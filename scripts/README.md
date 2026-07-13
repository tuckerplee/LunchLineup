# Scripts

## Files

- `README.md`: this scripts folder guide.
- `apply-db-migrations.mjs`: applies the Prisma schema and raw SQL migrations in deployment order through the repository-local Prisma CLI.
- `artillery-smoke.yml`: Artillery smoke-load scenario used by CI against a running Compose target.
- `audit-prod.mjs`: runs the production npm audit gate and allows only the documented Next/PostCSS moderate advisory.
- `backup.sh`: encrypted Postgres backup helper with checksum, offsite sync, atomic writes, and optional Prometheus textfile metrics.
- `build-release-bundle.mjs`: builds a source-bound rollback bundle from exact deployed inputs, retaining only an immutable runtime-secret descriptor and never runtime secret bytes.
- `bootstrap-production-admin.mjs`: reconciles production system RBAC and creates the initial admin only when the monitored address is absent; deploy replay never restores an existing admin role, deletion state, or assignment, and refuses unavailable bootstrap tenants.
- `bootstrap-vm107-dev.sh`: disposable VM107 dev bootstrap and optional Postgres restore helper.
- `chaos-experiment.sh`: destructive or resilience experiment helper.
- `data-target-guard.mjs`: shared fail-before-Prisma target guard for development/E2E seeds, legacy imports, and migration deployments.
- `deployed-release-inputs.mjs`: binds the exact manifest, deployment bundle, immutable runtime-secret descriptor, and launch-proof bytes used by the deploy job; runtime secret bytes are never included.
- `deploy-vm217-remote.sh`: VM217 immutable release deploy helper with public Next.js and required-service health gates, CI-bound launch proof, and rollback-safe migration control.
- `download-assets.sh`: asset download helper.
- `dr-drill.sh`: disaster recovery drill helper.
- `final-migration.sh`: final migration helper.
- `generate-sbom.sh`: software bill of materials generation helper.
- `generate-raw-migration-policy.mjs`: generates exact additive approvals and digest-bound expand/contract records while rejecting historical drift.
- `import-legacy-users.mjs`: imports legacy PHP `users` and `staff` export JSON into the Prisma tenant/user/RBAC schema and writes a private login-method report.
- `invoke-retained-record-purge.mjs`: controlled retained-record expiry invocation helper that defaults to dry-run, requires a platform token, writes JSON proof, and publishes Prometheus textfile metrics for scheduler alerting.
- `launch-proof-evidence.mjs`: parses fetched DR, load, and alert-route JSON evidence and binds semantic results to launch-proof claims.
- `load-test.sh`: runs the Artillery smoke-load scenario against `TARGET_URL` or an explicit URL argument.
- `materialize-rollback-state.mjs`: rejects secret-bearing state, validates a resolved immutable previous-release bundle, then writes the isolated application root used by the centralized CI rollback job.
- `pitr-base-backup.sh`: creates and verifies a plain-format physical base backup before packaging it, uploads an immutable remote commit marker last, and writes PITR freshness metrics without remote deletion.
- `pitr-restore.sh`: downloads one explicit committed base backup through the dedicated read-only identity, verifies the extracted PGDATA, refuses live/non-empty PGDATA, and materializes paused point-in-time recovery configuration.
- `pitr-verify-storage.sh`: runs WAL and base-backup writer canaries and fails unless versioning, default/per-object COMPLIANCE retention, and denied deletion are proven.
- `production-tuning.sh`: production tuning helper.
- `provision-app-db-role.mjs`: uses repository-local Prisma stdin to idempotently harden the restricted Postgres runtime role and grant existing plus future admin-owned schema objects without host `psql` or secrets in process arguments.
- `pull-vm217-logs.sh`: VM217 log pull helper.
- `raw-migration-rollback-policy.json`: exact-digest approvals for candidate-only raw SQL that the backward-compatible additive classifier permits during rollback.
- `release-bundle-registry.mjs`: resolves and publishes immutable secret-free release bundles; empty registries can bootstrap only from an independently retained bundle whose exact SHA is freshly proven on two live HTTPS endpoints.
- `rehydrate-runtime-secret.mjs`: fetches one immutable AWS Secrets Manager VersionId, verifies its release-bound SHA-256, and writes runtime bytes only to a mode-0600 runner-temporary file.
- `rehydrate-durable-queues.sql`: bounded operator query that marks due schedule and webhook outbox rows for broker-loss republishing after restore or queue loss.
- `restore.sh`: fail-closed encrypted backup restore helper that transactionally replaces an approved non-empty schema, reprovisions the restricted app database role, and proves that role can access restored relations.
- `rotate-auth-secrets.mjs`: dry-run-first, serializable maintenance helper that hashes legacy refresh tokens, re-encrypts every MFA TOTP secret under the current managed key, and verifies old-key removal before commit.
- `rotate-webhook-endpoint-secrets.mjs`: application-key-aware pre-DDL conversion of recoverable plaintext endpoint secrets to AES-256-GCM envelopes with count-only output.
- `rsync-vm217.sh`: legacy VM217 rsync helper.
- `run-dast.sh`: runs the OWASP ZAP baseline scan against `TARGET_URL` or an explicit URL argument.
- `seed-e2e.mjs`: resets and seeds the disposable E2E tenant, admin and super-admin PIN users, RBAC roles, and first location.
- `setup-vm217.sh`: legacy VM217 setup helper.
- `verify-deploy-source.ps1`: Windows deploy-source verification script.
- `verify-deploy-source.sh`: Linux deploy-source verification script.
- `verify-backup-readiness.sh`: validates required systemd environment files and unit syntax, runs the actual backup and PITR services to successful offsite/fresh-metrics proof, then enables their timers.
- `verify-downloaded-launch-proof.py`: VM217-side checksum/source verifier for exact retained proof bytes, with candidate freshness enforcement and non-expiring rollback mode.
- `verify-external-health-release.mjs`: post-deploy public health probe that requires `X-LunchLineup-Release` to equal the deployed candidate SHA and emits JSON evidence.
- `verify-observability-configs.mjs`: deterministic Node verifier for Compose observability wiring, Caddy route/header structure, Prometheus scrape/rule config, and Alertmanager routing without requiring Docker or external config binaries by default; optional tool mode can also run Caddy, promtool, and amtool validation.
- `verify-old-release-compatibility.mjs`: validates retained isolated-clone proof that the immediately previous release passed against candidate schema before production mutation.
- `verify-production-launch-proof.mjs`: rejects placeholder manifests, fetches retained evidence, verifies artifact bytes, and semantically validates operational results before delegating to the release artifact verifier.
- `verify-stripe-meter-config.mjs`: retrieves the configured production billing meter from Stripe and binds its live identity, event name, active/live state, and `last` aggregation to launch proof.
- `verify-rollback-schema-compatibility.py`: statement-aware rollback schema classifier that allows only backward-compatible additive tables, nullable/defaulted columns, and indexes while rejecting destructive, constraining, or unknown DDL.
- `verify-trivy-release-reports.mjs`: verifies every Trivy image report and sidecar checksum against its digest-pinned release-manifest entry and fails on HIGH or CRITICAL vulnerabilities.
- `validate-production-launch.mjs`: strict public SaaS launch environment validator for real domains, live provider keys, managed secret-file paths, HTTPS public surfaces including required `APP_ORIGIN`, and the code-locked production closed-beta Terms gate.
- `verify-release-artifacts.mjs`: verifies the CI release manifest includes digest-pinned API, web, engine, worker, migration, control, and backup images plus pinned Dockerfile bases, Compose third-party services, CI service containers, and deploy command variables before rollout.
- `verify-raw-migration-rollback.mjs`: compares candidate and rollback raw-migration inventories, requires an exact policy approval for every candidate-only digest, and delegates SQL classification to the fail-closed rollback DDL verifier.
- `write-smoke-env.mjs`: writes the ephemeral CI smoke-stack `.env.smoke` and metrics token secret used by DAST and load-test jobs.
- `write-deployment-contract.mjs`: creates the deterministic deployment-contract bundle and binds its checksum, byte count, workflow, production Compose, deploy/migration scripts, and operational configuration hashes into each release manifest.

