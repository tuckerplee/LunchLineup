#!/bin/bash
# scripts/restore.sh
# Production database restore script
set -euo pipefail

if [ "$#" -ne 1 ]; then
    echo "Usage: $0 <path_to_encrypted_backup_file>"
    exit 1
fi

BACKUP_FILE="$1"

# Fallback values
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
POSTGRES_DB="${POSTGRES_DB:-lunchlineup}"

if [ ! -f "${BACKUP_FILE}" ]; then
    echo "ERROR: Backup file ${BACKUP_FILE} not found."
    exit 1
fi

if [ -z "${BACKUP_ENCRYPTION_KEY:-}" ]; then
  echo "ERROR: BACKUP_ENCRYPTION_KEY is not set. Cannot decrypt."
  exit 1
fi

echo "WARNING: This will overwrite the current database '${POSTGRES_DB}' on '${POSTGRES_HOST}'."
read -p "Are you sure you want to proceed? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Restore aborted."
    exit 1
fi

echo "Starting restore from ${BACKUP_FILE}..."

# 1. Decrypt with GPG
# 2. Decompress with zstd
# 3. Restore with psql
gpg --decrypt --batch --passphrase "${BACKUP_ENCRYPTION_KEY}" "${BACKUP_FILE}" \
  | zstd -d -c \
  | psql -U "${POSTGRES_USER}" -h "${POSTGRES_HOST}" -d "${POSTGRES_DB}"

echo "Database restore completed successfully."
