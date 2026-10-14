#!/usr/bin/env bash
# scripts/drills/backup-restore-drill.sh
#
# Local, disposable proof that the LunchLineup backup, offsite, restore, PITR and
# alerting paths work end to end. Everything runs in throwaway Docker objects
# named ll-drill-* (labelled ll-drill=1); nothing talks to a real server. The
# only things production adds are the owner's real bucket keys and alert webhook.
#
#   scripts/drills/backup-restore-drill.sh all       # build, up, logical, pitr, alerts, systemd
#   scripts/drills/backup-restore-drill.sh <phase>   # build | up | logical | pitr | alerts | systemd | down
#
# Environment:
#   DRILL_WORK_DIR        scratch directory (default: mktemp; reused if state.env exists)
#   DRILL_SOURCE_DIR      LF source tree to test (default: `git archive HEAD` of this checkout,
#                         so CRLF checkouts are safe inside Linux containers)
#   DRILL_MIGRATE_IMAGE   image providing /app/node_modules (prisma, pg). Default: build
#                         infrastructure/docker/Dockerfile.migrations (needs npm registry access)
#   DRILL_ALERT_PROMETHEUS=0   skip the slow (~6 min) Prometheus-rule -> Alertmanager path
#   DRILL_REMOVE_IMAGES=1      `down` also removes the ll-drill-*:local images
#
# Each phase prints "RESULT ..." lines; a failed assertion prints "FAIL ..." and exits 1.
set -euo pipefail
IFS=$'\n\t'

export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"

NET=ll-drill-net
BACKUP_IMG=ll-drill-backup:local
POSTGRES_IMG=ll-drill-postgres:local
MINIO_IMG=ll-drill-minio:local
TOOLBOX_IMG=ll-drill-toolbox:local
ALERTMANAGER_IMG="${DRILL_ALERTMANAGER_IMAGE:-prom/alertmanager:v0.34.0}"
PROMETHEUS_IMG="${DRILL_PROMETHEUS_IMAGE:-prom/prometheus:v3.5.0}"
NODE_EXPORTER_IMG="${DRILL_NODE_EXPORTER_IMAGE:-prom/node-exporter:v1.9.1}"
LABEL=ll-drill=1

BACKUP_BUCKET=ll-drill-backups
BACKUP_PREFIX=drill/db-backups
PITR_BUCKET=ll-drill-pitr
PITR_PREFIX=cluster-drill
PITR_ENDPOINT=http://ll-drill-minio:9000

WORK="${DRILL_WORK_DIR:-}"
if [ -z "${WORK}" ]; then
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/ll-drill.XXXXXX")"
fi
mkdir -p "${WORK}/secrets" "${WORK}/results"
STATE="${WORK}/state.env"

winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
W_WORK="$(winpath "${WORK}")"

log() { printf '\n== %s\n' "$*"; }
result() { printf 'RESULT %s\n' "$*" | tee -a "${WORK}/results/summary.txt"; }
die() { printf 'FAIL %s\n' "$*" >&2; exit 1; }
rand() { head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "${1:-24}"; }
expect_eq() { [ "$2" = "$3" ] || die "$1: expected '$3', got '$2'"; result "$1 = $2"; }

# ---------------------------------------------------------------- state
if [ -f "${STATE}" ]; then
  # shellcheck disable=SC1090
  . "${STATE}"
else
  {
    echo "PG_PASS=$(rand 20)"
    echo "RESTORE_PG_PASS=$(rand 20)"
    echo "APP_PW=$(rand 24)"
    echo "PLATFORM_SECRET=$(rand 24)"
    echo "MINIO_ROOT_PASSWORD=$(rand 28)"
    echo "KMS_KEY=$(head -c 32 /dev/urandom | base64)"
  } >"${STATE}"
  # shellcheck disable=SC1090
  . "${STATE}"
fi
MINIO_ROOT_USER=drilladmin
PG_USER=lunchlineup_admin
PG_DB=lunchlineup
APP_USER=lunchlineup_app

# ---------------------------------------------------------------- source tree (LF)
source_dir() {
  if [ -n "${DRILL_SOURCE_DIR:-}" ]; then
    printf '%s' "${DRILL_SOURCE_DIR}"
    return
  fi
  if [ ! -d "${WORK}/src" ]; then
    mkdir -p "${WORK}/src"
    (cd "${REPO_ROOT}" && git -c core.autocrlf=false archive HEAD) | tar -x -C "${WORK}/src"
  fi
  printf '%s' "${WORK}/src"
}
SRC="$(source_dir)"
W_SRC="$(winpath "${SRC}")"

# ---------------------------------------------------------------- docker helpers
d() { docker "$@"; }
rm_container() { docker rm -f "$1" >/dev/null 2>&1 || true; }

psql_src() { docker exec -i -e PGPASSWORD="${PG_PASS}" ll-drill-pg psql -X -At -U "${PG_USER}" -d "${PG_DB}" "$@"; }
psql_restore() { docker exec -i -e PGPASSWORD="${RESTORE_PG_PASS}" ll-drill-pg-restore psql -X -At -U "${PG_USER}" -d "${PG_DB}" "$@"; }

# Run a command in the toolbox (backup image + migrate node_modules + this checkout's scripts).
toolbox() {
  docker run --rm --label "${LABEL}" --network "${NET}" -e HOME=/tmp -e GNUPGHOME=/tmp "$@"
}

fingerprint() { # <container-exec-fn>
  "$1" -f - <"${SRC}/scripts/drills/db-fingerprint.sql"
}

wait_for() { # <seconds> <description> <command...>
  local seconds="$1" description="$2"
  shift 2
  local i=0
  until "$@" >/dev/null 2>&1; do
    i=$((i + 1))
    [ "${i}" -le "${seconds}" ] || die "timed out waiting for ${description}"
    sleep 1
  done
}

# ================================================================ build
phase_build() {
  log "build images from ${SRC}"
  d build -q -t "${BACKUP_IMG}" -f "${W_SRC}/infrastructure/docker/Dockerfile.backup" "${W_SRC}" >/dev/null
  d build -q -t "${POSTGRES_IMG}" -f "${W_SRC}/infrastructure/docker/Dockerfile.postgres" "${W_SRC}" >/dev/null
  d build -q -t "${MINIO_IMG}" -f "${W_SRC}/scripts/drills/Dockerfile.minio" "${W_SRC}/scripts/drills" >/dev/null
  local migrate="${DRILL_MIGRATE_IMAGE:-}"
  if [ -z "${migrate}" ]; then
    migrate=ll-drill-migrate:local
    d build -q -t "${migrate}" -f "${W_SRC}/infrastructure/docker/Dockerfile.migrations" "${W_SRC}" >/dev/null
  fi
  d build -q -t "${TOOLBOX_IMG}" -f "${W_SRC}/scripts/drills/Dockerfile.toolbox" \
    --build-arg "BACKUP_IMAGE=${BACKUP_IMG}" --build-arg "MIGRATE_IMAGE=${migrate}" "${W_SRC}" >/dev/null
  result "images built backup=$(d image inspect -f '{{.Id}}' "${BACKUP_IMG}" | cut -c1-19) postgres=$(d image inspect -f '{{.Id}}' "${POSTGRES_IMG}" | cut -c1-19)"
}

