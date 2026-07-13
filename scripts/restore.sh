#!/bin/bash
# scripts/restore.sh
# Fail-closed restore helper for encrypted LunchLineup Postgres backups.
set -euo pipefail
IFS=$'\n\t'

usage() {
  cat >&2 <<'USAGE'
Usage: RESTORE_TARGET_ENV=<disposable|staging|development|production> RESTORE_CONFIRM=restore-<db> ./scripts/restore.sh <backup.sql.zst.gpg>

Required:
  BACKUP_ENCRYPTION_KEY_FILE or BACKUP_ENCRYPTION_KEY
  APP_DB_USER, APP_DB_PASSWORD, PLATFORM_ADMIN_DB_CONTEXT_SECRET
  MIGRATION_DATABASE_URL (owner connection for provision-app-db-role.mjs)
  RESTORE_TARGET_ENV
  RESTORE_CONFIRM=restore-<POSTGRES_DB>
  RESTORE_REQUIRE_CHECKSUM=true

Production restore also requires:
  RESTORE_ALLOW_PRODUCTION=YES_RESTORE_PRODUCTION

Non-empty target databases also require:
  RESTORE_ALLOW_NONEMPTY=YES_OVERWRITE

Postgres-only DR after RabbitMQ volume loss:
  RESTORE_REHYDRATE_DURABLE_QUEUES=true
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

validate_restore_settings() {
  validate_bool RESTORE_REQUIRE_CHECKSUM "${RESTORE_REQUIRE_CHECKSUM}"
  validate_bool RESTORE_REHYDRATE_DURABLE_QUEUES "${RESTORE_REHYDRATE_DURABLE_QUEUES}"
  validate_postgres_identifier POSTGRES_DB "${POSTGRES_DB}"
  validate_postgres_identifier POSTGRES_USER "${POSTGRES_USER}"
  is_unsigned_integer "${POSTGRES_PORT}" || fail "POSTGRES_PORT must be a positive integer."
  [ "${POSTGRES_PORT}" -ge 1 ] && [ "${POSTGRES_PORT}" -le 65535 ] || fail "POSTGRES_PORT must be between 1 and 65535."
}

validate_app_role_settings() {
  validate_postgres_identifier APP_DB_USER "${APP_DB_USER}"
  [ "${APP_DB_USER}" != "${POSTGRES_USER}" ] || fail "APP_DB_USER must be distinct from POSTGRES_USER."
  [ -n "${APP_DB_PASSWORD}" ] || fail "APP_DB_PASSWORD is required."
  [ -n "${PLATFORM_ADMIN_DB_CONTEXT_SECRET}" ] || fail "PLATFORM_ADMIN_DB_CONTEXT_SECRET is required."
  [ -n "${MIGRATION_DATABASE_URL}" ] || fail "MIGRATION_DATABASE_URL is required."
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

verify_backup_checksum() {
  local checksum_file="${BACKUP_FILE}.sha256"

  if [ -f "${checksum_file}" ]; then
    require_command sha256sum
    (
      cd "$(dirname "${BACKUP_FILE}")"
      sha256sum -c "$(basename "${checksum_file}")"
    )
  elif [ "${RESTORE_REQUIRE_CHECKSUM}" = "true" ]; then
    fail "Checksum file is required by default: ${checksum_file}. Set RESTORE_REQUIRE_CHECKSUM=false only for an explicitly approved local drill."
  fi

  require_command sha256sum
  BACKUP_SHA256_LINE="$(sha256sum "${BACKUP_FILE}")"
  BACKUP_SHA256="${BACKUP_SHA256_LINE%% *}"
}

table_count() {
  psql \
    -U "${POSTGRES_USER}" \
    -h "${POSTGRES_HOST}" \
    -p "${POSTGRES_PORT}" \
    -d "${POSTGRES_DB}" \
    -At \
    -v ON_ERROR_STOP=1 \
    -c "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type = 'BASE TABLE';"
}

stream_restore_sql() {
  if [ "${TABLE_COUNT}" != "0" ]; then
    printf '%s\n' \
      'DROP SCHEMA public CASCADE;' \
      'CREATE SCHEMA public;'
  fi

  if ! gpg \
      --decrypt \
      --batch \
      --yes \
      --pinentry-mode loopback \
      --passphrase-fd 3 \
      "${BACKUP_FILE}" \
      3<<<"${BACKUP_KEY}" \
      | zstd -d -c; then
    # psql cannot observe an upstream pipe failure. Force its single transaction
    # to roll back any schema reset or partial restore already received.
    printf "\nDO \$\$ BEGIN RAISE EXCEPTION 'backup stream validation failed'; END \$\$;\n"
    return 1
  fi
}

provision_and_verify_app_role() {
  node "${SCRIPT_DIR}/provision-app-db-role.mjs"

  local access_proof
  access_proof="$(
    PGPASSWORD="${APP_DB_PASSWORD}" psql \
      -X \
      -U "${APP_DB_USER}" \
      -h "${POSTGRES_HOST}" \
      -p "${POSTGRES_PORT}" \
      -d "${POSTGRES_DB}" \
      -At \
      -v ON_ERROR_STOP=1 \
      -v expected_role="${APP_DB_USER}" \
      -c "SELECT CASE WHEN current_user = :'expected_role'
        AND has_schema_privilege(current_user, 'public', 'USAGE')
        AND NOT EXISTS (
          SELECT 1
          FROM pg_class AS relation
          JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND NOT (
              has_table_privilege(current_user, relation.oid, 'SELECT')
              AND has_table_privilege(current_user, relation.oid, 'INSERT')
              AND has_table_privilege(current_user, relation.oid, 'UPDATE')
              AND has_table_privilege(current_user, relation.oid, 'DELETE')
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM pg_class AS sequence
          JOIN pg_namespace AS namespace ON namespace.oid = sequence.relnamespace
          WHERE namespace.nspname = 'public'
            AND sequence.relkind = 'S'
            AND NOT (
              has_sequence_privilege(current_user, sequence.oid, 'USAGE')
              AND has_sequence_privilege(current_user, sequence.oid, 'SELECT')
              AND has_sequence_privilege(current_user, sequence.oid, 'UPDATE')
            )
        )
        THEN 1 ELSE 0 END;"
  )"
  [ "${access_proof}" = "1" ] || fail "Restricted application role could not access the restored public schema."
}

if [ "$#" -ne 1 ]; then
  usage
  exit 1
fi

BACKUP_FILE="$1"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_DB="${POSTGRES_DB:-lunchlineup}"
RESTORE_TARGET_ENV="${RESTORE_TARGET_ENV:-}"
RESTORE_REQUIRE_CHECKSUM="${RESTORE_REQUIRE_CHECKSUM:-true}"
RESTORE_REHYDRATE_DURABLE_QUEUES="${RESTORE_REHYDRATE_DURABLE_QUEUES:-false}"
APP_DB_USER="${APP_DB_USER:-}"
APP_DB_PASSWORD="${APP_DB_PASSWORD:-}"
PLATFORM_ADMIN_DB_CONTEXT_SECRET="${PLATFORM_ADMIN_DB_CONTEXT_SECRET:-}"
MIGRATION_DATABASE_URL="${MIGRATION_DATABASE_URL:-}"
REQUIRED_CONFIRM="restore-${POSTGRES_DB}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

validate_restore_settings
[ -f "${BACKUP_FILE}" ] || fail "Backup file not found: ${BACKUP_FILE}"

case "$(basename "${BACKUP_FILE}")" in
  latest | latest.*)
    fail "Refusing vague restore target '${BACKUP_FILE}'. Pass an explicit encrypted backup path."
    ;;
  -*)
    fail "Restore input filename must not start with '-'."
    ;;
  *.sql.zst.gpg)
    ;;
  *)
    fail "Restore input must be an encrypted .sql.zst.gpg backup."
    ;;
