#!/usr/bin/env bash
set -euo pipefail
umask 077

APP_DIR="${APP_DIR:-/opt/lunchlineup}"
LOCK_FILE="${LOCK_FILE:-/tmp/lunchlineup-deploy.lock}"
HEALTH_URL="${HEALTH_URL:-}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-180}"
HEALTH_REQUEST_TIMEOUT_SECONDS="${HEALTH_REQUEST_TIMEOUT_SECONDS:-10}"
HEALTH_POLL_SECONDS="${HEALTH_POLL_SECONDS:-5}"
SECRETS_DIR="${SECRETS_DIR:-/opt/lunchlineup-secrets}"
SECRET_ENV_PATH="${SECRET_ENV_PATH:-$SECRETS_DIR/runtime.env}"
DEPLOY_SCOPE="${VM217_DEPLOY_SCOPE:-production}"
SOURCE_SHA="${RELEASE_SOURCE_SHA:-${DEPLOY_SOURCE_SHA:-}}"
RELEASE_MANIFEST_PATH="${RELEASE_MANIFEST_PATH:-$APP_DIR/.release/release-manifest.json}"
COMPOSE_SERVICE_ENV_FILE="${COMPOSE_SERVICE_ENV_FILE:-$SECRET_ENV_PATH}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-}"
COMPOSE_PROJECT_DIRECTORY="${COMPOSE_PROJECT_DIRECTORY:-}"
COMPOSE_FILE="${COMPOSE_FILE:-}"
COMPOSE_IMAGE_PREFIX="${COMPOSE_IMAGE_PREFIX:-lunchlineup-release}"
POST_DEPLOY_PROOF_DIR="${POST_DEPLOY_PROOF_DIR:-/var/lib/lunchlineup/proofs}"
BACKUP_RELEASE_ENV_PATH="${BACKUP_RELEASE_ENV_PATH:-/var/lib/lunchlineup/backup-release.env}"
ACTIVE_RELEASE_POINTER="${ACTIVE_RELEASE_POINTER:-${APP_DIR%/}/current}"
RUNTIME_ENV_STORE_ROOT="${RUNTIME_ENV_STORE_ROOT:-/var/lib/lunchlineup/runtime-env}"
ACTIVE_RUNTIME_ENV_POINTER="${ACTIVE_RUNTIME_ENV_POINTER:-$RUNTIME_ENV_STORE_ROOT/current}"
SERVICE_GROUP_NAME="${LUNCHLINEUP_SERVICE_GROUP:-lunchlineup}"
SERVICE_GROUP_GID=""
SERVICE_USER_NAME="lunchlineup"
WEBHOOK_KEY_READINESS_STATE_PATH="${WEBHOOK_KEY_READINESS_STATE_PATH:-/var/lib/lunchlineup/webhook-key-readiness.json}"
DEPLOY_ALERT_RULES_URL="${DEPLOY_ALERT_RULES_URL:-http://127.0.0.1:3002/api/datasources/proxy/uid/prometheus/api/v1/rules}"
DEPLOY_ALERTMANAGER_URL="${DEPLOY_ALERTMANAGER_URL:-http://127.0.0.1:9093/api/v2/alerts}"
DEPLOY_ALERT_SCOPE_PREFIX="${DEPLOY_ALERT_SCOPE_PREFIX:-lunchlineup.}"
DEPLOY_ALERT_BOOT_GRACE_SECONDS="${DEPLOY_ALERT_BOOT_GRACE_SECONDS:-60}"
DEPLOY_ALERT_STABILITY_SECONDS="${DEPLOY_ALERT_STABILITY_SECONDS:-900}"
DEPLOY_ALERT_POLL_SECONDS="${DEPLOY_ALERT_POLL_SECONDS:-5}"
DEPLOY_ALERT_REQUEST_TIMEOUT_MS="${DEPLOY_ALERT_REQUEST_TIMEOUT_MS:-5000}"
DEPLOY_ALERT_MAX_RESPONSE_AGE_MS="${DEPLOY_ALERT_MAX_RESPONSE_AGE_MS:-30000}"
PRODUCTION_API_HEALTH_URL="${PRODUCTION_API_HEALTH_URL:-}"
PRODUCTION_WEB_URL="${PRODUCTION_WEB_URL:-}"
WEB_URL="${WEB_URL:-}"
LAUNCH_PROOF_MANIFEST_URI="${LAUNCH_PROOF_MANIFEST_URI:-}"
LAUNCH_PROOF_ARTIFACT_SHA256="${LAUNCH_PROOF_ARTIFACT_SHA256:-}"
LAUNCH_PROOF_MAX_AGE_SECONDS="${LAUNCH_PROOF_MAX_AGE_SECONDS:-86400}"
DEPLOY_OPERATION="${VM217_DEPLOY_OPERATION:-deploy}"
DEPLOY_MIGRATION_MODE="${DEPLOY_MIGRATION_MODE:-}"
EXPECTED_CURRENT_RELEASE_SHA="${EXPECTED_CURRENT_RELEASE_SHA:-}"
ROLLBACK_SCHEMA_COMPATIBILITY_CONFIRM="${ROLLBACK_SCHEMA_COMPATIBILITY_CONFIRM:-}"
ROLLBACK_CANDIDATE_DEPLOYMENT_ROOT="${ROLLBACK_CANDIDATE_DEPLOYMENT_ROOT:-/opt/lunchlineup}"
ROLLBACK_CANDIDATE_RELEASE_MANIFEST_PATH="${ROLLBACK_CANDIDATE_RELEASE_MANIFEST_PATH:-$ROLLBACK_CANDIDATE_DEPLOYMENT_ROOT/.release/release-manifest.json}"
ROLLBACK_CANDIDATE_SOURCE_SHA="${ROLLBACK_CANDIDATE_SOURCE_SHA:-}"
OLD_RELEASE_COMPATIBILITY_PROOF_PATH="${OLD_RELEASE_COMPATIBILITY_PROOF_PATH:-}"
OLD_RELEASE_COMPATIBILITY_PROOF_SHA256="${OLD_RELEASE_COMPATIBILITY_PROOF_SHA256:-}"
OLD_RELEASE_COMPATIBILITY_SIGNATURE_BUNDLE_PATH="${OLD_RELEASE_COMPATIBILITY_SIGNATURE_BUNDLE_PATH:-}"
OLD_RELEASE_COMPATIBILITY_SIGNATURE_BUNDLE_SHA256="${OLD_RELEASE_COMPATIBILITY_SIGNATURE_BUNDLE_SHA256:-}"
EXTERNAL_HEALTH_PROOF_PATH=""
BACKUP_RELEASE_ENV_STAGE_ACTIVE=false
BACKUP_RELEASE_ENV_PREVIOUS_PATH=""
BACKUP_RELEASE_ENV_PREVIOUS_EXISTED=false
BACKUP_SYSTEMD_UNIT_DIR="${BACKUP_SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
BACKUP_SYSTEMD_STATE_DIR=""
BACKUP_RUNTIME_STATE_PATH=""
BACKUP_SERVICES=(lunchlineup-backup.service lunchlineup-pitr-base-backup.service)
BACKUP_TIMERS=(lunchlineup-backup.timer lunchlineup-pitr-base-backup.timer)
BACKUP_UNITS=("${BACKUP_SERVICES[@]}" "${BACKUP_TIMERS[@]}")
RUNTIME_ENV_CANDIDATE_PATH=""
RUNTIME_ENV_CANDIDATE_SHA256=""
RUNTIME_ENV_CANDIDATE_CREATED=false
RUNTIME_ENV_PREVIOUS_TARGET=""
RUNTIME_ENV_PREVIOUS_EXISTED=false
RUNTIME_ENV_STAGE_ACTIVE=false

fail() {
  echo "$1" >&2
  exit 1
}

require_full_sha() {
  local value="$1"
  local label="$2"
  if [[ ! "$value" =~ ^[a-fA-F0-9]{40}$ ]]; then
    fail "$label must be a full 40-character Git SHA."
  fi
}

require_sha256() {
  local value="$1"
  local label="$2"
  if [[ ! "$value" =~ ^[a-fA-F0-9]{64}$ ]]; then
    fail "$label must be a 64-character SHA-256 digest."
  fi
}

require_file() {
  local path="$1"
  local label="$2"
  if [[ ! -f "$path" ]]; then
    fail "$label not found: $path"
  fi
}

validate_production_compose_scope() {
  local expected_project="lunchlineup"
  local expected_directory="$APP_DIR"
  local expected_file="$APP_DIR/docker-compose.yml"

  [[ "$COMPOSE_PROJECT_NAME" == "$expected_project" ]] \
    || fail "COMPOSE_PROJECT_NAME must remain lunchlineup for the stable production volume identity."
  [[ "$COMPOSE_PROJECT_DIRECTORY" == "$expected_directory" ]] \
    || fail "COMPOSE_PROJECT_DIRECTORY must equal the exact retained candidate release path."
  [[ "$COMPOSE_FILE" == "$expected_file" ]] \
    || fail "COMPOSE_FILE must equal the exact retained candidate Compose file."
  [[ -f "$COMPOSE_FILE" && ! -L "$COMPOSE_FILE" ]] \
    || fail "The retained candidate Compose file must be a regular file and not a symlink."

  python3 - "$COMPOSE_SERVICE_ENV_FILE" "$expected_project" "$expected_directory" "$expected_file" <<'PY'
import sys

path, expected_project, expected_directory, expected_file = sys.argv[1:5]
expected = {
    "COMPOSE_PROJECT_NAME": expected_project,
    "COMPOSE_PROJECT_DIRECTORY": expected_directory,
    "COMPOSE_FILE": expected_file,
}
forbidden = {"COMPOSE_ENV_FILES", "COMPOSE_PATH_SEPARATOR", "COMPOSE_PROFILES"}
values = {}
with open(path, "r", encoding="utf-8") as handle:
    for raw_line in handle:
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key] = value

for key, expected_value in expected.items():
    if key in values and values[key] != expected_value:
        raise SystemExit(f"Runtime environment {key} conflicts with the stable production Compose scope.")
for key in forbidden:
    if values.get(key, ""):
        raise SystemExit(f"Runtime environment must not set scope-affecting {key}.")
PY
}

sha256_file() {
  sha256sum "$1" | awk '{print $1}'
}

require_root_private_file() {
  local path="$1"
  local label="$2"
  local metadata
  [[ -f "$path" && ! -L "$path" && -s "$path" ]] || fail "$label must be a non-empty regular file and not a symlink."
  metadata="$(stat -c '%u:%g:%a' -- "$path" 2>/dev/null)" \
    || fail "Could not inspect $label ownership and permissions."
  [[ "$metadata" == "0:0:600" ]] || fail "$label must be owned by root:root with mode 0600."
}