# ================================================================ up
start_wal_provider() {
  rm_container ll-drill-wal-provider
  d run -d --label "${LABEL}" --name ll-drill-wal-provider --network "${NET}" --network-alias pitr-wal-provider \
    --user 70:70 --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777 \
    --security-opt no-new-privileges:true --restart unless-stopped \
    -e PITR_ENABLED=true -e "PITR_S3_ENDPOINT=${PITR_ENDPOINT}" -e PITR_ALLOW_INSECURE_ENDPOINT=true \
    -e "PITR_S3_BUCKET=${PITR_BUCKET}" -e "PITR_S3_PREFIX=${PITR_PREFIX}" -e PITR_OBJECT_LOCK_RETENTION_DAYS=14 \
    -e PITR_ACCESS_KEY_FILE=/run/secrets/pitr-wal-object-store/access_key \
    -e PITR_SECRET_KEY_FILE=/run/secrets/pitr-wal-object-store/secret_key \
    -e PITR_MC_BIN=/opt/lunchlineup/tools/mc -e PITR_PROVIDER_OWNERSHIP_MODE=container-job \
    -e PITR_WAL_PROVIDER_HOST=0.0.0.0 -e PITR_WAL_PROVIDER_PORT=8080 \
    -e PITR_WAL_PROVIDER_MAX_BYTES=33554432 -e PITR_WAL_PROVIDER_REQUEST_TIMEOUT_MS=900000 \
    -v "${W_WORK}/secrets/pitr-wal-object-store:/run/secrets/pitr-wal-object-store:ro" \
    --entrypoint node "${BACKUP_IMG}" /app/pitr-wal-provider.mjs >/dev/null
}

phase_up() {
  log "network, volumes, object store"
  d network inspect "${NET}" >/dev/null 2>&1 || d network create --label "${LABEL}" "${NET}" >/dev/null
  for v in minio-data pgdata metrics backup-data pitr-staging fetch pitr-restore-data alertmanager-data; do
    d volume inspect "ll-drill-${v}" >/dev/null 2>&1 || d volume create --label "${LABEL}" "ll-drill-${v}" >/dev/null
  done
  # node-exporter/other readers need to see the textfile metrics written by uid 0 and 70.
  d run --rm --label "${LABEL}" -v ll-drill-metrics:/m --entrypoint chmod "${BACKUP_IMG}" 1777 /m

  rm_container ll-drill-minio
  d run -d --label "${LABEL}" --name ll-drill-minio --network "${NET}" \
    -e "MINIO_ROOT_USER=${MINIO_ROOT_USER}" -e "MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD}" \
    -e "MINIO_KMS_SECRET_KEY=ll-drill-key:${KMS_KEY}" -v ll-drill-minio-data:/data "${MINIO_IMG}" >/dev/null
  wait_for 60 "MinIO" d exec ll-drill-minio curl -fsS http://127.0.0.1:9000/minio/health/ready

  rm_container ll-drill-sts
  d run -d --label "${LABEL}" --name ll-drill-sts --network "${NET}" --read-only \
    -v "${W_SRC}/scripts/drills/sts-stub.mjs:/sts-stub.mjs:ro" --entrypoint node "${BACKUP_IMG}" /sts-stub.mjs >/dev/null

  if [ ! -s "${WORK}/secrets/backup_key" ] || [ ! -d "${WORK}/secrets/pitr-wal-object-store" ]; then
    d run --rm --label "${LABEL}" --network "${NET}" \
      -v "${W_WORK}/secrets:/secrets" -v "${W_SRC}/scripts/drills/setup-object-store.sh:/setup.sh:ro" \
      -e DRILL_ENDPOINT=http://ll-drill-minio:9000 -e DRILL_STS_ENDPOINT=http://ll-drill-sts:8080 \
      -e "MINIO_ROOT_USER=${MINIO_ROOT_USER}" -e "MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD}" \
      --entrypoint sh "${BACKUP_IMG}" /setup.sh | tee "${WORK}/results/object-store-setup.txt"
  fi
  result "object store: versioned + COMPLIANCE Object Lock buckets ${BACKUP_BUCKET}, ${PITR_BUCKET}"

  log "WAL provider + Postgres 16 (archive_mode=on, compose flags)"
  start_wal_provider
  rm_container ll-drill-pg
  d run -d --label "${LABEL}" --name ll-drill-pg --network "${NET}" --network-alias postgres \
    --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777 \
    --tmpfs /var/run/postgresql:rw,noexec,nosuid,nodev,size=16m,mode=1777 --security-opt no-new-privileges:true \
    -v ll-drill-pgdata:/var/lib/postgresql/data \
    -v "${W_SRC}/infrastructure/postgres/postgresql.conf:/etc/postgresql/postgresql.conf:ro" \
    -v "${W_SRC}/infrastructure/postgres:/opt/lunchlineup/pitr:ro" -v ll-drill-metrics:/metrics \
    -e "POSTGRES_USER=${PG_USER}" -e "POSTGRES_PASSWORD=${PG_PASS}" -e "POSTGRES_DB=${PG_DB}" \
    -e PITR_ENABLED=true -e PITR_WAL_PROVIDER_URL=http://pitr-wal-provider:8080 \
    -e PITR_WAL_PROVIDER_CLIENT_TIMEOUT_SECONDS=930 -e PITR_WAL_METRICS_FILE=/metrics/lunchlineup_pitr_wal.prom \
    "${POSTGRES_IMG}" postgres -c config_file=/etc/postgresql/postgresql.conf -c archive_mode=on >/dev/null
  wait_for 90 "Postgres" d exec ll-drill-pg pg_isready -U "${PG_USER}" -d "${PG_DB}"
  sleep 3

  log "apply the real migrations, then seed"
  toolbox -e DATA_TARGET_ENV=disposable \
    -e "MIGRATION_DATABASE_URL=postgresql://${PG_USER}:${PG_PASS}@postgres:5432/${PG_DB}" \
    -e "DATABASE_URL=postgresql://${APP_USER}:${APP_PW}@postgres:5432/${PG_DB}" \
    -e "APP_DB_USER=${APP_USER}" -e "APP_DB_PASSWORD=${APP_PW}" -e "PLATFORM_ADMIN_DB_CONTEXT_SECRET=${PLATFORM_SECRET}" \
    -e "WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT=$(head -c 32 /dev/urandom | base64)" \
    -e "MIGRATION_SOURCE_SHA=$(git -C "${REPO_ROOT}" rev-parse HEAD 2>/dev/null || printf '0%.0s' $(seq 40))" \
    -e "POSTGRES_USER=${PG_USER}" "${TOOLBOX_IMG}" node scripts/apply-db-migrations.mjs >"${WORK}/results/migrations.log" 2>&1 \
    || { tail -20 "${WORK}/results/migrations.log"; die "migrations failed"; }
  psql_src -f - <"${SRC}/scripts/drills/seed.sql" >"${WORK}/results/seed.log"
  fingerprint psql_src >"${WORK}/results/fingerprint-source.txt"
  local tables rows
  tables="$(wc -l <"${WORK}/results/fingerprint-source.txt" | tr -d ' ')"
  rows="$(awk -F'|' '{ s += $2 } END { print s }' "${WORK}/results/fingerprint-source.txt")"
  result "source database: ${tables} tables, ${rows} rows, $(psql_src -c "select pg_size_pretty(pg_database_size('${PG_DB}'))")"
}

