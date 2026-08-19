#!/usr/bin/env bash

VM217_TRANSPORT_DEADLINES_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
VM217_BOUNDED_COMMAND_OWNER="$VM217_TRANSPORT_DEADLINES_DIR/run-bounded-command.mjs"
VM217_BOUNDED_COMMAND_PRESERVE_MSYS_ARGUMENTS=false
case "${OSTYPE:-}" in
  msys*|mingw*|cygwin*)
    VM217_BOUNDED_COMMAND_OWNER="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -W)/run-bounded-command.mjs"
    VM217_BOUNDED_COMMAND_PRESERVE_MSYS_ARGUMENTS=true
    ;;
esac
VM217_SSH_CONNECT_TIMEOUT_SECONDS="${VM217_SSH_CONNECT_TIMEOUT_SECONDS:-15}"
VM217_SSH_COMMAND_TIMEOUT_SECONDS="${VM217_SSH_COMMAND_TIMEOUT_SECONDS:-1800}"
VM217_MUTATION_BUDGET_SECONDS="${VM217_MUTATION_BUDGET_SECONDS:-$VM217_SSH_COMMAND_TIMEOUT_SECONDS}"
VM217_SCP_COMMAND_TIMEOUT_SECONDS="${VM217_SCP_COMMAND_TIMEOUT_SECONDS:-300}"
VM217_SSH_CLEANUP_TIMEOUT_SECONDS="${VM217_SSH_CLEANUP_TIMEOUT_SECONDS:-30}"
VM217_SSH_RECONCILE_TIMEOUT_SECONDS="${VM217_SSH_RECONCILE_TIMEOUT_SECONDS:-60}"
VM217_SSH_SERVER_ALIVE_INTERVAL_SECONDS="${VM217_SSH_SERVER_ALIVE_INTERVAL_SECONDS:-10}"
VM217_SSH_SERVER_ALIVE_COUNT_MAX="${VM217_SSH_SERVER_ALIVE_COUNT_MAX:-3}"
VM217_TRANSPORT_KILL_AFTER_SECONDS="${VM217_TRANSPORT_KILL_AFTER_SECONDS:-5}"
VM217_MUTATION_NOT_AFTER_EPOCH_SECONDS="${VM217_MUTATION_NOT_AFTER_EPOCH_SECONDS:-}"
VM217_MUTATION_BUDGET_STARTED_AT_SECONDS=""

vm217_require_bounded_integer() {
  local name="$1"
  local value="$2"
  local minimum="$3"
  local maximum="$4"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] && (( value >= minimum && value <= maximum )) \
    || { echo "$name must be an integer from $minimum through $maximum." >&2; return 64; }
}

vm217_validate_transport_deadlines() {
  vm217_require_bounded_integer VM217_SSH_CONNECT_TIMEOUT_SECONDS "$VM217_SSH_CONNECT_TIMEOUT_SECONDS" 1 120
  vm217_require_bounded_integer VM217_SSH_COMMAND_TIMEOUT_SECONDS "$VM217_SSH_COMMAND_TIMEOUT_SECONDS" 1 7200
  vm217_require_bounded_integer VM217_MUTATION_BUDGET_SECONDS "$VM217_MUTATION_BUDGET_SECONDS" 1 7200
  vm217_require_bounded_integer VM217_SCP_COMMAND_TIMEOUT_SECONDS "$VM217_SCP_COMMAND_TIMEOUT_SECONDS" 1 3600
  vm217_require_bounded_integer VM217_SSH_CLEANUP_TIMEOUT_SECONDS "$VM217_SSH_CLEANUP_TIMEOUT_SECONDS" 1 300
  vm217_require_bounded_integer VM217_SSH_RECONCILE_TIMEOUT_SECONDS "$VM217_SSH_RECONCILE_TIMEOUT_SECONDS" 1 300
  vm217_require_bounded_integer VM217_SSH_SERVER_ALIVE_INTERVAL_SECONDS "$VM217_SSH_SERVER_ALIVE_INTERVAL_SECONDS" 1 60
  vm217_require_bounded_integer VM217_SSH_SERVER_ALIVE_COUNT_MAX "$VM217_SSH_SERVER_ALIVE_COUNT_MAX" 1 10
  vm217_require_bounded_integer VM217_TRANSPORT_KILL_AFTER_SECONDS "$VM217_TRANSPORT_KILL_AFTER_SECONDS" 1 60
  if [[ -n "$VM217_MUTATION_NOT_AFTER_EPOCH_SECONDS" ]]; then
    vm217_require_bounded_integer VM217_MUTATION_NOT_AFTER_EPOCH_SECONDS "$VM217_MUTATION_NOT_AFTER_EPOCH_SECONDS" 1 2147483647
  fi
}