resolve_service_group() {
  local record
  local resolved_name
  local password
  local resolved_gid
  local members
  local extra
  local user_record
  local resolved_user
  local user_password
  local resolved_uid
  local primary_gid
  local gecos
  local home
  local shell
  local user_extra

  [[ "$SERVICE_GROUP_NAME" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] \
    || fail "LUNCHLINEUP_SERVICE_GROUP must be a bounded local group name."
  command -v getent >/dev/null 2>&1 || fail "getent is required to resolve the LunchLineup service group."
  record="$(getent group "$SERVICE_GROUP_NAME")" \
    || fail "LunchLineup service group '$SERVICE_GROUP_NAME' does not exist."
  [[ -n "$record" && "$record" != *$'\n'* ]] \
    || fail "LunchLineup service group resolution was ambiguous."
  IFS=':' read -r resolved_name password resolved_gid members extra <<< "$record"
  [[ "$resolved_name" == "$SERVICE_GROUP_NAME" && "$resolved_gid" =~ ^[0-9]+$ \
    && "$resolved_gid" != "0" && -z "$extra" ]] \
    || fail "LunchLineup service group must resolve exactly to a non-root numeric GID."
  user_record="$(getent passwd "$SERVICE_USER_NAME")" \
    || fail "LunchLineup service account '$SERVICE_USER_NAME' does not exist."
  [[ -n "$user_record" && "$user_record" != *$'\n'* ]] \
    || fail "LunchLineup service account resolution was ambiguous."
  IFS=':' read -r resolved_user user_password resolved_uid primary_gid gecos home shell user_extra <<< "$user_record"
  [[ "$resolved_user" == "$SERVICE_USER_NAME" && "$resolved_uid" =~ ^[0-9]+$ \
    && "$resolved_uid" != "0" && "$primary_gid" == "$resolved_gid" && -z "$user_extra" ]] \
    || fail "LunchLineup service group must be the non-root service account's primary group."
  SERVICE_GROUP_GID="$resolved_gid"
}

require_service_group_directory() {
  local path="$1"
  local label="$2"
  local metadata
  [[ -d "$path" && ! -L "$path" ]] || fail "$label must be a non-symlink directory."
  metadata="$(stat -c '%u:%g:%a' -- "$path" 2>/dev/null)" \
    || fail "Could not inspect $label ownership and permissions."
  [[ "$metadata" == "0:$SERVICE_GROUP_GID:750" ]] \
    || fail "$label must be owned by root:$SERVICE_GROUP_NAME with mode 0750."
}

normalize_runtime_env_directory() {
  local path="$1"
  local label="$2"
  local metadata
  [[ -d "$path" && ! -L "$path" ]] || fail "$label must be a non-symlink directory."
  metadata="$(stat -c '%u:%g:%a' -- "$path" 2>/dev/null)" \
    || fail "Could not inspect $label ownership and permissions."
  [[ "$metadata" == "0:0:700" || "$metadata" == "0:$SERVICE_GROUP_GID:750" ]] \
    || fail "$label has unsafe pre-existing ownership or permissions."
  chown "root:$SERVICE_GROUP_GID" -- "$path"
  chmod 750 -- "$path"
  require_service_group_directory "$path" "$label"
}

require_service_group_file() {
  local path="$1"
  local label="$2"
  local metadata
  [[ -f "$path" && ! -L "$path" && -s "$path" ]] || fail "$label must be a non-empty regular file and not a symlink."
  metadata="$(stat -c '%u:%g:%a' -- "$path" 2>/dev/null)" \
    || fail "Could not inspect $label ownership and permissions."
  [[ "$metadata" == "0:$SERVICE_GROUP_GID:640" ]] \
    || fail "$label must be owned by root:$SERVICE_GROUP_NAME with mode 0640."
}

normalize_durable_runtime_env_file() {
  local path="$1"
  local expected_sha256="$2"
  local metadata
  [[ -f "$path" && ! -L "$path" && -s "$path" ]] \
    || fail "Durable runtime environment must be a non-empty regular file and not a symlink."
  metadata="$(stat -c '%u:%g:%a' -- "$path" 2>/dev/null)" \
    || fail "Could not inspect durable runtime environment ownership and permissions."
  [[ "$metadata" == "0:0:600" || "$metadata" == "0:$SERVICE_GROUP_GID:640" ]] \
    || fail "Durable runtime environment has unsafe pre-existing ownership or permissions."
  [[ "$(sha256_file "$path")" == "$expected_sha256" ]] \
    || fail "Durable runtime environment digest mismatch."
  chown "root:$SERVICE_GROUP_GID" -- "$path"
  chmod 640 -- "$path"
  require_service_group_file "$path" "Durable runtime environment"
}

validate_durable_runtime_env() {
  local path="$1"
  local expected_sha256="$2"
  local relative
  local bound_source_sha
  local bound_digest
  local leaf
  local extra

  relative="${path#"$RUNTIME_ENV_STORE_ROOT/by-release/"}"
  [[ "$relative" != "$path" ]] || fail "Durable runtime environment is outside the managed store."
  IFS='/' read -r bound_source_sha bound_digest leaf extra <<< "$relative"
  [[ "$bound_source_sha" =~ ^[a-f0-9]{40}$ && "$bound_digest" =~ ^[a-f0-9]{64}$ \
    && "$leaf" == "runtime.env" && -z "$extra" ]] \
    || fail "Durable runtime environment path is not release-SHA and digest bound."
  for directory in \
    "$RUNTIME_ENV_STORE_ROOT" \
    "$RUNTIME_ENV_STORE_ROOT/by-release" \
    "$RUNTIME_ENV_STORE_ROOT/by-release/$bound_source_sha" \
    "$RUNTIME_ENV_STORE_ROOT/by-release/$bound_source_sha/$bound_digest"
  do
    require_service_group_directory "$directory" "Runtime environment store directory"
  done
  require_service_group_file "$path" "Durable runtime environment"
  [[ "$bound_digest" == "$expected_sha256" ]] \
    || fail "Durable runtime environment path digest does not match the validated digest."
  [[ "$(sha256_file "$path")" == "$expected_sha256" ]] \
    || fail "Durable runtime environment digest mismatch."
}

resolve_runtime_env_pointer() {
  local pointer="$1"
  local target
  local relative
  local bound_source_sha
  local bound_digest
  local leaf
  local extra

  [[ -L "$pointer" ]] || fail "Active runtime environment pointer must be a symlink."
  target="$(readlink -f -- "$pointer")" || fail "Active runtime environment pointer is dangling."
  relative="${target#"$RUNTIME_ENV_STORE_ROOT/by-release/"}"
  [[ "$relative" != "$target" ]] || fail "Active runtime environment pointer resolves outside the managed store."
  IFS='/' read -r bound_source_sha bound_digest leaf extra <<< "$relative"
  [[ "$bound_source_sha" =~ ^[a-f0-9]{40}$ && "$bound_digest" =~ ^[a-f0-9]{64}$ \
    && "$leaf" == "runtime.env" && -z "$extra" ]] \
    || fail "Active runtime environment pointer target is not release-SHA and digest bound."
  validate_durable_runtime_env "$target" "$bound_digest"
  printf '%s' "$target"
}

persist_candidate_runtime_env() {
  local transported_path="$COMPOSE_SERVICE_ENV_FILE"
  local expected_sha256="${PRODUCTION_RUNTIME_ENV_SHA256,,}"
  local release_sha="${SOURCE_SHA,,}"
  local by_release_root
  local release_dir
  local digest_dir
  local candidate_tmp

  [[ "$(id -u)" == "0" ]] || fail "Production runtime environments must be persisted by root."
  [[ "$RUNTIME_ENV_STORE_ROOT" == /* && "$ACTIVE_RUNTIME_ENV_POINTER" == /* \
    && "$ACTIVE_RUNTIME_ENV_POINTER" != "$RUNTIME_ENV_STORE_ROOT" ]] \
    || fail "Runtime environment store and active pointer must be distinct absolute paths."
  [[ "$RUNTIME_ENV_STORE_ROOT" != *"//"* && "$RUNTIME_ENV_STORE_ROOT" != *"/../"* \
    && "$RUNTIME_ENV_STORE_ROOT" != */.. && "$RUNTIME_ENV_STORE_ROOT" != *"/./"* \
    && "$RUNTIME_ENV_STORE_ROOT" != */. ]] \
    || fail "Runtime environment store must be a normalized absolute path."
  require_sha256 "$expected_sha256" "PRODUCTION_RUNTIME_ENV_SHA256"
  require_root_private_file "$transported_path" "Transported runtime environment"
  [[ "$(sha256_file "$transported_path")" == "$expected_sha256" ]] \
    || fail "Transported runtime environment digest mismatch."

  [[ "$SERVICE_GROUP_GID" =~ ^[1-9][0-9]*$ ]] || fail "LunchLineup service group was not resolved."
  mkdir -p -- "$RUNTIME_ENV_STORE_ROOT"
  normalize_runtime_env_directory "$RUNTIME_ENV_STORE_ROOT" "Runtime environment store"

  by_release_root="$RUNTIME_ENV_STORE_ROOT/by-release"
  release_dir="$by_release_root/$release_sha"
  digest_dir="$release_dir/$expected_sha256"
  for directory in "$by_release_root" "$release_dir" "$digest_dir"; do
    mkdir -p -- "$directory"
    normalize_runtime_env_directory "$directory" "Runtime environment store directory"
  done

  RUNTIME_ENV_CANDIDATE_PATH="$digest_dir/runtime.env"
  RUNTIME_ENV_CANDIDATE_SHA256="$expected_sha256"
  if [[ -e "$RUNTIME_ENV_CANDIDATE_PATH" || -L "$RUNTIME_ENV_CANDIDATE_PATH" ]]; then
    normalize_durable_runtime_env_file "$RUNTIME_ENV_CANDIDATE_PATH" "$expected_sha256"
    validate_durable_runtime_env "$RUNTIME_ENV_CANDIDATE_PATH" "$expected_sha256"
    RUNTIME_ENV_CANDIDATE_CREATED=false
  else
    candidate_tmp="$(mktemp "$digest_dir/.runtime.env.XXXXXX")"
    if ! cp -- "$transported_path" "$candidate_tmp"; then
      rm -f -- "$candidate_tmp"
      fail "Could not persist the candidate runtime environment."
    fi
    [[ "$(sha256_file "$candidate_tmp")" == "$expected_sha256" ]] \
      || { rm -f -- "$candidate_tmp"; fail "Candidate runtime environment changed while being persisted."; }
    chown "root:$SERVICE_GROUP_GID" -- "$candidate_tmp"
    chmod 640 -- "$candidate_tmp"
    require_service_group_file "$candidate_tmp" "Candidate durable runtime environment"
    mv -T -- "$candidate_tmp" "$RUNTIME_ENV_CANDIDATE_PATH"
    sync -f "$RUNTIME_ENV_CANDIDATE_PATH"
    RUNTIME_ENV_CANDIDATE_CREATED=true
    validate_durable_runtime_env "$RUNTIME_ENV_CANDIDATE_PATH" "$expected_sha256"
  fi

  if [[ -e "$ACTIVE_RUNTIME_ENV_POINTER" || -L "$ACTIVE_RUNTIME_ENV_POINTER" ]]; then
    RUNTIME_ENV_PREVIOUS_TARGET="$(resolve_runtime_env_pointer "$ACTIVE_RUNTIME_ENV_POINTER")"
    RUNTIME_ENV_PREVIOUS_EXISTED=true
  else
    RUNTIME_ENV_PREVIOUS_TARGET=""
    RUNTIME_ENV_PREVIOUS_EXISTED=false
  fi

  COMPOSE_SERVICE_ENV_FILE="$RUNTIME_ENV_CANDIDATE_PATH"
  PRODUCTION_RUNTIME_ENV_PATH="$RUNTIME_ENV_CANDIDATE_PATH"
  export COMPOSE_SERVICE_ENV_FILE PRODUCTION_RUNTIME_ENV_PATH
  RUNTIME_ENV_STAGE_ACTIVE=true
  echo "runtime_env_persisted path=$RUNTIME_ENV_CANDIDATE_PATH sha=$release_sha digest=$expected_sha256"
}

commit_runtime_env_pointer() {
  local pointer_parent
  local pointer_tmp

  [[ "$RUNTIME_ENV_STAGE_ACTIVE" == "true" ]] || fail "Candidate runtime environment is not staged."
  validate_durable_runtime_env "$RUNTIME_ENV_CANDIDATE_PATH" "$RUNTIME_ENV_CANDIDATE_SHA256"
  pointer_parent="$(dirname "$ACTIVE_RUNTIME_ENV_POINTER")"
  [[ "$pointer_parent" == "$RUNTIME_ENV_STORE_ROOT" ]] \
    || fail "Active runtime environment pointer must be inside the managed store root."
  if [[ -e "$ACTIVE_RUNTIME_ENV_POINTER" && ! -L "$ACTIVE_RUNTIME_ENV_POINTER" ]]; then
    fail "Active runtime environment pointer exists but is not a symlink."
  fi
  pointer_tmp="$RUNTIME_ENV_STORE_ROOT/.current.${SOURCE_SHA,,}.$$"
  rm -f -- "$pointer_tmp"
  ln -s -- "$RUNTIME_ENV_CANDIDATE_PATH" "$pointer_tmp"
  mv -Tf -- "$pointer_tmp" "$ACTIVE_RUNTIME_ENV_POINTER"
  [[ "$(resolve_runtime_env_pointer "$ACTIVE_RUNTIME_ENV_POINTER")" == "$RUNTIME_ENV_CANDIDATE_PATH" ]] \
    || fail "Active runtime environment pointer did not resolve to the candidate bytes."
}

restore_staged_runtime_env() {
  local pointer_tmp
  local current_target=""

  [[ "$RUNTIME_ENV_STAGE_ACTIVE" == "true" ]] || return 0
  if [[ -L "$ACTIVE_RUNTIME_ENV_POINTER" ]]; then
    current_target="$(readlink -f -- "$ACTIVE_RUNTIME_ENV_POINTER" 2>/dev/null || true)"
  elif [[ -e "$ACTIVE_RUNTIME_ENV_POINTER" ]]; then
    echo "Refusing to restore over a non-symlink active runtime environment pointer." >&2
    return 1
  fi

  if [[ "$RUNTIME_ENV_PREVIOUS_EXISTED" == "true" ]]; then
    validate_durable_runtime_env "$RUNTIME_ENV_PREVIOUS_TARGET" "$(basename "$(dirname "$RUNTIME_ENV_PREVIOUS_TARGET")")" || return 1
    pointer_tmp="$RUNTIME_ENV_STORE_ROOT/.current.restore.$$"
    rm -f -- "$pointer_tmp"
    ln -s -- "$RUNTIME_ENV_PREVIOUS_TARGET" "$pointer_tmp" || return 1
    mv -Tf -- "$pointer_tmp" "$ACTIVE_RUNTIME_ENV_POINTER" || return 1
    [[ "$(readlink -f -- "$ACTIVE_RUNTIME_ENV_POINTER")" == "$RUNTIME_ENV_PREVIOUS_TARGET" ]] || return 1
  elif [[ "$current_target" == "$RUNTIME_ENV_CANDIDATE_PATH" ]]; then
    rm -f -- "$ACTIVE_RUNTIME_ENV_POINTER" || return 1
  elif [[ -n "$current_target" ]]; then
    echo "Refusing to remove an active runtime environment pointer not owned by this deploy." >&2
    return 1
  fi

  if [[ "$RUNTIME_ENV_CANDIDATE_CREATED" == "true" && -f "$RUNTIME_ENV_CANDIDATE_PATH" ]]; then
    rm -f -- "$RUNTIME_ENV_CANDIDATE_PATH" || return 1
    rmdir --ignore-fail-on-non-empty -- "$(dirname "$RUNTIME_ENV_CANDIDATE_PATH")" \
      "$(dirname "$(dirname "$RUNTIME_ENV_CANDIDATE_PATH")")" 2>/dev/null || true
  fi
  RUNTIME_ENV_STAGE_ACTIVE=false
  echo "runtime_env_restored active=$ACTIVE_RUNTIME_ENV_POINTER"
}

# Deliberate no-op seam used by local failure-injection fixtures immediately
# after an atomic pointer write. Production execution never overrides it.
post_pointer_commit_checkpoint() {
  :
}

finalize_runtime_env() {
  [[ "$(resolve_runtime_env_pointer "$ACTIVE_RUNTIME_ENV_POINTER")" == "$RUNTIME_ENV_CANDIDATE_PATH" ]] \
    || fail "Runtime environment promotion was not committed."
  RUNTIME_ENV_STAGE_ACTIVE=false
  RUNTIME_ENV_CANDIDATE_CREATED=false
  RUNTIME_ENV_PREVIOUS_TARGET=""
  RUNTIME_ENV_PREVIOUS_EXISTED=false
  echo "runtime_env_active path=$RUNTIME_ENV_CANDIDATE_PATH sha=${SOURCE_SHA,,} digest=$RUNTIME_ENV_CANDIDATE_SHA256"
}
bootstrap_runtime_env() {
  mkdir -p "$SECRETS_DIR"
  if [[ ! -f "$SECRET_ENV_PATH" ]]; then
    if [[ -f .env && ! -L .env ]]; then
      cp .env "$SECRET_ENV_PATH"
      chmod 600 "$SECRET_ENV_PATH"
      echo "Bootstrapped $SECRET_ENV_PATH from existing $APP_DIR/.env"
    else
      fail "Missing secret env file: $SECRET_ENV_PATH"
    fi
  fi
  ln -sfn "$SECRET_ENV_PATH" .env
}

quarantine_worktree_git_pointer() {
  # Worktree syncs can copy a .git file pointer from a local machine. Keep server deploys git-agnostic.
  if [[ -f .git && ! -d .git ]]; then
    mv .git ".git.worktree-link.broken.$(date +%Y%m%d%H%M%S)"
  fi
}

health_deadline_epoch() {
  printf '%s' "$(( $(date +%s) + HEALTH_TIMEOUT_SECONDS ))"
}

health_request_timeout_seconds() {
  local deadline="$1"
  local remaining="$(( deadline - $(date +%s) ))"
  (( remaining > 0 )) || return 1
  if (( remaining < HEALTH_REQUEST_TIMEOUT_SECONDS )); then
    printf '%s' "$remaining"
  else
    printf '%s' "$HEALTH_REQUEST_TIMEOUT_SECONDS"
  fi
}

health_deadline_expired() {
  local deadline="$1"
  (( $(date +%s) >= deadline ))
}

sleep_before_health_retry() {
  local deadline="$1"
  local remaining="$(( deadline - $(date +%s) ))"
  local sleep_seconds="$HEALTH_POLL_SECONDS"
  (( remaining > 0 )) || return 1
  (( sleep_seconds <= remaining )) || sleep_seconds="$remaining"
  sleep "$sleep_seconds"
  ! health_deadline_expired "$deadline"
}

validate_health_deadlines() {
  [[ "$HEALTH_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] && (( HEALTH_TIMEOUT_SECONDS <= 3600 )) \
    || fail "HEALTH_TIMEOUT_SECONDS must be an integer from 1 through 3600."
  [[ "$HEALTH_REQUEST_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] && (( HEALTH_REQUEST_TIMEOUT_SECONDS <= 60 )) \
    || fail "HEALTH_REQUEST_TIMEOUT_SECONDS must be an integer from 1 through 60."
  [[ "$HEALTH_POLL_SECONDS" =~ ^[1-9][0-9]*$ ]] && (( HEALTH_POLL_SECONDS <= 60 )) \
    || fail "HEALTH_POLL_SECONDS must be an integer from 1 through 60."
}

wait_for_health() {
  local url="$1"
  local deadline
  local code="request-not-attempted"
  deadline="$(health_deadline_epoch)"

  while ! health_deadline_expired "$deadline"; do
    local request_timeout
    request_timeout="$(health_request_timeout_seconds "$deadline")" || break
    code=$(curl --silent --show-error \
      --connect-timeout "$request_timeout" \
      --max-time "$request_timeout" \
      --output /dev/null \
      --write-out '%{http_code}' \
      "$url" 2>/dev/null || true)
    if [[ "$code" == "200" ]]; then
      echo "Health check passed: $url"
      return
    fi
    sleep_before_health_retry "$deadline" || break
  done

  echo "Health check timed out after ${HEALTH_TIMEOUT_SECONDS}s (last code: ${code:-request-failed})" >&2
  if [[ "$DEPLOY_SCOPE" == "production" ]]; then
    compose_release ps
  else
    docker compose --env-file "$SECRET_ENV_PATH" ps
  fi
  return 1
}

wait_for_release_health() {
  local url="$1"
  local expected_release="$2"
  local deadline
  local error_path
  EXTERNAL_HEALTH_PROOF_PATH="$(mktemp)"
  error_path="$(mktemp)"
  deadline="$(health_deadline_epoch)"

  while ! health_deadline_expired "$deadline"; do
    local request_timeout
    request_timeout="$(health_request_timeout_seconds "$deadline")" || break
    if EXTERNAL_HEALTH_REQUEST_TIMEOUT_MS="$(( request_timeout * 1000 ))" \
      node scripts/verify-external-health-release.mjs "$url" "$expected_release" \
        --output "$EXTERNAL_HEALTH_PROOF_PATH" > /dev/null 2> "$error_path"; then
      rm -f "$error_path"
      echo "External health release identity passed: $url serves $expected_release"
      return
    fi
    sleep_before_health_retry "$deadline" || break
  done

  echo "External health release identity timed out after ${HEALTH_TIMEOUT_SECONDS}s: $(cat "$error_path")" >&2
  rm -f "$error_path" "$EXTERNAL_HEALTH_PROOF_PATH"
  EXTERNAL_HEALTH_PROOF_PATH=""
  return 1
}

validate_production_web_url() {
  python3 - "$PRODUCTION_WEB_URL" <<'PY'
import ipaddress
import sys
from urllib.parse import urlsplit

url = sys.argv[1]
parsed = urlsplit(url)
host = (parsed.hostname or "").lower()

if parsed.scheme != "https" or not host:
    raise SystemExit("PRODUCTION_WEB_URL must be an HTTPS URL with a public hostname.")
if parsed.username or parsed.password or parsed.query or parsed.fragment:
    raise SystemExit("PRODUCTION_WEB_URL must not contain credentials, a query, or a fragment.")
if parsed.path not in ("", "/"):
    raise SystemExit("PRODUCTION_WEB_URL must target the public Next.js root route (/), not an API or health path.")
if "." not in host or host == "localhost" or host.endswith((".local", ".test", ".invalid", ".example")):
    raise SystemExit("PRODUCTION_WEB_URL must use a real public hostname.")

try:
    address = ipaddress.ip_address(host)
except ValueError:
    address = None

if address is not None and not address.is_global:
    raise SystemExit("PRODUCTION_WEB_URL must not use a loopback or private IP address.")
PY
}

wait_for_web_surface() {
  local url="$1"
  local label="$2"
  local expected_release="${3:-}"
  local body
  local headers
  local probe_url
  local deadline
  local reason="not checked"

  body="$(mktemp)"
  headers="$(mktemp)"
  probe_url="${url%/}/?lunchlineup_deploy_probe=${SOURCE_SHA:-development}"
  deadline="$(health_deadline_epoch)"

  while ! health_deadline_expired "$deadline"; do
    local code
    local content_type
    local request_timeout
    local response_bytes
    local served_release

    request_timeout="$(health_request_timeout_seconds "$deadline")" || break
    : > "$body"
    : > "$headers"
    code=$(curl --silent --show-error \
      --connect-timeout "$request_timeout" \
      --max-time "$request_timeout" \
      --header 'Cache-Control: no-cache' \
      --dump-header "$headers" \
      --output "$body" \
      --write-out '%{http_code}' \
      "$probe_url" 2>/dev/null || true)
    content_type="$(awk 'BEGIN { IGNORECASE=1 } /^Content-Type:/ { sub(/\r$/, ""); sub(/^[^:]+:[[:space:]]*/, ""); value=$0 } END { print value }' "$headers")"
    served_release="$(awk 'BEGIN { IGNORECASE=1 } /^X-LunchLineUp-Release:/ { sub(/\r$/, ""); sub(/^[^:]+:[[:space:]]*/, ""); value=$0 } END { print value }' "$headers")"
    response_bytes="$(stat -c%s "$body" 2>/dev/null || printf '0')"

    if [[ "$code" != "200" ]]; then
      reason="HTTP ${code:-request-failed}"
    elif [[ "$content_type" != text/html* ]]; then
      reason="unexpected Content-Type ${content_type:-missing}"
    elif (( response_bytes < 1024 )); then
      reason="response too small (${response_bytes} bytes)"
    elif [[ -n "$expected_release" && "$served_release" != "$expected_release" ]]; then
      reason="release header mismatch (expected $expected_release, received ${served_release:-missing})"
    elif ! grep -Fq '<h1>LunchLineup</h1>' "$body"; then
      reason="missing LunchLineup application heading"
    elif ! grep -Fq '/_next/static/' "$body"; then
      reason="missing Next.js static asset reference"
    else
      rm -f "$body" "$headers"
      echo "$label check passed: $url (200 HTML, ${response_bytes} bytes, release $served_release, LunchLineup and Next.js markers present)"
      return
    fi

    sleep_before_health_retry "$deadline" || break
  done

  rm -f "$body" "$headers"
  echo "$label check timed out after ${HEALTH_TIMEOUT_SECONDS}s: $url ($reason)" >&2
  return 1
}

wait_for_required_services() {
  local services=(pdf-parser worker engine webhook-replay prometheus alertmanager loki promtail otel-collector tempo grafana)
  local deadline
  local pending=()
  deadline="$(health_deadline_epoch)"

  while ! health_deadline_expired "$deadline"; do
    pending=()
    local service
    for service in "${services[@]}"; do
      local container_id
      local health_status
      local state_status
      container_id="$(compose_release ps -q "$service" 2>/dev/null || true)"
      if [[ -z "$container_id" ]]; then
        pending+=("$service:missing")
        continue
      fi

      health_status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
      state_status="$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || true)"
      if [[ -n "$health_status" && "$health_status" != "healthy" ]]; then
        pending+=("$service:$health_status")
      elif [[ -z "$health_status" && "$state_status" != "running" ]]; then
        pending+=("$service:${state_status:-unknown}")
      fi
    done

    if (( ${#pending[@]} == 0 )); then
      echo "Required service health passed: ${services[*]}"
      return
    fi

    sleep_before_health_retry "$deadline" || break
  done


  echo "Required service health timed out after ${HEALTH_TIMEOUT_SECONDS}s: ${pending[*]}" >&2
  compose_release ps
  compose_release logs --tail=100 "${services[@]}" || true
  return 1
}

verify_release_manifest() {
  require_file "$RELEASE_MANIFEST_PATH" "Release manifest"
  command -v python3 >/dev/null 2>&1 || fail "python3 is required to verify the release manifest on VM217."

  python3 - "$RELEASE_MANIFEST_PATH" "$SOURCE_SHA" "$PRODUCTION_API_HEALTH_URL" "$COMPOSE_SERVICE_ENV_FILE" "$APP_DIR" <<'PY'
import hashlib
import ipaddress
import json
import re
import sys
from urllib.parse import urlsplit

manifest_path, source_sha, production_api_health_url, runtime_env_path, app_dir = sys.argv[1:6]
required_services = ["api", "api-v2", "web", "engine", "worker", "migrate", "control", "backup"]

with open(manifest_path, "r", encoding="utf-8") as handle:
    manifest = json.load(handle)

if manifest.get("sourceSha") != source_sha:
    raise SystemExit(f"Manifest sourceSha {manifest.get('sourceSha')} does not match {source_sha}.")

deployment_contract = manifest.get("deploymentContract")
if not isinstance(deployment_contract, dict) or deployment_contract.get("algorithm") != "sha256":
    raise SystemExit("Release manifest deploymentContract with sha256 algorithm is required.")
deployment_files = deployment_contract.get("files")
if not isinstance(deployment_files, dict) or not deployment_files:
    raise SystemExit("Release manifest deploymentContract.files is required.")
for relative_path, expected_sha in deployment_files.items():
    if not isinstance(relative_path, str) or relative_path.startswith(("/", "../")) or "/../" in relative_path:
        raise SystemExit(f"Unsafe deployment contract path: {relative_path}")
    file_path = f"{app_dir}/{relative_path}"
    try:
        with open(file_path, "rb") as handle:
            actual_sha = hashlib.sha256(handle.read()).hexdigest()
    except OSError as error:
        raise SystemExit(f"Deployment contract file is unavailable: {relative_path}: {error}")
    if actual_sha != expected_sha:
        raise SystemExit(f"Deployment contract hash mismatch: {relative_path}")

health_proof = manifest.get("productionHealthProof")
if not isinstance(health_proof, dict):
    raise SystemExit("Release manifest productionHealthProof object is required.")
domain = str(health_proof.get("domain", "")).lower().rstrip(".")
health_url = str(health_proof.get("url", ""))
parsed_health_url = urlsplit(health_url)
host = (parsed_health_url.hostname or "").lower().rstrip(".")
if health_url != production_api_health_url:
    raise SystemExit("PRODUCTION_API_HEALTH_URL must exactly match release manifest productionHealthProof.url.")
if parsed_health_url.scheme != "https" or host != domain or parsed_health_url.path not in ("/health", "/api/health"):
    raise SystemExit("Release manifest production API health proof must use HTTPS on DOMAIN and target /health or /api/health.")
if parsed_health_url.username or parsed_health_url.password or parsed_health_url.query or parsed_health_url.fragment:
    raise SystemExit("Release manifest production API health proof must not contain credentials, a query, or a fragment.")
if parsed_health_url.port not in (None, 443):
    raise SystemExit("Release manifest production API health proof must use the default HTTPS port.")
if "." not in host or host == "localhost" or host.endswith((".local", ".test", ".invalid", ".example")):
    raise SystemExit("Release manifest production API health proof must use a real public hostname.")
try:
    address = ipaddress.ip_address(host)
except ValueError:
    address = None
if address is not None and not address.is_global:
    raise SystemExit("Release manifest production API health proof must not use a loopback or private IP address.")

runtime_env = {}
with open(runtime_env_path, "r", encoding="utf-8") as handle:
    for raw_line in handle:
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.removeprefix("export ").split("=", 1)
        runtime_env[key.strip()] = value.strip().strip("\"'")
if runtime_env.get("DOMAIN", "").lower().rstrip(".") != domain:
    raise SystemExit("Release manifest productionHealthProof.domain must match runtime DOMAIN.")
if runtime_env.get("PRODUCTION_API_HEALTH_URL") != health_url:
    raise SystemExit("Release manifest productionHealthProof.url must match runtime PRODUCTION_API_HEALTH_URL.")

images = manifest.get("images")
if not isinstance(images, dict):
    raise SystemExit("Release manifest images object is required.")

for service in required_services:
    image = images.get(service)
    if not isinstance(image, dict):
        raise SystemExit(f"images.{service} is required.")

    ref = str(image.get("ref", "")).strip()
    digest = str(image.get("digest", "")).strip()
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", digest, re.IGNORECASE):
        raise SystemExit(f"images.{service}.digest must be a sha256 digest.")
    if "$" in ref or "${" in ref:
        raise SystemExit(f"images.{service}.ref must be resolved, got {ref}.")
    if re.search(r"(^|[/:=])(latest|local)([@:\s]|$)", ref, re.IGNORECASE):
        raise SystemExit(f"images.{service}.ref must not use latest or local tags.")
    if f":{source_sha}@{digest}" not in ref:
        raise SystemExit(f"images.{service}.ref must pin {source_sha} to {digest}.")
    if not re.search(r"@sha256:[a-f0-9]{64}$", ref, re.IGNORECASE):
        raise SystemExit(f"images.{service}.ref must include an immutable digest.")
    print(f"{service}={ref}")
PY
}

pull_release_images() {
  local image_map
  image_map="$(mktemp)"
  verify_release_manifest > "$image_map"

  while IFS='=' read -r service ref; do
    [[ -n "$service" && -n "$ref" ]] || continue
    echo "Pulling immutable release image for $service: $ref"
    docker pull "$ref"
    docker tag "$ref" "$COMPOSE_IMAGE_PREFIX/$service:$SOURCE_SHA"
  done < "$image_map"

  rm -f "$image_map"
}

compose_release() {
  COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" \
    COMPOSE_FILE="$COMPOSE_FILE" \
    COMPOSE_PROFILES="" \
    IMAGE_PREFIX="$COMPOSE_IMAGE_PREFIX" \
    IMAGE_TAG="$SOURCE_SHA" \
    docker compose \
      --project-name "$COMPOSE_PROJECT_NAME" \
      --project-directory "$COMPOSE_PROJECT_DIRECTORY" \
      --env-file "$COMPOSE_SERVICE_ENV_FILE" \
      --file "$COMPOSE_FILE" \
      "$@"
}

configure_migration_mode() {
  case "$DEPLOY_OPERATION" in
    deploy)
      DEPLOY_MIGRATION_MODE="${DEPLOY_MIGRATION_MODE:-apply}"
      ;;
    rollback)
      DEPLOY_MIGRATION_MODE="${DEPLOY_MIGRATION_MODE:-skip}"
      ;;
    *)
      fail "Unsupported VM217_DEPLOY_OPERATION '$DEPLOY_OPERATION'. Use deploy or rollback."
      ;;
  esac

  if [[ "$DEPLOY_MIGRATION_MODE" != "apply" && "$DEPLOY_MIGRATION_MODE" != "skip" ]]; then
    fail "DEPLOY_MIGRATION_MODE must be apply or skip."
  fi
  if [[ "$DEPLOY_OPERATION" == "rollback" && "$DEPLOY_MIGRATION_MODE" != "skip" ]]; then
    fail "Rollback refuses to apply an older release schema; DEPLOY_MIGRATION_MODE must remain skip."
  fi

  if [[ "$DEPLOY_OPERATION" == "deploy" ]]; then
    MIGRATION_SOURCE_SHA="$SOURCE_SHA"
    MIGRATION_BASELINE_SOURCE_SHA="$EXPECTED_CURRENT_RELEASE_SHA"
  else
    MIGRATION_SOURCE_SHA=""
    MIGRATION_BASELINE_SOURCE_SHA=""
  fi

  export DEPLOY_MIGRATION_MODE
  export MIGRATION_BASELINE_SOURCE_SHA
  export MIGRATION_SOURCE_SHA
  export ROLLBACK_SCHEMA_COMPATIBILITY_VERIFIED=false
}

preflight_rollback_schema_compatibility() {
  [[ "$DEPLOY_OPERATION" == "rollback" ]] || return

  local expected_confirmation="verified-compatible-with-current-schema:$SOURCE_SHA"
  if [[ "$ROLLBACK_SCHEMA_COMPATIBILITY_CONFIRM" != "$expected_confirmation" ]]; then
    fail "Rollback requires ROLLBACK_SCHEMA_COMPATIBILITY_CONFIRM=$expected_confirmation after review of the read-only schema diff."
  fi

  local diff_path
  diff_path="$(mktemp)"
  if ! compose_release run --rm --no-deps --entrypoint sh migrate -ec '
    DATABASE_URL="$MIGRATION_DATABASE_URL" npx prisma migrate diff \
      --from-schema-datamodel=/app/packages/db/prisma/schema.prisma \
      --to-url="$MIGRATION_DATABASE_URL" \
      --script
  ' > "$diff_path"; then
    rm -f "$diff_path"
    fail "Rollback schema compatibility preflight could not compare the rollback schema to the current database."
  fi

  if ! python3 scripts/verify-rollback-schema-compatibility.py "$diff_path"; then
    rm -f "$diff_path"
    fail "Rollback schema compatibility preflight failed closed; keep the current release running and review every schema difference."
  fi

  rm -f "$diff_path"
  export ROLLBACK_SCHEMA_COMPATIBILITY_VERIFIED=true
  echo "rollback_schema_compatibility_ok sha=$SOURCE_SHA migration_mode=skip"
}

preflight_rollback_raw_migrations() {
  [[ "$DEPLOY_OPERATION" == "rollback" ]] || return
  require_file "$ROLLBACK_CANDIDATE_RELEASE_MANIFEST_PATH" "ROLLBACK_CANDIDATE_RELEASE_MANIFEST_PATH"
  require_full_sha "$ROLLBACK_CANDIDATE_SOURCE_SHA" "ROLLBACK_CANDIDATE_SOURCE_SHA"
  require_file "$OLD_RELEASE_COMPATIBILITY_PROOF_PATH" "OLD_RELEASE_COMPATIBILITY_PROOF_PATH"
  require_file "$OLD_RELEASE_COMPATIBILITY_SIGNATURE_BUNDLE_PATH" "OLD_RELEASE_COMPATIBILITY_SIGNATURE_BUNDLE_PATH"
  require_sha256 "$OLD_RELEASE_COMPATIBILITY_PROOF_SHA256" "OLD_RELEASE_COMPATIBILITY_PROOF_SHA256"
  require_sha256 "$OLD_RELEASE_COMPATIBILITY_SIGNATURE_BUNDLE_SHA256" "OLD_RELEASE_COMPATIBILITY_SIGNATURE_BUNDLE_SHA256"
  [[ "$(sha256_file "$OLD_RELEASE_COMPATIBILITY_PROOF_PATH")" == "$OLD_RELEASE_COMPATIBILITY_PROOF_SHA256" ]] \
    || fail "Old-release compatibility proof changed after signed transport verification."
  [[ "$(sha256_file "$OLD_RELEASE_COMPATIBILITY_SIGNATURE_BUNDLE_PATH")" == "$OLD_RELEASE_COMPATIBILITY_SIGNATURE_BUNDLE_SHA256" ]] \
    || fail "Old-release compatibility signature bundle changed after transport verification."
  node "$ROLLBACK_CANDIDATE_DEPLOYMENT_ROOT/scripts/verify-old-release-compatibility.mjs" \
    "$OLD_RELEASE_COMPATIBILITY_PROOF_PATH" \
    "$SOURCE_SHA" \
    "$ROLLBACK_CANDIDATE_SOURCE_SHA"
  node "$ROLLBACK_CANDIDATE_DEPLOYMENT_ROOT/scripts/verify-raw-migration-rollback.mjs" \
    --rollback-manifest "$RELEASE_MANIFEST_PATH" \
    --candidate-manifest "$ROLLBACK_CANDIDATE_RELEASE_MANIFEST_PATH" \
    --candidate-root "$ROLLBACK_CANDIDATE_DEPLOYMENT_ROOT" \
    --policy "$ROLLBACK_CANDIDATE_DEPLOYMENT_ROOT/scripts/raw-migration-rollback-policy.json" \
    --old-release-compatibility-proof "$OLD_RELEASE_COMPATIBILITY_PROOF_PATH"
}

preflight_expected_current_release() {
  [[ "$DEPLOY_OPERATION" == "deploy" && -n "$EXPECTED_CURRENT_RELEASE_SHA" ]] || return
  require_full_sha "$EXPECTED_CURRENT_RELEASE_SHA" "EXPECTED_CURRENT_RELEASE_SHA"
  [[ -L "$ACTIVE_RELEASE_POINTER" ]] \
    || fail "Authenticated registry current SHA cannot be reconciled with a missing durable active release pointer."
  local active_target
  local marker
  active_target="$(readlink -f -- "$ACTIVE_RELEASE_POINTER")" \
    || fail "Authenticated registry current SHA cannot be reconciled with a dangling active release pointer."
  marker="$active_target/DEPLOYED_GIT_SHA"
  [[ -f "$marker" && ! -L "$marker" ]] \
    || fail "Authenticated registry current SHA cannot be reconciled with the live release identity marker."
  [[ "$(tr -d '\r\n' < "$marker")" == "$EXPECTED_CURRENT_RELEASE_SHA" ]] \
    || fail "Live release SHA does not match the authenticated release registry current pointer; refusing candidate mutation."
  echo "current_release_pointer_match_ok sha=$EXPECTED_CURRENT_RELEASE_SHA active=$ACTIVE_RELEASE_POINTER"
}

preflight_webhook_rollback_keys() {
  node scripts/webhook-key-rollback-readiness.mjs verify \
    --runtime-env "$COMPOSE_SERVICE_ENV_FILE" \
    --state "$WEBHOOK_KEY_READINESS_STATE_PATH" \
    --candidate-source-sha "$SOURCE_SHA"
}

validate_candidate_release_path() {
  local production_root
  local expected_release
  production_root="$(dirname "$ACTIVE_RELEASE_POINTER")"
  expected_release="$production_root/releases/${SOURCE_SHA,,}"
  [[ "$APP_DIR" == "$expected_release" && -d "$APP_DIR" && ! -L "$APP_DIR" ]] \
    || fail "Production APP_DIR must be the exact retained releases/<source SHA> path."
  [[ "$(readlink -f -- "$APP_DIR")" == "$expected_release" ]] \
    || fail "Production APP_DIR must resolve canonically to the retained candidate release."
  [[ "$(stat -c '%d' -- "$production_root")" == "$(stat -c '%d' -- "$APP_DIR")" ]] \
    || fail "Candidate retained release must share the production root filesystem."
}

lock_candidate_release_bytes() {
  local invalid
  [[ -z "$(find "$APP_DIR" -mindepth 1 -type l -print -quit)" ]] \
    || fail "Candidate retained release contains a symlink."
  [[ -z "$(find "$APP_DIR" -mindepth 1 ! -type d ! -type f -print -quit)" ]] \
    || fail "Candidate retained release contains an unsupported file type."
  [[ -z "$(find "$APP_DIR" -type f \( -name .env -o -name runtime.env -o -name runtime-secret.json \) -print -quit)" ]] \
    || fail "Candidate retained release contains runtime secret material."

  find "$APP_DIR" -type d -exec chown "root:$SERVICE_GROUP_GID" -- {} + -exec chmod 550 -- {} +
  find "$APP_DIR" -type f ! -perm /0111 -exec chown "root:$SERVICE_GROUP_GID" -- {} + -exec chmod 440 -- {} +
  find "$APP_DIR" -type f -perm /0111 -exec chown "root:$SERVICE_GROUP_GID" -- {} + -exec chmod 550 -- {} +

  invalid="$(find "$APP_DIR" -type d \( ! -uid 0 -o ! -gid "$SERVICE_GROUP_GID" -o ! -perm 0550 \) -print -quit)"
  [[ -z "$invalid" ]] || fail "Candidate retained release directories are not immutable service-group paths."
  invalid="$(find "$APP_DIR" -type f \( ! -uid 0 -o ! -gid "$SERVICE_GROUP_GID" \) -print -quit)"
  [[ -z "$invalid" ]] || fail "Candidate retained release files have invalid ownership."
  invalid="$(find "$APP_DIR" -type f ! -perm 0440 ! -perm 0550 -print -quit)"
  [[ -z "$invalid" ]] || fail "Candidate retained release files have permissions outside 0440/0550."
}

verify_deploy_alerts() {
  local deadline
  local now
  local sleep_seconds
  local stable_since=0
  deadline=$(( $(date +%s) + DEPLOY_ALERT_BOOT_GRACE_SECONDS + DEPLOY_ALERT_STABILITY_SECONDS ))

  while true; do
    if node scripts/verify-deploy-alerts.mjs query \
      --url "$DEPLOY_ALERT_RULES_URL" \
      --alertmanager-url "$DEPLOY_ALERTMANAGER_URL" \
      --runtime-env "$COMPOSE_SERVICE_ENV_FILE" \
      --scope-prefix "$DEPLOY_ALERT_SCOPE_PREFIX" \
      --timeout-ms "$DEPLOY_ALERT_REQUEST_TIMEOUT_MS" \
      --max-response-age-ms "$DEPLOY_ALERT_MAX_RESPONSE_AGE_MS"; then
      now=$(date +%s)
      if (( stable_since == 0 )); then
        stable_since="$now"
      fi
      if (( now - stable_since >= DEPLOY_ALERT_STABILITY_SECONDS )); then
        echo "deploy_alert_stability_ok clean_seconds=$(( now - stable_since ))"
        return
      fi
    else
      stable_since=0
      now=$(date +%s)
    fi
    if (( now >= deadline )); then
      echo "Critical LunchLineup alerts did not remain continuously inactive for the required stability window." >&2
      return 1
    fi
    sleep_seconds="$DEPLOY_ALERT_POLL_SECONDS"
    if (( now + sleep_seconds > deadline )); then
      sleep_seconds=$(( deadline - now ))
    fi
    (( sleep_seconds > 0 )) && sleep "$sleep_seconds"
  done
}

read_backup_enabled_state() {
  local unit="$1"
  local unit_was_present="$2"
  local output
  local status=0

  if output="$(systemctl is-enabled "$unit" 2>/dev/null)"; then
    status=0
  else
    status=$?
  fi
  [[ "$output" != *$'\n'* && "$output" != *$'\r'* ]] || return 1
  case "$output" in
    enabled | enabled-runtime | linked | linked-runtime | alias)
      [[ "$status" -eq 0 ]] || return 1
      printf 'true'
      ;;
    disabled | static | indirect | generated | transient)
      [[ "$status" -ne 0 ]] || return 1
      printf 'false'
      ;;
    not-found)
      [[ "$status" -ne 0 && "$unit_was_present" == "false" ]] || return 1
      printf 'false'
      ;;
    *) return 1 ;;
  esac
}

read_backup_active_state() {
  local unit="$1"
  local unit_was_present="$2"
  local output
  local status=0

  if output="$(systemctl is-active "$unit" 2>/dev/null)"; then
    status=0
  else
    status=$?
  fi
  [[ "$output" != *$'\n'* && "$output" != *$'\r'* ]] || return 1
  case "$output" in
    active)
      [[ "$status" -eq 0 ]] || return 1
      printf 'true'
      ;;
    inactive | failed)
      [[ "$status" -ne 0 ]] || return 1
      printf 'false'
      ;;
    unknown | not-found)
      [[ "$status" -ne 0 && "$unit_was_present" == "false" ]] || return 1
      printf 'false'
      ;;
    *) return 1 ;;
  esac
}