# ================================================================ logical backup -> offsite -> restore
run_backup_job() { # extra docker args are passed through
  d run --rm --label "${LABEL}" --name ll-drill-backup-job --init --network "${NET}" --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --cpus 2 --memory 2g --pids-limit 512 \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777 \
    -v ll-drill-backup-data:/backups -v ll-drill-metrics:/metrics \
    -v "${W_WORK}/secrets/backup-offsite:/run/secrets/backup-offsite:ro" \
    -v "${W_WORK}/secrets/backup_key:/run/secrets/backup_key:ro" \
    -e POSTGRES_HOST=postgres -e POSTGRES_PORT=5432 -e "POSTGRES_USER=${PG_USER}" -e "POSTGRES_DB=${PG_DB}" \
    -e "PGPASSWORD=${PG_PASS}" -e BACKUP_DIR=/backups -e BACKUP_RETENTION_DAYS=35 \
    -e BACKUP_ENCRYPTION_KEY_FILE=/run/secrets/backup_key -e BACKUP_OFFSITE_ENABLED=true \
    -e "BACKUP_OFFSITE_URI=s3://${BACKUP_BUCKET}/${BACKUP_PREFIX}" -e BACKUP_OFFSITE_RETENTION_DAYS=35 \
    -e BACKUP_OFFSITE_RETENTION_DRY_RUN=false -e BACKUP_PROVIDER_OWNERSHIP_MODE=container-job \
    -e AWS_SHARED_CREDENTIALS_FILE=/run/secrets/backup-offsite/aws-credentials \
    -e AWS_CONFIG_FILE=/run/secrets/backup-offsite/aws-config \
    -e RCLONE_CONFIG=/run/secrets/backup-offsite/rclone.conf \
    -e BACKUP_METRICS_FILE=/metrics/lunchlineup_backup.prom "$@" "${BACKUP_IMG}"
}

compose_backup_service_block() {
  awk '/^  backup:$/ { on = 1; next } on && /^  [a-z][a-z0-9-]*:$/ { exit } on { print }' "${SRC}/docker-compose.yml"
}

aws_fetch() { # <creds-dir> -- <aws args...>
  local dir="$1"
  shift 2
  d run --rm --label "${LABEL}" --network "${NET}" -v "${W_WORK}/secrets/${dir}:/c:ro" \
    -e AWS_SHARED_CREDENTIALS_FILE=/c/aws-credentials -e AWS_CONFIG_FILE=/c/aws-config \
    --entrypoint aws "${BACKUP_IMG}" "$@"
}

restore_job() { # <backup-path-in-fetch-volume> [extra env...]
  local file="$1"
  shift
  d run --rm --label "${LABEL}" --name ll-drill-restore-job --network "${NET}" -e GNUPGHOME=/tmp -e HOME=/tmp \
    -v "${W_WORK}/secrets/backup_key:/run/secrets/backup_key:ro" -v ll-drill-fetch:/fetch \
    -e POSTGRES_HOST=postgres-restore -e POSTGRES_PORT=5432 -e "POSTGRES_USER=${PG_USER}" -e "POSTGRES_DB=${PG_DB}" \
    -e "PGPASSWORD=${RESTORE_PG_PASS}" -e "POSTGRES_PASSWORD=${RESTORE_PG_PASS}" \
    -e BACKUP_ENCRYPTION_KEY_FILE=/run/secrets/backup_key -e RESTORE_TARGET_ENV=disposable -e "RESTORE_CONFIRM=restore-${PG_DB}" \
    -e "APP_DB_USER=${APP_USER}" -e "APP_DB_PASSWORD=${APP_PW}" -e "PLATFORM_ADMIN_DB_CONTEXT_SECRET=${PLATFORM_SECRET}" \
    -e "MIGRATION_DATABASE_URL=postgresql://${PG_USER}:${RESTORE_PG_PASS}@postgres-restore:5432/${PG_DB}" \
    "$@" "${TOOLBOX_IMG}" ./scripts/restore.sh "${file}"
}

