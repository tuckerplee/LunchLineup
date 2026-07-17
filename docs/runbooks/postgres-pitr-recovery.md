# PostgreSQL Point-In-Time Recovery

Use this runbook to restore production to a UTC timestamp using a verified physical base backup plus the off-host WAL archive. Keep the encrypted logical dump path in `scripts/restore.sh`; it remains the independent fallback.

Accepted availability PDF work is covered by PostgreSQL backup/PITR because the validated bytes are committed as a bounded AES-256-GCM envelope in the job transaction before `202`; local upload storage is not authoritative. The encryption key is deliberately external to PostgreSQL: retain the dedicated current `AVAILABILITY_IMPORT_ENCRYPTION_KEY` in the managed secret system for the full PITR window and provide the same exact 32-byte key only to restored API/worker services. Never place it in restore evidence, SQL dumps, logs, or the database.

## Preconditions

- Stop application writes before final cutover. Never run recovery against the live `postgres_data` volume.
- Record the incident timestamp in UTC and choose a completed base backup whose completion precedes that timestamp.
- Confirm `PITR_ENABLED=true`, `PITR_ARCHIVE_MODE=on`, the exact HTTPS endpoint/bucket/cluster prefix, and `PITR_OBJECT_LOCK_RETENTION_DAYS` of at least 14. Non-PITR renders must remain `archive_mode=off`; an invoked archive command with disabled PITR is a failure, never a successful no-op.
- Confirm `PITR_LIFECYCLE_MAX_RETENTION_DAYS` is greater than immutable retention and no more than 90.
- Confirm the runtime names four distinct absolute managed directories: `PITR_WAL_OBJECT_STORE_SECRETS_DIR`, `PITR_BASE_BACKUP_OBJECT_STORE_SECRETS_DIR`, `PITR_RESTORE_OBJECT_STORE_SECRETS_DIR`, and `PITR_LIFECYCLE_AUDIT_OBJECT_STORE_SECRETS_DIR`.
- Confirm `PITR_LIFECYCLE_POLICY_PROOF_FILE` is an absolute readable host file and its canonical SHA-256 equals `PITR_LIFECYCLE_POLICY_SHA256`; `PITR_LIFECYCLE_POLICY_PROOF_URI` must identify the same immutable retained JSON bytes.
- Confirm `PITR_AUTHORIZATION_SIMULATOR_FILE` is the protected executable provider adapter, its exact bytes match `PITR_AUTHORIZATION_SIMULATOR_SHA256`, and `PITR_AUTHORIZATION_SIMULATOR_TIMEOUT_SECONDS` is from 1 through 300.
- Keep the original `postgres_data` volume and container stopped but intact until recovery is accepted.
- Recovery targets must be after the selected base backup ended and inside the object-store lifecycle window.
- Confirm the restored API and worker receive the original dedicated `AVAILABILITY_IMPORT_ENCRYPTION_KEY`; a different or missing key makes accepted nonterminal envelopes retryable but unreadable.

For the encrypted logical-backup DR drill, provision two distinct trusted executables: `DR_OFFHOST_FETCH_COMMAND` retrieves only the requested immutable object bytes, while `DR_OFFHOST_READBACK_COMMAND` independently uses a provider-authenticated API to resolve the requested version and report its checksum, byte count, principal, request ID, and observation time. They must be different non-symlink executable files that are not group- or world-writable. Before Cosign or either execution, the drill opens the attestation, signature bundle, and both adapters with no-follow stable-identity checks and copies each once into its private mode-0700 evidence directory; signature verification, parsing, hashing, and execution consume only those snapshots. Provider output is likewise copied once into a private mode-0600 stable snapshot before parsing, hashing, or proof normalization. The fetch adapter may not create the readback proof. A self-attested version from the fetch path, a different resolved version/checksum/size, missing provider identity, stale observation, or failed authentication blocks before Docker starts.

Retained DR and PITR launch evidence must also include a fixed-workflow-signed recovery-execution attestation. Its canonical binding covers the exact release/run, immutable source objects and authenticated provider readback, isolated target identity plus queried PostgreSQL system identifier, and successful restore/invariant outcome. The verifier recomputes that binding before Cosign verification, so rewriting the artifact and its nested hash into a forged self-consistent success is rejected.

