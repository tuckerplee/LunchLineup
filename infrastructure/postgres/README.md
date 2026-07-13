# PostgreSQL PITR

## Files

- `README.md`: this Postgres runtime and PITR configuration guide.
- `archive-wal.sh`: fail-closed `archive_command` target that accepts only exact 24-hex WAL segments, 8-hex `.history` files, or PostgreSQL `<segment>.<offset>.backup` names and returns success only after an encrypted remote object is durable or verified byte-identical.
- `pg_hba.conf.template`: generated client-authentication template.
- `pitr-object-store.sh`: shared exact PostgreSQL archive-name classifier plus secret-file, endpoint, prefix, MinIO client, and COMPLIANCE-retained encrypted-upload helpers.
- `pitr-verify-object-store.sh`: fail-closed writer preflight for bucket versioning, default COMPLIANCE retention, per-object retention, and denied deletion.
- `postgresql.conf`: checked-in Compose Postgres runtime configuration with native WAL archiving.
- `postgresql.conf.template`: generated Postgres tuning template with matching PITR controls.
- `restore-wal.sh`: `restore_command` target that applies the same exact-name contract and retrieves WAL segments, timeline history, or backup-history metadata from the off-host archive.

## Contract

Production sets `PITR_ENABLED=true`, a unique cluster-specific `PITR_S3_PREFIX`, an HTTPS endpoint/bucket, and `PITR_OBJECT_LOCK_RETENTION_DAYS` of at least 14. The bucket must have versioning enabled and default COMPLIANCE Object Lock for that exact duration. Every upload also requests COMPLIANCE retention explicitly.

Postgres mounts only `PITR_WAL_OBJECT_STORE_SECRETS_DIR`; the daily base-backup job mounts only `PITR_BASE_BACKUP_OBJECT_STORE_SECRETS_DIR`; recovery mounts only `PITR_RESTORE_OBJECT_STORE_SECRETS_DIR`. WAL and base-backup identities may put, stat, read for idempotency verification, inspect bucket version/retention configuration, and inspect object retention, but must be denied every object/version delete action. The restore identity is read-only. No application or data container receives lifecycle credentials.

`scripts/pitr-verify-storage.sh` actively uploads one immutable canary with each writer identity and requires the delete attempt to fail while the object remains readable. Production deploy runs this before its mutation marker, and backup readiness repeats it before enabling timers. `archive_command` only returns success after encrypted remote durability proof; PostgreSQL therefore retains/retries a segment when off-host storage is unavailable.

Archive expiry belongs to a separately managed bucket lifecycle policy and identity outside this Compose stack. That identity must never be mounted in Postgres, backup, restore, API, worker, or migration containers. Logical encrypted dumps remain a separate recovery path and are not replaced by PITR.