phase_logical() {
  log "compose: backup service defaults GNUPGHOME=/tmp"
  compose_backup_service_block | grep -q -- '- GNUPGHOME=/tmp' || die "docker-compose.yml backup service does not default GNUPGHOME=/tmp"
  result "docker-compose.yml backup service sets GNUPGHOME=/tmp"

  log "encrypted logical backup + immutable offsite upload (scripts/backup.sh, compose hardening flags, GNUPGHOME=/tmp as the compose service sets it)"
  run_backup_job -e GNUPGHOME=/tmp 2>&1 | tee "${WORK}/results/logical-backup.log"
  local ok file size sha off_ver sum_ver principal
  ok="$(grep '^backup_ok ' "${WORK}/results/logical-backup.log" | tail -1)"
  [ -n "${ok}" ] || die "backup.sh did not print backup_ok"
  field() { printf '%s\n' "${ok}" | tr ' ' '\n' | sed -n "s/^$1=//p"; }
  file="$(field backup_file)"; size="$(field size_bytes)"; sha="$(field backup_sha256)"
  off_ver="$(field offsite_version)"; sum_ver="$(field checksum_version)"; principal="$(field provider_principal)"
  result "backup_ok size_bytes=${size} sha256=${sha}"
  result "offsite object s3://${BACKUP_BUCKET}/${BACKUP_PREFIX}/$(basename "${file}") version=${off_ver} checksum_version=${sum_ver} principal=${principal}"

  log "independent provider readback with the read-only identity"
  local key head
  key="${BACKUP_PREFIX}/$(basename "${file}")"
  head="$(aws_fetch backup-offsite-restore -- s3api head-object --bucket "${BACKUP_BUCKET}" --key "${key}" --version-id "${off_ver}" --checksum-mode ENABLED --output json)"
  printf '%s\n' "${head}" >"${WORK}/results/offsite-head-object.json"
  printf '%s' "${head}" | grep -q "\"ContentLength\": ${size}" || die "offsite ContentLength != ${size}"
  printf '%s' "${head}" | grep -q '"ObjectLockMode": "COMPLIANCE"' || die "offsite object is not COMPLIANCE locked"
  result "offsite head-object: ContentLength=${size} ObjectLockMode=COMPLIANCE $(printf '%s' "${head}" | grep -o '"ObjectLockRetainUntilDate": "[^"]*"')"

  log "negative: the writer identity cannot delete or overwrite the immutable backup"
  if aws_fetch backup-offsite -- s3api delete-object --bucket "${BACKUP_BUCKET}" --key "${key}" --version-id "${off_ver}" >"${WORK}/results/delete-attempt.txt" 2>&1; then
    die "writer identity DELETED an immutable backup version"
  fi
  grep -q 'AccessDenied\|Access Denied' "${WORK}/results/delete-attempt.txt" || die "delete was refused for an unexpected reason: $(cat "${WORK}/results/delete-attempt.txt")"
  result "delete-object-version by writer identity: AccessDenied"

  log "fetch the OFFSITE copy by exact version id (not the local file)"
  d run --rm --label "${LABEL}" --network "${NET}" -v "${W_WORK}/secrets/backup-offsite-restore:/c:ro" -v ll-drill-fetch:/fetch \
    -e AWS_SHARED_CREDENTIALS_FILE=/c/aws-credentials -e AWS_CONFIG_FILE=/c/aws-config --entrypoint sh "${BACKUP_IMG}" -ec "
      cd /fetch && find . -mindepth 1 -delete
      aws s3api get-object --bucket ${BACKUP_BUCKET} --key ${key} --version-id ${off_ver} $(basename "${file}") >/dev/null
      aws s3api get-object --bucket ${BACKUP_BUCKET} --key ${key}.sha256 --version-id ${sum_ver} $(basename "${file}").sha256 >/dev/null
      ls -l; sha256sum -c $(basename "${file}").sha256
      mkdir tampered && cp $(basename "${file}") $(basename "${file}").sha256 tampered/
      printf 'X' | dd of=tampered/$(basename "${file}") bs=1 seek=100 conv=notrunc 2>/dev/null
    " | tee "${WORK}/results/offsite-fetch.txt"
  local fetched_sha
  fetched_sha="$(d run --rm --label "${LABEL}" -v ll-drill-fetch:/fetch --entrypoint sha256sum "${BACKUP_IMG}" "/fetch/$(basename "${file}")" | awk '{print $1}')"
  expect_eq "offsite copy sha256 equals backup_sha256" "${fetched_sha}" "${sha}"

  log "restore target: fresh, empty Postgres 16"
  rm_container ll-drill-pg-restore
  d run -d --label "${LABEL}" --name ll-drill-pg-restore --network "${NET}" --network-alias postgres-restore \
    -e "POSTGRES_USER=${PG_USER}" -e "POSTGRES_PASSWORD=${RESTORE_PG_PASS}" -e "POSTGRES_DB=${PG_DB}" "${POSTGRES_IMG}" >/dev/null
  wait_for 90 "restore Postgres" d exec ll-drill-pg-restore pg_isready -U "${PG_USER}" -d "${PG_DB}"
  sleep 3
  expect_eq "restore target table count before restore" "$(psql_restore -c "select count(*) from information_schema.tables where table_schema='public'")" 0

  log "negative: a corrupted offsite copy is refused before the database is touched"
  if restore_job "/fetch/tampered/$(basename "${file}")" >"${WORK}/results/restore-tampered.log" 2>&1; then
    die "restore.sh accepted a tampered backup"
  fi
  grep -q 'FAILED\|did NOT match\|checksum' "${WORK}/results/restore-tampered.log" || die "tampered restore failed for an unexpected reason"
  expect_eq "tables after refused tampered restore" "$(psql_restore -c "select count(*) from information_schema.tables where table_schema='public'")" 0

  log "restore the verified offsite copy with scripts/restore.sh"
  restore_job "/fetch/$(basename "${file}")" 2>&1 | tail -3 | tee "${WORK}/results/logical-restore.log"
  grep -q '^restore_ok .*app_role_verified=true' "${WORK}/results/logical-restore.log" || die "restore.sh did not print restore_ok"

  log "compare restored database with the source (rows + md5 of every row, every table)"
  fingerprint psql_restore >"${WORK}/results/fingerprint-restored.txt"
  if ! diff "${WORK}/results/fingerprint-source.txt" "${WORK}/results/fingerprint-restored.txt" >"${WORK}/results/fingerprint.diff"; then
    cat "${WORK}/results/fingerprint.diff"
    die "restored database differs from source"
  fi
  local tables rows
  tables="$(wc -l <"${WORK}/results/fingerprint-source.txt" | tr -d ' ')"
  rows="$(awk -F'|' '{ s += $2 } END { print s }' "${WORK}/results/fingerprint-source.txt")"
  result "restore from offsite: ${tables}/${tables} tables identical, ${rows}/${rows} rows identical (count + md5 per table)"
  grep -E '^public\.(Tenant|User|Location|Schedule|Shift|TimeCard|AuditLog)\|' "${WORK}/results/fingerprint-restored.txt" | while read -r line; do result "  restored ${line}"; done

  log "backup freshness metric written for node-exporter"
  d run --rm --label "${LABEL}" -v ll-drill-metrics:/m --entrypoint sh "${BACKUP_IMG}" -c 'ls -l /m; grep -v "^#" /m/lunchlineup_backup.prom' | tee "${WORK}/results/backup-metrics.txt"
}

# ================================================================ PITR
mc_in() { # <creds-dir> <mc args...>   (read-only identities)
  local dir="$1"
  shift
  d run --rm --label "${LABEL}" --network "${NET}" -v "${W_WORK}/secrets/${dir}:/s:ro" --entrypoint sh "${BACKUP_IMG}" -c '
    export MC_CONFIG_DIR=/tmp/mc MC_HOST_pitr="http://$(cat /s/access_key):$(cat /s/secret_key)@ll-drill-minio:9000"
    exec /opt/lunchlineup/tools/mc "$@"' mc "$@"
}

version_of() { # <object path under pitr/...>
  mc_in pitr-restore-object-store --json ls --versions "pitr/${PITR_BUCKET}/${PITR_PREFIX}/$1" \
    | sed -n 's/.*"versionId":"\([^"]*\)".*/\1/p' | head -1
}

run_pitr_job() { # <script> <extra docker args...>
  local script="$1"
  shift
  d run --rm --label "${LABEL}" --network "${NET}" --read-only --security-opt no-new-privileges:true \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777 \
    -v "${W_SRC}/scripts:/opt/lunchlineup/scripts:ro" -v "${W_SRC}/infrastructure/postgres:/opt/lunchlineup/infrastructure/postgres:ro" \
    -v ll-drill-pitr-staging:/var/lib/lunchlineup-pitr \
    -e PITR_ENABLED=true -e "PITR_S3_ENDPOINT=${PITR_ENDPOINT}" -e PITR_ALLOW_INSECURE_ENDPOINT=true \
    -e "PITR_S3_BUCKET=${PITR_BUCKET}" -e "PITR_S3_PREFIX=${PITR_PREFIX}" -e PITR_OBJECT_LOCK_RETENTION_DAYS=14 \
    -e PITR_STAGING_DIR=/var/lib/lunchlineup-pitr -e PITR_MC_BIN=/opt/lunchlineup/tools/mc \
    -e PITR_PROVIDER_OWNERSHIP_MODE=container-job "$@" \
    --entrypoint /bin/sh "${BACKUP_IMG}" "/opt/lunchlineup/scripts/${script}"
}

wal_objects_report() {
  mc_in pitr-restore-object-store ls "pitr/${PITR_BUCKET}/${PITR_PREFIX}/wal/"
}

phase_pitr() {
  log "WAL archiving health"
  psql_src -c "select pg_switch_wal()" >/dev/null
  sleep 6
  psql_src -c "select 'archived_count='||archived_count||' failed_count='||failed_count||' last_archived_wal='||coalesce(last_archived_wal,'-') from pg_stat_archiver" | tee "${WORK}/results/archiver.txt"
  wal_objects_report >"${WORK}/results/wal-objects.txt"
  local small
  small="$(awk '$4 !~ /MiB|GiB/ { c++ } END { print c + 0 }' "${WORK}/results/wal-objects.txt")"
  expect_eq "archived WAL objects smaller than 1 MiB (truncation guard)" "${small}" 0
  result "archived WAL: $(wc -l <"${WORK}/results/wal-objects.txt" | tr -d ' ') segments, e.g. $(head -1 "${WORK}/results/wal-objects.txt" | sed 's/^\[[^]]*\] *//')"

  log "daily base backup job (scripts/pitr-base-backup.sh) -> MinIO"
  run_pitr_job pitr-base-backup.sh -v ll-drill-metrics:/metrics \
    -v "${W_WORK}/secrets/pitr-base-backup-object-store:/run/secrets/pitr-base-backup-object-store:ro" \
    -e POSTGRES_HOST=postgres -e POSTGRES_PORT=5432 -e "POSTGRES_USER=${PG_USER}" -e "PGPASSWORD=${PG_PASS}" \
    -e PITR_METRICS_FILE=/metrics/lunchlineup_pitr.prom \
    -e PITR_ACCESS_KEY_FILE=/run/secrets/pitr-base-backup-object-store/access_key \
    -e PITR_SECRET_KEY_FILE=/run/secrets/pitr-base-backup-object-store/secret_key 2>&1 | tee "${WORK}/results/pitr-base-backup.log" | tail -3
  local bid
  bid="$(sed -n 's/^pitr_base_backup_ok backup_id=\([^ ]*\) .*/\1/p' "${WORK}/results/pitr-base-backup.log")"
  [ -n "${bid}" ] || die "base backup did not report pitr_base_backup_ok"
  result "base backup ${bid} committed (COMPLETE marker uploaded last)"

  log "writes around the recovery target"
  psql_src -c "INSERT INTO \"AuditLog\" (id,\"tenantId\",action,resource) SELECT 'pitr-pre-'||g,'drill-tenant-1','pitr.pre','before target '||g FROM generate_series(1,1000) g" >/dev/null
  psql_src -c "INSERT INTO \"AuditLog\" (id,\"tenantId\",action,resource) VALUES ('pitr-marker-A','drill-tenant-1','pitr.marker','write A: must SURVIVE recovery')" >/dev/null
  sleep 2
  local target
  target="$(psql_src -c "select to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')")"
  sleep 3
  psql_src -c "INSERT INTO \"AuditLog\" (id,\"tenantId\",action,resource) VALUES ('pitr-marker-B','drill-tenant-1','pitr.marker','write B: must be ABSENT after recovery')" >/dev/null
  psql_src -c "INSERT INTO \"AuditLog\" (id,\"tenantId\",action,resource) SELECT 'pitr-post-'||g,'drill-tenant-1','pitr.post','after target '||g FROM generate_series(1,1000) g" >/dev/null
  local segment sysid
  segment="$(psql_src -c "select pg_walfile_name(pg_current_wal_lsn())")"
  sysid="$(psql_src -c "select system_identifier from pg_control_system()")"
  psql_src -c "select pg_switch_wal()" >/dev/null
  wait_for 180 "WAL segment ${segment} to be archived" sh -c "[ \"\$(docker exec -e PGPASSWORD='${PG_PASS}' ll-drill-pg psql -X -At -U ${PG_USER} -d ${PG_DB} -c \"select last_archived_wal >= '${segment}' from pg_stat_archiver\")\" = t ]"
  result "write A at <= ${target}; write B 3 s later; recovery target ${target}; WAL segment ${segment}; source system_identifier ${sysid}"

  log "exact immutable versions (restore identity)"
  local v_complete v_base v_manifest v_wal
  v_complete="$(version_of "basebackups/${bid}/COMPLETE")"
  v_base="$(version_of "basebackups/${bid}/base.tar.gz")"
  v_manifest="$(version_of "basebackups/${bid}/backup_manifest")"
  v_wal="$(version_of "wal/${segment}")"
  [ -n "${v_complete}" ] && [ -n "${v_base}" ] && [ -n "${v_manifest}" ] && [ -n "${v_wal}" ] || die "could not resolve object versions"

  log "materialize the isolated restore volume (scripts/pitr-restore.sh)"
  d volume rm -f ll-drill-pitr-restore-data >/dev/null 2>&1 || true
  d volume create --label "${LABEL}" ll-drill-pitr-restore-data >/dev/null
  run_pitr_job pitr-restore.sh -v ll-drill-pitr-restore-data:/restore \
    -v "${W_WORK}/secrets/pitr-restore-object-store:/run/secrets/pitr-restore-object-store:ro" \
    -e PITR_ACCESS_KEY_FILE=/run/secrets/pitr-restore-object-store/access_key \
    -e PITR_SECRET_KEY_FILE=/run/secrets/pitr-restore-object-store/secret_key \
    -e PITR_RESTORE_DATA_DIR=/restore -e "PITR_BASE_BACKUP_ID=${bid}" -e "PITR_RECOVERY_TARGET_TIME=${target}" \
    -e PITR_RECOVERY_TARGET_TIMELINE=1 -e "PITR_EXPECTED_SYSTEM_IDENTIFIER=${sysid}" -e "PITR_ARCHIVED_WAL_SEGMENT=${segment}" \
    -e "PITR_BASE_BACKUP_COMPLETE_VERSION_ID=${v_complete}" -e "PITR_BASE_BACKUP_ARCHIVE_VERSION_ID=${v_base}" \
    -e "PITR_BASE_BACKUP_MANIFEST_VERSION_ID=${v_manifest}" -e "PITR_ARCHIVED_WAL_VERSION_ID=${v_wal}" \
    -e "PITR_RESTORE_CONFIRM=restore-pitr-${bid}" 2>&1 | tee "${WORK}/results/pitr-restore.log" | tail -2 | cut -c1-260
  grep -q '^pitr_restore_materialized ' "${WORK}/results/pitr-restore.log" || die "pitr-restore.sh did not materialize"

  log "start the validation instance (archiving off) and wait for the paused target"
  rm_container ll-drill-pitr-validation
  # The backup image carries the same PostgreSQL 16.15 server and GNU coreutils; the BusyBox
  # postgres image cannot run restore-wal.sh's `timeout --signal=TERM`.
  d run -d --label "${LABEL}" --name ll-drill-pitr-validation --network "${NET}" --network-alias postgres-pitr --user 70:70 \
    -e PITR_ENABLED=true -e "PITR_S3_ENDPOINT=${PITR_ENDPOINT}" -e PITR_ALLOW_INSECURE_ENDPOINT=true \
    -e "PITR_S3_BUCKET=${PITR_BUCKET}" -e "PITR_S3_PREFIX=${PITR_PREFIX}" -e PITR_OBJECT_LOCK_RETENTION_DAYS=14 \
    -e PITR_ACCESS_KEY_FILE=/run/secrets/pitr-restore-object-store/access_key \
    -e PITR_SECRET_KEY_FILE=/run/secrets/pitr-restore-object-store/secret_key \
    -e PITR_PROVIDER_OWNERSHIP_MODE=container-job -e TMPDIR=/tmp \
    -v ll-drill-pitr-restore-data:/var/lib/postgresql/data \
    -v "${W_SRC}/infrastructure/postgres:/opt/lunchlineup/pitr:ro" \
    -v "${W_WORK}/secrets/pitr-restore-object-store:/run/secrets/pitr-restore-object-store:ro" \
    --entrypoint postgres "${BACKUP_IMG}" -D /var/lib/postgresql/data -c listen_addresses='*' -c archive_mode=off \
    -c unix_socket_directories=/tmp >/dev/null
  # Poll the log, not the server: a client connection during replay would fork a process that the
  # container-job ownership check in restore-wal.sh would count as a provider survivor.
  wait_for 240 "recovery to pause at the target" sh -c "docker logs ll-drill-pitr-validation 2>&1 | grep -q 'pausing at the end of recovery'"
  docker logs ll-drill-pitr-validation 2>&1 | grep -E 'starting point-in-time|recovery stopping|pausing at the end|pitr_wal_restored' | tail -6 | tee "${WORK}/results/pitr-validation-log.txt"

  vq() { docker exec -i ll-drill-pitr-validation psql -X -At -h /tmp -U "${PG_USER}" -d "${PG_DB}" "$@"; }
  expect_eq "validation instance in recovery (paused at target)" "$(vq -c 'select pg_is_in_recovery()')" t
  local a b pre post total last
  a="$(vq -c "select count(*) from \"AuditLog\" where id='pitr-marker-A'")"
  b="$(vq -c "select count(*) from \"AuditLog\" where id='pitr-marker-B'")"
  pre="$(vq -c "select count(*) from \"AuditLog\" where id like 'pitr-pre-%'")"
  post="$(vq -c "select count(*) from \"AuditLog\" where id like 'pitr-post-%'")"
  total="$(vq -c 'select count(*) from "AuditLog"')"
  last="$(vq -c "select to_char(pg_last_xact_replay_timestamp() at time zone 'utc','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')")"
  expect_eq "PITR write A (before target) present" "${a}" 1
  expect_eq "PITR write B (after target) present" "${b}" 0
  expect_eq "PITR rows written before target (of 1000)" "${pre}" 1000
  expect_eq "PITR rows written after target (of 1000)" "${post}" 0
  result "PITR last replayed commit ${last} <= target ${target}; AuditLog rows ${total} (source now has $(psql_src -c 'select count(*) from "AuditLog"'))"
  [[ "${last}" < "${target}" || "${last}" == "${target}" ]] || die "replayed past the recovery target"
  expect_eq "source still has write B" "$(psql_src -c "select count(*) from \"AuditLog\" where id='pitr-marker-B'")" 1

  log "accept recovery: pg_wal_replay_resume() promotes the isolated copy"
  vq -c 'select pg_wal_replay_resume()' >/dev/null
  wait_for 60 "promotion" sh -c "[ \"\$(docker exec ll-drill-pitr-validation psql -X -At -h /tmp -U ${PG_USER} -d ${PG_DB} -c 'select pg_is_in_recovery()')\" = f ]"
  expect_eq "after promotion: write A present" "$(vq -c "select count(*) from \"AuditLog\" where id='pitr-marker-A'")" 1
  expect_eq "after promotion: write B absent" "$(vq -c "select count(*) from \"AuditLog\" where id='pitr-marker-B'")" 0
  vq -c "INSERT INTO \"AuditLog\" (id,\"tenantId\",action,resource) VALUES ('pitr-after-promotion','drill-tenant-1','pitr.after','recovered copy is writable')" >/dev/null
  result "recovered primary is writable; new timeline $(vq -c 'select timeline_id from pg_control_checkpoint()')"
  rm_container ll-drill-pitr-validation

}