## Legacy User Import

`import-legacy-users.mjs` reads the VM106 legacy user export JSON, creates tenants, locations, users, preserved legacy password hashes, and RBAC assignments in the Prisma/Postgres schema, and writes the login-method report outside the repo by default. Run it only against an isolated dev/staging database unless production cutover has been explicitly approved. Legacy `super_admin` rows import as tenant `ADMIN` with an `import_note`; create platform admins only through `bootstrap-production-admin.mjs`.

Example:

```bash
DATA_TARGET_ENV=development \
  node scripts/import-legacy-users.mjs /tmp/legacy-users-20260603.json --report /tmp/imported-user-credentials-20260603.csv
```

`DATA_TARGET_ENV` and a valid `DATABASE_URL` are mandatory. A production cutover must use `production-cutover`, run with `NODE_ENV=production`, set `LEGACY_IMPORT_PRODUCTION_CONFIRM=import-legacy-users-production-cutover`, and set `LEGACY_SOURCE_EXPORT_SHA256` to the exact 64-hex SHA-256 of the selected export. The script hashes the export and rejects a mismatch before loading Prisma.

`apply-db-migrations.mjs` requires `MIGRATION_DATABASE_URL` for the database owner/admin and preserves `DATABASE_URL` for the restricted runtime role. It executes the checked-in repository-local Prisma CLI through Node, avoiding shell or `npx` dependency resolution on Windows and CI. Before any Prisma or raw SQL DDL, it invokes `rotate-webhook-endpoint-secrets.mjs`; plaintext and previous-key endpoint/delivery envelopes are validated and re-encrypted under `WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT`, using `WEBHOOK_DELIVERY_ENCRYPTION_KEY_PREVIOUS` only for bounded overlap; failure stops without printing or destroying credentials. It executes `pre_*.sql` before `prisma db push`, skips immutable superseded bootstrap SQL plus schema-superseded legacy username and RBAC migrations, then installs tenant-context helpers and the platform-admin capability before dependent RLS policies. After schema and raw SQL work, it provisions the restricted app role. Ephemeral CI supplies a fixed test-only webhook key; staging and production must receive their protected runtime key.

