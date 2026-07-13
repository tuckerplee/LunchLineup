#!/bin/sh
# Verified physical base backup upload for PostgreSQL PITR.
set -eu
umask 077

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"
. "${REPO_ROOT}/infrastructure/postgres/pitr-object-store.sh"

POSTGRES_HOST="${POSTGRES_HOST:-postgres}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
PITR_STAGING_DIR="${PITR_STAGING_DIR:-/var/lib/lunchlineup-pitr}"
BACKUP_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
BACKUP_DIR="${PITR_STAGING_DIR}/${BACKUP_ID}"
BACKUP_DATA_DIR="${BACKUP_DIR}/data"
PITR_MC_CONFIG_DIR=""

cleanup() {
  rm -rf "${BACKUP_DIR}"
  pitr_close_object_store
}
trap cleanup EXIT HUP INT TERM

case "${PITR_STAGING_DIR}" in
  '' | / | . | ..) pitr_fail "PITR_STAGING_DIR must be a dedicated directory." ;;
esac

for command_name in pg_basebackup pg_verifybackup tar sha256sum find mktemp; do
  command -v "${command_name}" >/dev/null 2>&1 || pitr_fail "Required command is missing: ${command_name}"
done
[ -n "${PGPASSWORD:-}" ] || pitr_fail "PGPASSWORD is required for the physical base backup connection."
mkdir -p "${BACKUP_DATA_DIR}"

pg_basebackup \
  --host="${POSTGRES_HOST}" \
  --port="${POSTGRES_PORT}" \
  --username="${POSTGRES_USER}" \
  --pgdata="${BACKUP_DATA_DIR}" \
  --format=plain \
  --wal-method=stream \
  --checkpoint=fast \
  --manifest-checksums=SHA256 \
  --label="LunchLineup PITR ${BACKUP_ID}"

pg_verifybackup --no-parse-wal --exit-on-error "${BACKUP_DATA_DIR}"
[ -s "${BACKUP_DATA_DIR}/backup_manifest" ] || pitr_fail "Base backup manifest is missing."
cp "${BACKUP_DATA_DIR}/backup_manifest" "${BACKUP_DIR}/backup_manifest"
tar -czf "${BACKUP_DIR}/base.tar.gz" -C "${BACKUP_DATA_DIR}" .
rm -rf "${BACKUP_DATA_DIR}"
[ -s "${BACKUP_DIR}/base.tar.gz" ] || pitr_fail "Base backup archive is missing."
[ -s "${BACKUP_DIR}/backup_manifest" ] || pitr_fail "Base backup manifest is missing."
MANIFEST_SHA256="$(sha256sum "${BACKUP_DIR}/backup_manifest" | awk '{print $1}')"
COMPLETED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat >"${BACKUP_DIR}/COMPLETE" <<EOF
backup_id=${BACKUP_ID}
completed_at=${COMPLETED_AT}
manifest_sha256=${MANIFEST_SHA256}
EOF

pitr_open_object_store
REMOTE_BACKUP="${PITR_REMOTE_ROOT}/basebackups/${BACKUP_ID}"
for backup_file in "${BACKUP_DIR}"/*; do
  [ "$(basename "${backup_file}")" = "COMPLETE" ] && continue
  pitr_upload_encrypted "${backup_file}" "${REMOTE_BACKUP}/$(basename "${backup_file}")" >/dev/null
done
# COMPLETE is the commit marker and is intentionally the last uploaded object.
pitr_upload_encrypted "${BACKUP_DIR}/COMPLETE" "${REMOTE_BACKUP}/COMPLETE" >/dev/null
pitr_mc stat "${REMOTE_BACKUP}/COMPLETE" >/dev/null

if [ -n "${PITR_METRICS_FILE:-}" ]; then
  METRICS_DIR="$(dirname "${PITR_METRICS_FILE}")"
  mkdir -p "${METRICS_DIR}"
  TMP_METRICS="$(mktemp "${METRICS_DIR}/lunchlineup-pitr.prom.tmp.XXXXXX")"
  cat >"${TMP_METRICS}" <<EOF
# HELP lunchlineup_pitr_base_backup_last_success_timestamp_seconds Unix timestamp of the last verified remote PITR base backup.
# TYPE lunchlineup_pitr_base_backup_last_success_timestamp_seconds gauge
lunchlineup_pitr_base_backup_last_success_timestamp_seconds $(date -u +%s)
# HELP lunchlineup_pitr_object_lock_retention_days Immutable COMPLIANCE retention applied to uploaded PITR objects.
# TYPE lunchlineup_pitr_object_lock_retention_days gauge
lunchlineup_pitr_object_lock_retention_days ${PITR_OBJECT_LOCK_RETENTION_DAYS}
EOF
  mv "${TMP_METRICS}" "${PITR_METRICS_FILE}"
fi

printf 'pitr_base_backup_ok backup_id=%s manifest_sha256=%s remote=%s completed_at=%s\n' \
  "${BACKUP_ID}" "${MANIFEST_SHA256}" "${REMOTE_BACKUP}" "${COMPLETED_AT}"