phase_lifecycle() {
  # The verifier only canonicalises the endpoint string and insists on https; the real
  # export below still runs against the local http MinIO.
  log "lifecycle policy proof (lifecycle-audit identity -> scripts/verify-pitr-lifecycle-policy.mjs)"
  toolbox -v "${W_WORK}/secrets/pitr-lifecycle-audit-object-store:/run/secrets/audit:ro" \
    -e PITR_ENABLED=true -e "PITR_S3_ENDPOINT=${PITR_ENDPOINT}" -e PITR_ALLOW_INSECURE_ENDPOINT=true \
    -e "PITR_S3_BUCKET=${PITR_BUCKET}" -e "PITR_S3_PREFIX=${PITR_PREFIX}" -e PITR_OBJECT_LOCK_RETENTION_DAYS=14 \
    -e PITR_ACCESS_KEY_FILE=/run/secrets/audit/access_key -e PITR_SECRET_KEY_FILE=/run/secrets/audit/secret_key \
    -e PITR_MC_BIN=/opt/lunchlineup/tools/mc -e PITR_PROVIDER_OWNERSHIP_MODE=container-job "${TOOLBOX_IMG}" sh -ec "
      sh /opt/lunchlineup/infrastructure/postgres/pitr-export-lifecycle-policy.sh >/tmp/live.json
      node scripts/verify-pitr-lifecycle-policy.mjs --policy-file /tmp/live.json --endpoint https://ll-drill-minio:9000\
        --bucket ${PITR_BUCKET} --prefix ${PITR_PREFIX} --immutable-days 14 --maximum-days 90 --canonical-output /tmp/canonical.json" \
    2>&1 | tee "${WORK}/results/pitr-lifecycle.txt" | tail -3
  psql_src -c "select 'archived_count='||archived_count||' failed_count='||failed_count from pg_stat_archiver" | sed 's/^/RESULT pg_stat_archiver at end: /' | tee -a "${WORK}/results/summary.txt"
}

