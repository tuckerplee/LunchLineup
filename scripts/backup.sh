#!/bin/bash
# scripts/backup.sh
# Encrypted Postgres backup helper for production and disposable restore tests.
set -euo pipefail
IFS=$'\n\t'
umask 077

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

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

validate_backup_settings() {
  case "${BACKUP_DIR}" in
    '' | '/' | '.' | '..')
      fail "BACKUP_DIR must be a dedicated backup directory, not '${BACKUP_DIR}'."
      ;;
  esac

  [[ "${BACKUP_PREFIX}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || fail "BACKUP_PREFIX must contain only letters, numbers, dots, underscores, or hyphens."
  case "${BACKUP_PREFIX}" in
    '.' | '..' | *'..'*) fail "BACKUP_PREFIX must be a simple filename prefix." ;;
  esac

  is_unsigned_integer "${BACKUP_RETENTION_DAYS}" || fail "BACKUP_RETENTION_DAYS must be a positive integer."
  [ "${BACKUP_RETENTION_DAYS}" -ge 1 ] || fail "BACKUP_RETENTION_DAYS must be at least 1."
  is_unsigned_integer "${BACKUP_OFFSITE_RETENTION_DAYS}" || fail "BACKUP_OFFSITE_RETENTION_DAYS must be a positive integer."
  [ "${BACKUP_OFFSITE_RETENTION_DAYS}" -ge 1 ] || fail "BACKUP_OFFSITE_RETENTION_DAYS must be at least 1."
  case "${BACKUP_OFFSITE_RETENTION_DRY_RUN}" in
    true | false) ;;
    *) fail "BACKUP_OFFSITE_RETENTION_DRY_RUN must be true or false." ;;
  esac
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

write_backup_metrics() {
  [ -n "${BACKUP_METRICS_FILE:-}" ] || return 0

  local metrics_dir
  local tmp_metrics_file
  metrics_dir="$(dirname "${BACKUP_METRICS_FILE}")"
  mkdir -p "${metrics_dir}"
  tmp_metrics_file="$(mktemp "${metrics_dir}/lunchlineup-backup.prom.tmp.XXXXXX")"

  cat >"${tmp_metrics_file}" <<METRICS
# HELP lunchlineup_backup_last_success_timestamp_seconds Unix timestamp of the last successful encrypted LunchLineup backup.
# TYPE lunchlineup_backup_last_success_timestamp_seconds gauge
lunchlineup_backup_last_success_timestamp_seconds ${BACKUP_COMPLETED_AT}
# HELP lunchlineup_backup_last_success_size_bytes Size in bytes of the last successful encrypted LunchLineup backup.
# TYPE lunchlineup_backup_last_success_size_bytes gauge
lunchlineup_backup_last_success_size_bytes ${BACKUP_SIZE_BYTES}
METRICS

  mv "${tmp_metrics_file}" "${BACKUP_METRICS_FILE}"
}

validate_offsite_repository() {
  local offsite_uri="$1"
  local target

  case "${offsite_uri}" in
    *[$'\t\r\n ']* | *'\'* | *'..'* | *'?'* | *'['* | *']'* | *'*'*)
      fail "BACKUP_OFFSITE_URI must be an exact repository without whitespace, traversal, or glob characters."
      ;;
    s3://*)
      target="${offsite_uri#s3://}"
      case "${target}" in /* | *'//'*) fail "BACKUP_OFFSITE_URI must use one non-root S3 prefix." ;; esac
      [ "${target}" != "${target#*/}" ] || fail "BACKUP_OFFSITE_URI must include a non-root S3 prefix."
      [ -n "${target%%/*}" ] && [ -n "${target#*/}" ] || fail "BACKUP_OFFSITE_URI must include an S3 bucket and non-root prefix."
      OFFSITE_KIND="s3"
      OFFSITE_REPOSITORY="s3://${target%/}"
      OFFSITE_S3_BUCKET="${target%%/*}"
      OFFSITE_S3_PREFIX="${target#*/}"
      OFFSITE_S3_PREFIX="${OFFSITE_S3_PREFIX%/}"
      ;;
    rclone:*)
      target="${offsite_uri#rclone:}"
      case "${target}" in *'//'*) fail "BACKUP_OFFSITE_URI must use one non-root rclone path." ;; esac
      [ "${target}" != "${target#*:}" ] || fail "BACKUP_OFFSITE_URI must include an rclone remote and non-root path."
      [ -n "${target%%:*}" ] && [ -n "${target#*:}" ] || fail "BACKUP_OFFSITE_URI must include an rclone remote and non-root path."
      OFFSITE_KIND="rclone"
      OFFSITE_REPOSITORY="${target%/}"
      ;;
    *)
      fail "Unsupported BACKUP_OFFSITE_URI. Use s3://... or rclone:<remote:path>."
      ;;
  esac
}

