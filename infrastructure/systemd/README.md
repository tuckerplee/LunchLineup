# Systemd Units

## Files

- `README.md`: this systemd scheduler installation guide.
- `install-retention-scheduler.sh`: installs and verifies the four units on the VM without enabling them.
- `run-retention-scheduler.sh`: builds the Compose invocation and runs the one-shot `retention-scheduler` container.
- `lunchlineup-retained-record-review.service`: hardened seven-year retained-record candidate dry-run (container).
- `lunchlineup-retained-record-review.timer`: daily retained-record eligibility review timer.
- `lunchlineup-retention-purge.env.example`: optional runtime.env overrides (token source, uid/gid, bind directories) for both retention schedules.
- `lunchlineup-retention-purge.service`: confirmed 30-day application-data purge unit (container).
- `lunchlineup-retention-purge.timer`: daily application-data retention timer.

## Host prerequisites

The units write Prometheus textfile metrics to `/var/lib/node_exporter/textfile_collector/`, which the VM's own node_exporter (an estate service, not part of the application stack) serves to the estate Prometheus. Backups are not scheduled from this folder: Postgres PITR is the estate pgBackRest and file backups are host restic, both owned by estate-infra (`docs/estate/README.md`).

The VM has no host Node.js and no `lunchlineup` user, by design. The jobs run `scripts/invoke-retained-record-purge.mjs` in a one-shot container from the already-deployed `migrate` image (`${IMAGE_PREFIX}/migrate:${IMAGE_TAG}`, which already carries Node and the repo `scripts/` tree; no Dockerfile change and no image rebuild). Nothing is built on the VM.

## Retention Schedulers

Install these files only from a clean, GitHub-pushed release checkout at `/opt/lunchlineup`. The two schedules have separate responsibilities:

- `lunchlineup-retention-purge.service` executes only the confirmed 30-day `application_data` stage.
- `lunchlineup-retained-record-review.service` runs only a seven-year `retained_records` dry-run. The API rejects final retained-record execution by this service identity.

Each unit is `Type=oneshot`, `User=root` (for the Docker socket), and takes `/run/lock/lunchlineup-deploy.lock` with `flock -w 600` so it never overlaps a deploy or runtime maintenance. It runs `infrastructure/systemd/run-retention-scheduler.sh`, which executes:

```bash
COMPOSE_SERVICE_ENV_FILE=/opt/lunchlineup-secrets/runtime.env docker compose --project-name lunchlineup --project-directory /opt/lunchlineup --env-file /opt/lunchlineup-secrets/runtime.env -f docker-compose.yml -f infrastructure/development-admission/compose.private-proxy.yml [-f infrastructure/postgres/compose.pgbackrest.yml] run --rm --no-deps -T -e RETENTION_PURGE_STAGE=... -e RETENTION_PURGE_DRY_RUN=... [-e RETENTION_PURGE_EXECUTE_CONFIRM=...] -e RETENTION_PURGE_PROOF_FILE=... -e RETENTION_PURGE_METRICS_FILE=... -e RETENTION_PURGE_LOCK_FILE=... retention-scheduler
```

(the pgBackRest overlay is added only when `PGBACKREST_ENABLED=true` in runtime.env). The `retention-scheduler` Compose service is in profile `ops`, `restart: "no"`, never started by `up`; it uses the hardened locked-runtime profile (read-only root, `no-new-privileges`, all capabilities dropped, tmpfs `/tmp`), runs as uid/gid `RETENTION_PURGE_UID`/`RETENTION_PURGE_GID` (default 1000:1000), joins only the internal `app` network, and calls `http://api-v2:3002/v2/admin/retention/purge-expired` (API v2 forwards to the legacy API with an allowed internal host), not the public hostname.

Required state:

- `/opt/lunchlineup-secrets/runtime.env` exists and `RETENTION_PURGE_SERVICE_TOKEN_SECRET_FILE` names the generated service token. Compose mounts it as the secret `retention_purge_token` at `/run/secrets/retention_purge_token` (`RETENTION_PURGE_TOKEN_FILE`); the API mounts the same secret as `RETENTION_PURGE_SERVICE_TOKEN_FILE=/run/secrets/retention_purge_token`. Do not use a reusable platform-admin JWT. The file must be readable by the container uid.
- `/var/lib/lunchlineup/proofs/` exists and is writable by the container uid (the install script creates it, owner 1000:1000, mode 0750). Proof JSON is written atomically with mode 0600.
- `/var/lib/node_exporter/textfile_collector/` (estate-owned, never created here) is writable by the container uid. `.prom` files are written atomically (temp file plus rename) with mode 0644 so node_exporter can read them.
- The `migrate` image for the active `IMAGE_TAG` is present locally.
- Lock files live on the container's tmpfs `/tmp` (`/tmp/retention-purge.lock`, `/tmp/retained-record-review.lock`); the host deploy flock provides cross-run exclusion.