backup_restore_problem() {
  echo "Backup deployment restoration failed: $*" >&2
  backup_restore_failed=true
}

reconcile_backup_runtime_state() {
  local unit="$1"
  local unit_was_present="$2"
  local expected_enabled="$3"
  local expected_active="$4"
  local actual_enabled
  local actual_active

  if ! actual_enabled="$(read_backup_enabled_state "$unit" "$unit_was_present")"; then
    backup_restore_problem "could not read $unit enabled state"
  elif [[ "$actual_enabled" != "$expected_enabled" ]]; then
    if [[ "$expected_enabled" == "true" ]]; then
      systemctl enable "$unit" >/dev/null 2>&1 || backup_restore_problem "could not enable $unit"
    else
      systemctl disable "$unit" >/dev/null 2>&1 || backup_restore_problem "could not disable $unit"
    fi
  fi

  if ! actual_active="$(read_backup_active_state "$unit" "$unit_was_present")"; then
    backup_restore_problem "could not read $unit active state"
  elif [[ "$actual_active" != "$expected_active" ]]; then
    if [[ "$expected_active" == "true" ]]; then
      systemctl start "$unit" >/dev/null 2>&1 || backup_restore_problem "could not start $unit"
    else
      systemctl stop "$unit" >/dev/null 2>&1 || backup_restore_problem "could not stop $unit"
    fi
  fi
}

