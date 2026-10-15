#!/usr/bin/env bash
# Target-parameterized deploy of prebuilt images (pilot or production).
#
#   sudo scripts/deploy-release.sh --target pilot|production <image-dir>
#   sudo scripts/deploy-release.sh --target production --rollback <receipt-id>
#
# <image-dir> holds <name>.tar.gz + <name>.image.json pairs written by
# scripts/export-internal-ci-release-images.sh. The script never builds, never
# prunes, never deletes volumes, and never tears the stack down. Integrity =
# sha256 of each archive plus the loaded image ID, both from exporter metadata.
# By owner decision there is no signing or release-gating machinery.
#
# pilot       dev.lunchlineup.com on VM107 (same behaviour as deploy-private-pilot.sh)
# production  https://lunchlineup.com; offsite backup REQUIRED; deploy receipt kept
#
# Public routing is Cloudflare Tunnel -> nginx CT940 (10.231.10.30) -> VM port 80.
# TLS ends at Cloudflare; nginx must send X-Forwarded-Proto https. The www host is
# redirected to the apex at nginx and never reaches this stack.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/lunchlineup}"
PROJECT=lunchlineup
LOCK_FILE=/run/lock/lunchlineup-deploy.lock
HEALTH_TIMEOUT_SECONDS="${DEPLOY_HEALTH_TIMEOUT_SECONDS:-300}"
DOCKER="${DEPLOY_DOCKER:-docker}"
STATE_DIR="${DEPLOY_STATE_DIR:-/var/lib/lunchlineup/deploy}"
IMAGE_PREFIX_VALUE="lunchlineup"
IMAGE_TAG_VALUE=""
RELEASE_SHA_VALUE=""
RELEASE_ID=""
RECEIPT_DIR=""
RECEIPT_STARTED=""
BACKUP_PROOF_LINE=""
IMAGE_RECORDS=""
TARGET=""

fail() { echo "deploy_release_failed: $1" >&2; exit 1; }
step() { echo "== $*"; }

# --- target configuration ----------------------------------------------------
configure_target() {
  TARGET="$1"
  case "$TARGET" in
    pilot)
      RUNTIME_ENV="${PILOT_RUNTIME_ENV_FILE:-/opt/lunchlineup-secrets/runtime.env}"
      EXPECTED_HOSTNAME=lunchlineup-dev
      APP_HOST=dev.lunchlineup.com
      BIND_IP=10.231.10.108
      OVERLAY=infrastructure/development-admission/compose.private-proxy.yml
      HOLD_FILES=(/etc/lunchlineup/vm107-launch.hold /etc/lunchlineup/private-launch.hold)
      DATA_TARGETS_RE='^(disposable|development)$'
      OFFSITE_REQUIRED=false
      ;;
    production)
      RUNTIME_ENV="${PROD_RUNTIME_ENV_FILE:-/opt/lunchlineup-secrets/runtime.env}"
      # OWNER: set PROD_EXPECTED_HOSTNAME to the production app VM hostname once provisioned.
      EXPECTED_HOSTNAME="${PROD_EXPECTED_HOSTNAME:-lunchlineup-prod}"
      APP_HOST=lunchlineup.com
      BIND_IP="${PROD_BIND_IP:-}"
      OVERLAY=infrastructure/production/compose.production-proxy.yml
      HOLD_FILES=(/etc/lunchlineup/production-launch.hold)
      DATA_TARGETS_RE='^production$'
      OFFSITE_REQUIRED=true
      [[ "$BIND_IP" =~ ^(10(\.[0-9]{1,3}){3}|192\.168(\.[0-9]{1,3}){2}|172\.(1[6-9]|2[0-9]|3[01])(\.[0-9]{1,3}){2})$ ]] \
        || fail "PROD_BIND_IP must be the app VM private IPv4 address"
      ;;
    *) fail "--target must be pilot or production" ;;
  esac
  APP_ORIGIN_VALUE="https://$APP_HOST"
}

env_value() { # exactly-once KEY=value lookup in the runtime env
  local n; n="$(grep -c "^$1=" "$RUNTIME_ENV" || true)"
  [[ "$n" == 1 ]] || fail "$1 must occur exactly once in $RUNTIME_ENV"
  grep "^$1=" "$RUNTIME_ENV" | cut -d= -f2-
}

compose() {
  COMPOSE_SERVICE_ENV_FILE="$RUNTIME_ENV" "$DOCKER" compose --project-name "$PROJECT" --project-directory "$APP_DIR" \
    --env-file "$RUNTIME_ENV" \
    -f "$APP_DIR/docker-compose.yml" \
    -f "$APP_DIR/$OVERLAY" "$@"
}

