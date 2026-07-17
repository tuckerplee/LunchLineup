#!/bin/bash
# scripts/dr-drill.sh
# Restores an explicit encrypted backup into an ephemeral Postgres container.
set -euo pipefail
IFS=$'\n\t'
umask 077

usage() {
  cat >&2 <<'USAGE'
Usage: BACKUP_FILE=/tmp/lunchlineup-YYYYMMDDHHMMSS.sql.zst.gpg DR_OFFHOST_SOURCE_URI=s3://bucket/db-backups/... DR_OFFHOST_SOURCE_VERSION=VERSION DR_OFFHOST_EXPECTED_SHA256=SHA256 DR_OFFHOST_FETCH_COMMAND=/trusted/fetch-backup DR_OFFHOST_READBACK_COMMAND=/trusted/provider-readback ./scripts/dr-drill.sh

Required by default:
  BACKUP_ENCRYPTION_KEY_FILE or BACKUP_ENCRYPTION_KEY
  BACKUP_FILE naming a new disposable destination for the retrieved .sql.zst.gpg object
  DR_OFFHOST_SOURCE_URI naming one exact off-host object
  DR_OFFHOST_SOURCE_VERSION naming one exact immutable object version
  DR_OFFHOST_EXPECTED_SHA256 naming the declared object checksum
  DR_OFFHOST_FETCH_COMMAND retrieving only the declared immutable bytes
  DR_OFFHOST_READBACK_COMMAND independently authenticating provider version/checksum metadata
  DR_RECOVERY_ADAPTER_ATTESTATION_FILE and DR_RECOVERY_ADAPTER_SIGNATURE_BUNDLE_FILE
  DR_RECOVERY_ADAPTER_ATTESTATION_URI and DR_RECOVERY_ADAPTER_SIGNATURE_BUNDLE_URI
  DR_RECOVERY_ADAPTER_CERTIFICATE_IDENTITY and DR_RECOVERY_ADAPTER_OIDC_ISSUER

Local-only drills may set DR_REQUIRE_OFFHOST_SOURCE=false.
Checksum-free drills require DR_REQUIRE_CHECKSUM=false and should not be used for launch proof.
USAGE
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command is missing: $1"
}

dr_owner_cgroup_v2_create() {
  local cgroup_path cgroup_parent cgroup_domain
  awk '$5 == "/sys/fs/cgroup" && $0 ~ / - cgroup2 / { found=1 } END { exit !found }' /proc/self/mountinfo 2>/dev/null \
    || { echo "ERROR: DR adapter ownership requires cgroup v2 mounted at /sys/fs/cgroup." >&2; return 1; }
  cgroup_path="$(sed -n 's/^0:://p' /proc/self/cgroup)"
  case "${cgroup_path}" in /*) ;; *) echo "ERROR: DR adapter ownership could not resolve the current cgroup v2 path." >&2; return 1 ;; esac
  cgroup_parent="/sys/fs/cgroup${cgroup_path}"
  cgroup_domain="$(mktemp -d "${cgroup_parent%/}/lunchlineup-dr-adapter.XXXXXX" 2>/dev/null)" \
    || { echo "ERROR: DR adapter ownership requires a writable delegated cgroup v2 beneath ${cgroup_parent}." >&2; return 1; }
  if [ ! -w "${cgroup_domain}/cgroup.procs" ] \
    || [ ! -w "${cgroup_domain}/cgroup.kill" ] \
    || ! grep -q '^populated 0$' "${cgroup_domain}/cgroup.events" 2>/dev/null
  then
    rmdir -- "${cgroup_domain}" 2>/dev/null || true
    echo "ERROR: DR adapter ownership requires delegated cgroup.procs, cgroup.kill, and cgroup.events controls." >&2
    return 1
  fi
  printf '%s' "${cgroup_domain}"
}

dr_owner_cgroup_v2_populated() {
  grep -q '^populated 1$' "$1/cgroup.events" 2>/dev/null
}

dr_owner_cgroup_v2_empty() {
  grep -q '^populated 0$' "$1/cgroup.events" 2>/dev/null \
    && [ -z "$(cat "$1/cgroup.procs" 2>/dev/null)" ] \
    && grep -q '^populated 0$' "$1/cgroup.events" 2>/dev/null
}

dr_owner_cgroup_v2_signal() {
  local cgroup_domain="$1"
  local signal_name="$2"
  local owned_pid
  while IFS= read -r owned_pid; do
    [ -z "${owned_pid}" ] || kill "-${signal_name}" "${owned_pid}" 2>/dev/null || true
  done <"${cgroup_domain}/cgroup.procs"
}

dr_owner_cgroup_v2_terminate() {
  local cgroup_domain="$1"
  local empty_checks=0
  dr_owner_cgroup_v2_signal "${cgroup_domain}" TERM
  sleep 5
  if dr_owner_cgroup_v2_populated "${cgroup_domain}"; then
    printf '1\n' >"${cgroup_domain}/cgroup.kill" \
      || { echo "ERROR: Could not KILL the complete DR adapter cgroup v2 ownership domain." >&2; return 1; }
  fi
  while ! dr_owner_cgroup_v2_empty "${cgroup_domain}"; do
    empty_checks=$((empty_checks + 1))
    [ "${empty_checks}" -le 100 ] \
      || { echo "ERROR: DR adapter cgroup v2 ownership domain did not become empty after KILL." >&2; return 1; }
    sleep 0.05
  done
}

dr_owner_cgroup_v2_wait_stopped() {
  local child_pid="$1"
  local state=""
  local checks=0
  while [ "${checks}" -le 200 ]; do
    [ -r "/proc/${child_pid}/status" ] || return 1
    state="$(sed -n 's/^State:[[:space:]]*\([A-Za-z]\).*/\1/p' "/proc/${child_pid}/status")"
    [ "${state}" != T ] || return 0
    checks=$((checks + 1))
    sleep 0.01
  done
  return 1
}

is_unsigned_integer() {
  case "$1" in
    '' | *[!0-9]*)
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

validate_bool() {
  case "$2" in
    true | false)
      ;;
    *)
      fail "$1 must be true or false."
      ;;
  esac
}