## Destructive Data Targets

The development Prisma seed, E2E seed, legacy import, and migration wrapper all use `data-target-guard.mjs` before Prisma loads. Seed scopes reject production environment markers and production-like database URLs. Development seed scopes are `test`, `disposable`, or `development`; E2E accepts only `test` or `disposable` and has no production override. Migration contexts are `test`, `disposable`, `development`, `staging`, or `production`; production requires `DATA_TARGET_ENV=production`, `NODE_ENV=production`, plus `MIGRATION_PRODUCTION_CONFIRM=apply-lunchlineup-production-migrations`. The production launch validator enforces all three values, and production admin bootstrap runs only in that context.

## Deploy Rule

Run `verify-deploy-source.ps1` or `verify-deploy-source.sh` before server rollout. A server deploy must match a clean GitHub-pushed SHA and should leave or verify `DEPLOYED_GIT_SHA`. The verifier accepts normal upstream branches and detached GitHub Actions checkouts when `GITHUB_ACTIONS`, `GITHUB_EVENT_NAME=push`, `GITHUB_REF`, and `GITHUB_SHA` prove the pushed branch head.

Run `verify-release-artifacts.mjs` against the CI `release-manifest` artifact before staging or production rollout. App images must be pinned as `<service>:<git-sha>@sha256:<digest>`, every Dockerfile base image and non-app Compose image must include an immutable `@sha256:` digest, and the deployment contract must bind every raw SQL migration path and digest. Candidate launch-proof entries carry source, command, checksum, byte count, unique URI, and fresh timestamps; candidate launch proof must not contain `externalHealth`. Public release identity is established only after mutation by `verify-external-health-release.mjs`, which requires the served `X-LunchLineup-Release` header to equal `RELEASE_SOURCE_SHA` before release pointers advance. `--launch-proof-mode rollback` verifies an older known-good proof's contract, source, and evidence structure without applying the candidate freshness TTL.

