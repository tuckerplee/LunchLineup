#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REMOTE_APP_DIR="/opt/lunchlineup"
REMOTE_ENTRYPOINT="scripts/deploy-vm217-remote.sh"
REMOTE_RUNTIME_ENV_POINTER="${VM217_REMOTE_RUNTIME_ENV_POINTER:-/var/lib/lunchlineup/runtime-env/current}"
REMOTE_BACKUP_RELEASE_ENV="${VM217_REMOTE_BACKUP_RELEASE_ENV:-/var/lib/lunchlineup/backup-release.env}"
COMPOSE_PROJECT="lunchlineup"
ACTIVATOR="$SCRIPT_DIR/activate-retained-rollback.sh"
TRANSPORT_DEADLINES="$SCRIPT_DIR/vm217-transport-deadlines.sh"
REMOTE_STAGE=""
LOCAL_ARCHIVE=""
LOCAL_PROTECTED_CHANNEL=""
REMOTE_MUTATION_STARTED=false

HOST=""
USER_NAME=""
PRIVATE_KEY=""
KNOWN_HOSTS=""
ROLLBACK_APP_DIR=""
RELEASE_MANIFEST=""
RUNTIME_ENV=""
RUNTIME_SECRET_DESCRIPTOR=""
LAUNCH_PROOF=""
SOURCE_SHA=""
OLD_RELEASE_COMPATIBILITY_PROOF="${OLD_RELEASE_COMPATIBILITY_PROOF_PATH:-}"
OLD_RELEASE_COMPATIBILITY_SIGNATURE_BUNDLE="${OLD_RELEASE_COMPATIBILITY_SIGNATURE_BUNDLE_PATH:-}"
OLD_RELEASE_COMPATIBILITY_PROOF_SHA256="${OLD_RELEASE_COMPATIBILITY_PROOF_SHA256:-}"
COMPATIBILITY_CANDIDATE_SOURCE_SHA="${ROLLBACK_CANDIDATE_SOURCE_SHA:-}"
EXPECTED_CERTIFICATE_IDENTITY="${RELEASE_BUNDLE_CERTIFICATE_IDENTITY:-}"
EXPECTED_OIDC_ISSUER="${RELEASE_BUNDLE_OIDC_ISSUER:-}"

usage() {
  cat <<'USAGE'
Usage: rollback-vm217-transport.sh \
  --host HOST \
  --user USER \
  --private-key FILE \
  --known-hosts FILE \
  --rollback-app-dir DIR \
  --release-manifest FILE \
  --runtime-env FILE \
  --runtime-secret-descriptor FILE \
  --launch-proof FILE \
  --source-sha SHA \
  --old-release-compatibility-proof FILE \
  --old-release-compatibility-signature-bundle FILE \
  --old-release-compatibility-proof-sha256 SHA256 \
  --compatibility-candidate-source-sha SHA \
  --expected-certificate-identity IDENTITY \
  --expected-oidc-issuer ISSUER \
  [--remote-app-dir PATH] \
  [--remote-entrypoint REPO_RELATIVE_PATH] \
  [--compose-project NAME]

Required environment:
  PRODUCTION_API_HEALTH_URL
  PRODUCTION_WEB_URL
  LAUNCH_PROOF_MANIFEST_URI

Optional environment:
  LAUNCH_PROOF_MAX_AGE_SECONDS (default: 86400)
  ROLLBACK_RELEASE_RETENTION_COUNT (default: 3; range: 3-20)
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
    --rollback-app-dir) require_option_value "$1" "${2:-}"; ROLLBACK_APP_DIR="$2"; shift 2 ;;
    --release-manifest) require_option_value "$1" "${2:-}"; RELEASE_MANIFEST="$2"; shift 2 ;;
    --runtime-env) require_option_value "$1" "${2:-}"; RUNTIME_ENV="$2"; shift 2 ;;
    --runtime-secret-descriptor) require_option_value "$1" "${2:-}"; RUNTIME_SECRET_DESCRIPTOR="$2"; shift 2 ;;
    --launch-proof) require_option_value "$1" "${2:-}"; LAUNCH_PROOF="$2"; shift 2 ;;
    --source-sha) require_option_value "$1" "${2:-}"; SOURCE_SHA="$2"; shift 2 ;;
    --old-release-compatibility-proof) require_option_value "$1" "${2:-}"; OLD_RELEASE_COMPATIBILITY_PROOF="$2"; shift 2 ;;
    --old-release-compatibility-signature-bundle) require_option_value "$1" "${2:-}"; OLD_RELEASE_COMPATIBILITY_SIGNATURE_BUNDLE="$2"; shift 2 ;;
    --old-release-compatibility-proof-sha256) require_option_value "$1" "${2:-}"; OLD_RELEASE_COMPATIBILITY_PROOF_SHA256="$2"; shift 2 ;;
    --compatibility-candidate-source-sha) require_option_value "$1" "${2:-}"; COMPATIBILITY_CANDIDATE_SOURCE_SHA="$2"; shift 2 ;;
    --expected-certificate-identity) require_option_value "$1" "${2:-}"; EXPECTED_CERTIFICATE_IDENTITY="$2"; shift 2 ;;
    --expected-oidc-issuer) require_option_value "$1" "${2:-}"; EXPECTED_OIDC_ISSUER="$2"; shift 2 ;;
    --remote-app-dir) require_option_value "$1" "${2:-}"; REMOTE_APP_DIR="$2"; shift 2 ;;
    --remote-entrypoint) require_option_value "$1" "${2:-}"; REMOTE_ENTRYPOINT="$2"; shift 2 ;;
    --compose-project) require_option_value "$1" "${2:-}"; COMPOSE_PROJECT="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done