# --- target checks -----------------------------------------------------------
check_host() {
  step "host check ($TARGET)"
  [[ "$(id -u)" == 0 ]] || fail "run as root (sudo)"
  [[ "$(hostname -s)" == "$EXPECTED_HOSTNAME" ]] || fail "this is not $EXPECTED_HOSTNAME"
  [[ "$APP_DIR" == /opt/lunchlineup && -f "$APP_DIR/docker-compose.yml" ]] || fail "APP_DIR must be the /opt/lunchlineup checkout"
  [[ -f "$APP_DIR/$OVERLAY" ]] || fail "compose overlay missing: $APP_DIR/$OVERLAY"
  [[ -f "$RUNTIME_ENV" && ! -L "$RUNTIME_ENV" ]] || fail "runtime env missing or a symlink: $RUNTIME_ENV"
  local hold
  for hold in "${HOLD_FILES[@]}"; do
    [[ ! -e "$hold" ]] || fail "launch hold present: $hold (remove it only on explicit owner instruction)"
  done
}

check_runtime_env() {
  step "runtime env check ($TARGET)"
  local key value creds
  for key in APP_ORIGIN NEXT_PUBLIC_APP_ORIGIN NEXT_PUBLIC_APP_URL ALLOWED_ORIGINS; do
    [[ "$(env_value "$key")" == "$APP_ORIGIN_VALUE" ]] || fail "$key must be exactly $APP_ORIGIN_VALUE"
  done
  for key in PRIVATE_APP_HOST DOMAIN ALLOWED_HOSTS; do
    [[ "$(env_value "$key")" == "$APP_HOST" ]] || fail "$key must be $APP_HOST"
  done
  [[ "$(env_value COOKIE_SECURE)" == true ]] || fail "COOKIE_SECURE must be true (TLS ends at Cloudflare/CT940)"
  [[ "$(env_value TRUST_PROXY)" =~ ^(loopback|linklocal|uniquelocal|([0-9]{1,3}\.){3}[0-9]{1,3}(/[0-9]{1,2})?)(,(loopback|linklocal|uniquelocal|([0-9]{1,3}\.){3}[0-9]{1,3}(/[0-9]{1,2})?))*$ ]] \
    || fail "TRUST_PROXY must list named private ranges or explicit addresses/CIDRs (not true or a hop count)"
  [[ "$(env_value PROXY_HTTP_BIND)" == "$BIND_IP" && "$(env_value PROXY_HTTP_PORT)" == 80 ]] \
    || fail "PROXY_HTTP_BIND/PORT must be $BIND_IP:80"
  value="$(env_value DATA_TARGET_ENV)"
  [[ "$value" =~ $DATA_TARGETS_RE ]] || fail "DATA_TARGET_ENV is not allowed for target $TARGET"
  case "$TARGET" in
    pilot)
      if grep -Eiq '(^|[/.=@])(www|beta)\.lunchlineup\.com|(https?://|=)lunchlineup\.com' "$RUNTIME_ENV"; then
        fail "runtime env references a production/beta lunchlineup.com host"
      fi
      ;;
    production)
      if grep -Eiq '(^|[^A-Za-z0-9-])(dev|beta|staging|stage|test|qa)\.lunchlineup\.com|lunchlineup-dev|(^|[=/@])(localhost|127\.0\.0\.1)([:/,]|$)' "$RUNTIME_ENV"; then
        fail "runtime env references a dev/beta/staging/localhost origin"
      fi
      [[ "$(env_value NODE_ENV)" == production ]] || fail "NODE_ENV must be production"
      [[ "$(env_value MIGRATION_PRODUCTION_CONFIRM)" == apply-lunchlineup-production-migrations ]] \
        || fail "MIGRATION_PRODUCTION_CONFIRM must be apply-lunchlineup-production-migrations"
      RELEASE_SHA_VALUE="$(env_value DEPLOY_RELEASE_SHA)"
      [[ "$RELEASE_SHA_VALUE" =~ ^[a-f0-9]{40}$ ]] || fail "DEPLOY_RELEASE_SHA must be the 40-hex release commit"
      value="$(env_value BACKUP_OFFSITE_URI)"
      [[ "$value" =~ ^s3://[a-z0-9][a-z0-9.-]{1,62}/[A-Za-z0-9._/-]+$ ]] \
        || fail "BACKUP_OFFSITE_URI must be s3://bucket/prefix (offsite backup is required in production)"
      creds="$(grep '^BACKUP_OFFSITE_CREDENTIALS_DIR=' "$RUNTIME_ENV" | cut -d= -f2- || true)"
      creds="${creds:-$APP_DIR/secrets/backup-offsite}"
      [[ -d "$creds" && -n "$(ls -A "$creds" 2>/dev/null)" ]] || fail "offsite credentials directory missing or empty: $creds"
      ;;
  esac
  IMAGE_TAG_VALUE="$(env_value IMAGE_TAG)"
  [[ "$IMAGE_TAG_VALUE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ && "$IMAGE_TAG_VALUE" != local ]] \
    || fail "IMAGE_TAG must be a release tag (not empty or 'local')"
  IMAGE_PREFIX_VALUE="$(grep '^IMAGE_PREFIX=' "$RUNTIME_ENV" | cut -d= -f2- || true)"
  IMAGE_PREFIX_VALUE="${IMAGE_PREFIX_VALUE:-lunchlineup}"
  [[ "$IMAGE_PREFIX_VALUE" =~ ^[a-z0-9][a-z0-9._/-]*$ ]] || fail "IMAGE_PREFIX is invalid"
}

# --- image load --------------------------------------------------------------
# Refuses on any mismatch; tags by verified image ID only. Previous images are
# kept under lunchlineup-rollback/<name>:previous and a per-release stamp tag.
load_images() {
  local dir="$1" meta name fields ref id sha bytes archive actual_sha actual_bytes loaded target prev count=0
  [[ -d "$dir" ]] || fail "image directory not found: $dir"
  mkdir -p "$STATE_DIR"; chmod 700 "$STATE_DIR"
  IMAGE_RECORDS=""
  shopt -s nullglob
  for meta in "$dir"/*.image.json; do
    fields="$(python3 -c '
import json, sys
m = json.load(open(sys.argv[1], encoding="utf-8"))
sys.stdout.write("\t".join(str(m[k]) for k in ("artifactName", "imageRef", "localImageId", "archiveSha256", "archiveBytes")))' "$meta")" \
      || fail "unreadable metadata: $meta"
    IFS=$'\t' read -r name ref id sha bytes <<<"$fields"
    [[ "$name" =~ ^[a-z0-9-]+$ && "$(basename "$meta")" == "$name.image.json" ]] || fail "bad artifactName in $meta"
    [[ "$id" =~ ^sha256:[a-f0-9]{64}$ && "$sha" =~ ^[a-f0-9]{64}$ && "$bytes" =~ ^[0-9]+$ ]] || fail "bad metadata values in $meta"
    archive="$dir/$name.tar.gz"
    [[ -f "$archive" && ! -L "$archive" ]] || fail "missing archive: $archive"
    actual_bytes="$(stat -c %s "$archive")"
    actual_sha="$(sha256sum "$archive" | awk '{print $1}')"
    [[ "$actual_bytes" == "$bytes" ]] || fail "$name: archive size mismatch"
    [[ "$actual_sha" == "$sha" ]] || fail "$name: archive sha256 mismatch"
    step "load $name"
    target="$IMAGE_PREFIX_VALUE/$name:$IMAGE_TAG_VALUE"
    prev=""
    if prev="$("$DOCKER" image inspect --format '{{.Id}}' "$target" 2>/dev/null)" && [[ -n "$prev" ]]; then
      "$DOCKER" tag "$prev" "lunchlineup-rollback/$name:previous"
      "$DOCKER" tag "$prev" "lunchlineup-rollback/$name:before-${RELEASE_ID:-manual}"
    else
      prev=""
    fi
    gzip -dc "$archive" | "$DOCKER" load >/dev/null
    loaded="$("$DOCKER" image inspect --format '{{.Id}}' "$id")" || fail "$name: loaded image $id not found"
    [[ "$loaded" == "$id" ]] || fail "$name: loaded image ID $loaded != metadata $id"
    if [[ "$ref" == lunchlineup-internal-ci/* ]]; then
      "$DOCKER" tag "$id" "$target"
    else
      # Digest-pinned third-party images load unnamed; name them so compose's
      # name@digest reference resolves locally with --pull never.
      base="${ref%@*}"
      [[ "${base##*/}" == *:* ]] || base="$base:pinned"
      "$DOCKER" tag "$id" "$base"
    fi
    IMAGE_RECORDS+="$name"$'\t'"$target"$'\t'"$id"$'\t'"$sha"$'\t'"${prev:-none}"$'\n'
    count=$((count + 1))
  done
  shopt -u nullglob
  (( count > 0 )) || fail "no *.image.json metadata found in $dir"
  echo "loaded and verified $count image(s)"
}

# --- receipt -----------------------------------------------------------------
migration_list() { # sorted migration entries shipped in the checkout
  local root="$APP_DIR/packages/db/prisma/migrations"
  [[ -d "$root" ]] || return 0
  (cd "$root" && find . -mindepth 1 -maxdepth 2 \( -name '*.sql' -o -type d \) -printf '%P\n' | LC_ALL=C sort)
}

write_receipt() { # $1 = status
  [[ -n "$RECEIPT_DIR" ]] || return 0
  IMAGE_RECORDS="$IMAGE_RECORDS" MIGRATIONS="$(migration_list)" BACKUP_PROOF="$BACKUP_PROOF_LINE" \
  python3 - "$RECEIPT_DIR/receipt.json" "$1" "$TARGET" "$RELEASE_ID" "$IMAGE_TAG_VALUE" "$RELEASE_SHA_VALUE" \
      "$APP_ORIGIN_VALUE" "$RECEIPT_STARTED" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" <<'PY'
import json, os, sys
path, status, target, rid, tag, sha, origin, started, finished = sys.argv[1:10]
images = []
for line in os.environ["IMAGE_RECORDS"].splitlines():
    n, ref, iid, asha, prev = line.split("\t")
    images.append({"name": n, "composeRef": ref, "imageId": iid, "archiveSha256": asha,
                   "previousImageId": None if prev == "none" else prev})
doc = {"schemaVersion": 1, "status": status, "target": target, "releaseId": rid, "imageTag": tag,
       "releaseSha": sha or None, "origin": origin, "startedAt": started, "finishedAt": finished,
       "images": images, "migrations": [m for m in os.environ["MIGRATIONS"].splitlines() if m],
       "preDeployBackup": os.environ["BACKUP_PROOF"] or None}
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as fh:
    json.dump(doc, fh, indent=2, sort_keys=True); fh.write("\n")
os.replace(tmp, path)
PY
}

begin_receipt() {
  RECEIPT_STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$IMAGE_TAG_VALUE"
  RECEIPT_DIR="$STATE_DIR/receipts/$RELEASE_ID"
  mkdir -p "$RECEIPT_DIR"; chmod 700 "$STATE_DIR/receipts" "$RECEIPT_DIR"
}

finish_receipt_on_exit() {
  local rc=$?
  if [[ -n "$RECEIPT_DIR" && -f "$RECEIPT_DIR/receipt.json" ]] && ! grep -q '"status": "ok"' "$RECEIPT_DIR/receipt.json"; then
    write_receipt failed || true
  fi
  return $rc
}

# --- deploy ------------------------------------------------------------------
pre_deploy_backup() {
  if "$DOCKER" volume inspect "${PROJECT}_postgres_data" >/dev/null 2>&1; then
    if [[ "$OFFSITE_REQUIRED" != true && "${PILOT_SKIP_BACKUP:-}" == I_ACCEPT_NO_BACKUP ]]; then
      echo "WARNING: pre-deploy backup skipped by explicit operator override"
      return
    fi
    step "pre-deploy database backup (scripts/backup.sh via the backup service)"
    local out; out="$(mktemp)"
    compose --profile ops run --rm --pull never backup 2>&1 | tee "$out" \
      || { rm -f "$out"; fail "pre-deploy backup failed; nothing was changed"; }
    BACKUP_PROOF_LINE="$(grep '^backup_ok ' "$out" | tail -n 1 || true)"
    rm -f "$out"
    if [[ "$OFFSITE_REQUIRED" == true ]]; then
      [[ -n "$BACKUP_PROOF_LINE" ]] || fail "backup produced no backup_ok proof; nothing was changed"
      [[ "$BACKUP_PROOF_LINE" == *" offsite_uri=s3://"* && "$BACKUP_PROOF_LINE" != *" offsite_version=none "* \
         && "$BACKUP_PROOF_LINE" != *" checksum_version=none "* ]] \
        || fail "backup proof lacks an immutable offsite object version; production deploy refused"
    fi
  elif [[ "$OFFSITE_REQUIRED" == true && "${DEPLOY_FIRST_INSTALL:-}" != yes ]]; then
    fail "no postgres volume on production; set DEPLOY_FIRST_INSTALL=yes only for the very first empty install"
  else
    echo "no existing postgres volume; skipping backup"
  fi
}

run_migrations() {
  step "migrations (scripts/apply-db-migrations.mjs via the migrate service)"
  compose run --rm --pull never migrate || fail "migrations failed; app containers not (re)started"
}

wait_for_health() {
  step "health: http://$BIND_IP/health (Host: $APP_HOST)"
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECONDS )) body hdr
  until body="$(curl -fsS --max-time 10 -H "Host: $APP_HOST" "http://$BIND_IP/health" 2>/dev/null)" \
        && grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' <<<"$body"; do
    (( $(date +%s) < deadline )) || { compose ps || true; fail "health did not return status ok within ${HEALTH_TIMEOUT_SECONDS}s"; }
    sleep 5
  done
  echo "health ok: $body"
  if [[ "$TARGET" == production && -n "$RELEASE_SHA_VALUE" ]]; then
    hdr="$(curl -fsS --max-time 10 -D - -o /dev/null -H "Host: $APP_HOST" "http://$BIND_IP/" | tr -d '\r' | grep -i '^x-lunchlineup-release:' || true)"
    [[ "${hdr#*: }" == "$RELEASE_SHA_VALUE" ]] || fail "served X-LunchLineup-Release does not match $RELEASE_SHA_VALUE (got: ${hdr:-none})"
  fi
}

