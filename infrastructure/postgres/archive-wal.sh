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
  rm -f "${PITR_WAL_PROVIDER_RESPONSE}"
}
trap cleanup EXIT HUP INT TERM

[ "${PITR_WAL_PROVIDER_URL}" = "http://pitr-wal-provider:8080" ] \
  || pitr_fail "PITR_WAL_PROVIDER_URL must name the private Compose WAL provider."
pitr_is_bounded_positive_integer "${PITR_WAL_PROVIDER_CLIENT_TIMEOUT_SECONDS}" 1200 \
  || pitr_fail "PITR_WAL_PROVIDER_CLIENT_TIMEOUT_SECONDS must be an integer from 1 through 1200."
command -v wget >/dev/null 2>&1 || pitr_fail "Required command is missing: wget"

if ! wget \
  --quiet \
  --output-document="${PITR_WAL_PROVIDER_RESPONSE}" \
  --timeout="${PITR_WAL_PROVIDER_CLIENT_TIMEOUT_SECONDS}" \
  --tries=1 \
  --post-file="${SOURCE_PATH}" \
  "${PITR_WAL_PROVIDER_URL}/archive/${ARCHIVE_NAME}"
then
  pitr_fail "Request-scoped WAL provider did not confirm remote durability."
fi

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
