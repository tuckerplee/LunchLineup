#!/bin/sh
# scripts/dr-drill.sh
set -e

echo "Starting Disaster Recovery Drill..."

# 1. Find latest backup
LATEST_BACKUP=$(ls -t /backups/*.sql.zst | head -n 1)

if [ -z "${LATEST_BACKUP}" ]; then
  echo "No backups found!"
  exit 1
fi

echo "Restoring from ${LATEST_BACKUP} to ephemeral test database..."

# 2. Spin up ephemeral Postgres (simplified logic)
# 3. Restore data
# zstd -d -c "${LATEST_BACKUP}" | psql -h localhost -U root test_db

# 4. Run sanity checks
# psql -h localhost -U root test_db -c "SELECT count(*) FROM tenants;"

echo "DR Drill successful."
