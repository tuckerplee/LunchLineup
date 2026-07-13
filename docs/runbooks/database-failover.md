# Runbook: Database Failover

For timestamp recovery after destructive writes or primary loss, use `postgres-pitr-recovery.md`. Keep this outage path and the encrypted logical-dump restore path available independently.

## Symptom

Postgres is unreachable, health checks fail, or all replicas report unhealthy.

## Diagnostics

1. Check `docker compose logs --tail=200 postgres` for crash logs.
2. Verify disk space: `docker compose exec postgres df -h /var/lib/postgresql/data`.
3. Check PgBouncer status: `docker compose logs --tail=200 pgbouncer`.
4. Check active connections in the Grafana Database dashboard.
5. Confirm backup telemetry exists: `lunchlineup_backup_last_success_timestamp_seconds`.

## Resolution

1. **If OOM**: increase container memory limits in `docker-compose.yml`, then restart the affected services.
2. **If disk full**: run `docker compose exec postgres vacuumdb --all --verbose`, then prune old WAL only after confirming backups are healthy.
3. **If corrupted**: restore from an explicit encrypted backup path, never a vague `latest` alias. Restore into an empty disposable or staging database first:

   ```bash
   BACKUP_ENCRYPTION_KEY_FILE=/run/secrets/backup_key \
   RESTORE_TARGET_ENV=disposable \
   RESTORE_CONFIRM=restore-lunchlineup_drill \
   POSTGRES_DB=lunchlineup_drill \
   ./scripts/restore.sh /backups/lunchlineup-YYYYMMDDHHMMSS.sql.zst.gpg
   ```

4. **If config error**: check `postgresql.conf` for invalid values, then regenerate from known-good defaults.

## Backup Verification

Before promoting a restore, prove the backup in a disposable environment:

```bash
BACKUP_ENCRYPTION_KEY_FILE=/run/secrets/backup_key ./scripts/dr-drill.sh
docker compose ps
curl -fsS http://127.0.0.1/health
```

Expected result: restore exits successfully, health returns ok, and tenant-scoped schedule data can be queried without cross-tenant leakage.

For an emergency production restore, the target database must be empty unless the incident owner explicitly accepts overwrite risk:

```bash
BACKUP_ENCRYPTION_KEY_FILE=/run/secrets/backup_key \
RESTORE_TARGET_ENV=production \
RESTORE_ALLOW_PRODUCTION=YES_RESTORE_PRODUCTION \
RESTORE_CONFIRM=restore-lunchlineup \
./scripts/restore.sh /backups/lunchlineup-YYYYMMDDHHMMSS.sql.zst.gpg
```

If the target database is not empty, rebuild an empty target first. Use `RESTORE_ALLOW_NONEMPTY=YES_OVERWRITE` only with incident-owner approval.

## Escalation

If the database is unrecoverable, trigger the DR drill:

```bash
./scripts/dr-drill.sh
```