vm217_assert_mutation_cutoff() {
  local now_epoch_seconds
  if [[ -n "$VM217_MUTATION_NOT_AFTER_EPOCH_SECONDS" ]]; then
    now_epoch_seconds="$(date +%s)" \
      || { echo "Could not read the VM217 mutation cutoff clock." >&2; return 70; }
    if (( now_epoch_seconds > VM217_MUTATION_NOT_AFTER_EPOCH_SECONDS )); then
      printf 'VM217 pre-mutation cutoff passed before remote mutation began; no mutation was attempted. Re-run compatibility validation and do not bypass the cutoff.\n' >&2
      return 124
    fi
  fi
}

vm217_run_bounded_command_owner() {
  if [[ "$VM217_BOUNDED_COMMAND_PRESERVE_MSYS_ARGUMENTS" == "true" ]]; then
    MSYS2_ARG_CONV_EXCL='*' \
      LUNCHLINEUP_BOUNDED_COMMAND_PRESERVE_MSYS_ARGUMENTS=1 \
      node "$VM217_BOUNDED_COMMAND_OWNER" "$@"
  else
    node "$VM217_BOUNDED_COMMAND_OWNER" "$@"
  fi
}

vm217_run_with_deadline() {
  local operation="$1"
  local deadline_seconds="$2"
  shift 2
  local status

  if vm217_run_bounded_command_owner \
    --timeout-seconds "$deadline_seconds" \
    --kill-after-seconds "$VM217_TRANSPORT_KILL_AFTER_SECONDS" \
    -- \
    "$@"; then
    return 0
  else
    status=$?
  fi

  if (( status == 124 || status == 137 )); then
    printf 'VM217 transport deadline exceeded during %s after %ss; remote state is unknown. Keep rollback eligibility armed, verify VM217 release state, and do not retry the mutation blindly.\n' \
      "$operation" "$deadline_seconds" >&2
    return 124
  fi
  return "$status"
}

vm217_begin_mutation_budget() {
  [[ -z "$VM217_MUTATION_BUDGET_STARTED_AT_SECONDS" ]] \
    || { echo "VM217 aggregate mutation budget has already started." >&2; return 64; }
  vm217_assert_mutation_cutoff || return $?
  VM217_MUTATION_BUDGET_STARTED_AT_SECONDS="$SECONDS"
}

vm217_run_with_mutation_budget() {
  local operation="$1"
  local command_deadline_seconds="$2"
  shift 2
  local elapsed_seconds
  local remaining_seconds
  local effective_deadline_seconds

  [[ -n "$VM217_MUTATION_BUDGET_STARTED_AT_SECONDS" ]] \
    || { echo "VM217 aggregate mutation budget was not started." >&2; return 64; }
  elapsed_seconds=$((SECONDS - VM217_MUTATION_BUDGET_STARTED_AT_SECONDS))
  remaining_seconds=$((VM217_MUTATION_BUDGET_SECONDS - elapsed_seconds))
  if (( remaining_seconds < 1 )); then
    printf 'VM217 aggregate mutation deadline exhausted before %s after %ss; remote state is unknown. Keep rollback eligibility armed, verify VM217 release state, and do not retry the mutation blindly.\n' \
      "$operation" "$VM217_MUTATION_BUDGET_SECONDS" >&2
    return 124
  fi
  effective_deadline_seconds="$command_deadline_seconds"
  if (( effective_deadline_seconds > remaining_seconds )); then
    effective_deadline_seconds="$remaining_seconds"
  fi
  vm217_run_with_deadline "$operation" "$effective_deadline_seconds" "$@"
}

