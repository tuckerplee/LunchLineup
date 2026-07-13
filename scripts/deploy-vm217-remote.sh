#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/lunchlineup}"
LOCK_FILE="${LOCK_FILE:-/tmp/lunchlineup-deploy.lock}"
HEALTH_URL="${HEALTH_URL:-}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-180}"
SECRETS_DIR="${SECRETS_DIR:-/opt/lunchlineup-secrets}"
SECRET_ENV_PATH="${SECRET_ENV_PATH:-$SECRETS_DIR/runtime.env}"
DEPLOY_SCOPE="${VM217_DEPLOY_SCOPE:-production}"
SOURCE_SHA="${RELEASE_SOURCE_SHA:-${DEPLOY_SOURCE_SHA:-}}"
RELEASE_MANIFEST_PATH="${RELEASE_MANIFEST_PATH:-$APP_DIR/.release/release-manifest.json}"
COMPOSE_SERVICE_ENV_FILE="${COMPOSE_SERVICE_ENV_FILE:-$SECRET_ENV_PATH}"
COMPOSE_IMAGE_PREFIX="${COMPOSE_IMAGE_PREFIX:-lunchlineup-release}"
POST_DEPLOY_PROOF_DIR="${POST_DEPLOY_PROOF_DIR:-/var/lib/lunchlineup/proofs}"
BACKUP_RELEASE_ENV_PATH="${BACKUP_RELEASE_ENV_PATH:-/var/lib/lunchlineup/backup-release.env}"
PRODUCTION_API_HEALTH_URL="${PRODUCTION_API_HEALTH_URL:-}"
PRODUCTION_WEB_URL="${PRODUCTION_WEB_URL:-}"
WEB_URL="${WEB_URL:-}"
LAUNCH_PROOF_MANIFEST_URI="${LAUNCH_PROOF_MANIFEST_URI:-}"
LAUNCH_PROOF_ARTIFACT_SHA256="${LAUNCH_PROOF_ARTIFACT_SHA256:-}"
LAUNCH_PROOF_MAX_AGE_SECONDS="${LAUNCH_PROOF_MAX_AGE_SECONDS:-86400}"
DEPLOY_OPERATION="${VM217_DEPLOY_OPERATION:-deploy}"
DEPLOY_MIGRATION_MODE="${DEPLOY_MIGRATION_MODE:-}"
ROLLBACK_SCHEMA_COMPATIBILITY_CONFIRM="${ROLLBACK_SCHEMA_COMPATIBILITY_CONFIRM:-}"
ROLLBACK_CANDIDATE_DEPLOYMENT_ROOT="${ROLLBACK_CANDIDATE_DEPLOYMENT_ROOT:-/opt/lunchlineup}"
ROLLBACK_CANDIDATE_RELEASE_MANIFEST_PATH="${ROLLBACK_CANDIDATE_RELEASE_MANIFEST_PATH:-$ROLLBACK_CANDIDATE_DEPLOYMENT_ROOT/.release/release-manifest.json}"
EXTERNAL_HEALTH_PROOF_PATH=""
BACKUP_RELEASE_ENV_STAGE_ACTIVE=false
BACKUP_RELEASE_ENV_PREVIOUS_PATH=""
BACKUP_RELEASE_ENV_PREVIOUS_EXISTED=false
BACKUP_TIMER_STATE_PATH=""
BACKUP_TIMERS=(lunchlineup-backup.timer lunchlineup-pitr-base-backup.timer)

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