verify_backup_runtime_state() {
  local unit="$1"
  local unit_was_present="$2"
  local expected_enabled="$3"
  local expected_active="$4"
  local actual_enabled
  local actual_active

  actual_enabled="$(read_backup_enabled_state "$unit" "$unit_was_present")" \
    || { backup_restore_problem "could not independently confirm $unit enabled state"; return; }
  [[ "$actual_enabled" == "$expected_enabled" ]] \
    || backup_restore_problem "$unit enabled state does not match its snapshot"
  actual_active="$(read_backup_active_state "$unit" "$unit_was_present")" \
    || { backup_restore_problem "could not independently confirm $unit active state"; return; }
  [[ "$actual_active" == "$expected_active" ]] \
    || backup_restore_problem "$unit active state does not match its snapshot"
}

verify_backup_unit_bytes() {
  local unit="$1"
  local unit_was_present="$2"
  local unit_path="$BACKUP_SYSTEMD_UNIT_DIR/$unit"
  local snapshot_path="$BACKUP_SYSTEMD_STATE_DIR/unit-$unit"

  if [[ "$unit_was_present" == "true" ]]; then
    if [[ -L "$snapshot_path" ]]; then
      [[ -L "$unit_path" && "$(readlink -- "$unit_path")" == "$(readlink -- "$snapshot_path")" ]] \
        || backup_restore_problem "restored symlink for $unit does not match its snapshot"
    else
      [[ -f "$unit_path" && ! -L "$unit_path" ]] && cmp -s -- "$snapshot_path" "$unit_path" \
        || backup_restore_problem "restored bytes for $unit do not match its snapshot"
    fi
  else
    [[ ! -e "$unit_path" && ! -L "$unit_path" ]] \
      || backup_restore_problem "newly introduced $unit remains after restoration"
  fi
}