if [[ -n "$SOURCE_SHA" && ! "$SOURCE_SHA" =~ ^[a-fA-F0-9]{40}$ ]]; then
  fail "--source-sha must be a full 40-character Git SHA."
fi
for required_name in HOST USER_NAME PRIVATE_KEY KNOWN_HOSTS ROLLBACK_APP_DIR RELEASE_MANIFEST RUNTIME_ENV RUNTIME_SECRET_DESCRIPTOR LAUNCH_PROOF SOURCE_SHA OLD_RELEASE_COMPATIBILITY_PROOF OLD_RELEASE_COMPATIBILITY_SIGNATURE_BUNDLE OLD_RELEASE_COMPATIBILITY_PROOF_SHA256 COMPATIBILITY_CANDIDATE_SOURCE_SHA EXPECTED_CERTIFICATE_IDENTITY EXPECTED_OIDC_ISSUER; do
  [[ -n "${!required_name}" ]] || fail "Missing required rollback transport option for $required_name."
done

[[ "$SOURCE_SHA" =~ ^[a-fA-F0-9]{40}$ ]] || fail "--source-sha must be a full 40-character Git SHA."
SOURCE_SHA="${SOURCE_SHA,,}"
[[ "$COMPATIBILITY_CANDIDATE_SOURCE_SHA" =~ ^[a-fA-F0-9]{40}$ ]] || fail "--compatibility-candidate-source-sha must be a full 40-character Git SHA."
COMPATIBILITY_CANDIDATE_SOURCE_SHA="${COMPATIBILITY_CANDIDATE_SOURCE_SHA,,}"
[[ "$COMPATIBILITY_CANDIDATE_SOURCE_SHA" != "$SOURCE_SHA" ]] || fail "Compatibility candidate source SHA must differ from the rollback source SHA."
[[ "$OLD_RELEASE_COMPATIBILITY_PROOF_SHA256" =~ ^[a-fA-F0-9]{64}$ ]] || fail "--old-release-compatibility-proof-sha256 must be a 64-character SHA-256 digest."
OLD_RELEASE_COMPATIBILITY_PROOF_SHA256="${OLD_RELEASE_COMPATIBILITY_PROOF_SHA256,,}"
[[ "$EXPECTED_CERTIFICATE_IDENTITY" == https://* && "$EXPECTED_CERTIFICATE_IDENTITY" != *$'\n'* && "$EXPECTED_CERTIFICATE_IDENTITY" != *$'\r'* ]] \
  || fail "Expected certificate identity must be a single-line HTTPS identity."
[[ "$EXPECTED_OIDC_ISSUER" == https://* && "$EXPECTED_OIDC_ISSUER" != *$'\n'* && "$EXPECTED_OIDC_ISSUER" != *$'\r'* ]] \
  || fail "Expected OIDC issuer must be a single-line HTTPS issuer."
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
  || fail "--compose-project must remain lunchlineup for the stable production volume identity."
[[ "${VM217_RECONCILE_ONLY:-false}" == "true" || "${VM217_RECONCILE_ONLY:-false}" == "false" ]] \
  || fail "VM217_RECONCILE_ONLY must be true or false."

for command_name in awk base64 chmod cosign date find git mktemp node rm scp sha256sum ssh ssh-keygen stat tar timeout; do
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

require_readonly_directory() {
  local path="$1"
  local label="$2"
  local mode
  local mode_value
  [[ -d "$path" && ! -L "$path" && -r "$path" && -x "$path" ]] \
    || fail "$label must be a readable, searchable directory and not a symlink."
  mode="$(file_mode "$path" "$label")"
  mode_value=$((8#$mode))
  (( (mode_value & 0500) == 0500 )) || fail "$label must be owner-readable and owner-searchable."
  (( (mode_value & 0022) == 0 )) || fail "$label must not be group- or world-writable."
}

canonical_file() {
  local path="$1"
  local directory
  directory="$(cd "$(dirname "$path")" && pwd -P)" || return 1
  printf '%s/%s' "$directory" "$(basename "$path")"
}

canonical_directory() {
  (cd "$1" && pwd -P)
}

require_private_input "$PRIVATE_KEY" "Private key"
require_readonly_input "$KNOWN_HOSTS" "Pinned known_hosts file"
require_readonly_directory "$ROLLBACK_APP_DIR" "Retained rollback application root"
require_readonly_input "$RELEASE_MANIFEST" "Retained release manifest"
require_private_input "$RUNTIME_ENV" "Rehydrated runtime environment"
require_private_input "$RUNTIME_SECRET_DESCRIPTOR" "Runtime secret descriptor"
require_readonly_input "$LAUNCH_PROOF" "Retained launch proof"
require_readonly_input "$OLD_RELEASE_COMPATIBILITY_PROOF" "Signed old-release compatibility proof"
require_readonly_input "$OLD_RELEASE_COMPATIBILITY_SIGNATURE_BUNDLE" "Old-release compatibility signature bundle"
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
  || fail "Pinned known_hosts file does not contain the requested host."

ROLLBACK_APP_DIR="$(canonical_directory "$ROLLBACK_APP_DIR")" \
  || fail "Could not resolve retained rollback application root."
RELEASE_MANIFEST="$(canonical_file "$RELEASE_MANIFEST")" \
  || fail "Could not resolve retained release manifest."
EXPECTED_MANIFEST="$(canonical_file "$ROLLBACK_APP_DIR/.release/release-manifest.json")" \
  || fail "Retained rollback application root is missing .release/release-manifest.json."
[[ "$RELEASE_MANIFEST" == "$EXPECTED_MANIFEST" ]] \
  || fail "--release-manifest must be the manifest inside --rollback-app-dir."

LOCAL_ENTRYPOINT="$ROLLBACK_APP_DIR/$REMOTE_ENTRYPOINT"
LOCAL_VERIFIER="$ROLLBACK_APP_DIR/scripts/verify-release-artifacts.mjs"
LOCAL_COMPATIBILITY_VERIFIER="$ROLLBACK_APP_DIR/scripts/verify-old-release-compatibility.mjs"
require_readonly_input "$LOCAL_ENTRYPOINT" "Retained remote rollback entrypoint"
require_readonly_input "$LOCAL_VERIFIER" "Retained release verifier"
require_readonly_input "$LOCAL_COMPATIBILITY_VERIFIER" "Retained old-release compatibility verifier"
require_readonly_input "$ACTIVATOR" "Rollback activation helper"
git -C "$REPO_ROOT" ls-files --error-unmatch -- "$REMOTE_ENTRYPOINT" >/dev/null 2>&1 \
  || fail "Remote rollback entrypoint path must be checked in."

[[ -z "$(find "$ROLLBACK_APP_DIR" -mindepth 1 -type l -print -quit)" ]] \
  || fail "Retained rollback application root must not contain symlinks."
[[ -z "$(find "$ROLLBACK_APP_DIR" -mindepth 1 ! -type d ! -type f -print -quit)" ]] \
  || fail "Retained rollback application root may contain only regular files and directories."

for required_env in PRODUCTION_API_HEALTH_URL PRODUCTION_WEB_URL LAUNCH_PROOF_MANIFEST_URI; do
  required_value="${!required_env:-}"
  [[ -n "$required_value" && "$required_value" != *$'\n'* && "$required_value" != *$'\r'* ]] \
    || fail "$required_env must be a non-empty single-line value."
done

PROOF_MAX_AGE="${LAUNCH_PROOF_MAX_AGE_SECONDS:-86400}"
[[ "$PROOF_MAX_AGE" =~ ^[1-9][0-9]*$ ]] \
  || fail "LAUNCH_PROOF_MAX_AGE_SECONDS must be a positive integer."
RETENTION_COUNT="${ROLLBACK_RELEASE_RETENTION_COUNT:-3}"
[[ "$RETENTION_COUNT" =~ ^[0-9]+$ && "$RETENTION_COUNT" -ge 3 && "$RETENTION_COUNT" -le 20 ]] \
  || fail "ROLLBACK_RELEASE_RETENTION_COUNT must be an integer from 3 through 20."

sha256_file() {
  local path="$1"
  local digest
  digest="$(sha256sum -- "$path" | awk '{print $1}')"
  [[ "$digest" =~ ^[a-fA-F0-9]{64}$ ]] || fail "Could not hash a rollback transport input."
  printf '%s' "${digest,,}"
}

binding_output="$(node - "$RUNTIME_SECRET_DESCRIPTOR" "$RELEASE_MANIFEST" "$SOURCE_SHA" "$REMOTE_ENTRYPOINT" <<'NODE'
const { readFileSync } = require('node:fs');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

let descriptor;
let manifest;
try {
  descriptor = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  manifest = JSON.parse(readFileSync(process.argv[3], 'utf8'));
} catch (error) {
  fail(`Rollback transport JSON input is invalid: ${error.message}`);
}

if (
  !descriptor
  || typeof descriptor !== 'object'
  || Array.isArray(descriptor)
  || descriptor.version !== 1
  || descriptor.provider !== 'aws-secretsmanager'
  || typeof descriptor.reference !== 'string'
  || descriptor.reference.length === 0
  || /[\r\n]/.test(descriptor.reference)
  || typeof descriptor.secretVersion !== 'string'
  || !/^[A-Za-z0-9-]{32,64}$/.test(descriptor.secretVersion)
  || typeof descriptor.sha256 !== 'string'
  || !/^[a-f0-9]{64}$/.test(descriptor.sha256)
) fail('Runtime secret descriptor does not satisfy the retained version 1 contract.');

if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.sourceSha !== process.argv[4]) {
  fail('Retained release manifest sourceSha does not match --source-sha.');
}
const files = manifest.deploymentContract?.files;
if (!files || typeof files !== 'object' || Array.isArray(files)) {
  fail('Retained release manifest is missing deploymentContract.files.');
}
for (const path of [process.argv[5], 'scripts/verify-release-artifacts.mjs']) {
  if (!/^[a-f0-9]{64}$/.test(files[path] ?? '')) {
    fail(`Retained release manifest does not bind ${path}.`);
  }
}

process.stdout.write(`${descriptor.sha256}\n${files[process.argv[5]]}\n${files['scripts/verify-release-artifacts.mjs']}\n`);
NODE
)" || fail "Could not validate retained rollback bindings."
mapfile -t binding_lines <<< "$binding_output"
(( ${#binding_lines[@]} == 3 )) || fail "Retained rollback binding validation returned an invalid result."
DESCRIPTOR_RUNTIME_SHA256="${binding_lines[0]}"
MANIFEST_ENTRYPOINT_SHA256="${binding_lines[1]}"
MANIFEST_VERIFIER_SHA256="${binding_lines[2]}"

RUNTIME_ENV_SHA256="$(sha256_file "$RUNTIME_ENV")"
[[ "$RUNTIME_ENV_SHA256" == "$DESCRIPTOR_RUNTIME_SHA256" ]] \
  || fail "Rehydrated runtime environment does not match the retained runtime-secret descriptor."
ENTRYPOINT_SHA256="$(sha256_file "$LOCAL_ENTRYPOINT")"
[[ "$ENTRYPOINT_SHA256" == "$MANIFEST_ENTRYPOINT_SHA256" ]] \
  || fail "Retained remote rollback entrypoint does not match the release manifest."
VERIFIER_SHA256="$(sha256_file "$LOCAL_VERIFIER")"
[[ "$VERIFIER_SHA256" == "$MANIFEST_VERIFIER_SHA256" ]] \
  || fail "Retained release verifier does not match the release manifest."
ACTIVATOR_SHA256="$(sha256_file "$ACTIVATOR")"
ACTUAL_COMPATIBILITY_PROOF_SHA256="$(sha256_file "$OLD_RELEASE_COMPATIBILITY_PROOF")"
[[ "$ACTUAL_COMPATIBILITY_PROOF_SHA256" == "$OLD_RELEASE_COMPATIBILITY_PROOF_SHA256" ]] \
  || fail "Signed old-release compatibility proof does not match its expected digest."
cosign verify-blob "$OLD_RELEASE_COMPATIBILITY_PROOF" \
  --bundle "$OLD_RELEASE_COMPATIBILITY_SIGNATURE_BUNDLE" \
  --certificate-identity "$EXPECTED_CERTIFICATE_IDENTITY" \
  --certificate-oidc-issuer "$EXPECTED_OIDC_ISSUER" >/dev/null \
  || fail "Old-release compatibility proof signature is missing, invalid, or detached."
node "$LOCAL_COMPATIBILITY_VERIFIER" \
  "$OLD_RELEASE_COMPATIBILITY_PROOF" \
  "$SOURCE_SHA" \
  "$COMPATIBILITY_CANDIDATE_SOURCE_SHA" >/dev/null \
  || fail "Signed old-release compatibility proof does not bind the rollback and candidate source SHAs."

node "$LOCAL_VERIFIER" "$RELEASE_MANIFEST" \
  --source-sha "$SOURCE_SHA" \
  --deployment-root "$ROLLBACK_APP_DIR" \
  --launch-proof-file "$LAUNCH_PROOF" \
  --launch-proof-mode rollback \
  --max-proof-age-seconds "$PROOF_MAX_AGE" >/dev/null

MANIFEST_SHA256="$(sha256_file "$RELEASE_MANIFEST")"
DESCRIPTOR_SHA256="$(sha256_file "$RUNTIME_SECRET_DESCRIPTOR")"
LAUNCH_PROOF_SHA256="$(sha256_file "$LAUNCH_PROOF")"
COMPATIBILITY_SIGNATURE_SHA256="$(sha256_file "$OLD_RELEASE_COMPATIBILITY_SIGNATURE_BUNDLE")"

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

read_vm217_rollback_state() {
  local expected_previous="$1"
  local reconciliation_output
  local reconciliation_status=0
  reconciliation_output="$(vm217_reconcile_release_state \
    "VM217 rollback state reconciliation" \
    "$REMOTE_APP_DIR" \
    "$SOURCE_SHA" \
    "$COMPATIBILITY_CANDIDATE_SOURCE_SHA" \
    "$expected_previous" \
    "$RUNTIME_ENV_SHA256" \
    "$REMOTE_RUNTIME_ENV_POINTER" \
    "$REMOTE_BACKUP_RELEASE_ENV" \
    "$COMPOSE_PROJECT" \
    "$(encode_reconciliation_value "$PRODUCTION_WEB_URL")" \
    "-" \
    "${SSH_OPTIONS[@]}" "$SSH_TARGET")" || reconciliation_status=$?
  (( reconciliation_status == 0 )) || return "$reconciliation_status"
  printf '%s\n' "$reconciliation_output"
}

reconcile_vm217_rollback_state() {
  local reconciliation_output
  reconciliation_output="$(read_vm217_rollback_state "$COMPATIBILITY_CANDIDATE_SOURCE_SHA")" \
    || return $?
  printf '%s\n' "$reconciliation_output"
  [[ "$reconciliation_output" == vm217_reconciliation_ok\ exact_state=primary\ * ]] \
    || { echo "VM217 rollback reconciliation found the candidate or another non-target state." >&2; return 1; }
}

if [[ "${VM217_RECONCILE_ONLY:-false}" == "true" ]]; then
  reconcile_vm217_rollback_state
  exit 0
fi

cleanup_staging() {
  local exit_code=$?
  local cleanup_status
  trap - EXIT
  if [[ -n "$REMOTE_STAGE" ]]; then
    if vm217_run_cleanup_ssh "remote rollback staging cleanup" \
      "${SSH_OPTIONS[@]}" "$SSH_TARGET" rm -rf -- "$REMOTE_STAGE" >/dev/null; then
      :
    else
      cleanup_status=$?
      echo "Remote rollback transport staging cleanup failed." >&2
      (( exit_code != 0 )) || exit_code="$cleanup_status"
    fi
  fi
  if [[ -n "$LOCAL_ARCHIVE" ]]; then
    if ! rm -f -- "$LOCAL_ARCHIVE"; then
      echo "Local rollback transport staging cleanup failed." >&2
      (( exit_code != 0 )) || exit_code=1
    fi
  fi
  if [[ -n "$LOCAL_PROTECTED_CHANNEL" ]]; then
    if ! rm -f -- "$LOCAL_PROTECTED_CHANNEL"; then
      echo "Local rollback protected-channel cleanup failed." >&2
      (( exit_code != 0 )) || exit_code=1
    fi
  fi
  exit "$exit_code"
}

handle_mutation_signal() {
  local signal_name="$1"
  local signal_exit_code="$2"
  trap '' INT TERM
  if [[ "$REMOTE_MUTATION_STARTED" == "true" ]]; then
    echo "VM217 rollback transport received $signal_name after remote mutation began; attempting one bounded authenticated reconciliation before cleanup." >&2
    if reconcile_vm217_rollback_state; then
      echo "vm217_rollback_transport_recovered sha=$SOURCE_SHA signal=$signal_name state=exact-committed-state"
      exit 0
    fi
    echo "VM217 rollback signal reconciliation did not prove the exact rollback target; preserving $signal_name exit semantics." >&2
  fi
  exit "$signal_exit_code"
}

trap cleanup_staging EXIT
trap 'handle_mutation_signal INT 130' INT
trap 'handle_mutation_signal TERM 143' TERM

umask 077
LOCAL_ARCHIVE="$(mktemp "${TMPDIR:-/tmp}/lunchlineup-rollback-transport.XXXXXXXX")"
tar --create --file "$LOCAL_ARCHIVE" --directory "$ROLLBACK_APP_DIR" .
chmod 600 "$LOCAL_ARCHIVE"
ARCHIVE_SHA256="$(sha256_file "$LOCAL_ARCHIVE")"
stage_token="${LOCAL_ARCHIVE##*.}"
[[ "$stage_token" =~ ^[A-Za-z0-9]+$ ]] \
  || fail "Could not derive a safe rollback transport staging token."
remote_stage_candidate="/tmp/lunchlineup-rollback-transport.$stage_token"

vm217_begin_mutation_budget
preflight_output="$(read_vm217_rollback_state "-")" \
  || fail "VM217 rollback preflight could not prove the exact target or candidate state; production mutation remains blocked."
case "$preflight_output" in
  vm217_reconciliation_ok\ exact_state=primary\ *)
    printf '%s\n' "$preflight_output"
    echo "vm217_rollback_transport_recovered sha=$SOURCE_SHA state=already-exact-target"
    exit 0
    ;;
  vm217_reconciliation_ok\ exact_state=secondary\ *)
    printf '%s\n' "$preflight_output"
    ;;
  *)
    fail "VM217 rollback preflight returned an unsupported exact-state result; production mutation remains blocked."
    ;;
esac
vm217_assert_mutation_cutoff \
  || fail "VM217 rollback preflight exhausted the pre-mutation cutoff; production mutation remains blocked."
REMOTE_STAGE="$remote_stage_candidate"
REMOTE_MUTATION_STARTED=true
vm217_run_ssh "remote rollback staging allocation" \
  "${SSH_OPTIONS[@]}" "$SSH_TARGET" mkdir -m 700 -- "$REMOTE_STAGE"

REMOTE_ARCHIVE="$REMOTE_STAGE/rollback-app.tar"
REMOTE_RUNTIME_ENV="$REMOTE_STAGE/runtime.env"
REMOTE_DESCRIPTOR="$REMOTE_STAGE/runtime-secret.json"
REMOTE_LAUNCH_PROOF="$REMOTE_STAGE/launch-proof.json"
REMOTE_ACTIVATOR="$REMOTE_STAGE/activate-retained-rollback.sh"
REMOTE_COMPATIBILITY_PROOF="$REMOTE_STAGE/old-release-compatibility.json"
REMOTE_COMPATIBILITY_SIGNATURE="$REMOTE_STAGE/old-release-compatibility.sigstore.json"
REMOTE_PROTECTED_CHANNEL="$REMOTE_STAGE/protected-channel"

if [[ "$LAUNCH_PROOF_MANIFEST_URI" == *$'\n'* || "$LAUNCH_PROOF_MANIFEST_URI" == *$'\r'* ]]; then
  fail "LAUNCH_PROOF_MANIFEST_URI must be a single-line value."
fi
LOCAL_PROTECTED_CHANNEL="$(mktemp "${TMPDIR:-/tmp}/lunchlineup-vm217-rollback-protected.XXXXXXXX")"
printf '%s\n' "$LAUNCH_PROOF_MANIFEST_URI" > "$LOCAL_PROTECTED_CHANNEL"
chmod 600 "$LOCAL_PROTECTED_CHANNEL"
PROTECTED_CHANNEL_SHA256="$(sha256_file "$LOCAL_PROTECTED_CHANNEL")"

vm217_run_scp "retained rollback archive upload" "${SCP_OPTIONS[@]}" -- "$LOCAL_ARCHIVE" "$SCP_TARGET:$REMOTE_ARCHIVE"
vm217_run_scp "rollback runtime environment upload" "${SCP_OPTIONS[@]}" -- "$RUNTIME_ENV" "$SCP_TARGET:$REMOTE_RUNTIME_ENV"
vm217_run_scp "rollback runtime descriptor upload" "${SCP_OPTIONS[@]}" -- "$RUNTIME_SECRET_DESCRIPTOR" "$SCP_TARGET:$REMOTE_DESCRIPTOR"
vm217_run_scp "retained launch proof upload" "${SCP_OPTIONS[@]}" -- "$LAUNCH_PROOF" "$SCP_TARGET:$REMOTE_LAUNCH_PROOF"
vm217_run_scp "rollback activator upload" "${SCP_OPTIONS[@]}" -- "$ACTIVATOR" "$SCP_TARGET:$REMOTE_ACTIVATOR"
vm217_run_scp "signed old-release compatibility proof upload" "${SCP_OPTIONS[@]}" -- "$OLD_RELEASE_COMPATIBILITY_PROOF" "$SCP_TARGET:$REMOTE_COMPATIBILITY_PROOF"
vm217_run_scp "old-release compatibility signature upload" "${SCP_OPTIONS[@]}" -- "$OLD_RELEASE_COMPATIBILITY_SIGNATURE_BUNDLE" "$SCP_TARGET:$REMOTE_COMPATIBILITY_SIGNATURE"
vm217_run_scp "protected launch-proof channel upload" "${SCP_OPTIONS[@]}" -- "$LOCAL_PROTECTED_CHANNEL" "$SCP_TARGET:$REMOTE_PROTECTED_CHANNEL"
vm217_run_ssh "remote rollback staging permission hardening" "${SSH_OPTIONS[@]}" "$SSH_TARGET" chmod 600 -- \
  "$REMOTE_ARCHIVE" \
  "$REMOTE_RUNTIME_ENV" \
  "$REMOTE_DESCRIPTOR" \
  "$REMOTE_LAUNCH_PROOF" \
  "$REMOTE_ACTIVATOR" \
  "$REMOTE_COMPATIBILITY_PROOF" \
  "$REMOTE_COMPATIBILITY_SIGNATURE" \
  "$REMOTE_PROTECTED_CHANNEL"

encode_required_env() {
  local name="$1"
  printf '%s' "${!name}" | base64 --wrap=0
}

PRODUCTION_API_HEALTH_URL_B64="$(encode_required_env PRODUCTION_API_HEALTH_URL)"
PRODUCTION_WEB_URL_B64="$(encode_required_env PRODUCTION_WEB_URL)"
activation_status=0
if vm217_run_ssh "remote retained rollback activation" "${SSH_OPTIONS[@]}" "$SSH_TARGET" \
  bash -s -- \
  "$REMOTE_ACTIVATOR" \
  "$ACTIVATOR_SHA256" \
  "$REMOTE_STAGE" \
  "$ARCHIVE_SHA256" \
  "$RUNTIME_ENV_SHA256" \
  "$DESCRIPTOR_SHA256" \
  "$LAUNCH_PROOF_SHA256" \
  "$MANIFEST_SHA256" \
  "$ENTRYPOINT_SHA256" \
  "$VERIFIER_SHA256" \
  "$OLD_RELEASE_COMPATIBILITY_PROOF_SHA256" \
  "$COMPATIBILITY_SIGNATURE_SHA256" \
  "$SOURCE_SHA" \
  "$COMPATIBILITY_CANDIDATE_SOURCE_SHA" \
  "$REMOTE_APP_DIR" \
  "$REMOTE_ENTRYPOINT" \
  "$COMPOSE_PROJECT" \
  "$PRODUCTION_API_HEALTH_URL_B64" \
  "$PRODUCTION_WEB_URL_B64" \
  "$REMOTE_PROTECTED_CHANNEL" \
  "$PROTECTED_CHANNEL_SHA256" \
  "$PROOF_MAX_AGE" \
  "$RETENTION_COUNT" <<'REMOTE_SCRIPT'
set -euo pipefail
umask 077

activator="$1"
expected_sha256="$2"
shift 2
[[ -f "$activator" && ! -L "$activator" && -s "$activator" ]] \
  || { echo "Rollback activation helper is missing from remote staging." >&2; exit 1; }
actual_sha256="$(sha256sum -- "$activator" | awk '{print tolower($1)}')"
[[ "$actual_sha256" == "$expected_sha256" ]] \
  || { echo "Rollback activation helper changed in transport." >&2; exit 1; }
exec bash "$activator" "$@"
REMOTE_SCRIPT
then
  :
else
  activation_status=$?
  if reconcile_vm217_rollback_state; then
    echo "vm217_rollback_transport_recovered sha=$SOURCE_SHA activation_exit_code=$activation_status state=exact-committed-state"
    exit 0
  fi
  echo "VM217 rollback activation failed and reconciliation did not prove the exact rollback target active." >&2
  exit "$activation_status"
fi

reconcile_vm217_rollback_state >/dev/null \
  || fail "VM217 rollback activation returned success but full committed-state reconciliation failed."
echo "vm217_rollback_transport_ok sha=$SOURCE_SHA"
