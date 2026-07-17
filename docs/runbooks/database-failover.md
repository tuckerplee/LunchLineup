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

Expected result: the drill emits `dr_drill_ok` only after removing the full immutable container ID returned by `docker run` and independently proving both that exact ID and the reserved name are absent. Its retained JSON must bind `container_id=cleanup_container_id`, `cleanup_container_id_absent=true`, `cleanup_container_name_absent=true`, and `cleanup_id_evidence=docker-ps-exact-id-v1`; a rename/replacement race or cleanup uncertainty exits nonzero and leaves no success artifact. The database password reaches Docker only through the private env file, never CLI arguments. A promoted disposable stack must then return healthy and permit a tenant-scoped schedule query without cross-tenant leakage.

For an emergency production restore, retain two independent target records: a protected JSON descriptor and a fixed-workflow-signed target pin. Both bind the production cluster ID, owner and migration host/port/database/user, and PostgreSQL `system_identifier`; pin the descriptor SHA-256 out of band. Also retain the signed recovery-adapter and exact recovery-execution attestation/signature pairs used by the DR proof. `restore.sh` rejects symlinks and opens the encrypted backup, checksum, and each evidence path once through a stable descriptor into private mode-0600 snapshots; all hashes, parsing, signature verification, decryption, and SQL input consume only those snapshots. Replacing a declared path after verification cannot alter the restored bytes. It validates these before confirmation, then queries `pg_control_system()` and matches the signed identifier before table inspection or mutation:

```bash
BACKUP_ENCRYPTION_KEY_FILE=/run/secrets/backup_key \
RESTORE_TARGET_ENV=production \
RESTORE_ALLOW_PRODUCTION=YES_RESTORE_PRODUCTION \
RESTORE_PRODUCTION_CLUSTER_ID=production-cluster-a \
RESTORE_PRODUCTION_TARGET_DESCRIPTOR_FILE=/secure/production-database-target.json \
RESTORE_PRODUCTION_TARGET_DESCRIPTOR_SHA256=<descriptor-sha256> \
RESTORE_PRODUCTION_TARGET_PIN_FILE=/secure/production-database-target-pin.json \
RESTORE_PRODUCTION_TARGET_PIN_SIGNATURE_BUNDLE_FILE=/secure/production-database-target-pin.sigstore.json \
RESTORE_CONFIRM=restore-production-target:production-cluster-a:lunchlineup:<target-pin-sha256>:<descriptor-sha256> \
RESTORE_DR_PROVENANCE_FILE=/secure/provider-readback.json \
RESTORE_DR_PROVENANCE_SHA256=<readback-sha256> \
RESTORE_DR_ADAPTER_ATTESTATION_FILE=/secure/recovery-adapter-attestation.json \
RESTORE_DR_ADAPTER_SIGNATURE_BUNDLE_FILE=/secure/recovery-adapter-attestation.sigstore.json \
RESTORE_DR_EXECUTION_ATTESTATION_FILE=/secure/recovery-execution-attestation.json \
RESTORE_DR_EXECUTION_SIGNATURE_BUNDLE_FILE=/secure/recovery-execution-attestation.sigstore.json \
RESTORE_DR_RELEASE_SHA=<40-character-release-sha> \
./scripts/restore.sh /backups/lunchlineup-YYYYMMDDHHMMSS.sql.zst.gpg
```

The destructive transaction, optional queue rehydration, restricted-role provisioning, and final readbacks share `RESTORE_MUTATION_TIMEOUT_SECONDS` (default and maximum 600 seconds; 601 is rejected). Deadline exhaustion exits `70`, kills the bounded child process group, performs only bounded target-identity/table reconciliation under `RESTORE_RECONCILIATION_TIMEOUT_SECONDS`, and must not be retried blindly. The disposable drill separately applies one `DR_RESTORE_PIPELINE_TIMEOUT_SECONDS` deadline (default and maximum 600 seconds) from Docker container creation through readiness, decrypt/decompress/restore, sanity reads, immutable-ID cleanup, proof publication, and proof readback; deadline failure runs only the independently bounded exact-ID emergency cleanup and leaves no success proof.

If the target database is not empty, rebuild an empty target first. Use `RESTORE_ALLOW_NONEMPTY=YES_OVERWRITE` only with incident-owner approval.

## Escalation

If the database is unrecoverable, trigger the DR drill with the exact off-host object, immutable version/checksum, signed adapters, and proof destination described above:

```bash
./scripts/dr-drill.sh
```
