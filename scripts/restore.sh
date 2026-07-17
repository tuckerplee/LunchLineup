#!/bin/bash
# scripts/restore.sh
# Fail-closed restore helper for encrypted LunchLineup Postgres backups.
set -euo pipefail
IFS=$'\n\t'
umask 077

usage() {
  cat >&2 <<'USAGE'
Usage: RESTORE_TARGET_ENV=<disposable|staging|development|production> RESTORE_CONFIRM=restore-<db> ./scripts/restore.sh <backup.sql.zst.gpg>

Required:
  BACKUP_ENCRYPTION_KEY_FILE or BACKUP_ENCRYPTION_KEY
  APP_DB_USER, APP_DB_PASSWORD, PLATFORM_ADMIN_DB_CONTEXT_SECRET
  MIGRATION_DATABASE_URL (owner connection for provision-app-db-role.mjs)
  RESTORE_TARGET_ENV
  RESTORE_CONFIRM=restore-<POSTGRES_DB>
  RESTORE_REQUIRE_CHECKSUM=true

Production restore also requires:
  RESTORE_ALLOW_PRODUCTION=YES_RESTORE_PRODUCTION
  RESTORE_DR_PROVENANCE_FILE and RESTORE_DR_PROVENANCE_SHA256
  RESTORE_DR_SOURCE_URI and RESTORE_DR_SOURCE_VERSION
  RESTORE_DR_ADAPTER_ATTESTATION_FILE and RESTORE_DR_ADAPTER_SIGNATURE_BUNDLE_FILE
  RESTORE_DR_ADAPTER_ATTESTATION_URI and RESTORE_DR_ADAPTER_SIGNATURE_BUNDLE_URI
  RESTORE_DR_ADAPTER_CERTIFICATE_IDENTITY and RESTORE_DR_ADAPTER_OIDC_ISSUER
  RESTORE_DR_EXECUTION_ATTESTATION_FILE and RESTORE_DR_EXECUTION_SIGNATURE_BUNDLE_FILE
  RESTORE_DR_EXECUTION_ATTESTATION_URI and RESTORE_DR_EXECUTION_SIGNATURE_BUNDLE_URI
  RESTORE_DR_RELEASE_SHA
  RESTORE_PRODUCTION_TARGET_DESCRIPTOR_FILE and RESTORE_PRODUCTION_TARGET_DESCRIPTOR_SHA256
  RESTORE_PRODUCTION_TARGET_PIN_FILE and RESTORE_PRODUCTION_TARGET_PIN_SIGNATURE_BUNDLE_FILE
  RESTORE_PRODUCTION_CLUSTER_ID

Non-empty target databases also require:
  RESTORE_ALLOW_NONEMPTY=YES_OVERWRITE

Postgres-only DR after RabbitMQ volume loss:
  RESTORE_REHYDRATE_DURABLE_QUEUES=true
USAGE
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

RECOVERY_EXECUTION_CERTIFICATE_IDENTITY='https://github.com/tuckerplee/LunchLineup/.github/workflows/ci.yml@refs/heads/main'
RECOVERY_EXECUTION_OIDC_ISSUER='https://token.actions.githubusercontent.com'

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command is missing: $1"
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

validate_postgres_identifier() {
  case "$2" in
    '' | *[!A-Za-z0-9_]* | [0-9]*)
      fail "$1 must be a simple Postgres identifier."
      ;;
  esac
}

validate_restore_settings() {
  validate_bool RESTORE_REQUIRE_CHECKSUM "${RESTORE_REQUIRE_CHECKSUM}"
  validate_bool RESTORE_REHYDRATE_DURABLE_QUEUES "${RESTORE_REHYDRATE_DURABLE_QUEUES}"
  validate_postgres_identifier POSTGRES_DB "${POSTGRES_DB}"
  validate_postgres_identifier POSTGRES_USER "${POSTGRES_USER}"
  is_unsigned_integer "${POSTGRES_PORT}" || fail "POSTGRES_PORT must be a positive integer."
  [ "${POSTGRES_PORT}" -ge 1 ] && [ "${POSTGRES_PORT}" -le 65535 ] || fail "POSTGRES_PORT must be between 1 and 65535."
  is_unsigned_integer "${RESTORE_SIGNATURE_VERIFY_TIMEOUT_SECONDS}" || fail "RESTORE_SIGNATURE_VERIFY_TIMEOUT_SECONDS must be a positive integer."
  [ "${RESTORE_SIGNATURE_VERIFY_TIMEOUT_SECONDS}" -ge 1 ] && [ "${RESTORE_SIGNATURE_VERIFY_TIMEOUT_SECONDS}" -le 300 ] \
    || fail "RESTORE_SIGNATURE_VERIFY_TIMEOUT_SECONDS must be between 1 and 300."
  is_unsigned_integer "${RESTORE_DB_READ_TIMEOUT_SECONDS}" || fail "RESTORE_DB_READ_TIMEOUT_SECONDS must be a positive integer."
  [ "${RESTORE_DB_READ_TIMEOUT_SECONDS}" -ge 1 ] && [ "${RESTORE_DB_READ_TIMEOUT_SECONDS}" -le 120 ] \
    || fail "RESTORE_DB_READ_TIMEOUT_SECONDS must be between 1 and 120."
  is_unsigned_integer "${RESTORE_EVIDENCE_SNAPSHOT_TIMEOUT_SECONDS}" || fail "RESTORE_EVIDENCE_SNAPSHOT_TIMEOUT_SECONDS must be a positive integer."
  [ "${RESTORE_EVIDENCE_SNAPSHOT_TIMEOUT_SECONDS}" -ge 1 ] && [ "${RESTORE_EVIDENCE_SNAPSHOT_TIMEOUT_SECONDS}" -le 60 ] \
    || fail "RESTORE_EVIDENCE_SNAPSHOT_TIMEOUT_SECONDS must be between 1 and 60."
  is_unsigned_integer "${RESTORE_MUTATION_TIMEOUT_SECONDS}" || fail "RESTORE_MUTATION_TIMEOUT_SECONDS must be a positive integer."
  [ "${RESTORE_MUTATION_TIMEOUT_SECONDS}" -ge 1 ] && [ "${RESTORE_MUTATION_TIMEOUT_SECONDS}" -le 600 ] \
    || fail "RESTORE_MUTATION_TIMEOUT_SECONDS must be between 1 and 600."
  is_unsigned_integer "${RESTORE_RECONCILIATION_TIMEOUT_SECONDS}" || fail "RESTORE_RECONCILIATION_TIMEOUT_SECONDS must be a positive integer."
  [ "${RESTORE_RECONCILIATION_TIMEOUT_SECONDS}" -ge 1 ] && [ "${RESTORE_RECONCILIATION_TIMEOUT_SECONDS}" -le 300 ] \
    || fail "RESTORE_RECONCILIATION_TIMEOUT_SECONDS must be between 1 and 300."
}

validate_app_role_settings() {
  validate_postgres_identifier APP_DB_USER "${APP_DB_USER}"
  [ "${APP_DB_USER}" != "${POSTGRES_USER}" ] || fail "APP_DB_USER must be distinct from POSTGRES_USER."
  [ -n "${APP_DB_PASSWORD}" ] || fail "APP_DB_PASSWORD is required."
  [ -n "${PLATFORM_ADMIN_DB_CONTEXT_SECRET}" ] || fail "PLATFORM_ADMIN_DB_CONTEXT_SECRET is required."
  [ -n "${MIGRATION_DATABASE_URL}" ] || fail "MIGRATION_DATABASE_URL is required."
}

verify_fixed_signature() {
  local payload_file="$1"
  local signature_file="$2"
  local label="$3"
  require_command cosign
  require_command timeout
  if ! timeout --foreground --signal=TERM --kill-after=5s "${RESTORE_SIGNATURE_VERIFY_TIMEOUT_SECONDS}s" \
    cosign verify-blob \
      "${payload_file}" \
      --bundle "${signature_file}" \
      --certificate-identity "${RECOVERY_EXECUTION_CERTIFICATE_IDENTITY}" \
      --certificate-oidc-issuer "${RECOVERY_EXECUTION_OIDC_ISSUER}" >/dev/null
  then
    fail "${label} signature is invalid or is not from the pinned protected workflow identity."
  fi
}

