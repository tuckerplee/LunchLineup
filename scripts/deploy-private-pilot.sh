#!/usr/bin/env bash
# Deploy prebuilt images to the private pilot (VM107, https://dev.lunchlineup.com).
#
#   sudo scripts/deploy-private-pilot.sh <image-dir>
#
# <image-dir> holds <name>.tar.gz + <name>.image.json pairs written by
# scripts/export-internal-ci-release-images.sh on the VM218 builder.
# This script never builds, never prunes, never deletes volumes, and only
# targets dev.lunchlineup.com. Integrity = sha256 of each archive plus the
# loaded image ID, both taken from the exporter metadata. When PGBACKREST_ENABLED=true
# the postgres container's pgBackRest is verified (host files) and set up
# (`stanza-create`, `check`) after postgres is healthy; the script takes no backup and
# installs no timer (the estate schedules `pgbackrest backup`).
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/lunchlineup}"
RUNTIME_ENV="${PILOT_RUNTIME_ENV_FILE:-/opt/lunchlineup-secrets/runtime.env}"
PROJECT=lunchlineup
EXPECTED_HOSTNAME=lunchlineup-dev
PILOT_HOST=dev.lunchlineup.com
PILOT_ORIGIN="https://$PILOT_HOST"
# Private bind address of the pilot VM. Default is the current address; the runtime env
# may set PILOT_BIND_IP (e.g. 10.1.50.10 after renumbering), resolved in check_runtime_env.
PILOT_BIND=10.231.10.108
LOCK_FILE=/run/lock/lunchlineup-deploy.lock
HOLD_FILES=(/etc/lunchlineup/vm107-launch.hold /etc/lunchlineup/private-launch.hold)
STATE_DIR="${PILOT_STATE_DIR:-/var/lib/lunchlineup/deploy}"
HEALTH_TIMEOUT_SECONDS="${PILOT_HEALTH_TIMEOUT_SECONDS:-300}"
DOCKER="${PILOT_DOCKER:-docker}"
IMAGE_PREFIX_VALUE="lunchlineup"
IMAGE_TAG_VALUE=""

fail() { echo "deploy_private_pilot_failed: $1" >&2; exit 1; }
step() { echo "== $*"; }

env_value() { # exactly-once KEY=value lookup in the runtime env
  local n; n="$(grep -c "^$1=" "$RUNTIME_ENV" || true)"
  [[ "$n" == 1 ]] || fail "$1 must occur exactly once in $RUNTIME_ENV"
  grep "^$1=" "$RUNTIME_ENV" | cut -d= -f2-
}

env_optional() { # KEY=value lookup that may be absent (empty output), but never duplicated
  local n; n="$(grep -c "^$1=" "$RUNTIME_ENV" || true)"
  [[ "$n" -le 1 ]] || fail "$1 must occur at most once in $RUNTIME_ENV"
  if [[ "$n" == 1 ]]; then grep "^$1=" "$RUNTIME_ENV" | cut -d= -f2-; fi
}

# pgBackRest (estate PITR inside the postgres container) is opt-in per runtime env.
# PGBACKREST_ENABLED=true adds infrastructure/postgres/compose.pgbackrest.yml. Everything
# is verified on the host BEFORE any container changes. Default (unset/false): archive_mode
# stays off and nothing pgBackRest-related runs.
PGBACKREST_ON=false
PGBACKREST_STANZA_VALUE=""
COMPOSE_EXTRA=()

compose() {
  COMPOSE_SERVICE_ENV_FILE="$RUNTIME_ENV" "$DOCKER" compose --project-name "$PROJECT" --project-directory "$APP_DIR" \
    --env-file "$RUNTIME_ENV" \
    -f "$APP_DIR/docker-compose.yml" \
    -f "$APP_DIR/infrastructure/development-admission/compose.private-proxy.yml" ${COMPOSE_EXTRA[@]+"${COMPOSE_EXTRA[@]}"} "$@"
}

