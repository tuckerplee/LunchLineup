#!/bin/sh
# Request-scoped WAL upload worker. Its container exits after this command.
set -eu
umask 077

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
. "${SCRIPT_DIR}/pitr-object-store.sh"

[ "$#" -eq 2 ] || pitr_fail "pitr-wal-provider-upload.sh requires source path and archive filename."
SOURCE_PATH="$1"
ARCHIVE_NAME="$2"
[ -f "${SOURCE_PATH}" ] || pitr_fail "WAL provider source file does not exist."
ARCHIVE_KIND="$(pitr_archive_kind "${ARCHIVE_NAME}")" || pitr_fail "Unexpected WAL archive filename."

PITR_MC_CONFIG_DIR=""
cleanup() {
  pitr_close_object_store
}
trap cleanup EXIT HUP INT TERM

pitr_open_object_store
case "${ARCHIVE_KIND}" in
  history) REMOTE_PATH="${PITR_REMOTE_ROOT}/history/${ARCHIVE_NAME}" ;;
  backup) REMOTE_PATH="${PITR_REMOTE_ROOT}/metadata/${ARCHIVE_NAME}" ;;
  wal) REMOTE_PATH="${PITR_REMOTE_ROOT}/wal/${ARCHIVE_NAME}" ;;
esac

ARCHIVE_VERSION="$(pitr_upload_encrypted "${SOURCE_PATH}" "${REMOTE_PATH}")"
printf 'pitr_wal_provider_uploaded name=%s version_id=%s conditional_create=true\n' \
  "${ARCHIVE_NAME}" "${ARCHIVE_VERSION}"