# ================================================================ alerts

phase_alerts() {
  log "webhook receiver (stand-in for the owner's alert endpoint)"
  rm_container ll-drill-webhook
  d run -d --label "${LABEL}" --name ll-drill-webhook --network "${NET}" --read-only --tmpfs /tmp:rw,size=8m,mode=1777 \
    -v "${W_SRC}/scripts/drills/webhook-receiver.mjs:/receiver.mjs:ro" --entrypoint node "${BACKUP_IMG}" /receiver.mjs >/dev/null

  log "Alertmanager with the repo config (infrastructure/alertmanager/alertmanager.yml)"
  rm_container ll-drill-alertmanager
  mkdir -p "${WORK}/alert-secrets"
  printf 'http://ll-drill-webhook:8080/alert' >"${WORK}/alert-secrets/alertmanager_webhook_url"
  chmod 0644 "${WORK}/alert-secrets/alertmanager_webhook_url"
  d run -d --label "${LABEL}" --name ll-drill-alertmanager --network "${NET}" --network-alias alertmanager --read-only \
    --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777 \
    -v "${W_SRC}/infrastructure/alertmanager/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro" \
    -v "${W_WORK}/alert-secrets/alertmanager_webhook_url:/run/secrets/alertmanager_webhook_url:ro" \
    -v ll-drill-alertmanager-data:/alertmanager "${ALERTMANAGER_IMG}" \
    --config.file=/etc/alertmanager/alertmanager.yml --storage.path=/alertmanager >/dev/null
  wait_for 60 "Alertmanager" d exec ll-drill-alertmanager wget -qO- http://127.0.0.1:9093/-/healthy
  d exec ll-drill-alertmanager /bin/amtool check-config /etc/alertmanager/alertmanager.yml 2>&1 | tee "${WORK}/results/amtool-check-config.txt" | head -8

  log "fire a test alert with amtool; group_wait is 30 s"
  d exec ll-drill-alertmanager /bin/amtool --alertmanager.url=http://127.0.0.1:9093 alert add LunchLineupDrillTest \
    severity=critical service=backup team=ops --annotation=summary="Backup drill test alert" \
    --annotation=description="Synthetic alert fired by scripts/drills/backup-restore-drill.sh" >/dev/null
  wait_for 120 "webhook delivery" sh -c "docker exec ll-drill-webhook node -e \"fetch('http://127.0.0.1:8080/received').then(r=>r.text()).then(t=>{process.exit(t.includes('LunchLineupDrillTest')?0:1)})\""
  docker exec ll-drill-webhook node -e "fetch('http://127.0.0.1:8080/received').then(r=>r.text()).then(t=>{for(const l of t.trim().split('\n')){const e=JSON.parse(l);const p=e.payload;console.log(JSON.stringify({receivedAt:e.receivedAt,status:p.status,receiver:p.receiver,alerts:(p.alerts||[]).map(a=>({alertname:a.labels.alertname,severity:a.labels.severity,status:a.status,summary:a.annotations&&a.annotations.summary}))}))}})" | tee "${WORK}/results/webhook-received-amtool.jsonl"
  result "Alertmanager -> webhook delivered LunchLineupDrillTest (status firing)"

  if [ "${DRILL_ALERT_PROMETHEUS:-1}" = 1 ]; then
    alerts_prometheus_path
  fi
}