require_trusted_adapter() {
  local path="$1"
  local name="$2"
  local mode
  local mode_value
  case "$path" in
    /* | [A-Za-z]:/*) ;;
    *) fail "$name must be an absolute trusted executable path." ;;
  esac
  [ -f "$path" ] && [ ! -L "$path" ] && [ -r "$path" ] && [ -x "$path" ] && [ -s "$path" ] \
    || fail "$name must be a readable executable regular file and not a symlink."
  mode="$(stat -c '%a' -- "$path" 2>/dev/null)" \
    || fail "Could not inspect $name permissions."
  case "$mode" in
    '' | *[!0-7]*) fail "Could not validate $name permissions." ;;
  esac
  mode_value=$((8#$mode))
  (( (mode_value & 0100) != 0 )) || fail "$name must be owner-executable."
  (( (mode_value & 0022) == 0 )) || fail "$name must not be group- or world-writable."
}

verify_recovery_adapter_attestation() {
  require_command chmod
  require_command mktemp
  require_command node
  DR_EVIDENCE_SNAPSHOT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lunchlineup-dr-evidence.XXXXXX")"
  chmod 700 -- "${DR_EVIDENCE_SNAPSHOT_DIR}"
  snapshot_regular_file_once \
    "${DR_RECOVERY_ADAPTER_ATTESTATION_DECLARED_FILE}" \
    "${DR_EVIDENCE_SNAPSHOT_DIR}/adapter-attestation.json" \
    "Recovery adapter attestation" \
    || fail "Could not bind the recovery adapter attestation to one stable private snapshot."
  snapshot_regular_file_once \
    "${DR_RECOVERY_ADAPTER_SIGNATURE_BUNDLE_DECLARED_FILE}" \
    "${DR_EVIDENCE_SNAPSHOT_DIR}/adapter-signature.sigstore.json" \
    "Recovery adapter signature bundle" \
    || fail "Could not bind the recovery adapter signature bundle to one stable private snapshot."
  snapshot_regular_file_once \
    "${DR_OFFHOST_FETCH_COMMAND_DECLARED}" \
    "${DR_EVIDENCE_SNAPSHOT_DIR}/fetch-adapter" \
    "Off-host fetch adapter" \
    || fail "Could not bind the off-host fetch adapter to one stable private snapshot."
  snapshot_regular_file_once \
    "${DR_OFFHOST_READBACK_COMMAND_DECLARED}" \
    "${DR_EVIDENCE_SNAPSHOT_DIR}/readback-adapter" \
    "Off-host readback adapter" \
    || fail "Could not bind the off-host readback adapter to one stable private snapshot."
  chmod 700 -- \
    "${DR_EVIDENCE_SNAPSHOT_DIR}/fetch-adapter" \
    "${DR_EVIDENCE_SNAPSHOT_DIR}/readback-adapter"
  DR_RECOVERY_ADAPTER_ATTESTATION_FILE="${DR_EVIDENCE_SNAPSHOT_DIR}/adapter-attestation.json"
  DR_RECOVERY_ADAPTER_SIGNATURE_BUNDLE_FILE="${DR_EVIDENCE_SNAPSHOT_DIR}/adapter-signature.sigstore.json"
  DR_OFFHOST_FETCH_COMMAND="${DR_EVIDENCE_SNAPSHOT_DIR}/fetch-adapter"
  DR_OFFHOST_READBACK_COMMAND="${DR_EVIDENCE_SNAPSHOT_DIR}/readback-adapter"

  for signed_path_name in DR_RECOVERY_ADAPTER_ATTESTATION_FILE DR_RECOVERY_ADAPTER_SIGNATURE_BUNDLE_FILE; do
    signed_path="${!signed_path_name}"
    case "${signed_path}" in /* | [A-Za-z]:/*) ;; *) fail "${signed_path_name} must be an absolute path." ;; esac
    [ -f "${signed_path}" ] && [ ! -L "${signed_path}" ] && [ -s "${signed_path}" ] \
      || fail "${signed_path_name} must be a non-empty regular file and not a symlink."
    [ "$(stat -c '%s' -- "${signed_path}")" -le 1048576 ] \
      || fail "${signed_path_name} must not exceed 1048576 bytes."
  done
  for signed_uri_name in DR_RECOVERY_ADAPTER_ATTESTATION_URI DR_RECOVERY_ADAPTER_SIGNATURE_BUNDLE_URI; do
    signed_uri="${!signed_uri_name}"
    case "${signed_uri}" in
      https://* | s3://*) ;;
      *) fail "${signed_uri_name} must name one immutable https:// or s3:// retained artifact." ;;
    esac
    case "${signed_uri}" in *[[:space:]]* | *latest* | *current*) fail "${signed_uri_name} must not use whitespace or a latest/current alias." ;; esac
  done
  [ -n "${DR_RECOVERY_ADAPTER_CERTIFICATE_IDENTITY}" ] \
    || fail "DR_RECOVERY_ADAPTER_CERTIFICATE_IDENTITY is required."
  [ -n "${DR_RECOVERY_ADAPTER_OIDC_ISSUER}" ] \
    || fail "DR_RECOVERY_ADAPTER_OIDC_ISSUER is required."
  require_trusted_adapter "${DR_OFFHOST_FETCH_COMMAND}" DR_OFFHOST_FETCH_COMMAND
  require_trusted_adapter "${DR_OFFHOST_READBACK_COMMAND}" DR_OFFHOST_READBACK_COMMAND
  DR_OFFHOST_FETCH_COMMAND_SHA256="$(sha256sum -- "${DR_OFFHOST_FETCH_COMMAND}" | awk '{print tolower($1)}')"
  DR_OFFHOST_READBACK_COMMAND_SHA256="$(sha256sum -- "${DR_OFFHOST_READBACK_COMMAND}" | awk '{print tolower($1)}')"
  [ "${DR_OFFHOST_FETCH_COMMAND_SHA256}" != "${DR_OFFHOST_READBACK_COMMAND_SHA256}" ] \
    || fail "DR_OFFHOST_FETCH_COMMAND and DR_OFFHOST_READBACK_COMMAND must be independently implemented executables."
  require_command cosign
  if ! run_bounded \
    "Recovery adapter signature verification" \
    "${DR_OFFHOST_READBACK_TIMEOUT_SECONDS}" \
    cosign verify-blob \
      "${DR_RECOVERY_ADAPTER_ATTESTATION_FILE}" \
      --bundle "${DR_RECOVERY_ADAPTER_SIGNATURE_BUNDLE_FILE}" \
      --certificate-identity "${DR_RECOVERY_ADAPTER_CERTIFICATE_IDENTITY}" \
      --certificate-oidc-issuer "${DR_RECOVERY_ADAPTER_OIDC_ISSUER}" >/dev/null
  then
    fail "Recovery adapter attestation signature is invalid or is not from the protected workflow identity."
  fi
  if ! node - \
    "${DR_RECOVERY_ADAPTER_ATTESTATION_FILE}" \
    "${DR_OFFHOST_FETCH_COMMAND_SHA256}" \
    "${DR_OFFHOST_READBACK_COMMAND_SHA256}" \
    "$(source_kind)" \
    "${DR_RECOVERY_ADAPTER_CERTIFICATE_IDENTITY}" \
    "${DR_RECOVERY_ADAPTER_OIDC_ISSUER}" <<'NODE'
const { readFileSync } = require('node:fs');
const [path, fetchSha, readbackSha, sourceKind, identity, issuer] = process.argv.slice(2);
let value;
try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { process.exit(1); }
const issuedAt = Date.parse(value?.issuedAt);
const expiresAt = Date.parse(value?.expiresAt);
const now = Date.now();
if (
  value?.version !== 1
  || value?.kind !== 'lunchlineup-signed-recovery-adapter-provenance'
  || value?.fetchAdapterSha256 !== fetchSha
  || value?.readbackAdapterSha256 !== readbackSha
  || !Array.isArray(value?.sourceKinds)
  || !value.sourceKinds.includes(sourceKind)
  || value?.certificateIdentity !== identity
  || value?.oidcIssuer !== issuer
  || !Number.isFinite(issuedAt)
  || !Number.isFinite(expiresAt)
  || issuedAt > now + 30_000
  || expiresAt <= now
  || expiresAt - issuedAt > 90 * 86_400_000
) process.exit(1);
NODE
  then
    fail "Signed recovery adapter attestation does not pin these exact fetch/readback adapter bytes and source kind."
  fi
  DR_RECOVERY_ADAPTER_ATTESTATION_SHA256="$(sha256sum -- "${DR_RECOVERY_ADAPTER_ATTESTATION_FILE}" | awk '{print tolower($1)}')"
  DR_RECOVERY_ADAPTER_SIGNATURE_BUNDLE_SHA256="$(sha256sum -- "${DR_RECOVERY_ADAPTER_SIGNATURE_BUNDLE_FILE}" | awk '{print tolower($1)}')"
}

validate_postgres_identifier() {
  case "$2" in
    '' | *[!A-Za-z0-9_]* | [0-9]*)
      fail "$1 must be a simple Postgres identifier."
      ;;
  esac
}

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

snapshot_regular_file_once() {
  local source_path="$1"
  local snapshot_path="$2"
  local label="$3"
  timeout --signal=TERM --kill-after=2s "${DR_OFFHOST_READBACK_TIMEOUT_SECONDS}s" \
    node --input-type=module - "${source_path}" "${snapshot_path}" "${label}" <<'NODE'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  writeSync,
} from 'node:fs';

const [sourcePath, snapshotPath, label] = process.argv.slice(2);
let source;
let destination;
try {
  const pathState = lstatSync(sourcePath, { bigint: true });
  if (pathState.isSymbolicLink() || !pathState.isFile()) throw new Error('source must be a non-symlink regular file');
  const noFollow = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0);
  source = openSync(sourcePath, constants.O_RDONLY | noFollow);
  const before = fstatSync(source, { bigint: true });
  if (!before.isFile() || before.size < 1n) throw new Error('source must be a non-empty regular file');
  for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) {
    if (pathState[key] !== before[key]) throw new Error('source path changed before its stable descriptor was bound');
  }
  destination = openSync(snapshotPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  for (;;) {
    const read = readSync(source, buffer, 0, buffer.length, null);
    if (read === 0) break;
    let written = 0;
    while (written < read) written += writeSync(destination, buffer, written, read - written);
  }
  const after = fstatSync(source, { bigint: true });
  for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) {
    if (before[key] !== after[key]) throw new Error('source changed while its stable snapshot was captured');
  }
} catch (error) {
  process.stderr.write(`${label} snapshot failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (destination !== undefined) closeSync(destination);
  if (source !== undefined) closeSync(source);
}
NODE
}

snapshot_backup_input() {
  local backup_name
  local checksum_source
  local snapshot_sha256
  local snapshot_bytes

  BACKUP_DECLARED_FILE="${BACKUP_FILE}"
  BACKUP_DECLARED_CHECKSUM_FILE="${BACKUP_FILE}.sha256"
  backup_name="$(basename -- "${BACKUP_DECLARED_FILE}")"
  checksum_source="${BACKUP_DECLARED_CHECKSUM_FILE}"
  DR_BACKUP_SNAPSHOT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lunchlineup-dr-backup.XXXXXX")"
  chmod 700 -- "${DR_BACKUP_SNAPSHOT_DIR}"
  snapshot_regular_file_once "${BACKUP_DECLARED_FILE}" "${DR_BACKUP_SNAPSHOT_DIR}/${backup_name}" 'DR backup input' \
    || fail "DR backup input must be a stable non-symlink regular file."
  if [ -e "${checksum_source}" ] || [ -L "${checksum_source}" ]; then
    snapshot_regular_file_once "${checksum_source}" "${DR_BACKUP_SNAPSHOT_DIR}/${backup_name}.sha256" 'DR checksum sidecar' \
      || fail "DR checksum sidecar must be a stable non-symlink regular file."
  fi
  BACKUP_FILE="${DR_BACKUP_SNAPSHOT_DIR}/${backup_name}"
  snapshot_sha256="$(sha256sum -- "${BACKUP_FILE}" | awk '{print tolower($1)}')"
  snapshot_bytes="$(stat -c '%s' -- "${BACKUP_FILE}")"
  if [ "${DR_REQUIRE_OFFHOST_SOURCE}" = "true" ]; then
    [ "${snapshot_sha256}" = "${DR_OFFHOST_EXPECTED_SHA256}" ] \
      && [ "${snapshot_bytes}" = "${DR_OFFHOST_RETRIEVED_BYTES}" ] \
      || fail "Private DR backup snapshot does not match the provider-bound checksum and byte count."
  fi
}

read_backup_key() {
  if [ -n "${BACKUP_ENCRYPTION_KEY_FILE:-}" ]; then
    [ -f "${BACKUP_ENCRYPTION_KEY_FILE}" ] || fail "BACKUP_ENCRYPTION_KEY_FILE does not exist."
    cat "${BACKUP_ENCRYPTION_KEY_FILE}"
    return
  fi

  [ -n "${BACKUP_ENCRYPTION_KEY:-}" ] || fail "Set BACKUP_ENCRYPTION_KEY_FILE or BACKUP_ENCRYPTION_KEY."
  printf '%s' "${BACKUP_ENCRYPTION_KEY}"
}

validate_container_name() {
  case "${DR_CONTAINER}" in
    lunchlineup-dr-drill-*)
      ;;
    *)
      fail "DR_CONTAINER must start with lunchlineup-dr-drill- so cleanup cannot remove an unrelated container."
      ;;
  esac

  case "${DR_CONTAINER}" in
    '' | *[!A-Za-z0-9_.-]*)
      fail "DR_CONTAINER contains unsupported characters."
      ;;
  esac
}

validate_offhost_source() {
  [ "${DR_REQUIRE_OFFHOST_SOURCE}" = "true" ] || return 0

  [ -n "${DR_OFFHOST_SOURCE_URI}" ] || fail "DR_OFFHOST_SOURCE_URI is required when DR_REQUIRE_OFFHOST_SOURCE=true. Declare one exact off-host backup object."

  case "${DR_OFFHOST_SOURCE_URI}" in
    file://* | /* | ./* | ../* | http://localhost* | https://localhost* | http://127.* | https://127.*)
      fail "DR_OFFHOST_SOURCE_URI must name off-host storage, not a local path or localhost URL."
      ;;
    s3://* | rclone:* | rsync://* | scp://* | ssh://* | https://* | restic:* | b2://*)
      ;;
    *)
      fail "DR_OFFHOST_SOURCE_URI must use s3://, rclone:, rsync://, scp://, ssh://, https://, restic:, or b2://."
      ;;
  esac

  case "${DR_OFFHOST_SOURCE_URI}" in
    *[[:space:]]* | *\?* | *\#* | */ | *latest | *latest.*)
      fail "DR_OFFHOST_SOURCE_URI must identify one exact immutable backup object without whitespace, query, fragment, repository suffix, or latest alias."
      ;;
    *.sql.zst.gpg) ;;
    *) fail "DR_OFFHOST_SOURCE_URI must end with an explicit .sql.zst.gpg object name." ;;
  esac

  [ -n "${DR_OFFHOST_SOURCE_VERSION}" ] \
    || fail "DR_OFFHOST_SOURCE_VERSION is required for exact off-host retrieval."
  case "${DR_OFFHOST_SOURCE_VERSION}" in
    *[[:space:]]* | *$'\r'* | *$'\n'* | latest | null)
      fail "DR_OFFHOST_SOURCE_VERSION must be one exact immutable version identifier."
      ;;
  esac
  case "${DR_OFFHOST_EXPECTED_SHA256}" in
    *[!A-Fa-f0-9]* | '') fail "DR_OFFHOST_EXPECTED_SHA256 must be a 64-character SHA-256 digest." ;;
  esac
  [ "${#DR_OFFHOST_EXPECTED_SHA256}" -eq 64 ] \
    || fail "DR_OFFHOST_EXPECTED_SHA256 must be a 64-character SHA-256 digest."
  DR_OFFHOST_EXPECTED_SHA256="${DR_OFFHOST_EXPECTED_SHA256,,}"
  [ "${DR_REQUIRE_CHECKSUM}" = "true" ] \
    || fail "Off-host DR evidence always requires checksum verification; DR_REQUIRE_CHECKSUM must remain true."
  [ -n "${DR_OFFHOST_FETCH_COMMAND}" ] \
    || fail "DR_OFFHOST_FETCH_COMMAND is required to retrieve the declared off-host object."
  [ -n "${DR_OFFHOST_READBACK_COMMAND}" ] \
    || fail "DR_OFFHOST_READBACK_COMMAND is required for independent provider-authenticated version/checksum readback."
  require_command stat
  require_command sha256sum
  require_command node
  is_unsigned_integer "${DR_OFFHOST_FETCH_TIMEOUT_SECONDS}" \
    || fail "DR_OFFHOST_FETCH_TIMEOUT_SECONDS must be a positive integer."
  [ "${DR_OFFHOST_FETCH_TIMEOUT_SECONDS}" -ge 1 ] && [ "${DR_OFFHOST_FETCH_TIMEOUT_SECONDS}" -le 600 ] \
    || fail "DR_OFFHOST_FETCH_TIMEOUT_SECONDS must be between 1 and 600."
  is_unsigned_integer "${DR_OFFHOST_READBACK_TIMEOUT_SECONDS}" \
    || fail "DR_OFFHOST_READBACK_TIMEOUT_SECONDS must be a positive integer."
  [ "${DR_OFFHOST_READBACK_TIMEOUT_SECONDS}" -ge 1 ] && [ "${DR_OFFHOST_READBACK_TIMEOUT_SECONDS}" -le 600 ] \
    || fail "DR_OFFHOST_READBACK_TIMEOUT_SECONDS must be between 1 and 600."
  verify_recovery_adapter_attestation
  is_unsigned_integer "${DR_OFFHOST_READBACK_MAX_AGE_SECONDS}" \
    || fail "DR_OFFHOST_READBACK_MAX_AGE_SECONDS must be a positive integer."
  [ "${DR_OFFHOST_READBACK_MAX_AGE_SECONDS}" -ge 1 ] && [ "${DR_OFFHOST_READBACK_MAX_AGE_SECONDS}" -le 900 ] \
    || fail "DR_OFFHOST_READBACK_MAX_AGE_SECONDS must be between 1 and 900."
}