vm217_run_ssh() {
  local operation="$1"
  shift
  if [[ -n "$VM217_MUTATION_BUDGET_STARTED_AT_SECONDS" ]]; then
    vm217_run_with_mutation_budget "$operation" "$VM217_SSH_COMMAND_TIMEOUT_SECONDS" ssh "$@"
  else
    vm217_run_with_deadline "$operation" "$VM217_SSH_COMMAND_TIMEOUT_SECONDS" ssh "$@"
  fi
}

vm217_run_scp() {
  local operation="$1"
  shift
  if [[ -n "$VM217_MUTATION_BUDGET_STARTED_AT_SECONDS" ]]; then
    vm217_run_with_mutation_budget "$operation" "$VM217_SCP_COMMAND_TIMEOUT_SECONDS" scp "$@"
  else
    vm217_run_with_deadline "$operation" "$VM217_SCP_COMMAND_TIMEOUT_SECONDS" scp "$@"
  fi
}

vm217_run_cleanup_ssh() {
  local operation="$1"
  shift
  vm217_run_with_deadline "$operation" "$VM217_SSH_CLEANUP_TIMEOUT_SECONDS" ssh "$@"
}

vm217_run_reconcile_ssh() {
  local operation="$1"
  shift
  vm217_run_with_deadline "$operation" "$VM217_SSH_RECONCILE_TIMEOUT_SECONDS" ssh "$@"
}

