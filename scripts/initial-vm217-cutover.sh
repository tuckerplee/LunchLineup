#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_TRANSPORT="$SCRIPT_DIR/deploy-vm217-transport.sh"
PROOF_VERIFIER="$SCRIPT_DIR/verify-initial-cutover-proof.mjs"
TRANSPORT_DEADLINES="$SCRIPT_DIR/vm217-transport-deadlines.sh"

HOST=""
USER_NAME=""
PRIVATE_KEY=""
KNOWN_HOSTS=""
RELEASE_MANIFEST=""
RUNTIME_ENV=""
LAUNCH_PROOF=""
SOURCE_SHA=""
SNAPSHOT_COMMAND=""
PROOF_FETCH_COMMAND=""
ROLLBACK_COMMAND=""
ROLLBACK_PROOF=""
DURABLE_PROOF_URI=""
CONFIRMATION=""
MAX_PROOF_AGE_SECONDS="900"
REMOTE_APP_DIR="/opt/lunchlineup"
REMOTE_RUNTIME_ENV_POINTER="${VM217_REMOTE_RUNTIME_ENV_POINTER:-/var/lib/lunchlineup/runtime-env/current}"
REMOTE_BACKUP_RELEASE_ENV="${VM217_REMOTE_BACKUP_RELEASE_ENV:-/var/lib/lunchlineup/backup-release.env}"
REMOTE_ENTRYPOINT=""
COMPOSE_PROJECT="${COMPOSE_PROJECT_NAME:-lunchlineup}"
PRODUCTION_WEB_URL="${PRODUCTION_WEB_URL:-}"
LEGACY_TRAFFIC_MARKER="${INITIAL_CUTOVER_LEGACY_TRAFFIC_MARKER:-Lunch Lineup}"
SNAPSHOT_TIMEOUT_SECONDS="${INITIAL_CUTOVER_SNAPSHOT_TIMEOUT_SECONDS:-300}"
PROOF_FETCH_TIMEOUT_SECONDS="${INITIAL_CUTOVER_PROOF_FETCH_TIMEOUT_SECONDS:-120}"
ROLLBACK_TIMEOUT_SECONDS="${INITIAL_CUTOVER_ROLLBACK_TIMEOUT_SECONDS:-600}"
ADAPTER_KILL_AFTER_SECONDS="${INITIAL_CUTOVER_ADAPTER_KILL_AFTER_SECONDS:-5}"

MUTATION_STARTED=false
ROLLBACK_ATTEMPTED=false
SNAPSHOT_COMMAND_SHA256=""
ROLLBACK_COMMAND_SHA256=""
ROLLBACK_PROOF_SHA256=""

usage() {
  cat <<'USAGE'
Usage: initial-vm217-cutover.sh \
  --host HOST \
  --user USER \
  --private-key FILE \
  --known-hosts FILE \
  --release-manifest FILE \
  --runtime-env FILE \
  --launch-proof FILE \
  --source-sha SHA \
  --snapshot-command EXECUTABLE \
  --proof-fetch-command EXECUTABLE \
  --rollback-command EXECUTABLE \
  --rollback-proof FILE \
  --durable-proof-uri HTTPS_OR_S3_URI \
  --confirm initial-vm217-cutover-from-legacy-php:SHA \
  [--max-proof-age-seconds N] \
  [--remote-app-dir PATH] \
  [--remote-entrypoint REPO_RELATIVE_PATH]

The external snapshot command must create a VM217 recovery snapshot and publish
its JSON attestation to the durable URI. The external proof-fetch command must
retrieve those exact retained bytes into --rollback-proof. If candidate transport
fails after mutation starts, the digest-bound external rollback command is run.
USAGE
}

fail() {
  echo "$1" >&2
  exit 1
}

require_option_value() {
  local option="$1"
  local value="${2:-}"
  [[ -n "$value" ]] || fail "$option requires a value."
}