record_offsite_candidate() {
  local object_name="$1"
  local object_uri="$2"
  local object_timestamp

  case "${object_name}" in
    "${BACKUP_PREFIX}"-*.sql.zst.gpg) object_timestamp="${object_name#"${BACKUP_PREFIX}"-}"; object_timestamp="${object_timestamp%.sql.zst.gpg}" ;;
    "${BACKUP_PREFIX}"-*.sql.zst.gpg.sha256) object_timestamp="${object_name#"${BACKUP_PREFIX}"-}"; object_timestamp="${object_timestamp%.sql.zst.gpg.sha256}" ;;
    *) return 0 ;;
  esac
  [[ "${object_timestamp}" =~ ^[0-9]{14}$ ]] || return 0

  [[ "${object_timestamp}" < "${BACKUP_OFFSITE_RETENTION_CUTOFF}" ]] || return 0
  BACKUP_OFFSITE_RETENTION_CANDIDATES=$((BACKUP_OFFSITE_RETENTION_CANDIDATES + 1))
  printf 'offsite_retention_candidate mode=%s object=%s\n' "${BACKUP_OFFSITE_RETENTION_MODE}" "${object_uri}"

  [ "${BACKUP_OFFSITE_RETENTION_DRY_RUN}" = "false" ] || return 0
  case "${OFFSITE_KIND}" in
    s3) aws s3 rm "${object_uri}" || fail "Failed to delete retained S3 backup object: ${object_uri}" ;;
    rclone) rclone deletefile "${object_uri}" || fail "Failed to delete retained rclone backup object: ${object_uri}" ;;
  esac
  BACKUP_OFFSITE_RETENTION_DELETED=$((BACKUP_OFFSITE_RETENTION_DELETED + 1))
}

prune_offsite() {
  local listing
  local line
  local object_key
  local object_name
  local expected_prefix

  BACKUP_OFFSITE_RETENTION_CANDIDATES=0
  BACKUP_OFFSITE_RETENTION_DELETED=0
  BACKUP_OFFSITE_RETENTION_MODE="execute"
  [ "${BACKUP_OFFSITE_RETENTION_DRY_RUN}" = "false" ] || BACKUP_OFFSITE_RETENTION_MODE="dry_run"
  BACKUP_OFFSITE_RETENTION_CUTOFF="$(date -u -d "@$(( $(date -u +%s) - BACKUP_OFFSITE_RETENTION_DAYS * 86400 ))" +%Y%m%d%H%M%S)" \
    || fail "Unable to calculate offsite backup retention cutoff."

  case "${OFFSITE_KIND}" in
    s3)
      if ! listing="$(aws s3 ls "${OFFSITE_REPOSITORY}/" --recursive)"; then
        fail "Failed to list the configured S3 backup repository for retention."
      fi
      expected_prefix="${OFFSITE_S3_PREFIX}/"
      while IFS= read -r line; do
        [ -n "${line}" ] || continue
        object_key="$(printf '%s\n' "${line}" | awk '{print $4}')"
        case "${object_key}" in
          "${expected_prefix}"*) ;;
          *) continue ;;
        esac
        object_name="${object_key#"${expected_prefix}"}"
        case "${object_name}" in */*) continue ;; esac
        record_offsite_candidate "${object_name}" "s3://${OFFSITE_S3_BUCKET}/${object_key}"
      done <<<"${listing}"
      ;;
    rclone)
      if ! listing="$(rclone lsf "${OFFSITE_REPOSITORY}" --files-only --max-depth 1)"; then
        fail "Failed to list the configured rclone backup repository for retention."
      fi
      while IFS= read -r object_name; do
        [ -n "${object_name}" ] || continue
        case "${object_name}" in */*) continue ;; esac
        record_offsite_candidate "${object_name}" "${OFFSITE_REPOSITORY}/${object_name}"
      done <<<"${listing}"
      ;;
  esac

  printf 'offsite_retention_ok mode=%s repository=%s cutoff=%s candidates=%s deleted=%s\n' \
    "${BACKUP_OFFSITE_RETENTION_MODE}" \
    "${BACKUP_OFFSITE_PROOF_URI}" \
    "${BACKUP_OFFSITE_RETENTION_CUTOFF}" \
    "${BACKUP_OFFSITE_RETENTION_CANDIDATES}" \
    "${BACKUP_OFFSITE_RETENTION_DELETED}"
}

