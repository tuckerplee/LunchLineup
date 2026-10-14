# Backup / Offsite / Restore / PITR / Alerting Drill

A local, disposable end-to-end proof of the LunchLineup recovery paths. It uses
throwaway `ll-drill-*` Docker objects only and never contacts a real server. Production
therefore needs only the owner's real object-store credentials and alert endpoint.

## Run it

```bash
# Linux/macOS, or Git Bash on Windows with Docker Desktop. Builds from `git archive HEAD`
# (LF), so a CRLF checkout is safe.
DRILL_MIGRATE_IMAGE=<any image with /app/node_modules incl. prisma + pg, e.g. the release migrate image> \
  scripts/drills/backup-restore-drill.sh all
# or phase by phase: build | up | logical | pitr | lifecycle | alerts | systemd | down
scripts/drills/backup-restore-drill.sh down      # removes every ll-drill-* container/volume/network
```

If `DRILL_MIGRATE_IMAGE` is unset the harness builds `infrastructure/docker/Dockerfile.migrations`
(needs npm registry access). `DRILL_ALERT_PROMETHEUS=0` skips the slow Prometheus-rule path.
Each phase prints `RESULT ...` lines and exits non-zero with `FAIL ...` on any broken assertion.

What is real and what is stood in:

| Component | Drill | Production |
|---|---|---|
| Postgres 16, migrations, `backup.sh`, `restore.sh`, `pitr-*.sh`, `archive-wal.sh`, WAL provider, Alertmanager config, Prometheus rules | the repo's own files and images | same |
| Object store | MinIO built from source (upstream images are no longer published), versioning + COMPLIANCE Object Lock, exact-prefix lifecycle, delete-deny policy, least-privilege identities, KMS key for SSE-S3 | owner's S3 bucket |
| `aws sts get-caller-identity` | `scripts/drills/sts-stub.mjs` (MinIO lacks STS GetCallerIdentity) | real AWS STS |
| Alert endpoint | `scripts/drills/webhook-receiver.mjs` | owner's webhook |

## Result of the recorded run (HEAD of `claude/backup-drill`)

Logical backup, offsite, restore (60 tables, 33,816 rows; 1.0 MB encrypted dump):

```
backup_ok ... size_bytes=1039121 backup_sha256=2d5b1033...c149602b offsite_version=0dea389a-... provider_principal=arn:aws:iam::000000000000:user/ll-drill-backup-writer expiry_owner=lifecycle
offsite head-object: ContentLength=1039121 ObjectLockMode=COMPLIANCE RetainUntil 2026-11-18
delete-object-version by writer identity: AccessDenied
offsite copy sha256 equals backup_sha256
tables after refused tampered restore = 0            (corrupt offsite copy rejected before any DB change)
restore_ok ... restored_table_count=60 app_role_verified=true
restore from offsite: 60/60 tables identical, 33816/33816 rows identical (count + md5 per table)
  public.AuditLog 15000  public.Shift 12000  public.TimeCard 6000  public.User 600  public.Schedule 48  public.Location 6  public.Tenant 3
```

PITR (base backup + WAL archived to MinIO, target between two writes):

```
archived WAL: 16MiB segments, none under 1 MiB
base backup 20261014T230915Z.kUDgXkQlP0 committed (COMPLETE marker uploaded last)
write A (pitr-marker-A) at <= target 2026-10-14T23:09:22.331426Z; write B 3 s later
validation instance in recovery, paused at target
write A present = 1, write B present = 0, rows before target 1000/1000, rows after target 0/1000
last replayed commit 23:09:19.925Z <= target; recovered AuditLog 16001 rows vs source 17002; source still has write B
after promotion: A present, B absent, writable, new timeline 2
pitr_lifecycle_policy_ready current_expiration_days=30 noncurrent_expiration_days=1 maximum_retention_days=90 exact_rules=2
```

Alerts:

```
amtool check-config: SUCCESS (repo alertmanager.yml, url_file secret)
LunchLineupDrillTest (amtool) -> webhook, status firing, then resolved
promtool check rules: SUCCESS 45 rules; promtool test rules: SUCCESS
object store stopped -> PitrWalArchiveFailure (critical) fired in Prometheus -> Alertmanager -> webhook
object store restored -> archiver recovered (last_archived_time > last_failed_time)
```

During the Prometheus step, other repo rules for components the drill does not run
(`PublicWebProbeStale`, `PdfParserReadinessMissing`) also reached the webhook: that is the
expected behaviour for missing telemetry.

## Bugs the drill found (all fixed in this branch, separate commits)

1. `pitr-object-store.sh`: a missing object was never recognised (`mc --json` reports it on
   stdout), so the first upload of every WAL/base-backup object failed as "state unknown".
2. No `pg_hba` replication entry for the base-backup container: `pg_basebackup` was rejected.
   Added `infrastructure/postgres/pg_hba.conf` (`host replication all samenet scram-sha-256`).
3. `backup.sh` container-job mode aborted (exit 70) on its own orphaned `sleep`, i.e. every
   offsite upload.
4. `docker-compose.yml` backup service lacked `GNUPGHOME=/tmp` (read-only home).
5. `pitr-restore.sh` wrote `recovery_target_time` with a `Z` suffix, which PostgreSQL rejects.
6. **Critical:** `archive-wal.sh` used BusyBox `wget --post-file`, which truncates at the first
   NUL byte. Every 16 MiB WAL segment was archived as a 3-byte immutable object while reporting
   success, so PITR would have restored nothing. Now streamed with `nc` and an explicit
   `Content-Length`; the WAL provider also needed `httpAllowHalfOpen` so it answers after the
   client's FIN. The drill asserts archived segments are full size.
7. Textfile metrics were created `0600`, unreadable by unprivileged node-exporter, so the
   backup/PITR freshness metrics never appeared (permanent `*TelemetryMissing` alerts).
   Files are now `0644`; the textfile directory must be writable by root, uid 70 and `lunchlineup`
   (see `infrastructure/systemd/README.md`).

## Recovery validation instance: use the backup image

The runbook example starts the validation Postgres from the BusyBox `postgres:16-alpine` image.
Its `timeout` rejects the GNU long options `restore-wal.sh` uses, and the container-job ownership
check counts unrelated Postgres processes as survivors. Run it from the backup image instead (same
PostgreSQL 16.15 server, GNU coreutils), as the drill does:

```bash
docker run -d --name pitr-validation --user 70:70 \
  -e PITR_ENABLED=true -e PITR_S3_ENDPOINT=... -e PITR_S3_BUCKET=... -e PITR_S3_PREFIX=... \
  -e PITR_OBJECT_LOCK_RETENTION_DAYS=14 -e PITR_PROVIDER_OWNERSHIP_MODE=container-job -e TMPDIR=/tmp \
  -e PITR_ACCESS_KEY_FILE=/run/secrets/pitr-restore-object-store/access_key \
  -e PITR_SECRET_KEY_FILE=/run/secrets/pitr-restore-object-store/secret_key \
  -v lunchlineup_postgres_pitr_restore_data:/var/lib/postgresql/data \
  -v /opt/lunchlineup/infrastructure/postgres:/opt/lunchlineup/pitr:ro \
  -v "$PITR_RESTORE_OBJECT_STORE_SECRETS_DIR":/run/secrets/pitr-restore-object-store:ro \
  --entrypoint postgres "$PITR_VALIDATION_BACKUP_IMAGE" -D /var/lib/postgresql/data \
  -c listen_addresses='*' -c archive_mode=off -c unix_socket_directories=/tmp
```

Do not connect until `docker logs` shows `pausing at the end of recovery`; a client connecting
during replay forks a process the ownership check will count.

## Alerting: plugging in the owner's endpoint

