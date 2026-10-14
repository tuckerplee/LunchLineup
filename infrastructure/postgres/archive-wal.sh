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

[ "${PITR_ENABLED:-false}" = "true" ] \
  || pitr_fail "archive-wal.sh cannot acknowledge WAL unless PITR_ENABLED=true."

PITR_MC_CONFIG_DIR=""
PITR_WAL_METRICS_FILE="${PITR_WAL_METRICS_FILE:-}"
PITR_WAL_PROVIDER_URL="${PITR_WAL_PROVIDER_URL:-http://pitr-wal-provider:8080}"
PITR_WAL_PROVIDER_CLIENT_TIMEOUT_SECONDS="${PITR_WAL_PROVIDER_CLIENT_TIMEOUT_SECONDS:-930}"
PITR_WAL_PROVIDER_RESPONSE="$(mktemp "${TMPDIR:-/tmp}/lunchlineup-pitr-wal-provider.XXXXXX")"

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
  rm -f "${PITR_WAL_PROVIDER_RESPONSE}" "${PITR_WAL_PROVIDER_RESPONSE}.raw"
}
trap cleanup EXIT HUP INT TERM

[ "${PITR_WAL_PROVIDER_URL}" = "http://pitr-wal-provider:8080" ] \
  || pitr_fail "PITR_WAL_PROVIDER_URL must name the private Compose WAL provider."
pitr_is_bounded_positive_integer "${PITR_WAL_PROVIDER_CLIENT_TIMEOUT_SECONDS}" 1200 \
  || pitr_fail "PITR_WAL_PROVIDER_CLIENT_TIMEOUT_SECONDS must be an integer from 1 through 1200."
for required_command in nc wc tr awk head; do
  command -v "${required_command}" >/dev/null 2>&1 || pitr_fail "Required command is missing: ${required_command}"
done

# Send the segment with netcat and an explicit Content-Length. BusyBox wget
# (the only HTTP client in the postgres image) treats --post-file content as a
# C string, so a WAL segment was truncated at its first NUL byte (3 bytes) and
# the provider "durably archived" a corrupt object. The provider rejects any
# body whose length differs from Content-Length, so a short read here fails.
SOURCE_BYTES="$(wc -c <"${SOURCE_PATH}" | tr -d ' \t')"
[ "${SOURCE_BYTES}" -gt 0 ] 2>/dev/null || pitr_fail "WAL source file is empty or unreadable: ${SOURCE_PATH}"
PITR_WAL_PROVIDER_RAW="${PITR_WAL_PROVIDER_RESPONSE}.raw"
if ! {
  printf 'POST /archive/%s HTTP/1.0\r\nHost: pitr-wal-provider:8080\r\nContent-Type: application/octet-stream\r\nContent-Length: %s\r\nConnection: close\r\n\r\n' \
    "${ARCHIVE_NAME}" "${SOURCE_BYTES}"
  cat "${SOURCE_PATH}"
} | nc -w "${PITR_WAL_PROVIDER_CLIENT_TIMEOUT_SECONDS}" pitr-wal-provider 8080 >"${PITR_WAL_PROVIDER_RAW}"
then
  rm -f "${PITR_WAL_PROVIDER_RAW}"
  pitr_fail "Request-scoped WAL provider did not confirm remote durability."
fi
PITR_WAL_PROVIDER_STATUS_LINE="$(head -n 1 "${PITR_WAL_PROVIDER_RAW}" | tr -d '\r')"
case "${PITR_WAL_PROVIDER_STATUS_LINE}" in
  'HTTP/1.'[01]' 200 '*) ;;
  *)
    rm -f "${PITR_WAL_PROVIDER_RAW}"
    pitr_fail "Request-scoped WAL provider did not confirm remote durability (${PITR_WAL_PROVIDER_STATUS_LINE:-no response})."
    ;;
esac
tr -d '\r' <"${PITR_WAL_PROVIDER_RAW}" | awk 'body { print } /^$/ { body = 1 }' >"${PITR_WAL_PROVIDER_RESPONSE}"
rm -f "${PITR_WAL_PROVIDER_RAW}"

provider_line_count="$(wc -l <"${PITR_WAL_PROVIDER_RESPONSE}" | tr -d ' ')"
[ "${provider_line_count}" -eq 1 ] || pitr_fail "WAL provider returned malformed durability proof."
IFS=' ' read -r provider_marker provider_name provider_version provider_conditional provider_extra \
  <"${PITR_WAL_PROVIDER_RESPONSE}"
[ "${provider_marker}" = "pitr_wal_provider_uploaded" ] \
  && [ "${provider_name}" = "name=${ARCHIVE_NAME}" ] \
  && [ "${provider_conditional}" = "conditional_create=true" ] \
  && [ -z "${provider_extra}" ] \
  || pitr_fail "WAL provider returned mismatched durability proof."
ARCHIVE_VERSION="${provider_version#version_id=}"
[ "${provider_version}" = "version_id=${ARCHIVE_VERSION}" ] \
  || pitr_fail "WAL provider proof has no version identity."
case "${ARCHIVE_VERSION}" in
  '' | *[!A-Za-z0-9._+=:/-]*) pitr_fail "WAL provider proof has an invalid version identity." ;;
esac

printf 'pitr_wal_archived name=%s provider=pitr-wal-provider version_id=%s conditional_create=true\n' \
  "${ARCHIVE_NAME}" "${ARCHIVE_VERSION}"
