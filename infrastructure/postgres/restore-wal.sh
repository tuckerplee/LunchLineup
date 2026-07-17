#!/bin/sh
# PostgreSQL restore_command target for an isolated PITR recovery cluster.
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
. "${SCRIPT_DIR}/pitr-object-store.sh"

[ "$#" -eq 2 ] || pitr_fail "restore-wal.sh requires archive filename and destination path."
ARCHIVE_NAME="$1"
DESTINATION="$2"
ARCHIVE_KIND="$(pitr_archive_kind "${ARCHIVE_NAME}")" || pitr_fail "Unexpected WAL restore filename."

PITR_MC_CONFIG_DIR=""
TMP_DESTINATION="${DESTINATION}.pitr-tmp.$$"
cleanup() {
  rm -f "${TMP_DESTINATION}"
  pitr_close_object_store
}
trap cleanup EXIT HUP INT TERM

pitr_open_object_store
case "${ARCHIVE_KIND}" in
  history) REMOTE_PATH="${PITR_REMOTE_ROOT}/history/${ARCHIVE_NAME}" ;;
  backup) REMOTE_PATH="${PITR_REMOTE_ROOT}/metadata/${ARCHIVE_NAME}" ;;
  wal) REMOTE_PATH="${PITR_REMOTE_ROOT}/wal/${ARCHIVE_NAME}" ;;
esac

RESTORED_VERSION="$(pitr_download_single_version "${REMOTE_PATH}" "${TMP_DESTINATION}")"
mv "${TMP_DESTINATION}" "${DESTINATION}"
printf 'pitr_wal_restored name=%s version_id=%s\n' "${ARCHIVE_NAME}" "${RESTORED_VERSION}" >&2