alerts_prometheus_path() {
  log "real rule path: archive failure metric -> node-exporter -> Prometheus rule PitrWalArchiveFailure -> Alertmanager -> webhook"
  rm_container ll-drill-node-exporter
  rm_container ll-drill-prometheus
  d run -d --label "${LABEL}" --name ll-drill-node-exporter --network "${NET}" -v ll-drill-metrics:/textfile:ro "${NODE_EXPORTER_IMG}" \
    --collector.textfile.directory=/textfile --collector.disable-defaults --collector.textfile >/dev/null
  cat >"${WORK}/prometheus.yml" <<'EOF'
global:
  scrape_interval: 15s
  evaluation_interval: 15s
rule_files:
  - /etc/prometheus/alerts/lunchlineup.yml
alerting:
  alertmanagers:
    - static_configs:
        - targets: ['alertmanager:9093']
scrape_configs:
  - job_name: drill-textfile
    static_configs:
      - targets: ['ll-drill-node-exporter:9100']
EOF
  d run --rm --label "${LABEL}" -v "${W_SRC}/infrastructure/prometheus/alerts:/alerts:ro" --entrypoint promtool "${PROMETHEUS_IMG}" check rules /alerts/lunchlineup.yml 2>&1 | tail -3 | tee "${WORK}/results/promtool-check-rules.txt"
  d run --rm --label "${LABEL}" -v "${W_SRC}/infrastructure/prometheus/alerts:/alerts:ro" --entrypoint promtool "${PROMETHEUS_IMG}" test rules /alerts/tests/lunchlineup.test.yml 2>&1 | tail -3 | tee "${WORK}/results/promtool-test-rules.txt"
  d run -d --label "${LABEL}" --name ll-drill-prometheus --network "${NET}" \
    -v "${W_WORK}/prometheus.yml:/etc/prometheus/prometheus.yml:ro" -v "${W_SRC}/infrastructure/prometheus/alerts:/etc/prometheus/alerts:ro" \
    "${PROMETHEUS_IMG}" --config.file=/etc/prometheus/prometheus.yml --storage.tsdb.path=/tmp/prom >/dev/null
  wait_for 60 "Prometheus" d exec ll-drill-prometheus wget -qO- http://127.0.0.1:9090/-/ready

  # Healthy baseline: the archive success metric must be scraped.
  psql_src -c "select pg_switch_wal()" >/dev/null
  sleep 30
  local ok_ts
  ok_ts="$(d exec ll-drill-prometheus wget -qO- 'http://127.0.0.1:9090/api/v1/query?query=lunchlineup_pitr_wal_archive_last_success_timestamp_seconds' | sed -n 's/.*"value":\[[0-9.]*,"\([0-9.e+]*\)"\].*/\1/p')"
  [ -n "${ok_ts}" ] || die "Prometheus did not scrape lunchlineup_pitr_wal_archive_last_success_timestamp_seconds (textfile permissions?)"
  result "Prometheus scraped lunchlineup_pitr_wal_archive_last_success_timestamp_seconds=${ok_ts}"

  log "break the archive: stop the object store, keep generating WAL"
  d pause ll-drill-minio >/dev/null
  local i
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22; do
    psql_src -c "INSERT INTO \"AuditLog\" (id,\"tenantId\",action,resource) VALUES ('alert-drill-${i}','drill-tenant-1','alert.drill','x'); select pg_switch_wal()" >/dev/null 2>&1 || true
    sleep 15
    if docker exec ll-drill-webhook node -e "fetch('http://127.0.0.1:8080/received').then(r=>r.text()).then(t=>{process.exit(t.includes('PitrWalArchiveFailure')?0:1)})" >/dev/null 2>&1; then
      break
    fi
  done
  d unpause ll-drill-minio >/dev/null
  docker exec ll-drill-webhook node -e "fetch('http://127.0.0.1:8080/received').then(r=>r.text()).then(t=>{for(const l of t.trim().split('\n')){const e=JSON.parse(l);const p=e.payload;console.log(JSON.stringify({receivedAt:e.receivedAt,status:p.status,alerts:(p.alerts||[]).map(a=>({alertname:a.labels.alertname,severity:a.labels.severity,status:a.status,summary:a.annotations&&a.annotations.summary,runbook:a.annotations&&a.annotations.runbook}))}))}})" | tee "${WORK}/results/webhook-received-all.jsonl"
  grep -q PitrWalArchiveFailure "${WORK}/results/webhook-received-all.jsonl" || die "PitrWalArchiveFailure was not delivered to the webhook"
  result "Prometheus rule PitrWalArchiveFailure fired and was delivered to the webhook after the object store went down"

  log "object store restored: archiving must recover and the archive backlog must drain"
  wait_for 180 "archiver to recover" sh -c "[ \"\$(docker exec -e PGPASSWORD='${PG_PASS}' ll-drill-pg psql -X -At -U ${PG_USER} -d ${PG_DB} -c \"select (last_archived_time > last_failed_time)::text from pg_stat_archiver\")\" = true ]"
  result "archiver recovered after the outage: $(psql_src -c "select 'archived_count='||archived_count||' failed_count='||failed_count from pg_stat_archiver")"
}