Run `validate-production-launch.mjs /path/to/runtime.env` before production deploys. The bundled production Compose path requires both database URLs to target `postgres:5432/POSTGRES_DB`, so its logical backup and PITR jobs prove recovery for the authoritative database; an external database requires a separate validated recovery architecture. VM217 production deploy reruns it with `--verify-local-secret-files` and refuses mutation unless `BACKUP_ENCRYPTION_KEY_SECRET_FILE` exists and is readable on that host. Production self-service remains closed beta until counsel approves versioned Terms and a future code change updates every enforcement layer. The validator is stricter than CI smoke validation: it rejects `invite_only` or `open`, example or `.test` domains, missing, blank, path-bearing, or non-HTTPS `APP_ORIGIN`, local secret-file paths, public API host binds, any `NEXT_PUBLIC_API_URL` other than same-origin `/api/v1`, mismatched API/web OIDC availability, missing or malformed 32-byte `MFA_SECRET_ENCRYPTION_KEY_CURRENT`, invalid MFA previous-key overlap, missing or malformed 32-byte `WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT`, missing backup off-host/metrics settings, missing retained launch-proof manifest URI, test Stripe keys, missing Stripe prices, meter, or webhook endpoint IDs, metering snapshot intervals above five minutes, and insecure browser endpoint URLs. Production migration runs invoke `bootstrap-production-admin.mjs` only with `DATA_TARGET_ENV=production`; it reconciles the system permission and role catalog and creates the monitored `ADMIN_EMAIL` super-admin plus assignment only when that tenant-bound address does not exist. If that tenant already exists but is not active or is soft-deleted, bootstrap fails before role reconciliation. Existing users are never reactivated, promoted, renamed, or reassigned by migration replay; use an audited account-recovery operation for those changes. The first admin session is then forced through MFA enrollment by the auth policy.

The production GitHub environment must define `PRODUCTION_RUNTIME_SECRET_REFERENCE` and `PRODUCTION_RUNTIME_SECRET_VERSION` as variables identifying one immutable AWS Secrets Manager version. The deploy workflow fetches that exact version into a runner-temp file, runs `validate-production-launch.mjs`, records `PRODUCTION_RUNTIME_ENV_PATH`, `COMPOSE_SERVICE_ENV_FILE`, and `PRODUCTION_RUNTIME_ENV_SHA256` in the job environment, rechecks the file hash immediately before deploy, and deletes the temp file after the production deploy job finishes. Before any deploy mutation, `verify-stripe-meter-config.mjs` uses the live Stripe key in that exact runtime env to retrieve `STRIPE_METER_ID`, every configured plan price, and `STRIPE_WEBHOOK_ENDPOINT_ID`. It requires an active live `last` meter with the worker's exact payload mappings, active live metered recurring prices attached to that meter, and an enabled live webhook endpoint subscribed to every handled entitlement event; those values must exactly match `evidence.stripeMeter` in the decoded launch-proof bytes. The production deploy step binds `PRODUCTION_API_HEALTH_URL` and `PRODUCTION_WEB_URL` from GitHub environment variables plus `LAUNCH_PROOF_MANIFEST_URI` from the protected environment secret into the remote command's inherited environment. These values are not concatenated into the command text. `verify-release-artifacts.mjs` also requires `PRODUCTION_DEPLOY_COMMAND` to forward all three as double-quoted shell variables, so an opaque remote wrapper cannot silently drop or unsafely expand them.

Automatic rollback uses `PRODUCTION_RELEASE_REGISTRY_URI`, not a mutable GitHub rollback-state secret. Before deploy and smoke, CI resolves `index.json`, downloads immutable `releases/<currentSuccessfulSha>.json`, and validates it before creating `PREVIOUS_DEPLOYMENT_APP_DIR`. After all production input preflights, a dedicated completed workflow step durably arms centralized rollback before the remote deploy command can mutate VM217. The arm is independent of remote output, so transport or runner loss at mutation start still triggers rollback. After production smoke passes, CI publishes the candidate SHA-keyed bundle with conditional-create semantics and only then advances the registry index.