while (( $# > 0 )); do
  case "$1" in
    --host) require_option_value "$1" "${2:-}"; HOST="$2"; shift 2 ;;
    --user) require_option_value "$1" "${2:-}"; USER_NAME="$2"; shift 2 ;;
    --private-key) require_option_value "$1" "${2:-}"; PRIVATE_KEY="$2"; shift 2 ;;
    --known-hosts) require_option_value "$1" "${2:-}"; KNOWN_HOSTS="$2"; shift 2 ;;
    --release-manifest) require_option_value "$1" "${2:-}"; RELEASE_MANIFEST="$2"; shift 2 ;;
    --runtime-env) require_option_value "$1" "${2:-}"; RUNTIME_ENV="$2"; shift 2 ;;
    --launch-proof) require_option_value "$1" "${2:-}"; LAUNCH_PROOF="$2"; shift 2 ;;
    --source-sha) require_option_value "$1" "${2:-}"; SOURCE_SHA="$2"; shift 2 ;;
    --snapshot-command) require_option_value "$1" "${2:-}"; SNAPSHOT_COMMAND="$2"; shift 2 ;;
    --proof-fetch-command) require_option_value "$1" "${2:-}"; PROOF_FETCH_COMMAND="$2"; shift 2 ;;
    --rollback-command) require_option_value "$1" "${2:-}"; ROLLBACK_COMMAND="$2"; shift 2 ;;
    --rollback-proof) require_option_value "$1" "${2:-}"; ROLLBACK_PROOF="$2"; shift 2 ;;
    --durable-proof-uri) require_option_value "$1" "${2:-}"; DURABLE_PROOF_URI="$2"; shift 2 ;;
    --confirm) require_option_value "$1" "${2:-}"; CONFIRMATION="$2"; shift 2 ;;
    --max-proof-age-seconds) require_option_value "$1" "${2:-}"; MAX_PROOF_AGE_SECONDS="$2"; shift 2 ;;
    --remote-app-dir) require_option_value "$1" "${2:-}"; REMOTE_APP_DIR="$2"; shift 2 ;;
    --remote-entrypoint) require_option_value "$1" "${2:-}"; REMOTE_ENTRYPOINT="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done

for required_name in HOST USER_NAME PRIVATE_KEY KNOWN_HOSTS RELEASE_MANIFEST RUNTIME_ENV LAUNCH_PROOF SOURCE_SHA SNAPSHOT_COMMAND PROOF_FETCH_COMMAND ROLLBACK_COMMAND ROLLBACK_PROOF DURABLE_PROOF_URI CONFIRMATION; do
  [[ -n "${!required_name}" ]] || fail "Missing required initial cutover option for $required_name."
done

[[ "$SOURCE_SHA" =~ ^[a-fA-F0-9]{40}$ ]] || fail "--source-sha must be a full 40-character Git SHA."
SOURCE_SHA="${SOURCE_SHA,,}"
[[ "$CONFIRMATION" == "initial-vm217-cutover-from-legacy-php:$SOURCE_SHA" ]] \
  || fail "--confirm must equal initial-vm217-cutover-from-legacy-php:$SOURCE_SHA."
[[ "$MAX_PROOF_AGE_SECONDS" =~ ^[1-9][0-9]*$ ]] \
  || fail "--max-proof-age-seconds must be a positive integer."
