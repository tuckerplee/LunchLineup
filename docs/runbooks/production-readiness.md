# Production Readiness Runbook

Production database recovery requires both the existing encrypted logical dump and the independent PostgreSQL PITR path in `postgres-pitr-recovery.md`. The validated runtime and migration URLs must target the Compose `postgres:5432/POSTGRES_DB` service that those recovery jobs protect; an external authoritative database requires a separate, explicitly validated recovery architecture. Do not launch with PITR disabled or without a manually verified remote base backup and WAL segment.

## Purpose

Use this runbook before any public SaaS production deploy. It proves the deploy is sourced from GitHub, uses immutable artifacts, has real secrets and backup storage, and has alert routes that point to actionable runbooks.

## Required Inputs

- A clean local Git tree for the owned deploy commit.
- The commit pushed to the upstream GitHub branch before server deploy.
- The CI `release-manifest` artifact for that commit.
- The retained `.release/launch-proof.json` artifact for that commit, with non-skipped evidence for runtime env validation, the production Stripe meter, DAST, load smoke, logical DR drill, PITR drill, and alert routing. External release identity is intentionally absent predeploy and is proven after mutation from the public release header. `evidence.pitrDrill` must prove a named `COMPLETE` physical base backup, archived WAL, recovery target, successful paused restore, and passing invariants.
- Immutable image digests for `api`, `web`, `engine`, `worker`, `control`, `migrate`, `backup`, Dockerfile base images, and every non-application Compose service image.
- Production `.tfvars` values for `domain_name`, `vm_targets`, `network_cidr`, `secrets_backend`, `backup_repository`, `backup_metrics_collector`, `alert_targets`, and `operator_runbook_url`.
- A dedicated S3 Terraform backend bucket with versioning enabled, public access blocked, TLS-only access, server-side encryption, and native `.tflock` locking. Backend access must use a short-lived workload identity or assumed role.
- A managed secrets backend. Do not use plaintext files, local-only paths, placeholders, or copied example values for production.
- GitHub production environment variables `PRODUCTION_RUNTIME_SECRET_REFERENCE` and `PRODUCTION_RUNTIME_SECRET_VERSION`, identifying one immutable AWS Secrets Manager version. The referenced secret contains the production runtime env used by `scripts/validate-production-launch.mjs` and must include loopback-only `API_HOST_BIND`, `DATA_TARGET_ENV=production`, `MIGRATION_PRODUCTION_CONFIRM=apply-lunchlineup-production-migrations`, `MFA_SECRET_ENCRYPTION_KEY_CURRENT`, `WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT`, `STRIPE_SECRET_KEY`, `STRIPE_METER_ID`, `STRIPE_METER_EVENT_NAME`, `BACKUP_ENCRYPTION_KEY_SECRET_FILE`, `BACKUP_OFFSITE_URI`, `BACKUP_METRICS_FILE`, `ALERTMANAGER_WEBHOOK_URL_FILE`, `LUNCHLINEUP_STATUS_HEALTH_URL`, `LAUNCH_PROOF_MANIFEST_URI`, and the `LAUNCH_PROOF_*` retained evidence references. The workflow exports only the decoded runner-temp path and SHA as `PRODUCTION_RUNTIME_ENV_PATH`, `COMPOSE_SERVICE_ENV_FILE`, and `PRODUCTION_RUNTIME_ENV_SHA256`; production deploy commands must consume those values.
- GitHub production variable `PRODUCTION_RELEASE_REGISTRY_URI` naming a retained S3 prefix. Protected `RELEASE_REGISTRY_AWS_ACCESS_KEY_ID` and `RELEASE_REGISTRY_AWS_SECRET_ACCESS_KEY` credentials must allow read, conditional create of immutable `releases/<sha>.json`, and update of `index.json`.
- GitHub production variable `OLD_RELEASE_COMPATIBILITY_COMMAND`. It must create `OLD_RELEASE_COMPATIBILITY_PROOF_PATH` from an isolated database clone, apply candidate schema there, run the immediately previous retained release against it, retain evidence, and leave production unmodified.
- Monitored production addresses for `NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL`, `NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL`, and `NEXT_PUBLIC_DPA_CONTACT_EMAIL`.
- Exact `PUBLIC_SIGNUP_MODE=closed_beta` and `NEXT_PUBLIC_SIGNUP_MODE=closed_beta`. The checked-in Terms are explicitly not counsel-approved or versioned for self-service use, so production validation and runtime guards reject `invite_only` and `open` regardless of invite codes or Turnstile configuration.
- GitHub repository or organization variables for every web build-time public value: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL`, `NEXT_PUBLIC_OIDC_ENABLED`, `NEXT_PUBLIC_SIGNUP_MODE`, `NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL`, `NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL`, `NEXT_PUBLIC_DPA_CONTACT_EMAIL`, `NEXT_PUBLIC_APP_ORIGIN`, `NEXT_PUBLIC_APP_URL`, and `NEXT_PUBLIC_APP_ENV`. Main-branch web image builds fail closed if `NEXT_PUBLIC_WS_URL` is missing, non-`wss`, or points at localhost.
- GitHub staging variables `STAGING_API_HEALTH_URL` and `STAGING_WEB_URL`; both public responses must serve `X-LunchLineup-Release: GITHUB_SHA` through `verify-external-health-release.mjs`.
- GitHub production variables `PRODUCTION_HEALTH_URL`, `PRODUCTION_API_HEALTH_URL`, `PRODUCTION_WEB_URL`, and `PRODUCTION_POST_DEPLOY_PROOF_COMMAND`. `PRODUCTION_WEB_URL` must be the canonical public HTTPS root and must be forwarded by the deploy command to VM217. The proof command must compare the server `DEPLOYED_GIT_SHA` against `RELEASE_SOURCE_SHA`, run the public API health proof, and match the downloaded launch-proof artifact to `LAUNCH_PROOF_ARTIFACT_SHA256` within `LAUNCH_PROOF_MAX_AGE_SECONDS` before recording its nonzero size.
- Separate secret files for `METRICS_TOKEN_FILE` and `CONTROL_PLANE_ADMIN_TOKEN_SECRET_FILE`. The metrics token is for Prometheus reads only; the control-plane admin token gates `/api/status` and `/api/control/*`.
- An off-host backup repository, `/run/secrets/backup_key` provisioned from the managed secrets backend, `/etc/lunchlineup/backup-offsite` containing only a mode-`0640` `aws-credentials`/optional `aws-config` or `rclone.conf`, an installed `lunchlineup-backup.timer`, and a tested restore path.

## Self-Service Legal Gate

The checked-in Terms are an operational beta draft and are not counsel-approved. This repository therefore permits production closed-beta operation only; existing-workspace login and authenticated operator invitations remain available, but invite-only and open workspace self-service are blocked.

Before either self-service mode can be enabled, counsel must approve final Terms, assign an immutable version, and retain the approval record outside the repository. After that external prerequisite is complete, a reviewed code change must update the checked-in Terms readiness policy, validator, API guard, frontend guard, tests, environment example, and this runbook. Environment changes alone must never open production signup. The `PAID_GA_*` attestation does not satisfy this separate self-service Terms prerequisite.

## Preflight Checks

From the repository root:

```bash
npm run test:migration
npm run audit:prod
node scripts/verify-release-artifacts.mjs .release/release-manifest.json --source-sha "$(git rev-parse HEAD)" --launch-proof-file .release/launch-proof.json
node scripts/validate-production-launch.mjs /path/to/production-runtime.env
node scripts/rotate-auth-secrets.mjs
node --test tests/deploy/backup-scheduler.test.mjs tests/deploy/backup-restore-dr.test.mjs
node --test infrastructure/terraform/production/production-contract.test.mjs
```

If Terraform is installed:

```bash
cd infrastructure/terraform/production
terraform init -backend=false
terraform fmt -check
terraform validate
terraform test
```

This `-backend=false` path is only for backend-independent validation and mocked, plan-only tests. Do not run a production plan or apply from this initialization.

## Terraform Backend Initialization

The state bucket must be created and governed outside the LunchLineup production stack. Confirm that bucket versioning is enabled and authenticate with a short-lived workload identity or assumed role. Do not place AWS access keys in a backend file, command argument, shell history, Terraform variable, or Git.

Required backend permissions are `s3:ListBucket`, `s3:GetObject`, and `s3:PutObject` for `lunchlineup/production/terraform.tfstate` and `lunchlineup/production/terraform.tfstate.tflock`, plus `s3:DeleteObject` for only the `.tflock` object. State-object deletion is not required. The separately authorized recovery operator also needs `s3:ListBucketVersions` and `s3:GetObjectVersion`; routine plan/apply identities do not.

```bash
cd infrastructure/terraform/production
test "$(aws s3api get-bucket-versioning --bucket "$TF_STATE_BUCKET" --query Status --output text)" = Enabled
terraform init -reconfigure \
  -backend-config="bucket=$TF_STATE_BUCKET" \
  -backend-config="region=$AWS_REGION"
terraform plan -var-file=production.tfvars -out=production.tfplan
terraform show production.tfplan
```

Stop if versioning is not exactly `Enabled`, initialization reports a local backend, or Terraform cannot acquire the remote lock. Never use `-backend=false`, `-lock=false`, `-force-copy`, `-state`, or `-state-out` for a production plan or apply.

## Existing State Migration

Perform migration in an exclusive change window with all automated Terraform jobs disabled. First make an encrypted, access-restricted backup of the existing local state outside the repository. Record its SHA-256 and do not delete it until the migrated remote state and an S3 object version are verified.

```bash
cd infrastructure/terraform/production
terraform init -migrate-state \
  -backend-config="bucket=$TF_STATE_BUCKET" \
  -backend-config="region=$AWS_REGION"
terraform state pull > /secure/recovery/lunchlineup-production-after-migration.tfstate
sha256sum /secure/recovery/lunchlineup-production-after-migration.tfstate
aws s3api list-object-versions \
  --bucket "$TF_STATE_BUCKET" \
  --prefix lunchlineup/production/terraform.tfstate \
  --max-items 5
terraform plan -refresh-only -var-file=production.tfvars -detailed-exitcode
```

Approve Terraform's migration prompt only after it identifies the expected local source state and the configured S3 destination. A refresh-only exit code of `0` is required before normal planning; investigate exit code `2`, and treat any other code as failure. Never copy state with generic file or S3 commands as the migration mechanism.

## State And Lock Recovery

On a lock conflict, identify the operator/job that owns it and wait for or stop that operation cleanly. Use `terraform force-unlock <LOCK_ID>` only after proving no plan or apply is still running and recording the lock ID in the incident/change record. Do not delete `.tflock` directly.

For state recovery, freeze all Terraform writers, capture the current remote state with `terraform state pull`, and list S3 versions. Select a known-good version by timestamp, version ID, serial, lineage, and change record. Restore it as a new current version so history remains intact:

```bash
aws s3api list-object-versions \
  --bucket "$TF_STATE_BUCKET" \
  --prefix lunchlineup/production/terraform.tfstate
aws s3api copy-object \
  --bucket "$TF_STATE_BUCKET" \
  --key lunchlineup/production/terraform.tfstate \
  --copy-source "$TF_STATE_BUCKET/lunchlineup/production/terraform.tfstate?versionId=$KNOWN_GOOD_VERSION_ID"
terraform state pull > /secure/recovery/lunchlineup-production-restored.tfstate
terraform plan -refresh-only -var-file=production.tfvars -detailed-exitcode
```

Keep writers frozen until the restored state lineage/serial and infrastructure inventory are reviewed and refresh-only planning returns `0`. If recovery correctness is uncertain, stop and restore into an isolated account/bucket for inspection rather than experimenting against production.

If Prometheus tooling is installed:

```bash
promtool check config infrastructure/prometheus/prometheus.yml
promtool check rules infrastructure/prometheus/alerts/lunchlineup.yml
```

## Deploy Source Verification

Run one deploy-source verifier before touching the server:

```bash
scripts/verify-deploy-source.sh
```

```powershell
scripts\verify-deploy-source.ps1
```

The verifier must show that the current commit is clean, has an upstream GitHub branch, and either matches the server `DEPLOYED_GIT_SHA` or records a first deploy explicitly.

## Immutable Release Artifact Verification

Download the CI `release-manifest` artifact for the pushed commit and verify it before any deploy command:

```bash
node scripts/verify-release-artifacts.mjs .release/release-manifest.json --source-sha "$(git rev-parse HEAD)" --launch-proof-file .release/launch-proof.json
```

Every app image in the manifest, including the one-shot `backup` image, must be pinned as `<service>:<git-sha>@sha256:<digest>`. Every Dockerfile base image, CI service container image, and non-application Compose image must include an immutable `@sha256:` digest. The web image must receive all `NEXT_PUBLIC_*` values as Docker build args; browser bundles do not get corrected by Compose runtime env after the image is built. The staging and production deploy commands must consume `RELEASE_MANIFEST_PATH`, pass `RELEASE_SOURCE_SHA` into one deploy-source verifier before server mutation, and start Compose with pulled release images plus `--no-build --pull never`. Production deploy commands must also consume `PRODUCTION_RUNTIME_ENV_PATH` or `COMPOSE_SERVICE_ENV_FILE` and `PRODUCTION_RUNTIME_ENV_SHA256`, so the env file that passed launch validation is the one used for Compose/server mutation. A production deploy stops the backup timers, atomically stages `/var/lib/lunchlineup/backup-release.env` with the candidate image prefix and SHA, restores the previous pointer and timer state on any readiness failure, and commits the staged pointer only after one-shot backup/PITR proof succeeds. Do not deploy `latest`, `local`, tag-only images, or images built directly on the server. If `verify-release-artifacts.mjs` prints `launch_proof=not_checked`, the release artifact check is incomplete for public launch.

## Launch Proof Manifest

Keep `.release/launch-proof.json` with the release evidence. It must use the same `sourceSha` as `release-manifest.json`, `version: 1`, an ISO `generatedAt`, and these `evidence` entries:

- `runtimeEnv`: `scripts/validate-production-launch.mjs` proof for the production runtime env.
- `stripeMeter`: the expected commit SHA, Stripe meter ID, event name and payload mappings, attached metered plan prices, enabled webhook endpoint and handled event set, `aggregation: last`, `livemode: true`, and `meterStatus: active`; the production workflow compares these values to live Stripe API retrievals.
- `dast`: DAST artifact or run URL.
- `load`: load-smoke artifact or run URL.
- `drDrill`: retained DR JSON proof URI, `backupSha256`, `restoredTableCount`, exact off-host backup `sourceUri`, and artifact `completed_at`/`checked_at` plus `source_sha` that exactly match the outer `checkedAt` and `sourceSha`.
- `pitrDrill`: retained PITR JSON proof URI with an explicit `COMPLETE` base backup, archived WAL segment, recovery target, successful paused restore, passing invariant checks, and ordered source/restore/check timestamps.
- `alertRoute`: production critical-alert route proof URL.
- External health is not a predeploy launch-proof entry. The deploy and production-smoke gates query the public endpoint after mutation and require `X-LunchLineup-Release` to equal the candidate SHA.

Each entry must have `status: passed` or `status: ok`, matching `sourceSha`, unique retained `uri`, `checkedAt`, `summary`, generating `command`, `exitCode: 0`, retained artifact `artifactSha256`, and positive `artifactBytes`. `checkedAt` must not be later than top-level `generatedAt`; generation and evidence timestamps must be within the 86,400-second production freshness bound and no more than five minutes in the future. Do not use `skipped`, `pending`, `latest`, or `current` references. Start from `docs/testing/launch-proof-template.json`, but replace every placeholder with real retained artifact metadata before verification. Retained-record expiry scheduling belongs in `data-retention-delete-export.md`; this launch proof must not create a second purge scheduler or mark retained-record expiry complete.

## Runtime Environment Verification

Before opening production traffic, validate the same runtime env values that the production deployment will use:

```bash
node scripts/validate-production-launch.mjs /path/to/production-runtime.env
node scripts/verify-stripe-meter-config.mjs /path/to/production-runtime.env .release/launch-proof.json --source-sha "$(git rev-parse HEAD)"
```

GitHub production deploys must provide `PRODUCTION_RUNTIME_SECRET_REFERENCE` and `PRODUCTION_RUNTIME_SECRET_VERSION` as production environment variables. The deploy workflow fetches that exact immutable secret version into a runner-temp file, runs `scripts/validate-production-launch.mjs`, records the temp path and SHA in `PRODUCTION_RUNTIME_ENV_PATH`, `COMPOSE_SERVICE_ENV_FILE`, and `PRODUCTION_RUNTIME_ENV_SHA256`, rechecks the SHA immediately before server mutation, and deletes the temp file after the job finishes. Do not store the decoded env file in the repository, workflow logs, release artifacts, or server checkout. Production migration execution additionally requires exact `DATA_TARGET_ENV=production` and `MIGRATION_PRODUCTION_CONFIRM=apply-lunchlineup-production-migrations`; Compose passes the target into the `migrate` container, and the confirmation comes from the same service env file. The validator rejects public API host binds, local secret paths, local backup paths, missing `MFA_SECRET_ENCRYPTION_KEY_CURRENT`, missing or malformed `WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT`, missing backup freshness textfile output, missing Alertmanager webhook secret files, internal status health URLs, missing public contact emails or placeholder contact domains, signup mode drift, any production signup mode other than `closed_beta`, missing `LAUNCH_PROOF_MANIFEST_URI`, and missing or vague `LAUNCH_PROOF_*` evidence references.

## Auth Secret Rotation

Before opening production signups or importing legacy users, dry-run auth secret rotation:

```bash
node scripts/rotate-auth-secrets.mjs
```

If the dry run reports legacy plaintext candidates, execute with the managed MFA encryption key:

```bash
MFA_SECRET_ENCRYPTION_KEY_CURRENT=<managed secret> \
AUTH_SECRET_ROTATION_EXECUTE_CONFIRM=rotate-auth-secrets \
node scripts/rotate-auth-secrets.mjs --execute
```

Use `--revoke-sessions` only when the launch plan intentionally forces users with legacy plaintext refresh-token rows to sign in again. The helper prints counts only; do not paste token or TOTP secret material into tickets, logs, or release artifacts. Managed current/previous overlap, first-time legacy v1 migration, and fail-closed old-key removal are defined in `mfa-encryption-key-rotation.md`.

## Control Plane And Docker Socket Proof

The public production Compose baseline must be private-fail-closed:

- `control` publishes only `127.0.0.1:3001:3001`.
- `control` joins only the internal `management` network, not `data` or `external`.
- `control` has no `/var/run/docker.sock` mount.
- `CONTROL_PLANE_DOCKER_STATUS=disabled` unless a separate private operations override has been reviewed.
- `/api/status` and `/api/control/*` use `/run/secrets/control_plane_admin_token`.
- `/api/metrics` uses `/run/secrets/metrics_token` for Prometheus scraping.
- Raw Docker socket helpers such as `autoheal` are kept out of the default public profile; only enable the `ops` profile on a private operations host with explicit review.

If Docker-backed control-plane status is intentionally enabled for a private operations host, require a separate Compose override that sets `CONTROL_PLANE_DOCKER_STATUS=enabled`, sets `CONTROL_PLANE_DOCKER_SOCKET_PATH`, documents the operator-only network path, and proves the public stack still cannot reach the socket-backed endpoint. Do not enable Docker socket access in the public baseline.

## Backup And Restore Proof

Before public traffic:

- Provision `/run/secrets/backup_key` from the managed secrets backend with owner `root`, group `lunchlineup`, and mode `0640`. Set `BACKUP_ENCRYPTION_KEY_SECRET_FILE=/run/secrets/backup_key`; never place the passphrase in `BACKUP_ENCRYPTION_KEY` or an env file. The remote deploy validates that exact host source path as readable before pulling or starting candidate services.
- Provision `/etc/lunchlineup/backup-offsite` with owner `root`, group `lunchlineup`, and mode `0750`. For S3, install mode-`0640` `aws-credentials` and optional `aws-config`; for rclone, install mode-`0640` `rclone.conf`. Set `BACKUP_OFFSITE_CREDENTIALS_DIR=/etc/lunchlineup/backup-offsite`. Do not place provider credentials in the runtime env or Compose environment.
- Set `BACKUP_OFFSITE_URI` to an exact non-root `s3://bucket/prefix` or `rclone:remote:path` repository and `NODE_EXPORTER_TEXTFILE_DIR=/var/lib/node_exporter/textfile_collector` in the validated production runtime env. Set `BACKUP_OFFSITE_RETENTION_DAYS=35` and `BACKUP_OFFSITE_RETENTION_DRY_RUN=false` in the scheduler env. The Compose job forces offsite upload, bounded exact-object remote retention, and writes `/metrics/lunchlineup_backup.prom` through that host mount.
- Install `infrastructure/systemd/lunchlineup-backup.env.example`, `.service`, and `.timer` exactly as documented in `infrastructure/systemd/README.md`. Confirm the last successful deploy created `/var/lib/lunchlineup/backup-release.env`.
- Run the same one-shot path used by the timer, then enable recurrence:

  ```bash
  systemctl start lunchlineup-backup.service
  journalctl -u lunchlineup-backup.service -n 50 --no-pager
  test -s /var/lib/node_exporter/textfile_collector/lunchlineup_backup.prom
  systemctl enable --now lunchlineup-backup.timer
  systemctl list-timers lunchlineup-backup.timer
  ```

  The unit executes `docker compose --profile ops ... run --rm --no-deps --pull never backup`; it must use the deployed backup image and must not build or pull on the production host.
- Confirm the log contains `offsite_retention_ok mode=execute` followed by `backup_ok`, the encrypted `.sql.zst.gpg` object and `.sha256` sidecar exist in the `backup_data` volume, and the exact timestamped objects exist at `BACKUP_OFFSITE_URI`. Remote retention lists only that non-root repository and deletes matching direct-child backup objects one exact URI at a time; a list/delete error must fail the service. For a pre-launch listing rehearsal, run one shot with `BACKUP_OFFSITE_RETENTION_DRY_RUN=true`, review every `offsite_retention_candidate` line, then restore `false` and rerun before launch.
- Query Prometheus for `lunchlineup_backup_last_success_timestamp_seconds`, then confirm `BackupMissingTelemetry` and `BackupStale` are inactive. The metric file alone is insufficient without the offsite object and checksum sidecar.
- Download the encrypted backup and its `.sha256` sidecar from the off-host repository to a disposable path. Do not use a `latest` alias; record the exact object URI.
- Restore that exact off-host backup into a disposable environment, not production:

  ```bash
  BACKUP_FILE=/tmp/lunchlineup-YYYYMMDDHHMMSS.sql.zst.gpg \
  DR_OFFHOST_SOURCE_URI=s3://lunchlineup-prod/db-backups/lunchlineup-YYYYMMDDHHMMSS.sql.zst.gpg \
  DR_SOURCE_SHA="$(git rev-parse HEAD)" \
  BACKUP_ENCRYPTION_KEY_FILE=/run/secrets/backup_key \
  ./scripts/dr-drill.sh
  ```

- Capture the `dr_drill_ok ...` line and the JSON proof file path from `DR_PROOF_FILE` or `/tmp/lunchlineup-dr-drill-*.json`. The proof must include `status: ok`, `backup_sha256`, `source_uri`, `source_kind`, nonzero `restored_table_count`, release-bound `source_sha`, and `completed_at`/`checked_at`. Copy that exact completion timestamp into the outer launch-proof `drDrill.checkedAt`.
- Confirm restored API health and at least one tenant-scoped schedule query if this backup is promoted into a disposable app stack after the database-only drill.
- Confirm the Prometheus backup freshness alerts continue to see `lunchlineup_backup_last_success_timestamp_seconds` after node-exporter and Prometheus restart.

## PITR Immutable Storage Proof

Before public launch and before the production deploy mutation marker:

- Provision distinct managed WAL append-only, base-backup append-only, and restore read-only credential directories. Never reuse one identity or directory across these roles.
- Enable bucket versioning and default COMPLIANCE Object Lock for `PITR_OBJECT_LOCK_RETENTION_DAYS` of at least 14 days.
- Run `scripts/pitr-verify-storage.sh` with the candidate release image inputs. Require both writer proof lines and `pitr_storage_readiness_ok`; any missing permission, successful delete attempt, missing versioning, or retention mismatch blocks deployment.
- Keep lifecycle expiration in a separately managed object-store policy/identity. Do not mount lifecycle/delete credentials in application, migration, Postgres, backup, or restore containers.
## Alert And Runbook Proof

- Confirm `alert_targets` contains at least one production paging route and Alertmanager routes every `critical` alert to that target.
- Confirm every alert in `infrastructure/prometheus/alerts/lunchlineup.yml` has a `runbook` annotation pointing at an existing `docs/runbooks/*.md` file.
- Confirm Prometheus scrapes `webhook-replay:3004`, `WebhookReplayNotReady` is enabled, and `lunchlineup_webhook_replay_ready{job="webhook-replay"}` is `1` after startup.
- Confirm the API scrape exposes `lunchlineup_dependency_up{dependency="rabbitmq"} 1`, `RabbitMQDependencyUnavailable` is inactive, and `/health` returns `503` when RabbitMQ is stopped or unreachable.
- Confirm Grafana, Loki, Tempo, and Prometheus are private or authenticated.

## Launch Blocks

Stop the production deploy if any of these are true:

- Terraform reports any `missing_required_inputs`.
- `npm run audit:prod` fails, or npm adds any production advisory outside the exact documented Next/PostCSS moderate triage.
- `.release/release-manifest.json` is missing or fails `scripts/verify-release-artifacts.mjs`.
- `.release/launch-proof.json` is missing, uses a different `sourceSha`, contains skipped/pending evidence, omits per-entry command/checksum/size/source metadata, or fails `scripts/verify-release-artifacts.mjs --launch-proof-file`.
- `PRODUCTION_RUNTIME_SECRET_REFERENCE` or `PRODUCTION_RUNTIME_SECRET_VERSION` is missing, the immutable secret version cannot be fetched, or the fetched runtime env fails `scripts/validate-production-launch.mjs`.
- The retained release registry cannot resolve the immediately previous successful SHA, the isolated-clone compatibility artifact is missing/stale/mismatched, or old-release smoke fails against candidate schema.
- Stripe cannot authoritatively retrieve `STRIPE_METER_ID`, or the live meter is not active/live, does not use `STRIPE_METER_EVENT_NAME`, does not aggregate with `last`, or does not exactly match `.release/launch-proof.json` evidence.
- The production runtime env does not set exact `DATA_TARGET_ENV=production` and `MIGRATION_PRODUCTION_CONFIRM=apply-lunchlineup-production-migrations` before the migration container starts.
- `PRODUCTION_API_HEALTH_URL`, canonical root `PRODUCTION_WEB_URL`, or `PRODUCTION_POST_DEPLOY_PROOF_COMMAND` is missing, or the proof command does not verify `DEPLOYED_GIT_SHA` against `RELEASE_SOURCE_SHA`, public API health, retained proof checksum, and nonzero proof-artifact size.
- The API health response is degraded, `lunchlineup_dependency_up{dependency="rabbitmq"}` is absent or zero, or `RabbitMQDependencyUnavailable` is firing.
- Any production image reference, Dockerfile base image, CI service image, or non-app Compose service image uses a mutable tag instead of a digest.
- The release manifest omits `backup`, `/var/lib/lunchlineup/backup-release.env` does not select the deployed SHA, or the timer would build or pull an image on the server.
- Any secret, password, token, private key, `.env`, backup payload, or generated credential is tracked in Git.
- The public Compose baseline mounts `/var/run/docker.sock` into a default-profile service, mounts it into `control`, places `control` on `data` or `external`, or uses the metrics token for admin/control actions.
- Backup restore has not been rehearsed from the same off-host repository through `scripts/dr-drill.sh` with `DR_OFFHOST_SOURCE_URI` and a retained JSON proof file.
- `lunchlineup-backup.timer` or `lunchlineup-pitr-base-backup.timer` is not installed, enabled, and active; candidate-image one-shots do not prove offsite logical backup plus PITR base backup; fresh metrics are absent; or `BackupMissingTelemetry`/`BackupStale` is firing.
- PITR writer credentials are shared or can delete, the restore identity can write, bucket versioning/default COMPLIANCE Object Lock is absent or mismatched, pitr_storage_readiness_ok is missing before mutation, or lifecycle/delete credentials are mounted in any application/data container.
- `LUNCHLINEUP_STATUS_HEALTH_URL`, `ALERTMANAGER_WEBHOOK_URL_FILE`, `LAUNCH_PROOF_MANIFEST_URI`, or any required `LAUNCH_PROOF_*` reference is missing, points at local/test/example values, or uses a vague `latest`/`current` alias.
- `NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL`, `NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL`, or `NEXT_PUBLIC_DPA_CONTACT_EMAIL` is missing, unmonitored, or still uses a `.example` placeholder.
- `PUBLIC_SIGNUP_MODE` or `NEXT_PUBLIC_SIGNUP_MODE` is missing, mismatched, or not exactly `closed_beta`; invite codes and Turnstile keys do not override the unresolved counsel-approved, versioned Terms prerequisite.
- `/privacy`, `/security`, and `/subprocessors` have not been reviewed against `docs/compliance/privacy-security.md`, `docs/compliance/subprocessors.md`, and `docs/compliance/dpa-readiness.md`.
- Restore requires `RESTORE_ALLOW_NONEMPTY=YES_OVERWRITE` because the target database was not rebuilt empty first.
- Alerts route only to a personal inbox, placeholder target, or unmonitored channel.
- The server has uncommitted direct edits or reports a `DEPLOYED_GIT_SHA` that does not match the intended GitHub commit.

## Post-Deploy Verification

On the server:

```bash
cat /opt/lunchlineup/DEPLOYED_GIT_SHA
docker compose ps
docker compose logs --tail=100 api worker engine
systemctl status lunchlineup-backup.timer --no-pager
systemctl list-timers lunchlineup-backup.timer
test -s /var/lib/node_exporter/textfile_collector/lunchlineup_backup.prom
curl -fsS https://lunchlineup.com/health
```

From a private admin workstation:

```bash
curl -fsS https://lunchlineup.com/health
curl -fsS https://lunchlineup.com/ | grep -F '<h1>LunchLineup</h1>'
curl -fsS https://lunchlineup.com/ | grep -F '/_next/static/'
curl -fsS https://lunchlineup.com/api/v1/health
```

The VM217 deploy helper checks the public API through `PRODUCTION_API_HEALTH_URL` and the canonical public root through `PRODUCTION_WEB_URL`. The root probe rejects redirects, non-HTML and undersized responses, pages missing either the LunchLineup heading or a Next.js static asset reference, and any `X-LunchLineup-Release` header that does not equal `RELEASE_SOURCE_SHA`. Before writing success proof it also requires healthy worker, engine, webhook replay, Prometheus, and Alertmanager containers. A failed gate leaves `DEPLOYED_GIT_SHA` unchanged and causes the workflow's failed-deploy step to execute `PRODUCTION_ROLLBACK_COMMAND`. The CI production smoke job repeats the public web/API checks, then runs `PRODUCTION_POST_DEPLOY_PROOF_COMMAND` with `RELEASE_SOURCE_SHA`, `LAUNCH_PROOF_ARTIFACT_SHA256`, and `LAUNCH_PROOF_MAX_AGE_SECONDS` in the environment. The API health response includes database, Redis, and RabbitMQ checks; any failed RabbitMQ connection returns `503`, causing the launch gate to fail. Expected result: the release header, both web markers, and health responses are successful, `lunchlineup_dependency_up{dependency="rabbitmq"}` is `1`, `DEPLOYED_GIT_SHA` matches the pushed GitHub commit, and no critical alerts fire during the first 15 minutes.

## First Release Registry Bootstrap

Run the production workflow manually with ootstrap_release_registry=true and exact confirmation ootstrap-first-production-release:<candidate SHA>. CI verifies the registry is empty, deploys and verifies the candidate, then atomically creates the immutable v2 release bundle and index. Runtime bytes are fetched by AWS Secrets Manager VersionId into runner temp storage and are never uploaded.