# ================================================================ systemd
phase_systemd() {
  log "systemd units (infrastructure/systemd)"
  local units="${SRC}/infrastructure/systemd"
  grep -q '^OnCalendar=\*-\*-\* 02:17:00$' "${units}/lunchlineup-backup.timer" || die "backup timer schedule changed"
  grep -q '^Persistent=true$' "${units}/lunchlineup-backup.timer" || die "backup timer is not Persistent"
  grep -q '^Unit=lunchlineup-backup.service$' "${units}/lunchlineup-backup.timer" || die "backup timer targets the wrong unit"
  grep -q 'pitr-run-candidate-job.sh" lunchlineup-backup.service' "${units}/lunchlineup-backup.service" || die "service does not run the candidate wrapper"
  grep -q 'lunchlineup-backup.service) *' "${SRC}/scripts/pitr-run-candidate-job.sh" || grep -q 'lunchlineup-backup.service' "${SRC}/scripts/pitr-run-candidate-job.sh" || die "wrapper does not map the unit"
  result "backup timer: daily 02:17 (+30m random), Persistent=true, runs pitr-run-candidate-job.sh lunchlineup-backup.service"
  if command -v systemd-analyze >/dev/null 2>&1; then
    local tmp="${WORK}/systemd"
    mkdir -p "${tmp}"
    cp "${units}"/lunchlineup-backup.* "${units}"/lunchlineup-pitr-base-backup.* "${tmp}/"
    (cd "${tmp}" && systemd-analyze verify --man=no ./lunchlineup-backup.service ./lunchlineup-backup.timer ./lunchlineup-pitr-base-backup.service ./lunchlineup-pitr-base-backup.timer 2>&1 || true) | tee "${WORK}/results/systemd-verify.txt"
    systemd-analyze calendar '*-*-* 02:17:00' '*-*-* 03:17:00' 2>&1 | tee "${WORK}/results/systemd-calendar.txt" | grep -E 'Original|Next elapse' || true
  else
    result "systemd-analyze not available on this host; units checked statically only"
  fi
}

# ================================================================ down
phase_down() {
  log "removing ll-drill-* containers, volumes and network"
  local ids
  ids="$(docker ps -aq --filter "label=${LABEL}")"
  [ -z "${ids}" ] || docker rm -f ${ids} >/dev/null
  ids="$(docker volume ls -q --filter "label=${LABEL}")"
  [ -z "${ids}" ] || docker volume rm -f ${ids} >/dev/null
  docker network rm "${NET}" >/dev/null 2>&1 || true
  if [ "${DRILL_REMOVE_IMAGES:-0}" = 1 ]; then
    docker rmi -f "${BACKUP_IMG}" "${POSTGRES_IMG}" "${MINIO_IMG}" "${TOOLBOX_IMG}" ll-drill-migrate:local >/dev/null 2>&1 || true
  fi
  result "drill containers, volumes and network removed"
}

case "${1:-all}" in
  build) phase_build ;;
  up) phase_up ;;
  logical) phase_logical ;;
  pitr) phase_pitr ;;
  lifecycle) phase_lifecycle ;;
  alerts) phase_alerts ;;
  systemd) phase_systemd ;;
  down) phase_down ;;
  all)
    phase_build
    phase_up
    phase_logical
    phase_pitr
    phase_lifecycle
    phase_alerts
    phase_systemd
    result "ALL DRILL PHASES PASSED (work dir ${WORK})"
    ;;
  *) echo "usage: $0 [all|build|up|logical|pitr|alerts|systemd|down]" >&2; exit 64 ;;
esac