rollback_images() { # $1 = release id of the deploy whose previous images should return
  local rid="$1" doc lines name ref prev
  [[ "$rid" =~ ^[A-Za-z0-9._-]+$ ]] || fail "invalid receipt id"
  doc="$STATE_DIR/receipts/$rid/receipt.json"
  [[ -f "$doc" ]] || fail "no receipt: $doc"
  step "image rollback to the images that preceded $rid (no migrations, no data restore)"
  lines="$(python3 -c '
import json, sys
for i in json.load(open(sys.argv[1]))["images"]:
    print("\t".join([i["name"], i["composeRef"], i["previousImageId"] or "none"]))' "$doc")"
  while IFS=$'\t' read -r name ref prev; do
    [[ -n "$name" ]] || continue
    [[ "$prev" != none ]] || fail "$name had no previous image; cannot roll back images (first deploy)"
    [[ "$("$DOCKER" image inspect --format '{{.Id}}' "$prev")" == "$prev" ]] || fail "$name: previous image $prev is no longer present"
    "$DOCKER" tag "$prev" "$ref"
  done <<<"$lines"
  compose config --quiet || fail "compose config invalid"
  compose up -d --no-build --pull never
  RELEASE_SHA_VALUE=""  # header check skipped: restore DEPLOY_RELEASE_SHA in runtime.env, then recreate proxy
  wait_for_health
  echo "deploy_release_rollback_ok target=$TARGET from=$rid (schema is forward-only; see docs/runbooks/production-cutover.md)"
}