`deploy-vm217-remote.sh` defaults to the production artifact path. It pulls only digest-pinned images and starts the stack with `--no-build --pull never`. After mutation, both the public API health endpoint and the public Next.js page must serve `X-LunchLineup-Release: <RELEASE_SOURCE_SHA>`; the API identity artifact is embedded in the retained post-deploy proof before `DEPLOYED_GIT_SHA` and the backup release pointer advance. A mismatch, empty body, proof failure, or failed rollback leaves prior release truth in place.

For rollback, set `VM217_DEPLOY_OPERATION=rollback`. Before production DDL, CI requires retained isolated-clone proof that the previous release passes against candidate schema. The raw gate rejects changed historical digests, approves only classifier-proven additive SQL directly, and requires every non-additive migration to have a digest-bound expand/contract record plus that proof. Rollback retains candidate schema, runs the independent live Prisma diff, and keeps migration mode `skip` with SHA-bound confirmation.

Legacy source-sync helpers remain development-only and require `VM217_DEPLOY_SCOPE=development`.

## CI Smoke Helpers

`write-smoke-env.mjs` defaults to `.env.smoke` so smoke checks do not overwrite an operator `.env`. It generates independent 32-byte keys for webhook delivery and the password-reset delivery outbox. Before DAST or load startup, CI pulls release images through digest-pinned refs from `release-manifest.json` and explicitly pulls the digest-pinned `proxy`, `pgbouncer`, `postgres`, `redis`, and `rabbitmq` Compose images. Only then does it start the stack with `--no-build --pull never`, so a fresh runner cannot fail or drift on an implicit pull.

`run-dast.sh` and `load-test.sh` are executable helpers, not placeholders. They default to `http://localhost`, matching the Compose edge proxy used by CI smoke.

## Observability Config Verification

Run the deterministic structural verifier locally with no Docker or external binaries:

```bash
node scripts/verify-observability-configs.mjs --root .
```

Use `--tool-mode auto` when Caddy, promtool, or amtool may be installed locally. Available host tools are executed; missing tools print equivalent `docker run --rm` fallback commands using the digest-pinned tool images from `docker-compose.yml`.

```bash
node scripts/verify-observability-configs.mjs --root . --tool-mode auto
```

Use `--tool-mode host` to fail if any host tool is missing, or `--tool-mode container` to execute the digest-pinned fallback containers. Container mode requires Docker but is not part of the default local test path.

The same verifier checks the host-level public web probe, hardened systemd unit/timer, node-exporter metric path, critical Prometheus failure/staleness alerts, and checked-in runbook. This probe exercises the public edge without adding egress to an application container.

## Code Organization Note

`deploy-vm217-remote.sh` and `verify-release-artifacts.mjs` remain large deployment-policy owners. The VM-side retained-proof parser is isolated in `verify-downloaded-launch-proof.py`, and the shell script is organized as bounded orchestration functions. A later low-conflict cleanup should split `verify-release-artifacts.mjs` into manifest, command, and proof policy modules while preserving its single CLI contract.

## Backup And Restore Helpers

`backup.sh` writes only encrypted `.sql.zst.gpg` backups, emits a portable `.sha256` file that references the backup basename, keeps local and remote objects 35 days by default, can publish freshness metrics when `BACKUP_METRICS_FILE` points at a Prometheus textfile collector path, and prints `offsite_retention_ok ...` plus `backup_ok ...` proof lines. Remote retention requires a non-root repository, lists only its direct children, accepts only exact timestamped backup/sidecar names for `BACKUP_PREFIX`, and deletes candidates one exact object at a time. Set `BACKUP_OFFSITE_RETENTION_DRY_RUN=true` to list candidates without deletion. Prefer `BACKUP_ENCRYPTION_KEY_FILE` over inline `BACKUP_ENCRYPTION_KEY`. Scheduled S3 uploads read `/run/secrets/backup-offsite/aws-credentials` through `AWS_SHARED_CREDENTIALS_FILE`; rclone uploads read `/run/secrets/backup-offsite/rclone.conf` through `RCLONE_CONFIG`. Compose mounts only the dedicated credential directory read-only and does not forward provider keys or the full runtime env.

