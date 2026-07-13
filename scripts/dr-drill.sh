#!/bin/bash
# scripts/dr-drill.sh
# Restores an explicit encrypted backup into an ephemeral Postgres container.
set -euo pipefail
IFS=$'\n\t'

usage() {
  cat >&2 <<'USAGE'
Usage: BACKUP_FILE=/tmp/lunchlineup-YYYYMMDDHHMMSS.sql.zst.gpg DR_OFFHOST_SOURCE_URI=s3://bucket/db-backups/... ./scripts/dr-drill.sh

Required by default:
  BACKUP_ENCRYPTION_KEY_FILE or BACKUP_ENCRYPTION_KEY
  BACKUP_FILE pointing at an explicit .sql.zst.gpg file downloaded from off-host storage
  BACKUP_FILE.sha256 beside the backup file
  DR_OFFHOST_SOURCE_URI naming the off-host source object or repository

Local-only drills may set DR_REQUIRE_OFFHOST_SOURCE=false.
Checksum-free drills require DR_REQUIRE_CHECKSUM=false and should not be used for launch proof.
USAGE
}

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

validate_bool() {
  case "$2" in
    true | false)
      ;;
    *)
      fail "$1 must be true or false."
      ;;
  esac
}

validate_postgres_identifier() {
  case "$2" in
    '' | *[!A-Za-z0-9_]* | [0-9]*)
      fail "$1 must be a simple Postgres identifier."
      ;;
  esac
}

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
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

validate_container_name() {
  case "${DR_CONTAINER}" in
    lunchlineup-dr-drill-*)
      ;;
    *)
      fail "DR_CONTAINER must start with lunchlineup-dr-drill- so cleanup cannot remove an unrelated container."
      ;;
  esac

  case "${DR_CONTAINER}" in
    '' | *[!A-Za-z0-9_.-]*)
      fail "DR_CONTAINER contains unsupported characters."
      ;;
  esac
}

validate_offhost_source() {
  [ "${DR_REQUIRE_OFFHOST_SOURCE}" = "true" ] || return 0

  [ -n "${DR_OFFHOST_SOURCE_URI}" ] || fail "DR_OFFHOST_SOURCE_URI is required when DR_REQUIRE_OFFHOST_SOURCE=true. Download an explicit off-host backup object and record its source URI."

  case "${DR_OFFHOST_SOURCE_URI}" in
    file://* | /* | ./* | ../* | http://localhost* | https://localhost* | http://127.* | https://127.*)
      fail "DR_OFFHOST_SOURCE_URI must name off-host storage, not a local path or localhost URL."
      ;;
    s3://* | rclone:* | rsync://* | scp://* | ssh://* | https://* | restic:* | b2://*)
      ;;
    *)
      fail "DR_OFFHOST_SOURCE_URI must use s3://, rclone:, rsync://, scp://, ssh://, https://, restic:, or b2://."
      ;;
  esac
}

validate_dr_settings() {
  validate_bool DR_REQUIRE_OFFHOST_SOURCE "${DR_REQUIRE_OFFHOST_SOURCE}"
  validate_bool DR_REQUIRE_CHECKSUM "${DR_REQUIRE_CHECKSUM}"
  validate_bool DR_REQUIRE_TABLES "${DR_REQUIRE_TABLES}"
  validate_postgres_identifier DR_USER "${DR_USER}"
  validate_postgres_identifier DR_DB "${DR_DB}"
  is_unsigned_integer "${DR_WAIT_SECONDS}" || fail "DR_WAIT_SECONDS must be a positive integer."
  [ "${DR_WAIT_SECONDS}" -ge 1 ] && [ "${DR_WAIT_SECONDS}" -le 300 ] || fail "DR_WAIT_SECONDS must be between 1 and 300."

  case "${DR_IMAGE}" in
    '' | *:latest | *:latest@*)
      fail "DR_IMAGE must be explicit and must not use the latest tag."
      ;;
  esac
  case "${DR_IMAGE}" in
    *@sha256:*) ;;
    *)
      fail "DR_IMAGE must include an immutable @sha256 digest."
      ;;
  esac

  validate_container_name
  validate_offhost_source
}

select_backup_file() {
  if [ -n "${BACKUP_FILE}" ]; then
    return 0
  fi

  if [ "${DR_REQUIRE_OFFHOST_SOURCE}" = "true" ]; then
    fail "BACKUP_FILE is required when DR_REQUIRE_OFFHOST_SOURCE=true. Pass the exact off-host backup object after downloading it to a disposable path."
  fi

  case "${BACKUP_DIR}" in
    '' | '/' | '.' | '..')
      fail "BACKUP_DIR must be a dedicated backup directory, not '${BACKUP_DIR}'."
      ;;
  esac

  BACKUP_FILE="$(ls -t "${BACKUP_DIR}"/*.sql.zst.gpg 2>/dev/null | head -n 1 || true)"
}