main() {
  local target="" rollback="" dir="" c
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --target) target="${2:-}"; shift 2 ;;
      --rollback) rollback="${2:-}"; shift 2 ;;
      -*) echo "unknown option $1" >&2; exit 64 ;;
      *) dir="$1"; shift ;;
    esac
  done
  [[ -n "$target" && ( -n "$dir" || -n "$rollback" ) && ! ( -n "$dir" && -n "$rollback" ) ]] \
    || { echo "Usage: $0 --target pilot|production (<image-dir> | --rollback <receipt-id>)" >&2; exit 64; }
  configure_target "$target"
  for c in "$DOCKER" python3 curl flock sha256sum gzip awk grep tee; do command -v "$c" >/dev/null 2>&1 || fail "missing command: $c"; done
  exec 9>"$LOCK_FILE"
  flock -n 9 || fail "another deployment or storage cleanup holds $LOCK_FILE"
  check_host
  check_runtime_env
  if [[ -n "$rollback" ]]; then rollback_images "$rollback"; return; fi
  begin_receipt
  trap finish_receipt_on_exit EXIT
  write_receipt started
  load_images "$dir"
  write_receipt started
  compose config --quiet || fail "compose config invalid"
  pre_deploy_backup
  write_receipt started
  step "start postgres"; compose up -d --no-build --pull never postgres
  run_migrations
  step "start stack"; compose up -d --no-build --pull never
  wait_for_health
  write_receipt ok
  echo "deploy_release_ok target=$TARGET tag=$IMAGE_TAG_VALUE origin=$APP_ORIGIN_VALUE receipt=$RECEIPT_DIR/receipt.json"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
