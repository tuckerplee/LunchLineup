#!/bin/sh
# Materialize an explicit remote base backup into an empty, isolated PGDATA volume.
set -eu
umask 077

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"
. "${REPO_ROOT}/infrastructure/postgres/pitr-object-store.sh"

PITR_BASE_BACKUP_ID="${PITR_BASE_BACKUP_ID:-}"
PITR_RECOVERY_TARGET_TIME="${PITR_RECOVERY_TARGET_TIME:-}"
PITR_RECOVERY_TARGET_TIMELINE="${PITR_RECOVERY_TARGET_TIMELINE:-}"
PITR_EXPECTED_SYSTEM_IDENTIFIER="${PITR_EXPECTED_SYSTEM_IDENTIFIER:-}"
PITR_ARCHIVED_WAL_SEGMENT="${PITR_ARCHIVED_WAL_SEGMENT:-}"
PITR_BASE_BACKUP_COMPLETE_VERSION_ID="${PITR_BASE_BACKUP_COMPLETE_VERSION_ID:-}"
PITR_BASE_BACKUP_ARCHIVE_VERSION_ID="${PITR_BASE_BACKUP_ARCHIVE_VERSION_ID:-}"
PITR_BASE_BACKUP_MANIFEST_VERSION_ID="${PITR_BASE_BACKUP_MANIFEST_VERSION_ID:-}"
PITR_ARCHIVED_WAL_VERSION_ID="${PITR_ARCHIVED_WAL_VERSION_ID:-}"
PITR_RESTORE_DATA_DIR="${PITR_RESTORE_DATA_DIR:-/restore}"
PITR_RESTORE_CONFIRM="${PITR_RESTORE_CONFIRM:-}"
PITR_STAGING_DIR="${PITR_STAGING_DIR:-/var/lib/lunchlineup-pitr}"
PITR_DOWNLOAD_DIR=""
PITR_MC_CONFIG_DIR=""

cleanup() {
  [ -z "${PITR_DOWNLOAD_DIR}" ] || rm -rf -- "${PITR_DOWNLOAD_DIR}"
  pitr_close_object_store
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

case "${PITR_BASE_BACKUP_ID}" in
  '' | latest | latest.* | *[!A-Za-z0-9._-]*) pitr_fail "PITR_BASE_BACKUP_ID must name one explicit backup." ;;
esac
command -v node >/dev/null 2>&1 || pitr_fail "node is required to validate PITR_RECOVERY_TARGET_TIME."
if ! node - "${PITR_RECOVERY_TARGET_TIME}" <<'JS'
const value = process.argv[2];
const match = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.exec(value);
const wholeSeconds = `${value.slice(0, 19)}Z`;
const parsed = new Date(wholeSeconds);
// Preserve fractional precision verbatim; Date is only the calendar validator.
if (!match || match[0] !== value || value.startsWith('0000-')
    || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== value.slice(0, 19)) {
  process.exitCode = 1;
}
JS
then
  pitr_fail "PITR_RECOVERY_TARGET_TIME must be a valid explicit UTC RFC3339 timestamp."
fi
case "${PITR_ARCHIVED_WAL_SEGMENT}" in
  ????????????????????????) case "${PITR_ARCHIVED_WAL_SEGMENT}" in *[!A-Fa-f0-9]*) pitr_fail "PITR_ARCHIVED_WAL_SEGMENT must be a 24-hex WAL segment name." ;; esac ;;
  *) pitr_fail "PITR_ARCHIVED_WAL_SEGMENT must be a 24-hex WAL segment name." ;;
esac
if ! node - "${PITR_RECOVERY_TARGET_TIMELINE}" "${PITR_ARCHIVED_WAL_SEGMENT}" <<'JS'
const [timeline, wal] = process.argv.slice(2);
const match = /^[1-9][0-9]{0,9}$/.exec(timeline);
if (!match || match[0] !== timeline
    || Number(timeline) > 0xffffffff
    || Number(timeline) !== Number.parseInt(wal.slice(0, 8), 16)) {
  process.exitCode = 1;
}
JS
then
  pitr_fail "PITR_RECOVERY_TARGET_TIMELINE must be an explicit decimal timeline matching the named archived WAL segment."