vm217_reconcile_release_state() {
  local operation="$1"
  local production_root="$2"
  local expected_primary="$3"
  local expected_secondary="$4"
  local expected_previous="$5"
  local expected_primary_runtime_sha256="$6"
  local active_runtime_pointer="$7"
  local backup_release_env="$8"
  local compose_project="$9"
  local production_web_url_b64="${10}"
  local legacy_marker_b64="${11}"
  shift 11

  vm217_run_reconcile_ssh "$operation" "$@" bash -s -- \
    "$production_root" \
    "$expected_primary" \
    "$expected_secondary" \
    "$expected_previous" \
    "$expected_primary_runtime_sha256" \
    "$active_runtime_pointer" \
    "$backup_release_env" \
    "$compose_project" \
    "$production_web_url_b64" \
    "$legacy_marker_b64" <<'REMOTE_RECONCILIATION'
set -euo pipefail

fail() {
  echo "$1" >&2
  exit 1
}

production_root="$1"
expected_primary="$2"
expected_secondary="$3"
expected_previous="$4"
expected_primary_runtime_sha256="$5"
active_runtime_pointer="$6"
backup_release_env="$7"
compose_project="$8"
production_web_url="$(printf '%s' "$9" | base64 --decode)" \
  || fail "VM217 reconciliation web URL is not valid base64."
legacy_marker=""
if [[ "${10}" != "-" ]]; then
  legacy_marker="$(printf '%s' "${10}" | base64 --decode)" \
    || fail "VM217 reconciliation legacy marker is not valid base64."
fi

for command_name in awk base64 basename curl date docker grep mktemp python3 readlink rm sha256sum stat systemctl tr; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "$command_name is required for VM217 read-only reconciliation."
done
[[ "$production_root" == /* && -d "$production_root" && ! -L "$production_root" ]] \
  || fail "VM217 reconciliation production root is invalid."
[[ "$expected_primary" =~ ^[a-f0-9]{40}$ || "$expected_primary" == "legacy" ]] \
  || fail "VM217 reconciliation primary state is invalid."
[[ "$expected_secondary" == "-" || "$expected_secondary" == "legacy" || "$expected_secondary" =~ ^[a-f0-9]{40}$ ]] \
  || fail "VM217 reconciliation secondary state is invalid."
[[ "$expected_secondary" == "-" || "$expected_secondary" != "$expected_primary" ]] \
  || fail "VM217 reconciliation expected states must be distinct."
[[ "$expected_previous" == "-" || "$expected_previous" =~ ^[a-f0-9]{40}$ ]] \
  || fail "VM217 reconciliation previous release expectation is invalid."
[[ "$expected_primary_runtime_sha256" == "-" || "$expected_primary_runtime_sha256" =~ ^[a-f0-9]{64}$ ]] \
  || fail "VM217 reconciliation runtime digest expectation is invalid."
[[ "$active_runtime_pointer" == /* && "$(basename "$active_runtime_pointer")" == "current" ]] \
  || fail "VM217 reconciliation active runtime pointer is invalid."
[[ "$backup_release_env" == /* ]] \
  || fail "VM217 reconciliation backup release environment path is invalid."
[[ "$compose_project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] \
  || fail "VM217 reconciliation Compose project is invalid."
[[ "$production_web_url" == https://* && "$production_web_url" != *$'\n'* && "$production_web_url" != *$'\r'* ]] \
  || fail "VM217 reconciliation requires a single-line HTTPS public web URL."

headers="$(mktemp)"
body="$(mktemp)"
trap 'rm -f -- "$headers" "$body"' EXIT
code="$(curl --silent --show-error \
  --connect-timeout 10 \
  --max-time 30 \
  --header 'Cache-Control: no-cache' \
  --dump-header "$headers" \
  --output "$body" \
  --write-out '%{http_code}' \
  "${production_web_url%/}/?lunchlineup_reconcile=$(date +%s)")" \
  || fail "VM217 reconciliation could not read public traffic."
[[ "$code" == "200" ]] || fail "VM217 reconciliation public traffic did not return HTTP 200."
traffic_release="$(awk 'tolower($0) ~ /^x-lunchlineup-release:/ { value=$0; sub(/\r$/, "", value); sub(/^[^:]+:[[:space:]]*/, "", value) } END { print value }' "$headers")"

active_pointer="$production_root/current"
if [[ -L "$active_pointer" ]]; then
  active_target="$(readlink -f -- "$active_pointer")" \
    || fail "VM217 reconciliation found a dangling active release pointer."
  active_sha="$(basename "$active_target")"
  [[ "$active_sha" =~ ^[a-f0-9]{40}$ && "$active_target" == "$production_root/releases/$active_sha" \
    && -d "$active_target" && ! -L "$active_target" ]] \
    || fail "VM217 reconciliation active pointer is not an exact retained release."
  [[ "$active_sha" == "$expected_primary" || "$active_sha" == "$expected_secondary" ]] \
    || fail "VM217 reconciliation active release is outside the exact expected candidate/baseline set."
  exact_state="secondary"
  [[ "$active_sha" == "$expected_primary" ]] && exact_state="primary"
  marker="$active_target/DEPLOYED_GIT_SHA"
  [[ -f "$marker" && ! -L "$marker" && "$(tr -d '\r\n' < "$marker")" == "$active_sha" ]] \
    || fail "VM217 reconciliation active release marker is missing or stale."
  compose_config="$active_target/docker-compose.yml"
  [[ -f "$compose_config" && ! -L "$compose_config" ]] \
    || fail "VM217 reconciliation active release is missing its Compose owner file."

  if [[ "$active_sha" == "$expected_primary" && "$expected_previous" != "-" ]]; then
    previous_pointer="$production_root/previous"
    [[ -L "$previous_pointer" ]] \
      || fail "VM217 reconciliation previous release pointer is missing."
    previous_target="$(readlink -f -- "$previous_pointer")" \
      || fail "VM217 reconciliation previous release pointer is dangling."
    [[ "$previous_target" == "$production_root/releases/$expected_previous" \
      && -d "$previous_target" && ! -L "$previous_target" ]] \
      || fail "VM217 reconciliation previous release pointer does not preserve the exact pre-rollback release."
    [[ -f "$previous_target/DEPLOYED_GIT_SHA" && ! -L "$previous_target/DEPLOYED_GIT_SHA" \
      && "$(tr -d '\r\n' < "$previous_target/DEPLOYED_GIT_SHA")" == "$expected_previous" ]] \
      || fail "VM217 reconciliation previous release marker is missing or stale."
  fi

  [[ -L "$active_runtime_pointer" ]] \
    || fail "VM217 reconciliation active runtime environment pointer is missing."
  runtime_target="$(readlink -f -- "$active_runtime_pointer")" \
    || fail "VM217 reconciliation active runtime environment pointer is dangling."
  runtime_store_root="$(dirname "$active_runtime_pointer")"
  runtime_relative="${runtime_target#"$runtime_store_root/by-release/"}"
  IFS='/' read -r runtime_release_sha runtime_sha256 runtime_leaf runtime_extra <<< "$runtime_relative"
  [[ "$runtime_relative" != "$runtime_target" \
    && "$runtime_release_sha" == "$active_sha" \
    && "$runtime_sha256" =~ ^[a-f0-9]{64}$ \
    && "$runtime_leaf" == "runtime.env" \
    && -z "$runtime_extra" \
    && -f "$runtime_target" \
    && ! -L "$runtime_target" ]] \
    || fail "VM217 reconciliation active runtime environment is not exact release/digest-owned state."
  runtime_metadata="$(stat -c '%u:%g:%a' -- "$runtime_target")" \
    || fail "VM217 reconciliation could not inspect active runtime environment metadata."
  IFS=':' read -r runtime_uid runtime_gid runtime_mode <<< "$runtime_metadata"
  [[ "$runtime_uid" == "0" && "$runtime_gid" =~ ^[1-9][0-9]*$ && "$runtime_mode" == "640" ]] \
    || fail "VM217 reconciliation active runtime environment ownership or mode is unsafe."
  [[ "$(sha256sum -- "$runtime_target" | awk '{print tolower($1)}')" == "$runtime_sha256" ]] \
    || fail "VM217 reconciliation active runtime environment digest is stale."
  if [[ "$active_sha" == "$expected_primary" && "$expected_primary_runtime_sha256" != "-" ]]; then
    [[ "$runtime_sha256" == "$expected_primary_runtime_sha256" ]] \
      || fail "VM217 reconciliation active runtime environment does not match the expected release bytes."
  fi

  [[ -f "$backup_release_env" && ! -L "$backup_release_env" ]] \
    || fail "VM217 reconciliation backup release environment is missing."
  [[ "$(stat -c '%u:%g:%a' -- "$backup_release_env")" == "0:0:640" ]] \
    || fail "VM217 reconciliation backup release environment ownership or mode is unsafe."
  mapfile -t backup_lines < "$backup_release_env"
  (( ${#backup_lines[@]} == 5 )) \
    || fail "VM217 reconciliation backup release environment must contain exactly five owned assignments."
  [[ "${backup_lines[0]}" == IMAGE_PREFIX=* && -n "${backup_lines[0]#IMAGE_PREFIX=}" \
    && "${backup_lines[1]}" == "IMAGE_TAG=$active_sha" \
    && "${backup_lines[2]}" == "COMPOSE_PROJECT_NAME=$compose_project" \
    && "${backup_lines[3]}" == "COMPOSE_SERVICE_ENV_FILE=$runtime_target" \
    && "${backup_lines[4]}" == "PRODUCTION_RUNTIME_ENV_SHA256=$runtime_sha256" ]] \
    || fail "VM217 reconciliation backup release environment is not exact active release/runtime ownership."
  image_prefix="${backup_lines[0]#IMAGE_PREFIX=}"
  [[ "$image_prefix" =~ ^[A-Za-z0-9._/:@-]+$ ]] \
    || fail "VM217 reconciliation backup image prefix is invalid."
  for timer in lunchlineup-backup.timer lunchlineup-pitr-base-backup.timer; do
    systemctl is-enabled --quiet "$timer" \
      || fail "VM217 reconciliation required backup timer is not enabled: $timer"
    systemctl is-active --quiet "$timer" \
      || fail "VM217 reconciliation required backup timer is not active: $timer"
  done

  compose_json="$(mktemp)"
  expectations="$(mktemp)"
  trap 'rm -f -- "$headers" "$body" "$compose_json" "$expectations"' EXIT
  IMAGE_PREFIX="$image_prefix" \
    IMAGE_TAG="$active_sha" \
    COMPOSE_PROJECT_NAME="$compose_project" \
    COMPOSE_FILE="$compose_config" \
    COMPOSE_PROFILES="" \
    COMPOSE_SERVICE_ENV_FILE="$runtime_target" \
    docker compose \
      --project-name "$compose_project" \
      --project-directory "$active_target" \
      --env-file "$runtime_target" \
      -f "$compose_config" \
      config --format json > "$compose_json" \
    || fail "VM217 reconciliation could not resolve the active Compose service contract."
  python3 - "$compose_json" "$active_sha" > "$expectations" <<'PY'
import json
import re
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    config = json.load(handle)
active_sha = sys.argv[2]
services = config.get("services")
if not isinstance(services, dict) or not services:
    raise SystemExit("VM217 reconciliation Compose contract has no services.")

for name, service in sorted(services.items()):
    if not isinstance(service, dict) or service.get("profiles"):
        continue
    image = service.get("image")
    if not isinstance(image, str) or not image or "|" in image or "\n" in image:
        raise SystemExit(f"VM217 reconciliation service {name} has no exact image identity.")
    if not re.search(r"@sha256:[a-f0-9]{64}$", image, re.IGNORECASE) and not image.endswith(f":{active_sha}"):
        raise SystemExit(f"VM217 reconciliation service {name} image is neither fixed-digest nor release-SHA owned: {image}")
    health = service.get("healthcheck")
    has_health = isinstance(health, dict) and not health.get("disable") and health.get("test") not in (None, [], ["NONE"])
    restart = str(service.get("restart", "")).lower()
    mode = "completed" if restart == "no" else "healthy" if has_health else "running"
    print(f"{name}|{mode}|{image}")
PY
  [[ -s "$expectations" ]] \
    || fail "VM217 reconciliation Compose contract resolved no required production services."

  expected_service_count=0
  while IFS='|' read -r service expected_mode expected_image; do
    expected_image="${expected_image%$'\r'}"
    [[ -n "$service" && -n "$expected_mode" && -n "$expected_image" ]] \
      || fail "VM217 reconciliation resolved an invalid service expectation."
    expected_service_count=$((expected_service_count + 1))
    service_containers=0
    service_matches=0
    inspection="missing"
    while IFS= read -r container_id; do
      [[ -n "$container_id" ]] || continue
      service_containers=$((service_containers + 1))
      inspection="$(docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.State.ExitCode}}|{{.Label "com.docker.compose.project.working_dir"}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.project.config_files"}}|{{.Config.Image}}' "$container_id")" \
        || fail "VM217 reconciliation could not inspect the $service container."
      IFS='|' read -r state health exit_code working_dir project config_files image <<< "$inspection"
      resolved_working_dir="$(readlink -f -- "$working_dir" 2>/dev/null || true)"
      resolved_config_file="$(readlink -f -- "$config_files" 2>/dev/null || true)"
      state_matches=false
      case "$expected_mode" in
        healthy) [[ "$state" == "running" && "$health" == "healthy" ]] && state_matches=true ;;
        running) [[ "$state" == "running" && "$health" == "none" ]] && state_matches=true ;;
        completed) [[ "$state" == "exited" && "$health" == "none" && "$exit_code" == "0" ]] && state_matches=true ;;
        *) fail "VM217 reconciliation resolved an unsupported service health contract." ;;
      esac
      if [[ "$state_matches" == "true" \
        && "$resolved_working_dir" == "$active_target" \
        && "$project" == "$compose_project" \
        && "$resolved_config_file" == "$compose_config" \
        && "$image" == "$expected_image" ]]; then
        service_matches=$((service_matches + 1))
      fi
    done < <(docker ps --all --quiet \
      --filter "label=com.docker.compose.project=$compose_project" \
      --filter "label=com.docker.compose.service=$service")
    (( service_containers == 1 && service_matches == 1 )) \
      || fail "VM217 reconciliation did not find exactly one $expected_mode $service service with its exact active Compose image and ownership (containers=$service_containers observed=$inspection expected_image=$expected_image)."
  done < "$expectations"
  project_container_count="$(docker ps --all --quiet \
    --filter "label=com.docker.compose.project=$compose_project" | awk 'NF { count++ } END { print count + 0 }')"
  (( project_container_count == expected_service_count )) \
    || fail "VM217 reconciliation found missing, duplicate, profile-only, or mixed-release project containers."

  [[ "$traffic_release" == "$active_sha" ]] \
    || fail "VM217 reconciliation public traffic does not serve the exact active release."
  printf 'vm217_reconciliation_ok exact_state=%s active_release_sha=%s runtime_release_sha=%s runtime_sha256=%s service_release_sha=%s service_count=%s traffic_release_sha=%s timers=active legacy_traffic=false\n' \
    "$exact_state" "$active_sha" "$runtime_release_sha" "$runtime_sha256" "$active_sha" "$expected_service_count" "$traffic_release"
  exit 0