Production recurrence is owned by `infrastructure/systemd/lunchlineup-backup.service` and `.timer`. The unit runs the Compose `backup` service only under the `ops` profile, consumes `/run/secrets/backup_key`, forces an offsite target, writes `lunchlineup_backup.prom` into the node-exporter textfile collector, and uses `--pull never` with the last successfully deployed release pointer.

`restore.sh` refuses `latest`, plaintext dumps, missing checksum sidecars by default, production restores without `RESTORE_ALLOW_PRODUCTION=YES_RESTORE_PRODUCTION`, and non-empty targets without `RESTORE_ALLOW_NONEMPTY=YES_OVERWRITE`. Successful restores print `restore_ok ... restored_table_count=...`; set `RESTORE_REQUIRE_CHECKSUM=false` only for an explicitly approved local drill.

`dr-drill.sh` restores an explicit encrypted backup into an ephemeral Postgres container, runs a sanity SQL query, writes a JSON proof file to `DR_PROOF_FILE` or `/tmp/lunchlineup-dr-drill-*.json`, prints `dr_drill_ok ...`, and removes only containers whose names start with `lunchlineup-dr-drill-`. For public-launch proof, download a backup from off-host storage, keep its `.sha256` sidecar beside it, and set `DR_OFFHOST_SOURCE_URI` to the source object or repository:

```bash
BACKUP_FILE=/tmp/lunchlineup-YYYYMMDDHHMMSS.sql.zst.gpg \
DR_OFFHOST_SOURCE_URI=s3://lunchlineup-prod/db-backups/lunchlineup-YYYYMMDDHHMMSS.sql.zst.gpg \
DR_SOURCE_SHA="$(git rev-parse HEAD)" \
BACKUP_ENCRYPTION_KEY_FILE=/run/secrets/backup_key \
./scripts/dr-drill.sh
```

Launch-proof drills must set `DR_SOURCE_SHA` to the release SHA. Their retained JSON `completed_at`/`checked_at` must exactly equal the outer `drDrill.checkedAt`, and `source_sha` must equal the outer evidence `sourceSha`; this makes the outer freshness check apply to the actual restore completion. Local-only drills may set `DR_REQUIRE_OFFHOST_SOURCE=false`; checksum-free drills require `DR_REQUIRE_CHECKSUM=false` and do not satisfy launch proof.
The default DR Postgres image is digest-pinned. Any `DR_IMAGE` override must also include an immutable `@sha256:` digest.

PITR is a separate physical recovery path. PostgreSQL synchronously archives completed WAL through `infrastructure/postgres/archive-wal.sh`; `pitr-base-backup.sh` creates and verifies daily plain-format `pg_basebackup` data, packages it, and uploads `COMPLETE` last. WAL and base-backup writers use separate append-only credentials and apply COMPLIANCE Object Lock to every upload; neither code path can delete archives. Bucket lifecycle expiry is owned by a separate object-store policy/identity that is never mounted in application or data containers. `pitr-restore.sh` uses a third read-only identity and requires one explicit backup ID, UTC target, archived WAL segment, exact confirmation, empty isolated volume, and valid commit marker. Run `pitr-verify-storage.sh` before deployment and follow `docs/runbooks/postgres-pitr-recovery.md`.

## Retained Record Expiry Helper

`invoke-retained-record-purge.mjs` is the scheduler-safe wrapper for `POST /api/v1/admin/retention/purge-expired`. It requires an explicit endpoint URL and bearer token file, defaults to `dryRun: true`, takes a lock, and follows stable continuation pages up to `RETENTION_PURGE_MAX_PAGES` (default 20). Proof and Prometheus textfile output include candidate, deleted-record, processed, failed, and skipped counts. The first application-data page also reports pending and reconciled deletion-billing barriers; Stripe retry failures are included in `failedTenants` and `failedTenantCount`. Any `failedTenants` or remaining continuation at the safety bound makes the wrapper exit nonzero after isolated attempts complete. The token file must contain the generated retention service token that the API also mounts through `RETENTION_PURGE_SERVICE_TOKEN_FILE`; do not use a normal platform-admin JWT.

Example daily dry-run invocation:

