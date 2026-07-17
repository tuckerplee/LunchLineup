#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REMOTE_APP_DIR="/opt/lunchlineup"
REMOTE_ENTRYPOINT="scripts/deploy-vm217-remote.sh"
REMOTE_RUNTIME_ENV_POINTER="${VM217_REMOTE_RUNTIME_ENV_POINTER:-/var/lib/lunchlineup/runtime-env/current}"
REMOTE_BACKUP_RELEASE_ENV="${VM217_REMOTE_BACKUP_RELEASE_ENV:-/var/lib/lunchlineup/backup-release.env}"
COMPOSE_PROJECT="${COMPOSE_PROJECT_NAME:-lunchlineup}"
TRANSPORT_DEADLINES="$SCRIPT_DIR/vm217-transport-deadlines.sh"
REMOTE_STAGE=""
LOCAL_PROTECTED_CHANNEL=""
REMOTE_OPERATION_STARTED=false

HOST=""
USER_NAME=""
PRIVATE_KEY=""
KNOWN_HOSTS=""
RELEASE_MANIFEST=""
RUNTIME_ENV=""
LAUNCH_PROOF=""
SOURCE_SHA=""

usage() {
  cat <<'USAGE'
Usage: deploy-vm217-transport.sh \
  --host HOST \
  --user USER \
  --private-key FILE \
  --known-hosts FILE \
  --release-manifest FILE \
  --runtime-env FILE \
  --launch-proof FILE \
  --source-sha SHA \
  [--remote-app-dir PATH] \
  [--remote-entrypoint REPO_RELATIVE_PATH]
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
    --remote-app-dir) require_option_value "$1" "${2:-}"; REMOTE_APP_DIR="$2"; shift 2 ;;
    --remote-entrypoint) require_option_value "$1" "${2:-}"; REMOTE_ENTRYPOINT="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done

for required_name in HOST USER_NAME PRIVATE_KEY KNOWN_HOSTS RELEASE_MANIFEST RUNTIME_ENV LAUNCH_PROOF SOURCE_SHA; do
  [[ -n "${!required_name}" ]] || fail "Missing required transport option for $required_name."
done