clear_backup_stage_snapshot_paths() {
  BACKUP_RELEASE_ENV_PREVIOUS_PATH=""
  BACKUP_RELEASE_ENV_PREVIOUS_EXISTED=false
  BACKUP_SYSTEMD_STATE_DIR=""
  BACKUP_RUNTIME_STATE_PATH=""
}

remove_confirmed_backup_stage_snapshots() {
  local previous_path="$BACKUP_RELEASE_ENV_PREVIOUS_PATH"
  local state_dir="$BACKUP_SYSTEMD_STATE_DIR"

  BACKUP_RELEASE_ENV_STAGE_ACTIVE=false
  clear_backup_stage_snapshot_paths
  rm -f -- "$previous_path" || return 1
  rm -rf -- "$state_dir" || return 1
}

restore_staged_backup_release_pointer() {
  local unit
  local unit_was_present
  local was_enabled
  local was_active
  local unit_path
  local snapshot_path
  local restore_tmp
  local previous_path="$BACKUP_RELEASE_ENV_PREVIOUS_PATH"
  local state_dir="$BACKUP_SYSTEMD_STATE_DIR"
  local runtime_state_path="$BACKUP_RUNTIME_STATE_PATH"
  backup_restore_failed=false

  [[ "$BACKUP_RELEASE_ENV_STAGE_ACTIVE" == "true" ]] || return 0
  if [[ ! -f "$runtime_state_path" || ! -f "$state_dir/units" ]]; then
    echo "Backup deployment restoration failed: exact systemd state snapshot is missing; snapshots preserved: env=$previous_path systemd=$state_dir" >&2
    return 1
  fi
  if [[ "$BACKUP_RELEASE_ENV_PREVIOUS_EXISTED" == "true" \
    && ( ! -f "$previous_path" || -L "$previous_path" ) ]]; then
    echo "Backup deployment restoration failed: previous backup release pointer snapshot is missing or unsafe; snapshots preserved: env=$previous_path systemd=$state_dir" >&2
    return 1
  fi

  if [[ "$BACKUP_RELEASE_ENV_PREVIOUS_EXISTED" == "true" ]]; then
    restore_tmp="$(mktemp "$(dirname "$BACKUP_RELEASE_ENV_PATH")/backup-release.env.restore.XXXXXX")" \
      || backup_restore_problem "could not allocate a backup release pointer restore file"
    if [[ -n "${restore_tmp:-}" ]]; then
      cp -p -- "$previous_path" "$restore_tmp" \
        || backup_restore_problem "could not copy the previous backup release pointer"
      mv -f -- "$restore_tmp" "$BACKUP_RELEASE_ENV_PATH" \
        || backup_restore_problem "could not restore the previous backup release pointer"
    fi
    [[ -f "$BACKUP_RELEASE_ENV_PATH" && ! -L "$BACKUP_RELEASE_ENV_PATH" ]] \
      && cmp -s -- "$previous_path" "$BACKUP_RELEASE_ENV_PATH" \
      || backup_restore_problem "backup release pointer bytes do not match the snapshot"
  else
    rm -f -- "$BACKUP_RELEASE_ENV_PATH" \
      || backup_restore_problem "could not remove the newly introduced backup release pointer"
    [[ ! -e "$BACKUP_RELEASE_ENV_PATH" && ! -L "$BACKUP_RELEASE_ENV_PATH" ]] \
      || backup_restore_problem "newly introduced backup release pointer remains"
  fi

  while IFS='|' read -r unit unit_was_present was_enabled was_active; do
    [[ -n "$unit" ]] || continue
    if [[ "$unit_was_present" == "false" ]]; then
      reconcile_backup_runtime_state "$unit" true false false
    fi
  done < "$runtime_state_path"

  while IFS='|' read -r unit unit_was_present; do
    [[ -n "$unit" ]] || continue
    unit_path="$BACKUP_SYSTEMD_UNIT_DIR/$unit"
    snapshot_path="$state_dir/unit-$unit"
    if [[ "$unit_was_present" == "true" ]]; then
      rm -f -- "$unit_path" || backup_restore_problem "could not remove candidate bytes for $unit"
      cp -a -- "$snapshot_path" "$unit_path" || backup_restore_problem "could not restore snapshot bytes for $unit"
    else
      rm -f -- "$unit_path" || backup_restore_problem "could not remove newly introduced $unit"
    fi
  done < "$state_dir/units"

  systemctl daemon-reload \
    || backup_restore_problem "systemd daemon-reload failed after deployment restoration"

  while IFS='|' read -r unit unit_was_present was_enabled was_active; do
    [[ -n "$unit" ]] || continue
    if [[ "$unit_was_present" == "true" ]]; then
      reconcile_backup_runtime_state "$unit" "$unit_was_present" "$was_enabled" "$was_active"
    fi
  done < "$runtime_state_path"

  while IFS='|' read -r unit unit_was_present was_enabled was_active; do
    [[ -n "$unit" ]] || continue
    verify_backup_unit_bytes "$unit" "$unit_was_present"
    verify_backup_runtime_state "$unit" "$unit_was_present" "$was_enabled" "$was_active"
  done < "$runtime_state_path"

  if [[ "$backup_restore_failed" == "true" ]]; then
    echo "Backup deployment restore snapshots preserved: env=$previous_path systemd=$state_dir" >&2
    return 1
  fi
  remove_confirmed_backup_stage_snapshots \
    || { echo "Confirmed backup deployment state was restored, but snapshot cleanup failed: env=$previous_path systemd=$state_dir" >&2; return 1; }
  echo "backup_release_env_restored path=$BACKUP_RELEASE_ENV_PATH units=exact runtime_state=confirmed"
}