validate_dr_settings() {
  validate_bool DR_REQUIRE_OFFHOST_SOURCE "${DR_REQUIRE_OFFHOST_SOURCE}"
  validate_bool DR_REQUIRE_CHECKSUM "${DR_REQUIRE_CHECKSUM}"
  validate_bool DR_REQUIRE_TABLES "${DR_REQUIRE_TABLES}"
  validate_postgres_identifier DR_USER "${DR_USER}"
  validate_postgres_identifier DR_DB "${DR_DB}"
  [ -n "${DR_PASSWORD}" ] && [ "${#DR_PASSWORD}" -le 1024 ] \
    && [[ "${DR_PASSWORD}" != *$'\n'* && "${DR_PASSWORD}" != *$'\r'* ]] \
    || fail "DR_PASSWORD must be a non-empty single-line value of at most 1024 bytes."
  is_unsigned_integer "${DR_WAIT_SECONDS}" || fail "DR_WAIT_SECONDS must be a positive integer."
  [ "${DR_WAIT_SECONDS}" -ge 1 ] && [ "${DR_WAIT_SECONDS}" -le 300 ] || fail "DR_WAIT_SECONDS must be between 1 and 300."
  for timeout_name in \
    DR_DOCKER_OPERATION_TIMEOUT_SECONDS \
    DR_DECRYPT_TIMEOUT_SECONDS \
    DR_ZSTD_TIMEOUT_SECONDS \
    DR_PSQL_TIMEOUT_SECONDS \
    DR_CLEANUP_TIMEOUT_SECONDS \
    DR_RESTORE_PIPELINE_TIMEOUT_SECONDS
  do
    timeout_value="${!timeout_name}"
    is_unsigned_integer "$timeout_value" || fail "$timeout_name must be a positive integer."
    [ "$timeout_value" -ge 1 ] && [ "$timeout_value" -le 600 ] \
      || fail "$timeout_name must be between 1 and 600."
  done
  [ "$DR_DECRYPT_TIMEOUT_SECONDS" -le "$DR_RESTORE_PIPELINE_TIMEOUT_SECONDS" ] \
    && [ "$DR_ZSTD_TIMEOUT_SECONDS" -le "$DR_RESTORE_PIPELINE_TIMEOUT_SECONDS" ] \
    && [ "$DR_PSQL_TIMEOUT_SECONDS" -le "$DR_RESTORE_PIPELINE_TIMEOUT_SECONDS" ] \
    || fail "Decrypt, zstd, and psql deadlines must not exceed DR_RESTORE_PIPELINE_TIMEOUT_SECONDS."

  case "${DR_IMAGE}" in
    '' | *:latest | *:latest@*)
      fail "DR_IMAGE must be explicit and must not use the latest tag."
      ;;
  esac
  case "${DR_IMAGE}" in
    *@sha256:*) ;;
    *)
      fail "DR_IMAGE must include an immutable @sha256 digest."
      ;;
  esac

  validate_container_name
  validate_offhost_source
}

select_backup_file() {
  if [ -n "${BACKUP_FILE}" ]; then
    return 0
  fi

  if [ "${DR_REQUIRE_OFFHOST_SOURCE}" = "true" ]; then
    fail "BACKUP_FILE is required when DR_REQUIRE_OFFHOST_SOURCE=true. Pass the exact off-host backup object after downloading it to a disposable path."
  fi

  case "${BACKUP_DIR}" in
    '' | '/' | '.' | '..')
      fail "BACKUP_DIR must be a dedicated backup directory, not '${BACKUP_DIR}'."
      ;;
  esac

  BACKUP_FILE="$(ls -t "${BACKUP_DIR}"/*.sql.zst.gpg 2>/dev/null | head -n 1 || true)"
}

