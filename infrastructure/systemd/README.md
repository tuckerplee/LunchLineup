# Systemd Units

## Files

- `README.md`: this systemd scheduler installation guide.
- `lunchlineup-backup.env.example`: static non-secret backup scheduler settings; deploy writes the exact runtime pointer separately.
- `lunchlineup-backup.service`: one-shot encrypted offsite database backup through the release Compose image.
- `lunchlineup-backup.timer`: daily backup timer with persistent catch-up and randomized delay.
- `lunchlineup-pitr-base-backup.env.example`: static non-secret physical base-backup scheduler settings.
- `lunchlineup-pitr-base-backup.service`: hardened one-shot verified remote `pg_basebackup` invocation.
- `lunchlineup-pitr-base-backup.timer`: daily physical base-backup schedule with persistent catch-up.
- `lunchlineup-public-web-probe.env.example`: canonical public URL, release pointer, request bounds, and textfile metric path.
- `lunchlineup-public-web-probe.service`: hardened one-shot public DNS/TLS/Caddy/Next.js probe.
- `lunchlineup-public-web-probe.timer`: one-minute public availability schedule.
- `lunchlineup-retained-record-review.service`: hardened seven-year retained-record candidate dry-run.
- `lunchlineup-retained-record-review.timer`: daily retained-record eligibility review timer.
- `lunchlineup-retention-purge.env.example`: shared endpoint, service-token, and application-data output environment for both retention schedules.
- `lunchlineup-retention-purge.service`: confirmed 30-day application-data purge unit.
- `lunchlineup-retention-purge.timer`: daily application-data retention timer.

## Backup Scheduler

Production deploy atomically persists validated runtime bytes at `/var/lib/lunchlineup/runtime-env/by-release/<source-sha>/<sha256>/runtime.env` as `root:root` mode `0600`. Compose uses that exact file. The deploy stops existing timers and writes the same path and digest with the candidate image identity to `/var/lib/lunchlineup/backup-release.env`, so backup and PITR proof consume identical bytes. Every production deploy, rollback, backup, and PITR command uses the fixed Compose project `lunchlineup`; the release SHA selects the exact retained project directory, Compose file, runtime bytes, and images but never changes named-volume identity. Each service derives `/opt/lunchlineup/releases/<IMAGE_TAG>` instead of `/opt/lunchlineup/current`, passes its full canonical `lunchlineup-*.service` identifier to the wrapper stored in that candidate, captures the new systemd `INVOCATION_ID`, renders the mapped Compose service image, resolves its local `sha256:` digest, and exports the InvocationID/path/source/image binding into the one-shot container. The transport passes that exact retained directory as `APP_DIR`; readiness never appends another `releases/<sha>`. It then runs `scripts/verify-backup-readiness.sh` before committed release truth advances. The verifier allows the service-side 2-hour logical-backup and 6-hour PITR limits with client deadlines of 7,260 and 21,660 seconds, and validates each service's atomically replaced metric immediately at that service's completion against its own start time. On client timeout it must reconcile the exact InvocationID, terminal service state, and immutable candidate container ID, remove that ID, and prove absence before restoring the byte-for-byte unit and enabled/active snapshots. A restoration, cleanup, or readback failure is terminal.

Install only after the production release images have been pulled from a GitHub-pushed commit. Successful promotion atomically advances `/var/lib/lunchlineup/runtime-env/current`; retained rollback reactivates the prior SHA/digest path. Missing files, digest drift, non-root ownership, or mode drift fail closed. Runtime bytes remain outside repository and immutable release artifacts. The timers require the generated backup release file and run Compose with `--pull never`.

Required production state:

- The validated candidate runtime contains an exact non-root `BACKUP_OFFSITE_URI=s3://bucket/prefix`, `BACKUP_OFFSITE_RETENTION_DAYS=35`, `BACKUP_OFFSITE_RETENTION_DRY_RUN=false`, and `BACKUP_OFFSITE_LIFECYCLE_MAX_DAYS` covering retention. Mutable rclone and local repositories are forbidden.
- `/etc/lunchlineup/backup-offsite` is owned by `root:lunchlineup`, mode `0750`, and contains mode-`0640` `aws-credentials` plus optional `aws-config`, or the job uses a dedicated instance role. Never put provider keys in the runtime/Compose environment.
- `/run/secrets/backup_key` contains a generated high-entropy GPG symmetric passphrase and is readable by the `lunchlineup` group. The passphrase must not be stored in an env file or the repository.
- The `lunchlineup` service account can access Docker. Treat Docker group membership as root-equivalent access and do not reuse this account for interactive users.
- S3 credentials are supplied through the dedicated read-only credential mount or an instance role.
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

The candidate wrapper calls the one-shot `backup` Compose service under the `ops` profile with `--detach --no-deps --pull never`, owns the exact returned container ID through bounded wait/log/remove/absence readback, and emits `candidate_release_job_ok` binding the fresh InvocationID, candidate path, source SHA, rendered image reference, and resolved image digest. Local encrypted archives retain bounded cleanup. Remote expiry belongs only to the verified bucket lifecycle: the job never lists for pruning or deletes remote objects. It conditionally creates the encrypted dump and checksum, requests COMPLIANCE retention, and requires exact version/checksum/bytes/retention readback plus authenticated caller identity. Verify fresh matching `offsite_retention_ok mode=lifecycle_owned`, `offsite_immutable_ok`, and `backup_ok expiry_owner=lifecycle` lines. `verify-backup-readiness.sh` rejects stale, unversioned, unauthenticated, or mismatched proof before enabling timers. Platform on-call owns `BackupMissingTelemetry` and `BackupStale`; either alert is a failed backup-path incident until provider proof and textfile freshness are restored.