(( MAX_PROOF_AGE_SECONDS <= 86400 )) || fail "--max-proof-age-seconds must not exceed 86400."
[[ "$USER_NAME" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] || fail "--user contains unsupported characters."
[[ "$HOST" =~ ^[A-Za-z0-9]([A-Za-z0-9.:-]*[A-Za-z0-9])?$ ]] || fail "--host contains unsupported characters."
[[ "$REMOTE_APP_DIR" =~ ^/[A-Za-z0-9._/-]+$ && "$REMOTE_APP_DIR" != *"//"* && "$REMOTE_APP_DIR" != *"/../"* && "$REMOTE_APP_DIR" != */.. ]] \
  || fail "--remote-app-dir must be an absolute normalized path with no shell metacharacters."
[[ "$COMPOSE_PROJECT" == "lunchlineup" ]] \
  || fail "COMPOSE_PROJECT_NAME must remain lunchlineup for the stable production volume identity."
[[ "$PRODUCTION_WEB_URL" == https://* && "$PRODUCTION_WEB_URL" != *$'\n'* && "$PRODUCTION_WEB_URL" != *$'\r'* ]] \
  || fail "PRODUCTION_WEB_URL must be a non-empty single-line HTTPS URL for cutover reconciliation."
[[ -n "$LEGACY_TRAFFIC_MARKER" && "$LEGACY_TRAFFIC_MARKER" != *$'\n'* && "$LEGACY_TRAFFIC_MARKER" != *$'\r'* ]] \
  || fail "INITIAL_CUTOVER_LEGACY_TRAFFIC_MARKER must be non-empty and single-line."
if [[ ! "$DURABLE_PROOF_URI" =~ ^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:443)?/.+$ \
  && ! "$DURABLE_PROOF_URI" =~ ^s3://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?/.+$ ]]; then
  fail "--durable-proof-uri must identify a specific retained https:// or s3:// object."
fi
[[ "$DURABLE_PROOF_URI" != *[[:space:]]* && "$DURABLE_PROOF_URI" != *\?* && "$DURABLE_PROOF_URI" != *\#* ]] \
  || fail "--durable-proof-uri must not contain whitespace, a query, or a fragment."

for command_name in awk base64 bash chmod env node rm sha256sum ssh ssh-keygen stat timeout; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required."
done
for timeout_name in SNAPSHOT_TIMEOUT_SECONDS PROOF_FETCH_TIMEOUT_SECONDS ROLLBACK_TIMEOUT_SECONDS ADAPTER_KILL_AFTER_SECONDS; do
  timeout_value="${!timeout_name}"
  [[ "$timeout_value" =~ ^[1-9][0-9]*$ && "$timeout_value" -le 3600 ]] \
    || fail "$timeout_name must be an integer from 1 through 3600."
done

file_mode() {
  local path="$1"
  local label="$2"
  local mode
  mode="$(stat -c '%a' -- "$path" 2>/dev/null)" || fail "Could not inspect $label permissions."
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || fail "Could not validate $label permissions."
  printf '%s' "$mode"
}

require_regular_input() {
  local path="$1"
  local label="$2"
  [[ -f "$path" && ! -L "$path" && -r "$path" && -s "$path" ]] \
    || fail "$label must be a readable, non-empty regular file and not a symlink."
}

require_private_input() {
  local path="$1"
  local label="$2"
  local mode
  require_regular_input "$path" "$label"
  mode="$(file_mode "$path" "$label")"
  [[ "$mode" == "400" || "$mode" == "600" || "$mode" == "0400" || "$mode" == "0600" ]] \
    || fail "$label must have mode 0400 or 0600."
}

require_readonly_input() {
  local path="$1"
  local label="$2"
  local mode
  local mode_value
  require_regular_input "$path" "$label"
  mode="$(file_mode "$path" "$label")"
  mode_value=$((8#$mode))
  (( (mode_value & 0400) != 0 )) || fail "$label must be owner-readable."
  (( (mode_value & 0022) == 0 )) || fail "$label must not be group- or world-writable."
}

canonical_file() {
  local path="$1"
  local directory
  directory="$(cd "$(dirname "$path")" && pwd -P)" || return 1
  printf '%s/%s' "$directory" "$(basename "$path")"
}

require_external_command() {
  local path="$1"
  local label="$2"
  local canonical
  local mode
  local mode_value
  [[ -f "$path" && ! -L "$path" && -r "$path" && -x "$path" && -s "$path" ]] \
    || fail "$label must be a readable executable regular file and not a symlink."
  mode="$(file_mode "$path" "$label")"
  mode_value=$((8#$mode))
  (( (mode_value & 0100) != 0 )) || fail "$label must be owner-executable."
  (( (mode_value & 0022) == 0 )) || fail "$label must not be group- or world-writable."
  canonical="$(canonical_file "$path")" || fail "Could not resolve $label."
  case "$canonical" in
    "$REPO_ROOT"/*) fail "$label must be external to the LunchLineup repository." ;;
  esac
  printf '%s' "$canonical"
}

sha256_file() {
  local path="$1"
  local digest
  digest="$(sha256sum -- "$path" | awk '{print $1}')"
  [[ "$digest" =~ ^[a-fA-F0-9]{64}$ ]] || fail "Could not hash $path."
  printf '%s' "${digest,,}"
}

require_private_input "$PRIVATE_KEY" "Private key"
require_readonly_input "$KNOWN_HOSTS" "Pinned known_hosts file"
require_readonly_input "$RELEASE_MANIFEST" "Release manifest"
require_private_input "$RUNTIME_ENV" "Runtime environment"
require_readonly_input "$LAUNCH_PROOF" "Launch proof"
require_readonly_input "$DEPLOY_TRANSPORT" "VM217 deployment transport"
require_readonly_input "$PROOF_VERIFIER" "Initial cutover proof verifier"
require_readonly_input "$TRANSPORT_DEADLINES" "VM217 transport deadline helper"

# shellcheck source=./vm217-transport-deadlines.sh
source "$TRANSPORT_DEADLINES"
vm217_validate_transport_deadlines || exit $?

ssh-keygen -y -P '' -f "$PRIVATE_KEY" >/dev/null 2>&1 \
  || fail "Private key must be a valid unencrypted SSH private key."
ssh-keygen -l -f "$KNOWN_HOSTS" >/dev/null 2>&1 \
  || fail "Pinned known_hosts file must contain valid SSH host keys."
ssh-keygen -F "$HOST" -f "$KNOWN_HOSTS" 2>/dev/null \
  | awk 'NF && $1 !~ /^#/ { found=1; exit } END { exit !found }' \
  || fail "Pinned known_hosts file does not contain the requested VM217 host."

SNAPSHOT_COMMAND="$(require_external_command "$SNAPSHOT_COMMAND" "External snapshot command")"
PROOF_FETCH_COMMAND="$(require_external_command "$PROOF_FETCH_COMMAND" "External proof-fetch command")"
ROLLBACK_COMMAND="$(require_external_command "$ROLLBACK_COMMAND" "External rollback command")"

[[ "$ROLLBACK_PROOF" == /* ]] || fail "--rollback-proof must be an absolute runner-local path."
[[ ! -e "$ROLLBACK_PROOF" && ! -L "$ROLLBACK_PROOF" ]] \
  || fail "--rollback-proof must not exist before the durable proof is fetched."
ROLLBACK_PROOF_PARENT="$(cd "$(dirname "$ROLLBACK_PROOF")" && pwd -P)" \
  || fail "--rollback-proof parent directory must already exist."
ROLLBACK_PROOF="$ROLLBACK_PROOF_PARENT/$(basename "$ROLLBACK_PROOF")"
case "$ROLLBACK_PROOF" in
  "$REPO_ROOT"/*) fail "--rollback-proof must remain outside the LunchLineup repository." ;;
esac

SNAPSHOT_COMMAND_SHA256="$(sha256_file "$SNAPSHOT_COMMAND")"
PROOF_FETCH_COMMAND_SHA256="$(sha256_file "$PROOF_FETCH_COMMAND")"
ROLLBACK_COMMAND_SHA256="$(sha256_file "$ROLLBACK_COMMAND")"
RUNTIME_ENV_SHA256="$(sha256_file "$RUNTIME_ENV")"

SSH_TARGET="$USER_NAME@$HOST"
SSH_OPTIONS=(
  -i "$PRIVATE_KEY"
  -o BatchMode=yes
  -o PasswordAuthentication=no
  -o KbdInteractiveAuthentication=no
  -o NumberOfPasswordPrompts=0
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$KNOWN_HOSTS"
  -o "ConnectTimeout=$VM217_SSH_CONNECT_TIMEOUT_SECONDS"
  -o ConnectionAttempts=1
  -o "ServerAliveInterval=$VM217_SSH_SERVER_ALIVE_INTERVAL_SECONDS"
  -o "ServerAliveCountMax=$VM217_SSH_SERVER_ALIVE_COUNT_MAX"
  -o LogLevel=ERROR
)

reconcile_initial_cutover_state() {
  local expected_primary="$1"
  local expected_secondary="$2"
  local reconciliation_output
  local reconciliation_status=0
  reconciliation_output="$(vm217_reconcile_release_state \
    "initial cutover exact state reconciliation" \
    "$REMOTE_APP_DIR" \
    "$expected_primary" \
    "$expected_secondary" \
    "-" \
    "$([[ "$expected_primary" == "$SOURCE_SHA" ]] && printf '%s' "$RUNTIME_ENV_SHA256" || printf '-')" \
    "$REMOTE_RUNTIME_ENV_POINTER" \
    "$REMOTE_BACKUP_RELEASE_ENV" \
    "$COMPOSE_PROJECT" \
    "$(printf '%s' "$PRODUCTION_WEB_URL" | base64 --wrap=0)" \
    "$(printf '%s' "$LEGACY_TRAFFIC_MARKER" | base64 --wrap=0)" \
    "${SSH_OPTIONS[@]}" "$SSH_TARGET")" || reconciliation_status=$?
  (( reconciliation_status == 0 )) || return "$reconciliation_status"
  printf '%s\n' "$reconciliation_output"
  [[ "$reconciliation_output" == vm217_reconciliation_ok\ exact_state=primary\ * ]] \
    || { echo "Initial cutover reconciliation found the secondary or another non-target state." >&2; return 1; }
}

if vm217_run_ssh "initial cutover remote preflight" \
  "${SSH_OPTIONS[@]}" "$SSH_TARGET" bash -s -- initial-vm217-cutover-preflight "$REMOTE_APP_DIR" <<'REMOTE_PREFLIGHT'
set -euo pipefail

[[ "$1" == "initial-vm217-cutover-preflight" ]] || exit 64
deployed_sha_path="$2/DEPLOYED_GIT_SHA"
current_pointer="$2/current"
if [[ -e "$deployed_sha_path" || -L "$deployed_sha_path" || -e "$current_pointer" || -L "$current_pointer" ]]; then
  exit 42
fi
REMOTE_PREFLIGHT
then
  :
else
  preflight_status=$?
  if (( preflight_status == 124 )); then
    exit "$preflight_status"
  fi
  fail "Initial cutover requires VM217 to have no existing DEPLOYED_GIT_SHA; use the strict retained release-registry deploy path after v2 has succeeded."
fi

COMMON_RECOVERY_ENV=(
  "INITIAL_CUTOVER_HOST=$HOST"
  "INITIAL_CUTOVER_VM_ID=217"
  "INITIAL_CUTOVER_LEGACY_SYSTEM=php"
  "INITIAL_CUTOVER_SOURCE_SHA=$SOURCE_SHA"
  "INITIAL_CUTOVER_DURABLE_PROOF_URI=$DURABLE_PROOF_URI"
  "INITIAL_CUTOVER_SNAPSHOT_COMMAND_SHA256=$SNAPSHOT_COMMAND_SHA256"
  "INITIAL_CUTOVER_PROOF_FETCH_COMMAND_SHA256=$PROOF_FETCH_COMMAND_SHA256"
  "INITIAL_CUTOVER_ROLLBACK_COMMAND_SHA256=$ROLLBACK_COMMAND_SHA256"
  "INITIAL_CUTOVER_PRIVATE_KEY=$PRIVATE_KEY"
  "INITIAL_CUTOVER_KNOWN_HOSTS=$KNOWN_HOSTS"
  "INITIAL_CUTOVER_SSH_STRICT_HOST_KEY_CHECKING=yes"
)

run_bounded_adapter() {
  local label="$1"
  local seconds="$2"
  shift 2
  local status=0
  timeout --foreground --signal=TERM --kill-after="${ADAPTER_KILL_AFTER_SECONDS}s" "${seconds}s" "$@" >/dev/null \
    || status=$?
  (( status != 0 )) || return 0
  if (( status == 124 || status == 137 )); then
    echo "$label timed out after ${seconds}s; adapter state is unknown and requires independent readback reconciliation." >&2
  fi
  return "$status"
}

snapshot_status=0
if run_bounded_adapter "External snapshot command" "$SNAPSHOT_TIMEOUT_SECONDS" \
  env "${COMMON_RECOVERY_ENV[@]}" "$SNAPSHOT_COMMAND"; then
  :
else
  snapshot_status=$?
  if (( snapshot_status != 124 && snapshot_status != 137 )); then
    fail "External snapshot command failed before VM217 mutation."
  fi
fi
[[ ! -e "$ROLLBACK_PROOF" && ! -L "$ROLLBACK_PROOF" ]] \
  || fail "External snapshot command must not create the runner-local rollback proof."

fetch_status=0
for fetch_attempt in 1 2; do
  rm -f -- "$ROLLBACK_PROOF"
  if run_bounded_adapter "External durable proof fetch" "$PROOF_FETCH_TIMEOUT_SECONDS" \
    env "${COMMON_RECOVERY_ENV[@]}" "INITIAL_CUTOVER_PROOF_FILE=$ROLLBACK_PROOF" "$PROOF_FETCH_COMMAND"; then
    fetch_status=0
    break
  else
    fetch_status=$?
  fi
  rm -f -- "$ROLLBACK_PROOF"
  if (( fetch_status != 124 && fetch_status != 137 )); then
    break
  fi
done
(( fetch_status == 0 )) \
  || fail "External durable proof fetch failed or remained unknown after one bounded retry; no VM217 mutation was attempted."
require_private_input "$ROLLBACK_PROOF" "Fetched durable rollback proof"

node "$PROOF_VERIFIER" \
  --proof-file "$ROLLBACK_PROOF" \
  --expected-host "$HOST" \
  --expected-source-sha "$SOURCE_SHA" \
  --expected-proof-uri "$DURABLE_PROOF_URI" \
  --expected-snapshot-command-sha256 "$SNAPSHOT_COMMAND_SHA256" \
  --expected-proof-fetch-command-sha256 "$PROOF_FETCH_COMMAND_SHA256" \
  --expected-rollback-command-sha256 "$ROLLBACK_COMMAND_SHA256" \
  --max-age-seconds "$MAX_PROOF_AGE_SECONDS"

if (( snapshot_status == 124 || snapshot_status == 137 )); then
  echo "initial_cutover_snapshot_unknown_state_reconciled proof=$DURABLE_PROOF_URI" >&2
fi

ROLLBACK_PROOF_SHA256="$(sha256_file "$ROLLBACK_PROOF")"

verify_recovery_inputs_unchanged() {
  [[ "$(sha256_file "$SNAPSHOT_COMMAND")" == "$SNAPSHOT_COMMAND_SHA256" ]] \
    || fail "External snapshot command changed after proof verification."
  [[ "$(sha256_file "$PROOF_FETCH_COMMAND")" == "$PROOF_FETCH_COMMAND_SHA256" ]] \
    || fail "External proof-fetch command changed after proof verification."
  [[ "$(sha256_file "$ROLLBACK_COMMAND")" == "$ROLLBACK_COMMAND_SHA256" ]] \
    || fail "External rollback command changed after proof verification."
  [[ "$(sha256_file "$ROLLBACK_PROOF")" == "$ROLLBACK_PROOF_SHA256" ]] \
    || fail "Fetched rollback proof changed after verification."
}

run_external_rollback() {
  local reason="$1"
  local deploy_status="$2"

  if [[ "$ROLLBACK_ATTEMPTED" == "true" ]]; then
    echo "External rollback was already attempted; manual recovery is required." >&2
    return 70
  fi
  ROLLBACK_ATTEMPTED=true
  MUTATION_STARTED=false

  if [[ "$(sha256_file "$ROLLBACK_COMMAND")" != "$ROLLBACK_COMMAND_SHA256" ]]; then
    echo "External rollback command changed after mutation; refusing unknown code and requiring manual recovery." >&2
    return 70
  fi

  local rollback_status=0
  if run_bounded_adapter "External rollback command" "$ROLLBACK_TIMEOUT_SECONDS" env "${COMMON_RECOVERY_ENV[@]}" \
    "INITIAL_CUTOVER_PROOF_FILE=$ROLLBACK_PROOF" \
    "INITIAL_CUTOVER_PROOF_SHA256=$ROLLBACK_PROOF_SHA256" \
    "INITIAL_CUTOVER_FAILURE_REASON=$reason" \
    "INITIAL_CUTOVER_DEPLOY_EXIT_CODE=$deploy_status" \
    "$ROLLBACK_COMMAND" >/dev/null; then
    :
  else
    rollback_status=$?
  fi

  if reconcile_initial_cutover_state legacy -; then
    if (( rollback_status == 0 )); then
      echo "initial_vm217_cutover_external_rollback_ok source_sha=$SOURCE_SHA state=exact-legacy" >&2
    else
      echo "initial_vm217_cutover_external_rollback_reconciled source_sha=$SOURCE_SHA" >&2
    fi
    return 0
  fi

  if (( rollback_status == 0 )); then
    echo "External rollback reported success but exact legacy state was not active; treating the rollback as a no-op and requiring manual recovery." >&2
  elif (( rollback_status == 124 || rollback_status == 137 )); then
    echo "External rollback timed out and legacy-state readback could not prove completion; manual recovery is required." >&2
  else
    echo "External rollback failed and legacy-state readback could not prove completion; manual recovery from $DURABLE_PROOF_URI is required." >&2
  fi
  return 70
}

handle_signal() {
  local signal_status="$1"
  trap - INT TERM
  if [[ "$MUTATION_STARTED" == "true" ]]; then
    run_external_rollback signal "$signal_status" || signal_status=70
  fi
  exit "$signal_status"
}

trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM

verify_recovery_inputs_unchanged

TRANSPORT_ARGS=(
  --host "$HOST"
  --user "$USER_NAME"
  --private-key "$PRIVATE_KEY"
  --known-hosts "$KNOWN_HOSTS"
  --release-manifest "$RELEASE_MANIFEST"
  --runtime-env "$RUNTIME_ENV"
  --launch-proof "$LAUNCH_PROOF"
  --source-sha "$SOURCE_SHA"
  --remote-app-dir "$REMOTE_APP_DIR"
)
[[ -z "$REMOTE_ENTRYPOINT" ]] || TRANSPORT_ARGS+=(--remote-entrypoint "$REMOTE_ENTRYPOINT")

MUTATION_STARTED=true
if VM217_RECONCILIATION_ALLOW_LEGACY=true \
  VM217_LEGACY_TRAFFIC_MARKER="$LEGACY_TRAFFIC_MARKER" \
  bash "$DEPLOY_TRANSPORT" "${TRANSPORT_ARGS[@]}"; then
  if reconcile_initial_cutover_state "$SOURCE_SHA" legacy; then
    MUTATION_STARTED=false
  else
    run_external_rollback deploy-success-reconciliation-failed 0 || true
    exit 70
  fi
else
  deploy_status=$?
  if run_external_rollback deploy-transport-failed "$deploy_status"; then
    exit "$deploy_status"
  fi
  exit 70
fi

echo "initial_vm217_cutover_ok source_sha=$SOURCE_SHA rollback_proof_sha256=$ROLLBACK_PROOF_SHA256"