check_pgbackrest() {
  local enabled key path mode
  PGBACKREST_ON=false; COMPOSE_EXTRA=()
  enabled="$(env_optional PGBACKREST_ENABLED)"
  case "${enabled:-false}" in
    false) echo "pgBackRest: disabled (archive_mode off)"; return 0 ;;
    true) ;;
    *) fail "PGBACKREST_ENABLED must be true or false" ;;
  esac
  [[ -f "$APP_DIR/infrastructure/postgres/compose.pgbackrest.yml" ]] || fail "infrastructure/postgres/compose.pgbackrest.yml missing from the checkout"
  PGBACKREST_STANZA_VALUE="$(env_value PGBACKREST_STANZA)"
  [[ "$PGBACKREST_STANZA_VALUE" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] || fail "PGBACKREST_STANZA is invalid"
  [[ "$(env_value PGBACKREST_SFTP_HOST)" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$ ]] || fail "PGBACKREST_SFTP_HOST is invalid"
  [[ "$(env_value PGBACKREST_SFTP_USER)" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || fail "PGBACKREST_SFTP_USER is invalid"
  [[ "$(env_value PGBACKREST_REPO_PATH)" =~ ^/[A-Za-z0-9._/-]{0,255}$ ]] || fail "PGBACKREST_REPO_PATH must be an absolute path on the SFTP chroot"
  [[ "$(env_optional PGBACKREST_SFTP_PORT)" =~ ^([0-9]{1,5})?$ ]] || fail "PGBACKREST_SFTP_PORT must be a port number"
  for key in PGBACKREST_SFTP_KEY_FILE PGBACKREST_SFTP_KNOWN_HOSTS_FILE PGBACKREST_CIPHER_PASS_FILE; do
    path="$(env_value "$key")"
    [[ "$path" == /* ]] || fail "$key must be an absolute host path"
    [[ -f "$path" && ! -L "$path" && -s "$path" && -r "$path" ]] || fail "$key: $path is missing, empty, unreadable or a symlink (pgBackRest requires it)"
  done
  for key in PGBACKREST_SFTP_KEY_FILE PGBACKREST_CIPHER_PASS_FILE; do
    path="$(env_value "$key")"
    mode="$(stat -c %a "$path")"
    (( (8#$mode & 8#077) == 0 )) || fail "$key must not be group/world accessible (chmod 600 $path)"
  done
  PGBACKREST_ON=true
  COMPOSE_EXTRA=(-f "$APP_DIR/infrastructure/postgres/compose.pgbackrest.yml")
  echo "pgBackRest: enabled (stanza $PGBACKREST_STANZA_VALUE)"
}

# After postgres is healthy: idempotent stanza-create, then `check` (which forces a WAL
# switch and proves archive-push reaches the repository). Fail closed on any error.
pgbackrest_setup() {
  [[ "$PGBACKREST_ON" == true ]] || return 0
  step "pgBackRest stanza-create and check ($PGBACKREST_STANZA_VALUE)"
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECONDS )) pg
  until pg="$(compose ps --format '{{.Health}}' postgres 2>/dev/null)" && [[ "$pg" == healthy ]]; do
    (( $(date +%s) < deadline )) || fail "postgres did not become healthy within ${HEALTH_TIMEOUT_SECONDS}s; pgBackRest not set up"
    sleep 3
  done
  compose exec -T -u postgres postgres pgbackrest "--stanza=$PGBACKREST_STANZA_VALUE" stanza-create \
    || fail "pgbackrest stanza-create failed"
  compose exec -T -u postgres postgres pgbackrest "--stanza=$PGBACKREST_STANZA_VALUE" check \
    || fail "pgbackrest check failed (WAL archiving to the repository is not working)"
  echo "pgBackRest ready. First/manual full backup: docker compose exec -T -u postgres postgres pgbackrest --stanza=$PGBACKREST_STANZA_VALUE --type=full backup"
}

# --- 2. target check ---------------------------------------------------------
check_target() {
  step "target check"
  [[ "$(id -u)" == 0 ]] || fail "run as root (sudo)"
  [[ "$(hostname -s)" == "$EXPECTED_HOSTNAME" ]] || fail "this is not $EXPECTED_HOSTNAME (VM107)"
  [[ "$APP_DIR" == /opt/lunchlineup && -f "$APP_DIR/docker-compose.yml" ]] || fail "APP_DIR must be the /opt/lunchlineup checkout"
  [[ -f "$RUNTIME_ENV" && ! -L "$RUNTIME_ENV" ]] || fail "runtime env missing or a symlink: $RUNTIME_ENV"
  local hold
  for hold in "${HOLD_FILES[@]}"; do
    [[ ! -e "$hold" ]] || fail "launch hold present: $hold (remove it only on explicit owner instruction)"
  done
  local key value
  for key in APP_ORIGIN NEXT_PUBLIC_APP_ORIGIN NEXT_PUBLIC_APP_URL; do
    [[ "$(env_value "$key")" == "$PILOT_ORIGIN" ]] || fail "$key must be exactly $PILOT_ORIGIN"
  done
  [[ "$(env_value ALLOWED_ORIGINS)" == "$PILOT_ORIGIN" ]] || fail "ALLOWED_ORIGINS must be exactly $PILOT_ORIGIN"
  for key in PRIVATE_APP_HOST DOMAIN ALLOWED_HOSTS; do
    [[ "$(env_value "$key")" == "$PILOT_HOST" ]] || fail "$key must be $PILOT_HOST"
  done
  [[ "$(env_value COOKIE_SECURE)" == true ]] || fail "COOKIE_SECURE must be true (TLS ends at the CT940 proxy)"
  # The APIs sit on the internal-only `app` network, so named private ranges or explicit
  # addresses/CIDRs are acceptable; blanket true and hop counts are not.
  [[ "$(env_value TRUST_PROXY)" =~ ^(loopback|linklocal|uniquelocal|([0-9]{1,3}\.){3}[0-9]{1,3}(/[0-9]{1,2})?)(,(loopback|linklocal|uniquelocal|([0-9]{1,3}\.){3}[0-9]{1,3}(/[0-9]{1,2})?))*$ ]] \
    || fail "TRUST_PROXY must list named private ranges or explicit addresses/CIDRs (not true or a hop count)"
  value="$(env_optional PILOT_BIND_IP)"
  if [[ -n "$value" ]]; then
    [[ "$value" =~ ^(10(\.[0-9]{1,3}){3}|192\.168(\.[0-9]{1,3}){2}|172\.(1[6-9]|2[0-9]|3[01])(\.[0-9]{1,3}){2})$ ]] \
    || fail "PILOT_BIND_IP must be a private IPv4 address"
    PILOT_BIND="$value"
  fi
  value="$(env_optional CADDY_TRUSTED_PROXIES)"
  [[ -z "$value" || "$value" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}(/[0-9]{1,2})?( ([0-9]{1,3}\.){3}[0-9]{1,3}(/[0-9]{1,2})?)*$ ]] \
    || fail "CADDY_TRUSTED_PROXIES must be space-separated IPv4 addresses/CIDRs"
  [[ "$(env_value PROXY_HTTP_BIND)" == "$PILOT_BIND" && "$(env_value PROXY_HTTP_PORT)" == 80 ]] \
    || fail "PROXY_HTTP_BIND/PORT must be $PILOT_BIND:80"
  value="$(env_value DATA_TARGET_ENV)"
  [[ "$value" == disposable || "$value" == development || "$value" == staging ]] || fail "DATA_TARGET_ENV must be disposable, development or staging"
  if grep -Eiq '(^|[/.=@])(www|beta)\.lunchlineup\.com|(https?://|=)lunchlineup\.com' "$RUNTIME_ENV"; then
    fail "runtime env references a production/beta lunchlineup.com host"
  fi
  IMAGE_TAG_VALUE="$(env_value IMAGE_TAG)"
  [[ "$IMAGE_TAG_VALUE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ && "$IMAGE_TAG_VALUE" != local ]] \
    || fail "IMAGE_TAG must be a release tag (not empty or 'local')"
  IMAGE_PREFIX_VALUE="$(grep '^IMAGE_PREFIX=' "$RUNTIME_ENV" | cut -d= -f2- || true)"
  IMAGE_PREFIX_VALUE="${IMAGE_PREFIX_VALUE:-lunchlineup}"
  [[ "$IMAGE_PREFIX_VALUE" =~ ^[a-z0-9][a-z0-9._/-]*$ ]] || fail "IMAGE_PREFIX is invalid"
  check_pgbackrest
}

# --- 1. image load -----------------------------------------------------------
# Refuses on any mismatch; tags by verified image ID only.
load_images() {
  local dir="$1" meta name fields ref id sha bytes archive actual_sha actual_bytes loaded target count=0
  [[ -d "$dir" ]] || fail "image directory not found: $dir"
  mkdir -p "$STATE_DIR"; : > "$STATE_DIR/previous-images.tsv"
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
    # Keep the image currently tagged for compose so rollback is possible.
    target="$IMAGE_PREFIX_VALUE/$name:$IMAGE_TAG_VALUE"
    if prev="$("$DOCKER" image inspect --format '{{.Id}}' "$target" 2>/dev/null)" && [[ -n "$prev" ]]; then
      "$DOCKER" tag "$prev" "lunchlineup-rollback/$name:previous"
      printf '%s\t%s\t%s\n' "$name" "$target" "$prev" >> "$STATE_DIR/previous-images.tsv"
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
    count=$((count + 1))
  done
  shopt -u nullglob
  (( count > 0 )) || fail "no *.image.json metadata found in $dir"
  echo "loaded and verified $count image(s)"
}

# --- 3. deploy ---------------------------------------------------------------
# Recovery point: Postgres PITR is the estate pgBackRest (repo on the NAS,
# configured by estate-infra). This script runs no dump or backup container.
run_migrations() {
  step "migrations (scripts/apply-db-migrations.mjs via the migrate service)"
  compose run --rm --pull never migrate || fail "migrations failed; app containers not (re)started"
}

wait_for_health() {
  step "health: http://$PILOT_BIND/health (Host: $PILOT_HOST)"
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECONDS )) body
  until body="$(curl -fsS --max-time 10 -H "Host: $PILOT_HOST" "http://$PILOT_BIND/health" 2>/dev/null)" \
        && grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' <<<"$body"; do
    (( $(date +%s) < deadline )) || { compose ps || true; fail "health did not return status ok within ${HEALTH_TIMEOUT_SECONDS}s"; }
    sleep 5
  done
  echo "health ok: $body"
}

main() {
  [[ $# == 1 ]] || { echo "Usage: $0 <image-dir>" >&2; exit 64; }
  for c in "$DOCKER" python3 curl flock sha256sum gzip awk grep; do command -v "$c" >/dev/null 2>&1 || fail "missing command: $c"; done
  exec 9>"$LOCK_FILE"
  flock -n 9 || fail "another deployment or storage cleanup holds $LOCK_FILE"
  check_target
  load_images "$1"
  compose config --quiet || fail "compose config invalid"
  step "start postgres"; compose up -d --no-build --pull never postgres
  pgbackrest_setup
  run_migrations
  step "start stack"; compose up -d --no-build --pull never
  wait_for_health
  echo "deploy_private_pilot_ok tag=$IMAGE_TAG_VALUE origin=$PILOT_ORIGIN"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