prepare_offhost_destination() {
  [ "${DR_REQUIRE_OFFHOST_SOURCE}" = "true" ] || return 0

  [ -n "${BACKUP_FILE}" ] \
    || fail "BACKUP_FILE is required when DR_REQUIRE_OFFHOST_SOURCE=true and must name a new disposable retrieval destination."
  case "${BACKUP_FILE}" in
    /* | [A-Za-z]:/*) ;;
    *) fail "BACKUP_FILE must be an absolute disposable path for off-host retrieval." ;;
  esac
  [ ! -e "${BACKUP_FILE}" ] && [ ! -L "${BACKUP_FILE}" ] \
    || fail "BACKUP_FILE must not exist before off-host retrieval; a caller-provided local file cannot satisfy DR evidence."
  [ -d "$(dirname "${BACKUP_FILE}")" ] \
    || fail "BACKUP_FILE parent directory must already exist."
  [ "$(basename "${BACKUP_FILE}")" = "${DR_OFFHOST_SOURCE_URI##*/}" ] \
    || fail "BACKUP_FILE basename must exactly match the declared off-host object name."

  DR_OFFHOST_READBACK_FILE="${DR_OFFHOST_READBACK_FILE:-${BACKUP_FILE}.offhost-readback.json}"
  DR_OFFHOST_READBACK_DECLARED_FILE="${DR_OFFHOST_READBACK_FILE}"
  case "${DR_OFFHOST_READBACK_FILE}" in
    /* | [A-Za-z]:/*) ;;
    *) fail "DR_OFFHOST_READBACK_FILE must be an absolute disposable path." ;;
  esac
  [ ! -e "${DR_OFFHOST_READBACK_FILE}" ] && [ ! -L "${DR_OFFHOST_READBACK_FILE}" ] \
    || fail "DR_OFFHOST_READBACK_FILE must not exist before retrieval."
  [ ! -e "${BACKUP_FILE}.sha256" ] && [ ! -L "${BACKUP_FILE}.sha256" ] \
    || fail "The generated checksum sidecar must not exist before off-host retrieval."
}

discard_failed_offhost_retrieval() {
  timeout --foreground --signal=TERM --kill-after=5s "${DR_CLEANUP_TIMEOUT_SECONDS}s" \
    rm -f -- "${BACKUP_FILE}" "${BACKUP_FILE}.sha256" "${DR_OFFHOST_READBACK_FILE}" 2>/dev/null || true
}

offhost_retrieval_fail() {
  local message="$1"
  discard_failed_offhost_retrieval
  fail "$message"
}

run_adapter_process_tree_bounded() {
  local seconds="$1"
  shift
  local adapter_pid
  local timer_pid
  local adapter_cgroup
  local reason_file
  local owner_error_file
  local status=0

  adapter_cgroup="$(dr_owner_cgroup_v2_create)" || return 78
  reason_file="$(mktemp "${TMPDIR:-/tmp}/lunchlineup-dr-adapter-reason.XXXXXX")" || {
    rmdir -- "${adapter_cgroup}" 2>/dev/null || true
    return 78
  }
  owner_error_file="${reason_file}.owner-error"
  rm -f -- "${reason_file}"
  sh -c 'kill -STOP "$$"; exec "$@"' lunchlineup-dr-adapter-owner "$@" &
  adapter_pid=$!
  if ! dr_owner_cgroup_v2_wait_stopped "${adapter_pid}" \
    || ! printf '%s\n' "${adapter_pid}" >"${adapter_cgroup}/cgroup.procs" \
    || ! grep -Fxq "${adapter_pid}" "${adapter_cgroup}/cgroup.procs"
  then
    kill -KILL "${adapter_pid}" 2>/dev/null || true
    wait "${adapter_pid}" 2>/dev/null || true
    rmdir -- "${adapter_cgroup}" 2>/dev/null || true
    rm -f -- "${reason_file}" "${owner_error_file}"
    echo "ERROR: DR adapter was not started because cgroup v2 ownership could not be established atomically." >&2
    return 78
  fi
  if ! kill -CONT "${adapter_pid}"; then
    kill -KILL "${adapter_pid}" 2>/dev/null || true
    wait "${adapter_pid}" 2>/dev/null || true
    rmdir -- "${adapter_cgroup}" 2>/dev/null || true
    rm -f -- "${reason_file}" "${owner_error_file}"
    echo "ERROR: DR adapter was not started because its cgroup v2 owner could not release the launch barrier." >&2
    return 78
  fi
  (
    sleep "$seconds"
    if dr_owner_cgroup_v2_populated "${adapter_cgroup}"; then
      printf '%s\n' timeout >"${reason_file}"
      dr_owner_cgroup_v2_terminate "${adapter_cgroup}" \
        || printf '%s\n' termination-failed >"${owner_error_file}"
    fi
  ) &
  timer_pid=$!
  if wait "${adapter_pid}"; then status=0; else status=$?; fi
  if dr_owner_cgroup_v2_populated "${adapter_cgroup}"; then
    if [ -s "${reason_file}" ]; then
      wait "${timer_pid}" >/dev/null 2>&1 || true
    else
      kill -TERM "${timer_pid}" >/dev/null 2>&1 || true
      wait "${timer_pid}" >/dev/null 2>&1 || true
      printf '%s\n' descendant-survivor >"${reason_file}"
      dr_owner_cgroup_v2_terminate "${adapter_cgroup}" \
        || printf '%s\n' termination-failed >"${owner_error_file}"
    fi
  else
    kill -TERM "${timer_pid}" >/dev/null 2>&1 || true
    wait "${timer_pid}" >/dev/null 2>&1 || true
  fi
  if [ -s "${owner_error_file}" ] || ! dr_owner_cgroup_v2_empty "${adapter_cgroup}"; then
    echo "ERROR: DR adapter ownership domain could not be proven empty; failed-output cleanup is unsafe." >&2
    return 78
  fi
  rmdir -- "${adapter_cgroup}" || {
    echo "ERROR: DR adapter ownership domain could not be removed after empty proof." >&2
    return 78
  }
  if [ -s "${reason_file}" ]; then
    case "$(head -n 1 "${reason_file}")" in
      timeout) status=124 ;;
      descendant-survivor) status=125 ;;
    esac
  fi
  rm -f -- "${reason_file}" "${owner_error_file}"
  return "$status"
}

retrieve_offhost_backup() {
  [ "${DR_REQUIRE_OFFHOST_SOURCE}" = "true" ] || return 0

  require_command chmod
  require_command env
  require_command node
  require_command sha256sum
  require_command timeout

  local fetch_status
  DR_OFFHOST_FETCH_COMMAND_SHA256="$(sha256sum -- "${DR_OFFHOST_FETCH_COMMAND}" | awk '{print tolower($1)}')"
  if run_adapter_process_tree_bounded \
    "${DR_OFFHOST_FETCH_TIMEOUT_SECONDS}" \
    env \
      DR_FETCH_SOURCE_URI="${DR_OFFHOST_SOURCE_URI}" \
      DR_FETCH_SOURCE_VERSION="${DR_OFFHOST_SOURCE_VERSION}" \
      DR_FETCH_EXPECTED_SHA256="${DR_OFFHOST_EXPECTED_SHA256}" \
      DR_FETCH_COMMAND_SHA256="${DR_OFFHOST_FETCH_COMMAND_SHA256}" \
      DR_FETCH_BACKUP_OUTPUT="${BACKUP_FILE}" \
      "${DR_OFFHOST_FETCH_COMMAND}" >/dev/null 2>&1; then
    fetch_status=0
  else
    fetch_status=$?
  fi

  if [ "$fetch_status" -eq 124 ] || [ "$fetch_status" -eq 137 ]; then
    offhost_retrieval_fail "Off-host backup retrieval timed out after ${DR_OFFHOST_FETCH_TIMEOUT_SECONDS}s; remote state is unknown and no restore was attempted."
  fi
  [ "$fetch_status" -ne 78 ] \
    || offhost_retrieval_fail "Off-host backup retrieval requires a writable delegated cgroup v2 ownership domain; the adapter was not safely runnable."
  [ "$fetch_status" -ne 125 ] \
    || offhost_retrieval_fail "Off-host fetch exited with live descendants; the complete ownership domain was terminated before failed-output cleanup."
  [ "$fetch_status" -eq 0 ] \
    || offhost_retrieval_fail "Off-host backup retrieval failed for the exact declared object/version; no restore was attempted."
  [ "$(sha256sum -- "${DR_OFFHOST_FETCH_COMMAND}" | awk '{print tolower($1)}')" = "${DR_OFFHOST_FETCH_COMMAND_SHA256}" ] \
    || offhost_retrieval_fail "DR_OFFHOST_FETCH_COMMAND changed during retrieval."
  [ -f "${BACKUP_FILE}" ] && [ ! -L "${BACKUP_FILE}" ] && [ -s "${BACKUP_FILE}" ] \
    || offhost_retrieval_fail "Off-host fetch did not create a non-empty regular backup file."
  [ ! -e "${DR_OFFHOST_READBACK_FILE}" ] && [ ! -L "${DR_OFFHOST_READBACK_FILE}" ] \
    || offhost_retrieval_fail "Off-host fetch must not create provider readback evidence."
  chmod 600 -- "${BACKUP_FILE}"

  local fetched_sha256
  local fetched_bytes
  fetched_sha256="$(sha256sum -- "${BACKUP_FILE}" | awk '{print tolower($1)}')"
  fetched_bytes="$(stat -c '%s' -- "${BACKUP_FILE}")"
  [ "$fetched_sha256" = "${DR_OFFHOST_EXPECTED_SHA256}" ] \
    || offhost_retrieval_fail "Retrieved off-host backup does not match DR_OFFHOST_EXPECTED_SHA256."

  local readback_status
  DR_OFFHOST_READBACK_COMMAND_SHA256="$(sha256sum -- "${DR_OFFHOST_READBACK_COMMAND}" | awk '{print tolower($1)}')"
  if run_adapter_process_tree_bounded \
    "${DR_OFFHOST_READBACK_TIMEOUT_SECONDS}" \
    env \
      DR_READBACK_SOURCE_URI="${DR_OFFHOST_SOURCE_URI}" \
      DR_READBACK_REQUESTED_VERSION="${DR_OFFHOST_SOURCE_VERSION}" \
      DR_READBACK_SOURCE_KIND="$(source_kind)" \
      DR_READBACK_COMMAND_SHA256="${DR_OFFHOST_READBACK_COMMAND_SHA256}" \
      DR_READBACK_OUTPUT="${DR_OFFHOST_READBACK_FILE}" \
      "${DR_OFFHOST_READBACK_COMMAND}" >/dev/null 2>&1; then
    readback_status=0
  else
    readback_status=$?
  fi
  if [ "$readback_status" -eq 124 ] || [ "$readback_status" -eq 137 ]; then
    offhost_retrieval_fail "Provider-authenticated off-host readback timed out after ${DR_OFFHOST_READBACK_TIMEOUT_SECONDS}s; metadata state is unknown and no restore was attempted."
  fi
  [ "$readback_status" -ne 78 ] \
    || offhost_retrieval_fail "Provider-authenticated readback requires a writable delegated cgroup v2 ownership domain; the adapter was not safely runnable."
  [ "$readback_status" -ne 125 ] \
    || offhost_retrieval_fail "Provider-authenticated readback exited with live descendants; the complete ownership domain was terminated before failed-output cleanup."
  [ "$readback_status" -eq 0 ] \
    || offhost_retrieval_fail "Independent provider-authenticated version/checksum readback failed; no restore was attempted."
  [ "$(sha256sum -- "${DR_OFFHOST_READBACK_COMMAND}" | awk '{print tolower($1)}')" = "${DR_OFFHOST_READBACK_COMMAND_SHA256}" ] \
    || offhost_retrieval_fail "DR_OFFHOST_READBACK_COMMAND changed during provider readback."
  [ -f "${DR_OFFHOST_READBACK_FILE}" ] && [ ! -L "${DR_OFFHOST_READBACK_FILE}" ] && [ -s "${DR_OFFHOST_READBACK_FILE}" ] \
    || offhost_retrieval_fail "Provider readback did not create the required evidence."
  chmod 600 -- "${DR_OFFHOST_READBACK_FILE}"

  local provider_claims
  local provider_readback_snapshot="${DR_EVIDENCE_SNAPSHOT_DIR}/provider-readback.json"
  snapshot_regular_file_once \
    "${DR_OFFHOST_READBACK_FILE}" \
    "${provider_readback_snapshot}" \
    "Provider-authenticated readback" \
    || offhost_retrieval_fail "Could not bind provider-authenticated readback to one stable private snapshot."
  if ! provider_claims="$(node - \
    "${provider_readback_snapshot}" \
    "${DR_OFFHOST_SOURCE_URI}" \
    "${DR_OFFHOST_SOURCE_VERSION}" \
    "${DR_OFFHOST_EXPECTED_SHA256}" \
    "${fetched_bytes}" \
    "${DR_OFFHOST_READBACK_COMMAND_SHA256}" \
    "$(source_kind)" \
    "${DR_OFFHOST_READBACK_MAX_AGE_SECONDS}" <<'NODE'
const { readFileSync } = require('node:fs');

const [path, sourceUri, sourceVersion, expectedSha256, expectedBytesText, readbackCommandSha256, sourceKind, maxAgeSecondsText] = process.argv.slice(2);
let proof;
let proofBytes;
try {
  proofBytes = readFileSync(path);
  proof = JSON.parse(proofBytes.toString('utf8'));
} catch {
  process.exit(1);
}
const observedAt = Date.parse(proof?.observedAt);
const now = Date.now();
const maxAgeMs = Number(maxAgeSecondsText) * 1000;
const safeIdentity = (value, minimum, maximum) => (
  typeof value === 'string'
  && value.length >= minimum
  && value.length <= maximum
  && /^[\x21-\x7e]+$/.test(value)
);
if (
  !proof
  || typeof proof !== 'object'
  || Array.isArray(proof)
  || proofBytes.byteLength > 64 * 1024
  || proof.version !== 2
  || proof.kind !== 'lunchlineup-provider-authenticated-object-readback'
  || proof.sourceKind !== sourceKind
  || proof.sourceUri !== sourceUri
  || proof.requestedVersion !== sourceVersion
  || proof.resolvedVersion !== sourceVersion
  || proof.objectChecksum?.algorithm !== 'sha256'
  || proof.objectChecksum?.value !== expectedSha256
  || proof.bytes !== Number(expectedBytesText)
  || proof.readbackCommandSha256 !== readbackCommandSha256
  || proof.authentication?.status !== 'verified'
  || proof.authentication?.mechanism !== 'provider-api'
  || !safeIdentity(proof.authentication?.principal, 3, 512)
  || !safeIdentity(proof.authentication?.requestId, 8, 256)
  || !Number.isFinite(observedAt)
  || observedAt > now + 30_000
  || now - observedAt > maxAgeMs
) process.exit(1);
process.stdout.write([
  proof.resolvedVersion,
  proof.authentication.principal,
  proof.authentication.requestId,
  new Date(observedAt).toISOString(),
  proofBytes.toString('base64'),
].join('\t'));
NODE
  )"; then
    offhost_retrieval_fail "Provider-authenticated readback does not independently bind the exact URI, resolved version, checksum, bytes, identity, request, and fresh observation time."
  fi

  IFS=$'\t' read -r \
    DR_OFFHOST_PROVIDER_VERSION \
    DR_OFFHOST_READBACK_PRINCIPAL \
    DR_OFFHOST_READBACK_REQUEST_ID \
    DR_OFFHOST_READBACK_OBSERVED_AT \
    DR_OFFHOST_READBACK_BASE64 <<<"${provider_claims}"
  [ -n "${DR_OFFHOST_READBACK_BASE64}" ] \
    || offhost_retrieval_fail "Provider-authenticated readback normalization failed."

  DR_OFFHOST_READBACK_SHA256="$(sha256sum -- "${provider_readback_snapshot}" | awk '{print tolower($1)}')"
  DR_OFFHOST_RETRIEVED_BYTES="${fetched_bytes}"
  DR_OFFHOST_READBACK_VERIFIED=true
  printf '%s  %s\n' "${DR_OFFHOST_EXPECTED_SHA256}" "$(basename "${BACKUP_FILE}")" >"${BACKUP_FILE}.sha256"
  chmod 600 -- "${BACKUP_FILE}.sha256"
}

validate_backup_file() {
  [ -n "${BACKUP_FILE}" ] || fail "No encrypted .sql.zst.gpg backups found in ${BACKUP_DIR}."
  [ -f "${BACKUP_FILE}" ] || fail "Backup file not found: ${BACKUP_FILE}"

  case "$(basename "${BACKUP_FILE}")" in
    latest | latest.*)
      fail "Refusing vague drill target '${BACKUP_FILE}'. Pass an explicit encrypted backup path."
      ;;
    -*)
      fail "Backup input filename must not start with '-'."
      ;;
    *.sql.zst.gpg)
      ;;
    *)
      fail "DR drill input must be an encrypted .sql.zst.gpg backup."
      ;;
  esac
}

verify_backup_checksum() {
  local checksum_file="${BACKUP_FILE}.sha256"

  if [ -f "${checksum_file}" ]; then
    require_command sha256sum
    (
      cd "$(dirname "${BACKUP_FILE}")"
      sha256sum -c "$(basename "${checksum_file}")"
    )
  elif [ "${DR_REQUIRE_CHECKSUM}" = "true" ]; then
    fail "Checksum file is required by default: ${checksum_file}. Set DR_REQUIRE_CHECKSUM=false only for an explicitly approved local drill."
  fi

  require_command sha256sum
  BACKUP_SHA256_LINE="$(sha256sum "${BACKUP_FILE}")"
  BACKUP_SHA256="${BACKUP_SHA256_LINE%% *}"
}

source_kind() {
  case "${DR_OFFHOST_SOURCE_URI}" in
    s3://*) printf 's3' ;;
    rclone:*) printf 'rclone' ;;
    rsync://*) printf 'rsync' ;;
    scp://*) printf 'scp' ;;
    ssh://*) printf 'ssh' ;;
    https://*) printf 'https' ;;
    restic:*) printf 'restic' ;;
    b2://*) printf 'b2' ;;
    '') printf 'local' ;;
    *) printf 'other' ;;
  esac
}

write_dr_proof() {
  local completed_at="$1"
  local completed_epoch="$2"
  local proof_dir
  local tmp_proof_file

  proof_dir="$(dirname "${DR_PROOF_FILE}")"
  mkdir -p "${proof_dir}"
  tmp_proof_file="$(mktemp "${proof_dir}/lunchlineup-dr-proof.json.tmp.XXXXXX")"
  DR_TMP_PROOF_FILE="${tmp_proof_file}"

  run_pipeline_bounded "DR success proof write" "${DR_DOCKER_OPERATION_TIMEOUT_SECONDS}" \
    bash -c 'cat >"$1"' _ "${tmp_proof_file}" <<PROOF
{
  "status": "ok",
  "source_sha": "$(json_escape "${DR_SOURCE_SHA}")",
  "checked_at": "$(json_escape "${completed_at}")",
  "started_at": "$(json_escape "${DR_STARTED_AT}")",
  "completed_at": "$(json_escape "${completed_at}")",
  "duration_seconds": $((completed_epoch - DR_STARTED_EPOCH)),
  "backup_file": "$(json_escape "${BACKUP_DECLARED_FILE}")",
  "backup_sha256": "$(json_escape "${BACKUP_SHA256}")",
  "checksum_file": "$(json_escape "${BACKUP_DECLARED_CHECKSUM_FILE}")",
  "source_uri": "$(json_escape "${DR_OFFHOST_SOURCE_URI}")",
  "source_kind": "$(source_kind)",
  "source_version": "$(json_escape "${DR_OFFHOST_SOURCE_VERSION}")",
  "source_provider_version": "$(json_escape "${DR_OFFHOST_PROVIDER_VERSION}")",
  "source_expected_sha256": "$(json_escape "${DR_OFFHOST_EXPECTED_SHA256}")",
  "source_retrieved_bytes": ${DR_OFFHOST_RETRIEVED_BYTES},
  "source_readback_file": "$(json_escape "${DR_OFFHOST_READBACK_DECLARED_FILE}")",
  "source_readback_sha256": "$(json_escape "${DR_OFFHOST_READBACK_SHA256}")",
  "source_readback_base64": "$(json_escape "${DR_OFFHOST_READBACK_BASE64}")",
  "source_readback_verified": ${DR_OFFHOST_READBACK_VERIFIED},
  "source_readback_principal": "$(json_escape "${DR_OFFHOST_READBACK_PRINCIPAL}")",
  "source_readback_request_id": "$(json_escape "${DR_OFFHOST_READBACK_REQUEST_ID}")",
  "source_readback_observed_at": "$(json_escape "${DR_OFFHOST_READBACK_OBSERVED_AT}")",
  "source_fetch_command_sha256": "$(json_escape "${DR_OFFHOST_FETCH_COMMAND_SHA256}")",
  "source_readback_command_sha256": "$(json_escape "${DR_OFFHOST_READBACK_COMMAND_SHA256}")",
  "source_adapter_attestation_uri": "$(json_escape "${DR_RECOVERY_ADAPTER_ATTESTATION_URI}")",
  "source_adapter_attestation_sha256": "$(json_escape "${DR_RECOVERY_ADAPTER_ATTESTATION_SHA256}")",
  "source_adapter_signature_bundle_uri": "$(json_escape "${DR_RECOVERY_ADAPTER_SIGNATURE_BUNDLE_URI}")",
  "source_adapter_signature_bundle_sha256": "$(json_escape "${DR_RECOVERY_ADAPTER_SIGNATURE_BUNDLE_SHA256}")",
  "source_adapter_certificate_identity": "$(json_escape "${DR_RECOVERY_ADAPTER_CERTIFICATE_IDENTITY}")",
  "source_adapter_oidc_issuer": "$(json_escape "${DR_RECOVERY_ADAPTER_OIDC_ISSUER}")",
  "dr_image": "$(json_escape "${DR_IMAGE}")",
  "container": "$(json_escape "${DR_CONTAINER}")",
  "container_id": "$(json_escape "${DR_CONTAINER_ID}")",
  "cleanup_status": "succeeded",
  "cleanup_container": "$(json_escape "${DR_CONTAINER}")",
  "cleanup_container_id": "$(json_escape "${DR_CONTAINER_ID}")",
  "cleanup_container_absent": true,
  "cleanup_container_id_absent": true,
  "cleanup_container_name_absent": true,
  "cleanup_checked_at": "$(json_escape "${DR_CLEANUP_CONFIRMED_AT}")",
  "cleanup_evidence": "docker-ps-exact-name-v1",
  "cleanup_id_evidence": "docker-ps-exact-id-v1",
  "database": "$(json_escape "${DR_DB}")",
  "restored_table_count": ${RESTORED_TABLE_COUNT},
  "sanity_result": "$(json_escape "${SANITY_RESULT}")"
}
PROOF

  run_pipeline_bounded "DR success proof publication" "${DR_DOCKER_OPERATION_TIMEOUT_SECONDS}" \
    mv "${tmp_proof_file}" "${DR_PROOF_FILE}"
  DR_TMP_PROOF_FILE=""
}

run_container_operation() {
  if [ "${DR_PIPELINE_ACTIVE:-false}" = "true" ] && [ "${DR_EMERGENCY_CLEANUP:-false}" != "true" ]; then
    run_pipeline_bounded "$@"
  else
    run_bounded "$@"
  fi
}

read_dr_container_name_ids() {
  run_container_operation "Docker container lookup" "$DR_DOCKER_OPERATION_TIMEOUT_SECONDS" \
    docker ps -a --no-trunc --filter "name=^/${DR_CONTAINER}$" --format '{{.ID}}'
}

read_dr_container_id_matches() {
  [ -n "${DR_CONTAINER_ID}" ] || return 0
  run_container_operation "Docker container ID lookup" "$DR_DOCKER_OPERATION_TIMEOUT_SECONDS" \
    docker ps -a --no-trunc --filter "id=${DR_CONTAINER_ID}" --format '{{.ID}}'
}

confirm_dr_container_identity() {
  local id_matches
  local name_ids
  id_matches="$(read_dr_container_id_matches)" \
    || { echo "ERROR: Could not read back the captured DR container ID." >&2; return 1; }
  name_ids="$(read_dr_container_name_ids)" \
    || { echo "ERROR: Could not read back the DR container name binding." >&2; return 1; }
  [ "${id_matches}" = "${DR_CONTAINER_ID}" ] && [ "${name_ids}" = "${DR_CONTAINER_ID}" ] \
    || { echo "ERROR: DR container name/ID binding changed; refusing a rename or replacement race." >&2; return 1; }
}

confirm_dr_container_absent() {
  local id_matches
  local name_ids
  if ! id_matches="$(read_dr_container_id_matches)"; then
    echo "ERROR: Could not independently read back DR container ID absence for ${DR_CONTAINER_ID}." >&2
    return 1
  fi
  if ! name_ids="$(read_dr_container_name_ids)"; then
    echo "ERROR: Could not independently read back DR container name absence for ${DR_CONTAINER}." >&2
    return 1
  fi
  if [ -n "${id_matches}" ]; then
    echo "ERROR: Captured DR container ID remains after cleanup: ${DR_CONTAINER_ID}." >&2
    return 1
  fi
  if [ -n "${name_ids}" ]; then
    echo "ERROR: A renamed or replacement container owns the DR container name after cleanup: ${DR_CONTAINER}." >&2
    return 1
  fi
  DR_CLEANUP_CONFIRMED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

cleanup_dr_container() {
  local id_matches
  local name_ids
  local cleanup_failed=false

  if ! id_matches="$(read_dr_container_id_matches)"; then
    echo "ERROR: DR container ID lookup failed during cleanup; container state is unknown: ${DR_CONTAINER_ID}." >&2
    return 1
  fi
  if ! name_ids="$(read_dr_container_name_ids)"; then
    echo "ERROR: DR container name lookup failed during cleanup; container state is unknown: ${DR_CONTAINER}." >&2
    return 1
  fi
  if [ -n "${DR_CONTAINER_ID}" ] && { [ "${id_matches}" != "${DR_CONTAINER_ID}" ] || [ "${name_ids}" != "${DR_CONTAINER_ID}" ]; }; then
    echo "ERROR: DR container name/ID binding changed before cleanup; rejecting rename or replacement race." >&2
    cleanup_failed=true
  fi
  if [ "${id_matches}" = "${DR_CONTAINER_ID}" ] && [ -n "${DR_CONTAINER_ID}" ]; then
    if ! run_container_operation "DR container cleanup" "$DR_CLEANUP_TIMEOUT_SECONDS" \
      docker rm -f "${DR_CONTAINER_ID}" >/dev/null 2>&1; then
      echo "ERROR: DR container cleanup failed or timed out; inspect captured ID ${DR_CONTAINER_ID} without repeating restore mutation." >&2
      cleanup_failed=true
    fi
  elif [ -z "${DR_CONTAINER_ID}" ] && [ -n "${name_ids}" ]; then
    echo "ERROR: A container appeared under the reserved DR name before this drill captured an ID; it was not removed." >&2
    cleanup_failed=true
  fi
  confirm_dr_container_absent || cleanup_failed=true
  [ "${cleanup_failed}" = "false" ]
}

invalidate_dr_success_artifact() {
  local invalidation_failed=false

  if [ -n "${DR_TMP_PROOF_FILE:-}" ]; then
    rm -f -- "${DR_TMP_PROOF_FILE}" || invalidation_failed=true
  fi
  rm -f -- "${DR_PROOF_FILE}" || invalidation_failed=true
  [ ! -e "${DR_PROOF_FILE}" ] && [ ! -L "${DR_PROOF_FILE}" ] || invalidation_failed=true
  if [ "${invalidation_failed}" = "true" ]; then
    echo "ERROR: Could not invalidate DR success proof after cleanup uncertainty: ${DR_PROOF_FILE}." >&2
    return 1
  fi
}

prepare_dr_proof_destination() {
  local proof_dir

  case "${DR_PROOF_FILE}" in
    /* | [A-Za-z]:/*) ;;
    *) fail "DR_PROOF_FILE must be an absolute path." ;;
  esac
  proof_dir="$(dirname "${DR_PROOF_FILE}")"
  mkdir -p "${proof_dir}"
  [ -d "${proof_dir}" ] && [ ! -L "${proof_dir}" ] \
    || fail "DR_PROOF_FILE parent must be a non-symlink directory."
  invalidate_dr_success_artifact \
    || fail "Could not clear prior DR success evidence before the drill."
}

verify_written_dr_proof() {
  run_pipeline_bounded "DR success proof readback" "${DR_DOCKER_OPERATION_TIMEOUT_SECONDS}" \
    node - "${DR_PROOF_FILE}" "${DR_CONTAINER}" "${DR_CONTAINER_ID}" "${DR_CLEANUP_CONFIRMED_AT}" <<'NODE'
const { readFileSync } = require('node:fs');
const [path, container, containerId, cleanupCheckedAt] = process.argv.slice(2);
let proof;
try { proof = JSON.parse(readFileSync(path, 'utf8')); } catch { process.exit(1); }
if (
  proof?.status !== 'ok'
  || !/^[a-f0-9]{64}$/.test(containerId)
  || proof?.container_id !== containerId
  || proof?.cleanup_status !== 'succeeded'
  || proof?.cleanup_container !== container
  || proof?.cleanup_container_id !== containerId
  || proof?.cleanup_container_absent !== true
  || proof?.cleanup_container_id_absent !== true
  || proof?.cleanup_container_name_absent !== true
  || proof?.cleanup_checked_at !== cleanupCheckedAt
  || proof?.cleanup_evidence !== 'docker-ps-exact-name-v1'
  || proof?.cleanup_id_evidence !== 'docker-ps-exact-id-v1'
) process.exit(1);
NODE
}

run_bounded() {
  local label="$1"
  local seconds="$2"
  shift 2
  local status=0
  timeout --foreground --signal=TERM --kill-after=5s "${seconds}s" "$@" || status=$?
  if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
    echo "ERROR: ${label} timed out after ${seconds}s; operation state is unknown." >&2
  fi
  return "$status"
}

pipeline_remaining_seconds() {
  local remaining=$((DR_PIPELINE_DEADLINE_EPOCH - $(date -u +%s)))
  [ "${remaining}" -ge 1 ] || return 1
  printf '%s' "${remaining}"
}

run_pipeline_bounded() {
  local label="$1"
  local phase_seconds="$2"
  shift 2
  local remaining
  local effective
  local status=0
  remaining="$(pipeline_remaining_seconds)" || {
    echo "ERROR: DR restore pipeline deadline exhausted before ${label}; no success evidence is valid." >&2
    return 124
  }
  effective="${phase_seconds}"
  if [ "${remaining}" -lt "${effective}" ]; then effective="${remaining}"; fi
  timeout --signal=TERM --kill-after=5s "${effective}s" "$@" || status=$?
  if [ "${status}" -eq 124 ] || [ "${status}" -eq 137 ]; then
    echo "ERROR: DR restore pipeline deadline or ${label} phase limit was exhausted; operation state is unknown." >&2
  fi
  return "${status}"
}

DR_TIMESTAMP="$(date -u +%Y%m%d%H%M%S)"
DR_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DR_STARTED_EPOCH="$(date -u +%s)"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_FILE="${BACKUP_FILE:-}"
BACKUP_DECLARED_FILE=""
BACKUP_DECLARED_CHECKSUM_FILE=""
DR_OFFHOST_SOURCE_URI="${DR_OFFHOST_SOURCE_URI:-${BACKUP_OFFSITE_URI:-}}"
DR_OFFHOST_SOURCE_VERSION="${DR_OFFHOST_SOURCE_VERSION:-}"
DR_OFFHOST_EXPECTED_SHA256="${DR_OFFHOST_EXPECTED_SHA256:-}"
DR_OFFHOST_FETCH_COMMAND="${DR_OFFHOST_FETCH_COMMAND:-}"
DR_OFFHOST_FETCH_COMMAND_DECLARED="${DR_OFFHOST_FETCH_COMMAND}"
DR_OFFHOST_FETCH_COMMAND_SHA256=""
DR_OFFHOST_FETCH_TIMEOUT_SECONDS="${DR_OFFHOST_FETCH_TIMEOUT_SECONDS:-300}"
DR_OFFHOST_READBACK_COMMAND="${DR_OFFHOST_READBACK_COMMAND:-}"
DR_OFFHOST_READBACK_COMMAND_DECLARED="${DR_OFFHOST_READBACK_COMMAND}"
DR_OFFHOST_READBACK_COMMAND_SHA256=""
DR_OFFHOST_READBACK_TIMEOUT_SECONDS="${DR_OFFHOST_READBACK_TIMEOUT_SECONDS:-120}"
DR_OFFHOST_READBACK_MAX_AGE_SECONDS="${DR_OFFHOST_READBACK_MAX_AGE_SECONDS:-300}"
DR_OFFHOST_READBACK_FILE="${DR_OFFHOST_READBACK_FILE:-}"
DR_OFFHOST_READBACK_DECLARED_FILE="${DR_OFFHOST_READBACK_FILE}"
DR_OFFHOST_READBACK_SHA256=""
DR_OFFHOST_READBACK_BASE64=""
DR_OFFHOST_PROVIDER_VERSION=""
DR_OFFHOST_READBACK_PRINCIPAL=""
DR_OFFHOST_READBACK_REQUEST_ID=""
DR_OFFHOST_READBACK_OBSERVED_AT=""
DR_OFFHOST_RETRIEVED_BYTES=0
DR_OFFHOST_READBACK_VERIFIED=false
DR_RECOVERY_ADAPTER_ATTESTATION_FILE="${DR_RECOVERY_ADAPTER_ATTESTATION_FILE:-}"
DR_RECOVERY_ADAPTER_SIGNATURE_BUNDLE_FILE="${DR_RECOVERY_ADAPTER_SIGNATURE_BUNDLE_FILE:-}"
DR_RECOVERY_ADAPTER_ATTESTATION_DECLARED_FILE="${DR_RECOVERY_ADAPTER_ATTESTATION_FILE}"
DR_RECOVERY_ADAPTER_SIGNATURE_BUNDLE_DECLARED_FILE="${DR_RECOVERY_ADAPTER_SIGNATURE_BUNDLE_FILE}"
DR_RECOVERY_ADAPTER_ATTESTATION_URI="${DR_RECOVERY_ADAPTER_ATTESTATION_URI:-}"
DR_RECOVERY_ADAPTER_SIGNATURE_BUNDLE_URI="${DR_RECOVERY_ADAPTER_SIGNATURE_BUNDLE_URI:-}"
DR_RECOVERY_ADAPTER_CERTIFICATE_IDENTITY="${DR_RECOVERY_ADAPTER_CERTIFICATE_IDENTITY:-}"
DR_RECOVERY_ADAPTER_OIDC_ISSUER="${DR_RECOVERY_ADAPTER_OIDC_ISSUER:-}"
DR_RECOVERY_ADAPTER_ATTESTATION_SHA256=""
DR_RECOVERY_ADAPTER_SIGNATURE_BUNDLE_SHA256=""
DR_REQUIRE_OFFHOST_SOURCE="${DR_REQUIRE_OFFHOST_SOURCE:-true}"
DR_REQUIRE_CHECKSUM="${DR_REQUIRE_CHECKSUM:-true}"
DR_IMAGE="${DR_IMAGE:-postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777}"
DR_CONTAINER="${DR_CONTAINER:-lunchlineup-dr-drill-${DR_TIMESTAMP}-$$}"
DR_USER="${DR_USER:-drill}"
DR_PASSWORD="${DR_PASSWORD:-lunchlineup_drill_${DR_TIMESTAMP}_$$}"
DR_DB="${DR_DB:-lunchlineup_drill}"
DR_WAIT_SECONDS="${DR_WAIT_SECONDS:-45}"
DR_REQUIRE_TABLES="${DR_REQUIRE_TABLES:-true}"
DR_DOCKER_OPERATION_TIMEOUT_SECONDS="${DR_DOCKER_OPERATION_TIMEOUT_SECONDS:-60}"
DR_DECRYPT_TIMEOUT_SECONDS="${DR_DECRYPT_TIMEOUT_SECONDS:-300}"
DR_ZSTD_TIMEOUT_SECONDS="${DR_ZSTD_TIMEOUT_SECONDS:-300}"
DR_PSQL_TIMEOUT_SECONDS="${DR_PSQL_TIMEOUT_SECONDS:-300}"
DR_CLEANUP_TIMEOUT_SECONDS="${DR_CLEANUP_TIMEOUT_SECONDS:-30}"
DR_RESTORE_PIPELINE_TIMEOUT_SECONDS="${DR_RESTORE_PIPELINE_TIMEOUT_SECONDS:-600}"
DR_PROOF_FILE="${DR_PROOF_FILE:-${TMPDIR:-/tmp}/lunchlineup-dr-drill-${DR_TIMESTAMP}.json}"
DR_SOURCE_SHA="${DR_SOURCE_SHA:-}"
DR_TABLE_COUNT_SQL="SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type = 'BASE TABLE';"
DR_SANITY_SQL="${DR_SANITY_SQL:-${DR_TABLE_COUNT_SQL}}"
CONTAINER_STARTED="false"
DR_CONTAINER_ID=""
DR_DOCKER_ENV_FILE=""
DR_CLEANUP_CONFIRMED_AT=""
DR_TMP_PROOF_FILE=""
DR_SUCCESS_FINALIZED=false
DR_BACKUP_SNAPSHOT_DIR=""
DR_EVIDENCE_SNAPSHOT_DIR=""
DR_PIPELINE_ACTIVE=false
DR_PIPELINE_DEADLINE_EPOCH=0
DR_EMERGENCY_CLEANUP=false

if [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

cleanup_pre_container_evidence() {
  local exit_code=$?
  trap - EXIT
  if [ -n "${DR_EVIDENCE_SNAPSHOT_DIR}" ]; then
    rm -rf -- "${DR_EVIDENCE_SNAPSHOT_DIR}" || exit_code=1
  fi
  exit "${exit_code}"
}
trap cleanup_pre_container_evidence EXIT

prepare_dr_proof_destination
validate_dr_settings
select_backup_file
prepare_offhost_destination
retrieve_offhost_backup
validate_backup_file
cleanup() {
  local exit_code=$?
  local cleanup_failed=false
  trap - EXIT
  set +e
  DR_EMERGENCY_CLEANUP=true
  if [ "${DR_SUCCESS_FINALIZED}" != "true" ]; then
    cleanup_dr_container || cleanup_failed=true
    invalidate_dr_success_artifact || cleanup_failed=true
  fi
  if [ -n "${DR_DOCKER_ENV_FILE}" ]; then
    rm -f -- "${DR_DOCKER_ENV_FILE}" || cleanup_failed=true
  fi
  if [ -n "${DR_BACKUP_SNAPSHOT_DIR}" ]; then
    rm -rf -- "${DR_BACKUP_SNAPSHOT_DIR}" || cleanup_failed=true
  fi
  if [ -n "${DR_EVIDENCE_SNAPSHOT_DIR}" ]; then
    rm -rf -- "${DR_EVIDENCE_SNAPSHOT_DIR}" || cleanup_failed=true
  fi
  if [ "${cleanup_failed}" = "true" ]; then
    exit_code=1
  fi
  exit "${exit_code}"
}
trap cleanup EXIT
snapshot_backup_input
verify_backup_checksum

require_command docker
require_command gpg
require_command zstd
require_command timeout
require_command sed
require_command tr
require_command mktemp

if ! initial_container_matches="$(read_dr_container_name_ids)"; then
  fail "Could not independently verify the initial DR container state: ${DR_CONTAINER}."
fi
if [ -n "${initial_container_matches}" ]; then
  fail "DR_CONTAINER already exists: ${DR_CONTAINER}. Pick a new lunchlineup-dr-drill-* name."
fi

BACKUP_KEY="$(read_backup_key)"
DR_DOCKER_ENV_FILE="$(mktemp "${TMPDIR:-/tmp}/lunchlineup-dr-docker-env.XXXXXX")"
printf 'POSTGRES_USER=%s\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=%s\nPGPASSWORD=%s\n' \
  "${DR_USER}" "${DR_PASSWORD}" "${DR_DB}" "${DR_PASSWORD}" >"${DR_DOCKER_ENV_FILE}"
chmod 600 -- "${DR_DOCKER_ENV_FILE}"

echo "Starting disaster recovery drill from ${BACKUP_DECLARED_FILE}..."

DR_PIPELINE_DEADLINE_EPOCH=$(( $(date -u +%s) + DR_RESTORE_PIPELINE_TIMEOUT_SECONDS ))
DR_PIPELINE_ACTIVE=true
DR_CONTAINER_ID="$(run_pipeline_bounded "Docker restore container start" "$DR_DOCKER_OPERATION_TIMEOUT_SECONDS" docker run \
  -d \
  --name "${DR_CONTAINER}" \
  --env-file "${DR_DOCKER_ENV_FILE}" \
  "${DR_IMAGE}")"
[[ "${DR_CONTAINER_ID}" =~ ^[a-f0-9]{64}$ ]] \
  || fail "Docker did not return one full immutable container ID for the DR restore container."
CONTAINER_STARTED="true"
confirm_dr_container_identity \
  || fail "Could not prove the newly started DR container's exact name/ID binding."

ready="false"
for ((attempt = 1; attempt <= DR_WAIT_SECONDS; attempt++)); do
  if run_pipeline_bounded "Docker Postgres readiness check" "$DR_DOCKER_OPERATION_TIMEOUT_SECONDS" \
    docker exec "${DR_CONTAINER_ID}" pg_isready -U "${DR_USER}" -d "${DR_DB}" >/dev/null 2>&1; then
    ready="true"
    break
  fi
  pipeline_remaining_seconds >/dev/null \
    || fail "DR restore pipeline deadline exhausted while waiting for Postgres readiness."
  sleep 1
done

[ "${ready}" = "true" ] || fail "Ephemeral Postgres did not become ready."

if ! run_pipeline_bounded "Backup decryption" "$DR_DECRYPT_TIMEOUT_SECONDS" gpg \
  --decrypt \
  --batch \
  --yes \
  --pinentry-mode loopback \
  --passphrase-fd 3 \
  "${BACKUP_FILE}" \
  3<<<"${BACKUP_KEY}" \
  | run_pipeline_bounded "Backup decompression" "$DR_ZSTD_TIMEOUT_SECONDS" zstd -d -c \
  | run_pipeline_bounded "Postgres restore" "$DR_PSQL_TIMEOUT_SECONDS" docker exec \
      -i \
      "${DR_CONTAINER_ID}" \
      psql \
        -U "${DR_USER}" \
        -d "${DR_DB}" \
        -v ON_ERROR_STOP=1 \
        --single-transaction
then
  fail "Bounded decrypt/decompress/psql restore pipeline failed or timed out; the single transaction was not accepted as a successful restore."
fi

RESTORED_TABLE_COUNT="$(
  run_pipeline_bounded "Restored table-count query" "$DR_PSQL_TIMEOUT_SECONDS" docker exec \
    "${DR_CONTAINER_ID}" \
    psql \
      -U "${DR_USER}" \
      -d "${DR_DB}" \
      -At \
      -v ON_ERROR_STOP=1 \
      -c "${DR_TABLE_COUNT_SQL}"
)"

SANITY_RESULT="$(
  run_pipeline_bounded "DR sanity query" "$DR_PSQL_TIMEOUT_SECONDS" docker exec \
    "${DR_CONTAINER_ID}" \
    psql \
      -U "${DR_USER}" \
      -d "${DR_DB}" \
      -At \
      -v ON_ERROR_STOP=1 \
      -c "${DR_SANITY_SQL}" \
    | tr '\n' ' ' \
    | sed 's/[[:space:]]*$//'
)"

[ -n "${SANITY_RESULT}" ] || fail "DR sanity query returned no result."

if [ "${DR_REQUIRE_TABLES}" = "true" ] && [ "${RESTORED_TABLE_COUNT}" = "0" ]; then
  fail "DR sanity query found zero application tables."
fi

cleanup_dr_container \
  || fail "DR restore checks passed, but cleanup or exact container-absence readback failed; no success proof is valid."
CONTAINER_STARTED="false"
pipeline_remaining_seconds >/dev/null \
  || fail "DR restore pipeline deadline exhausted before success proof creation."
DR_COMPLETED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DR_COMPLETED_EPOCH="$(date -u +%s)"
write_dr_proof "${DR_COMPLETED_AT}" "${DR_COMPLETED_EPOCH}"
verify_written_dr_proof \
  || fail "DR proof readback did not bind successful cleanup and exact container absence."
pipeline_remaining_seconds >/dev/null \
  || fail "DR restore pipeline deadline exhausted before success finalization."
DR_SUCCESS_FINALIZED=true

echo "DR drill successful. Sanity result: ${SANITY_RESULT}"
printf 'dr_drill_ok backup_sha256=%s restored_table_count=%s source_kind=%s proof_file=%s cleanup=container-absent cleanup_checked_at=%s completed_at=%s\n' \
  "${BACKUP_SHA256}" \
  "${RESTORED_TABLE_COUNT}" \
  "$(source_kind)" \
  "${DR_PROOF_FILE}" \
  "${DR_CLEANUP_CONFIRMED_AT}" \
  "${DR_COMPLETED_AT}"