```bash
RETENTION_PURGE_URL=https://lunchlineup.com/api/v1/admin/retention/purge-expired \
RETENTION_PURGE_TOKEN_FILE=/run/secrets/retention_purge_token \
RETENTION_PURGE_PROOF_FILE=/var/lib/lunchlineup/proofs/retention-purge-latest.json \
RETENTION_PURGE_METRICS_FILE=/var/lib/node_exporter/textfile_collector/lunchlineup_retention_purge.prom \
RETENTION_PURGE_LOCK_FILE=/var/lock/lunchlineup-retention-purge.lock \
node scripts/invoke-retained-record-purge.mjs
```

The retention service token is restricted by the API to server-time dry-runs and ignores a caller-supplied `asOf`. Reviewed physical purge execution requires an authenticated platform-admin JWT plus `dryRun: false` and `executeConfirmation: purge-expired-retained-records`; the scheduled service token cannot execute it.

## Auth Secret Rotation

`rotate-auth-secrets.mjs` hashes legacy refresh tokens and re-encrypts every non-null `User.mfaSecret` under `MFA_SECRET_ENCRYPTION_KEY_CURRENT` in one serializable platform-admin transaction. It accepts `MFA_SECRET_ENCRYPTION_KEY_PREVIOUS` for bounded v2 overlap and deprecated `MFA_SECRET_ENCRYPTION_KEY` only to read legacy v1 envelopes. The script decrypts all rows before writes, verifies every resulting envelope with the current key alone, and rolls back on any unsupported or undecryptable row. It prints counts and key references only. Follow `docs/runbooks/mfa-encryption-key-rotation.md`; execute only after a successful dry run:

```bash
node scripts/rotate-auth-secrets.mjs
AUTH_SECRET_ROTATION_EXECUTE_CONFIRM=rotate-auth-secrets \
node scripts/rotate-auth-secrets.mjs --execute
```

Success requires `previousDependencyRows: 0`. Remove overlap keys from a local runtime-env copy and rerun the dry run plus production launch validator before deploying current-only configuration. Add `--revoke-sessions` only when the launch plan intentionally forces users with legacy plaintext refresh-token rows to sign in again.

## Disposable VM107 Dev Restore

`bootstrap-vm107-dev.sh` runs on a fresh private Debian dev VM. It sets the guest hostname to `lunchlineup-dev` by default, installs Docker, clones the GitHub branch, creates or reuses `/opt/lunchlineup-secrets/runtime.env`, starts the Docker Compose stack, optionally restores a `.sql`, `.sql.zst`, or `.sql.zst.gpg` Postgres dump, writes `DEPLOYED_GIT_SHA`, and validates direct plus `dev.lunchlineup.com` host-header health. Set `VM107_DESTRUCTIVE_CONFIRM=replace-and-restore-disposable-vm107` before any run that can remove `APP_DIR` or restore `BACKUP_FILE`. It is for disposable development recovery only, not production VM106.

## First Release Registry Bootstrap

An empty registry is not permission to deploy without rollback. Before dispatch, independently retain the secret-free v2 bundle for the release currently serving production. The bundle may contain only the immutable runtime-secret descriptor (provider, reference, VersionId, and SHA-256), never runtime secret bytes.

Run the production workflow manually with:

- `bootstrap_release_registry=true`
- `bootstrap_live_source_sha=<40-character SHA currently served by production>`
- `bootstrap_live_release_bundle_uri=<independent https:// or s3:// retained bundle URI>`
- `bootstrap_confirmation=bootstrap-current-live-release:<same live SHA>`

The protected bootstrap-only dispatch proves the API and web endpoints both serve that exact SHA and imports the retained bundle with conditional-create semantics; it cannot deploy a candidate. On a later push to main, CI resolves and materializes that baseline, verifies its rollback contract and retained launch proof, and runs old-release compatibility against the candidate schema clone before mutation. One retained baseline and a completed rollback-arm step keep the centralized rollback job armed for any later deploy-job or smoke-job failure without depending on the mutating command's output stream. Candidate runtime bytes exist only in mode-0600 runner-temporary files and are deleted; registry objects never contain them.