Every DR operation is finite. Defaults are 300 seconds for fetch, 120 for provider readback, 60 for each Docker operation, 300 each for decrypt/zstd/psql, 30 for cleanup, and 600 for the complete restore pipeline. Every override named below must be positive and no greater than 600; 601 is rejected. This applies to `DR_OFFHOST_FETCH_TIMEOUT_SECONDS`, `DR_OFFHOST_READBACK_TIMEOUT_SECONDS`, `DR_DOCKER_OPERATION_TIMEOUT_SECONDS`, `DR_DECRYPT_TIMEOUT_SECONDS`, `DR_ZSTD_TIMEOUT_SECONDS`, `DR_PSQL_TIMEOUT_SECONDS`, `DR_CLEANUP_TIMEOUT_SECONDS`, and `DR_RESTORE_PIPELINE_TIMEOUT_SECONDS`. The pipeline deadline starts before Docker container creation and owns readiness, restore, sanity, exact-ID cleanup, proof publication, and proof readback. Docker receives the database password only from the drill's private mode-0600 env file. Cleanup targets the captured full container ID and requires exact ID plus reserved-name absence; rename/replacement is a failed drill. A timeout is unknown state; retain the source/provider evidence and inspect the disposable destination before retrying.

## Credential And Retention Policy

Provision four least-privilege identities. The WAL and base-backup writers may create immutable objects, stat/read existing objects for idempotency, inspect bucket versioning/default retention, and inspect object retention. Explicitly deny `DeleteObject`, `DeleteObjectVersion`, retention bypass/clear, lifecycle mutation, and bucket deletion. The restore identity may list/read only the dedicated cluster prefix and inspect retention metadata. It cannot write or delete. The lifecycle-audit identity may only read bucket lifecycle, versioning, and Object Lock configuration; explicitly deny object writes/deletes plus lifecycle, retention, policy, and bucket mutation. The lifecycle administrator remains a separate external infrastructure identity and is never supplied to this repository or any container. The pinned simulator must authenticate separately with restore and lifecycle-audit credentials, call the provider authorization API without issuing mutations, echo the request digest/scope and authenticated provider principal/request ID, and return exact decisions for every required read and prohibited mutation. Missing, stale, implicit, or allowed mutation decisions block readiness.

Each PITR helper reads its access and secret keys from the mounted files into a private mode-`0600` temporary `mc` config. Provider commands receive only `--config-dir <private-path>`; neither credential may appear in process argv. Every call remains TERM-then-KILL bounded, and the temporary config is removed by the caller trap.

Enable bucket versioning and default COMPLIANCE Object Lock for exactly `PITR_OBJECT_LOCK_RETENTION_DAYS`. Every writer upload also requests COMPLIANCE retention. Configure enabled, untagged lifecycle rules scoped exactly to `$PITR_S3_PREFIX/` that:

- expire current versions no earlier than the immutable retention period;
- expire every noncurrent version without preserving a fixed number indefinitely;
- remove expired delete markers; and
- keep current-expiration days plus noncurrent-expiration days at or below `PITR_LIFECYCLE_MAX_RETENTION_DAYS`.

Export the live lifecycle configuration with the lifecycle-audit identity. Validate it and create a new canonical proof file without overwriting an existing artifact:

```bash
PITR_MC_BIN=/opt/lunchlineup/tools/mc \
PITR_ACCESS_KEY_FILE="$PITR_LIFECYCLE_AUDIT_OBJECT_STORE_SECRETS_DIR/access_key" \
PITR_SECRET_KEY_FILE="$PITR_LIFECYCLE_AUDIT_OBJECT_STORE_SECRETS_DIR/secret_key" \
sh infrastructure/postgres/pitr-export-lifecycle-policy.sh \
  >/secure/live-pitr-lifecycle-export.json
node scripts/verify-pitr-lifecycle-policy.mjs \
  --policy-file /secure/live-pitr-lifecycle-export.json \
  --endpoint "$PITR_S3_ENDPOINT" \
  --bucket "$PITR_S3_BUCKET" \
  --prefix "$PITR_S3_PREFIX" \
  --immutable-days "$PITR_OBJECT_LOCK_RETENTION_DAYS" \
  --maximum-days "$PITR_LIFECYCLE_MAX_RETENTION_DAYS" \
  --canonical-output /etc/lunchlineup/pitr-lifecycle-policy-20260714.json
```