validate_backup_file() {
  [ -n "${BACKUP_FILE}" ] || fail "No encrypted .sql.zst.gpg backups found in ${BACKUP_DIR}."
  [ -f "${BACKUP_FILE}" ] || fail "Backup file not found: ${BACKUP_FILE}"

  case "$(basename "${BACKUP_FILE}")" in
    latest | latest.*)
      fail "Refusing vague drill target '${BACKUP_FILE}'. Pass an explicit encrypted backup path."
      ;;
    -*)
      fail "Backup input filename must not start with '-'."
      ;;
    *.sql.zst.gpg)
      ;;
    *)
      fail "DR drill input must be an encrypted .sql.zst.gpg backup."
      ;;
  esac
}

verify_backup_checksum() {
  local checksum_file="${BACKUP_FILE}.sha256"

  if [ -f "${checksum_file}" ]; then
    require_command sha256sum
    (
      cd "$(dirname "${BACKUP_FILE}")"
      sha256sum -c "$(basename "${checksum_file}")"
    )
  elif [ "${DR_REQUIRE_CHECKSUM}" = "true" ]; then
    fail "Checksum file is required by default: ${checksum_file}. Set DR_REQUIRE_CHECKSUM=false only for an explicitly approved local drill."
  fi

  require_command sha256sum
  BACKUP_SHA256_LINE="$(sha256sum "${BACKUP_FILE}")"
  BACKUP_SHA256="${BACKUP_SHA256_LINE%% *}"
}

source_kind() {
  case "${DR_OFFHOST_SOURCE_URI}" in
    s3://*) printf 's3' ;;
    rclone:*) printf 'rclone' ;;
    rsync://*) printf 'rsync' ;;
    scp://*) printf 'scp' ;;
    ssh://*) printf 'ssh' ;;
    https://*) printf 'https' ;;
    restic:*) printf 'restic' ;;
    b2://*) printf 'b2' ;;
    '') printf 'local' ;;
    *) printf 'other' ;;
  esac
}

write_dr_proof() {
  local completed_at="$1"
  local completed_epoch="$2"
  local proof_dir
  local tmp_proof_file

  proof_dir="$(dirname "${DR_PROOF_FILE}")"
  mkdir -p "${proof_dir}"
  tmp_proof_file="$(mktemp "${proof_dir}/lunchlineup-dr-proof.json.tmp.XXXXXX")"

  cat >"${tmp_proof_file}" <<PROOF
{
  "status": "ok",
  "source_sha": "$(json_escape "${DR_SOURCE_SHA}")",
  "checked_at": "$(json_escape "${completed_at}")",
  "started_at": "$(json_escape "${DR_STARTED_AT}")",
  "completed_at": "$(json_escape "${completed_at}")",
  "duration_seconds": $((completed_epoch - DR_STARTED_EPOCH)),
  "backup_file": "$(json_escape "${BACKUP_FILE}")",
  "backup_sha256": "$(json_escape "${BACKUP_SHA256}")",
  "checksum_file": "$(json_escape "${BACKUP_FILE}.sha256")",
  "source_uri": "$(json_escape "${DR_OFFHOST_SOURCE_URI}")",
  "source_kind": "$(source_kind)",
  "dr_image": "$(json_escape "${DR_IMAGE}")",
  "container": "$(json_escape "${DR_CONTAINER}")",
  "database": "$(json_escape "${DR_DB}")",
  "restored_table_count": ${RESTORED_TABLE_COUNT},
  "sanity_result": "$(json_escape "${SANITY_RESULT}")"
}
PROOF

  mv "${tmp_proof_file}" "${DR_PROOF_FILE}"
}

docker_container_exists() {
  [ -n "$(docker ps -a --filter "name=^/${DR_CONTAINER}$" --format '{{.Names}}')" ]
}