### VM107 install (verify only, units stay disabled)

```bash
cd /opt/lunchlineup
sh infrastructure/systemd/install-retention-scheduler.sh   # add --grant-textfile-acl if the collector dir is not writable by uid 1000
```

The script checks the token and directories, installs the four units to `/etc/systemd/system`, runs `systemd-analyze verify` on them, `systemctl daemon-reload`, resolves the `ops` profile with `docker compose config`, and confirms the migrate image exists. It never enables or starts anything. Manual equivalent:

```bash
install -m 0644 infrastructure/systemd/lunchlineup-retention-purge.service /etc/systemd/system/lunchlineup-retention-purge.service
install -m 0644 infrastructure/systemd/lunchlineup-retention-purge.timer /etc/systemd/system/lunchlineup-retention-purge.timer
install -m 0644 infrastructure/systemd/lunchlineup-retained-record-review.service /etc/systemd/system/lunchlineup-retained-record-review.service
install -m 0644 infrastructure/systemd/lunchlineup-retained-record-review.timer /etc/systemd/system/lunchlineup-retained-record-review.timer
systemd-analyze verify /etc/systemd/system/lunchlineup-retention-purge.service /etc/systemd/system/lunchlineup-retention-purge.timer /etc/systemd/system/lunchlineup-retained-record-review.service /etc/systemd/system/lunchlineup-retained-record-review.timer
systemctl daemon-reload
```

### Enabling (separate owner decision)

```bash
systemctl enable --now lunchlineup-retention-purge.timer lunchlineup-retained-record-review.timer
systemctl start lunchlineup-retention-purge.service lunchlineup-retained-record-review.service
journalctl -u lunchlineup-retention-purge.service -u lunchlineup-retained-record-review.service -n 100 --no-pager
test -s /var/lib/lunchlineup/proofs/retention-purge-latest.json
test -s /var/lib/lunchlineup/proofs/retained-record-review-latest.json
test -s /var/lib/node_exporter/textfile_collector/lunchlineup_retention_purge.prom
test -s /var/lib/node_exporter/textfile_collector/lunchlineup_retained_record_review.prom
```

The application-data unit runs the container with `RETENTION_PURGE_STAGE=application_data RETENTION_PURGE_DRY_RUN=false RETENTION_PURGE_EXECUTE_CONFIRM=purge-expired-application-data` and the proof/metrics/lock paths `/var/lib/lunchlineup/proofs/retention-purge-latest.json`, `/var/lib/node_exporter/textfile_collector/lunchlineup_retention_purge.prom`, `/tmp/retention-purge.lock`. The review unit runs it with `RETENTION_PURGE_STAGE=retained_records RETENTION_PURGE_DRY_RUN=true RETENTION_PURGE_PROOF_FILE=/var/lib/lunchlineup/proofs/retained-record-review-latest.json RETENTION_PURGE_METRICS_FILE=/var/lib/node_exporter/textfile_collector/lunchlineup_retained_record_review.prom RETENTION_PURGE_LOCK_FILE=/tmp/retained-record-review.lock` and no confirmation. Final retained-record deletion remains a reviewed platform-admin action after external backup and security-log expiry checks.

## Monitoring and Alert Ownership

Platform on-call owns `ApplicationDataRetentionExecutionTelemetryMissing`, `ApplicationDataRetentionExecutionStale`, `RetentionPurgeTelemetryMissing`, `RetentionPurgeStale`, `RetentionPurgeFailed`, and `RetentionPurgeCandidatesReady`. The first pair requires `mode="execute",stage="application_data"`, so dry-run proof cannot satisfy automatic purge monitoring; treat missing or older-than-26-hour execution telemetry as scheduler deployment or runtime breakage. Treat candidate-ready alerts as reviewed data-retention tickets with the dry-run proof attached; do not execute a retained-record purge from the timer.
