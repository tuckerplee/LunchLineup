#!/bin/bash
# scripts/backup.sh
# Production database backup script with encryption and offsite sync
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
TIMESTAMP=$(date +%Y%m%d%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/lunchlineup-${TIMESTAMP}.sql.zst.gpg"

# Fallback values for env vars
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
POSTGRES_DB="${POSTGRES_DB:-lunchlineup}"

echo "Starting backup to ${BACKUP_FILE}..."

# 1. Create backup using pg_dump
# 2. Compress with zstd
# 3. Encrypt with GPG symmetric key
if [ -z "${BACKUP_ENCRYPTION_KEY:-}" ]; then
  echo "ERROR: BACKUP_ENCRYPTION_KEY is not set."
  exit 1
fi

pg_dump -U "${POSTGRES_USER}" -h "${POSTGRES_HOST}" "${POSTGRES_DB}" \
  | zstd -c \
  | gpg --symmetric --batch --passphrase "${BACKUP_ENCRYPTION_KEY}" -o "${BACKUP_FILE}"

echo "Backup encrypted and saved successfully."

# 4. Prune old backups (Keep last 30 days)
find "${BACKUP_DIR}" -type f -name "*.sql.zst.gpg" -mtime +30 -delete
echo "Pruned backups older than 30 days."

# 5. Offsite sync via AWS S3
if [ "${BACKUP_OFFSITE_ENABLED:-false}" = "true" ]; then
  if [ -z "${BACKUP_S3_BUCKET:-}" ]; then
     echo "ERROR: BACKUP_S3_BUCKET not set for offsite sync."
     exit 1
  fi
  echo "Syncing backup to S3 bucket: ${BACKUP_S3_BUCKET}..."
  aws s3 cp "${BACKUP_FILE}" "s3://${BACKUP_S3_BUCKET}/db-backups/"
  echo "Offsite sync complete."
fi

echo "Backup process finished successfully."
