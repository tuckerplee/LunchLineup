#!/usr/bin/env bash
# Idempotent VM107 internal-beta launch, verification, and resource-saving pause.
# This script owns application services only; Proxmox VM power and onboot policy
# remain explicit host-operator actions.
set -euo pipefail

ACTION="${1:-verify}"
APP_DIR="${APP_DIR:-/opt/lunchlineup}"
RUNTIME_ENV="${BETA_RUNTIME_ENV_FILE:-/opt/lunchlineup-secrets/runtime.env}"
SOURCE_SHA="${BETA_CANDIDATE_SHA:-}"
CANDIDATE_REF="${BETA_CANDIDATE_REF:-origin/main}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-lunchlineup}"
EXPECTED_HOSTNAME="${BETA_EXPECTED_HOSTNAME:-lunchlineup-dev}"
BETA_HOST="${BETA_HOST:-beta.lunchlineup.com}"
PUBLIC_ORIGIN="${BETA_PUBLIC_ORIGIN:-https://beta.lunchlineup.com}"
BUILD_IMAGES="${BETA_BUILD_IMAGES:-false}"
RUN_BACKUP_RESTORE_PROOF="${BETA_RUN_BACKUP_RESTORE_PROOF:-true}"
START_TIMEOUT_SECONDS="${BETA_START_TIMEOUT_SECONDS:-600}"
COMMAND_TIMEOUT_SECONDS="${BETA_COMMAND_TIMEOUT_SECONDS:-600}"
REQUEST_TIMEOUT_SECONDS="${BETA_REQUEST_TIMEOUT_SECONDS:-15}"
MONITORING_TIMEOUT_SECONDS="${BETA_MONITORING_TIMEOUT_SECONDS:-120}"
STOP_TIMEOUT_SECONDS="${BETA_STOP_TIMEOUT_SECONDS:-45}"
BACKUP_PROOF_MAX_AGE_SECONDS="${BETA_BACKUP_PROOF_MAX_AGE_SECONDS:-3600}"
BACKUP_PROOF_PATH="${BETA_BACKUP_RESTORE_PROOF_PATH:-/var/lib/lunchlineup/proofs/internal-beta-backup-restore.json}"
READINESS_PROOF_PATH="${BETA_READINESS_PROOF_PATH:-/var/lib/lunchlineup/proofs/internal-beta-readiness.json}"

required_services=(
  proxy web api webhook-replay engine pdf-parser worker pgbouncer pitr-wal-provider api-v2
  postgres redis rabbitmq control prometheus alertmanager node-exporter loki
  promtail otel-collector tempo grafana autoheal
)
candidate_image_services=(web api webhook-replay engine pdf-parser worker pitr-wal-provider api-v2 control)
build_services=(web api api-v2 migrate engine worker pitr-wal-provider control)

current_check="startup"
scratch_dir=""
completed=false