fi

[[ ! -e "$active_pointer" ]] \
  || fail "VM217 reconciliation active release pointer exists but is not a symlink."
[[ "$expected_primary" == "legacy" || "$expected_secondary" == "legacy" ]] \
  || fail "VM217 reconciliation found legacy state outside the exact expected state set."
[[ ! -e "$production_root/DEPLOYED_GIT_SHA" && ! -L "$production_root/DEPLOYED_GIT_SHA" ]] \
  || fail "VM217 reconciliation legacy state still has a v2 release marker."
[[ ! -e "$production_root/previous" && ! -L "$production_root/previous" ]] \
  || fail "VM217 reconciliation legacy state still has a v2 previous release pointer."
[[ ! -e "$active_runtime_pointer" && ! -L "$active_runtime_pointer" ]] \
  || fail "VM217 reconciliation legacy state still has an active v2 runtime environment pointer."
[[ ! -e "$backup_release_env" && ! -L "$backup_release_env" ]] \
  || fail "VM217 reconciliation legacy state still has a v2 backup release environment."
[[ -z "$(docker ps --all --filter "label=com.docker.compose.project=$compose_project" --format '{{.ID}}')" ]] \
  || fail "VM217 reconciliation legacy state still has release-owned v2 project containers."
[[ -n "$legacy_marker" ]] || fail "VM217 reconciliation requires an exact legacy traffic marker."
systemctl is-active --quiet apache2 \
  || fail "VM217 reconciliation could not prove the legacy Apache service is active."
[[ -z "$traffic_release" ]] \
  || fail "VM217 reconciliation legacy traffic unexpectedly carries a v2 release header."
grep -Fq -- "$legacy_marker" "$body" \
  || fail "VM217 reconciliation public traffic is missing the exact legacy marker."
exact_state="secondary"
[[ "$expected_primary" == "legacy" ]] && exact_state="primary"
printf 'vm217_reconciliation_ok exact_state=%s active_release_sha=legacy service_release_sha=apache2:active traffic_release_sha=legacy legacy_traffic=true\n' "$exact_state"
REMOTE_RECONCILIATION
}