esac

case "${RESTORE_TARGET_ENV}" in
  disposable | staging | development)
    ;;
  production)
    [ "${RESTORE_ALLOW_PRODUCTION:-}" = "YES_RESTORE_PRODUCTION" ] || fail "Production restore requires RESTORE_ALLOW_PRODUCTION=YES_RESTORE_PRODUCTION."
    ;;
  *)
    fail "RESTORE_TARGET_ENV must be disposable, staging, development, or production."
    ;;
esac

if [ "${RESTORE_CONFIRM:-}" != "${REQUIRED_CONFIRM}" ]; then
  if [ -t 0 ]; then
    printf 'Type %s to restore %s on %s: ' "${REQUIRED_CONFIRM}" "${POSTGRES_DB}" "${POSTGRES_HOST}" >&2
    read -r typed_confirmation
    [ "${typed_confirmation}" = "${REQUIRED_CONFIRM}" ] || fail "Restore confirmation did not match."
  else
    fail "Set RESTORE_CONFIRM=${REQUIRED_CONFIRM}."
  fi
fi

verify_backup_checksum
validate_app_role_settings
require_command gpg
require_command zstd
require_command psql
require_command node

TABLE_COUNT="$(table_count)"

if [ "${TABLE_COUNT}" != "0" ] && [ "${RESTORE_ALLOW_NONEMPTY:-}" != "YES_OVERWRITE" ]; then
  fail "Target database ${POSTGRES_DB} is not empty (${TABLE_COUNT} tables). Restore to an empty database or set RESTORE_ALLOW_NONEMPTY=YES_OVERWRITE."
fi

BACKUP_KEY="$(read_backup_key)"

echo "Starting restore from ${BACKUP_FILE} into ${RESTORE_TARGET_ENV} database ${POSTGRES_DB} on ${POSTGRES_HOST}:${POSTGRES_PORT}..."

stream_restore_sql \
  | psql \
      -U "${POSTGRES_USER}" \
      -h "${POSTGRES_HOST}" \
      -p "${POSTGRES_PORT}" \
      -d "${POSTGRES_DB}" \
      -v ON_ERROR_STOP=1 \
      --single-transaction

if [ "${RESTORE_REHYDRATE_DURABLE_QUEUES}" = "true" ]; then
  REHYDRATE_SQL="${SCRIPT_DIR}/rehydrate-durable-queues.sql"
  [ -f "${REHYDRATE_SQL}" ] || fail "Durable queue rehydration SQL is missing: ${REHYDRATE_SQL}"
  psql \
    -U "${POSTGRES_USER}" \
    -h "${POSTGRES_HOST}" \
    -p "${POSTGRES_PORT}" \
    -d "${POSTGRES_DB}" \
    -v ON_ERROR_STOP=1 \
    -f "${REHYDRATE_SQL}"
fi

provision_and_verify_app_role

RESTORED_TABLE_COUNT="$(table_count)"

echo "Database restore completed successfully."
printf 'restore_ok target_env=%s postgres_host=%s postgres_db=%s backup_file=%s backup_sha256=%s restored_table_count=%s durable_queues_rehydrated=%s app_role_verified=true\n' \
  "${RESTORE_TARGET_ENV}" \
  "${POSTGRES_HOST}" \
  "${POSTGRES_DB}" \
  "${BACKUP_FILE}" \
  "${BACKUP_SHA256}" \
  "${RESTORED_TABLE_COUNT}" \
  "${RESTORE_REHYDRATE_DURABLE_QUEUES}"