Alertmanager reads exactly one URL from the Docker secret `alertmanager_webhook_url`
(file `ALERTMANAGER_WEBHOOK_URL_FILE`, default `./secrets/alertmanager_webhook_url`; in
production point it at e.g. `/etc/lunchlineup/secrets/alertmanager_webhook_url`). The file
contains only the URL, mode 0600/0640, no trailing newline needed.

It is a **generic Alertmanager webhook**: it POSTs Alertmanager's JSON (`status`, `alerts[]`...).
A raw Slack Incoming Webhook URL will reject that payload (no `text`). Use a receiver that
accepts Alertmanager JSON: an Alertmanager-to-Slack/Teams/SMS/email relay, Opsgenie/PagerDuty
Prometheus-style endpoints, or Zapier/Make/n8n catch-hook. Switching the config to native
`slack_configs`/`email_configs` would also require updating
`scripts/verify-observability-configs.mjs`, which pins the webhook receiver.

## systemd

`infrastructure/systemd/lunchlineup-backup.{service,timer}` and the PITR pair parse cleanly with
`systemd-analyze verify` (the only complaint is `docker.service` missing on the verifying
host). The timer is `OnCalendar=*-*-* 02:17:00`, 30 min random delay, `Persistent=true`;
the PITR timer is 03:17. Each service runs
`pitr-run-candidate-job.sh <unit>` from `/opt/lunchlineup/releases/${IMAGE_TAG}`, which maps the unit
to the Compose `backup` / `pitr-base-backup` service. Install steps (see
`infrastructure/systemd/README.md` for the full list):

```bash
install -d -m 0750 /etc/lunchlineup /run/secrets /etc/lunchlineup/backup-offsite
install -d -o lunchlineup -g lunchlineup -m 0750 /var/lib/lunchlineup
install -d -m 1777 /var/lib/node_exporter/textfile_collector
install -o root -g lunchlineup -m 0640 infrastructure/systemd/lunchlineup-backup.env.example /etc/lunchlineup/backup.env
install -o root -g lunchlineup -m 0640 <backup passphrase file> /run/secrets/backup_key
install -o root -g lunchlineup -m 0640 <aws-credentials> /etc/lunchlineup/backup-offsite/aws-credentials
install -m 0644 infrastructure/systemd/lunchlineup-backup.service infrastructure/systemd/lunchlineup-backup.timer /etc/systemd/system/
systemd-analyze verify /etc/systemd/system/lunchlineup-backup.service /etc/systemd/system/lunchlineup-backup.timer
systemctl daemon-reload && systemctl start lunchlineup-backup.service   # deploy must have written /var/lib/lunchlineup/backup-release.env
journalctl -u lunchlineup-backup.service -n 50 --no-pager               # expect offsite_immutable_ok, backup_ok
systemctl enable --now lunchlineup-backup.timer
```

## What the owner must provide

- S3 bucket (AWS S3 for `sts get-caller-identity`) with versioning, default COMPLIANCE Object
  Lock (35-90 days), exact-prefix lifecycle (current and noncurrent expiry 35-90 days) and an
  unconditional deny of `s3:DeleteObject`/`s3:DeleteObjectVersion` on the prefix;
  `BACKUP_OFFSITE_URI=s3://bucket/prefix`; writer keys in `aws-credentials` (+ optional
  `aws-config`) under `BACKUP_OFFSITE_CREDENTIALS_DIR`.
- A PITR bucket/prefix with the same protections (Object Lock >= 14 days, lifecycle <= 90) and
  four identities (WAL writer, base-backup writer, restore reader, lifecycle-audit reader), plus
  `PITR_ENABLED=true`, `PITR_ARCHIVE_MODE=on`, HTTPS endpoint.
- The backup GPG passphrase (`/run/secrets/backup_key`) held offline as well.
- The alert receiver URL in the `alertmanager_webhook_url` secret file.
