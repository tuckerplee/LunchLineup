# Systemd Units

## Files

- `README.md`: this systemd scheduler installation guide.
- `lunchlineup-backup.env.example`: static Compose/runtime environment pointers for the backup scheduler.
- `lunchlineup-backup.service`: one-shot encrypted offsite database backup through the release Compose image.
- `lunchlineup-backup.timer`: daily backup timer with persistent catch-up and randomized delay.
- `lunchlineup-pitr-base-backup.env.example`: production Compose runtime pointer for the physical base-backup scheduler.
- `lunchlineup-pitr-base-backup.service`: hardened one-shot verified remote `pg_basebackup` invocation.
- `lunchlineup-pitr-base-backup.timer`: daily physical base-backup schedule with persistent catch-up.
- `lunchlineup-public-web-probe.env.example`: canonical public URL, release pointer, request bounds, and textfile metric path.
- `lunchlineup-public-web-probe.service`: hardened one-shot public DNS/TLS/Caddy/Next.js probe.
- `lunchlineup-public-web-probe.timer`: one-minute public availability schedule.
- `lunchlineup-retention-purge.env.example`: example environment file for the retained-record expiry dry-run scheduler.
- `lunchlineup-retention-purge.service`: confirmed 30-day application-data purge unit.
- `lunchlineup-retention-purge.timer`: daily application-data retention timer.

## Backup Scheduler

Production deploy stops the existing timers, atomically stages the candidate backup image pointer, and runs `scripts/verify-backup-readiness.sh` before committed release truth advances. The verifier requires every non-optional systemd `EnvironmentFile`, installs and checks the tracked backup and PITR units with `systemd-analyze verify`, starts the actual logical and physical oneshot services, requires successful unit results, offsite markers, and fresh Prometheus textfile metrics, and only then enables both timers. Any failure restores the previous pointer and each timer's prior enabled/active state.

Install only after the production release images have been pulled from a GitHub-pushed commit. `deploy-vm217-remote.sh` verifies the immutable manifest contains `backup`, pulls it by digest, retags it with the deployed SHA, and atomically stages `/var/lib/lunchlineup/backup-release.env` for candidate proof, restores the prior file on failure, and finalizes it with the deployed SHA only after proof passes. The timer refuses to start without that release pointer and runs Compose with `--pull never`, so it cannot drift to a registry tag.

Required production state:

- `/opt/lunchlineup-secrets/runtime.env` contains the production `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, a supported non-root `BACKUP_OFFSITE_URI` (`s3://bucket/prefix` or `rclone:remote:path`), `BACKUP_ENCRYPTION_KEY_SECRET_FILE=/run/secrets/backup_key`, and `NODE_EXPORTER_TEXTFILE_DIR=/var/lib/node_exporter/textfile_collector`.
- `/etc/lunchlineup/backup.env` sets `BACKUP_OFFSITE_RETENTION_DAYS=35` and `BACKUP_OFFSITE_RETENTION_DRY_RUN=false`. Use `true` only for a reviewed candidate-listing rehearsal; leaving it enabled does not satisfy production retention.
- `/etc/lunchlineup/backup-offsite` is owned by `root:lunchlineup`, mode `0750`, and contains only the selected provider credential file: `aws-credentials` plus optional `aws-config` for S3, or `rclone.conf` for rclone. Credential files are mode `0640`. Set `BACKUP_OFFSITE_CREDENTIALS_DIR` to this directory; Compose mounts it read-only at `/run/secrets/backup-offsite`. Never put AWS keys, rclone passwords, or the owner/runtime env in the Compose environment.
- `/run/secrets/backup_key` contains a generated high-entropy GPG symmetric passphrase and is readable by the `lunchlineup` group. The passphrase must not be stored in an env file or the repository.
- The `lunchlineup` service account can access Docker. Treat Docker group membership as root-equivalent access and do not reuse this account for interactive users.
- S3 credentials are supplied through the managed runtime environment or an instance role. For rclone, provision its config outside the repository and expose it through the managed runtime configuration.
- `/var/lib/node_exporter/textfile_collector/` exists. The backup container writes `lunchlineup_backup.prom` there and Compose mounts the same host directory read-only into node-exporter.

Example installation after the first successful artifact deploy:

```bash
install -d -m 0750 /etc/lunchlineup
install -d -m 0750 /run/secrets
install -d -o lunchlineup -g lunchlineup -m 0750 /var/lib/lunchlineup
install -d -m 0755 /var/lib/node_exporter/textfile_collector
install -o root -g lunchlineup -m 0640 infrastructure/systemd/lunchlineup-backup.env.example /etc/lunchlineup/backup.env
install -o root -g lunchlineup -m 0640 /secure/source/backup_key /run/secrets/backup_key
install -m 0644 infrastructure/systemd/lunchlineup-backup.service /etc/systemd/system/lunchlineup-backup.service
install -m 0644 infrastructure/systemd/lunchlineup-backup.timer /etc/systemd/system/lunchlineup-backup.timer
test -s /var/lib/lunchlineup/backup-release.env
systemd-analyze verify /etc/systemd/system/lunchlineup-backup.service /etc/systemd/system/lunchlineup-backup.timer
systemctl daemon-reload
systemctl start lunchlineup-backup.service
journalctl -u lunchlineup-backup.service -n 50 --no-pager
test -s /var/lib/node_exporter/textfile_collector/lunchlineup_backup.prom
systemctl enable --now lunchlineup-backup.timer
systemctl list-timers lunchlineup-backup.timer
```

The service calls the one-shot `backup` Compose service under the `ops` profile with `--rm --no-deps --pull never`. Local encrypted archives and checksum sidecars retain the existing 35-day cleanup. After uploading both current objects, the same run lists only the configured non-root remote repository and prunes exact direct-child `${BACKUP_PREFIX}-YYYYMMDDHHMMSS.sql.zst.gpg` objects and sidecars older than `BACKUP_OFFSITE_RETENTION_DAYS`; it never issues recursive or bucket-wide deletion. Verify the journal contains `offsite_retention_ok mode=execute ...` and review the candidate lines. Any list or exact-object delete failure fails the run before success telemetry is written. Platform on-call owns `BackupMissingTelemetry` and `BackupStale`; either alert is a failed backup-path incident until the timer, offsite object, checksum sidecar, remote-retention proof, and textfile metric are verified.

## PITR Base Backup Scheduler

PITR supplements rather than replaces the encrypted logical dump. Its service also requires `/var/lib/lunchlineup/backup-release.env` so the proof executes the same deployed immutable image set rather than local defaults. Install the timer only after `scripts/pitr-verify-storage.sh` proves both append-only writer identities, versioning, default/per-object COMPLIANCE retention, and denied deletion. Provision distinct absolute managed directories for `PITR_WAL_OBJECT_STORE_SECRETS_DIR`, `PITR_BASE_BACKUP_OBJECT_STORE_SECRETS_DIR`, and read-only `PITR_RESTORE_OBJECT_STORE_SECRETS_DIR`; each contains only `access_key` and `secret_key`. Lifecycle deletion uses a separate object-store policy/identity outside Compose. Start the service once and verify `pitr_base_backup_ok`, the remote `COMPLETE` object, and `/var/lib/node_exporter/textfile_collector/lunchlineup_pitr.prom` before enabling the timer.

```bash
install -o root -g lunchlineup -m 0640 infrastructure/systemd/lunchlineup-pitr-base-backup.env.example /etc/lunchlineup/pitr-base-backup.env
install -m 0644 infrastructure/systemd/lunchlineup-pitr-base-backup.service /etc/systemd/system/lunchlineup-pitr-base-backup.service
install -m 0644 infrastructure/systemd/lunchlineup-pitr-base-backup.timer /etc/systemd/system/lunchlineup-pitr-base-backup.timer
systemd-analyze verify /etc/systemd/system/lunchlineup-pitr-base-backup.service /etc/systemd/system/lunchlineup-pitr-base-backup.timer
systemctl daemon-reload
systemctl start lunchlineup-pitr-base-backup.service
journalctl -u lunchlineup-pitr-base-backup.service -n 100 --no-pager
systemctl enable --now lunchlineup-pitr-base-backup.timer
```

## Public Web Availability Probe

Install the probe from the same clean, GitHub-pushed checkout used for production. It runs outside Compose so it exercises public DNS, TLS, Caddy, and the rendered Next.js page. The service has no secrets, accepts only a public HTTPS root URL, disables redirects, and bounds connect time, total time, and response bytes. It verifies the response release header against `/opt/lunchlineup/DEPLOYED_GIT_SHA` and writes metrics atomically to node-exporter's existing textfile collector.

Example installation:

```bash
install -d -m 0750 /etc/lunchlineup
install -d -o lunchlineup -g lunchlineup -m 0755 /var/lib/node_exporter/textfile_collector
install -o root -g lunchlineup -m 0640 infrastructure/systemd/lunchlineup-public-web-probe.env.example /etc/lunchlineup/public-web-probe.env
install -m 0644 infrastructure/systemd/lunchlineup-public-web-probe.service /etc/systemd/system/lunchlineup-public-web-probe.service
install -m 0644 infrastructure/systemd/lunchlineup-public-web-probe.timer /etc/systemd/system/lunchlineup-public-web-probe.timer
systemd-analyze verify /etc/systemd/system/lunchlineup-public-web-probe.service /etc/systemd/system/lunchlineup-public-web-probe.timer
systemctl daemon-reload
systemctl start lunchlineup-public-web-probe.service
journalctl -u lunchlineup-public-web-probe.service -n 50 --no-pager
test -s /var/lib/node_exporter/textfile_collector/lunchlineup_public_web.prom
systemctl enable --now lunchlineup-public-web-probe.timer
systemctl list-timers lunchlineup-public-web-probe.timer
```

Platform on-call owns `PublicWebUnavailable` and `PublicWebProbeStale`. Follow `docs/runbooks/public-web-unavailable.md`; do not write `DEPLOYED_GIT_SHA` manually to silence a release mismatch.

## Retained Record Scheduler

Install these files only from a clean, GitHub-pushed release checkout. `ExecStart` pins the 30-day `application_data` stage and its dedicated confirmation. The API rejects this service identity for the seven-year retained-record stage.

Required production state:

- `/etc/lunchlineup/retention-purge.env` exists, is root-readable, and points at the production retention endpoint.
- `/run/secrets/retention_purge_token` exists with a generated retained-record service token. The API container must mount the same secret at `RETENTION_PURGE_SERVICE_TOKEN_FILE=/run/secrets/retention_purge_token` through `RETENTION_PURGE_SERVICE_TOKEN_SECRET_FILE`; do not use a reusable platform-admin JWT for this scheduler.
- `/var/lib/lunchlineup/proofs/` is writable by the `lunchlineup` service user for the latest JSON proof.
- `/var/lib/node_exporter/textfile_collector/` is writable by the service user and mounted read-only into the Compose `node-exporter` service.

Example installation:

```bash
install -d -m 0750 /etc/lunchlineup
install -d -m 0750 /run/secrets
install -d -o lunchlineup -g lunchlineup -m 0750 /var/lib/lunchlineup/proofs
install -d -o lunchlineup -g lunchlineup -m 0755 /var/lib/node_exporter/textfile_collector
install -m 0640 infrastructure/systemd/lunchlineup-retention-purge.env.example /etc/lunchlineup/retention-purge.env
install -o root -g lunchlineup -m 0640 /secure/source/retention_purge_token /run/secrets/retention_purge_token
install -m 0644 infrastructure/systemd/lunchlineup-retention-purge.service /etc/systemd/system/lunchlineup-retention-purge.service
install -m 0644 infrastructure/systemd/lunchlineup-retention-purge.timer /etc/systemd/system/lunchlineup-retention-purge.timer
systemd-analyze verify /etc/systemd/system/lunchlineup-retention-purge.service /etc/systemd/system/lunchlineup-retention-purge.timer
systemctl daemon-reload
systemctl enable --now lunchlineup-retention-purge.timer
systemctl start lunchlineup-retention-purge.service
journalctl -u lunchlineup-retention-purge.service -n 50 --no-pager
test -s /var/lib/lunchlineup/proofs/retention-purge-latest.json
test -s /var/lib/node_exporter/textfile_collector/lunchlineup_retention_purge.prom
```

The installed service runs `/usr/bin/env RETENTION_PURGE_STAGE=application_data RETENTION_PURGE_DRY_RUN=false RETENTION_PURGE_EXECUTE_CONFIRM=purge-expired-application-data /usr/bin/node /opt/lunchlineup/scripts/invoke-retained-record-purge.mjs`. Final retained-record deletion is never scheduled; follow `docs/runbooks/data-retention-delete-export.md` for its reviewed manual execution.

## Monitoring and Alert Ownership

Platform on-call owns `RetentionPurgeTelemetryMissing`, `RetentionPurgeStale`, `RetentionPurgeFailed`, and `RetentionPurgeCandidatesReady`. Treat missing, stale, or failed telemetry as scheduler deployment or runtime breakage. Treat candidate-ready alerts as reviewed data-retention tickets with the dry-run proof attached; do not execute a purge from the timer.
