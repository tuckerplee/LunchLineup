# PostgreSQL Point-In-Time Recovery

Use this runbook to restore production to a UTC timestamp using a verified physical base backup plus the off-host WAL archive. Keep the encrypted logical dump path in `scripts/restore.sh`; it remains the independent fallback.

## Preconditions

- Stop application writes before final cutover. Never run recovery against the live `postgres_data` volume.
- Record the incident timestamp in UTC and choose a completed base backup whose completion precedes that timestamp.
- Confirm `PITR_ENABLED=true`, the exact HTTPS endpoint/bucket/cluster prefix, and `PITR_OBJECT_LOCK_RETENTION_DAYS` of at least 14.
- Confirm the runtime names three distinct absolute managed directories: `PITR_WAL_OBJECT_STORE_SECRETS_DIR`, `PITR_BASE_BACKUP_OBJECT_STORE_SECRETS_DIR`, and `PITR_RESTORE_OBJECT_STORE_SECRETS_DIR`.
- Keep the original `postgres_data` volume and container stopped but intact until recovery is accepted.
- Recovery targets must be after the selected base backup ended and inside the object-store lifecycle window.

## Credential And Retention Policy

Provision three least-privilege identities. The WAL and base-backup writers may create immutable objects, stat/read existing objects for idempotency, inspect bucket versioning/default retention, and inspect object retention. Explicitly deny `DeleteObject`, `DeleteObjectVersion`, retention bypass/clear, lifecycle mutation, and bucket deletion. The restore identity may list/read only the dedicated cluster prefix and inspect retention metadata. It cannot write or delete.

Enable bucket versioning and default COMPLIANCE Object Lock for exactly `PITR_OBJECT_LOCK_RETENTION_DAYS`. Every writer upload also requests COMPLIANCE retention. Before launch and before every production deploy, run:

```bash
APP_DIR=/opt/lunchlineup \
COMPOSE_SERVICE_ENV_FILE=/opt/lunchlineup-secrets/runtime.env \
IMAGE_PREFIX=ghcr.io/tuckerplee/lunchlineup \
IMAGE_TAG=<pushed-release-sha> \
bash scripts/pitr-verify-storage.sh
```

Require one `pitr_object_store_ready` line for each writer and final `pitr_storage_readiness_ok`. The preflight uploads immutable canaries and must fail if either writer can delete, bucket versioning is not enabled, default retention is not COMPLIANCE for the configured duration, or per-object retention is absent. Do not proceed after any failure.

Archive expiry belongs only to a separately managed object-store lifecycle policy/identity. Never place lifecycle/delete credentials in this repository, runtime env, or any Postgres, backup, restore, API, worker, or migration container. Application-side recursive archive deletion is prohibited.

## Verify The Archive

Check PostgreSQL archiver health before an incident and after every deployment:

```sql
SELECT archived_count, failed_count, last_archived_wal, last_archived_time,
       last_failed_wal, last_failed_time
FROM pg_stat_archiver;
SELECT pg_switch_wal();
```

Run the daily service manually and require its proof plus remote commit marker:

```bash
systemctl start lunchlineup-pitr-base-backup.service
journalctl -u lunchlineup-pitr-base-backup.service -n 100 --no-pager
test -s /var/lib/node_exporter/textfile_collector/lunchlineup_pitr.prom
```

List `${PITR_S3_PREFIX}/basebackups/` using the managed object-store account. Select one explicit backup ID; do not use `latest`. Confirm that backup contains `base.tar.gz`, `backup_manifest`, and `COMPLETE`, and that WAL objects continue beyond the requested target. The backup job creates a plain-format `pg_basebackup`, verifies its manifest with `pg_verifybackup`, and only then packages it as `base.tar.gz` for encrypted upload.

## Materialize An Isolated Restore

The recovery profile writes only to `postgres_pitr_restore_data`. Recreate that disposable volume before each attempt, then pass the exact ID, target, and confirmation:

```bash
docker compose --profile recovery --env-file /opt/lunchlineup-secrets/runtime.env rm -sf pitr-restore
docker volume rm lunchlineup-production_postgres_pitr_restore_data 2>/dev/null || true
docker volume create lunchlineup-production_postgres_pitr_restore_data

PITR_BASE_BACKUP_ID=20260709T201700Z-1234 \
PITR_RECOVERY_TARGET_TIME=2026-07-09T21:14:00Z \
PITR_ARCHIVED_WAL_SEGMENT=00000001000000000000002A \
PITR_RESTORE_CONFIRM=restore-pitr-20260709T201700Z-1234 \
docker compose --profile recovery \
  --env-file /opt/lunchlineup-secrets/runtime.env \
  run --rm --no-deps --pull never pitr-restore
```

The command must print `pitr_restore_materialized`. Compose explicitly forwards `PITR_ARCHIVED_WAL_SEGMENT`; an omitted, blank, or malformed value fails before any download. The helper downloads only the named backup, validates that the remote `COMPLETE` marker names that backup and matches the manifest checksum, verifies the named archived WAL segment is remotely durable, extracts the packaged plain-format backup, runs `pg_verifybackup --no-parse-wal --exit-on-error` against the restored PGDATA, refuses non-empty/live PGDATA, and writes `recovery.signal`, source metadata, and a paused UTC recovery target.

## Start And Validate Recovery

Start a temporary Postgres container on loopback. Use the same pinned image, restore volume, PITR tool volume, scripts, endpoint configuration, and credential files as production. Keep archiving disabled in the validation instance so it cannot write a new timeline into the production archive prefix.

