#!/bin/sh
# Shared fail-closed S3-compatible object-store setup for PostgreSQL PITR scripts.
set -eu

pitr_fail() {
  echo "ERROR: $*" >&2
  exit 1
}

pitr_is_positive_integer() {
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
    *) [ "$1" -ge 1 ] ;;
  esac
}

pitr_archive_kind() {
  archive_name="$1"
  if printf '%s\n' "${archive_name}" | grep -Eq '^[0-9A-F]{24}$'; then
    printf '%s\n' wal
  elif printf '%s\n' "${archive_name}" | grep -Eq '^[0-9A-F]{8}\.history$'; then
    printf '%s\n' history
  elif printf '%s\n' "${archive_name}" | grep -Eq '^[0-9A-F]{24}\.[0-9A-F]{8}\.backup$'; then
    printf '%s\n' backup
  else
    return 1
  fi
}

pitr_validate_object_store() {
  [ "${PITR_ENABLED:-false}" = "true" ] || pitr_fail "PITR_ENABLED must be true."

  case "${PITR_S3_ENDPOINT:-}" in
    https://*) ;;
    http://*) [ "${PITR_ALLOW_INSECURE_ENDPOINT:-false}" = "true" ] || pitr_fail "PITR_S3_ENDPOINT must use HTTPS." ;;
    *) pitr_fail "PITR_S3_ENDPOINT must be an explicit HTTPS S3-compatible endpoint." ;;
  esac

  case "${PITR_S3_BUCKET:-}" in
    '' | *[!a-z0-9.-]* | .* | *.) pitr_fail "PITR_S3_BUCKET must be a valid explicit bucket name." ;;
  esac
  case "${PITR_S3_PREFIX:-}" in
    '' | /* | */ | *..* | *//* | *[!A-Za-z0-9._/-]*) pitr_fail "PITR_S3_PREFIX must be a dedicated cluster prefix." ;;
  esac

  PITR_MC_BIN="${PITR_MC_BIN:-/opt/lunchlineup/tools/mc}"
  PITR_OBJECT_LOCK_RETENTION_DAYS="${PITR_OBJECT_LOCK_RETENTION_DAYS:-}"
  PITR_ACCESS_KEY_FILE="${PITR_ACCESS_KEY_FILE:-}"
  PITR_SECRET_KEY_FILE="${PITR_SECRET_KEY_FILE:-}"
  pitr_is_positive_integer "${PITR_OBJECT_LOCK_RETENTION_DAYS}" \
    || pitr_fail "PITR_OBJECT_LOCK_RETENTION_DAYS must be a positive integer."
  [ -x "${PITR_MC_BIN}" ] || pitr_fail "PITR object-store client is not executable: ${PITR_MC_BIN}"
  [ -s "${PITR_ACCESS_KEY_FILE}" ] || pitr_fail "PITR access-key secret is missing."
  [ -s "${PITR_SECRET_KEY_FILE}" ] || pitr_fail "PITR secret-key secret is missing."
}

pitr_open_object_store() {
  pitr_validate_object_store
  PITR_MC_CONFIG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lunchlineup-pitr-mc.XXXXXX")"
  PITR_ACCESS_KEY="$(cat "${PITR_ACCESS_KEY_FILE}")"
  PITR_SECRET_KEY="$(cat "${PITR_SECRET_KEY_FILE}")"
  [ -n "${PITR_ACCESS_KEY}" ] || pitr_fail "PITR access-key secret is empty."
  [ -n "${PITR_SECRET_KEY}" ] || pitr_fail "PITR secret-key secret is empty."

  "${PITR_MC_BIN}" --config-dir "${PITR_MC_CONFIG_DIR}" alias set \
    --api S3v4 \
    --path auto \
    pitr \
    "${PITR_S3_ENDPOINT}" \
    "${PITR_ACCESS_KEY}" \
    "${PITR_SECRET_KEY}" >/dev/null
  unset PITR_ACCESS_KEY PITR_SECRET_KEY
  PITR_REMOTE_ROOT="pitr/${PITR_S3_BUCKET}/${PITR_S3_PREFIX}"
}

pitr_close_object_store() {
  if [ -n "${PITR_MC_CONFIG_DIR:-}" ]; then
    rm -rf "${PITR_MC_CONFIG_DIR}"
    PITR_MC_CONFIG_DIR=""
  fi
}

pitr_mc() {
  "${PITR_MC_BIN}" --config-dir "${PITR_MC_CONFIG_DIR}" "$@"
}

pitr_upload_encrypted() {
  source_file="$1"
  target="$2"
  pitr_mc cp \
    --checksum SHA256 \
    --disable-multipart \
    --retention-mode COMPLIANCE \
    --retention-duration "${PITR_OBJECT_LOCK_RETENTION_DAYS}d" \
    --enc-s3 "${target}" \
    "${source_file}" \
    "${target}"
}