Retain those exact canonical JSON bytes at the immutable `PITR_LIFECYCLE_POLICY_PROOF_URI`, copy the emitted `policy_sha256` into `PITR_LIFECYCLE_POLICY_SHA256`, and point `PITR_LIFECYCLE_POLICY_PROOF_FILE` at the protected host copy. Before launch and before every production deploy, run:

```bash
APP_DIR=/opt/lunchlineup \
COMPOSE_SERVICE_ENV_FILE=/opt/lunchlineup-secrets/runtime.env \
IMAGE_PREFIX=ghcr.io/tuckerplee/lunchlineup \
IMAGE_TAG=<pushed-release-sha> \
bash scripts/pitr-verify-storage.sh
```

Require one `pitr_object_store_ready` line for each writer, `pitr_authorization_simulation_ready role=restore`, `pitr_authorization_simulation_ready role=lifecycle-audit`, one `pitr_lifecycle_policy_ready` line, and final `pitr_storage_readiness_ok`. The preflight uploads immutable canaries, proves provider-side denied mutations for both read-only identities without attempting production writes/deletes/policy changes, exports the live lifecycle policy through the lifecycle-audit identity, and compares its canonical scope/rules/digest with the retained proof. It fails on overprivileged credentials, any successful writer delete, missing versioning, Object Lock mismatch, early current expiry, retained noncurrent versions, missing delete-marker cleanup, lifecycle drift, proof drift, or maximum-retention breach.

Archive expiry belongs only to the separately managed object-store lifecycle administrator. Never place lifecycle-administrator or delete credentials in this repository, runtime env, or any Postgres, backup, restore, API, worker, migration, or one-shot audit container. Application-side recursive archive deletion is prohibited. Retain the provider IAM policy/role attachment and bucket lifecycle change record outside this repository; the preflight safely proves live read access and policy semantics but does not attempt destructive IAM or lifecycle mutations.

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

Deployment readiness does not trust a mutable image tag after inspection. Systemd passes the canonical `lunchlineup-backup.service` or `lunchlineup-pitr-base-backup.service` identifier to the candidate wrapper; only the wrapper maps that identifier to its Compose service. The wrapper renders Compose once, resolves the selected image to its immutable local digest, executes only the private digest-rewritten render, and journals `candidate_release_job_ok` with the full unit identifier. Require the exact unit, systemd InvocationID, `/opt/lunchlineup/releases/<source-sha>` path, source SHA, and executed digest in both the journal binding and final `backup_readiness_ok` proof. Readiness captures the old metric identity before each one-shot and validates that job's newly published completion timestamp immediately after it completes, so a six-hour PITR cannot make the already-proven logical-backup timestamp fail a 300-second freshness window and stale pre-run evidence cannot pass.

List `${PITR_S3_PREFIX}/basebackups/` with `mc --json ls --versions`. Select one explicit backup ID and record the single non-null version ID for `COMPLETE`, `base.tar.gz`, `backup_manifest`, and the named WAL. Any missing, multiple, delete-marker, `null`, `latest`, or changed current version blocks restore. Provider stat authorization/transport errors are unknown state, never absence.

## Materialize An Isolated Restore

The recovery profile writes only to `postgres_pitr_restore_data`. Recreate that disposable volume before each attempt, then pass the exact ID, target, and confirmation:

```bash
docker compose --profile recovery --env-file /opt/lunchlineup-secrets/runtime.env rm -sf pitr-restore
docker volume rm lunchlineup_postgres_pitr_restore_data 2>/dev/null || true
docker volume create lunchlineup_postgres_pitr_restore_data

PITR_BASE_BACKUP_ID=20260709T201700Z-1234 \
PITR_RECOVERY_TARGET_TIME=2026-07-09T21:14:00Z \
PITR_ARCHIVED_WAL_SEGMENT=00000001000000000000002A \
PITR_BASE_BACKUP_COMPLETE_VERSION_ID=<exact-complete-version> \
PITR_BASE_BACKUP_ARCHIVE_VERSION_ID=<exact-base-archive-version> \
PITR_BASE_BACKUP_MANIFEST_VERSION_ID=<exact-manifest-version> \
PITR_ARCHIVED_WAL_VERSION_ID=<exact-wal-version> \
PITR_RESTORE_CONFIRM=restore-pitr-20260709T201700Z-1234 \
docker compose --profile recovery \
  --env-file /opt/lunchlineup-secrets/runtime.env \
  run --rm --no-deps --pull never pitr-restore
```

