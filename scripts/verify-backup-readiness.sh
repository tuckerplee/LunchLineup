#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/lunchlineup}"
COMPOSE_SERVICE_ENV_FILE="${COMPOSE_SERVICE_ENV_FILE:?COMPOSE_SERVICE_ENV_FILE is required}"
IMAGE_PREFIX="${IMAGE_PREFIX:?IMAGE_PREFIX is required}"
IMAGE_TAG="${IMAGE_TAG:?IMAGE_TAG is required}"
METRICS_DIR="${NODE_EXPORTER_TEXTFILE_DIR:-/var/lib/node_exporter/textfile_collector}"
MAX_METRIC_AGE_SECONDS="${BACKUP_PROOF_MAX_AGE_SECONDS:-300}"
SYSTEMD_UNIT_DIR="${BACKUP_SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
BACKUP_ENV_FILE="${BACKUP_SYSTEMD_ENV_FILE:-/etc/lunchlineup/backup.env}"
BACKUP_RELEASE_ENV_FILE="${BACKUP_RELEASE_ENV_FILE:-/var/lib/lunchlineup/backup-release.env}"
PITR_BASE_BACKUP_ENV_FILE="${PITR_BASE_BACKUP_SYSTEMD_ENV_FILE:-/etc/lunchlineup/pitr-base-backup.env}"
PITR_STORAGE_VERIFY_SCRIPT="${PITR_STORAGE_VERIFY_SCRIPT:-$APP_DIR/scripts/pitr-verify-storage.sh}"
SYSTEMD_OPERATION_TIMEOUT_SECONDS="${BACKUP_SYSTEMD_OPERATION_TIMEOUT_SECONDS:-30}"
BACKUP_SERVICE_START_TIMEOUT_SECONDS="${BACKUP_SERVICE_START_TIMEOUT_SECONDS:-7260}"
PITR_SERVICE_START_TIMEOUT_SECONDS="${PITR_SERVICE_START_TIMEOUT_SECONDS:-21660}"
TIMEOUT_RECONCILIATION_SECONDS="${BACKUP_TIMEOUT_RECONCILIATION_SECONDS:-120}"
DOCKER_OPERATION_TIMEOUT_SECONDS="${BACKUP_DOCKER_OPERATION_TIMEOUT_SECONDS:-30}"
CANDIDATE_PATH="$APP_DIR"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME is required}"
CANDIDATE_COMPOSE_PROJECT="$COMPOSE_PROJECT_NAME"

