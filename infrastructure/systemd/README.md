# Systemd Units

## Files

- `README.md`: this systemd scheduler installation guide.
- `lunchlineup-retained-record-review.service`: hardened seven-year retained-record candidate dry-run.
- `lunchlineup-retained-record-review.timer`: daily retained-record eligibility review timer.
- `lunchlineup-retention-purge.env.example`: shared endpoint, service-token, and application-data output environment for both retention schedules.
- `lunchlineup-retention-purge.service`: confirmed 30-day application-data purge unit.
- `lunchlineup-retention-purge.timer`: daily application-data retention timer.

## Host prerequisites

The units here write Prometheus textfile metrics to `/var/lib/node_exporter/textfile_collector/`, which the VM's own node_exporter (an estate service, not part of the application stack) serves to the estate Prometheus. Backups are not scheduled from this folder: Postgres PITR is the estate pgBackRest and file backups are host restic, both owned by estate-infra (`docs/estate/README.md`).

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
