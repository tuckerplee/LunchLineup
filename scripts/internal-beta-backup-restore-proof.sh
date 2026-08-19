#!/usr/bin/env bash
# Create a bounded logical snapshot of VM107 and restore it into an isolated,
# temporary database. The live database is never dropped or restored over.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/lunchlineup}"
RUNTIME_ENV="${BETA_RUNTIME_ENV_FILE:-/opt/lunchlineup-secrets/runtime.env}"
SOURCE_SHA="${BETA_CANDIDATE_SHA:-}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-lunchlineup}"
PROOF_PATH="${BETA_BACKUP_RESTORE_PROOF_PATH:-/var/lib/lunchlineup/proofs/internal-beta-backup-restore.json}"
COMMAND_TIMEOUT_SECONDS="${BETA_BACKUP_COMMAND_TIMEOUT_SECONDS:-600}"
CLEANUP_TIMEOUT_SECONDS="${BETA_BACKUP_CLEANUP_TIMEOUT_SECONDS:-60}"

current_check="startup"
scratch_dir=""
restore_database=""
cleanup_complete=false

fail() {
  echo "internal_beta_backup_restore_failed check=${current_check} detail=$1" >&2
  exit 1
}

on_exit() {
  local status=$?
  if [[ "$cleanup_complete" != true ]]; then
    cleanup || status=1
  fi
  if (( status != 0 )); then
    echo "internal_beta_backup_restore_failed check=${current_check}" >&2
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

require_positive_integer() {
  local name="$1"
  local value="$2"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || fail "$name must be a positive integer"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

env_value() {
  local key="$1"
  local count
  count="$(grep -c "^${key}=" "$RUNTIME_ENV" || true)"
  [[ "$count" == 1 ]] || fail "$key must occur exactly once in the runtime env"
  grep "^${key}=" "$RUNTIME_ENV" | cut -d= -f2-
}

env_path() {
  local value
  value="$(env_value "$1")"
  if [[ "$value" == /* ]]; then
    printf '%s\n' "$value"
  else
    printf '%s/%s\n' "$APP_DIR" "${value#./}"
  fi
}

compose() {
  timeout --foreground "${COMMAND_TIMEOUT_SECONDS}s" \
    docker compose \
      --project-name "$COMPOSE_PROJECT_NAME" \
      --project-directory "$APP_DIR" \
      --env-file "$RUNTIME_ENV" \
      -f "$APP_DIR/docker-compose.yml" \
      "$@"
}

postgres_exec() {
  compose exec -T postgres "$@"
}

cleanup() {
  local cleanup_status=0
  if [[ -n "$restore_database" ]]; then
    timeout --foreground "${CLEANUP_TIMEOUT_SECONDS}s" \
      docker compose \
        --project-name "$COMPOSE_PROJECT_NAME" \
        --project-directory "$APP_DIR" \
        --env-file "$RUNTIME_ENV" \
        -f "$APP_DIR/docker-compose.yml" \
        exec -T postgres \
        dropdb --if-exists --force -U "$postgres_user" "$restore_database" \
      >/dev/null 2>&1 || cleanup_status=1
  fi
  if [[ -n "$scratch_dir" && -d "$scratch_dir" ]]; then
    rm -rf -- "$scratch_dir" || cleanup_status=1
  fi
  cleanup_complete=true
  return "$cleanup_status"
}

current_check="inputs"
[[ "$SOURCE_SHA" =~ ^[a-f0-9]{40}$ ]] || fail "BETA_CANDIDATE_SHA must be one lowercase 40-character Git SHA"
[[ "$COMPOSE_PROJECT_NAME" == lunchlineup ]] || fail "COMPOSE_PROJECT_NAME must remain lunchlineup"
[[ "$APP_DIR" == /opt/lunchlineup ]] || fail "APP_DIR must remain /opt/lunchlineup on VM107"
[[ "$RUNTIME_ENV" == /opt/lunchlineup-secrets/runtime.env ]] \
  || fail "BETA_RUNTIME_ENV_FILE must remain the VM107 root-only runtime env"
proof_basename="${PROOF_PATH#/var/lib/lunchlineup/proofs/}"
[[ "$PROOF_PATH" == /var/lib/lunchlineup/proofs/*.json \
  && "$proof_basename" != */* \
  && "$proof_basename" =~ ^[A-Za-z0-9._-]+\.json$ ]] \
  || fail "BETA_BACKUP_RESTORE_PROOF_PATH must be one JSON file directly under /var/lib/lunchlineup/proofs"
[[ -d "$APP_DIR/.git" ]] || fail "APP_DIR is not the VM107 Git checkout"
[[ -f "$RUNTIME_ENV" && ! -L "$RUNTIME_ENV" ]] || fail "runtime env must be a regular non-symlink file"
require_positive_integer BETA_BACKUP_COMMAND_TIMEOUT_SECONDS "$COMMAND_TIMEOUT_SECONDS"
require_positive_integer BETA_BACKUP_CLEANUP_TIMEOUT_SECONDS "$CLEANUP_TIMEOUT_SECONDS"
(( COMMAND_TIMEOUT_SECONDS >= 60 && COMMAND_TIMEOUT_SECONDS <= 1800 )) \
  || fail "BETA_BACKUP_COMMAND_TIMEOUT_SECONDS must be from 60 through 1800"
(( CLEANUP_TIMEOUT_SECONDS >= 10 && CLEANUP_TIMEOUT_SECONDS <= 180 )) \
  || fail "BETA_BACKUP_CLEANUP_TIMEOUT_SECONDS must be from 10 through 180"
for command_name in docker git grep cut timeout mktemp sha256sum stat date awk sed cmp tr cat gpg rm dirname mkdir chmod mv; do
  require_command "$command_name"
done

current_check="source_identity"
actual_sha="$(git -C "$APP_DIR" rev-parse HEAD)"
[[ "$actual_sha" == "$SOURCE_SHA" ]] || fail "checkout does not match the requested candidate"
[[ -z "$(git -C "$APP_DIR" status --porcelain --untracked-files=all)" ]] \
  || fail "checkout is dirty"
[[ "$(env_value IMAGE_TAG)" == "$SOURCE_SHA" ]] || fail "IMAGE_TAG is not candidate-bound"
[[ "$(env_value DEPLOY_RELEASE_SHA)" == "$SOURCE_SHA" ]] || fail "DEPLOY_RELEASE_SHA is not candidate-bound"
[[ "$(env_value MIGRATION_SOURCE_SHA)" == "$SOURCE_SHA" ]] || fail "MIGRATION_SOURCE_SHA is not candidate-bound"
backup_key_file="$(env_path BACKUP_ENCRYPTION_KEY_SECRET_FILE)"
[[ -s "$backup_key_file" && ! -L "$backup_key_file" ]] \
  || fail "backup encryption key is missing"

current_check="database_identity"
postgres_user="$(env_value POSTGRES_USER)"
postgres_database="$(env_value POSTGRES_DB)"
[[ "$postgres_user" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] || fail "POSTGRES_USER is not a safe role name"
[[ "$postgres_database" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] || fail "POSTGRES_DB is not a safe database name"
restore_database="ll_beta_restore_${SOURCE_SHA:0:12}_$$"
[[ ${#restore_database} -le 63 ]] || fail "temporary restore database name is too long"

current_check="postgres_health"
compose config --quiet
postgres_id="$(compose ps -q postgres)"
[[ -n "$postgres_id" ]] || fail "postgres container is not running"
[[ "$(timeout --foreground 30s docker inspect --format '{{.State.Status}}' "$postgres_id")" == running ]] \
  || fail "postgres container is not running"
[[ "$(timeout --foreground 30s docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$postgres_id")" == healthy ]] \
  || fail "postgres container is not healthy"

current_check="snapshot"
scratch_dir="$(mktemp -d "${TMPDIR:-/tmp}/lunchlineup-beta-restore.XXXXXX")"
chmod 0700 "$scratch_dir"
plain_dump_path="$scratch_dir/database.dump"
encrypted_dump_path="$scratch_dir/database.dump.gpg"
restore_dump_path="$scratch_dir/restored.database.dump"
source_inventory="$scratch_dir/source.inventory"
restore_inventory="$scratch_dir/restore.inventory"
gnupg_home="$scratch_dir/gnupg"
mkdir -p "$gnupg_home"
chmod 0700 "$gnupg_home"
umask 077
postgres_exec pg_dump \
  --format=custom \
  --compress=6 \
  --no-owner \
  --no-acl \
  --username "$postgres_user" \
  --dbname "$postgres_database" \
  > "$plain_dump_path"
[[ -s "$plain_dump_path" ]] || fail "logical snapshot is empty"
GNUPGHOME="$gnupg_home" timeout --foreground "${COMMAND_TIMEOUT_SECONDS}s" \
  gpg --batch --yes --pinentry-mode loopback --no-symkey-cache \
    --cipher-algo AES256 --symmetric \
    --passphrase-file "$backup_key_file" \
    --output "$encrypted_dump_path" "$plain_dump_path"
[[ -s "$encrypted_dump_path" ]] || fail "encrypted logical snapshot is empty"
rm -f -- "$plain_dump_path"
[[ ! -e "$plain_dump_path" ]] || fail "plaintext logical snapshot cleanup failed"
dump_sha256="$(sha256sum "$encrypted_dump_path" | awk '{print $1}')"
dump_bytes="$(stat -c '%s' "$encrypted_dump_path")"
[[ "$dump_sha256" =~ ^[a-f0-9]{64}$ && "$dump_bytes" =~ ^[1-9][0-9]*$ ]] \
  || fail "logical snapshot identity is invalid"

inventory_sql=$(cat <<'SQL'
SELECT 'public_tables=' || count(*)::text
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
SELECT 'successful_migrations=' || count(*)::text
FROM public._prisma_migrations
WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
SELECT 'critical_tables=' || count(*)::text
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_type = 'BASE TABLE'
  AND table_name IN ('Tenant', 'User', 'Location', 'Schedule', 'Shift');
SELECT 'critical_rows=' || (
  (SELECT count(*) FROM public."Tenant")
  + (SELECT count(*) FROM public."User")
  + (SELECT count(*) FROM public."Location")
  + (SELECT count(*) FROM public."Schedule")
  + (SELECT count(*) FROM public."Shift")
)::text;
SQL
)
postgres_exec psql \
  --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
  --username "$postgres_user" --dbname "$postgres_database" \
  --command "$inventory_sql" \
  | sed '/^[[:space:]]*$/d' > "$source_inventory"
[[ -s "$source_inventory" ]] || fail "source inventory is empty"
grep -Eq '^public_tables=[1-9][0-9]*$' "$source_inventory" \
  || fail "source snapshot has no public tables"
grep -Eq '^successful_migrations=[1-9][0-9]*$' "$source_inventory" \
  || fail "source snapshot has no successful migrations"
grep -Fxq 'critical_tables=5' "$source_inventory" \
  || fail "source snapshot is missing a launch-critical table"

current_check="isolated_restore"
GNUPGHOME="$gnupg_home" timeout --foreground "${COMMAND_TIMEOUT_SECONDS}s" \
  gpg --batch --yes --pinentry-mode loopback --no-symkey-cache \
    --decrypt --passphrase-file "$backup_key_file" \
    --output "$restore_dump_path" "$encrypted_dump_path"
[[ -s "$restore_dump_path" ]] || fail "decrypted restore snapshot is empty"
postgres_exec createdb --username "$postgres_user" --template template0 "$restore_database"
postgres_exec pg_restore \
  --exit-on-error \
  --no-owner \
  --no-acl \
  --username "$postgres_user" \
  --dbname "$restore_database" \
  < "$restore_dump_path"
postgres_exec psql \
  --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
  --username "$postgres_user" --dbname "$restore_database" \
  --command "$inventory_sql" \
  | sed '/^[[:space:]]*$/d' > "$restore_inventory"
cmp --silent "$source_inventory" "$restore_inventory" \
  || fail "restored critical inventory does not match the source snapshot"

current_check="cleanup"
cleanup || fail "temporary restore database or snapshot cleanup failed"
remaining_database="$(postgres_exec psql \
  --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
  --username "$postgres_user" --dbname postgres \
  --command "SELECT count(*) FROM pg_database WHERE datname = '${restore_database}';" \
  | tr -d '[:space:]')"
[[ "$remaining_database" == 0 ]] || fail "temporary restore database still exists"

current_check="proof"
proof_dir="$(dirname "$PROOF_PATH")"
mkdir -p "$proof_dir"
chmod 0700 "$proof_dir"
proof_tmp="$(mktemp "$proof_dir/.internal-beta-backup-restore.XXXXXX")"
checked_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
cat > "$proof_tmp" <<JSON
{
  "status": "passed",
  "sourceSha": "$SOURCE_SHA",
  "checkedAt": "$checked_at",
  "snapshotSha256": "$dump_sha256",
  "snapshotBytes": $dump_bytes,
  "encryptedSnapshot": true,
  "restoreTarget": "isolated-temporary-database",
  "schemaAndMigrationInventoryMatched": true,
  "criticalDataInventoryMatched": true,
  "temporaryDatabaseRemoved": true
}
JSON
chmod 0600 "$proof_tmp"
mv -f "$proof_tmp" "$PROOF_PATH"

echo "internal_beta_backup_restore_ok sha=$SOURCE_SHA proof=$PROOF_PATH"