validate_protected_evidence_file() {
  local path="$1"
  local label="$2"
  local maximum_bytes="$3"
  case "${path}" in /* | [A-Za-z]:/*) ;; *) fail "${label} must be an absolute path." ;; esac
  [ -f "${path}" ] && [ ! -L "${path}" ] && [ -s "${path}" ] \
    || fail "${label} must be a non-empty regular file and not a symlink."
  [ "$(stat -c '%s' -- "${path}")" -le "${maximum_bytes}" ] \
    || fail "${label} must not exceed ${maximum_bytes} bytes."
  local mode
  mode="$(stat -c '%a' -- "${path}")" || fail "Could not inspect ${label} permissions."
  case "${mode}" in '' | *[!0-7]*) fail "Could not validate ${label} permissions." ;; esac
  (( (8#${mode} & 0022) == 0 )) || fail "${label} must not be group- or world-writable."
}

snapshot_protected_evidence_file() {
  local source_path="$1"
  local label="$2"
  local maximum_bytes="$3"
  local output_name="$4"
  local snapshot_path
  local snapshot_size

  validate_protected_evidence_file "${source_path}" "${label}" "${maximum_bytes}"
  RESTORE_EVIDENCE_SNAPSHOT_COUNTER=$((RESTORE_EVIDENCE_SNAPSHOT_COUNTER + 1))
  snapshot_path="${RESTORE_EVIDENCE_SNAPSHOT_DIR}/evidence-${RESTORE_EVIDENCE_SNAPSHOT_COUNTER}"
  if ! snapshot_regular_file_once "${source_path}" "${snapshot_path}" "${label}" "${maximum_bytes}"; then
    fail "Could not capture one stable private snapshot of ${label}."
  fi
  [ -f "${snapshot_path}" ] && [ ! -L "${snapshot_path}" ] \
    || fail "${label} snapshot is not a regular file."
  chmod 600 -- "${snapshot_path}"
  snapshot_size="$(stat -c '%s' -- "${snapshot_path}")"
  [ "${snapshot_size}" -ge 1 ] && [ "${snapshot_size}" -le "${maximum_bytes}" ] \
    || fail "${label} snapshot must contain 1 through ${maximum_bytes} bytes."
  [ "$(stat -c '%a' -- "${snapshot_path}")" = "600" ] \
    || fail "${label} snapshot must have mode 0600."
  printf -v "${output_name}" '%s' "${snapshot_path}"
}

snapshot_regular_file_once() {
  local source_path="$1"
  local snapshot_path="$2"
  local label="$3"
  timeout --signal=TERM --kill-after=2s "${RESTORE_EVIDENCE_SNAPSHOT_TIMEOUT_SECONDS}s" \
    node --input-type=module - "${source_path}" "${snapshot_path}" "${label}" "${4:-0}" <<'NODE'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  writeSync,
} from 'node:fs';

const [sourcePath, snapshotPath, label, maximumBytesText = '0'] = process.argv.slice(2);
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
  const maximumBytes = BigInt(maximumBytesText);
  if (maximumBytes > 0n && before.size > maximumBytes) throw new Error(`source exceeds ${maximumBytes} bytes`);
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
  local snapshot_dir="${RESTORE_EVIDENCE_SNAPSHOT_DIR}/backup"
  local backup_name
  local checksum_source

  BACKUP_DECLARED_FILE="${BACKUP_FILE}"
  backup_name="$(basename -- "${BACKUP_DECLARED_FILE}")"
  checksum_source="${BACKUP_DECLARED_FILE}.sha256"
  mkdir -m 700 -- "${snapshot_dir}"
  snapshot_regular_file_once "${BACKUP_DECLARED_FILE}" "${snapshot_dir}/${backup_name}" 'Restore backup input' \
    || fail "Restore backup input must be a stable non-symlink regular file."
  if [ -e "${checksum_source}" ] || [ -L "${checksum_source}" ]; then
    snapshot_regular_file_once "${checksum_source}" "${snapshot_dir}/${backup_name}.sha256" 'Restore checksum sidecar' \
      || fail "Restore checksum sidecar must be a stable non-symlink regular file."
  fi
  BACKUP_FILE="${snapshot_dir}/${backup_name}"
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

verify_backup_checksum() {
  local checksum_file="${BACKUP_FILE}.sha256"

  if [ -f "${checksum_file}" ]; then
    require_command sha256sum
    (
      cd "$(dirname "${BACKUP_FILE}")"
      sha256sum -c "$(basename "${checksum_file}")"
    )
  elif [ "${RESTORE_REQUIRE_CHECKSUM}" = "true" ]; then
    fail "Checksum file is required by default: ${checksum_file}. Set RESTORE_REQUIRE_CHECKSUM=false only for an explicitly approved local drill."
  fi

  require_command sha256sum
  BACKUP_SHA256_LINE="$(sha256sum "${BACKUP_FILE}")"
  BACKUP_SHA256="${BACKUP_SHA256_LINE%% *}"
}

verify_production_target_descriptor() {
  [ "${RESTORE_TARGET_ENV}" = "production" ] || return 0
  local descriptor_snapshot
  local pin_snapshot
  local pin_signature_snapshot
  snapshot_protected_evidence_file "${RESTORE_PRODUCTION_TARGET_DESCRIPTOR_FILE}" \
    'Production target descriptor (RESTORE_PRODUCTION_TARGET_DESCRIPTOR_FILE)' 65536 descriptor_snapshot
  snapshot_protected_evidence_file "${RESTORE_PRODUCTION_TARGET_PIN_FILE}" \
    'Production target pin (RESTORE_PRODUCTION_TARGET_PIN_FILE)' 65536 pin_snapshot
  snapshot_protected_evidence_file "${RESTORE_PRODUCTION_TARGET_PIN_SIGNATURE_BUNDLE_FILE}" \
    'Production target pin signature bundle (RESTORE_PRODUCTION_TARGET_PIN_SIGNATURE_BUNDLE_FILE)' 1048576 pin_signature_snapshot
  RESTORE_PRODUCTION_TARGET_DESCRIPTOR_FILE="${descriptor_snapshot}"
  RESTORE_PRODUCTION_TARGET_PIN_FILE="${pin_snapshot}"
  RESTORE_PRODUCTION_TARGET_PIN_SIGNATURE_BUNDLE_FILE="${pin_signature_snapshot}"
  case "${RESTORE_PRODUCTION_TARGET_DESCRIPTOR_FILE}" in
    /* | [A-Za-z]:/*) ;;
    *) fail "Production restore requires RESTORE_PRODUCTION_TARGET_DESCRIPTOR_FILE to be an absolute path." ;;
  esac
  [ -f "${RESTORE_PRODUCTION_TARGET_DESCRIPTOR_FILE}" ] \
    && [ ! -L "${RESTORE_PRODUCTION_TARGET_DESCRIPTOR_FILE}" ] \
    && [ -s "${RESTORE_PRODUCTION_TARGET_DESCRIPTOR_FILE}" ] \
    || fail "Production target descriptor must be a non-empty regular file and not a symlink."
  require_command stat
  require_command sha256sum
  require_command node
  validate_protected_evidence_file "${RESTORE_PRODUCTION_TARGET_PIN_FILE}" 'Production target pin' 65536
  validate_protected_evidence_file "${RESTORE_PRODUCTION_TARGET_PIN_SIGNATURE_BUNDLE_FILE}" 'Production target pin signature bundle' 1048576
  verify_fixed_signature \
    "${RESTORE_PRODUCTION_TARGET_PIN_FILE}" \
    "${RESTORE_PRODUCTION_TARGET_PIN_SIGNATURE_BUNDLE_FILE}" \
    'Production target pin'
  RESTORE_PRODUCTION_TARGET_PIN_SHA256="$(sha256sum -- "${RESTORE_PRODUCTION_TARGET_PIN_FILE}" | awk '{print tolower($1)}')"
  [ "$(stat -c '%s' -- "${RESTORE_PRODUCTION_TARGET_DESCRIPTOR_FILE}")" -le 65536 ] \
    || fail "Production target descriptor must not exceed 65536 bytes."
  descriptor_mode="$(stat -c '%a' -- "${RESTORE_PRODUCTION_TARGET_DESCRIPTOR_FILE}")" \
    || fail "Could not inspect production target descriptor permissions."
  case "${descriptor_mode}" in '' | *[!0-7]*) fail "Could not validate production target descriptor permissions." ;; esac
  descriptor_mode_value=$((8#${descriptor_mode}))
  (( (descriptor_mode_value & 0022) == 0 )) \
    || fail "Production target descriptor must not be group- or world-writable."
  case "${RESTORE_PRODUCTION_TARGET_DESCRIPTOR_SHA256}" in
    '' | *[!A-Fa-f0-9]*) fail "RESTORE_PRODUCTION_TARGET_DESCRIPTOR_SHA256 must be a 64-character SHA-256 digest." ;;
  esac
  [ "${#RESTORE_PRODUCTION_TARGET_DESCRIPTOR_SHA256}" -eq 64 ] \
    || fail "RESTORE_PRODUCTION_TARGET_DESCRIPTOR_SHA256 must be a 64-character SHA-256 digest."
  RESTORE_PRODUCTION_TARGET_DESCRIPTOR_SHA256="${RESTORE_PRODUCTION_TARGET_DESCRIPTOR_SHA256,,}"
  [ "$(sha256sum -- "${RESTORE_PRODUCTION_TARGET_DESCRIPTOR_FILE}" | awk '{print tolower($1)}')" = "${RESTORE_PRODUCTION_TARGET_DESCRIPTOR_SHA256}" ] \
    || fail "Production target descriptor digest does not match RESTORE_PRODUCTION_TARGET_DESCRIPTOR_SHA256."
  case "${RESTORE_PRODUCTION_CLUSTER_ID}" in
    '' | *[!A-Za-z0-9._-]* | latest | current) fail "RESTORE_PRODUCTION_CLUSTER_ID must name one explicit protected production cluster." ;;
  esac

  local pinned_system_identifier
  if ! pinned_system_identifier="$(RESTORE_MIGRATION_DATABASE_URL_INPUT="${MIGRATION_DATABASE_URL}" node - \
    "${RESTORE_PRODUCTION_TARGET_DESCRIPTOR_FILE}" \
    "${RESTORE_PRODUCTION_TARGET_PIN_FILE}" \
    "${RESTORE_PRODUCTION_CLUSTER_ID}" \
    "${POSTGRES_HOST}" \
    "${POSTGRES_PORT}" \
    "${POSTGRES_DB}" \
    "${POSTGRES_USER}" \
    "${RECOVERY_EXECUTION_CERTIFICATE_IDENTITY}" \
    "${RECOVERY_EXECUTION_OIDC_ISSUER}" <<'NODE'
const { readFileSync } = require('node:fs');

const [path, pinPath, clusterId, postgresHost, postgresPort, postgresDatabase, postgresUser, certificateIdentity, oidcIssuer] = process.argv.slice(2);
const migrationUrlText = process.env.RESTORE_MIGRATION_DATABASE_URL_INPUT ?? '';
let descriptor;
let pin;
let migrationUrl;
try {
  descriptor = JSON.parse(readFileSync(path, 'utf8'));
  pin = JSON.parse(readFileSync(pinPath, 'utf8'));
  migrationUrl = new URL(migrationUrlText);
} catch {
  process.exit(1);
}
const decode = (value) => {
  try { return decodeURIComponent(value); } catch { return null; }
};
const migrationDatabase = decode(migrationUrl.pathname.replace(/^\//, ''));
const migrationUsername = decode(migrationUrl.username);
const expectedPort = String(migrationUrl.port || '5432');
const now = Date.now();
const pinIssuedAt = Date.parse(pin?.issuedAt);
const pinExpiresAt = Date.parse(pin?.expiresAt);
const systemIdentifier = String(pin?.postgres?.systemIdentifier ?? '');
if (
  !descriptor
  || typeof descriptor !== 'object'
  || Array.isArray(descriptor)
  || descriptor.version !== 1
  || descriptor.kind !== 'lunchlineup-protected-production-database-target'
  || descriptor.environment !== 'production'
  || descriptor.clusterId !== clusterId
  || descriptor.postgres?.host !== postgresHost
  || String(descriptor.postgres?.port) !== String(postgresPort)
  || descriptor.postgres?.database !== postgresDatabase
  || descriptor.postgres?.ownerUsername !== postgresUser
  || String(descriptor.postgres?.systemIdentifier ?? '') !== systemIdentifier
  || !['postgres:', 'postgresql:'].includes(migrationUrl.protocol)
  || migrationUrl.hostname !== descriptor.migration?.host
  || expectedPort !== String(descriptor.migration?.port)
  || migrationDatabase !== descriptor.migration?.database
  || migrationUsername !== descriptor.migration?.username
  || descriptor.migration?.host !== postgresHost
  || String(descriptor.migration?.port) !== String(postgresPort)
  || descriptor.migration?.database !== postgresDatabase
  || descriptor.migration?.username !== postgresUser
  || migrationUrl.hash
  || !pin
  || typeof pin !== 'object'
  || Array.isArray(pin)
  || pin.version !== 1
  || pin.kind !== 'lunchlineup-signed-production-database-target-pin'
  || pin.environment !== 'production'
  || pin.clusterId !== clusterId
  || pin.certificateIdentity !== certificateIdentity
  || pin.oidcIssuer !== oidcIssuer
  || pin.postgres?.host !== postgresHost
  || String(pin.postgres?.port) !== String(postgresPort)
  || pin.postgres?.database !== postgresDatabase
  || pin.postgres?.ownerUsername !== postgresUser
  || !/^[0-9]{10,32}$/.test(systemIdentifier)
  || !Number.isFinite(pinIssuedAt)
  || !Number.isFinite(pinExpiresAt)
  || pinIssuedAt > now + 30_000
  || pinExpiresAt <= now
  || pinExpiresAt - pinIssuedAt > 366 * 86400 * 1000
) process.exit(1);
process.stdout.write(systemIdentifier);
NODE
  )"; then
    fail "Protected production target descriptor does not match the independently signed target pin, DB identity, cluster, or MIGRATION_DATABASE_URL."
  fi
  RESTORE_PRODUCTION_SYSTEM_IDENTIFIER="${pinned_system_identifier}"
  REQUIRED_CONFIRM="restore-production-target:${RESTORE_PRODUCTION_CLUSTER_ID}:${POSTGRES_DB}:${RESTORE_PRODUCTION_TARGET_PIN_SHA256}:${RESTORE_PRODUCTION_TARGET_DESCRIPTOR_SHA256}"
}

verify_production_system_identifier() {
  [ "${RESTORE_TARGET_ENV}" = "production" ] || return 0
  local queried_system_identifier
  local query_status
  if queried_system_identifier="$(
    PGCONNECT_TIMEOUT="${RESTORE_DB_READ_TIMEOUT_SECONDS}" \
      timeout --foreground --signal=TERM --kill-after=5s "${RESTORE_DB_READ_TIMEOUT_SECONDS}s" \
      psql \
        -X \
        -U "${POSTGRES_USER}" \
        -h "${POSTGRES_HOST}" \
        -p "${POSTGRES_PORT}" \
        -d "${POSTGRES_DB}" \
        -At \
        -v ON_ERROR_STOP=1 \
        -c 'SELECT system_identifier::text FROM pg_control_system();'
  )"; then
    query_status=0
  else
    query_status=$?
  fi
  if [ "${query_status}" -eq 124 ] || [ "${query_status}" -eq 137 ]; then
    fail "Production target system-identifier query timed out; target identity is unknown and no restore mutation was attempted."
  fi
  [ "${query_status}" -eq 0 ] || fail "Could not independently query the production PostgreSQL system identifier before restore mutation."
  case "${queried_system_identifier}" in '' | *[!0-9]*) fail "Production PostgreSQL returned an invalid system identifier." ;; esac
  [ "${queried_system_identifier}" = "${RESTORE_PRODUCTION_SYSTEM_IDENTIFIER}" ] \
    || fail "Queried PostgreSQL system identifier does not match the independently signed production target pin; refusing restore mutation."
}

verify_production_dr_provenance() {
  [ "${RESTORE_TARGET_ENV}" = "production" ] || return 0
  local provenance_snapshot
  local adapter_attestation_snapshot
  local adapter_signature_snapshot
  snapshot_protected_evidence_file "${RESTORE_DR_PROVENANCE_FILE}" \
    'Production provider provenance (RESTORE_DR_PROVENANCE_FILE)' 65536 provenance_snapshot
  snapshot_protected_evidence_file "${RESTORE_DR_ADAPTER_ATTESTATION_FILE}" \
    'Recovery adapter attestation (RESTORE_DR_ADAPTER_ATTESTATION_FILE)' 1048576 adapter_attestation_snapshot
  snapshot_protected_evidence_file "${RESTORE_DR_ADAPTER_SIGNATURE_BUNDLE_FILE}" \
    'Recovery adapter signature bundle (RESTORE_DR_ADAPTER_SIGNATURE_BUNDLE_FILE)' 1048576 adapter_signature_snapshot
  RESTORE_DR_PROVENANCE_FILE="${provenance_snapshot}"
  RESTORE_DR_ADAPTER_ATTESTATION_FILE="${adapter_attestation_snapshot}"
  RESTORE_DR_ADAPTER_SIGNATURE_BUNDLE_FILE="${adapter_signature_snapshot}"

  case "${RESTORE_DR_PROVENANCE_FILE}" in
    /* | [A-Za-z]:/*) ;;
    *) fail "Production restore requires RESTORE_DR_PROVENANCE_FILE to be an absolute path." ;;
  esac
  [ -f "${RESTORE_DR_PROVENANCE_FILE}" ] && [ ! -L "${RESTORE_DR_PROVENANCE_FILE}" ] && [ -s "${RESTORE_DR_PROVENANCE_FILE}" ] \
    || fail "Production restore requires a non-empty regular provider provenance file, not a symlink."
  case "${RESTORE_DR_PROVENANCE_SHA256}" in
    '' | *[!A-Fa-f0-9]*) fail "RESTORE_DR_PROVENANCE_SHA256 must be a 64-character SHA-256 digest." ;;
  esac
  [ "${#RESTORE_DR_PROVENANCE_SHA256}" -eq 64 ] \
    || fail "RESTORE_DR_PROVENANCE_SHA256 must be a 64-character SHA-256 digest."
  RESTORE_DR_PROVENANCE_SHA256="${RESTORE_DR_PROVENANCE_SHA256,,}"
  case "${RESTORE_DR_SOURCE_URI}" in
    s3://*.sql.zst.gpg | rclone:*.sql.zst.gpg | rsync://*.sql.zst.gpg | scp://*.sql.zst.gpg | ssh://*.sql.zst.gpg | https://*.sql.zst.gpg | restic:*.sql.zst.gpg | b2://*.sql.zst.gpg) ;;
    *) fail "RESTORE_DR_SOURCE_URI must name one explicit off-host .sql.zst.gpg object." ;;
  esac
  case "${RESTORE_DR_SOURCE_URI}" in
    *[[:space:]]* | *\?* | *\#* | */ | *latest | *latest.*) fail "RESTORE_DR_SOURCE_URI must name one exact immutable off-host object." ;;
  esac
  case "${RESTORE_DR_SOURCE_VERSION}" in
    '' | *[[:space:]]* | latest | null) fail "RESTORE_DR_SOURCE_VERSION must name one exact immutable provider version." ;;
  esac
  is_unsigned_integer "${RESTORE_DR_PROVENANCE_MAX_AGE_SECONDS}" \
    || fail "RESTORE_DR_PROVENANCE_MAX_AGE_SECONDS must be a positive integer."
  [ "${RESTORE_DR_PROVENANCE_MAX_AGE_SECONDS}" -ge 1 ] && [ "${RESTORE_DR_PROVENANCE_MAX_AGE_SECONDS}" -le 900 ] \
    || fail "RESTORE_DR_PROVENANCE_MAX_AGE_SECONDS must be between 1 and 900."
  require_command node
  require_command stat
  require_command sha256sum
  [ "$(stat -c '%s' -- "${RESTORE_DR_PROVENANCE_FILE}")" -le 65536 ] \
    || fail "Production restore provider provenance must not exceed 65536 bytes."

  local actual_provenance_sha256
  actual_provenance_sha256="$(sha256sum -- "${RESTORE_DR_PROVENANCE_FILE}" | awk '{print tolower($1)}')"
  [ "${actual_provenance_sha256}" = "${RESTORE_DR_PROVENANCE_SHA256}" ] \
    || fail "Provider provenance readback digest does not match RESTORE_DR_PROVENANCE_SHA256."

  for adapter_path_name in RESTORE_DR_ADAPTER_ATTESTATION_FILE RESTORE_DR_ADAPTER_SIGNATURE_BUNDLE_FILE; do
    adapter_path="${!adapter_path_name}"
    case "${adapter_path}" in /* | [A-Za-z]:/*) ;; *) fail "${adapter_path_name} must be an absolute path." ;; esac
    [ -f "${adapter_path}" ] && [ ! -L "${adapter_path}" ] && [ -s "${adapter_path}" ] \
      || fail "${adapter_path_name} must be a non-empty regular file and not a symlink."
    [ "$(stat -c '%s' -- "${adapter_path}")" -le 1048576 ] \
      || fail "${adapter_path_name} must not exceed 1048576 bytes."
  done
  for adapter_uri_name in RESTORE_DR_ADAPTER_ATTESTATION_URI RESTORE_DR_ADAPTER_SIGNATURE_BUNDLE_URI; do
    adapter_uri="${!adapter_uri_name}"
    case "${adapter_uri}" in https://* | s3://*) ;; *) fail "${adapter_uri_name} must name one immutable https:// or s3:// retained artifact." ;; esac
    case "${adapter_uri}" in *[[:space:]]* | *latest* | *current*) fail "${adapter_uri_name} must not use whitespace or a latest/current alias." ;; esac
  done
  [ -n "${RESTORE_DR_ADAPTER_CERTIFICATE_IDENTITY}" ] || fail "RESTORE_DR_ADAPTER_CERTIFICATE_IDENTITY is required."
  [ -n "${RESTORE_DR_ADAPTER_OIDC_ISSUER}" ] || fail "RESTORE_DR_ADAPTER_OIDC_ISSUER is required."
  [ "${RESTORE_DR_ADAPTER_CERTIFICATE_IDENTITY}" = "${RECOVERY_EXECUTION_CERTIFICATE_IDENTITY}" ] \
    && [ "${RESTORE_DR_ADAPTER_OIDC_ISSUER}" = "${RECOVERY_EXECUTION_OIDC_ISSUER}" ] \
    || fail "Recovery adapter signer identity must match the independently pinned protected workflow identity."
  require_command cosign
  require_command timeout
  if ! timeout --foreground --signal=TERM --kill-after=5s "${RESTORE_DR_PROVENANCE_MAX_AGE_SECONDS}s" \
    cosign verify-blob \
      "${RESTORE_DR_ADAPTER_ATTESTATION_FILE}" \
      --bundle "${RESTORE_DR_ADAPTER_SIGNATURE_BUNDLE_FILE}" \
      --certificate-identity "${RESTORE_DR_ADAPTER_CERTIFICATE_IDENTITY}" \
      --certificate-oidc-issuer "${RESTORE_DR_ADAPTER_OIDC_ISSUER}" >/dev/null
  then
    fail "Recovery adapter attestation signature is invalid or is not from the protected workflow identity."
  fi
  RESTORE_DR_ADAPTER_ATTESTATION_SHA256="$(sha256sum -- "${RESTORE_DR_ADAPTER_ATTESTATION_FILE}" | awk '{print tolower($1)}')"
  RESTORE_DR_ADAPTER_SIGNATURE_BUNDLE_SHA256="$(sha256sum -- "${RESTORE_DR_ADAPTER_SIGNATURE_BUNDLE_FILE}" | awk '{print tolower($1)}')"

  local provenance_claims
  if ! provenance_claims="$(node - \
    "${RESTORE_DR_PROVENANCE_FILE}" \
    "${RESTORE_DR_SOURCE_URI}" \
    "${RESTORE_DR_SOURCE_VERSION}" \
    "${BACKUP_SHA256}" \
    "$(stat -c '%s' -- "${BACKUP_FILE}")" \
    "${RESTORE_DR_PROVENANCE_MAX_AGE_SECONDS}" \
    "${RESTORE_DR_ADAPTER_ATTESTATION_FILE}" \
    "${RESTORE_DR_ADAPTER_ATTESTATION_URI}" \
    "${RESTORE_DR_ADAPTER_ATTESTATION_SHA256}" \
    "${RESTORE_DR_ADAPTER_SIGNATURE_BUNDLE_URI}" \
    "${RESTORE_DR_ADAPTER_SIGNATURE_BUNDLE_SHA256}" \
    "${RESTORE_DR_ADAPTER_CERTIFICATE_IDENTITY}" \
    "${RESTORE_DR_ADAPTER_OIDC_ISSUER}" <<'NODE'
const { readFileSync } = require('node:fs');

const [
  path,
  sourceUri,
  sourceVersion,
  backupSha256,
  backupBytesText,
  maxAgeSecondsText,
  attestationPath,
  attestationUri,
  attestationSha256,
  signatureUri,
  signatureSha256,
  certificateIdentity,
  oidcIssuer,
] = process.argv.slice(2);
let proof;
let attestation;
try {
  proof = JSON.parse(readFileSync(path, 'utf8'));
  attestation = JSON.parse(readFileSync(attestationPath, 'utf8'));
} catch {
  process.exit(1);
}
const observedAt = Date.parse(proof?.observedAt);
const now = Date.now();
const sourceKind = sourceUri.startsWith('rclone:') || sourceUri.startsWith('restic:')
  ? sourceUri.slice(0, sourceUri.indexOf(':'))
  : sourceUri.slice(0, sourceUri.indexOf('://'));
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
  || proof.version !== 2
  || proof.kind !== 'lunchlineup-provider-authenticated-object-readback'
  || proof.sourceKind !== sourceKind
  || proof.sourceUri !== sourceUri
  || proof.requestedVersion !== sourceVersion
  || proof.resolvedVersion !== sourceVersion
  || proof.objectChecksum?.algorithm !== 'sha256'
  || proof.objectChecksum?.value !== backupSha256
  || proof.bytes !== Number(backupBytesText)
  || !/^[a-f0-9]{64}$/.test(proof.readbackCommandSha256 ?? '')
  || proof.authentication?.status !== 'verified'
  || proof.authentication?.mechanism !== 'provider-api'
  || !safeIdentity(proof.authentication?.principal, 3, 512)
  || !safeIdentity(proof.authentication?.requestId, 8, 256)
  || !Number.isFinite(observedAt)
  || observedAt > now + 30_000
  || now - observedAt > Number(maxAgeSecondsText) * 1000
  || proof.source_adapter_attestation_uri !== attestationUri
  || proof.source_adapter_attestation_sha256 !== attestationSha256
  || proof.source_adapter_signature_bundle_uri !== signatureUri
  || proof.source_adapter_signature_bundle_sha256 !== signatureSha256
  || proof.source_adapter_certificate_identity !== certificateIdentity
  || proof.source_adapter_oidc_issuer !== oidcIssuer
  || attestation?.version !== 1
  || attestation?.kind !== 'lunchlineup-signed-recovery-adapter-provenance'
  || attestation?.fetchAdapterSha256 !== proof.source_fetch_command_sha256
  || attestation?.readbackAdapterSha256 !== proof.source_readback_command_sha256
  || !Array.isArray(attestation?.sourceKinds)
  || !attestation.sourceKinds.includes(sourceKind)
  || attestation?.certificateIdentity !== certificateIdentity
  || attestation?.oidcIssuer !== oidcIssuer
  || !Number.isFinite(Date.parse(attestation?.issuedAt))
  || !Number.isFinite(Date.parse(attestation?.expiresAt))
  || Date.parse(attestation.expiresAt) <= now
  || Date.parse(attestation.expiresAt) - Date.parse(attestation.issuedAt) > 90 * 86400 * 1000
) process.exit(1);
process.stdout.write([
  proof.authentication.principal,
  proof.authentication.requestId,
  new Date(observedAt).toISOString(),
].join('\t'));
NODE
  )"; then
    fail "Production restore provider provenance is missing, mismatched, unauthenticated, or stale."
  fi
  IFS=$'\t' read -r \
    RESTORE_DR_PROVENANCE_PRINCIPAL \
    RESTORE_DR_PROVENANCE_REQUEST_ID \
    RESTORE_DR_PROVENANCE_OBSERVED_AT <<<"${provenance_claims}"
  [ -n "${RESTORE_DR_PROVENANCE_OBSERVED_AT}" ] \
    || fail "Production restore provider provenance normalization failed."
}

verify_production_dr_execution() {
  [ "${RESTORE_TARGET_ENV}" = "production" ] || return 0
  local execution_attestation_snapshot
  local execution_signature_snapshot
  snapshot_protected_evidence_file "${RESTORE_DR_EXECUTION_ATTESTATION_FILE}" \
    'DR execution attestation (RESTORE_DR_EXECUTION_ATTESTATION_FILE)' 1048576 execution_attestation_snapshot
  snapshot_protected_evidence_file "${RESTORE_DR_EXECUTION_SIGNATURE_BUNDLE_FILE}" \
    'DR execution signature bundle (RESTORE_DR_EXECUTION_SIGNATURE_BUNDLE_FILE)' 1048576 execution_signature_snapshot
  RESTORE_DR_EXECUTION_ATTESTATION_FILE="${execution_attestation_snapshot}"
  RESTORE_DR_EXECUTION_SIGNATURE_BUNDLE_FILE="${execution_signature_snapshot}"
  validate_protected_evidence_file "${RESTORE_DR_EXECUTION_ATTESTATION_FILE}" 'DR execution attestation' 1048576
  validate_protected_evidence_file "${RESTORE_DR_EXECUTION_SIGNATURE_BUNDLE_FILE}" 'DR execution signature bundle' 1048576
  for execution_uri_name in RESTORE_DR_EXECUTION_ATTESTATION_URI RESTORE_DR_EXECUTION_SIGNATURE_BUNDLE_URI; do
    execution_uri="${!execution_uri_name}"
    case "${execution_uri}" in https://* | s3://*) ;; *) fail "${execution_uri_name} must name one immutable retained https:// or s3:// artifact." ;; esac
    case "${execution_uri}" in *[[:space:]]* | *latest* | *current*) fail "${execution_uri_name} must not use whitespace or a latest/current alias." ;; esac
  done
  [ "${RESTORE_DR_EXECUTION_ATTESTATION_URI}" != "${RESTORE_DR_EXECUTION_SIGNATURE_BUNDLE_URI}" ] \
    || fail "DR execution attestation and signature bundle must be distinct retained artifacts."
  case "${RESTORE_DR_RELEASE_SHA}" in '' | *[!a-fA-F0-9]*) fail "RESTORE_DR_RELEASE_SHA must be a 40-character Git SHA." ;; esac
  [ "${#RESTORE_DR_RELEASE_SHA}" -eq 40 ] || fail "RESTORE_DR_RELEASE_SHA must be a 40-character Git SHA."
  RESTORE_DR_RELEASE_SHA="${RESTORE_DR_RELEASE_SHA,,}"

  verify_fixed_signature \
    "${RESTORE_DR_EXECUTION_ATTESTATION_FILE}" \
    "${RESTORE_DR_EXECUTION_SIGNATURE_BUNDLE_FILE}" \
    'DR execution attestation'
  RESTORE_DR_EXECUTION_ATTESTATION_SHA256="$(sha256sum -- "${RESTORE_DR_EXECUTION_ATTESTATION_FILE}" | awk '{print tolower($1)}')"
  RESTORE_DR_EXECUTION_SIGNATURE_BUNDLE_SHA256="$(sha256sum -- "${RESTORE_DR_EXECUTION_SIGNATURE_BUNDLE_FILE}" | awk '{print tolower($1)}')"

  local execution_claims
  if ! execution_claims="$(node - \
    "${RESTORE_DR_EXECUTION_ATTESTATION_FILE}" \
    "${RESTORE_DR_RELEASE_SHA}" \
    "${RESTORE_DR_SOURCE_URI}" \
    "${RESTORE_DR_SOURCE_VERSION}" \
    "${BACKUP_SHA256}" \
    "$(stat -c '%s' -- "${BACKUP_FILE}")" \
    "${RESTORE_DR_PROVENANCE_PRINCIPAL}" \
    "${RESTORE_DR_PROVENANCE_REQUEST_ID}" \
    "${RESTORE_DR_PROVENANCE_OBSERVED_AT}" \
    "${RESTORE_DR_PROVENANCE_SHA256}" \
    "${RECOVERY_EXECUTION_CERTIFICATE_IDENTITY}" \
    "${RECOVERY_EXECUTION_OIDC_ISSUER}" <<'NODE'
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');

const [path, releaseSha, sourceUri, sourceVersion, checksum, bytesText, principal, requestId, observedAtText, readbackSha256, certificateIdentity, oidcIssuer] = process.argv.slice(2);
let attestation;
try { attestation = JSON.parse(readFileSync(path, 'utf8')); } catch { process.exit(1); }
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const binding = attestation?.binding;
const startedAt = Date.parse(binding?.run?.startedAt);
const completedAt = Date.parse(binding?.run?.completedAt);
const observedAt = Date.parse(observedAtText);
const issuedAt = Date.parse(attestation?.issuedAt);
const expiresAt = Date.parse(attestation?.expiresAt);
const now = Date.now();
const sourceKind = sourceUri.startsWith('rclone:') || sourceUri.startsWith('restic:')
  ? sourceUri.slice(0, sourceUri.indexOf(':'))
  : sourceUri.slice(0, sourceUri.indexOf('://'));
const bindingSha256 = createHash('sha256').update(canonical(binding)).digest('hex');
if (
  attestation?.version !== 1
  || attestation?.kind !== 'lunchlineup-signed-recovery-execution-proof'
  || attestation?.certificateIdentity !== certificateIdentity
  || attestation?.oidcIssuer !== oidcIssuer
  || attestation?.bindingSha256 !== bindingSha256
  || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/.test(binding?.run?.id ?? '')
  || binding?.run?.releaseSha !== releaseSha
  || !Number.isFinite(startedAt)
  || !Number.isFinite(completedAt)
  || startedAt > completedAt
  || binding?.source?.kind !== sourceKind
  || binding?.source?.uri !== sourceUri
  || binding?.source?.version !== sourceVersion
  || binding?.source?.checksum?.algorithm !== 'sha256'
  || binding?.source?.checksum?.value !== checksum
  || binding?.source?.bytes !== Number(bytesText)
  || binding?.providerReadback?.principal !== principal
  || binding?.providerReadback?.requestId !== requestId
  || binding?.providerReadback?.observedAt !== observedAtText
  || binding?.providerReadback?.sha256 !== readbackSha256
  || !Number.isFinite(observedAt)
  || observedAt < startedAt - 30_000
  || observedAt > completedAt + 30_000
  || !['disposable', 'isolated-recovery'].includes(binding?.target?.environment)
  || !/^[\x21-\x7e]{8,512}$/.test(binding?.target?.identity ?? '')
  || !/^[0-9]{10,32}$/.test(String(binding?.target?.systemIdentifier ?? ''))
  || binding?.outcome?.status !== 'succeeded'
  || !Number.isSafeInteger(binding?.outcome?.restoredTableCount)
  || binding.outcome.restoredTableCount <= 0
  || binding?.outcome?.appRoleVerified !== true
  || !Number.isFinite(issuedAt)
  || !Number.isFinite(expiresAt)
  || issuedAt < completedAt - 30_000
  || issuedAt > now + 30_000
  || expiresAt <= now
  || expiresAt - issuedAt > 90 * 86400 * 1000
) process.exit(1);
process.stdout.write([
  binding.run.id,
  binding.target.identity,
  String(binding.target.systemIdentifier),
  String(binding.outcome.restoredTableCount),
].join('\t'));
NODE
  )"; then
    fail "DR execution attestation is not an independently signed exact execution, provider-readback, target, and final-outcome proof."
  fi
  IFS=$'\t' read -r \
    RESTORE_DR_EXECUTION_RUN_ID \
    RESTORE_DR_EXECUTION_TARGET_IDENTITY \
    RESTORE_DR_EXECUTION_TARGET_SYSTEM_IDENTIFIER \
    RESTORE_DR_EXECUTION_RESTORED_TABLE_COUNT <<<"${execution_claims}"
  [ -n "${RESTORE_DR_EXECUTION_RESTORED_TABLE_COUNT}" ] \
    || fail "DR execution attestation normalization failed."
}

table_count() {
  PGCONNECT_TIMEOUT="${RESTORE_DB_READ_TIMEOUT_SECONDS}" \
  timeout --signal=TERM --kill-after=5s "${RESTORE_DB_READ_TIMEOUT_SECONDS}s" psql \
    -U "${POSTGRES_USER}" \
    -h "${POSTGRES_HOST}" \
    -p "${POSTGRES_PORT}" \
    -d "${POSTGRES_DB}" \
    -At \
    -v ON_ERROR_STOP=1 \
      -c "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type = 'BASE TABLE';"
}

begin_restore_mutation_budget() {
  [ "${RESTORE_MUTATION_DEADLINE_EPOCH}" -eq 0 ] \
    || fail "Restore aggregate mutation budget has already started."
  RESTORE_MUTATION_DEADLINE_EPOCH=$(( $(date -u +%s) + RESTORE_MUTATION_TIMEOUT_SECONDS ))
}

restore_mutation_remaining_seconds() {
  local remaining=$((RESTORE_MUTATION_DEADLINE_EPOCH - $(date -u +%s)))
  [ "${remaining}" -ge 1 ] || return 1
  printf '%s' "${remaining}"
}

reconcile_restore_unknown_state() {
  local reconciliation_deadline=$(( $(date -u +%s) + RESTORE_RECONCILIATION_TIMEOUT_SECONDS ))
  local remaining
  local identity_status='not-required'
  local table_status='unavailable'
  local observed_identity=''
  local observed_tables=''

  if [ "${RESTORE_TARGET_ENV}" = "production" ]; then
    remaining=$((reconciliation_deadline - $(date -u +%s)))
    if [ "${remaining}" -ge 1 ] && observed_identity="$(
      PGCONNECT_TIMEOUT="${remaining}" timeout --signal=TERM --kill-after=2s "${remaining}s" psql \
        -X -U "${POSTGRES_USER}" -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT}" -d "${POSTGRES_DB}" \
        -At -v ON_ERROR_STOP=1 -c 'SELECT system_identifier::text FROM pg_control_system();'
    )"; then
      if [ "${observed_identity}" = "${RESTORE_PRODUCTION_SYSTEM_IDENTIFIER}" ]; then
        identity_status='match'
      else
        identity_status='mismatch'
      fi
    else
      identity_status='unavailable'
    fi
  fi

  remaining=$((reconciliation_deadline - $(date -u +%s)))
  if [ "${remaining}" -ge 1 ] && observed_tables="$(
    PGCONNECT_TIMEOUT="${remaining}" timeout --signal=TERM --kill-after=2s "${remaining}s" psql \
      -X -U "${POSTGRES_USER}" -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT}" -d "${POSTGRES_DB}" \
      -At -v ON_ERROR_STOP=1 \
      -c "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type = 'BASE TABLE';"
  )"; then
    case "${observed_tables}" in '' | *[!0-9]*) table_status='invalid' ;; *) table_status="count:${observed_tables}" ;; esac
  fi
  printf 'restore_unknown_state_reconciliation target_identity=%s table_readback=%s\n' \
    "${identity_status}" "${table_status}" >&2
}

restore_mutation_unknown() {
  local label="$1"
  echo "ERROR: Restore aggregate mutation deadline was exhausted during ${label}; production mutation state is unknown and must not be retried blindly." >&2
  reconcile_restore_unknown_state || true
  exit 70
}

run_restore_mutation_command() {
  local label="$1"
  shift
  local remaining
  local status
  remaining="$(restore_mutation_remaining_seconds)" \
    || restore_mutation_unknown "${label} before command start"
  if timeout --signal=TERM --kill-after=5s "${remaining}s" "$@"; then
    return 0
  else
    status=$?
  fi
  if [ "${status}" -eq 124 ] || [ "${status}" -eq 137 ]; then
    restore_mutation_unknown "${label}"
  fi
  echo "ERROR: ${label} failed inside the aggregate restore mutation budget." >&2
  return "${status}"
}

run_restore_mutation_capture() {
  local label="$1"
  local output_file="$2"
  shift 2
  run_restore_mutation_command "${label}" "$@" >"${output_file}"
}

stream_restore_sql() {
  if [ "${RESTORE_TARGET_ENV}" = "production" ]; then
    # This assertion is the first statement on the same connection and in the
    # same transaction that may reset the schema or import backup SQL.
    printf '%s\n' \
      'DO $lunchlineup_restore_identity$' \
      'DECLARE observed_system_identifier text;' \
      'BEGIN' \
      '  SELECT system_identifier::text INTO observed_system_identifier FROM pg_control_system();' \
      "  IF observed_system_identifier IS DISTINCT FROM '${RESTORE_PRODUCTION_SYSTEM_IDENTIFIER}' THEN" \
      "    RAISE EXCEPTION 'production restore system identifier mismatch inside destructive transaction';" \
      '  END IF;' \
      'END' \
      '$lunchlineup_restore_identity$;'
  fi
  if [ "${TABLE_COUNT}" != "0" ]; then
    printf '%s\n' \
      'DROP SCHEMA public CASCADE;' \
      'CREATE SCHEMA public;'
  fi

  if ! gpg \
      --decrypt \
      --batch \
      --yes \
      --pinentry-mode loopback \
      --passphrase-fd 3 \
      "${BACKUP_FILE}" \
      3<<<"${BACKUP_KEY}" \
      | zstd -d -c; then
    # psql cannot observe an upstream pipe failure. Force its single transaction
    # to roll back any schema reset or partial restore already received.
    printf "\nDO \$\$ BEGIN RAISE EXCEPTION 'backup stream validation failed'; END \$\$;\n"
    return 1
  fi
}

provision_and_verify_app_role() {
  run_restore_mutation_command 'restricted application role provisioning' \
    node "${SCRIPT_DIR}/provision-app-db-role.mjs"

  local access_proof
  local access_proof_file="${RESTORE_EVIDENCE_SNAPSHOT_DIR}/app-role-readback"
  PGPASSWORD="${APP_DB_PASSWORD}" run_restore_mutation_capture \
    'restricted application role access readback' "${access_proof_file}" psql \
      -X \
      -U "${APP_DB_USER}" \
      -h "${POSTGRES_HOST}" \
      -p "${POSTGRES_PORT}" \
      -d "${POSTGRES_DB}" \
      -At \
      -v ON_ERROR_STOP=1 \
      -v expected_role="${APP_DB_USER}" \
      -c "SELECT CASE WHEN current_user = :'expected_role'
        AND has_schema_privilege(current_user, 'public', 'USAGE')
        AND NOT EXISTS (
          SELECT 1
          FROM pg_class AS relation
          JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND NOT (
              has_table_privilege(current_user, relation.oid, 'SELECT')
              AND has_table_privilege(current_user, relation.oid, 'INSERT')
              AND has_table_privilege(current_user, relation.oid, 'UPDATE')
              AND has_table_privilege(current_user, relation.oid, 'DELETE')
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM pg_class AS sequence
          JOIN pg_namespace AS namespace ON namespace.oid = sequence.relnamespace
          WHERE namespace.nspname = 'public'
            AND sequence.relkind = 'S'
            AND NOT (
              has_sequence_privilege(current_user, sequence.oid, 'USAGE')
              AND has_sequence_privilege(current_user, sequence.oid, 'SELECT')
              AND has_sequence_privilege(current_user, sequence.oid, 'UPDATE')
            )
        )
        THEN 1 ELSE 0 END;"
  access_proof="$(<"${access_proof_file}")"
  [ "${access_proof}" = "1" ] || fail "Restricted application role could not access the restored public schema."
}

if [ "$#" -ne 1 ]; then
  usage
  exit 1
fi

BACKUP_FILE="$1"
BACKUP_DECLARED_FILE="$1"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_DB="${POSTGRES_DB:-lunchlineup}"
RESTORE_TARGET_ENV="${RESTORE_TARGET_ENV:-}"
RESTORE_REQUIRE_CHECKSUM="${RESTORE_REQUIRE_CHECKSUM:-true}"
RESTORE_REHYDRATE_DURABLE_QUEUES="${RESTORE_REHYDRATE_DURABLE_QUEUES:-false}"
RESTORE_DR_PROVENANCE_FILE="${RESTORE_DR_PROVENANCE_FILE:-}"
RESTORE_DR_PROVENANCE_SHA256="${RESTORE_DR_PROVENANCE_SHA256:-}"
RESTORE_DR_SOURCE_URI="${RESTORE_DR_SOURCE_URI:-}"
RESTORE_DR_SOURCE_VERSION="${RESTORE_DR_SOURCE_VERSION:-}"
RESTORE_DR_PROVENANCE_MAX_AGE_SECONDS="${RESTORE_DR_PROVENANCE_MAX_AGE_SECONDS:-300}"
RESTORE_DR_ADAPTER_ATTESTATION_FILE="${RESTORE_DR_ADAPTER_ATTESTATION_FILE:-}"
RESTORE_DR_ADAPTER_SIGNATURE_BUNDLE_FILE="${RESTORE_DR_ADAPTER_SIGNATURE_BUNDLE_FILE:-}"
RESTORE_DR_ADAPTER_ATTESTATION_URI="${RESTORE_DR_ADAPTER_ATTESTATION_URI:-}"
RESTORE_DR_ADAPTER_SIGNATURE_BUNDLE_URI="${RESTORE_DR_ADAPTER_SIGNATURE_BUNDLE_URI:-}"
RESTORE_DR_ADAPTER_CERTIFICATE_IDENTITY="${RESTORE_DR_ADAPTER_CERTIFICATE_IDENTITY:-}"
RESTORE_DR_ADAPTER_OIDC_ISSUER="${RESTORE_DR_ADAPTER_OIDC_ISSUER:-}"
RESTORE_DR_ADAPTER_ATTESTATION_SHA256=""
RESTORE_DR_ADAPTER_SIGNATURE_BUNDLE_SHA256=""
RESTORE_DR_EXECUTION_ATTESTATION_FILE="${RESTORE_DR_EXECUTION_ATTESTATION_FILE:-}"
RESTORE_DR_EXECUTION_SIGNATURE_BUNDLE_FILE="${RESTORE_DR_EXECUTION_SIGNATURE_BUNDLE_FILE:-}"
RESTORE_DR_EXECUTION_ATTESTATION_URI="${RESTORE_DR_EXECUTION_ATTESTATION_URI:-}"
RESTORE_DR_EXECUTION_SIGNATURE_BUNDLE_URI="${RESTORE_DR_EXECUTION_SIGNATURE_BUNDLE_URI:-}"
RESTORE_DR_EXECUTION_ATTESTATION_SHA256=""
RESTORE_DR_EXECUTION_SIGNATURE_BUNDLE_SHA256=""
RESTORE_DR_EXECUTION_RUN_ID=""
RESTORE_DR_EXECUTION_TARGET_IDENTITY=""
RESTORE_DR_EXECUTION_TARGET_SYSTEM_IDENTIFIER=""
RESTORE_DR_EXECUTION_RESTORED_TABLE_COUNT=""
RESTORE_DR_RELEASE_SHA="${RESTORE_DR_RELEASE_SHA:-}"
RESTORE_PRODUCTION_TARGET_DESCRIPTOR_FILE="${RESTORE_PRODUCTION_TARGET_DESCRIPTOR_FILE:-}"
RESTORE_PRODUCTION_TARGET_DESCRIPTOR_SHA256="${RESTORE_PRODUCTION_TARGET_DESCRIPTOR_SHA256:-}"
RESTORE_PRODUCTION_TARGET_PIN_FILE="${RESTORE_PRODUCTION_TARGET_PIN_FILE:-}"
RESTORE_PRODUCTION_TARGET_PIN_SIGNATURE_BUNDLE_FILE="${RESTORE_PRODUCTION_TARGET_PIN_SIGNATURE_BUNDLE_FILE:-}"
RESTORE_PRODUCTION_TARGET_PIN_SHA256=""
RESTORE_PRODUCTION_SYSTEM_IDENTIFIER=""
RESTORE_PRODUCTION_CLUSTER_ID="${RESTORE_PRODUCTION_CLUSTER_ID:-}"
RESTORE_DR_PROVENANCE_PRINCIPAL=""
RESTORE_DR_PROVENANCE_REQUEST_ID=""
RESTORE_DR_PROVENANCE_OBSERVED_AT=""
RESTORE_SIGNATURE_VERIFY_TIMEOUT_SECONDS="${RESTORE_SIGNATURE_VERIFY_TIMEOUT_SECONDS:-60}"
RESTORE_DB_READ_TIMEOUT_SECONDS="${RESTORE_DB_READ_TIMEOUT_SECONDS:-15}"
RESTORE_EVIDENCE_SNAPSHOT_TIMEOUT_SECONDS="${RESTORE_EVIDENCE_SNAPSHOT_TIMEOUT_SECONDS:-10}"
RESTORE_MUTATION_TIMEOUT_SECONDS="${RESTORE_MUTATION_TIMEOUT_SECONDS:-600}"
RESTORE_RECONCILIATION_TIMEOUT_SECONDS="${RESTORE_RECONCILIATION_TIMEOUT_SECONDS:-60}"
RESTORE_MUTATION_DEADLINE_EPOCH=0
RESTORE_EVIDENCE_SNAPSHOT_COUNTER=0
APP_DB_USER="${APP_DB_USER:-}"
APP_DB_PASSWORD="${APP_DB_PASSWORD:-}"
PLATFORM_ADMIN_DB_CONTEXT_SECRET="${PLATFORM_ADMIN_DB_CONTEXT_SECRET:-}"
MIGRATION_DATABASE_URL="${MIGRATION_DATABASE_URL:-}"
REQUIRED_CONFIRM="restore-${POSTGRES_DB}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for command_name in chmod head mkdir mktemp node rm stat timeout; do
  require_command "${command_name}"
done
RESTORE_EVIDENCE_SNAPSHOT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lunchlineup-restore-evidence.XXXXXX")"
chmod 700 -- "${RESTORE_EVIDENCE_SNAPSHOT_DIR}"
cleanup_restore_state() {
  local exit_code=$?
  trap - EXIT HUP INT TERM
  rm -rf -- "${RESTORE_EVIDENCE_SNAPSHOT_DIR}" || exit_code=1
  exit "${exit_code}"
}
trap cleanup_restore_state EXIT HUP INT TERM

validate_restore_settings
[ -e "${BACKUP_FILE}" ] || [ -L "${BACKUP_FILE}" ] || fail "Backup file not found: ${BACKUP_FILE}"

case "$(basename "${BACKUP_FILE}")" in
  latest | latest.*)
    fail "Refusing vague restore target '${BACKUP_FILE}'. Pass an explicit encrypted backup path."
    ;;
  -*)
    fail "Restore input filename must not start with '-'."
    ;;
  *.sql.zst.gpg)
    ;;
  *)
    fail "Restore input must be an encrypted .sql.zst.gpg backup."
    ;;
esac

snapshot_backup_input

case "${RESTORE_TARGET_ENV}" in
  disposable | staging | development)
    ;;
  production)
    [ "${RESTORE_ALLOW_PRODUCTION:-}" = "YES_RESTORE_PRODUCTION" ] || fail "Production restore requires RESTORE_ALLOW_PRODUCTION=YES_RESTORE_PRODUCTION."
    ;;
  *)
    fail "RESTORE_TARGET_ENV must be disposable, staging, development, or production."
    ;;
esac

verify_production_target_descriptor

if [ "${RESTORE_CONFIRM:-}" != "${REQUIRED_CONFIRM}" ]; then
  if [ -t 0 ]; then
    printf 'Type %s to restore %s on %s: ' "${REQUIRED_CONFIRM}" "${POSTGRES_DB}" "${POSTGRES_HOST}" >&2
    read -r typed_confirmation
    [ "${typed_confirmation}" = "${REQUIRED_CONFIRM}" ] || fail "Restore confirmation did not match."
  else
    fail "Set RESTORE_CONFIRM=${REQUIRED_CONFIRM}."
  fi
fi

verify_backup_checksum
verify_production_dr_provenance
verify_production_dr_execution
validate_app_role_settings
require_command gpg
require_command zstd
require_command psql
require_command node
require_command timeout

verify_production_system_identifier
if ! TABLE_COUNT="$(table_count)"; then
  fail "Bounded pre-restore table-count readback failed; no restore mutation was attempted."
fi

if [ "${TABLE_COUNT}" != "0" ] && [ "${RESTORE_ALLOW_NONEMPTY:-}" != "YES_OVERWRITE" ]; then
  fail "Target database ${POSTGRES_DB} is not empty (${TABLE_COUNT} tables). Restore to an empty database or set RESTORE_ALLOW_NONEMPTY=YES_OVERWRITE."
fi

BACKUP_KEY="$(read_backup_key)"

echo "Starting restore from ${BACKUP_DECLARED_FILE} into ${RESTORE_TARGET_ENV} database ${POSTGRES_DB} on ${POSTGRES_HOST}:${POSTGRES_PORT}..."

begin_restore_mutation_budget
export -f stream_restore_sql
export BACKUP_FILE BACKUP_KEY POSTGRES_USER POSTGRES_HOST POSTGRES_PORT POSTGRES_DB
export RESTORE_TARGET_ENV RESTORE_PRODUCTION_SYSTEM_IDENTIFIER TABLE_COUNT
run_restore_mutation_command 'destructive restore transaction' bash -c '
set -euo pipefail
stream_restore_sql | psql \
  -U "${POSTGRES_USER}" \
  -h "${POSTGRES_HOST}" \
  -p "${POSTGRES_PORT}" \
  -d "${POSTGRES_DB}" \
  -v ON_ERROR_STOP=1 \
  --single-transaction
'

if [ "${RESTORE_REHYDRATE_DURABLE_QUEUES}" = "true" ]; then
  REHYDRATE_SQL="${SCRIPT_DIR}/rehydrate-durable-queues.sql"
  [ -f "${REHYDRATE_SQL}" ] || fail "Durable queue rehydration SQL is missing: ${REHYDRATE_SQL}"
  run_restore_mutation_command 'durable queue rehydration' psql \
    -U "${POSTGRES_USER}" \
    -h "${POSTGRES_HOST}" \
    -p "${POSTGRES_PORT}" \
    -d "${POSTGRES_DB}" \
    -v ON_ERROR_STOP=1 \
    -f "${REHYDRATE_SQL}"
fi

provision_and_verify_app_role

RESTORED_TABLE_COUNT_FILE="${RESTORE_EVIDENCE_SNAPSHOT_DIR}/restored-table-count"
run_restore_mutation_capture 'restored table-count readback' "${RESTORED_TABLE_COUNT_FILE}" psql \
  -X \
  -U "${POSTGRES_USER}" \
  -h "${POSTGRES_HOST}" \
  -p "${POSTGRES_PORT}" \
  -d "${POSTGRES_DB}" \
  -At \
  -v ON_ERROR_STOP=1 \
  -c "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type = 'BASE TABLE';"
RESTORED_TABLE_COUNT="$(<"${RESTORED_TABLE_COUNT_FILE}")"
case "${RESTORED_TABLE_COUNT}" in '' | *[!0-9]*) fail "Restored table-count readback returned an invalid value." ;; esac

echo "Database restore completed successfully."
printf 'restore_ok target_env=%s postgres_host=%s postgres_db=%s postgres_system_identifier=%s backup_file=%s backup_sha256=%s restored_table_count=%s durable_queues_rehydrated=%s app_role_verified=true dr_source_uri=%s dr_source_version=%s dr_provenance_sha256=%s dr_provenance_principal=%s dr_provenance_request_id=%s dr_provenance_observed_at=%s dr_execution_attestation_sha256=%s dr_execution_signature_bundle_sha256=%s dr_execution_run_id=%s dr_execution_target_identity=%s dr_execution_target_system_identifier=%s dr_execution_restored_table_count=%s\n' \
  "${RESTORE_TARGET_ENV}" \
  "${POSTGRES_HOST}" \
  "${POSTGRES_DB}" \
  "${RESTORE_PRODUCTION_SYSTEM_IDENTIFIER:-none}" \
  "${BACKUP_DECLARED_FILE}" \
  "${BACKUP_SHA256}" \
  "${RESTORED_TABLE_COUNT}" \
  "${RESTORE_REHYDRATE_DURABLE_QUEUES}" \
  "${RESTORE_DR_SOURCE_URI:-none}" \
  "${RESTORE_DR_SOURCE_VERSION:-none}" \
  "${RESTORE_DR_PROVENANCE_SHA256:-none}" \
  "${RESTORE_DR_PROVENANCE_PRINCIPAL:-none}" \
  "${RESTORE_DR_PROVENANCE_REQUEST_ID:-none}" \
  "${RESTORE_DR_PROVENANCE_OBSERVED_AT:-none}" \
  "${RESTORE_DR_EXECUTION_ATTESTATION_SHA256:-none}" \
  "${RESTORE_DR_EXECUTION_SIGNATURE_BUNDLE_SHA256:-none}" \
  "${RESTORE_DR_EXECUTION_RUN_ID:-none}" \
  "${RESTORE_DR_EXECUTION_TARGET_IDENTITY:-none}" \
  "${RESTORE_DR_EXECUTION_TARGET_SYSTEM_IDENTIFIER:-none}" \
  "${RESTORE_DR_EXECUTION_RESTORED_TABLE_COUNT:-none}"
