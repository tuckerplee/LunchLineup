# Runbook: Database Failover

For timestamp recovery after destructive writes or primary loss, use `postgres-pitr-recovery.md`. Backups and PITR are the estate pgBackRest (repository on the NAS), operated by estate-infra; this runbook covers the application-side outage path.

## Symptom

Postgres is unreachable, health checks fail, or the stack reports the database dependency down.

## Diagnostics

1. Check `docker compose logs --tail=200 postgres` for crash logs.
2. Verify disk space: `docker compose exec postgres df -h /var/lib/postgresql/data`.
3. Check PgBouncer status: `docker compose logs --tail=200 pgbouncer`.
4. Check active connections and the `lunchlineup_dependency_up` series in the estate Grafana.
5. Ask estate-infra to confirm the latest pgBackRest backup and WAL archive state before any destructive step.

## Resolution

1. **If OOM**: increase container memory limits in `docker-compose.yml`, then restart the affected services.
2. **If disk full**: run `docker compose exec postgres vacuumdb --all --verbose`. If WAL archiving is attached and failing, fix the estate archive path first; do not delete WAL.
3. **If corrupted**: stop the application services and have estate-infra restore with pgBackRest (`postgres-pitr-recovery.md`). Rehearse in a disposable stack first when time allows.
4. **If config error**: check `postgresql.conf` and the `POSTGRES_ARCHIVE_MODE`/`POSTGRES_ARCHIVE_COMMAND` runtime values for invalid settings, then regenerate from known-good defaults.

## Verification after recovery

```bash
docker compose ps
curl -fsS http://127.0.0.1/health
```

Run `docker compose run --rm --pull never migrate`, confirm login and one tenant-scoped schedule query, then lift the launch hold.

## Escalation

If the database is unrecoverable, escalate to estate-infra with the pgBackRest stanza name, the target recovery time and the incident record. The drill procedure is in `backup-restore-drill.md`.