sync_offsite() {
  local offsite_uri="${BACKUP_OFFSITE_URI:-}"

  if [ -z "${offsite_uri}" ] && [ "${BACKUP_OFFSITE_ENABLED:-false}" = "true" ]; then
    [ -n "${BACKUP_S3_BUCKET:-}" ] || fail "BACKUP_S3_BUCKET or BACKUP_OFFSITE_URI is required when BACKUP_OFFSITE_ENABLED=true."
    offsite_uri="s3://${BACKUP_S3_BUCKET}/db-backups/"
  fi

  [ -n "${offsite_uri}" ] || return 0
  validate_offsite_repository "${offsite_uri}"
  if [ "${OFFSITE_KIND}" = "rclone" ]; then
    BACKUP_OFFSITE_PROOF_URI="rclone:${OFFSITE_REPOSITORY}/"
  else
    BACKUP_OFFSITE_PROOF_URI="${OFFSITE_REPOSITORY}/"
  fi

  case "${OFFSITE_KIND}" in
    s3)
      require_command aws
      [ -r "${AWS_SHARED_CREDENTIALS_FILE:-}" ] || fail "AWS_SHARED_CREDENTIALS_FILE must name a readable dedicated credentials file for s3 backups."
      aws s3 cp "${BACKUP_FILE}" "${OFFSITE_REPOSITORY}/"
      aws s3 cp "${BACKUP_FILE}.sha256" "${OFFSITE_REPOSITORY}/"
      ;;
    rclone)
      require_command rclone
      [ -r "${RCLONE_CONFIG:-}" ] || fail "RCLONE_CONFIG must name a readable dedicated config file for rclone backups."
      rclone copyto "${BACKUP_FILE}" "${OFFSITE_REPOSITORY}/$(basename "${BACKUP_FILE}")"
      rclone copyto "${BACKUP_FILE}.sha256" "${OFFSITE_REPOSITORY}/$(basename "${BACKUP_FILE}.sha256")"
      ;;
  esac

  prune_offsite
}

write_backup_proof() {
  printf 'backup_ok backup_file=%s checksum_file=%s backup_sha256=%s size_bytes=%s offsite_uri=%s completed_at=%s\n' \
    "${BACKUP_FILE}" \
    "${BACKUP_FILE}.sha256" \
    "${BACKUP_SHA256}" \
    "${BACKUP_SIZE_BYTES}" \
    "${BACKUP_OFFSITE_PROOF_URI:-none}" \
    "${BACKUP_COMPLETED_AT}"
}

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_PREFIX="${BACKUP_PREFIX:-lunchlineup}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-35}"
BACKUP_OFFSITE_RETENTION_DAYS="${BACKUP_OFFSITE_RETENTION_DAYS:-35}"
BACKUP_OFFSITE_RETENTION_DRY_RUN="${BACKUP_OFFSITE_RETENTION_DRY_RUN:-false}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_DB="${POSTGRES_DB:-lunchlineup}"
TIMESTAMP="$(date -u +%Y%m%d%H%M%S)"
BACKUP_OFFSITE_PROOF_URI=""

validate_backup_settings
require_command pg_dump
require_command zstd
require_command gpg
require_command sha256sum
require_command mktemp

mkdir -p "${BACKUP_DIR}"
BACKUP_FILE="${BACKUP_DIR}/${BACKUP_PREFIX}-${TIMESTAMP}.sql.zst.gpg"
TMP_BACKUP_FILE="$(mktemp "${BACKUP_DIR}/${BACKUP_PREFIX}-${TIMESTAMP}.sql.zst.gpg.tmp.XXXXXX")"
BACKUP_KEY="$(read_backup_key)"

cleanup() {
  rm -f "${TMP_BACKUP_FILE}"
}
trap cleanup EXIT

echo "Starting encrypted backup to ${BACKUP_FILE}..."

pg_dump \
  -U "${POSTGRES_USER}" \
  -h "${POSTGRES_HOST}" \
  -p "${POSTGRES_PORT}" \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  "${POSTGRES_DB}" \
  | zstd -T0 -c \
  | gpg \
      --symmetric \
      --batch \
      --yes \
      --pinentry-mode loopback \
      --cipher-algo AES256 \
      --passphrase-fd 3 \
      -o "${TMP_BACKUP_FILE}" \
      3<<<"${BACKUP_KEY}"

[ -s "${TMP_BACKUP_FILE}" ] || fail "Backup output is empty."
mv "${TMP_BACKUP_FILE}" "${BACKUP_FILE}"
BACKUP_SHA256_LINE="$(sha256sum "${BACKUP_FILE}")"
BACKUP_SHA256="${BACKUP_SHA256_LINE%% *}"
printf '%s  %s\n' "${BACKUP_SHA256}" "$(basename "${BACKUP_FILE}")" >"${BACKUP_FILE}.sha256"

sync_offsite

BACKUP_COMPLETED_AT="$(date -u +%s)"
BACKUP_SIZE_BYTES="$(wc -c <"${BACKUP_FILE}" | tr -d ' ')"
write_backup_metrics

find "${BACKUP_DIR}" -type f \( -name "${BACKUP_PREFIX}-*.sql.zst.gpg" -o -name "${BACKUP_PREFIX}-*.sql.zst.gpg.sha256" \) -mtime +"${BACKUP_RETENTION_DAYS}" -delete

echo "Backup process finished successfully: ${BACKUP_FILE}"
write_backup_proof
