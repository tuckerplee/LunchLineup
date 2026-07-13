#!/bin/sh
# Materialize an explicit remote base backup into an empty, isolated PGDATA volume.
set -eu
umask 077

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"
. "${REPO_ROOT}/infrastructure/postgres/pitr-object-store.sh"

PITR_BASE_BACKUP_ID="${PITR_BASE_BACKUP_ID:-}"
PITR_RECOVERY_TARGET_TIME="${PITR_RECOVERY_TARGET_TIME:-}"
PITR_ARCHIVED_WAL_SEGMENT="${PITR_ARCHIVED_WAL_SEGMENT:-}"
PITR_RESTORE_DATA_DIR="${PITR_RESTORE_DATA_DIR:-/restore}"
PITR_RESTORE_CONFIRM="${PITR_RESTORE_CONFIRM:-}"
PITR_DOWNLOAD_DIR="${PITR_STAGING_DIR:-/var/lib/lunchlineup-pitr}/restore-${PITR_BASE_BACKUP_ID}-$$"
PITR_MC_CONFIG_DIR=""

cleanup() {
  rm -rf "${PITR_DOWNLOAD_DIR}"
  pitr_close_object_store
}
trap cleanup EXIT HUP INT TERM

case "${PITR_BASE_BACKUP_ID}" in
  '' | latest | latest.* | *[!A-Za-z0-9._-]*) pitr_fail "PITR_BASE_BACKUP_ID must name one explicit backup." ;;
esac
case "${PITR_RECOVERY_TARGET_TIME}" in
  ????-??-??T??:??:??Z | ????-??-??T??:??:??.*Z) ;;
  *) pitr_fail "PITR_RECOVERY_TARGET_TIME must be an explicit UTC RFC3339 timestamp." ;;
esac
case "${PITR_ARCHIVED_WAL_SEGMENT}" in
  ????????????????????????) case "${PITR_ARCHIVED_WAL_SEGMENT}" in *[!A-Fa-f0-9]*) pitr_fail "PITR_ARCHIVED_WAL_SEGMENT must be a 24-hex WAL segment name." ;; esac ;;
  *) pitr_fail "PITR_ARCHIVED_WAL_SEGMENT must be a 24-hex WAL segment name." ;;
esac
[ "${PITR_RESTORE_CONFIRM}" = "restore-pitr-${PITR_BASE_BACKUP_ID}" ] \
  || pitr_fail "Set PITR_RESTORE_CONFIRM=restore-pitr-${PITR_BASE_BACKUP_ID}."
case "${PITR_RESTORE_DATA_DIR}" in
  '' | / | . | .. | /var/lib/postgresql/data) pitr_fail "Restore must target a separate empty PGDATA directory." ;;
esac

for command_name in pg_verifybackup tar find mktemp sha256sum; do
  command -v "${command_name}" >/dev/null 2>&1 || pitr_fail "Required command is missing: ${command_name}"
done
mkdir -p "${PITR_RESTORE_DATA_DIR}" "${PITR_DOWNLOAD_DIR}"
[ -z "$(find "${PITR_RESTORE_DATA_DIR}" -mindepth 1 -maxdepth 1 -print -quit)" ] \
  || pitr_fail "PITR_RESTORE_DATA_DIR must be empty."

pitr_open_object_store
REMOTE_BACKUP="${PITR_REMOTE_ROOT}/basebackups/${PITR_BASE_BACKUP_ID}"
pitr_mc cp --recursive "${REMOTE_BACKUP}/" "${PITR_DOWNLOAD_DIR}/" >/dev/null
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
pitr_mc stat "${REMOTE_WAL}" >/dev/null || pitr_fail "Named archived WAL segment is not remotely durable: ${PITR_ARCHIVED_WAL_SEGMENT}"

tar -xzf "${PITR_DOWNLOAD_DIR}/base.tar.gz" -C "${PITR_RESTORE_DATA_DIR}"
[ ! -e "${PITR_RESTORE_DATA_DIR}/tablespace_map" ] \
  || pitr_fail "This restore helper does not support external Postgres tablespaces."
[ -s "${PITR_RESTORE_DATA_DIR}/backup_manifest" ] \
  || pitr_fail "Extracted base backup manifest is missing."
[ "$(sha256sum "${PITR_RESTORE_DATA_DIR}/backup_manifest" | awk '{print $1}')" = "${COMPLETE_MANIFEST_SHA256}" ] \
  || pitr_fail "Extracted base backup manifest does not match the remote commit marker."
pg_verifybackup --no-parse-wal --exit-on-error "${PITR_RESTORE_DATA_DIR}"
touch "${PITR_RESTORE_DATA_DIR}/recovery.signal"
cat >>"${PITR_RESTORE_DATA_DIR}/postgresql.auto.conf" <<EOF
restore_command = 'sh /opt/lunchlineup/pitr/restore-wal.sh "%f" "%p"'
recovery_target_time = '${PITR_RECOVERY_TARGET_TIME}'
recovery_target_inclusive = true
recovery_target_timeline = 'latest'
recovery_target_action = 'pause'
EOF
chmod 0700 "${PITR_RESTORE_DATA_DIR}"
cat >"${PITR_RESTORE_DATA_DIR}/lunchlineup-pitr-restore-source" <<EOF
base_backup_id=${PITR_BASE_BACKUP_ID}
base_backup_status=COMPLETE
base_backup_completed_at=${COMPLETE_TIMESTAMP}
archived_wal_segment=${PITR_ARCHIVED_WAL_SEGMENT}
recovery_target_time=${PITR_RECOVERY_TARGET_TIME}
materialized_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
if id postgres >/dev/null 2>&1; then
  chown -R postgres:postgres "${PITR_RESTORE_DATA_DIR}"
fi

printf 'pitr_restore_materialized backup_id=%s target_time=%s wal_segment=%s data_dir=%s remote=%s\n' \
  "${PITR_BASE_BACKUP_ID}" "${PITR_RECOVERY_TARGET_TIME}" "${PITR_ARCHIVED_WAL_SEGMENT}" "${PITR_RESTORE_DATA_DIR}" "${REMOTE_BACKUP}"