on_exit() {
  local status=$?
  if [[ -n "$scratch_dir" && -d "$scratch_dir" ]]; then
    rm -rf -- "$scratch_dir" || status=1
  fi
  if (( status != 0 )) && [[ "$completed" != true ]]; then
    echo "internal_beta_readiness_failed action=$ACTION check=$current_check" >&2
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  echo "internal_beta_readiness_failed action=$ACTION check=$current_check detail=$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

require_bounded_integer() {
  local name="$1"
  local value="$2"
  local minimum="$3"
  local maximum="$4"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || fail "$name must be a positive integer"
  (( value >= minimum && value <= maximum )) \
    || fail "$name must be from $minimum through $maximum"
}

require_boolean() {
  local name="$1"
  local value="$2"
  [[ "$value" == true || "$value" == false ]] || fail "$name must be true or false"
}

require_beta_proof_path() {
  local name="$1"
  local value="$2"
  local basename_value="${value#/var/lib/lunchlineup/proofs/}"
  [[ "$value" == /var/lib/lunchlineup/proofs/*.json \
    && "$basename_value" != */* \
    && "$basename_value" =~ ^[A-Za-z0-9._-]+\.json$ ]] \
    || fail "$name must be one JSON file directly under /var/lib/lunchlineup/proofs"
}

env_value() {
  local key="$1"
  local count
  count="$(grep -c "^${key}=" "$RUNTIME_ENV" || true)"
  [[ "$count" == 1 ]] || fail "$key must occur exactly once in the runtime env"
  grep "^${key}=" "$RUNTIME_ENV" | cut -d= -f2-
}

env_path() {
  local value
  value="$(env_value "$1")"
  if [[ "$value" == /* ]]; then
    printf '%s\n' "$value"
  else
    printf '%s/%s\n' "$APP_DIR" "${value#./}"
  fi
}

compose() {
  timeout --foreground "${COMMAND_TIMEOUT_SECONDS}s" \
    docker compose \
      --project-name "$COMPOSE_PROJECT_NAME" \
      --project-directory "$APP_DIR" \
      --env-file "$RUNTIME_ENV" \
      -f "$APP_DIR/docker-compose.yml" \
      "$@"
}

container_value() {
  local container_id="$1"
  local format="$2"
  timeout --foreground 30s docker inspect --format "$format" "$container_id"
}

validate_inputs() {
  current_check="inputs"
  case "$ACTION" in
    launch|verify|pause) ;;
    *) fail "action must be launch, verify, or pause" ;;
  esac
  [[ "$SOURCE_SHA" =~ ^[a-f0-9]{40}$ ]] \
    || fail "BETA_CANDIDATE_SHA must be one lowercase 40-character Git SHA"
  [[ "$COMPOSE_PROJECT_NAME" == lunchlineup ]] || fail "COMPOSE_PROJECT_NAME must remain lunchlineup"
  [[ "$APP_DIR" == /opt/lunchlineup ]] || fail "APP_DIR must remain /opt/lunchlineup on VM107"
  [[ "$RUNTIME_ENV" == /opt/lunchlineup-secrets/runtime.env ]] \
    || fail "BETA_RUNTIME_ENV_FILE must remain the VM107 root-only runtime env"
  [[ "$EXPECTED_HOSTNAME" == lunchlineup-dev ]] \
    || fail "BETA_EXPECTED_HOSTNAME must remain lunchlineup-dev"
  [[ "$BETA_HOST" == beta.lunchlineup.com ]] || fail "BETA_HOST must remain beta.lunchlineup.com"
  [[ "$PUBLIC_ORIGIN" == https://beta.lunchlineup.com ]] \
    || fail "BETA_PUBLIC_ORIGIN must remain https://beta.lunchlineup.com"
  [[ -d "$APP_DIR/.git" ]] || fail "APP_DIR is not the VM107 Git checkout"
  if [[ "$ACTION" != pause ]]; then
    [[ -f "$RUNTIME_ENV" && ! -L "$RUNTIME_ENV" ]] \
      || fail "runtime env must be a regular non-symlink file"
  fi
  require_boolean BETA_BUILD_IMAGES "$BUILD_IMAGES"
  require_boolean BETA_RUN_BACKUP_RESTORE_PROOF "$RUN_BACKUP_RESTORE_PROOF"
  require_bounded_integer BETA_START_TIMEOUT_SECONDS "$START_TIMEOUT_SECONDS" 60 1800
  require_bounded_integer BETA_COMMAND_TIMEOUT_SECONDS "$COMMAND_TIMEOUT_SECONDS" 10 1800
  require_bounded_integer BETA_REQUEST_TIMEOUT_SECONDS "$REQUEST_TIMEOUT_SECONDS" 2 60
  require_bounded_integer BETA_MONITORING_TIMEOUT_SECONDS "$MONITORING_TIMEOUT_SECONDS" 30 600
  require_bounded_integer BETA_STOP_TIMEOUT_SECONDS "$STOP_TIMEOUT_SECONDS" 10 120
  require_bounded_integer BETA_BACKUP_PROOF_MAX_AGE_SECONDS "$BACKUP_PROOF_MAX_AGE_SECONDS" 60 86400
  require_beta_proof_path BETA_BACKUP_RESTORE_PROOF_PATH "$BACKUP_PROOF_PATH"
  require_beta_proof_path BETA_READINESS_PROOF_PATH "$READINESS_PROOF_PATH"
  for command_name in docker git curl grep cut awk timeout mktemp stat date hostname wc cmp sed tr sha256sum dirname cat tail sleep; do
    require_command "$command_name"
  done

  if [[ "$ACTION" != pause ]]; then
    runtime_mode="$(stat -c '%a' "$RUNTIME_ENV")"
    [[ "$runtime_mode" =~ ^[0-7]{3,4}$ ]] || fail "runtime env permissions are unreadable"
    runtime_mode_value=$((8#$runtime_mode))
    (( (runtime_mode_value & 077) == 0 )) || fail "runtime env must not be group- or world-readable"
  fi
  [[ "$(hostname -s)" == "$EXPECTED_HOSTNAME" ]] \
    || fail "host identity is not the expected VM107 guest hostname"
  [[ "$CANDIDATE_REF" == origin/* ]] \
    || fail "BETA_CANDIDATE_REF must be an origin remote-tracking ref"
  git check-ref-format "refs/remotes/$CANDIDATE_REF" >/dev/null \
    || fail "BETA_CANDIDATE_REF is invalid"
}

ensure_scratch_dir() {
  if [[ -z "$scratch_dir" ]]; then
    scratch_dir="$(mktemp -d "${TMPDIR:-/tmp}/lunchlineup-beta-readiness.XXXXXX")"
    chmod 0700 "$scratch_dir"
  fi
}

verify_resend_provider() {
  current_check="resend_provider"
  [[ -f "$APP_DIR/scripts/verify-resend-readiness.mjs" \
    && ! -L "$APP_DIR/scripts/verify-resend-readiness.mjs" ]] \
    || fail "candidate Resend readiness verifier is missing"
  ensure_scratch_dir
  local output="$scratch_dir/resend-readiness.json"
  compose run --rm --no-deps --pull never \
    --env-from-file "$RUNTIME_ENV" \
    api node scripts/verify-resend-readiness.mjs > "$output"
  grep -Fq '"ok": true' "$output" || fail "Resend provider did not accept the readiness probe"
  grep -Fq "\"releaseSha\": \"$SOURCE_SHA\"" "$output" \
    || fail "Resend readiness is not candidate-bound"
  grep -Fq '"providerAccepted": true' "$output" \
    || fail "Resend provider acceptance is missing"
}

verify_source_and_runtime() {
  current_check="source_identity"
  actual_sha="$(git -C "$APP_DIR" rev-parse HEAD)"
  [[ "$actual_sha" == "$SOURCE_SHA" ]] || fail "checkout does not match the requested candidate"
  [[ -z "$(git -C "$APP_DIR" status --porcelain --untracked-files=all)" ]] \
    || fail "checkout is dirty"
  timeout --foreground 120s git -C "$APP_DIR" fetch --prune origin \
    || fail "candidate remote refresh failed"
  git -C "$APP_DIR" rev-parse --verify "${CANDIDATE_REF}^{commit}" >/dev/null \
    || fail "candidate ref is unavailable"
  remote_sha="$(git -C "$APP_DIR" rev-parse "${CANDIDATE_REF}^{commit}")"
  [[ "$remote_sha" == "$SOURCE_SHA" ]] \
    || fail "candidate SHA is not the exact requested pushed ref head"

  current_check="runtime_contract"
  [[ "$(env_value IMAGE_TAG)" == "$SOURCE_SHA" ]] || fail "IMAGE_TAG is not candidate-bound"
  [[ "$(env_value DEPLOY_RELEASE_SHA)" == "$SOURCE_SHA" ]] || fail "DEPLOY_RELEASE_SHA is not candidate-bound"
  [[ "$(env_value MIGRATION_SOURCE_SHA)" == "$SOURCE_SHA" ]] || fail "MIGRATION_SOURCE_SHA is not candidate-bound"
  [[ "$(env_value DATA_TARGET_ENV)" == disposable ]] || fail "DATA_TARGET_ENV must remain disposable"
  [[ "$(env_value APP_ORIGIN)" == "$PUBLIC_ORIGIN" ]] || fail "APP_ORIGIN does not match the beta origin"
  [[ "$(env_value NEXT_PUBLIC_APP_ORIGIN)" == "$PUBLIC_ORIGIN" ]] \
    || fail "NEXT_PUBLIC_APP_ORIGIN does not match the beta origin"
  [[ "$(env_value PASSWORD_RESET_EMAIL_OUTBOX_ENABLED)" == true ]] \
    || fail "password-reset email outbox must be enabled"
  [[ "$(env_value STAFF_INVITATION_OUTBOX_ENABLED)" == true ]] \
    || fail "staff-invitation outbox must be enabled"
  [[ "$(env_value SCHEDULE_PUBLISHED_EMAIL_ENABLED)" == true ]] \
    || fail "published-schedule email delivery must be enabled"

  resend_key="$(env_value RESEND_API_KEY)"
  email_from="$(env_value EMAIL_FROM)"
  [[ "$resend_key" == re_* && "$resend_key" != re_dev_* && "$resend_key" != *change_me* ]] \
    || fail "Resend credential is missing or a disposable placeholder"
  [[ "$email_from" == *'@'* && "$email_from" != *'.example'* && "$email_from" != *'dev.lunchlineup.com'* ]] \
    || fail "EMAIL_FROM is not a beta provider sender"

  alert_route_file="$(env_path ALERTMANAGER_WEBHOOK_URL_FILE)"
  backup_key_file="$(env_path BACKUP_ENCRYPTION_KEY_SECRET_FILE)"
  [[ -s "$alert_route_file" && ! -L "$alert_route_file" ]] \
    || fail "Alertmanager route secret is missing"
  [[ -s "$backup_key_file" && ! -L "$backup_key_file" ]] \
    || fail "backup encryption key is missing"
  alert_route="$(tr -d '\r\n' < "$alert_route_file")"
  [[ "$alert_route" == https://* && "$alert_route" != *localhost* && "$alert_route" != *127.0.0.1* && "$alert_route" != *'.example'* ]] \
    || fail "Alertmanager route is still a local or placeholder sink"

  compose config --quiet
}

build_candidate_images() {
  [[ "$BUILD_IMAGES" == true ]] || return
  current_check="candidate_images_build"
  local service
  for service in "${build_services[@]}"; do
    compose build "$service"
  done
}

launch_services() {
  current_check="compose_launch"
  compose --profile ops up -d --no-build --pull never --remove-orphans "${required_services[@]}"
}

verify_migration() {
  current_check="migrations"
  migration_id="$(compose ps -a -q migrate | tail -n 1)"
  [[ -n "$migration_id" ]] || fail "candidate migration container is missing"
  [[ "$(container_value "$migration_id" '{{.State.Status}}')" == exited ]] \
    || fail "candidate migration container is not complete"
  [[ "$(container_value "$migration_id" '{{.State.ExitCode}}')" == 0 ]] \
    || fail "candidate migration container did not exit successfully"
  migration_image="$(container_value "$migration_id" '{{.Config.Image}}')"
  [[ "$migration_image" == *":$SOURCE_SHA" ]] || fail "migration image is not candidate-bound"
}

services_ready() {
  local service container_id state health image
  for service in "${required_services[@]}"; do
    container_id="$(compose ps -q "$service")"
    [[ -n "$container_id" ]] || return 1
    state="$(container_value "$container_id" '{{.State.Status}}')"
    [[ "$state" == running ]] || return 1
    health="$(container_value "$container_id" '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')"
    [[ "$health" == healthy || "$health" == none ]] || return 1
  done
  for service in "${candidate_image_services[@]}"; do
    container_id="$(compose ps -q "$service")"
    image="$(container_value "$container_id" '{{.Config.Image}}')"
    [[ "$image" == *":$SOURCE_SHA" ]] || return 1
  done
}

wait_for_services() {
  current_check="service_health"
  local deadline=$(( $(date +%s) + START_TIMEOUT_SECONDS ))
  until services_ready; do
    (( $(date +%s) < deadline )) || fail "required candidate services did not become healthy"
    sleep 5
  done
}

prepare_curl_config() {
  local client_id="${CF_ACCESS_CLIENT_ID:-}"
  local client_secret="${CF_ACCESS_CLIENT_SECRET:-}"
  if [[ -z "$client_id" && -z "$client_secret" ]]; then
    return
  fi
  [[ -n "$client_id" && -n "$client_secret" ]] \
    || fail "Cloudflare Access client ID and secret must be set together"
  [[ "$client_id" =~ ^[A-Za-z0-9._~-]+$ && "$client_secret" =~ ^[A-Za-z0-9._~-]+$ ]] \
    || fail "Cloudflare Access credentials contain unsupported characters"
  curl_config="$scratch_dir/cloudflare-access.curl"
  umask 077
  printf 'header = "CF-Access-Client-Id: %s"\nheader = "CF-Access-Client-Secret: %s"\n' \
    "$client_id" "$client_secret" > "$curl_config"
  chmod 0600 "$curl_config"
}

release_header() {
  awk 'tolower($0) ~ /^x-lunchlineup-release:/ { value=$0; sub(/^[^:]*:[[:space:]]*/, "", value); sub(/\r$/, "", value); last=value } END { print last }' "$1"
}

content_type_header() {
  awk 'tolower($0) ~ /^content-type:/ { value=$0; sub(/^[^:]*:[[:space:]]*/, "", value); sub(/\r$/, "", value); last=value } END { print last }' "$1"
}

http_release_probe() {
  local label="$1"
  local url="$2"
  local host_header="$3"
  local response_kind="$4"
  local public_request="$5"
  local headers="$scratch_dir/${label}.headers"
  local body="$scratch_dir/${label}.body"
  local args=(
    --silent --show-error --max-time "$REQUEST_TIMEOUT_SECONDS"
    --connect-timeout "$REQUEST_TIMEOUT_SECONDS" --dump-header "$headers"
    --output "$body" --write-out '%{http_code}' --request GET
    --header 'Cache-Control: no-cache'
  )
  if [[ -n "$host_header" ]]; then
    args+=(--header "Host: $host_header")
  fi
  if [[ "$public_request" == true && -n "${curl_config:-}" ]]; then
    args+=(--config "$curl_config")
  fi
  local code
  code="$(curl "${args[@]}" "$url")" || return 1
  [[ "$code" == 200 ]] || return 1
  [[ "$(release_header "$headers")" == "$SOURCE_SHA" ]] || return 1
  [[ -s "$body" ]] || return 1
  if [[ "$response_kind" == health ]]; then
    grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' "$body" || return 1
  else
    [[ "$(content_type_header "$headers")" == text/html* ]] || return 1
    (( $(wc -c < "$body") >= 1024 )) || return 1
    grep -Fq '<h1' "$body" || return 1
    grep -Fq 'LunchLineup' "$body" || return 1
    grep -Fq '/_next/static/' "$body" || return 1
  fi
}

verify_http_surfaces() {
  current_check="release_surfaces"
  ensure_scratch_dir
  prepare_curl_config
  http_release_probe direct_health http://127.0.0.1/health "$BETA_HOST" health false \
    || fail "direct beta health or release identity failed"
  http_release_probe direct_web http://127.0.0.1/ "$BETA_HOST" html false \
    || fail "direct beta web or release identity failed"
  http_release_probe public_health "$PUBLIC_ORIGIN/health" '' health true \
    || fail "public beta health or release identity failed"
  http_release_probe public_web "$PUBLIC_ORIGIN/" '' html true \
    || fail "public beta web or release identity failed"
}

prometheus_query() {
  local expression="$1"
  local output="$2"
  curl --silent --show-error --fail \
    --max-time "$REQUEST_TIMEOUT_SECONDS" \
    --connect-timeout "$REQUEST_TIMEOUT_SECONDS" \
    --get --data-urlencode "query=$expression" \
    --output "$output" \
    http://127.0.0.1:9090/api/v1/query
  grep -Eq '"status"[[:space:]]*:[[:space:]]*"success"' "$output"
}

empty_prometheus_result() {
  grep -Eq '"result"[[:space:]]*:[[:space:]]*\[[[:space:]]*\]' "$1"
}

verify_monitoring_and_outboxes() {
  current_check="monitoring"
  curl --silent --show-error --fail --max-time "$REQUEST_TIMEOUT_SECONDS" \
    http://127.0.0.1:9090/-/ready >/dev/null
  curl --silent --show-error --fail --max-time "$REQUEST_TIMEOUT_SECONDS" \
    http://127.0.0.1:9093/-/ready >/dev/null

  local readiness_expression='absent(lunchlineup_worker_ready{job="worker"}) or (lunchlineup_worker_ready{job="worker"} != 1) or absent(lunchlineup_solver_queue_telemetry_available{job="worker"}) or (lunchlineup_solver_queue_telemetry_available{job="worker"} != 1) or absent(lunchlineup_solver_queue_messages{job="worker",state="dead_letter"}) or absent(lunchlineup_password_reset_email_sweep_ready{job="worker"}) or (lunchlineup_password_reset_email_sweep_ready{job="worker"} != 1) or absent(lunchlineup_password_reset_email_dead_lettered{job="worker"}) or absent(lunchlineup_staff_invitation_sweep_ready{job="worker"}) or (lunchlineup_staff_invitation_sweep_ready{job="worker"} != 1) or absent(lunchlineup_staff_invitation_dead_lettered{job="worker"}) or absent(lunchlineup_notification_outbox_dead_lettered{job="api"})'
  local deadline=$(( $(date +%s) + MONITORING_TIMEOUT_SECONDS ))
  local readiness_output="$scratch_dir/readiness-query.json"
  until prometheus_query "$readiness_expression" "$readiness_output" \
    && empty_prometheus_result "$readiness_output"; do
    (( $(date +%s) < deadline )) || fail "required worker and email-outbox telemetry did not become ready"
    sleep 5
  done

  current_check="outbox_health"
  local outbox_expression='(lunchlineup_solver_queue_messages{job="worker",state="dead_letter"} > 0) or (lunchlineup_password_reset_email_dead_lettered{job="worker"} > 0) or (lunchlineup_staff_invitation_dead_lettered{job="worker"} > 0) or (lunchlineup_notification_outbox_dead_lettered{job="api"} > 0)'
  local outbox_output="$scratch_dir/outbox-query.json"
  prometheus_query "$outbox_expression" "$outbox_output" \
    || fail "outbox health query failed"
  empty_prometheus_result "$outbox_output" \
    || fail "one or more durable outboxes require operator attention"

  current_check="critical_alerts"
  local alert_expression='ALERTS{alertstate=~"pending|firing",severity="critical",alertname=~"ServiceDown|RequiredApiDependencyUnavailable|PdfParserUnavailable|PdfParserReadinessMissing|PasswordResetEmailProviderOutage|PasswordResetEmailSweepStale|StaffInvitationProviderOutage|StaffInvitationSweepNotReady|StaffInvitationSweepStale|NotificationOutboxDeadLetters|WebhookReplayNotReady|WebhookReplayFailures|SolverQueuePoisoned|SolverErrors|DiskSpaceLow|HostFilesystemTelemetryMissing"}'
  local alert_output="$scratch_dir/alert-query.json"
  prometheus_query "$alert_expression" "$alert_output" \
    || fail "critical alert query failed"
  empty_prometheus_result "$alert_output" \
    || fail "a beta launch-critical alert is pending or firing"
}

run_backup_restore_proof() {
  current_check="backup_restore_proof"
  if [[ "$RUN_BACKUP_RESTORE_PROOF" == true ]]; then
    BETA_RUNTIME_ENV_FILE="$RUNTIME_ENV" \
    BETA_CANDIDATE_SHA="$SOURCE_SHA" \
    BETA_BACKUP_RESTORE_PROOF_PATH="$BACKUP_PROOF_PATH" \
    COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" \
    APP_DIR="$APP_DIR" \
      bash "$APP_DIR/scripts/internal-beta-backup-restore-proof.sh"
  fi
  [[ -f "$BACKUP_PROOF_PATH" && ! -L "$BACKUP_PROOF_PATH" ]] \
    || fail "backup/restore proof is missing"
  grep -Fq '"status": "passed"' "$BACKUP_PROOF_PATH" \
    || fail "backup/restore proof did not pass"
  grep -Fq "\"sourceSha\": \"$SOURCE_SHA\"" "$BACKUP_PROOF_PATH" \
    || fail "backup/restore proof is for another release"
  grep -Fq '"temporaryDatabaseRemoved": true' "$BACKUP_PROOF_PATH" \
    || fail "backup/restore proof lacks cleanup confirmation"
  grep -Fq '"encryptedSnapshot": true' "$BACKUP_PROOF_PATH" \
    || fail "backup/restore proof lacks encrypted snapshot confirmation"
  grep -Fq '"schemaAndMigrationInventoryMatched": true' "$BACKUP_PROOF_PATH" \
    || fail "backup/restore proof lacks schema and migration comparison"
  grep -Fq '"criticalDataInventoryMatched": true' "$BACKUP_PROOF_PATH" \
    || fail "backup/restore proof lacks critical data comparison"
  proof_age=$(( $(date +%s) - $(stat -c '%Y' "$BACKUP_PROOF_PATH") ))
  (( proof_age >= 0 && proof_age <= BACKUP_PROOF_MAX_AGE_SECONDS )) \
    || fail "backup/restore proof is stale"
}

write_readiness_proof() {
  current_check="readiness_proof"
  local proof_dir proof_tmp checked_at backup_proof_sha
  proof_dir="$(dirname "$READINESS_PROOF_PATH")"
  mkdir -p "$proof_dir"
  chmod 0700 "$proof_dir"
  backup_proof_sha="$(sha256sum "$BACKUP_PROOF_PATH" | awk '{print $1}')"
  [[ "$backup_proof_sha" =~ ^[a-f0-9]{64}$ ]] || fail "backup proof digest is invalid"
  proof_tmp="$(mktemp "$proof_dir/.internal-beta-readiness.XXXXXX")"
  checked_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  cat > "$proof_tmp" <<JSON
{
  "status": "passed",
  "target": "vm107-internal-beta",
  "sourceSha": "$SOURCE_SHA",
  "checkedAt": "$checked_at",
  "directHealth": true,
  "directWeb": true,
  "publicHealth": true,
  "publicWeb": true,
  "releaseHeaderMatched": true,
  "migrationsPassed": true,
  "requiredServicesHealthy": true,
  "resendProviderAccepted": true,
  "outboxesReady": true,
  "launchCriticalAlertsClear": true,
  "backupRestoreProofSha256": "$backup_proof_sha"
}
JSON
  chmod 0600 "$proof_tmp"
  mv -f "$proof_tmp" "$READINESS_PROOF_PATH"
  deployed_tmp="$(mktemp "$APP_DIR/.DEPLOYED_GIT_SHA.XXXXXX")"
  printf '%s\n' "$SOURCE_SHA" > "$deployed_tmp"
  chmod 0644 "$deployed_tmp"
  mv -f "$deployed_tmp" "$APP_DIR/DEPLOYED_GIT_SHA"
}

verify_deployed_marker() {
  current_check="deployed_marker"
  [[ -f "$APP_DIR/DEPLOYED_GIT_SHA" && ! -L "$APP_DIR/DEPLOYED_GIT_SHA" ]] \
    || fail "DEPLOYED_GIT_SHA is missing"
  [[ "$(tr -d '\r\n' < "$APP_DIR/DEPLOYED_GIT_SHA")" == "$SOURCE_SHA" ]] \
    || fail "DEPLOYED_GIT_SHA does not match the candidate"
}

pause_services() {
  current_check="compose_pause"
  local running_ids
  running_ids="$(timeout --foreground 30s docker ps -q \
    --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")"
  if [[ -n "$running_ids" ]]; then
    # Word splitting is intentional: docker emits one validated container ID per line.
    timeout --foreground "$((STOP_TIMEOUT_SECONDS + 30))s" \
      docker stop --time "$STOP_TIMEOUT_SECONDS" $running_ids >/dev/null
  fi
  remaining_ids="$(timeout --foreground 30s docker ps -q \
    --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")"
  [[ -z "$remaining_ids" ]] || fail "one or more project containers remain running after pause"
  completed=true
  echo "internal_beta_paused_ok sha=$SOURCE_SHA data_preserved=true vm_onboot_unchanged=true"
}

validate_inputs

if [[ "$ACTION" == pause ]]; then
  current_check="pause_source_identity"
  [[ "$(git -C "$APP_DIR" rev-parse HEAD)" == "$SOURCE_SHA" ]] \
    || fail "checkout does not match the requested pause candidate"
  pause_services
  exit 0
fi

verify_source_and_runtime

if [[ "$ACTION" == launch ]]; then
  build_candidate_images
fi

verify_resend_provider

if [[ "$ACTION" == launch ]]; then
  launch_services
  wait_for_services
  verify_migration
  verify_http_surfaces
  run_backup_restore_proof
  verify_monitoring_and_outboxes
  write_readiness_proof
else
  wait_for_services
  verify_migration
  verify_http_surfaces
  run_backup_restore_proof
  verify_monitoring_and_outboxes
  verify_deployed_marker
  write_readiness_proof
fi

completed=true
echo "internal_beta_readiness_ok action=$ACTION sha=$SOURCE_SHA proof=$READINESS_PROOF_PATH vm_onboot_unchanged=true"
