#!/usr/bin/env bash
# Deploy prebuilt images to the private pilot (VM107, https://dev.lunchlineup.com).
#
#   sudo scripts/deploy-private-pilot.sh <image-dir>
#
# <image-dir> holds <name>.tar.gz + <name>.image.json pairs written by
# scripts/export-internal-ci-release-images.sh on the VM218 builder.
# This script never builds, never prunes, never deletes volumes, and only
# targets dev.lunchlineup.com. Integrity = sha256 of each archive plus the
# loaded image ID, both taken from the exporter metadata.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/lunchlineup}"
RUNTIME_ENV="${PILOT_RUNTIME_ENV_FILE:-/opt/lunchlineup-secrets/runtime.env}"
PROJECT=lunchlineup
EXPECTED_HOSTNAME=lunchlineup-dev
PILOT_HOST=dev.lunchlineup.com
PILOT_ORIGIN="https://$PILOT_HOST"
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

compose() {
  "$DOCKER" compose --project-name "$PROJECT" --project-directory "$APP_DIR" \
    --env-file "$RUNTIME_ENV" \
    -f "$APP_DIR/docker-compose.yml" \
    -f "$APP_DIR/infrastructure/development-admission/compose.private-proxy.yml" "$@"
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
  # Must be the Caddy address(es) on the compose network, never the default broad ranges.
  [[ "$(env_value TRUST_PROXY)" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/32(,([0-9]{1,3}\.){3}[0-9]{1,3}/32)*$ ]] \
    || fail "TRUST_PROXY must be an explicit list of /32 Caddy compose-network addresses"
  [[ "$(env_value PROXY_HTTP_BIND)" == "$PILOT_BIND" && "$(env_value PROXY_HTTP_PORT)" == 80 ]] \
    || fail "PROXY_HTTP_BIND/PORT must be $PILOT_BIND:80"
  value="$(env_value DATA_TARGET_ENV)"
  [[ "$value" == disposable || "$value" == development ]] || fail "DATA_TARGET_ENV must be disposable or development"
  if grep -Eiq '(^|[/.=@])(www|beta)\.lunchlineup\.com|(https?://|=)lunchlineup\.com' "$RUNTIME_ENV"; then
    fail "runtime env references a production/beta lunchlineup.com host"
  fi
  IMAGE_TAG_VALUE="$(env_value IMAGE_TAG)"
  [[ "$IMAGE_TAG_VALUE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ && "$IMAGE_TAG_VALUE" != local ]] \
    || fail "IMAGE_TAG must be a release tag (not empty or 'local')"
  IMAGE_PREFIX_VALUE="$(grep '^IMAGE_PREFIX=' "$RUNTIME_ENV" | cut -d= -f2- || true)"
  IMAGE_PREFIX_VALUE="${IMAGE_PREFIX_VALUE:-lunchlineup}"
  [[ "$IMAGE_PREFIX_VALUE" =~ ^[a-z0-9][a-z0-9._/-]*$ ]] || fail "IMAGE_PREFIX is invalid"
}

# --- 1. image load -----------------------------------------------------------
# Refuses on any mismatch; tags by verified image ID only.
load_images() {
  local dir="$1" meta name fields ref id sha bytes archive actual_sha actual_bytes loaded target count=0
  [[ -d "$dir" ]] || fail "image directory not found: $dir"
  mkdir -p "$STATE_DIR"; : > "$STATE_DIR/previous-images.tsv"
  shopt -s nullglob
  for meta in "$dir"/*.image.json; do
    fields="$(node -e '
      const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      process.stdout.write([m.artifactName, m.imageRef, m.localImageId, m.archiveSha256, m.archiveBytes].join("\t"));' "$meta")" \
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
    fi
    count=$((count + 1))
  done
  shopt -u nullglob
  (( count > 0 )) || fail "no *.image.json metadata found in $dir"
  echo "loaded and verified $count image(s)"
}

# --- 3. deploy ---------------------------------------------------------------
pre_deploy_backup() {
  if "$DOCKER" volume inspect "${PROJECT}_postgres_data" >/dev/null 2>&1; then
    if [[ "${PILOT_SKIP_BACKUP:-}" == I_ACCEPT_NO_BACKUP ]]; then
      echo "WARNING: pre-deploy backup skipped by explicit operator override"
      return
    fi
    step "pre-deploy database backup (scripts/backup.sh via the backup service)"
    compose --profile ops run --rm --pull never backup || fail "pre-deploy backup failed; nothing was changed"
  else
    echo "no existing postgres volume; skipping backup"
  fi
}

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
  for c in "$DOCKER" node curl flock sha256sum gzip awk grep; do command -v "$c" >/dev/null 2>&1 || fail "missing command: $c"; done
  exec 9>"$LOCK_FILE"
  flock -n 9 || fail "another deployment or storage cleanup holds $LOCK_FILE"
  check_target
  load_images "$1"
  compose config --quiet || fail "compose config invalid"
  pre_deploy_backup
  step "start postgres"; compose up -d --no-build --pull never postgres
  run_migrations
  step "start stack"; compose up -d --no-build --pull never
  wait_for_health
  echo "deploy_private_pilot_ok tag=$IMAGE_TAG_VALUE origin=$PILOT_ORIGIN"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