fail() { echo "$1" >&2; exit 1; }
[[ "$COMPOSE_PROJECT_NAME" == "lunchlineup" ]] || fail "COMPOSE_PROJECT_NAME must remain lunchlineup."
[[ "$MAX_METRIC_AGE_SECONDS" =~ ^[1-9][0-9]*$ ]] || fail "BACKUP_PROOF_MAX_AGE_SECONDS must be positive."
[[ "$SYSTEMD_OPERATION_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] \
  && (( SYSTEMD_OPERATION_TIMEOUT_SECONDS <= 120 )) \
  || fail "BACKUP_SYSTEMD_OPERATION_TIMEOUT_SECONDS must be an integer from 1 through 120."
for timeout_setting in \
  BACKUP_SERVICE_START_TIMEOUT_SECONDS \
  PITR_SERVICE_START_TIMEOUT_SECONDS \
  TIMEOUT_RECONCILIATION_SECONDS \
  DOCKER_OPERATION_TIMEOUT_SECONDS; do
  timeout_value="${!timeout_setting}"
  [[ "$timeout_value" =~ ^[1-9][0-9]*$ ]] || fail "$timeout_setting must be a positive integer."
done
(( BACKUP_SERVICE_START_TIMEOUT_SECONDS >= 7260 && BACKUP_SERVICE_START_TIMEOUT_SECONDS <= 28800 )) \
  || fail "BACKUP_SERVICE_START_TIMEOUT_SECONDS must be an integer from 7260 through 28800."
(( PITR_SERVICE_START_TIMEOUT_SECONDS >= 21660 && PITR_SERVICE_START_TIMEOUT_SECONDS <= 28800 )) \
  || fail "PITR_SERVICE_START_TIMEOUT_SECONDS must be an integer from 21660 through 28800."
(( TIMEOUT_RECONCILIATION_SECONDS <= 300 )) \
  || fail "BACKUP_TIMEOUT_RECONCILIATION_SECONDS must be no greater than 300."
(( DOCKER_OPERATION_TIMEOUT_SECONDS <= 120 )) \
  || fail "BACKUP_DOCKER_OPERATION_TIMEOUT_SECONDS must be no greater than 120."
[[ "$APP_DIR" == /* && -d "$APP_DIR" && ! -L "$APP_DIR" ]] \
  || fail "APP_DIR must be the exact absolute non-symlink retained candidate directory."
[[ "$(basename -- "$APP_DIR")" == "$IMAGE_TAG" && "$(basename -- "$(dirname -- "$APP_DIR")")" == releases ]] \
  || fail "APP_DIR must be the exact retained releases/<source SHA> path."
[[ "$(cd "$APP_DIR" && pwd -P)" == "$APP_DIR" ]] \
  || fail "APP_DIR must be canonical and may not traverse a symlink."
[[ "$(id -u)" == "0" ]] || fail "Backup scheduler installation requires root."
export IMAGE_PREFIX IMAGE_TAG

run_systemctl() {
  timeout --foreground --signal=TERM --kill-after=5s "${SYSTEMD_OPERATION_TIMEOUT_SECONDS}s" systemctl "$@"
}

run_journalctl() {
  timeout --foreground --signal=TERM --kill-after=5s "${SYSTEMD_OPERATION_TIMEOUT_SECONDS}s" journalctl "$@"
}

service_start_timeout() {
  case "$1" in
    lunchlineup-backup.service) printf '%s' "$BACKUP_SERVICE_START_TIMEOUT_SECONDS" ;;
    lunchlineup-pitr-base-backup.service) printf '%s' "$PITR_SERVICE_START_TIMEOUT_SECONDS" ;;
    *) return 1 ;;
  esac
}

run_systemctl_start() {
  local service="$1"
  local seconds
  seconds="$(service_start_timeout "$service")" || return 64
  timeout --foreground --signal=TERM --kill-after=5s "${seconds}s" systemctl start "$service"
}

reconciliation_remaining_seconds() {
  local remaining=$((timeout_reconciliation_deadline - $(date -u +%s)))
  [[ "$remaining" -ge 1 ]] || return 1
  printf '%s' "$remaining"
}

run_reconciliation_command() {
  local remaining
  remaining="$(reconciliation_remaining_seconds)" || return 124
  timeout --foreground --signal=TERM --kill-after=5s "${remaining}s" "$@"
}

candidate_compose_service() {
  case "$1" in
    lunchlineup-backup.service) printf 'backup' ;;
    lunchlineup-pitr-base-backup.service) printf 'pitr-base-backup' ;;
    *) return 1 ;;
  esac
}

read_candidate_container_ids() {
  local service="$1"
  local compose_service
  compose_service="$(candidate_compose_service "$service")" || return 1
  run_reconciliation_command docker ps -a --no-trunc \
    --filter "label=com.docker.compose.project=${CANDIDATE_COMPOSE_PROJECT}" \
    --filter "label=com.docker.compose.service=${compose_service}" \
    --format '{{.ID}}'
}

reconcile_timed_out_service() {
  local service="$1"
  local invocation_id
  local container_ids
  local container_id
  local remaining_ids
  local active_state
  local sub_state
  local result

  timeout_reconciliation_deadline=$(( $(date -u +%s) + TIMEOUT_RECONCILIATION_SECONDS ))
  invocation_id="$(run_reconciliation_command systemctl show "$service" --property=InvocationID --value)" \
    || return 1
  [[ "$invocation_id" =~ ^[A-Fa-f0-9]{32}$ ]] || return 1
  container_ids="$(read_candidate_container_ids "$service")" || return 1
  [[ "$container_ids" != *$'\n'* && "$container_ids" =~ ^[a-f0-9]{64}$ ]] || return 1
  container_id="$container_ids"

  if ! run_reconciliation_command systemctl stop "$service" >/dev/null 2>&1; then
    run_reconciliation_command systemctl kill --kill-who=all --signal=KILL "$service" >/dev/null 2>&1 || true
    run_reconciliation_command systemctl stop "$service" >/dev/null 2>&1 || return 1
  fi
  active_state="$(run_reconciliation_command systemctl show "$service" --property=ActiveState --value)" || return 1
  sub_state="$(run_reconciliation_command systemctl show "$service" --property=SubState --value)" || return 1
  result="$(run_reconciliation_command systemctl show "$service" --property=Result --value)" || return 1
  [[ "$active_state" =~ ^(inactive|failed)$ && "$sub_state" =~ ^(dead|failed)$ ]] || return 1

  remaining_ids="$(read_candidate_container_ids "$service")" || return 1
  if [[ -n "$remaining_ids" ]]; then
    [[ "$remaining_ids" == "$container_id" ]] || return 1
    run_reconciliation_command docker rm -f "$container_id" >/dev/null || return 1
  fi
  remaining_ids="$(read_candidate_container_ids "$service")" || return 1
  [[ -z "$remaining_ids" ]] || return 1
  printf 'backup_readiness_timeout_reconciled service=%s invocation_id=%s container_id=%s active_state=%s sub_state=%s result=%s\n' \
    "$service" "${invocation_id,,}" "$container_id" "$active_state" "$sub_state" "$result" >&2
}

services=(lunchlineup-backup.service lunchlineup-pitr-base-backup.service)
timers=(lunchlineup-backup.timer lunchlineup-pitr-base-backup.timer)
units=("${services[@]}" "${timers[@]}")
verification_complete=false
systemd_mutation_started=false
systemd_restore_safe=true
backup_log=""
pitr_log=""
declare -A candidate_invocation_ids=()
declare -A candidate_image_digests=()
declare -A candidate_metric_before=()
declare -A candidate_started_epochs=()
state_parent="${BACKUP_RESTORE_STATE_ROOT:-${TMPDIR:-/tmp}}"
[[ -d "$state_parent" && ! -L "$state_parent" ]] \
  || fail "BACKUP_RESTORE_STATE_ROOT must be an existing non-symlink directory."
state_dir="$(mktemp -d "$state_parent/lunchlineup-backup-readiness.XXXXXX")"
runtime_state_file="$state_dir/runtime-state"
unit_state_file="$state_dir/units"
: >"$runtime_state_file"
: >"$unit_state_file"
cleanup_failed=false

cleanup_problem() {
  echo "Backup-readiness cleanup failed: $*" >&2
  cleanup_failed=true
}

read_enabled_state() {
  local unit="$1"
  local unit_was_present="$2"
  local output
  local status=0

  if output="$(run_systemctl is-enabled "$unit" 2>/dev/null)"; then
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
    *)
      return 1
      ;;
  esac
}

read_active_state() {
  local unit="$1"
  local unit_was_present="$2"
  local output
  local status=0

  if output="$(run_systemctl is-active "$unit" 2>/dev/null)"; then
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
    *)
      return 1
      ;;
  esac
}

snapshot_runtime_state() {
  local unit="$1"
  local unit_was_present="$2"
  local was_enabled
  local was_active

  was_enabled="$(read_enabled_state "$unit" "$unit_was_present")" \
    || fail "Cannot safely snapshot $unit enabled state."
  was_active="$(read_active_state "$unit" "$unit_was_present")" \
    || fail "Cannot safely snapshot $unit active state."
  printf '%s|%s|%s|%s\n' "$unit" "$unit_was_present" "$was_enabled" "$was_active" \
    >> "$runtime_state_file"
}

reconcile_runtime_state() {
  local unit="$1"
  local unit_was_present="$2"
  local was_enabled="$3"
  local was_active="$4"

  [[ "$unit_was_present" == "true" ]] || cleanup_problem "cannot restore runtime state for absent $unit"
  if [[ "$was_enabled" == "true" ]]; then
    run_systemctl enable "$unit" >/dev/null 2>&1 || cleanup_problem "could not re-enable $unit"
  else
    run_systemctl disable "$unit" >/dev/null 2>&1 || cleanup_problem "could not restore disabled state for $unit"
  fi

  if [[ "$was_active" == "true" ]]; then
    run_systemctl start "$unit" >/dev/null 2>&1 || cleanup_problem "could not restart $unit"
  else
    run_systemctl stop "$unit" >/dev/null 2>&1 || cleanup_problem "could not restore inactive state for $unit"
  fi
}

verify_runtime_state() {
  local unit="$1"
  local unit_was_present="$2"
  local was_enabled="$3"
  local was_active="$4"
  local current_enabled
  local current_active

  current_enabled="$(read_enabled_state "$unit" "$unit_was_present")" \
    || { cleanup_problem "could not independently confirm $unit enabled state"; return; }
  [[ "$current_enabled" == "$was_enabled" ]] \
    || cleanup_problem "$unit enabled state was not restored"
  current_active="$(read_active_state "$unit" "$unit_was_present")" \
    || { cleanup_problem "could not independently confirm $unit active state"; return; }
  [[ "$current_active" == "$was_active" ]] \
    || cleanup_problem "$unit active state was not restored"
}

restore_systemd_state() {
  local was_enabled
  local was_active
  local unit_was_present
  local unit
  local unit_path
  local snapshot_path

  if [[ "$systemd_restore_safe" != "true" ]]; then
    cleanup_problem "candidate service/container state was not safely reconciled; refusing to replace unit bytes"
    return 1
  fi

  # Remove candidate runtime state while candidate bytes still exist.
  while IFS='|' read -r unit unit_was_present was_enabled was_active; do
    [[ -n "$unit" ]] || continue
    if [[ "$unit_was_present" != "true" ]]; then
      reconcile_runtime_state "$unit" true false false
    fi
  done < "$runtime_state_file"

  while IFS='|' read -r unit unit_was_present; do
    [[ -n "$unit" ]] || continue
    unit_path="$SYSTEMD_UNIT_DIR/$unit"
    snapshot_path="$state_dir/unit-$unit"
    if [[ "$unit_was_present" == "true" ]]; then
      rm -f -- "$unit_path" || cleanup_problem "could not remove candidate bytes for $unit"
      cp -a -- "$snapshot_path" "$unit_path" || cleanup_problem "could not restore previous bytes for $unit"
      if [[ -L "$snapshot_path" ]]; then
        [[ -L "$unit_path" && "$(readlink -- "$unit_path")" == "$(readlink -- "$snapshot_path")" ]] \
          || cleanup_problem "restored symlink for $unit does not match the previous target"
      else
        [[ -f "$unit_path" && ! -L "$unit_path" ]] && cmp -s -- "$snapshot_path" "$unit_path" \
          || cleanup_problem "restored bytes for $unit do not match the previous unit"
      fi
    else
      rm -f -- "$unit_path" || cleanup_problem "could not remove newly introduced $unit"
      [[ ! -e "$unit_path" && ! -L "$unit_path" ]] \
        || cleanup_problem "newly introduced $unit remains after restoration"
    fi
  done < "$unit_state_file"

  run_systemctl daemon-reload || cleanup_problem "systemd daemon-reload failed after unit restoration"

  while IFS='|' read -r unit unit_was_present was_enabled was_active; do
    [[ -n "$unit" ]] || continue
    if [[ "$unit_was_present" == "true" ]]; then
      reconcile_runtime_state "$unit" "$unit_was_present" "$was_enabled" "$was_active"
    fi
  done < "$runtime_state_file"

  while IFS='|' read -r unit unit_was_present was_enabled was_active; do
    [[ -n "$unit" ]] || continue
    verify_runtime_state "$unit" "$unit_was_present" "$was_enabled" "$was_active"
  done < "$runtime_state_file"

  [[ "$cleanup_failed" == "false" ]]
}

confirm_candidate_systemd_state() {
  local unit
  local expected_enabled
  local expected_active
  local actual_enabled
  local actual_active

  for unit in "${units[@]}"; do
    [[ -f "$SYSTEMD_UNIT_DIR/$unit" && ! -L "$SYSTEMD_UNIT_DIR/$unit" ]] \
      && cmp -s -- "$APP_DIR/infrastructure/systemd/$unit" "$SYSTEMD_UNIT_DIR/$unit" \
      || fail "Installed candidate bytes do not exactly match $unit."
    expected_enabled=false
    expected_active=false
    case "$unit" in
      *.timer)
        expected_enabled=true
        expected_active=true
        ;;
    esac
    actual_enabled="$(read_enabled_state "$unit" true)" \
      || fail "Could not independently confirm candidate enabled state for $unit."
    actual_active="$(read_active_state "$unit" true)" \
      || fail "Could not independently confirm candidate active state for $unit."
    [[ "$actual_enabled" == "$expected_enabled" ]] \
      || fail "Candidate enabled state does not match for $unit."
    [[ "$actual_active" == "$expected_active" ]] \
      || fail "Candidate active state does not match for $unit."
  done
}

cleanup_verification() {
  local exit_code=$?
  local log_file
  set +e
  for log_file in "$backup_log" "$pitr_log"; do
    [[ -z "$log_file" ]] || rm -f -- "$log_file" \
      || cleanup_problem "could not remove temporary log $log_file"
  done
  if [[ "$verification_complete" != "true" && "$systemd_mutation_started" == "true" ]]; then
    restore_systemd_state || cleanup_failed=true
  fi
  if [[ "$cleanup_failed" == "false" ]]; then
    rm -rf -- "$state_dir" || cleanup_problem "could not remove temporary state directory"
  fi
  if [[ "$cleanup_failed" == "true" ]]; then
    echo "Backup-readiness restore snapshots preserved: $state_dir" >&2
  fi
  trap - EXIT
  if [[ "$cleanup_failed" == "true" ]]; then
    exit 1
  fi
  exit "$exit_code"
}

trap cleanup_verification EXIT
for unit in "${units[@]}"; do
  unit_path="$SYSTEMD_UNIT_DIR/$unit"
  unit_was_present=false
  if [[ -e "$unit_path" || -L "$unit_path" ]]; then
    cp -a -- "$unit_path" "$state_dir/unit-$unit"
    printf '%s|true\n' "$unit" >> "$unit_state_file"
    unit_was_present=true
  else
    printf '%s|false\n' "$unit" >> "$unit_state_file"
  fi
  snapshot_runtime_state "$unit" "$unit_was_present"
done
systemd_mutation_started=true
run_systemctl disable --now "${timers[@]}" >/dev/null 2>&1 \
  || fail "Could not disable backup timers before readiness verification."
required_environment_files=(
  "$BACKUP_ENV_FILE"
  "$BACKUP_RELEASE_ENV_FILE"
  "$PITR_BASE_BACKUP_ENV_FILE"
)

for environment_file in "${required_environment_files[@]}"; do
  [[ -f "$environment_file" && -r "$environment_file" ]] \
    || fail "Required systemd EnvironmentFile is missing or unreadable: $environment_file"
done

for service in "${services[@]}"; do
  unit="$APP_DIR/infrastructure/systemd/$service"
  [[ -f "$unit" ]] || fail "Required backup service unit is missing: $unit"
done
for timer in "${timers[@]}"; do
  unit="$APP_DIR/infrastructure/systemd/$timer"
  [[ -f "$unit" ]] || fail "Required backup timer unit is missing: $unit"
done

APP_DIR="$APP_DIR" \
  COMPOSE_SERVICE_ENV_FILE="$COMPOSE_SERVICE_ENV_FILE" \
  IMAGE_PREFIX="$IMAGE_PREFIX" \
  IMAGE_TAG="$IMAGE_TAG" \
  bash "$PITR_STORAGE_VERIFY_SCRIPT"

unit_paths=()
for unit in "${services[@]}" "${timers[@]}"; do
  unit_path="$SYSTEMD_UNIT_DIR/$unit"
  install -m 0644 "$APP_DIR/infrastructure/systemd/$unit" "$unit_path"
  unit_paths+=("$unit_path")
done
systemd-analyze verify "${unit_paths[@]}"
run_systemctl daemon-reload


backup_log="$(mktemp)"
pitr_log="$(mktemp)"


run_backup_service() {
  local service="$1"
  local log_file="$2"
  local started_at
  local started_epoch
  local metric_path
  local invocation_id
  local binding
  local bound_invocation_id
  local bound_candidate_path
  local bound_source_sha
  local bound_image_digest
  local start_status=0
  local service_result=''
  case "$service" in
    lunchlineup-backup.service) metric_path="$METRICS_DIR/lunchlineup_backup.prom" ;;
    lunchlineup-pitr-base-backup.service) metric_path="$METRICS_DIR/lunchlineup_pitr.prom" ;;
    *) fail "Unsupported candidate backup service: $service" ;;
  esac
  candidate_metric_before["$service"]="$(stat -Lc '%d:%i:%s:%Y:%y' -- "$metric_path" 2>/dev/null || printf missing)"
  started_epoch="$(date -u +%s)"
  started_at="$(date --iso-8601=seconds)"
  run_systemctl reset-failed "$service" >/dev/null 2>&1 || true
  if run_systemctl_start "$service"; then
    start_status=0
  else
    start_status=$?
    service_result="$(run_systemctl show "$service" --property=Result --value 2>/dev/null || true)"
  fi
  if [[ "$start_status" -ne 0 ]]; then
    if [[ "$start_status" -eq 124 || "$start_status" -eq 137 || "$service_result" == timeout ]]; then
      if ! reconcile_timed_out_service "$service"; then
        systemd_restore_safe=false
        fail "$service timed out and exact InvocationID/container terminal reconciliation failed; candidate unit bytes were preserved."
      fi
    fi
    run_journalctl --unit "$service" --since "$started_at" --no-pager --output=cat >"$log_file" || true
    cat "$log_file" >&2
    fail "$service failed."
  fi
  invocation_id="$(run_systemctl show "$service" --property=InvocationID --value)" \
    || fail "Could not read the completed systemd InvocationID for $service."
  [[ "$invocation_id" =~ ^[A-Fa-f0-9]{32}$ ]] \
    || fail "$service did not report one valid systemd InvocationID."
  run_journalctl --unit "$service" "_SYSTEMD_INVOCATION_ID=$invocation_id" --no-pager --output=cat >"$log_file"
  [[ "$(run_systemctl show "$service" --property=Result --value)" == "success" ]] \
    || fail "$service did not report Result=success."
  [[ "$(run_systemctl show "$service" --property=ExecMainStatus --value)" == "0" ]] \
    || fail "$service did not exit successfully."
  binding="$(python3 - \
    "$log_file" \
    "$service" \
    "$invocation_id" \
    "$CANDIDATE_PATH" \
    "$IMAGE_TAG" <<'PY'
import re
import shlex
import sys

log_path, expected_service, expected_invocation, expected_path, expected_sha = sys.argv[1:]
matches = []
for line in open(log_path, encoding='utf-8').read().splitlines():
    if not line.startswith('candidate_release_job_ok '):
        continue
    fields = {}
    for token in shlex.split(line)[1:]:
        if '=' not in token:
            raise SystemExit('candidate release binding contains a malformed field')
        key, value = token.split('=', 1)
        if key in fields:
            raise SystemExit('candidate release binding contains a duplicate field')
        fields[key] = value
    matches.append(fields)
if len(matches) != 1:
    raise SystemExit('candidate release journal must contain exactly one completion binding for this invocation')
fields = matches[0]
if (
    fields.get('service') != expected_service
    or fields.get('invocation_id', '').lower() != expected_invocation.lower()
    or fields.get('candidate_path') != expected_path
    or fields.get('source_sha') != expected_sha
    or not re.fullmatch(r'[\x21-\x7e]{1,512}', fields.get('image_ref', ''))
    or not re.fullmatch(r'sha256:[a-f0-9]{64}', fields.get('image_digest', ''))
):
    raise SystemExit('candidate release journal binding does not match the exact systemd invocation, path, source SHA, and image digest')
print('\t'.join((fields['invocation_id'].lower(), fields['candidate_path'], fields['source_sha'], fields['image_digest'])))
PY
  )" || fail "$service journal did not bind the successful candidate release job."
  IFS=$'\t' read -r bound_invocation_id bound_candidate_path bound_source_sha bound_image_digest <<<"$binding"
  [[ -n "$bound_image_digest" ]] || fail "$service candidate release binding normalization failed."
  candidate_invocation_ids["$service"]="$bound_invocation_id"
  candidate_image_digests["$service"]="$bound_image_digest"
  candidate_started_epochs["$service"]="$started_epoch"
}

verify_service_metric() {
  local service="$1"
  local metric_path
  local metric_name
  local current_identity
  local checked_epoch
  case "$service" in
    lunchlineup-backup.service)
      metric_path="$METRICS_DIR/lunchlineup_backup.prom"
      metric_name=lunchlineup_backup_last_success_timestamp_seconds
      ;;
    lunchlineup-pitr-base-backup.service)
      metric_path="$METRICS_DIR/lunchlineup_pitr.prom"
      metric_name=lunchlineup_pitr_base_backup_last_success_timestamp_seconds
      ;;
    *) fail "Unsupported candidate backup service: $service" ;;
  esac
  current_identity="$(stat -Lc '%d:%i:%s:%Y:%y' -- "$metric_path" 2>/dev/null || printf missing)"
  [[ "$current_identity" != missing && "$current_identity" != "${candidate_metric_before[$service]}" ]] \
    || fail "$service did not atomically publish new metrics evidence for this invocation."
  checked_epoch="$(date -u +%s)"
  python3 - \
    "$metric_path" \
    "$metric_name" \
    "$MAX_METRIC_AGE_SECONDS" \
    "${candidate_started_epochs[$service]}" \
    "$checked_epoch" <<'PY'
import re
import sys

path, metric, max_age_text, started_text, checked_text = sys.argv[1:]
try:
    content = open(path, encoding='utf-8').read()
except OSError as error:
    raise SystemExit(f'missing backup metrics proof: {path}: {error}')
match = re.search(rf'^{re.escape(metric)}\s+(\d+)$', content, re.MULTILINE)
timestamp = int(match.group(1)) if match else -1
started = int(started_text)
checked = int(checked_text)
if (
    timestamp < started
    or timestamp > checked + 60
    or checked - timestamp > int(max_age_text)
):
    raise SystemExit(f'backup metrics proof is missing, stale, pre-run, or from the future: {metric}')
PY
}

run_backup_service lunchlineup-backup.service "$backup_log"
python3 - \
  "$backup_log" \
  "$MAX_METRIC_AGE_SECONDS" \
  "${candidate_started_epochs[lunchlineup-backup.service]}" \
  "$(date -u +%s)" <<'PY'
import datetime
import re
import shlex
import sys

log_path, max_age_text, started_text, checked_text = sys.argv[1:]
lines = open(log_path, encoding='utf-8').read().splitlines()

def fields(prefix):
    matches = [line for line in lines if line.startswith(prefix + ' ')]
    if not matches:
        raise SystemExit(f'backup one-shot is missing {prefix} proof')
    parsed = {}
    for token in shlex.split(matches[-1])[1:]:
        if '=' not in token:
            raise SystemExit(f'backup proof contains a malformed {prefix} field')
        key, value = token.split('=', 1)
        parsed[key] = value
    return parsed

retention = fields('offsite_retention_ok')
immutable = fields('offsite_immutable_ok')
backup = fields('backup_ok')
if retention.get('mode') != 'lifecycle_owned' or retention.get('delete') != 'denied':
    raise SystemExit('backup offsite expiry is not lifecycle-owned with deletion denied')
repository = retention.get('repository', '')
if not re.fullmatch(r's3://[^ /]+/[^ ]+/?', repository):
    raise SystemExit('backup offsite proof does not name an immutable S3 prefix')
version_pattern = re.compile(r'^[A-Za-z0-9._+=:/-]+$')
for key in ('object_version', 'checksum_version'):
    value = immutable.get(key, '')
    if not version_pattern.fullmatch(value) or value in {'none', 'null', 'latest'}:
        raise SystemExit(f'backup offsite proof is missing exact {key}')
principal = immutable.get('principal', '')
if not principal.startswith('arn:') or any(character.isspace() for character in principal):
    raise SystemExit('backup offsite proof is missing an authenticated provider principal')
try:
    observed = datetime.datetime.fromisoformat(immutable.get('observed_at', '').replace('Z', '+00:00'))
except ValueError as error:
    raise SystemExit('backup offsite proof has no valid provider observation time') from error
observed_epoch = int(observed.timestamp())
started_epoch = int(started_text)
checked_epoch = int(checked_text)
if observed_epoch < started_epoch or checked_epoch - observed_epoch > int(max_age_text) or observed_epoch > checked_epoch + 60:
    raise SystemExit('backup offsite provider observation is stale, pre-run, or from the future')
if (
    backup.get('offsite_uri') != repository
    or backup.get('offsite_version') != immutable['object_version']
    or backup.get('checksum_version') != immutable['checksum_version']
    or backup.get('provider_principal') != principal
    or backup.get('provider_observed_at') != immutable['observed_at']
    or backup.get('expiry_owner') != 'lifecycle'
):
    raise SystemExit('backup completion proof is not bound to immutable authenticated provider readback')
PY
verify_service_metric lunchlineup-backup.service

run_backup_service lunchlineup-pitr-base-backup.service "$pitr_log"
grep -q '^pitr_base_backup_ok ' "$pitr_log" || fail "PITR one-shot did not complete."
verify_service_metric lunchlineup-pitr-base-backup.service

run_systemctl enable --now "${timers[@]}" >/dev/null
for timer in "${timers[@]}"; do
  [[ "$(read_enabled_state "$timer" true)" == "true" ]] || fail "$timer is not enabled."
  [[ "$(read_active_state "$timer" true)" == "true" ]] || fail "$timer is not active."
done

confirm_candidate_systemd_state
verification_complete=true
printf 'backup_readiness_ok release_sha=%s candidate_path=%s backup_invocation_id=%s backup_image_digest=%s pitr_invocation_id=%s pitr_image_digest=%s units=exact timers=enabled-active services=disabled-inactive one_shot=backup-pitr offsite=verified metrics=fresh\n' \
  "$IMAGE_TAG" \
  "$CANDIDATE_PATH" \
  "${candidate_invocation_ids[lunchlineup-backup.service]}" \
  "${candidate_image_digests[lunchlineup-backup.service]}" \
  "${candidate_invocation_ids[lunchlineup-pitr-base-backup.service]}" \
  "${candidate_image_digests[lunchlineup-pitr-base-backup.service]}"
