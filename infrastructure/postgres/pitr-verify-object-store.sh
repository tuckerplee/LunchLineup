#!/bin/sh
# Proves one PITR writer is append-only and targets versioned COMPLIANCE storage.
set -eu
umask 077

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
. "${SCRIPT_DIR}/pitr-object-store.sh"

WRITER_NAME="${1:-}"
case "${WRITER_NAME}" in
  wal | base-backup) ;;
  *) pitr_fail "Writer name must be wal or base-backup." ;;
esac

PITR_MC_CONFIG_DIR=""
PROBE_FILE=""
cleanup() {
  [ -z "${PROBE_FILE}" ] || rm -f "${PROBE_FILE}"
  pitr_close_object_store
}
trap cleanup EXIT HUP INT TERM

pitr_open_object_store
BUCKET_ROOT="pitr/${PITR_S3_BUCKET}"
VERSION_INFO="$(pitr_mc version info "${BUCKET_ROOT}")" \
  || pitr_fail "${WRITER_NAME} identity cannot verify bucket versioning."
printf '%s\n' "${VERSION_INFO}" | grep -qi 'enabled' \
  || pitr_fail "PITR bucket versioning is not enabled."

RETENTION_INFO="$(pitr_mc retention info --default "${BUCKET_ROOT}")" \
  || pitr_fail "${WRITER_NAME} identity cannot verify default Object Lock retention."
printf '%s\n' "${RETENTION_INFO}" | grep -qi 'compliance' \
  || pitr_fail "PITR bucket default Object Lock mode must be COMPLIANCE."
printf '%s\n' "${RETENTION_INFO}" | grep -Eqi "(^|[^0-9])${PITR_OBJECT_LOCK_RETENTION_DAYS}[[:space:]]*(d|day|days)([^A-Za-z]|$)" \
  || pitr_fail "PITR bucket default retention does not match PITR_OBJECT_LOCK_RETENTION_DAYS."

PROBE_FILE="$(mktemp "${TMPDIR:-/tmp}/lunchlineup-pitr-${WRITER_NAME}.XXXXXX")"
printf 'writer=%s checked_at=%s\n' "${WRITER_NAME}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"${PROBE_FILE}"
PROBE_NAME="$(basename "${PROBE_FILE}")-$$"
PROBE_REMOTE="${PITR_REMOTE_ROOT}/readiness/${WRITER_NAME}/${PROBE_NAME}"
PROBE_VERSION="$(pitr_upload_encrypted "${PROBE_FILE}" "${PROBE_REMOTE}")"

if pitr_mc rm --force "${PROBE_REMOTE}" >/dev/null 2>&1; then
  pitr_fail "${WRITER_NAME} identity can create delete markers; append-only policy is required."
fi
if pitr_mc rm --version-id "${PROBE_VERSION}" --force "${PROBE_REMOTE}" >/dev/null 2>&1; then
  pitr_fail "${WRITER_NAME} identity can delete object versions; append-only policy is required."
fi
pitr_exact_stat_version "${PROBE_REMOTE}" "${PROBE_VERSION}" >/dev/null \
  || pitr_fail "Deletion-denial probe is no longer readable."
OBJECT_RETENTION="$(pitr_mc retention info --version-id "${PROBE_VERSION}" "${PROBE_REMOTE}")" \
  || pitr_fail "Uploaded probe has no readable Object Lock retention."
printf '%s\n' "${OBJECT_RETENTION}" | grep -qi 'compliance' \
  || pitr_fail "Uploaded probe is not protected by COMPLIANCE Object Lock."

printf 'pitr_object_store_ready writer=%s versioning=enabled object_lock=compliance retention_days=%s delete=denied remote=%s version_id=%s conditional_create=true\n' \
  "${WRITER_NAME}" "${PITR_OBJECT_LOCK_RETENTION_DAYS}" "${PROBE_REMOTE}" "${PROBE_VERSION}"