fi
if ! node - "${PITR_EXPECTED_SYSTEM_IDENTIFIER}" <<'JS'
const value = process.argv[2];
const match = /^[1-9][0-9]{0,19}$/.exec(value);
if (!match || match[0] !== value || BigInt(value) > 18446744073709551615n) {
  process.exitCode = 1;
}
JS
then
  pitr_fail "PITR_EXPECTED_SYSTEM_IDENTIFIER must be the independently recorded canonical PostgreSQL uint64 system identifier."
fi
for version_name in \
  PITR_BASE_BACKUP_COMPLETE_VERSION_ID \
  PITR_BASE_BACKUP_ARCHIVE_VERSION_ID \
  PITR_BASE_BACKUP_MANIFEST_VERSION_ID \
  PITR_ARCHIVED_WAL_VERSION_ID
do
  eval "version_value=\${${version_name}}"
  case "${version_value}" in
    '' | null | latest | *[!A-Za-z0-9._+=:/-]*) pitr_fail "${version_name} must name one exact immutable provider version." ;;
  esac
done
[ "${PITR_RESTORE_CONFIRM}" = "restore-pitr-${PITR_BASE_BACKUP_ID}" ] \
  || pitr_fail "Set PITR_RESTORE_CONFIRM=restore-pitr-${PITR_BASE_BACKUP_ID}."
if ! PITR_RESTORE_DATA_DIR="$(node - "${PITR_RESTORE_DATA_DIR}" <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const input = process.argv[2];
if (!path.isAbsolute(input)) process.exit(1);
const target = path.resolve(input);
if (target === '/' || target === '/var/lib/postgresql/data') process.exit(1);
let component = '/';
for (const part of target.split('/').filter(Boolean)) {
  component = path.join(component, part);
  try {
    const stat = fs.lstatSync(component);
    if (stat.isSymbolicLink() || !stat.isDirectory()) process.exit(1);
  } catch (error) {
    if (error.code === 'ENOENT') break;
    throw error;
  }
}
process.stdout.write(target);
JS
)"; then
  pitr_fail "Restore requires a separate absolute PGDATA directory without symbolic-link components."
