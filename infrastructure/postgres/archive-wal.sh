#!/bin/sh
# PostgreSQL archive_command target. Zero means the remote object is durable and identical.
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
. "${SCRIPT_DIR}/pitr-object-store.sh"

[ "$#" -eq 2 ] || pitr_fail "archive-wal.sh requires source path and archive filename."
SOURCE_PATH="$1"
ARCHIVE_NAME="$2"
[ -f "${SOURCE_PATH}" ] || pitr_fail "WAL source file does not exist: ${SOURCE_PATH}"
ARCHIVE_KIND="$(pitr_archive_kind "${ARCHIVE_NAME}")" || pitr_fail "Unexpected WAL archive filename."

# Development can opt out explicitly. The production launch gate requires true.
if [ "${PITR_ENABLED:-false}" != "true" ]; then
  exit 0
fi

PITR_MC_CONFIG_DIR=""
VERIFY_FILE=""
PITR_WAL_METRICS_FILE="${PITR_WAL_METRICS_FILE:-}"

metric_value() {
  metric_name="$1"
  [ -s "${PITR_WAL_METRICS_FILE}" ] || return 0
  awk -v name="${metric_name}" '$1 == name { value = $2 } END { if (value != "") print value }' "${PITR_WAL_METRICS_FILE}"
}

write_wal_metrics() {
  outcome="$1"
  [ -n "${PITR_WAL_METRICS_FILE}" ] || return 0
  metrics_dir="$(dirname "${PITR_WAL_METRICS_FILE}")"
  [ -d "${metrics_dir}" ] || return 0
  metrics_tmp="$(mktemp "${metrics_dir}/lunchlineup-pitr-wal.prom.tmp.XXXXXX")" || return 0
  now="$(date -u +%s)"
  last_success="$(metric_value lunchlineup_pitr_wal_archive_last_success_timestamp_seconds)"
  last_failure="$(metric_value lunchlineup_pitr_wal_archive_last_failure_timestamp_seconds)"
  [ "${outcome}" = success ] && last_success="${now}"
  [ "${outcome}" = failure ] && last_failure="${now}"
  cat >"${metrics_tmp}" <<EOF
# HELP lunchlineup_pitr_wal_archive_last_success_timestamp_seconds Unix timestamp of the last remotely verified WAL archive.
# TYPE lunchlineup_pitr_wal_archive_last_success_timestamp_seconds gauge
lunchlineup_pitr_wal_archive_last_success_timestamp_seconds ${last_success:-0}
# HELP lunchlineup_pitr_wal_archive_last_failure_timestamp_seconds Unix timestamp of the last failed WAL archive attempt.
# TYPE lunchlineup_pitr_wal_archive_last_failure_timestamp_seconds gauge
lunchlineup_pitr_wal_archive_last_failure_timestamp_seconds ${last_failure:-0}
EOF
  mv "${metrics_tmp}" "${PITR_WAL_METRICS_FILE}" || rm -f "${metrics_tmp}"
}

cleanup() {
  cleanup_status=$?
  if [ "${cleanup_status}" -eq 0 ]; then
    write_wal_metrics success || true
  else
    write_wal_metrics failure || true
  fi
  [ -z "${VERIFY_FILE}" ] || rm -f "${VERIFY_FILE}"
  pitr_close_object_store
}
trap cleanup EXIT HUP INT TERM

pitr_open_object_store
case "${ARCHIVE_KIND}" in
  history) REMOTE_PATH="${PITR_REMOTE_ROOT}/history/${ARCHIVE_NAME}" ;;
  backup) REMOTE_PATH="${PITR_REMOTE_ROOT}/metadata/${ARCHIVE_NAME}" ;;
  wal) REMOTE_PATH="${PITR_REMOTE_ROOT}/wal/${ARCHIVE_NAME}" ;;
esac

if pitr_mc stat "${REMOTE_PATH}" >/dev/null 2>&1; then
  VERIFY_FILE="$(mktemp "${TMPDIR:-/tmp}/lunchlineup-wal-verify.XXXXXX")"
  pitr_mc cp "${REMOTE_PATH}" "${VERIFY_FILE}" >/dev/null
  cmp -s "${SOURCE_PATH}" "${VERIFY_FILE}" || pitr_fail "Remote WAL object exists with different bytes: ${ARCHIVE_NAME}"
  exit 0
fi

pitr_upload_encrypted "${SOURCE_PATH}" "${REMOTE_PATH}" >/dev/null
pitr_mc stat "${REMOTE_PATH}" >/dev/null
printf 'pitr_wal_archived name=%s target=%s\n' "${ARCHIVE_NAME}" "${REMOTE_PATH}"