[[ "$SOURCE_SHA" =~ ^[a-fA-F0-9]{40}$ ]] || fail "--source-sha must be a full 40-character Git SHA."
[[ "$USER_NAME" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] || fail "--user contains unsupported characters."
[[ "$HOST" =~ ^[A-Za-z0-9]([A-Za-z0-9.:-]*[A-Za-z0-9])?$ ]] || fail "--host contains unsupported characters."
[[ "$REMOTE_APP_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail "--remote-app-dir must be an absolute path with no shell metacharacters."
[[ "$REMOTE_APP_DIR" != *"//"* && "$REMOTE_APP_DIR" != *"/../"* && "$REMOTE_APP_DIR" != */.. && "$REMOTE_APP_DIR" != *"/./"* && "$REMOTE_APP_DIR" != */. ]] \
  || fail "--remote-app-dir must not contain relative or empty path segments."
[[ "$REMOTE_ENTRYPOINT" =~ ^[A-Za-z0-9._/-]+$ && "$REMOTE_ENTRYPOINT" != /* ]] \
  || fail "--remote-entrypoint must be a repository-relative path with no shell metacharacters."
[[ "$REMOTE_ENTRYPOINT" != *"//"* && "$REMOTE_ENTRYPOINT" != *"/../"* && "$REMOTE_ENTRYPOINT" != ../* && "$REMOTE_ENTRYPOINT" != */.. && "$REMOTE_ENTRYPOINT" != *"/./"* && "$REMOTE_ENTRYPOINT" != ./* && "$REMOTE_ENTRYPOINT" != */. ]] \
  || fail "--remote-entrypoint must not contain relative or empty path segments."
[[ "$COMPOSE_PROJECT" == "lunchlineup" ]] \
  || fail "COMPOSE_PROJECT_NAME must remain lunchlineup for the stable production volume identity."
[[ "${VM217_RECONCILE_ONLY:-false}" == "true" || "${VM217_RECONCILE_ONLY:-false}" == "false" ]] \
  || fail "VM217_RECONCILE_ONLY must be true or false."

for command_name in awk base64 chmod git mktemp rm scp sha256sum ssh stat timeout; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required."
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
  [[ -f "$path" && ! -L "$path" && -r "$path" && -s "$path" ]] || fail "$label must be a readable, non-empty regular file and not a symlink."
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

require_private_input "$PRIVATE_KEY" "Private key"
require_private_input "$RUNTIME_ENV" "Runtime environment"
require_readonly_input "$KNOWN_HOSTS" "Pinned known_hosts file"
require_readonly_input "$RELEASE_MANIFEST" "Release manifest"
require_readonly_input "$LAUNCH_PROOF" "Launch proof"
require_readonly_input "$TRANSPORT_DEADLINES" "VM217 transport deadline helper"

# shellcheck source=./vm217-transport-deadlines.sh
source "$TRANSPORT_DEADLINES"
vm217_validate_transport_deadlines || exit $?

awk 'NF && $1 !~ /^#/ { found=1; exit } END { exit !found }' "$KNOWN_HOSTS" \
  || fail "Pinned known_hosts file must contain at least one host key."

LOCAL_ENTRYPOINT="$REPO_ROOT/$REMOTE_ENTRYPOINT"
require_readonly_input "$LOCAL_ENTRYPOINT" "Remote deployment entrypoint"
git -C "$REPO_ROOT" ls-files --error-unmatch -- "$REMOTE_ENTRYPOINT" >/dev/null 2>&1 \
  || fail "Remote deployment entrypoint must be checked in."

sha256_file() {
  local path="$1"
  local digest
  digest="$(sha256sum -- "$path" | awk '{print $1}')"
  [[ "$digest" =~ ^[a-fA-F0-9]{64}$ ]] || fail "Could not hash a transport input."
  printf '%s' "$digest"
}

MANIFEST_SHA256="$(sha256_file "$RELEASE_MANIFEST")"
RUNTIME_ENV_SHA256="$(sha256_file "$RUNTIME_ENV")"
LAUNCH_PROOF_SHA256="$(sha256_file "$LAUNCH_PROOF")"
ENTRYPOINT_SHA256="$(sha256_file "$LOCAL_ENTRYPOINT")"

SSH_TARGET="$USER_NAME@$HOST"
SCP_TARGET="$SSH_TARGET"
if [[ "$HOST" == *:* ]]; then
  SCP_TARGET="$USER_NAME@[$HOST]"
fi

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
SCP_OPTIONS=(
  -q
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

encode_reconciliation_value() {
  local value="$1"
  [[ -n "$value" && "$value" != *$'\n'* && "$value" != *$'\r'* ]] \
    || fail "VM217 reconciliation values must be non-empty and single-line."
  printf '%s' "$value" | base64 --wrap=0
}

reconcile_vm217_deploy_state() {
  local expected_secondary="${EXPECTED_CURRENT_RELEASE_SHA:--}"
  local legacy_marker_b64="-"
  if [[ "${VM217_RECONCILIATION_ALLOW_LEGACY:-false}" == "true" ]]; then
    expected_secondary="legacy"
    legacy_marker_b64="$(encode_reconciliation_value "${VM217_LEGACY_TRAFFIC_MARKER:-Lunch Lineup}")"
  fi
  vm217_reconcile_release_state \
    "VM217 deploy state reconciliation" \
    "$REMOTE_APP_DIR" \
    "${SOURCE_SHA,,}" \
    "${expected_secondary,,}" \
    "-" \
    "${RUNTIME_ENV_SHA256,,}" \
    "$REMOTE_RUNTIME_ENV_POINTER" \
    "$REMOTE_BACKUP_RELEASE_ENV" \
    "$COMPOSE_PROJECT" \
    "$(encode_reconciliation_value "${PRODUCTION_WEB_URL:-}")" \
    "$legacy_marker_b64" \
    "${SSH_OPTIONS[@]}" "$SSH_TARGET"
}

if [[ "${VM217_RECONCILE_ONLY:-false}" == "true" ]]; then
  reconcile_vm217_deploy_state
  exit 0
fi

cleanup_remote_stage() {
  local exit_code=$?
  local cleanup_status
  trap - EXIT
  if [[ -n "$REMOTE_STAGE" ]]; then
    if vm217_run_cleanup_ssh "remote deployment staging cleanup" \
      "${SSH_OPTIONS[@]}" "$SSH_TARGET" rm -rf -- "$REMOTE_STAGE" >/dev/null; then
      :
    else
      cleanup_status=$?
      echo "Remote transport staging cleanup failed." >&2
      (( exit_code != 0 )) || exit_code="$cleanup_status"
    fi
  fi
  if [[ -n "$LOCAL_PROTECTED_CHANNEL" ]]; then
    if ! rm -f -- "$LOCAL_PROTECTED_CHANNEL"; then
      echo "Local protected transport channel cleanup failed." >&2
      (( exit_code != 0 )) || exit_code=1
    fi
  fi
  exit "$exit_code"
}

handle_transport_signal() {
  local signal_name="$1"
  local signal_exit_code="$2"
  trap '' INT TERM
  if [[ "$REMOTE_OPERATION_STARTED" == "true" ]]; then
    echo "VM217 deploy transport received $signal_name after remote operations began; attempting one bounded authenticated reconciliation before cleanup." >&2
    reconcile_vm217_deploy_state >&2 \
      || echo "VM217 deploy signal reconciliation did not prove a stable exact release/services/traffic state." >&2
  fi
  exit "$signal_exit_code"
}

trap cleanup_remote_stage EXIT
trap 'handle_transport_signal INT 130' INT
trap 'handle_transport_signal TERM 143' TERM

run_transport_mutation_step() {
  local status
  if "$@"; then
    return 0
  else
    status=$?
  fi
  echo "VM217 transport operation failed after remote operations began; reconciling exact release/services/traffic state before any next action." >&2
  reconcile_vm217_deploy_state >&2 \
    || echo "VM217 transport reconciliation did not prove a stable exact state." >&2
  return "$status"
}

if [[ "${LAUNCH_PROOF_MANIFEST_URI:-}" == *$'\n'* || "${LAUNCH_PROOF_MANIFEST_URI:-}" == *$'\r'* ]]; then
  fail "LAUNCH_PROOF_MANIFEST_URI must be a single-line value when provided."
fi
umask 077
LOCAL_PROTECTED_CHANNEL="$(mktemp "${TMPDIR:-/tmp}/lunchlineup-vm217-protected.XXXXXXXX")"
printf '%s\n' "${LAUNCH_PROOF_MANIFEST_URI:--}" > "$LOCAL_PROTECTED_CHANNEL"
chmod 600 "$LOCAL_PROTECTED_CHANNEL"
PROTECTED_CHANNEL_SHA256="$(sha256_file "$LOCAL_PROTECTED_CHANNEL")"
stage_token="${LOCAL_PROTECTED_CHANNEL##*.}"
[[ "$stage_token" =~ ^[A-Za-z0-9]+$ ]] \
  || fail "Could not derive a safe deployment transport staging token."
remote_stage_candidate="/tmp/lunchlineup-ci-transport.$stage_token"

vm217_begin_mutation_budget
REMOTE_STAGE="$remote_stage_candidate"
REMOTE_OPERATION_STARTED=true
run_transport_mutation_step vm217_run_ssh "remote deployment staging allocation" \
  "${SSH_OPTIONS[@]}" "$SSH_TARGET" mkdir -m 700 -- "$REMOTE_STAGE"

REMOTE_MANIFEST="$REMOTE_STAGE/release-manifest.json"
REMOTE_RUNTIME_ENV="$REMOTE_STAGE/runtime.env"
REMOTE_LAUNCH_PROOF="$REMOTE_STAGE/launch-proof.json"
REMOTE_PROTECTED_CHANNEL="$REMOTE_STAGE/protected-channel"
REMOTE_ENTRYPOINT_PATH="$REMOTE_APP_DIR/$REMOTE_ENTRYPOINT"

run_transport_mutation_step vm217_run_scp "release manifest upload" "${SCP_OPTIONS[@]}" -- "$RELEASE_MANIFEST" "$SCP_TARGET:$REMOTE_MANIFEST"
run_transport_mutation_step vm217_run_scp "runtime environment upload" "${SCP_OPTIONS[@]}" -- "$RUNTIME_ENV" "$SCP_TARGET:$REMOTE_RUNTIME_ENV"
run_transport_mutation_step vm217_run_scp "launch proof upload" "${SCP_OPTIONS[@]}" -- "$LAUNCH_PROOF" "$SCP_TARGET:$REMOTE_LAUNCH_PROOF"
run_transport_mutation_step vm217_run_scp "protected launch-proof channel upload" "${SCP_OPTIONS[@]}" -- "$LOCAL_PROTECTED_CHANNEL" "$SCP_TARGET:$REMOTE_PROTECTED_CHANNEL"
run_transport_mutation_step vm217_run_ssh "remote deployment staging permission hardening" \
  "${SSH_OPTIONS[@]}" "$SSH_TARGET" chmod 600 -- "$REMOTE_MANIFEST" "$REMOTE_RUNTIME_ENV" "$REMOTE_LAUNCH_PROOF" "$REMOTE_PROTECTED_CHANNEL"

remote_sha256_file() {
  local path="$1"
  local output
  local digest
  output="$(run_transport_mutation_step vm217_run_ssh "remote deployment input checksum readback" \
    "${SSH_OPTIONS[@]}" "$SSH_TARGET" sha256sum -- "$path")"
  read -r digest _ <<< "$output"
  [[ "$digest" =~ ^[a-fA-F0-9]{64}$ ]] || fail "VM217 returned an invalid SHA-256 result."
  printf '%s' "$digest"
}

[[ "$(remote_sha256_file "$REMOTE_MANIFEST")" == "$MANIFEST_SHA256" ]] || fail "Release manifest changed in transport."
[[ "$(remote_sha256_file "$REMOTE_RUNTIME_ENV")" == "$RUNTIME_ENV_SHA256" ]] || fail "Runtime environment changed in transport."
[[ "$(remote_sha256_file "$REMOTE_LAUNCH_PROOF")" == "$LAUNCH_PROOF_SHA256" ]] || fail "Launch proof changed in transport."
[[ "$(remote_sha256_file "$REMOTE_PROTECTED_CHANNEL")" == "$PROTECTED_CHANNEL_SHA256" ]] || fail "Protected launch-proof channel changed in transport."
[[ "$(remote_sha256_file "$REMOTE_ENTRYPOINT_PATH")" == "$ENTRYPOINT_SHA256" ]] || fail "Remote deployment entrypoint does not match the checked-in runner copy."

if [[ -n "${LAUNCH_PROOF_MAX_AGE_SECONDS:-}" && ! "${LAUNCH_PROOF_MAX_AGE_SECONDS}" =~ ^[1-9][0-9]*$ ]]; then
  fail "LAUNCH_PROOF_MAX_AGE_SECONDS must be a positive integer when provided."
fi
if [[ -n "${EXPECTED_CURRENT_RELEASE_SHA:-}" && ! "${EXPECTED_CURRENT_RELEASE_SHA}" =~ ^[a-fA-F0-9]{40}$ ]]; then
  fail "EXPECTED_CURRENT_RELEASE_SHA must be a full 40-character Git SHA when provided."
fi

encode_optional_env() {
  local name="$1"
  local value
  value="${!name:-}"
  if [[ -z "$value" ]]; then
    printf '-'
    return
  fi
  printf '%s' "$value" | base64 --wrap=0
}

PRODUCTION_API_HEALTH_URL_B64="$(encode_optional_env PRODUCTION_API_HEALTH_URL)"
PRODUCTION_WEB_URL_B64="$(encode_optional_env PRODUCTION_WEB_URL)"
REMOTE_MAX_PROOF_AGE="${LAUNCH_PROOF_MAX_AGE_SECONDS:--}"
REMOTE_EXPECTED_CURRENT_RELEASE_SHA="${EXPECTED_CURRENT_RELEASE_SHA:--}"

deploy_status=0
if run_transport_mutation_step vm217_run_ssh "remote production deployment" "${SSH_OPTIONS[@]}" "$SSH_TARGET" \
  bash -s -- \
  "$PRODUCTION_API_HEALTH_URL_B64" \
  "$PRODUCTION_WEB_URL_B64" \
  "$REMOTE_PROTECTED_CHANNEL" \
  "$PROTECTED_CHANNEL_SHA256" \
  "$REMOTE_MAX_PROOF_AGE" \
  "$REMOTE_EXPECTED_CURRENT_RELEASE_SHA" \
  "$REMOTE_APP_DIR" \
  "$SOURCE_SHA" \
  "$REMOTE_MANIFEST" \
  "$REMOTE_RUNTIME_ENV" \
  "$RUNTIME_ENV_SHA256" \
  "$REMOTE_LAUNCH_PROOF" \
  "$LAUNCH_PROOF_SHA256" \
  "$MANIFEST_SHA256" \
  "$REMOTE_ENTRYPOINT_PATH" \
  "$COMPOSE_PROJECT" <<'REMOTE_SCRIPT'
set -euo pipefail

decode_optional() {
  local encoded="$1"
  if [[ "$encoded" == "-" ]]; then
    return
  fi
  printf '%s' "$encoded" | base64 --decode
}

production_api_health_url="$(decode_optional "$1")"
production_web_url="$(decode_optional "$2")"
protected_channel="$3"
expected_protected_channel_sha256="$4"
[[ -f "$protected_channel" && ! -L "$protected_channel" && -s "$protected_channel" ]] \
  || { echo "Protected launch-proof channel is missing." >&2; exit 1; }
[[ "$(stat -c '%a' -- "$protected_channel")" == "600" ]] \
  || { echo "Protected launch-proof channel must have mode 0600." >&2; exit 1; }
[[ "$(sha256sum -- "$protected_channel" | awk '{print tolower($1)}')" == "$expected_protected_channel_sha256" ]] \
  || { echo "Protected launch-proof channel changed after readback." >&2; exit 1; }
IFS= read -r launch_proof_manifest_uri < "$protected_channel"
[[ "$launch_proof_manifest_uri" != *$'\n'* && "$launch_proof_manifest_uri" != *$'\r'* ]] \
  || { echo "Protected launch-proof URI must be single-line." >&2; exit 1; }
[[ "$launch_proof_manifest_uri" != "-" ]] || launch_proof_manifest_uri=""

production_root="$7"
source_sha="${8,,}"
transported_manifest="$9"
source_entrypoint="${15}"
compose_project="${16}"
release_root="$production_root/releases"
candidate_app="$release_root/$source_sha"
candidate_manifest="$candidate_app/.release/release-manifest.json"
candidate_entrypoint="$candidate_app/${source_entrypoint#"$production_root/"}"
incoming_release=""

cleanup_incoming_release() {
  local exit_code=$?
  trap - EXIT
  if [[ -n "$incoming_release" && -d "$incoming_release" && ! -L "$incoming_release" ]]; then
    rm -rf -- "$incoming_release" || exit_code=1
  fi
  exit "$exit_code"
}

[[ "$production_root" == /* && -d "$production_root" && ! -L "$production_root" ]] \
  || { echo "Production root must be an absolute non-symlink directory." >&2; exit 1; }
[[ "$source_sha" =~ ^[a-f0-9]{40}$ ]] \
  || { echo "Candidate release SHA is invalid." >&2; exit 1; }
[[ "$compose_project" == "lunchlineup" ]] \
  || { echo "Production Compose project must remain lunchlineup." >&2; exit 1; }
mkdir -p -- "$release_root"
[[ -d "$release_root" && ! -L "$release_root" ]] \
  || { echo "Durable release root must be a non-symlink directory." >&2; exit 1; }
[[ "$(stat -c '%d' -- "$production_root")" == "$(stat -c '%d' -- "$release_root")" ]] \
  || { echo "Durable release root must share the production root filesystem." >&2; exit 1; }

if [[ -e "$candidate_app" || -L "$candidate_app" ]]; then
  [[ -d "$candidate_app" && ! -L "$candidate_app" ]] \
    || { echo "Candidate retained release path is unsafe." >&2; exit 1; }
else
  incoming_release="$release_root/.incoming-$source_sha.$$"
  mkdir -m 700 -- "$incoming_release"
  trap cleanup_incoming_release EXIT
  python3 - "$production_root" "$transported_manifest" "$incoming_release" <<'PY'
import hashlib
import json
import os
import shutil
import stat
import sys
from pathlib import Path, PurePosixPath

source_root = Path(sys.argv[1])
manifest_path = Path(sys.argv[2])
destination_root = Path(sys.argv[3])
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
files = manifest.get("deploymentContract", {}).get("files")
if not isinstance(files, dict) or not files:
    raise SystemExit("Release manifest deploymentContract.files is required for retained materialization.")

for raw_path, expected_sha in sorted(files.items()):
    relative = PurePosixPath(raw_path)
    if relative.is_absolute() or not relative.parts or any(part in ("", ".", "..") for part in relative.parts):
        raise SystemExit(f"Unsafe retained release path: {raw_path}")
    source = source_root.joinpath(*relative.parts)
    source_stat = source.lstat()
    if not stat.S_ISREG(source_stat.st_mode):
        raise SystemExit(f"Retained release source is not a regular file: {raw_path}")
    payload = source.read_bytes()
    if hashlib.sha256(payload).hexdigest() != expected_sha:
        raise SystemExit(f"Retained release source digest mismatch: {raw_path}")
    destination = destination_root.joinpath(*relative.parts)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(payload)
    destination.chmod(source_stat.st_mode & 0o755)

retained_manifest = destination_root / ".release" / "release-manifest.json"
retained_manifest.parent.mkdir(parents=True, exist_ok=True)
shutil.copyfile(manifest_path, retained_manifest)
retained_manifest.chmod(0o600)
PY
  [[ -z "$(find "$incoming_release" -mindepth 1 -type l -print -quit)" ]] \
    || { echo "Candidate retained release contains a symlink." >&2; exit 1; }
  [[ -z "$(find "$incoming_release" -type f \( -name .env -o -name runtime.env -o -name runtime-secret.json \) -print -quit)" ]] \
    || { echo "Candidate retained release contains runtime secret material." >&2; exit 1; }
  mv -T -- "$incoming_release" "$candidate_app"
  incoming_release=""
  trap - EXIT
fi

[[ -f "$candidate_manifest" && ! -L "$candidate_manifest" \
  && "$(sha256sum -- "$candidate_manifest" | awk '{print tolower($1)}')" == "${14,,}" ]] \
  || { echo "Candidate retained release manifest changed during materialization." >&2; exit 1; }
[[ -f "$candidate_entrypoint" && ! -L "$candidate_entrypoint" \
  && "$(sha256sum -- "$candidate_entrypoint" | awk '{print tolower($1)}')" == "$(sha256sum -- "$source_entrypoint" | awk '{print tolower($1)}')" ]] \
  || { echo "Candidate retained deployment entrypoint changed during materialization." >&2; exit 1; }

remote_env=(
  "APP_DIR=$candidate_app"
  "ACTIVE_RELEASE_POINTER=$production_root/current"
  "RELEASE_SOURCE_SHA=$source_sha"
  "RELEASE_MANIFEST_PATH=$candidate_manifest"
  "PRODUCTION_RUNTIME_ENV_PATH=${10}"
  "COMPOSE_SERVICE_ENV_FILE=${10}"
  "COMPOSE_PROJECT_NAME=$compose_project"
  "COMPOSE_PROJECT_DIRECTORY=$candidate_app"
  "COMPOSE_FILE=$candidate_app/docker-compose.yml"
  "PRODUCTION_RUNTIME_ENV_SHA256=${11}"
  "LAUNCH_PROOF_PATH=${12}"
  "LAUNCH_PROOF_ARTIFACT_SHA256=${13}"
  "TRANSPORT_RELEASE_MANIFEST_SHA256=${14}"
)
[[ -z "$production_api_health_url" ]] || remote_env+=("PRODUCTION_API_HEALTH_URL=$production_api_health_url")
[[ -z "$production_web_url" ]] || remote_env+=("PRODUCTION_WEB_URL=$production_web_url")
[[ -z "$launch_proof_manifest_uri" ]] || remote_env+=("LAUNCH_PROOF_MANIFEST_URI=$launch_proof_manifest_uri")
if [[ "$5" != "-" ]]; then
  remote_env+=("LAUNCH_PROOF_MAX_AGE_SECONDS=$5")
fi
if [[ "$6" != "-" ]]; then
  remote_env+=("EXPECTED_CURRENT_RELEASE_SHA=$6")
fi

exec env "${remote_env[@]}" bash "$candidate_entrypoint"
REMOTE_SCRIPT
then
  :
else
  deploy_status=$?
  exit "$deploy_status"
fi

echo "vm217_transport_ok sha=$SOURCE_SHA"