## PITR Base Backup Scheduler

PITR supplements rather than replaces the encrypted logical dump. Its service also requires `/var/lib/lunchlineup/backup-release.env` so pre-promotion proof executes `/opt/lunchlineup/releases/<candidate-sha>`, not the old `/current` target. Install the timer only after `scripts/pitr-verify-storage.sh` proves both append-only writer identities, versioning, default/per-object COMPLIANCE retention, denied deletion, and provider-simulated denied mutations for both read-only identities. Provision distinct absolute managed directories for `PITR_WAL_OBJECT_STORE_SECRETS_DIR`, `PITR_BASE_BACKUP_OBJECT_STORE_SECRETS_DIR`, read-only `PITR_RESTORE_OBJECT_STORE_SECRETS_DIR`, and lifecycle-audit credentials. Start the service once and verify `candidate_release_job_ok`, `pitr_candidate_binding_ok`, `pitr_base_backup_ok`, the remote `COMPLETE` object, and `/var/lib/node_exporter/textfile_collector/lunchlineup_pitr.prom` before enabling the timer.

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

Install the probe from the same clean, GitHub-pushed checkout used for production. The unit executes `/opt/lunchlineup/current/infrastructure/control/public-web-probe.sh` outside Compose so it follows the active retained release while exercising public DNS, TLS, Caddy, and the rendered Next.js page. The service has no secrets, accepts only a public HTTPS root URL, disables redirects, and bounds connect time, total time, and response bytes. It verifies the response release header against the canonical `/opt/lunchlineup/current/DEPLOYED_GIT_SHA` marker and writes metrics atomically to node-exporter's existing textfile collector. Because both the script and marker resolve through the same atomic `current` pointer, rollback cannot leave the probe pinned to a stale root-level marker.

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

## Retention Schedulers

Install these files only from a clean, GitHub-pushed release checkout. The two schedules have separate responsibilities:

- `lunchlineup-retention-purge.service` executes only the confirmed 30-day `application_data` stage.
- `lunchlineup-retained-record-review.service` runs only a seven-year `retained_records` dry-run. The API rejects final retained-record execution by this service identity.

Required production state:

- `/etc/lunchlineup/retention-purge.env` exists, is root-readable, and points at the production retention endpoint.
- `/run/secrets/retention_purge_token` contains the generated service token. The API container mounts the same secret at `RETENTION_PURGE_SERVICE_TOKEN_FILE=/run/secrets/retention_purge_token` through `RETENTION_PURGE_SERVICE_TOKEN_SECRET_FILE`; do not use a reusable platform-admin JWT.
- `/var/lib/lunchlineup/proofs/` is writable by the `lunchlineup` service user.
- `/var/lib/node_exporter/textfile_collector/` is writable by the service user and mounted read-only into Compose `node-exporter`.

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
install -m 0644 infrastructure/systemd/lunchlineup-retained-record-review.service /etc/systemd/system/lunchlineup-retained-record-review.service
install -m 0644 infrastructure/systemd/lunchlineup-retained-record-review.timer /etc/systemd/system/lunchlineup-retained-record-review.timer
systemd-analyze verify /etc/systemd/system/lunchlineup-retention-purge.service /etc/systemd/system/lunchlineup-retention-purge.timer /etc/systemd/system/lunchlineup-retained-record-review.service /etc/systemd/system/lunchlineup-retained-record-review.timer
systemctl daemon-reload
systemctl enable --now lunchlineup-retention-purge.timer lunchlineup-retained-record-review.timer
systemctl start lunchlineup-retention-purge.service lunchlineup-retained-record-review.service
journalctl -u lunchlineup-retention-purge.service -u lunchlineup-retained-record-review.service -n 100 --no-pager
test -s /var/lib/lunchlineup/proofs/retention-purge-latest.json
test -s /var/lib/lunchlineup/proofs/retained-record-review-latest.json
test -s /var/lib/node_exporter/textfile_collector/lunchlineup_retention_purge.prom
test -s /var/lib/node_exporter/textfile_collector/lunchlineup_retained_record_review.prom
```

The application-data unit runs `/usr/bin/env RETENTION_PURGE_STAGE=application_data RETENTION_PURGE_DRY_RUN=false RETENTION_PURGE_EXECUTE_CONFIRM=purge-expired-application-data /usr/bin/node /opt/lunchlineup/current/scripts/invoke-retained-record-purge.mjs`. The review unit runs `/usr/bin/env RETENTION_PURGE_STAGE=retained_records RETENTION_PURGE_DRY_RUN=true RETENTION_PURGE_PROOF_FILE=/var/lib/lunchlineup/proofs/retained-record-review-latest.json RETENTION_PURGE_METRICS_FILE=/var/lib/node_exporter/textfile_collector/lunchlineup_retained_record_review.prom RETENTION_PURGE_LOCK_FILE=/run/lunchlineup/retained-record-review.lock /usr/bin/node /opt/lunchlineup/current/scripts/invoke-retained-record-purge.mjs`. Final retained-record deletion remains a reviewed platform-admin action after external backup and security-log expiry checks.
## Monitoring and Alert Ownership

Platform on-call owns `ApplicationDataRetentionExecutionTelemetryMissing`, `ApplicationDataRetentionExecutionStale`, `RetentionPurgeTelemetryMissing`, `RetentionPurgeStale`, `RetentionPurgeFailed`, and `RetentionPurgeCandidatesReady`. The first pair requires `mode="execute",stage="application_data"`, so dry-run proof cannot satisfy automatic purge monitoring; treat missing or older-than-26-hour execution telemetry as scheduler deployment or runtime breakage. Treat candidate-ready alerts as reviewed data-retention tickets with the dry-run proof attached; do not execute a retained-record purge from the timer.