```bash
docker run --rm --name lunchlineup-pitr-validation \
  -p 127.0.0.1:55432:5432 \
  -e PITR_ENABLED=true \
  -e PITR_S3_ENDPOINT="$PITR_S3_ENDPOINT" \
  -e PITR_S3_BUCKET="$PITR_S3_BUCKET" \
  -e PITR_S3_PREFIX="$PITR_S3_PREFIX" \
  -e PITR_OBJECT_LOCK_RETENTION_DAYS="$PITR_OBJECT_LOCK_RETENTION_DAYS" \
  -e PITR_ACCESS_KEY_FILE=/run/secrets/pitr-restore-object-store/access_key \
  -e PITR_SECRET_KEY_FILE=/run/secrets/pitr-restore-object-store/secret_key \
  -v lunchlineup-production_postgres_pitr_restore_data:/var/lib/postgresql/data \
  -v lunchlineup-production_pitr_tools:/opt/lunchlineup/tools:ro \
  -v /opt/lunchlineup/infrastructure/postgres:/opt/lunchlineup/pitr:ro \
  -v "$PITR_RESTORE_OBJECT_STORE_SECRETS_DIR":/run/secrets/pitr-restore-object-store:ro \
  postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777 \
  postgres -c listen_addresses='*' -c archive_mode=off
```

In another shell, connect to `127.0.0.1:55432`. Require `pg_is_in_recovery() = true`, confirm `pg_last_xact_replay_timestamp()` reached the target, and run tenant, schedule, billing, webhook-outbox, and auto-schedule-outbox sanity queries. Capture row counts and incident-specific records. If the target is wrong, stop the container, remove only the restore volume, and repeat from a different base backup/target.

For launch proof, retain a JSON artifact as `evidence.pitrDrill`. It must bind the pushed release SHA and exact generating command; name the explicit `baseBackupId`, its `/basebackups/<id>/COMPLETE` URI and completion `sourceTimestamp`; name a 24-hex `archivedWalSegment` and its `/wal/<segment>` URI; record `recoveryTargetTime`, `restoreCompletedAt`, and `checkedAt`; set `baseBackupStatus: "COMPLETE"`, `restoreSucceeded`, `recoveryTargetReached`, and `recoveryPaused` to `true`; and include a non-empty `invariantChecks` array whose uniquely named checks all have `status: "passed"` and timestamps no later than `checkedAt`. Hash and retain those exact bytes before creating the outer launch proof.

## Alerts

- `PitrBaseBackupTelemetryMissing` and `PitrBaseBackupStale` mean the daily base-backup service has not published a recent remotely committed backup. Inspect the service journal, object-store `COMPLETE` marker, and `/var/lib/node_exporter/textfile_collector/lunchlineup_pitr.prom`.
- `PitrWalArchiveFailure` means the latest archive attempt failed after the last success. Check `pg_stat_archiver`, PostgreSQL logs, object-store credentials, and the exact failed segment before retrying with `SELECT pg_switch_wal();`.
- `PitrWalArchiveStale` means no remote WAL success has been recorded within five minutes. Check the archive command and `/var/lib/node_exporter/textfile_collector/lunchlineup_pitr_wal.prom`; do not silence it by writing metrics manually.

After acceptance, run `SELECT pg_wal_replay_resume();`, wait for `pg_is_in_recovery() = false`, and stop the validation container cleanly. This creates the recovered primary timeline in the isolated volume.

## Cut Over

1. Stop API, worker, webhook replay, and any other database writers.
2. Stop production Postgres without `down -v`; record the original volume name.
3. Create a reviewed Compose override mapping `lunchlineup-production_postgres_pitr_restore_data` to `/var/lib/postgresql/data` for the `postgres` service. Do not delete or reuse the original volume.
4. Start only Postgres, verify health and application invariants, then start migrations only if the deployed schema expects no forward changes.
5. If the incident also lost the RabbitMQ volume, keep API and workers stopped and run the Postgres-only queue rehydration below before starting them.
6. Start API and workers, run public/internal health checks, and monitor database errors, queue depth, webhook replay, and scheduler job state.
7. Force `SELECT pg_switch_wal();`, verify the new timeline history and WAL segment exist remotely, then run a new PITR base backup before declaring recovery complete.

### Rehydrate After RabbitMQ Volume Loss

Run this only when PostgreSQL was restored but RabbitMQ durable state was not. Keep every API, schedule worker, and webhook replay worker stopped while it runs:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f /opt/lunchlineup/scripts/rehydrate-durable-queues.sql
```

For an encrypted logical restore, the same action is built into the restore command:

```bash
RESTORE_REHYDRATE_DURABLE_QUEUES=true \
RESTORE_TARGET_ENV=production \
RESTORE_ALLOW_PRODUCTION=YES_RESTORE_PRODUCTION \
RESTORE_CONFIRM=restore-lunchlineup \
./scripts/restore.sh /explicit/path/lunchlineup-YYYYMMDDHHMMSS.sql.zst.gpg
```

The transaction resets only confirmed `PUBLISHED` schedule solve rows whose domain jobs are still `QUEUED`, `RUNNING`, or `RETRYING`, and confirmed `QUEUED` webhook rows. It preserves terminal schedule jobs plus delivered and dead-lettered webhooks. Start webhook replay and the API schedule outbox publisher after the SQL commits; their bounded leases and stable job/event identities make duplicate broker deliveries idempotent.

Retain the old volume according to incident policy. Roll back by stopping writers and switching the override back to the untouched original volume; never merge writes between timelines.