fi
case "${PITR_STAGING_DIR}" in
  /) pitr_fail "PITR_STAGING_DIR must be a dedicated absolute directory." ;;
  /*) ;;
  *) pitr_fail "PITR_STAGING_DIR must be a dedicated absolute directory." ;;
esac

for command_name in pg_verifybackup pg_controldata timeout tar find mktemp sha256sum; do
  command -v "${command_name}" >/dev/null 2>&1 || pitr_fail "Required command is missing: ${command_name}"
done
mkdir -p "${PITR_RESTORE_DATA_DIR}" "${PITR_STAGING_DIR}"
[ -z "$(find "${PITR_RESTORE_DATA_DIR}" -mindepth 1 -maxdepth 1 -print -quit)" ] \
  || pitr_fail "PITR_RESTORE_DATA_DIR must be empty."
PITR_DOWNLOAD_DIR="$(mktemp -d "${PITR_STAGING_DIR}/restore-${PITR_BASE_BACKUP_ID}.XXXXXXXXXX")"

pitr_open_object_store
REMOTE_BACKUP="${PITR_REMOTE_ROOT}/basebackups/${PITR_BASE_BACKUP_ID}"
for object_and_version in \
  "COMPLETE|${PITR_BASE_BACKUP_COMPLETE_VERSION_ID}" \
  "base.tar.gz|${PITR_BASE_BACKUP_ARCHIVE_VERSION_ID}" \
  "backup_manifest|${PITR_BASE_BACKUP_MANIFEST_VERSION_ID}"
do
  object_name="${object_and_version%%|*}"
  object_version="${object_and_version#*|}"
  resolved_version="$(pitr_resolve_single_version "${REMOTE_BACKUP}/${object_name}")"
  [ "${resolved_version}" = "${object_version}" ] \
    || pitr_fail "Named ${object_name} version is not the single current immutable base-backup version."
  pitr_download_version "${REMOTE_BACKUP}/${object_name}" "${object_version}" "${PITR_DOWNLOAD_DIR}/${object_name}"
done
[ -s "${PITR_DOWNLOAD_DIR}/COMPLETE" ] || pitr_fail "Remote base backup has no COMPLETE commit marker."
[ -s "${PITR_DOWNLOAD_DIR}/base.tar.gz" ] || pitr_fail "Remote base backup archive is missing."
[ -s "${PITR_DOWNLOAD_DIR}/backup_manifest" ] || pitr_fail "Remote backup manifest is missing."
COMPLETE_BACKUP_ID="$(awk -F= '$1 == "backup_id" { print $2 }' "${PITR_DOWNLOAD_DIR}/COMPLETE")"
COMPLETE_TIMESTAMP="$(awk -F= '$1 == "completed_at" { print $2 }' "${PITR_DOWNLOAD_DIR}/COMPLETE")"
COMPLETE_MANIFEST_SHA256="$(awk -F= '$1 == "manifest_sha256" { print $2 }' "${PITR_DOWNLOAD_DIR}/COMPLETE")"
[ "${COMPLETE_BACKUP_ID}" = "${PITR_BASE_BACKUP_ID}" ] || pitr_fail "COMPLETE marker does not match the named base backup."
case "${COMPLETE_TIMESTAMP}" in ????-??-??T??:??:??Z) ;; *) pitr_fail "COMPLETE marker has no valid completion timestamp." ;; esac
[ "${COMPLETE_MANIFEST_SHA256}" = "$(sha256sum "${PITR_DOWNLOAD_DIR}/backup_manifest" | awk '{print $1}')" ] \
  || pitr_fail "COMPLETE marker manifest checksum does not match the downloaded backup manifest."
REMOTE_WAL="${PITR_REMOTE_ROOT}/wal/${PITR_ARCHIVED_WAL_SEGMENT}"
RESOLVED_WAL_VERSION="$(pitr_resolve_single_version "${REMOTE_WAL}")"
[ "${RESOLVED_WAL_VERSION}" = "${PITR_ARCHIVED_WAL_VERSION_ID}" ] \
  || pitr_fail "Named archived WAL version is not the single current immutable version."
pitr_exact_stat_version "${REMOTE_WAL}" "${PITR_ARCHIVED_WAL_VERSION_ID}" >/dev/null \
  || pitr_fail "Named archived WAL segment version is not remotely durable: ${PITR_ARCHIVED_WAL_SEGMENT}"

tar -xzf "${PITR_DOWNLOAD_DIR}/base.tar.gz" -C "${PITR_RESTORE_DATA_DIR}"
[ ! -e "${PITR_RESTORE_DATA_DIR}/tablespace_map" ] \
  || pitr_fail "This restore helper does not support external Postgres tablespaces."
[ -s "${PITR_RESTORE_DATA_DIR}/backup_manifest" ] \
  || pitr_fail "Extracted base backup manifest is missing."
[ "$(sha256sum "${PITR_RESTORE_DATA_DIR}/backup_manifest" | awk '{print $1}')" = "${COMPLETE_MANIFEST_SHA256}" ] \
  || pitr_fail "Extracted base backup manifest does not match the remote commit marker."
pg_verifybackup --no-parse-wal --exit-on-error "${PITR_RESTORE_DATA_DIR}"
[ "$(cat "${PITR_RESTORE_DATA_DIR}/PG_VERSION")" = 16 ] \
  || pitr_fail "Physical recovery requires a PostgreSQL 16 base backup."
# pg_controldata may exit successfully after printing a CRC/layout warning.
# Do not trust its identifier unless the bounded read is clean and unambiguous.
if ! LC_ALL=C timeout --signal=TERM --kill-after=5s 30s pg_controldata "${PITR_RESTORE_DATA_DIR}" \
  >"${PITR_DOWNLOAD_DIR}/control-data" 2>"${PITR_DOWNLOAD_DIR}/control-error"; then
  pitr_fail "PostgreSQL control-file read failed or timed out; recovery identity is unknown."
fi
[ ! -s "${PITR_DOWNLOAD_DIR}/control-error" ] \
  || pitr_fail "PostgreSQL control-file read reported diagnostics; refusing recovery."
if ! node - "${PITR_DOWNLOAD_DIR}/control-data" "${PITR_EXPECTED_SYSTEM_IDENTIFIER}" <<'JS'
const fs = require('node:fs');
const [path, expected] = process.argv.slice(2);
const output = fs.readFileSync(path, 'utf8');
const identifiers = [...output.matchAll(/^Database system identifier:[ \t]+([0-9]+)$/gm)];
if (output.includes('WARNING:') || identifiers.length !== 1 || identifiers[0][1] !== expected) {
  process.exitCode = 1;
}
JS
then
  pitr_fail "Base backup control-file identity is untrusted or differs from PITR_EXPECTED_SYSTEM_IDENTIFIER."
fi
touch "${PITR_RESTORE_DATA_DIR}/recovery.signal"
cat >>"${PITR_RESTORE_DATA_DIR}/postgresql.auto.conf" <<EOF
restore_command = 'sh /opt/lunchlineup/pitr/restore-wal.sh "%f" "%p"'
recovery_target_time = '${PITR_RECOVERY_TARGET_TIME}'
recovery_target_inclusive = true
recovery_target_timeline = '${PITR_RECOVERY_TARGET_TIMELINE}'
recovery_target_action = 'pause'
EOF
chmod 0700 "${PITR_RESTORE_DATA_DIR}"
cat >"${PITR_RESTORE_DATA_DIR}/lunchlineup-pitr-restore-source" <<EOF
base_backup_id=${PITR_BASE_BACKUP_ID}
base_backup_status=COMPLETE
base_backup_completed_at=${COMPLETE_TIMESTAMP}
base_backup_complete_version_id=${PITR_BASE_BACKUP_COMPLETE_VERSION_ID}
base_backup_archive_version_id=${PITR_BASE_BACKUP_ARCHIVE_VERSION_ID}
base_backup_manifest_version_id=${PITR_BASE_BACKUP_MANIFEST_VERSION_ID}
archived_wal_segment=${PITR_ARCHIVED_WAL_SEGMENT}
archived_wal_version_id=${PITR_ARCHIVED_WAL_VERSION_ID}
recovery_target_time=${PITR_RECOVERY_TARGET_TIME}
recovery_target_timeline=${PITR_RECOVERY_TARGET_TIMELINE}
system_identifier=${PITR_EXPECTED_SYSTEM_IDENTIFIER}
materialized_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
if id postgres >/dev/null 2>&1; then
  chown -R postgres:postgres "${PITR_RESTORE_DATA_DIR}"
fi

printf 'pitr_restore_materialized backup_id=%s target_time=%s wal_segment=%s data_dir=%s remote=%s complete_version_id=%s archive_version_id=%s manifest_version_id=%s wal_version_id=%s target_timeline=%s system_identifier=%s\n' \
  "${PITR_BASE_BACKUP_ID}" "${PITR_RECOVERY_TARGET_TIME}" "${PITR_ARCHIVED_WAL_SEGMENT}" "${PITR_RESTORE_DATA_DIR}" "${REMOTE_BACKUP}" \
  "${PITR_BASE_BACKUP_COMPLETE_VERSION_ID}" "${PITR_BASE_BACKUP_ARCHIVE_VERSION_ID}" \
  "${PITR_BASE_BACKUP_MANIFEST_VERSION_ID}" "${PITR_ARCHIVED_WAL_VERSION_ID}" "${PITR_RECOVERY_TARGET_TIMELINE}" "${PITR_EXPECTED_SYSTEM_IDENTIFIER}"