cleanup_staged_release_state() {
  local exit_code=$?
  trap - EXIT
  set +e
  if [[ "$BACKUP_RELEASE_ENV_STAGE_ACTIVE" == "true" ]]; then
    restore_staged_backup_release_pointer || exit_code=1
  fi
  if [[ "$RUNTIME_ENV_STAGE_ACTIVE" == "true" ]]; then
    restore_staged_runtime_env || exit_code=1
  fi
  exit "$exit_code"
}

stage_backup_release_pointer() {
  local backup_release_env_dir
  local backup_release_env_tmp
  local unit
  local unit_path
  local unit_was_present
  local was_enabled
  local was_active

  [[ "$BACKUP_RELEASE_ENV_STAGE_ACTIVE" == "false" ]] || fail "A backup release pointer is already staged."
  [[ "$RUNTIME_ENV_STAGE_ACTIVE" == "true" ]] || fail "The durable candidate runtime environment is not staged."
  validate_durable_runtime_env "$RUNTIME_ENV_CANDIDATE_PATH" "$RUNTIME_ENV_CANDIDATE_SHA256"

  backup_release_env_dir="$(dirname "$BACKUP_RELEASE_ENV_PATH")"
  mkdir -p "$backup_release_env_dir"
  BACKUP_RELEASE_ENV_PREVIOUS_PATH="$(mktemp "$backup_release_env_dir/backup-release.env.previous.XXXXXX")"
  BACKUP_SYSTEMD_STATE_DIR="$(mktemp -d "$backup_release_env_dir/backup-systemd-state.XXXXXX")"
  BACKUP_RUNTIME_STATE_PATH="$BACKUP_SYSTEMD_STATE_DIR/runtime-state"
  : > "$BACKUP_RUNTIME_STATE_PATH"
  : > "$BACKUP_SYSTEMD_STATE_DIR/units"

  if [[ -f "$BACKUP_RELEASE_ENV_PATH" ]]; then
    cp -p "$BACKUP_RELEASE_ENV_PATH" "$BACKUP_RELEASE_ENV_PREVIOUS_PATH"
    BACKUP_RELEASE_ENV_PREVIOUS_EXISTED=true
  else
    BACKUP_RELEASE_ENV_PREVIOUS_EXISTED=false
  fi

  for unit in "${BACKUP_UNITS[@]}"; do
    unit_path="$BACKUP_SYSTEMD_UNIT_DIR/$unit"
    unit_was_present=false
    if [[ -e "$unit_path" || -L "$unit_path" ]]; then
      cp -a -- "$unit_path" "$BACKUP_SYSTEMD_STATE_DIR/unit-$unit"
      unit_was_present=true
    fi
    printf '%s|%s\n' "$unit" "$unit_was_present" >> "$BACKUP_SYSTEMD_STATE_DIR/units"
    was_enabled="$(read_backup_enabled_state "$unit" "$unit_was_present")" \
      || fail "Cannot safely snapshot $unit enabled state before deployment."
    was_active="$(read_backup_active_state "$unit" "$unit_was_present")" \
      || fail "Cannot safely snapshot $unit active state before deployment."
    printf '%s|%s|%s|%s\n' "$unit" "$unit_was_present" "$was_enabled" "$was_active" \
      >> "$BACKUP_RUNTIME_STATE_PATH"
  done

  BACKUP_RELEASE_ENV_STAGE_ACTIVE=true
  systemctl disable --now "${BACKUP_TIMERS[@]}" >/dev/null 2>&1 \
    || fail "Could not disable backup timers before staging the candidate release."

  backup_release_env_tmp="$(mktemp "$backup_release_env_dir/backup-release.env.tmp.XXXXXX")"
  printf 'IMAGE_PREFIX=%s\nIMAGE_TAG=%s\nCOMPOSE_PROJECT_NAME=%s\nCOMPOSE_SERVICE_ENV_FILE=%s\nPRODUCTION_RUNTIME_ENV_SHA256=%s\n' \
    "$COMPOSE_IMAGE_PREFIX" "$SOURCE_SHA" "$COMPOSE_PROJECT_NAME" "$RUNTIME_ENV_CANDIDATE_PATH" "$RUNTIME_ENV_CANDIDATE_SHA256" \
    > "$backup_release_env_tmp"
  chown root:root -- "$backup_release_env_tmp"
  chmod 640 -- "$backup_release_env_tmp"
  if ! mv "$backup_release_env_tmp" "$BACKUP_RELEASE_ENV_PATH"; then
    rm -f "$backup_release_env_tmp"
    fail "Could not stage the candidate backup release pointer."
  fi
  grep -Fxq "COMPOSE_SERVICE_ENV_FILE=$RUNTIME_ENV_CANDIDATE_PATH" "$BACKUP_RELEASE_ENV_PATH" \
    || fail "Candidate backup release pointer does not reference the durable runtime environment."
  grep -Fxq "COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME" "$BACKUP_RELEASE_ENV_PATH" \
    || fail "Candidate backup release pointer does not bind the stable production Compose project."
  grep -Fxq "PRODUCTION_RUNTIME_ENV_SHA256=$RUNTIME_ENV_CANDIDATE_SHA256" "$BACKUP_RELEASE_ENV_PATH" \
    || fail "Candidate backup release pointer does not bind the runtime environment digest."

  echo "backup_release_env_staged path=$BACKUP_RELEASE_ENV_PATH sha=$SOURCE_SHA timers=stopped"
}