The recovery Compose service forwards all four variables unchanged. The command must print `pitr_restore_materialized` with those exact versions. Each download uses provider `--version-id`; the helper also requires each supplied version to be the sole current immutable version, preventing stale/old-version substitution. It then validates the commit marker/manifest, verifies PGDATA, and writes paused recovery configuration plus version-bound source metadata.

## Start And Validate Recovery

Extract the provider client from the exact deployed backup image into a private temporary directory. The backup image reference must include its immutable registry digest. Remove the temporary extraction container before starting validation.

```bash
case "$PITR_VALIDATION_BACKUP_IMAGE" in
  *@sha256:[a-f0-9][a-f0-9]*) ;;
  *) echo "PITR_VALIDATION_BACKUP_IMAGE must be the exact deployed backup image digest." >&2; exit 1 ;;
esac
PITR_VALIDATION_TOOL_DIR="$(mktemp -d)"
PITR_VALIDATION_TOOL_CONTAINER="lunchlineup-pitr-tool-$$_$(date +%s)"
timeout 30s docker create --name "$PITR_VALIDATION_TOOL_CONTAINER" "$PITR_VALIDATION_BACKUP_IMAGE" >/dev/null
timeout 30s docker cp "$PITR_VALIDATION_TOOL_CONTAINER:/opt/lunchlineup/tools/mc" "$PITR_VALIDATION_TOOL_DIR/mc"
timeout 30s docker rm -f "$PITR_VALIDATION_TOOL_CONTAINER" >/dev/null
chmod 0700 "$PITR_VALIDATION_TOOL_DIR/mc"
```

Start a temporary Postgres container on loopback. Use the same pinned Postgres image, restore volume, extracted provider client, scripts, endpoint configuration, and credential files as production. Keep archiving disabled in the validation instance so it cannot write a new timeline into the production archive prefix.

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
  -v lunchlineup_postgres_pitr_restore_data:/var/lib/postgresql/data \
  -v "$PITR_VALIDATION_TOOL_DIR":/opt/lunchlineup/tools:ro \
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
3. Create a reviewed Compose override mapping `lunchlineup_postgres_pitr_restore_data` to `/var/lib/postgresql/data` for the `postgres` service. Do not delete or reuse the original volume.
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

For production logical restore, every target descriptor/pin, provider provenance, adapter attestation, and execution attestation/signature path is opened once into a private mode-0600 snapshot; hashes, JSON parsing, Cosign, and restore policy consume only those exact bytes. The signed `system_identifier` is queried during preflight and reasserted as the first SQL statement on the exact `psql --single-transaction` connection before `DROP SCHEMA` or backup import. An endpoint switch therefore aborts the transaction before mutation. `MIGRATION_DATABASE_URL`, including its password, is supplied to the descriptor validator through its protected child environment and must never appear in child argv or retained process evidence.

The destructive transaction, optional queue rehydration, restricted-role provisioning, role access proof, and final table readback share the absolute `RESTORE_MUTATION_TIMEOUT_SECONDS` budget. Exhaustion exits `70`, terminates the bounded process group, and performs only bounded production target-identity/table reconciliation under `RESTORE_RECONCILIATION_TIMEOUT_SECONDS`; do not retry without inspecting that readback.

The transaction resets only confirmed `PUBLISHED` schedule solve rows whose domain jobs are still `QUEUED`, `RUNNING`, or `RETRYING`, and confirmed `QUEUED` webhook rows. It preserves terminal schedule jobs plus delivered and dead-lettered webhooks. Start webhook replay and the API schedule outbox publisher after the SQL commits; their bounded leases and stable job/event identities make duplicate broker deliveries idempotent.

Retain the old volume according to incident policy. Roll back by stopping writers and switching the override back to the untouched original volume; never merge writes between timelines.