DR_TIMESTAMP="$(date -u +%Y%m%d%H%M%S)"
DR_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DR_STARTED_EPOCH="$(date -u +%s)"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_FILE="${BACKUP_FILE:-}"
DR_OFFHOST_SOURCE_URI="${DR_OFFHOST_SOURCE_URI:-${BACKUP_OFFSITE_URI:-}}"
DR_REQUIRE_OFFHOST_SOURCE="${DR_REQUIRE_OFFHOST_SOURCE:-true}"
DR_REQUIRE_CHECKSUM="${DR_REQUIRE_CHECKSUM:-true}"
DR_IMAGE="${DR_IMAGE:-postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777}"
DR_CONTAINER="${DR_CONTAINER:-lunchlineup-dr-drill-${DR_TIMESTAMP}-$$}"
DR_USER="${DR_USER:-drill}"
DR_PASSWORD="${DR_PASSWORD:-lunchlineup_drill_${DR_TIMESTAMP}_$$}"
DR_DB="${DR_DB:-lunchlineup_drill}"
DR_WAIT_SECONDS="${DR_WAIT_SECONDS:-45}"
DR_REQUIRE_TABLES="${DR_REQUIRE_TABLES:-true}"
DR_PROOF_FILE="${DR_PROOF_FILE:-${TMPDIR:-/tmp}/lunchlineup-dr-drill-${DR_TIMESTAMP}.json}"
DR_SOURCE_SHA="${DR_SOURCE_SHA:-}"
DR_TABLE_COUNT_SQL="SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type = 'BASE TABLE';"
DR_SANITY_SQL="${DR_SANITY_SQL:-${DR_TABLE_COUNT_SQL}}"
CONTAINER_STARTED="false"

if [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

validate_dr_settings
select_backup_file
validate_backup_file
verify_backup_checksum

require_command docker
require_command gpg
require_command zstd
require_command sed
require_command tr
require_command mktemp

if docker_container_exists; then
  fail "DR_CONTAINER already exists: ${DR_CONTAINER}. Pick a new lunchlineup-dr-drill-* name."
fi

cleanup() {
  if [ "${CONTAINER_STARTED}" = "true" ]; then
    docker rm -f "${DR_CONTAINER}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

BACKUP_KEY="$(read_backup_key)"

echo "Starting disaster recovery drill from ${BACKUP_FILE}..."

docker run \
  -d \
  --name "${DR_CONTAINER}" \
  -e POSTGRES_USER="${DR_USER}" \
  -e POSTGRES_PASSWORD="${DR_PASSWORD}" \
  -e POSTGRES_DB="${DR_DB}" \
  "${DR_IMAGE}" >/dev/null
CONTAINER_STARTED="true"

ready="false"
for ((attempt = 1; attempt <= DR_WAIT_SECONDS; attempt++)); do
  if docker exec "${DR_CONTAINER}" pg_isready -U "${DR_USER}" -d "${DR_DB}" >/dev/null 2>&1; then
    ready="true"
    break
  fi
  sleep 1
done

[ "${ready}" = "true" ] || fail "Ephemeral Postgres did not become ready."

gpg \
  --decrypt \
  --batch \
  --yes \
  --pinentry-mode loopback \
  --passphrase-fd 3 \
  "${BACKUP_FILE}" \
  3<<<"${BACKUP_KEY}" \
  | zstd -d -c \
  | docker exec \
      -i \
      -e PGPASSWORD="${DR_PASSWORD}" \
      "${DR_CONTAINER}" \
      psql \
        -U "${DR_USER}" \
        -d "${DR_DB}" \
        -v ON_ERROR_STOP=1 \
        --single-transaction

RESTORED_TABLE_COUNT="$(
  docker exec \
    -e PGPASSWORD="${DR_PASSWORD}" \
    "${DR_CONTAINER}" \
    psql \
      -U "${DR_USER}" \
      -d "${DR_DB}" \
      -At \
      -v ON_ERROR_STOP=1 \
      -c "${DR_TABLE_COUNT_SQL}"
)"

SANITY_RESULT="$(
  docker exec \
    -e PGPASSWORD="${DR_PASSWORD}" \
    "${DR_CONTAINER}" \
    psql \
      -U "${DR_USER}" \
      -d "${DR_DB}" \
      -At \
      -v ON_ERROR_STOP=1 \
      -c "${DR_SANITY_SQL}" \
    | tr '\n' ' ' \
    | sed 's/[[:space:]]*$//'
)"

[ -n "${SANITY_RESULT}" ] || fail "DR sanity query returned no result."

if [ "${DR_REQUIRE_TABLES}" = "true" ] && [ "${RESTORED_TABLE_COUNT}" = "0" ]; then
  fail "DR sanity query found zero application tables."
fi

DR_COMPLETED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DR_COMPLETED_EPOCH="$(date -u +%s)"
write_dr_proof "${DR_COMPLETED_AT}" "${DR_COMPLETED_EPOCH}"

echo "DR drill successful. Sanity result: ${SANITY_RESULT}"
printf 'dr_drill_ok backup_sha256=%s restored_table_count=%s source_kind=%s proof_file=%s completed_at=%s\n' \
  "${BACKUP_SHA256}" \
  "${RESTORED_TABLE_COUNT}" \
  "$(source_kind)" \
  "${DR_PROOF_FILE}" \
  "${DR_COMPLETED_AT}"