commit_release_pointers() {
  local active_pointer_parent
  local active_pointer_tmp
  local deployed_sha_tmp
  local unit
  local expected_enabled
  local expected_active
  local actual_enabled
  local actual_active
  local timer
  local previous_backup_env_path
  local backup_systemd_state_dir

  [[ "$BACKUP_RELEASE_ENV_STAGE_ACTIVE" == "true" ]] || fail "The candidate backup release pointer was not staged and verified."
  [[ "$RUNTIME_ENV_STAGE_ACTIVE" == "true" ]] || fail "The candidate runtime environment was not persisted and verified."
  validate_durable_runtime_env "$RUNTIME_ENV_CANDIDATE_PATH" "$RUNTIME_ENV_CANDIDATE_SHA256"
  grep -Fxq "COMPOSE_SERVICE_ENV_FILE=$RUNTIME_ENV_CANDIDATE_PATH" "$BACKUP_RELEASE_ENV_PATH" \
    || fail "Backup jobs are not bound to the candidate runtime environment."
  grep -Fxq "COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME" "$BACKUP_RELEASE_ENV_PATH" \
    || fail "Backup jobs are not bound to the stable production Compose project."
  grep -Fxq "PRODUCTION_RUNTIME_ENV_SHA256=$RUNTIME_ENV_CANDIDATE_SHA256" "$BACKUP_RELEASE_ENV_PATH" \
    || fail "Backup jobs are not bound to the candidate runtime environment digest."
  [[ "$APP_DIR" == /* && -d "$APP_DIR" && ! -L "$APP_DIR" ]] || fail "APP_DIR must be an absolute, non-symlink release directory."
  [[ "$ACTIVE_RELEASE_POINTER" == /* && "$ACTIVE_RELEASE_POINTER" != "$APP_DIR" ]] \
    || fail "ACTIVE_RELEASE_POINTER must be a distinct absolute path."
  if [[ -e "$ACTIVE_RELEASE_POINTER" && ! -L "$ACTIVE_RELEASE_POINTER" ]]; then
    fail "ACTIVE_RELEASE_POINTER exists but is not a symlink."
  fi

  node scripts/webhook-key-rollback-readiness.mjs record \
    --runtime-env "$RUNTIME_ENV_CANDIDATE_PATH" \
    --state "$WEBHOOK_KEY_READINESS_STATE_PATH" \
    --source-sha "$SOURCE_SHA"

  if [[ -f "$APP_DIR/DEPLOYED_GIT_SHA" && ! -L "$APP_DIR/DEPLOYED_GIT_SHA" \
    && "$(tr -d '\r\n' < "$APP_DIR/DEPLOYED_GIT_SHA")" == "$SOURCE_SHA" ]]; then
    deployed_sha_tmp=""
  else
    deployed_sha_tmp="$(mktemp "$APP_DIR/DEPLOYED_GIT_SHA.tmp.XXXXXX")"
    printf '%s\n' "$SOURCE_SHA" > "$deployed_sha_tmp"
    chown "root:$SERVICE_GROUP_GID" -- "$deployed_sha_tmp"
    chmod 440 "$deployed_sha_tmp"
    if ! mv "$deployed_sha_tmp" "$APP_DIR/DEPLOYED_GIT_SHA"; then
      rm -f "$deployed_sha_tmp"
      fail "Could not commit DEPLOYED_GIT_SHA; the staged release state will be restored."
    fi
  fi
  chown "root:$SERVICE_GROUP_GID" -- "$APP_DIR/DEPLOYED_GIT_SHA"
  chmod 440 -- "$APP_DIR/DEPLOYED_GIT_SHA"
  [[ "$(stat -c '%u:%g:%a' -- "$APP_DIR/DEPLOYED_GIT_SHA")" == "0:$SERVICE_GROUP_GID:440" ]] \
    || fail "Release identity marker is not service-group readable and immutable."

  commit_runtime_env_pointer
  post_pointer_commit_checkpoint runtime
  lock_candidate_release_bytes

  active_pointer_parent="$(dirname "$ACTIVE_RELEASE_POINTER")"
  mkdir -p "$active_pointer_parent"
  active_pointer_tmp="$active_pointer_parent/.current.$SOURCE_SHA.$$"
  rm -f -- "$active_pointer_tmp"
  ln -s -- "$APP_DIR" "$active_pointer_tmp"
  if ! mv -Tf -- "$active_pointer_tmp" "$ACTIVE_RELEASE_POINTER"; then
    rm -f -- "$active_pointer_tmp"
    fail "Could not atomically activate the retained release pointer."
  fi
  [[ "$(readlink -f "$ACTIVE_RELEASE_POINTER")" == "$(readlink -f "$APP_DIR")" ]] \
    || fail "ACTIVE_RELEASE_POINTER did not resolve to the candidate release."
  [[ -f "$ACTIVE_RELEASE_POINTER/DEPLOYED_GIT_SHA" \
    && "$(tr -d '\r\n' < "$ACTIVE_RELEASE_POINTER/DEPLOYED_GIT_SHA")" == "$SOURCE_SHA" ]] \
    || fail "Active release identity marker does not match the promoted source SHA."
  post_pointer_commit_checkpoint release

  finalize_runtime_env
  systemctl enable --now "${BACKUP_TIMERS[@]}" >/dev/null \
    || fail "Could not re-enable committed backup timers."
  for timer in "${BACKUP_TIMERS[@]}"; do
    systemctl is-enabled --quiet "$timer" \
      || fail "Committed backup timer is not enabled: $timer"
    systemctl is-active --quiet "$timer" \
      || fail "Committed backup timer is not active: $timer"
  done
  for unit in "${BACKUP_UNITS[@]}"; do
    [[ -f "$BACKUP_SYSTEMD_UNIT_DIR/$unit" && ! -L "$BACKUP_SYSTEMD_UNIT_DIR/$unit" ]] \
      && cmp -s -- "$APP_DIR/infrastructure/systemd/$unit" "$BACKUP_SYSTEMD_UNIT_DIR/$unit" \
      || fail "Committed backup unit bytes do not match the candidate release: $unit"
    expected_enabled=false
    expected_active=false
    case "$unit" in
      *.timer)
        expected_enabled=true
        expected_active=true
        ;;
    esac
    actual_enabled="$(read_backup_enabled_state "$unit" true)" \
      || fail "Could not independently confirm committed enabled state for $unit."
    actual_active="$(read_backup_active_state "$unit" true)" \
      || fail "Could not independently confirm committed active state for $unit."
    [[ "$actual_enabled" == "$expected_enabled" ]] \
      || fail "Committed enabled state does not match for $unit."
    [[ "$actual_active" == "$expected_active" ]] \
      || fail "Committed active state does not match for $unit."
  done
  previous_backup_env_path="$BACKUP_RELEASE_ENV_PREVIOUS_PATH"
  backup_systemd_state_dir="$BACKUP_SYSTEMD_STATE_DIR"
  remove_confirmed_backup_stage_snapshots \
    || fail "Committed backup state is exact, but deployment snapshot cleanup failed: env=$previous_backup_env_path systemd=$backup_systemd_state_dir"
  echo "backup_release_env_ok path=$BACKUP_RELEASE_ENV_PATH sha=$SOURCE_SHA runtime_env=$RUNTIME_ENV_CANDIDATE_PATH runtime_sha256=$RUNTIME_ENV_CANDIDATE_SHA256 units=exact timers=enabled-active services=disabled-inactive"
  echo "release_pointers_committed active=$ACTIVE_RELEASE_POINTER runtime_active=$ACTIVE_RUNTIME_ENV_POINTER deployed_sha=$APP_DIR/DEPLOYED_GIT_SHA backup_env=$BACKUP_RELEASE_ENV_PATH sha=$SOURCE_SHA"
}

prepare_launch_proof_curl_config() {
  local config_path="$1"
  printf '%s' "$LAUNCH_PROOF_MANIFEST_URI" | python3 -c '
import json
import os
import sys
from urllib.parse import urlsplit, urlunsplit

uri = sys.stdin.read()
if not uri or any(ord(character) < 32 or ord(character) == 127 for character in uri):
    raise SystemExit("launch proof URI must be a nonempty single-line value")
if "\\" in uri or "\"" in uri:
    raise SystemExit("launch proof URI contains characters unsafe for a private curl config")
parts = urlsplit(uri)
if parts.scheme.lower() != "https" or not parts.hostname:
    raise SystemExit("launch proof URI must be an absolute HTTPS URI")
try:
    port = parts.port
except ValueError as error:
    raise SystemExit("launch proof URI has an invalid port") from error
hostname = parts.hostname.lower()
if ":" in hostname:
    hostname = f"[{hostname}]"
authority = hostname if port is None else f"{hostname}:{port}"
identity = urlunsplit(("https", authority, parts.path or "/", "", ""))
with open(sys.argv[1], "w", encoding="utf-8", newline="\n") as handle:
    handle.write(f"url = {json.dumps(uri)}\n")
os.chmod(sys.argv[1], 0o600)
sys.stdout.write(identity)
' "$config_path"
}

json_string() {
  python3 -c 'import json, sys; print(json.dumps(sys.stdin.read()))'
}

write_post_deploy_proof() {
  local api_body
  local api_sha
  local api_bytes
  local proof_body
  local proof_sha
  local proof_bytes
  local proof_path
  local proof_tmp
  local proof_curl_config
  local launch_proof_manifest_identity
  local launch_proof_manifest_identity_json
  local launch_proof_mode="candidate"

  mkdir -p "$POST_DEPLOY_PROOF_DIR"
  api_body="$(mktemp)"
  proof_body="$(mktemp)"
  proof_curl_config="$(mktemp)"
  chmod 600 "$proof_curl_config"
  proof_path="${POST_DEPLOY_PROOF_PATH:-$POST_DEPLOY_PROOF_DIR/deploy-$SOURCE_SHA.json}"
  proof_tmp="$(mktemp "$POST_DEPLOY_PROOF_DIR/deploy-proof.tmp.XXXXXX")"

  require_file "$EXTERNAL_HEALTH_PROOF_PATH" "Post-deploy external health release proof"
  if [[ "$DEPLOY_OPERATION" == "rollback" ]]; then
    launch_proof_mode="rollback"
  fi

  curl --fail --silent --show-error \
    --connect-timeout "$HEALTH_REQUEST_TIMEOUT_SECONDS" \
    --max-time "$HEALTH_REQUEST_TIMEOUT_SECONDS" \
    "$PRODUCTION_API_HEALTH_URL" -o "$api_body"
  if ! launch_proof_manifest_identity="$(prepare_launch_proof_curl_config "$proof_curl_config")"; then
    rm -f "$proof_curl_config"
    fail "LAUNCH_PROOF_MANIFEST_URI is not a safe protected HTTPS artifact URI."
  fi
  if ! curl --fail --silent \
    --config "$proof_curl_config" \
    --connect-timeout "$HEALTH_REQUEST_TIMEOUT_SECONDS" \
    --max-time "$HEALTH_REQUEST_TIMEOUT_SECONDS" \
    -o "$proof_body"; then
    rm -f "$proof_curl_config"
    fail "Could not retrieve launch proof artifact: $launch_proof_manifest_identity"
  fi
  rm -f "$proof_curl_config"

  api_sha="$(sha256_file "$api_body")"
  api_bytes="$(stat -c%s "$api_body")"
  if (( api_bytes <= 0 )); then
    fail "Production API health response is empty: $PRODUCTION_API_HEALTH_URL"
  fi
  proof_sha="$(sha256_file "$proof_body")"
  proof_bytes="$(stat -c%s "$proof_body")"
  if (( proof_bytes <= 0 )); then
    fail "Launch proof artifact is empty: $launch_proof_manifest_identity"
  fi
  python3 scripts/verify-downloaded-launch-proof.py "$proof_body" \
    --source-sha "$SOURCE_SHA" \
    --sha256 "$LAUNCH_PROOF_ARTIFACT_SHA256" \
    --max-age-seconds "$LAUNCH_PROOF_MAX_AGE_SECONDS" \
    --mode "$launch_proof_mode"
  node scripts/verify-release-artifacts.mjs "$RELEASE_MANIFEST_PATH" \
    --source-sha "$SOURCE_SHA" \
    --launch-proof-file "$proof_body" \
    --launch-proof-mode "$launch_proof_mode"

  launch_proof_manifest_identity_json="$(printf '%s' "$launch_proof_manifest_identity" | json_string)"
  cat > "$proof_tmp" <<JSON
{
  "status": "passed",
  "sourceSha": "$SOURCE_SHA",
  "checkedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "apiHealthUrl": "$PRODUCTION_API_HEALTH_URL",
  "apiHealthSha256": "$api_sha",
  "apiHealthBytes": $api_bytes,
  "externalHealth": $(cat "$EXTERNAL_HEALTH_PROOF_PATH"),
  "publicWebUrl": "$PRODUCTION_WEB_URL",
  "releaseManifestSha256": "$(sha256_file "$RELEASE_MANIFEST_PATH")",
  "launchProofManifestUri": $launch_proof_manifest_identity_json,
  "launchProofManifestUriRedacted": true,
  "launchProofArtifactSha256": "$proof_sha",
  "launchProofArtifactBytes": $proof_bytes
}
JSON
  chmod 640 "$proof_tmp"
  mv "$proof_tmp" "$proof_path"

  rm -f "$api_body" "$proof_body" "$EXTERNAL_HEALTH_PROOF_PATH"
  EXTERNAL_HEALTH_PROOF_PATH=""
  echo "post_deploy_proof_ok path=$proof_path sha=$SOURCE_SHA proof_sha256=$proof_sha proof_bytes=$proof_bytes"
}

run_production_release_deploy() {
  require_full_sha "$SOURCE_SHA" "RELEASE_SOURCE_SHA"
  require_file "$COMPOSE_SERVICE_ENV_FILE" "COMPOSE_SERVICE_ENV_FILE"
  require_file "$RELEASE_MANIFEST_PATH" "RELEASE_MANIFEST_PATH"

  if [[ -z "${PRODUCTION_RUNTIME_ENV_SHA256:-}" ]]; then
    fail "PRODUCTION_RUNTIME_ENV_SHA256 is required for production deploys."
  fi
  PRODUCTION_RUNTIME_ENV_SHA256="${PRODUCTION_RUNTIME_ENV_SHA256,,}"
  require_sha256 "$PRODUCTION_RUNTIME_ENV_SHA256" "PRODUCTION_RUNTIME_ENV_SHA256"

  local actual_runtime_env_sha
  actual_runtime_env_sha="$(sha256_file "$COMPOSE_SERVICE_ENV_FILE")"
  if [[ "$actual_runtime_env_sha" != "$PRODUCTION_RUNTIME_ENV_SHA256" ]]; then
    fail "PRODUCTION_RUNTIME_ENV_SHA256 does not match COMPOSE_SERVICE_ENV_FILE."
  fi

  if [[ -z "$PRODUCTION_API_HEALTH_URL" ]]; then
    fail "PRODUCTION_API_HEALTH_URL is required for production post-deploy proof."
  fi
  if [[ -z "$PRODUCTION_WEB_URL" ]]; then
    fail "PRODUCTION_WEB_URL is required to verify the public Next.js root page before production success."
  fi
  validate_production_web_url
  if [[ -z "$LAUNCH_PROOF_MANIFEST_URI" ]]; then
    fail "LAUNCH_PROOF_MANIFEST_URI is required for production post-deploy proof."
  fi
  if [[ "$LAUNCH_PROOF_MANIFEST_URI" != https://* ]]; then
    fail "LAUNCH_PROOF_MANIFEST_URI must be a retained HTTPS artifact URI for VM217 production proof."
  fi
  require_sha256 "$LAUNCH_PROOF_ARTIFACT_SHA256" "LAUNCH_PROOF_ARTIFACT_SHA256"
  if [[ ! "$LAUNCH_PROOF_MAX_AGE_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
    fail "LAUNCH_PROOF_MAX_AGE_SECONDS must be a positive integer."
  fi
  if [[ ! "$DEPLOY_ALERT_BOOT_GRACE_SECONDS" =~ ^[0-9]+$ ]] || (( DEPLOY_ALERT_BOOT_GRACE_SECONDS > 300 )); then
    fail "DEPLOY_ALERT_BOOT_GRACE_SECONDS must be an integer from 0 through 300."
  fi
  if [[ ! "$DEPLOY_ALERT_STABILITY_SECONDS" =~ ^[0-9]+$ ]] \
    || (( DEPLOY_ALERT_STABILITY_SECONDS < 60 || DEPLOY_ALERT_STABILITY_SECONDS > 900 )); then
    fail "DEPLOY_ALERT_STABILITY_SECONDS must be an integer from 60 through 900."
  fi
  if [[ ! "$DEPLOY_ALERT_POLL_SECONDS" =~ ^[1-9][0-9]*$ ]] || (( DEPLOY_ALERT_POLL_SECONDS > 30 )); then
    fail "DEPLOY_ALERT_POLL_SECONDS must be an integer from 1 through 30."
  fi
  if [[ ! "$DEPLOY_ALERT_REQUEST_TIMEOUT_MS" =~ ^[0-9]+$ ]] \
    || (( DEPLOY_ALERT_REQUEST_TIMEOUT_MS < 1000 || DEPLOY_ALERT_REQUEST_TIMEOUT_MS > 15000 )); then
    fail "DEPLOY_ALERT_REQUEST_TIMEOUT_MS must be an integer from 1000 through 15000."
  fi
  if [[ ! "$DEPLOY_ALERT_MAX_RESPONSE_AGE_MS" =~ ^[0-9]+$ ]] \
    || (( DEPLOY_ALERT_MAX_RESPONSE_AGE_MS < 1000 || DEPLOY_ALERT_MAX_RESPONSE_AGE_MS > 300000 )); then
    fail "DEPLOY_ALERT_MAX_RESPONSE_AGE_MS must be an integer from 1000 through 300000."
  fi
  [[ "$DEPLOY_ALERT_SCOPE_PREFIX" == "lunchlineup." ]] || fail "DEPLOY_ALERT_SCOPE_PREFIX must remain lunchlineup."

  resolve_service_group
  validate_candidate_release_path
  preflight_expected_current_release
  validate_production_compose_scope
  persist_candidate_runtime_env
  node scripts/validate-production-launch.mjs "$COMPOSE_SERVICE_ENV_FILE" --verify-local-secret-files
  preflight_webhook_rollback_keys
  quarantine_worktree_git_pointer
  pull_release_images
  configure_migration_mode
  preflight_rollback_raw_migrations
  preflight_rollback_schema_compatibility

  echo "Deploying VM217 production release: sha=$SOURCE_SHA operation=$DEPLOY_OPERATION migration_mode=$DEPLOY_MIGRATION_MODE manifest=$RELEASE_MANIFEST_PATH"
  APP_DIR="$APP_DIR" \
    COMPOSE_SERVICE_ENV_FILE="$COMPOSE_SERVICE_ENV_FILE" \
    COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" \
    COMPOSE_PROJECT_DIRECTORY="$COMPOSE_PROJECT_DIRECTORY" \
    COMPOSE_FILE="$COMPOSE_FILE" \
    IMAGE_PREFIX="$COMPOSE_IMAGE_PREFIX" \
    IMAGE_TAG="$SOURCE_SHA" \
    bash scripts/pitr-verify-storage.sh
  compose_release up -d --no-build --pull never pdf-parser
  compose_release up -d --no-build --pull never
  if ! wait_for_release_health "$PRODUCTION_API_HEALTH_URL" "$SOURCE_SHA" || \
    ! wait_for_health "${HEALTH_URL:-$PRODUCTION_API_HEALTH_URL}" || \
    ! wait_for_web_surface "$PRODUCTION_WEB_URL" "Public Next.js web surface" "$SOURCE_SHA" || \
    ! wait_for_required_services; then
    compose_release ps
    compose_release logs --tail=100 proxy web api pdf-parser worker || true
    fail "Production post-deploy verification failed; the CI failure path must run the configured verified rollback command."
  fi
  if ! verify_deploy_alerts; then
    compose_release logs --tail=100 prometheus alertmanager grafana || true
    fail "Production deploy refused release promotion because critical alert verification failed closed."
  fi
  compose_release ps

  write_post_deploy_proof
  stage_backup_release_pointer
  APP_DIR="$APP_DIR" \
    COMPOSE_SERVICE_ENV_FILE="$COMPOSE_SERVICE_ENV_FILE" \
    COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" \
    COMPOSE_PROJECT_DIRECTORY="$COMPOSE_PROJECT_DIRECTORY" \
    COMPOSE_FILE="$COMPOSE_FILE" \
    IMAGE_PREFIX="$COMPOSE_IMAGE_PREFIX" \
    IMAGE_TAG="$SOURCE_SHA" \
    BACKUP_SYSTEMD_UNIT_DIR="$BACKUP_SYSTEMD_UNIT_DIR" \
    BACKUP_RESTORE_STATE_ROOT="$BACKUP_SYSTEMD_STATE_DIR" \
    bash scripts/verify-backup-readiness.sh
  commit_release_pointers
  echo "deploy_remote_ok scope=production sha=$SOURCE_SHA app_dir=$APP_DIR manifest=$RELEASE_MANIFEST_PATH"
}

run_development_source_deploy() {
  require_full_sha "${DEPLOY_SOURCE_SHA:-}" "DEPLOY_SOURCE_SHA"
  bootstrap_runtime_env
  quarantine_worktree_git_pointer

  local services=(
    proxy web api engine pdf-parser worker
    migrate pgbouncer postgres redis rabbitmq
    prometheus loki promtail otel-collector tempo grafana autoheal
  )

  echo "Deploying VM217 development source build: ${services[*]}"
  docker compose --env-file "$SECRET_ENV_PATH" up -d --build "${services[@]}"
  wait_for_health "${HEALTH_URL:-http://127.0.0.1/api/health}"
  wait_for_web_surface "${WEB_URL:-http://127.0.0.1/}" "Development Next.js web surface"
  docker compose --env-file "$SECRET_ENV_PATH" ps
  printf "%s\n" "$DEPLOY_SOURCE_SHA" > DEPLOYED_GIT_SHA
  echo "deploy_remote_ok scope=development sha=$DEPLOY_SOURCE_SHA app_dir=$APP_DIR"
}

if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

validate_health_deadlines
trap cleanup_staged_release_state EXIT

case "$DEPLOY_SCOPE" in
  production)
    ;;
  development)
    echo "VM217 development source deploy explicitly requested; this path is refused for production."
    ;;
  *)
    fail "Unsupported VM217_DEPLOY_SCOPE '$DEPLOY_SCOPE'. Use production or development."
    ;;
esac

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  fail "Another deploy is already running (lock: $LOCK_FILE)"
fi

cd "$APP_DIR"

if [[ "$DEPLOY_SCOPE" == "development" ]]; then
  run_development_source_deploy
else
  run_production_release_deploy
fi