sha256_file() {
  sha256sum "$1" | awk '{print $1}'
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

wait_for_health() {
  local url="$1"
  local start_time
  start_time=$(date +%s)

  while true; do
    local code
    code=$(curl -s -o /dev/null -w "%{http_code}" "$url" || true)
    if [[ "$code" == "200" ]]; then
      echo "Health check passed: $url"
      break
    fi

    local now
    now=$(date +%s)
    if (( now - start_time > HEALTH_TIMEOUT_SECONDS )); then
      echo "Health check timed out after ${HEALTH_TIMEOUT_SECONDS}s (last code: $code)" >&2
      docker compose ps
      return 1
    fi

    sleep 5
  done
}

wait_for_release_health() {
  local url="$1"
  local expected_release="$2"
  local start_time
  local error_path
  EXTERNAL_HEALTH_PROOF_PATH="$(mktemp)"
  error_path="$(mktemp)"
  start_time=$(date +%s)

  while true; do
    if node scripts/verify-external-health-release.mjs "$url" "$expected_release" --output "$EXTERNAL_HEALTH_PROOF_PATH" > /dev/null 2> "$error_path"; then
      rm -f "$error_path"
      echo "External health release identity passed: $url serves $expected_release"
      return
    fi

    local now
    now=$(date +%s)
    if (( now - start_time > HEALTH_TIMEOUT_SECONDS )); then
      echo "External health release identity timed out after ${HEALTH_TIMEOUT_SECONDS}s: $(cat "$error_path")" >&2
      rm -f "$error_path" "$EXTERNAL_HEALTH_PROOF_PATH"
      EXTERNAL_HEALTH_PROOF_PATH=""
BACKUP_RELEASE_ENV_STAGE_ACTIVE=false
BACKUP_RELEASE_ENV_PREVIOUS_PATH=""
BACKUP_RELEASE_ENV_PREVIOUS_EXISTED=false
BACKUP_TIMER_STATE_PATH=""
BACKUP_TIMERS=(lunchlineup-backup.timer lunchlineup-pitr-base-backup.timer)
      return 1
    fi
    sleep 5
  done
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
  local start_time
  local reason="not checked"

  body="$(mktemp)"
  headers="$(mktemp)"
  probe_url="${url%/}/?lunchlineup_deploy_probe=${SOURCE_SHA:-development}"
  start_time=$(date +%s)

  while true; do
    local code
    local content_type
    local response_bytes
    local served_release

    : > "$body"
    : > "$headers"
    code=$(curl --silent --show-error \
      --connect-timeout 10 \
      --max-time 30 \
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

    local now
    now=$(date +%s)
    if (( now - start_time > HEALTH_TIMEOUT_SECONDS )); then
      rm -f "$body" "$headers"
      echo "$label check timed out after ${HEALTH_TIMEOUT_SECONDS}s: $url ($reason)" >&2
      return 1
    fi

    sleep 5
  done
}

wait_for_required_services() {
  local services=(worker engine webhook-replay prometheus alertmanager loki promtail otel-collector tempo grafana)
  local start_time
  start_time=$(date +%s)

  while true; do
    local pending=()
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

    local now
    now=$(date +%s)
    if (( now - start_time > HEALTH_TIMEOUT_SECONDS )); then
      echo "Required service health timed out after ${HEALTH_TIMEOUT_SECONDS}s: ${pending[*]}" >&2
      compose_release ps
      compose_release logs --tail=100 "${services[@]}" || true
      return 1
    fi

    sleep 5
  done
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
required_services = ["api", "web", "engine", "worker", "migrate", "control", "backup"]

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
  IMAGE_PREFIX="$COMPOSE_IMAGE_PREFIX" IMAGE_TAG="$SOURCE_SHA" docker compose --env-file "$COMPOSE_SERVICE_ENV_FILE" "$@"
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

  export DEPLOY_MIGRATION_MODE
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
  node "$ROLLBACK_CANDIDATE_DEPLOYMENT_ROOT/scripts/verify-raw-migration-rollback.mjs" \
    --rollback-manifest "$RELEASE_MANIFEST_PATH" \
    --candidate-manifest "$ROLLBACK_CANDIDATE_RELEASE_MANIFEST_PATH" \
    --candidate-root "$ROLLBACK_CANDIDATE_DEPLOYMENT_ROOT" \
    --policy "$ROLLBACK_CANDIDATE_DEPLOYMENT_ROOT/scripts/raw-migration-rollback-policy.json"
}

restore_staged_backup_release_pointer() {
  local timer
  local was_enabled
  local was_active

  [[ "$BACKUP_RELEASE_ENV_STAGE_ACTIVE" == "true" ]] || return 0

  if [[ "$BACKUP_RELEASE_ENV_PREVIOUS_EXISTED" == "true" ]]; then
    if ! mv "$BACKUP_RELEASE_ENV_PREVIOUS_PATH" "$BACKUP_RELEASE_ENV_PATH"; then
      echo "Could not restore the previous backup release pointer: $BACKUP_RELEASE_ENV_PREVIOUS_PATH" >&2
      return 1
    fi
  else
    rm -f "$BACKUP_RELEASE_ENV_PATH"
  fi

  if [[ -f "$BACKUP_TIMER_STATE_PATH" ]]; then
    while IFS='|' read -r timer was_enabled was_active; do
      [[ -n "$timer" ]] || continue
      if [[ "$was_enabled" == "true" ]]; then
        systemctl enable "$timer" >/dev/null 2>&1 || true
      else
        systemctl disable "$timer" >/dev/null 2>&1 || true
      fi
      if [[ "$was_active" == "true" ]]; then
        systemctl start "$timer" >/dev/null 2>&1 || true
      else
        systemctl stop "$timer" >/dev/null 2>&1 || true
      fi
    done < "$BACKUP_TIMER_STATE_PATH"
  fi

  rm -f "$BACKUP_RELEASE_ENV_PREVIOUS_PATH" "$BACKUP_TIMER_STATE_PATH"
  BACKUP_RELEASE_ENV_STAGE_ACTIVE=false
  BACKUP_RELEASE_ENV_PREVIOUS_PATH=""
  BACKUP_RELEASE_ENV_PREVIOUS_EXISTED=false
  BACKUP_TIMER_STATE_PATH=""
  echo "backup_release_env_restored path=$BACKUP_RELEASE_ENV_PATH"
}

cleanup_staged_backup_release_pointer() {
  local exit_code=$?
  if [[ "$BACKUP_RELEASE_ENV_STAGE_ACTIVE" == "true" ]]; then
    restore_staged_backup_release_pointer || true
  fi
  return "$exit_code"
}

stage_backup_release_pointer() {
  local backup_release_env_dir
  local backup_release_env_tmp
  local timer
  local was_enabled
  local was_active

  [[ "$BACKUP_RELEASE_ENV_STAGE_ACTIVE" == "false" ]] || fail "A backup release pointer is already staged."

  backup_release_env_dir="$(dirname "$BACKUP_RELEASE_ENV_PATH")"
  mkdir -p "$backup_release_env_dir"
  BACKUP_RELEASE_ENV_PREVIOUS_PATH="$(mktemp "$backup_release_env_dir/backup-release.env.previous.XXXXXX")"
  BACKUP_TIMER_STATE_PATH="$(mktemp "$backup_release_env_dir/backup-timer-state.XXXXXX")"

  if [[ -f "$BACKUP_RELEASE_ENV_PATH" ]]; then
    cp -p "$BACKUP_RELEASE_ENV_PATH" "$BACKUP_RELEASE_ENV_PREVIOUS_PATH"
    BACKUP_RELEASE_ENV_PREVIOUS_EXISTED=true
  else
    BACKUP_RELEASE_ENV_PREVIOUS_EXISTED=false
  fi

  for timer in "${BACKUP_TIMERS[@]}"; do
    was_enabled=false
    was_active=false
    systemctl is-enabled --quiet "$timer" >/dev/null 2>&1 && was_enabled=true
    systemctl is-active --quiet "$timer" >/dev/null 2>&1 && was_active=true
    printf '%s|%s|%s\n' "$timer" "$was_enabled" "$was_active" >> "$BACKUP_TIMER_STATE_PATH"
  done

  BACKUP_RELEASE_ENV_STAGE_ACTIVE=true
  systemctl disable --now "${BACKUP_TIMERS[@]}" >/dev/null 2>&1 || true

  backup_release_env_tmp="$(mktemp "$backup_release_env_dir/backup-release.env.tmp.XXXXXX")"
  chmod 640 "$backup_release_env_tmp"
  printf 'IMAGE_PREFIX=%s\nIMAGE_TAG=%s\n' "$COMPOSE_IMAGE_PREFIX" "$SOURCE_SHA" > "$backup_release_env_tmp"
  if ! mv "$backup_release_env_tmp" "$BACKUP_RELEASE_ENV_PATH"; then
    rm -f "$backup_release_env_tmp"
    fail "Could not stage the candidate backup release pointer."
  fi

  echo "backup_release_env_staged path=$BACKUP_RELEASE_ENV_PATH sha=$SOURCE_SHA timers=stopped"
}

commit_release_pointers() {
  local deployed_sha_tmp

  [[ "$BACKUP_RELEASE_ENV_STAGE_ACTIVE" == "true" ]] || fail "The candidate backup release pointer was not staged and verified."

  deployed_sha_tmp="$(mktemp "$APP_DIR/DEPLOYED_GIT_SHA.tmp.XXXXXX")"
  chmod 640 "$deployed_sha_tmp"
  printf '%s\n' "$SOURCE_SHA" > "$deployed_sha_tmp"

  if ! mv "$deployed_sha_tmp" "$APP_DIR/DEPLOYED_GIT_SHA"; then
    rm -f "$deployed_sha_tmp"
    fail "Could not commit DEPLOYED_GIT_SHA; the staged backup release pointer will be restored."
  fi

  BACKUP_RELEASE_ENV_STAGE_ACTIVE=false
  rm -f "$BACKUP_RELEASE_ENV_PREVIOUS_PATH" "$BACKUP_TIMER_STATE_PATH"
  BACKUP_RELEASE_ENV_PREVIOUS_PATH=""
  BACKUP_RELEASE_ENV_PREVIOUS_EXISTED=false
  BACKUP_TIMER_STATE_PATH=""
  echo "backup_release_env_ok path=$BACKUP_RELEASE_ENV_PATH sha=$SOURCE_SHA"
  echo "release_pointers_committed deployed_sha=$APP_DIR/DEPLOYED_GIT_SHA backup_env=$BACKUP_RELEASE_ENV_PATH sha=$SOURCE_SHA"
}

trap cleanup_staged_backup_release_pointer EXIT

write_post_deploy_proof() {
  local api_body
  local api_sha
  local api_bytes
  local proof_body
  local proof_sha
  local proof_bytes
  local proof_path
  local proof_tmp
  local launch_proof_mode="candidate"

  mkdir -p "$POST_DEPLOY_PROOF_DIR"
  api_body="$(mktemp)"
  proof_body="$(mktemp)"
  proof_path="${POST_DEPLOY_PROOF_PATH:-$POST_DEPLOY_PROOF_DIR/deploy-$SOURCE_SHA.json}"
  proof_tmp="$(mktemp "$POST_DEPLOY_PROOF_DIR/deploy-proof.tmp.XXXXXX")"

  require_file "$EXTERNAL_HEALTH_PROOF_PATH" "Post-deploy external health release proof"
  if [[ "$DEPLOY_OPERATION" == "rollback" ]]; then
    launch_proof_mode="rollback"
  fi

  curl -fsS "$PRODUCTION_API_HEALTH_URL" -o "$api_body"
  curl -fsS "$LAUNCH_PROOF_MANIFEST_URI" -o "$proof_body"

  api_sha="$(sha256_file "$api_body")"
  api_bytes="$(stat -c%s "$api_body")"
  if (( api_bytes <= 0 )); then
    fail "Production API health response is empty: $PRODUCTION_API_HEALTH_URL"
  fi
  proof_sha="$(sha256_file "$proof_body")"
  proof_bytes="$(stat -c%s "$proof_body")"
  if (( proof_bytes <= 0 )); then
    fail "Launch proof artifact is empty: $LAUNCH_PROOF_MANIFEST_URI"
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
  "launchProofManifestUri": "$LAUNCH_PROOF_MANIFEST_URI",
  "launchProofArtifactSha256": "$proof_sha",
  "launchProofArtifactBytes": $proof_bytes
}
JSON
  chmod 640 "$proof_tmp"
  mv "$proof_tmp" "$proof_path"

  rm -f "$api_body" "$proof_body" "$EXTERNAL_HEALTH_PROOF_PATH"
  EXTERNAL_HEALTH_PROOF_PATH=""
BACKUP_RELEASE_ENV_STAGE_ACTIVE=false
BACKUP_RELEASE_ENV_PREVIOUS_PATH=""
BACKUP_RELEASE_ENV_PREVIOUS_EXISTED=false
BACKUP_TIMER_STATE_PATH=""
BACKUP_TIMERS=(lunchlineup-backup.timer lunchlineup-pitr-base-backup.timer)
  echo "post_deploy_proof_ok path=$proof_path sha=$SOURCE_SHA proof_sha256=$proof_sha proof_bytes=$proof_bytes"
}

run_production_release_deploy() {
  require_full_sha "$SOURCE_SHA" "RELEASE_SOURCE_SHA"
  require_file "$COMPOSE_SERVICE_ENV_FILE" "COMPOSE_SERVICE_ENV_FILE"
  require_file "$RELEASE_MANIFEST_PATH" "RELEASE_MANIFEST_PATH"

  if [[ -z "${PRODUCTION_RUNTIME_ENV_SHA256:-}" ]]; then
    fail "PRODUCTION_RUNTIME_ENV_SHA256 is required for production deploys."
  fi

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

  bootstrap_runtime_env
  node scripts/validate-production-launch.mjs "$COMPOSE_SERVICE_ENV_FILE" --verify-local-secret-files
  quarantine_worktree_git_pointer
  pull_release_images
  configure_migration_mode
  preflight_rollback_raw_migrations
  preflight_rollback_schema_compatibility

  echo "Deploying VM217 production release: sha=$SOURCE_SHA operation=$DEPLOY_OPERATION migration_mode=$DEPLOY_MIGRATION_MODE manifest=$RELEASE_MANIFEST_PATH"
  compose_release pull pitr-tools
  APP_DIR="$APP_DIR" \
    COMPOSE_SERVICE_ENV_FILE="$COMPOSE_SERVICE_ENV_FILE" \
    IMAGE_PREFIX="$COMPOSE_IMAGE_PREFIX" \
    IMAGE_TAG="$SOURCE_SHA" \
    bash scripts/pitr-verify-storage.sh
  compose_release up -d --no-build --pull never
  if ! wait_for_release_health "$PRODUCTION_API_HEALTH_URL" "$SOURCE_SHA" || \
    ! wait_for_health "${HEALTH_URL:-$PRODUCTION_API_HEALTH_URL}" || \
    ! wait_for_web_surface "$PRODUCTION_WEB_URL" "Public Next.js web surface" "$SOURCE_SHA" || \
    ! wait_for_required_services; then
    compose_release ps
    compose_release logs --tail=100 proxy web api || true
    fail "Production post-deploy verification failed; the CI failure path must run the configured verified rollback command."
  fi
  compose_release ps

  write_post_deploy_proof
  stage_backup_release_pointer
  APP_DIR="$APP_DIR" \
    COMPOSE_SERVICE_ENV_FILE="$COMPOSE_SERVICE_ENV_FILE" \
    IMAGE_PREFIX="$COMPOSE_IMAGE_PREFIX" \
    IMAGE_TAG="$SOURCE_SHA" \
    bash scripts/verify-backup-readiness.sh
  commit_release_pointers
  echo "deploy_remote_ok scope=production sha=$SOURCE_SHA app_dir=$APP_DIR manifest=$RELEASE_MANIFEST_PATH"
}

run_development_source_deploy() {
  require_full_sha "${DEPLOY_SOURCE_SHA:-}" "DEPLOY_SOURCE_SHA"
  bootstrap_runtime_env
  quarantine_worktree_git_pointer

  local services=(
    proxy web api engine worker
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
