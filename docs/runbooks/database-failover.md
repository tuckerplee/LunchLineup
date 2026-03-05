# Runbook: Database Failover

## Symptom
Postgres is unreachable or all replicas report unhealthy.

## Diagnostics
1. Check `docker logs lunchlineup-postgres` for crash logs.
2. Verify disk space: `docker exec lunchlineup-postgres df -h /var/lib/postgresql/data`
3. Check PgBouncer status: `docker logs lunchlineup-pgbouncer`
4. Check active connections in Grafana → Database dashboard.

## Resolution
1. **If OOM**: Increase container memory limits in docker-compose, restart.
2. **If disk full**: Run `docker exec lunchlineup-postgres vacuumdb --all --verbose`, prune old WAL.
3. **If corrupted**: Restore from latest backup:
   ```bash
   ./scripts/restore.sh latest
   ```
4. **If config error**: Check `postgresql.conf` for invalid values. Regenerate from defaults.

## Escalation
If database is unrecoverable, trigger DR drill: `./scripts/dr-drill.sh`
