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
- GitHub production environment variables `PRODUCTION_RUNTIME_SECRET_REFERENCE` and `PRODUCTION_RUNTIME_SECRET_VERSION`, identifying one immutable AWS Secrets Manager version. The referenced secret contains the production runtime env used by `scripts/validate-production-launch.mjs` and must include loopback-only `API_HOST_BIND`, `DATA_TARGET_ENV=production`, `MIGRATION_PRODUCTION_CONFIRM=apply-lunchlineup-production-migrations`, `MFA_SECRET_ENCRYPTION_KEY_CURRENT`, `WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT`, `STRIPE_SECRET_KEY`, `STRIPE_METER_ID`, `STRIPE_METER_EVENT_NAME`, `BACKUP_ENCRYPTION_KEY_SECRET_FILE`, `BACKUP_OFFSITE_URI`, `BACKUP_METRICS_FILE`, `ALERTMANAGER_WEBHOOK_URL_FILE`, `LUNCHLINEUP_STATUS_HEALTH_URL`, `LAUNCH_PROOF_MANIFEST_URI`, and the `LAUNCH_PROOF_*` retained evidence references. The workflow exports only the decoded runner-temp path and SHA as `PRODUCTION_RUNTIME_ENV_PATH`, `COMPOSE_SERVICE_ENV_FILE`, and `PRODUCTION_RUNTIME_ENV_SHA256`; the checked-in VM217 transport consumes those values directly.
- GitHub production variable `PRODUCTION_RELEASE_REGISTRY_URI` naming a retained S3 prefix. Protected registry credentials must allow read, conditional create of immutable `releases/<sha>.json`, `releases/<sha>.sigstore.json`, `indexes/<sha>.json`, and `indexes/<sha>.sigstore.json`, plus update of the signed `index.json` and `index.sigstore.json` pointers. Protected bootstrap and production-smoke jobs require GitHub `id-token: write` solely for keyless signing through the SHA-pinned Cosign installer; no static private signing key is permitted.
- The GitHub `production` environment must have at least two required reviewers, `Prevent self-review` enabled, a nonzero wait timer, and a deployment branch policy restricted to `main`. Keep VM217 host/user/private-key/pinned-known-host inputs, rollback access, release-registry credentials, and runtime-secret credentials environment-scoped. These controls are external GitHub settings and require retained launch evidence; workflow YAML cannot create or prove them. The emergency dispatch is not approved for use until these settings are verified.
- GitHub production secret `OLD_RELEASE_COMPATIBILITY_CLONE_COMMAND`. CI writes it to a mode-`0700` runner-temp driver and invokes `provision`/`destroy` with a run-owned `llc-<run>-<attempt>-<12hex>` clone ID, mode-`0600` clone env path, and the actual production runtime path. The driver may provision/destroy only; it never receives or authors evidence/proof paths. The checked-in harness owns migration, old-release smoke, evidence, finalization, and signing.
- Monitored production addresses for `NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL`, `NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL`, and `NEXT_PUBLIC_DPA_CONTACT_EMAIL`.
- Exact `PUBLIC_SIGNUP_MODE=closed_beta` and `NEXT_PUBLIC_SIGNUP_MODE=closed_beta`. The checked-in Terms are explicitly not counsel-approved or versioned for self-service use, so production validation and runtime guards reject `invite_only` and `open` regardless of invite codes or Turnstile configuration.
- GitHub repository or organization variables for every web build-time public value: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_OIDC_ENABLED`, `NEXT_PUBLIC_SIGNUP_MODE`, `NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL`, `NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL`, `NEXT_PUBLIC_DPA_CONTACT_EMAIL`, `NEXT_PUBLIC_APP_ORIGIN`, `NEXT_PUBLIC_APP_URL`, and `NEXT_PUBLIC_APP_ENV`.
- GitHub staging variables `STAGING_API_HEALTH_URL` and `STAGING_WEB_URL`. Staging may remain Cloudflare Access-protected; in that case, define the paired staging environment secrets `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`, which `verify-external-health-release.mjs` sends together. Both responses must serve `X-LunchLineup-Release: GITHUB_SHA` after access authentication.
- GitHub production variables `PRODUCTION_HEALTH_URL`, `PRODUCTION_API_HEALTH_URL`, `PRODUCTION_WEB_URL`, and `PRODUCTION_POST_DEPLOY_PROOF_COMMAND`. `PRODUCTION_WEB_URL` must be the canonical public HTTPS root and is forwarded to VM217 only by `scripts/deploy-vm217-transport.sh`. The proof command must compare the server `DEPLOYED_GIT_SHA` against `RELEASE_SOURCE_SHA`, run the public API health proof, and match the downloaded launch-proof artifact to `LAUNCH_PROOF_ARTIFACT_SHA256` within `LAUNCH_PROOF_MAX_AGE_SECONDS` before recording its nonzero size.
- Separate managed source files for the four release-path Compose secrets: `CONTROL_PLANE_ADMIN_TOKEN_SECRET_FILE`, `METRICS_TOKEN_FILE`, `ALERTMANAGER_WEBHOOK_URL_FILE`, and `BACKUP_ENCRYPTION_KEY_SECRET_FILE`. Do not reuse a path or credential bytes across these roles; the metrics token is for Prometheus reads only, and the control-plane admin token gates `/api/status` and `/api/control/*`. Provision the data-retention scheduler identity through its dedicated runbook so release proof cannot create or mutate that schedule.
- A versioned Object-Locked non-root S3 logical-backup prefix, `/run/secrets/backup_key`, dedicated mode-`0640` AWS credentials or instance role, lifecycle-owned bounded expiry, an installed `lunchlineup-backup.timer`, and a tested restore path.

## Self-Service Legal Gate

The checked-in Terms are an operational beta draft and are not counsel-approved. This repository therefore permits production closed-beta operation only; existing-workspace login and authenticated operator invitations remain available, but invite-only and open workspace self-service are blocked.

Before either self-service mode can be enabled, counsel must approve final Terms, assign an immutable version, and retain the approval record outside the repository. After that external prerequisite is complete, a reviewed code change must update the checked-in Terms readiness policy, validator, API guard, frontend guard, tests, environment example, and this runbook. Environment changes alone must never open production signup. The `PAID_GA_*` attestation does not satisfy this separate self-service Terms prerequisite. Conversely, `closed_beta` satisfies only the self-service mode gate; it does not waive the production paid-service legal attestation, and the validator must continue to require every `PAID_GA_*` value.

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

Every app image in the manifest, including the one-shot `backup` image, must be pinned as `<service>:<git-sha>@sha256:<digest>`. Every Dockerfile base image, CI service container image, and non-application Compose image must include an immutable `@sha256:` digest. The web image must receive all `NEXT_PUBLIC_*` values as Docker build args; browser bundles do not get corrected by Compose runtime env after the image is built. The staging deploy command must consume `RELEASE_MANIFEST_PATH`, pass `RELEASE_SOURCE_SHA` into one deploy-source verifier before server mutation, and start Compose with all four scope flags, pulled release images, `--no-build`, and `--pull never`. Normal production mutation accepts no command variable: CI directly invokes `scripts/deploy-vm217-transport.sh` with the protected host/user/private-key/pinned-known-host inputs plus the exact manifest, validated runtime env, launch proof, and source SHA. A production deploy stops the backup timers and atomically stages `/var/lib/lunchlineup/backup-release.env` with the candidate image prefix and SHA. Transport passes the exact canonical `/opt/lunchlineup/releases/<sha>` directory as `APP_DIR`; readiness must not append another release segment. Backup readiness snapshots all four installed service/timer unit bytes and both timers' enabled/active states before replacing units; each one-shot renders once, resolves the service image to an immutable local digest, executes a digest-rewritten private Compose config, and must emit exactly one journal completion bound to the read-back systemd InvocationID, retained candidate path, source SHA, and digest. Client limits are 7,260 seconds for the 2-hour logical backup and 21,660 seconds for the 6-hour PITR job. A timeout must capture the InvocationID, prove the service terminal, remove the immutable candidate container ID, and prove no survivor before old unit bytes are restored. Every failure restores and verifies the exact snapshot, and cleanup failure is terminal. The deploy restores the previous pointer on readiness failure and commits the staged pointer only after one-shot backup/PITR proof succeeds. Do not deploy `latest`, `local`, tag-only images, or images built directly on the server. If `verify-release-artifacts.mjs` prints `launch_proof=not_checked`, the release artifact check is incomplete for public launch.

## Signed SBOM And Vulnerability Reports

For every `release-manifest` image, the main-branch workflow retains the Syft SPDX report or Trivy JSON report, a versioned evidence document containing the report SHA-256, source SHA, manifest SHA-256, image reference, and image digest, plus a Sigstore verification bundle. The trusted GitHub Actions workflow keylessly signs the evidence and publishes it as a `custom` OCI attestation whose in-toto subject is the exact image digest. Both the matrix job and aggregate release gate require the expected workflow certificate identity, GitHub OIDC issuer, valid blob signature, exact predicate bytes, and exact digest subject. Missing Cosign, missing registry evidence, deletion, signer drift, report tampering, source drift, or digest drift fails closed.

Both SBOM and vulnerability artifacts use `retention-days: 90`, the maximum allowed for this public repository. The aggregate gate also publishes the release manifest and all 42 report, evidence, and Sigstore files as a source-SHA-tagged GitHub prerelease. `publish-release-evidence.mjs` fails before mutation unless repository release immutability is enabled, then verifies the published release is immutable and all 43 remote asset names, sizes, and SHA-256 digests match local bytes. Do not delete the release tag or substitute an Actions artifact for the immutable evidence release.

Before launch, enable immutable releases under repository Settings > General > Releases and retain the successful `release-evidence-<sourceSha>` URL with launch evidence. GHCR must grant this repository `packages: write` only to the protected main workflow and `packages: read` to release verification. Remove package-admin/delete permission from routine automation, and configure every cleanup policy to preserve deployed SHA image manifests and their Sigstore `.att` referrers for at least 365 days. If a registry attestation is deleted, release verification fails closed even though the immutable GitHub release retains the signed offline proof.

## Launch Proof Manifest

Keep `.release/launch-proof.json` with the release evidence. It must use the same `sourceSha` as `release-manifest.json`, `version: 1`, an ISO `generatedAt`, and these `evidence` entries:

- `runtimeEnv`: `scripts/validate-production-launch.mjs` proof for the production runtime env.
- `stripeMeter`: the expected commit SHA, Stripe meter ID, event name and payload mappings, attached metered plan prices, enabled webhook endpoint and handled event set, `aggregation: last`, `livemode: true`, and `meterStatus: active`; the production workflow compares these values to live Stripe API retrievals.
- `dast`: DAST artifact or run URL.
- `load`: load-smoke artifact or run URL.
- `drDrill`: retained DR JSON proof URI, `backupSha256`, `restoredTableCount`, exact off-host backup `sourceUri`, and artifact `completed_at`/`checked_at` plus `source_sha` that exactly match the outer `checkedAt` and `sourceSha`.
- `pitrDrill`: retained PITR JSON proof URI with exact immutable version IDs for `COMPLETE`, base archive, manifest, and WAL; fresh provider principal/request readback; a successful paused restore; passing invariants; and ordered timestamps.
- `alertRoute`: production critical-alert route proof URL.
- External health is not a predeploy launch-proof entry. The deploy and production-smoke gates query the public endpoint after mutation and require `X-LunchLineup-Release` to equal the candidate SHA.

Each entry must have `status: passed` or `status: ok`, matching `sourceSha`, unique retained `uri`, `checkedAt`, `summary`, generating `command`, `exitCode: 0`, retained artifact `artifactSha256`, and positive `artifactBytes`. `checkedAt` must not be later than top-level `generatedAt`; generation and evidence timestamps must be within the 86,400-second production freshness bound and no more than five minutes in the future. Do not use `skipped`, `pending`, `latest`, or `current` references. Start from `docs/testing/launch-proof-template.json`, but replace every placeholder with real retained artifact metadata before verification. Retained-record expiry scheduling belongs in `data-retention-delete-export.md`; this launch proof must not create a second purge scheduler or mark retained-record expiry complete.

Build the candidate proof with `node scripts/build-launch-proof-manifest.mjs --input /secure/path/launch-proof-builder-input.json --output .release/launch-proof.json`. The private builder input names `sourceSha`, `generatedAt`, `maxAgeSeconds`, and one descriptor for each `runtimeEnv`, `dast`, `load`, `drDrill`, `pitrDrill`, and `alertRoute` artifact. Every descriptor supplies the local `path`, retained immutable public HTTPS `uri`, `capturedAt`, producer identity, and retention class. The builder reads and validates the exact artifact bytes, emits their SHA-256 and size without local paths or secrets, refuses to overwrite an existing output, and produces deterministic JSON for the existing `verify-production-launch-proof.mjs` and Stripe checks. The verifier opens the manifest/proof once into private snapshots; when protected HTTPS retrieval needs `LAUNCH_PROOF_HTTP_BEARER_TOKEN`, it writes the header to a mode-0600 curl config and removes the token from provider argv/environment.

## Runtime Environment Verification

Before opening production traffic, validate the same runtime env values that the production deployment will use:

```bash
node scripts/validate-production-launch.mjs /path/to/production-runtime.env
node scripts/verify-stripe-meter-config.mjs /path/to/production-runtime.env .release/launch-proof.json --source-sha "$(git rev-parse HEAD)"
```

GitHub production deploys must provide `PRODUCTION_RUNTIME_SECRET_REFERENCE` and `PRODUCTION_RUNTIME_SECRET_VERSION` as production environment variables. The deploy workflow fetches that exact immutable secret version into a runner-temp file, runs `scripts/validate-production-launch.mjs`, records the temp path and SHA in `PRODUCTION_RUNTIME_ENV_PATH`, `COMPOSE_SERVICE_ENV_FILE`, and `PRODUCTION_RUNTIME_ENV_SHA256`, rechecks the SHA immediately before server mutation, and deletes the temp file after the job finishes. Do not store the decoded env file in the repository, workflow logs, release artifacts, or server checkout. Production migration execution additionally requires exact `DATA_TARGET_ENV=production` and `MIGRATION_PRODUCTION_CONFIRM=apply-lunchlineup-production-migrations`; Compose passes the target into the `migrate` container, and the confirmation comes from the same service env file. Production restore supplies `MIGRATION_DATABASE_URL` to target validation through the protected child environment, never child argv, and reasserts the signed PostgreSQL system identifier as the first statement inside the exact destructive single transaction. The validator rejects public API host binds, relative or repo-local Compose/PITR secret paths, unreadable or cross-role reused credential files during host-local verification, local backup paths, runtime `DATABASE_URL` query parameters or fragments that are not portable between Prisma and Python libpq, missing `MFA_SECRET_ENCRYPTION_KEY_CURRENT`, missing or malformed `WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT`, missing backup freshness textfile output, internal status health URLs, missing public contact emails or placeholder contact domains, signup mode drift, any production signup mode other than `closed_beta`, a missing or non-HTTPS `LAUNCH_PROOF_MANIFEST_URI`, and missing or vague `LAUNCH_PROOF_*` evidence references.

## CI-To-VM217 Transport Contract

Use `scripts/deploy-vm217-transport.sh` from a GitHub-hosted Linux runner with explicit `--host`, `--user`, `--private-key`, `--known-hosts`, `--release-manifest`, `--runtime-env`, `--launch-proof`, and full 40-character `--source-sha` arguments. The private key and runtime env must be non-empty, non-symlink files with mode `0400` or `0600`; the pinned `known_hosts`, manifest, and proof must be owner-readable and not group- or world-writable. The `known_hosts` file must contain a pinned host-key entry provisioned through the protected production environment, not a key learned during the deployment job.

The normal production job captures its deadline origin before checkout. `scripts/validate-production-deploy-deadlines.mjs` then owns one absolute setup-to-cleanup schedule: checkout, tool setup, release verification, compatibility clone provisioning, exact-root preflight, provider execution, and every other completed preflight debit the deploy window. Each child timeout is derived immediately before launch from the remaining absolute phase time and reserves TERM-to-KILL escalation. Compatibility clone destruction is armed before provisioning and has its own pre-mutation reserve; the fixed checked-in VM217 transport then runs under the remaining mutation deadline. Separately reserved absolute windows guarantee exact-state reconciliation and final clone/runtime-secret cleanup before the 5,400-second GitHub cutoff, while an idempotent `always()` fallback may spend only the final runner reserve.

The helper uses `StrictHostKeyChecking=yes`, the supplied `UserKnownHostsFile`, batch mode, password/keyboard-interactive authentication disabled, one connection attempt, explicit connect timeout, and explicit server-alive interval/count for every `ssh` and `scp` operation. `scripts/vm217-transport-deadlines.sh` starts its aggregate mutation budget before the first remote staging allocation or upload and also applies finite per-operation and cleanup deadlines. Budget exhaustion prevents the next mutation, runs bounded exact-state reconciliation, and leaves the independently bounded EXIT cleanup armed. The helper creates only a random `/tmp/lunchlineup-ci-transport.*` directory on VM217, copies the manifest, runtime env, and launch proof under fixed names, forces remote mode `0600`, and compares each remote SHA-256 to the local bytes before invoking the deployment entrypoint. The configurable `--remote-entrypoint` must be a safe repository-relative file tracked in the runner checkout, and its VM217 bytes must match that checked-in file. Invocation uses literal `bash` plus fixed environment assignments; `eval`, a caller-selected shell, and shell command text from a variable are not allowed.

The remote entrypoint receives `APP_DIR`, `RELEASE_SOURCE_SHA`, `RELEASE_MANIFEST_PATH`, `PRODUCTION_RUNTIME_ENV_PATH`, `COMPOSE_SERVICE_ENV_FILE`, `PRODUCTION_RUNTIME_ENV_SHA256`, `LAUNCH_PROOF_PATH`, `LAUNCH_PROOF_ARTIFACT_SHA256`, and `TRANSPORT_RELEASE_MANIFEST_SHA256`. When present in the protected job environment, the fixed remote wrapper also forwards `PRODUCTION_API_HEALTH_URL`, `PRODUCTION_WEB_URL`, `LAUNCH_PROOF_MANIFEST_URI`, and `LAUNCH_PROOF_MAX_AGE_SECONDS`; string values are base64-encoded for transport and decoded without `eval` or command interpolation. The entrypoint remains responsible for deployment policy and post-mutation proof. The transport removes the remote staging directory on success, failure, interruption, or entrypoint exit; cleanup is independently deadline-bounded, and cleanup failure makes an otherwise successful transport fail. Exit `124` plus the fixed `remote state is unknown` diagnostic means do not retry blindly: keep centralized rollback armed and independently inspect VM217 release identity first. Runtime bytes are never printed. Network and VPN credentials remain external to this helper and must be provisioned by the protected runner or network layer.

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

## Container Resource And Log Governance

The production Compose baseline gives every service finite CPU, memory, PID, open-file, and Docker JSON log-retention ceilings. The shared runtime anchors default to one CPU, 512 MiB, 256 PIDs, a 4,096 soft/8,192 hard file-descriptor limit, and five 10 MiB log files. API, web, migration, worker, scheduling, database, broker, backup/PITR, and stateful observability services declare higher reviewed ceilings where their workload requires them.

Before public traffic, render the configuration through the canonical scoped production Compose command documented in the server checks below and run the release load smoke against the exact deployment host. Then inspect `docker stats --no-stream` and container OOM/restart counts. A limit increase requires a reviewed Compose change and a repeated load smoke; do not remove the ceiling. Launch is blocked if any service is unbounded, repeatedly CPU-throttled, OOM-killed, PID-starved, unable to open required files, or able to grow local Docker logs without rotation.
## Hostile PDF Isolation

Availability PDF parsing must run only in the Compose `pdf-parser` service. The worker-side client may validate and transfer bounded bytes but must not import `pypdf` or parser implementation code. `pdf-parser` must retain `network_mode: none`, a read-only root, all capabilities dropped, `no-new-privileges`, non-root UID 10001, bounded `/tmp`, and only the `parser_ipc` Unix-socket volume. It must not receive the availability upload volume, database, RabbitMQ, Stripe, Resend, password-reset, telemetry, engine, or other production credentials.

The parser service accepts one document, stores it only in container tmpfs, executes the parser child with CPU, address-space, file, descriptor, result, and wall-clock bounds, returns a bounded response, and exits. `restart: unless-stopped` creates a fresh container process set before another tenant document is accepted. Launch is blocked if the parser can reach a production network, read worker/API secrets or upload storage, keep a parser process alive across documents, or start without the Unix-socket healthcheck.

Before public traffic, run `node --test tests/deploy/container-runtime-hardening.test.mjs`, inspect `docker inspect` for `NetworkMode=none`, an empty secret-bearing environment, a read-only root, dropped capabilities, and the single parser IPC mount, then submit one rejected and one valid PDF through the worker client. Confirm the parser container restarts after each document and the durable import result/refund behavior remains correct.
Production deploy must start `pdf-parser` explicitly before the full stack and include it in required-service health proof. After startup, stop `pdf-parser` in a non-production rehearsal and confirm `lunchlineup_pdf_parser_ready` becomes `0`, the worker healthcheck fails, and `PdfParserUnavailable` enters pending/firing after two minutes; restore the parser and confirm recovery. `PdfParserReadinessMissing` must fire when the worker scrape cannot expose the gauge. Run the bounded concurrent availability-import smoke with an active paid subscription and separately purchased credits; every accepted import must reach `SUCCEEDED` without increasing parser concurrency.

## Backup And Restore Proof

Before public traffic:

- Provision `/run/secrets/backup_key` from the managed secrets backend with owner `root`, group `lunchlineup`, and mode `0640`. Set `BACKUP_ENCRYPTION_KEY_SECRET_FILE=/run/secrets/backup_key`; never place the passphrase in `BACKUP_ENCRYPTION_KEY` or an env file. The remote deploy validates that exact host source path as readable before pulling or starting candidate services.
- Provision `/etc/lunchlineup/backup-offsite` with owner `root`, group `lunchlineup`, mode `0750`, and only mode-`0640` AWS credentials/config, or use a dedicated instance role. Mutable rclone is not production-capable.
- Set an exact non-root `BACKUP_OFFSITE_URI=s3://bucket/prefix`, `BACKUP_OFFSITE_RETENTION_DAYS=35`, `BACKUP_OFFSITE_RETENTION_DRY_RUN=false`, and `BACKUP_OFFSITE_LIFECYCLE_MAX_DAYS=90`. The bucket must prove versioning, default COMPLIANCE Object Lock, bounded current/noncurrent lifecycle expiry, and unconditional all-principal object/version-delete denial for the exact prefix.
- Install `infrastructure/systemd/lunchlineup-backup.env.example`, `.service`, and `.timer` exactly as documented in `infrastructure/systemd/README.md`. Confirm the last successful deploy created `/var/lib/lunchlineup/backup-release.env`.
- Run the same one-shot path used by the timer, then enable recurrence:

  ```bash
  systemctl start lunchlineup-backup.service
  journalctl -u lunchlineup-backup.service -n 50 --no-pager
  test -s /var/lib/node_exporter/textfile_collector/lunchlineup_backup.prom
  systemctl enable --now lunchlineup-backup.timer
  systemctl list-timers lunchlineup-backup.timer
  ```

  The unit executes the checked-in systemd backup path. Its private Compose invocation fixes the project name to `lunchlineup`, carries the exact retained candidate project directory, runtime env file, and Compose file, and uses `--profile ops`, `run --detach --no-deps`, and `--pull never`. The wrapper owns the exact returned container ID through bounded wait, logs, removal, and absence readback. Release SHAs must never change the project name or persistent volume identity. The job must use the deployed backup image and must not build or pull on the production host.
- Confirm fresh matching `offsite_retention_ok mode=lifecycle_owned`, `offsite_immutable_ok` exact object/checksum versions plus principal/time, and `backup_ok expiry_owner=lifecycle`. Verify both exact version IDs independently. The job performs no remote deletion; lifecycle owns expiry.
- Query Prometheus for `lunchlineup_backup_last_success_timestamp_seconds`, then confirm `BackupMissingTelemetry` and `BackupStale` are inactive. The metric file alone is insufficient without the offsite object and checksum sidecar.
- Select one immutable off-host backup object version and obtain its expected SHA-256 through the provider's authenticated inventory/readback path. Do not pre-download or reuse local backup bytes, and do not use a `latest` alias. Provision a trusted non-symlink, non-group/world-writable fetch adapter that implements the `DR_FETCH_*` contract documented in `scripts/README.md` and performs provider GET plus version readback.
- Retrieve and restore that exact off-host backup into a new disposable path and environment, not production:

  ```bash
  BACKUP_FILE=/tmp/lunchlineup-YYYYMMDDHHMMSS.sql.zst.gpg \
  DR_OFFHOST_SOURCE_URI=s3://lunchlineup-prod/db-backups/lunchlineup-YYYYMMDDHHMMSS.sql.zst.gpg \
  DR_OFFHOST_SOURCE_VERSION=<immutable-provider-version-id> \
  DR_OFFHOST_EXPECTED_SHA256=<64-hex-backup-sha256> \
  DR_OFFHOST_FETCH_COMMAND=/usr/local/libexec/lunchlineup-fetch-dr-backup \
  DR_OFFHOST_READBACK_COMMAND=/usr/local/libexec/lunchlineup-readback-dr-backup \
  DR_SOURCE_SHA="$(git rev-parse HEAD)" \
  BACKUP_ENCRYPTION_KEY_FILE=/run/secrets/backup_key \
  ./scripts/dr-drill.sh
  ```

- Capture `dr_drill_ok` and retained JSON only after bounded removal by the full immutable Docker container ID and independent exact-ID plus reserved-name absence readback. The JSON must bind `container_id=cleanup_container_id`, both ID/name absence booleans, `cleanup_id_evidence=docker-ps-exact-id-v1`, and the cleanup timestamp; rename/replacement, cleanup failure, or uncertain absence must exit nonzero and invalidate the artifact. The database password is written only to the drill's private Docker env file, never Docker CLI arguments. Both adapters must be exact executables pinned by an externally retained short-lived signed recovery-adapter attestation. Supply its local bytes, immutable attestation/signature URIs, and fixed protected workflow certificate identity/OIDC issuer. The drill verifies Cosign before retrieval; launch verification independently fetches and verifies those retained bytes plus the signed execution/readback/target/outcome/cleanup binding. Arbitrary adapter bytes, missing cleanup evidence, or forged self-consistent caller JSON fail.
- Confirm restored API health and at least one tenant-scoped schedule query if this backup is promoted into a disposable app stack after the database-only drill.
- Confirm the Prometheus backup freshness alerts continue to see `lunchlineup_backup_last_success_timestamp_seconds` after node-exporter and Prometheus restart.

## PITR Immutable Storage Proof

Before public launch and before the production deploy mutation marker:

- Provision distinct managed WAL append-only, base-backup append-only, restore read-only, and lifecycle-audit read-only credential directories, each containing readable `access_key` and `secret_key` files. Never reuse one file path or credential value across these or Compose secret roles. Set exact `PITR_ENABLED=true` and `PITR_ARCHIVE_MODE=on`; all non-PITR Compose renders must keep Postgres archiving off.
- Enable bucket versioning and default COMPLIANCE Object Lock for `PITR_OBJECT_LOCK_RETENTION_DAYS` of at least 14 days.
- Configure enabled untagged rules for exactly `$PITR_S3_PREFIX/` that expire current versions no earlier than Object Lock, expire every noncurrent version, clean expired delete markers, and keep current plus noncurrent expiry within `PITR_LIFECYCLE_MAX_RETENTION_DAYS` (greater than immutable retention and no more than 90).
- Retain the canonical lifecycle envelope at `PITR_LIFECYCLE_POLICY_PROOF_URI` and on the deployment host at `PITR_LIFECYCLE_POLICY_PROOF_FILE`. Its digest must equal `PITR_LIFECYCLE_POLICY_SHA256`.
- Pin a protected provider authorization simulator executable and digest with `PITR_AUTHORIZATION_SIMULATOR_FILE` and `PITR_AUTHORIZATION_SIMULATOR_SHA256`. Run `scripts/pitr-verify-storage.sh` with candidate release inputs. Require both writer lines, authorization-simulation lines for restore and lifecycle-audit, `pitr_lifecycle_policy_ready`, and `pitr_storage_readiness_ok`; any missing required read, allowed prohibited mutation, simulator drift, permission failure, successful writer delete, versioning/Object Lock mismatch, early or unbounded lifecycle rule, retained-proof mismatch, or policy digest drift blocks deployment.
- Keep lifecycle administration in a separately managed external object-store identity. The one-shot audit container receives only read-only lifecycle inspection credentials; no lifecycle-administrator or delete credential may be mounted in application, migration, Postgres, backup, restore, or audit containers.
## Alert And Runbook Proof

- Confirm `alert_targets` contains at least one production paging route and Alertmanager routes every `critical` alert to that target.
- Confirm every alert in `infrastructure/prometheus/alerts/lunchlineup.yml` has a `runbook` annotation pointing at an existing `docs/runbooks/*.md` file.
- Confirm Prometheus scrapes `webhook-replay:3004`, `WebhookReplayNotReady` is enabled, and `lunchlineup_webhook_replay_ready{job="webhook-replay"}` is `1` after startup.
- Confirm the API scrape exposes `lunchlineup_dependency_up` value `1` for `database`, `redis`, and `rabbitmq`; `RequiredApiDependencyUnavailable` is inactive; and `/health` returns `503` when any required dependency is stopped or unreachable.
- Query `NotificationOutbox` by `status` before launch and after each publish smoke test. `PENDING`, `FAILED`, or expired `PROCESSING` rows must clear through the API sweeper; any `DEAD_LETTERED` row and its redacted `lastError` requires operator triage. Error logs include `Notification outbox terminal failure` with intent and tenant IDs. Recovery tuning is bounded by `NOTIFICATION_OUTBOX_POLL_INTERVAL_MS`, `NOTIFICATION_OUTBOX_LEASE_MS`, `NOTIFICATION_OUTBOX_BATCH_SIZE`, and `NOTIFICATION_OUTBOX_MAX_ATTEMPTS`.
- Confirm Grafana, Loki, Tempo, and Prometheus are private or authenticated.

## Launch Blocks

Stop the production deploy if any of these are true:

- Terraform reports any `missing_required_inputs`.
- `npm run audit:prod` fails, or npm adds any production advisory outside the exact documented Next/PostCSS moderate triage.
- `.release/release-manifest.json` is missing or fails `scripts/verify-release-artifacts.mjs`.
- `.release/launch-proof.json` is missing, uses a different `sourceSha`, contains skipped/pending evidence, omits per-entry command/checksum/size/source metadata, or fails `scripts/verify-release-artifacts.mjs --launch-proof-file`.
- `PRODUCTION_RUNTIME_SECRET_REFERENCE` or `PRODUCTION_RUNTIME_SECRET_VERSION` is missing, the immutable secret version cannot be fetched, or the fetched runtime env fails `scripts/validate-production-launch.mjs`.
- A Syft or Trivy release report, signed evidence bundle, exact-digest OCI attestation, 90-day Actions artifact, immutable `release-evidence-<sourceSha>` release, or required GHCR retention/access proof is missing or fails verification.
- The retained release registry cannot cryptographically verify the signed pointer, immutable index, and release bundle against the exact trusted workflow identity and GitHub OIDC issuer; their source SHA or bundle digest differs; Cosign is unavailable; the immediately previous successful SHA cannot resolve; the isolated-clone compatibility artifact is missing/stale/mismatched; or old-release smoke fails against candidate schema.
- Stripe cannot authoritatively retrieve `STRIPE_METER_ID`, or the live meter is not active/live, does not use `STRIPE_METER_EVENT_NAME`, does not aggregate with `last`, or does not exactly match `.release/launch-proof.json` evidence.
- The production runtime env does not set exact `DATA_TARGET_ENV=production` and `MIGRATION_PRODUCTION_CONFIRM=apply-lunchlineup-production-migrations` before the migration container starts.
- `PRODUCTION_API_HEALTH_URL`, canonical root `PRODUCTION_WEB_URL`, or `PRODUCTION_POST_DEPLOY_PROOF_COMMAND` is missing, or the proof command does not verify `DEPLOYED_GIT_SHA` against `RELEASE_SOURCE_SHA`, public API health, retained proof checksum, and nonzero proof-artifact size.
- The API health response is degraded, any required `lunchlineup_dependency_up` series is absent or zero, or `RequiredApiDependencyUnavailable` is firing.
- Any production image reference, Dockerfile base image, CI service image, or non-app Compose service image uses a mutable tag instead of a digest.
- The release manifest omits `backup`, `/var/lib/lunchlineup/backup-release.env` does not select the deployed SHA, or the timer would build or pull an image on the server.
- Any secret, password, token, private key, `.env`, backup payload, or generated credential is tracked in Git.
- The public Compose baseline mounts `/var/run/docker.sock` into a default-profile service, mounts it into `control`, places `control` on `data` or `external`, or uses the metrics token for admin/control actions.
- Any production Compose service lacks a finite CPU, memory, PID, open-file, or Docker log-retention ceiling, or the exact-host load smoke shows repeated throttling, OOM kills, PID exhaustion, file-descriptor exhaustion, or restart loops under the reviewed limits.
- Backup restore has not been rehearsed from the same off-host repository through `scripts/dr-drill.sh` with `DR_OFFHOST_SOURCE_URI`, or the retained signed JSON does not prove successful cleanup and exact disposable-container absence after the drill.
- `lunchlineup-backup.timer` or `lunchlineup-pitr-base-backup.timer` is not installed, enabled, and active; candidate-image one-shots do not prove offsite logical backup plus PITR base backup; fresh metrics are absent; or `BackupMissingTelemetry`/`BackupStale` is firing.
- PITR writer credentials are shared or can delete; the digest-pinned provider simulator cannot prove both read-only identities or reports any allowed write/delete/retention/lifecycle/policy/bucket mutation; bucket versioning/default COMPLIANCE Object Lock is absent or mismatched; exact-prefix current, noncurrent, or delete-marker lifecycle rules are missing, early, or above the declared maximum; the live canonical policy differs from the retained proof/digest; required authorization, `pitr_lifecycle_policy_ready`, or `pitr_storage_readiness_ok` evidence is missing before mutation; or lifecycle-administrator/delete credentials are mounted in any application, data, or audit container.
- `LUNCHLINEUP_STATUS_HEALTH_URL`, `ALERTMANAGER_WEBHOOK_URL_FILE`, `LAUNCH_PROOF_MANIFEST_URI`, or any required `LAUNCH_PROOF_*` reference is missing, points at local/test/example values, or uses a vague `latest`/`current` alias; `LAUNCH_PROOF_MANIFEST_URI` must additionally be a retained HTTPS JSON URL.
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
docker compose \
  --project-name lunchlineup \
  --project-directory /opt/lunchlineup/current \
  --env-file /var/lib/lunchlineup/runtime-env/current \
  -f /opt/lunchlineup/current/docker-compose.yml \
  ps
docker compose \
  --project-name lunchlineup \
  --project-directory /opt/lunchlineup/current \
  --env-file /var/lib/lunchlineup/runtime-env/current \
  -f /opt/lunchlineup/current/docker-compose.yml \
  logs --tail=100 api worker engine
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

The VM217 deploy helper checks the public API through `PRODUCTION_API_HEALTH_URL` and the canonical public root through `PRODUCTION_WEB_URL`. The root probe rejects redirects, non-HTML and undersized responses, pages missing either the LunchLineup heading or a Next.js static asset reference, and any `X-LunchLineup-Release` header that does not equal `RELEASE_SOURCE_SHA`. Before mutation, the independently served live SHA must equal the authenticated registry current SHA. Before writing success proof the helper also requires healthy worker, engine, webhook replay, Prometheus, and Alertmanager containers. Protected launch-proof retrieval keeps the full URI in a private curl config and records only its redacted public identity. A failed gate leaves `DEPLOYED_GIT_SHA` unchanged and causes centralized rollback to consume the exact signed digest-bound compatibility proof through the checked-in VM217 rollback transport. CI then independently runs API health and strict canonical public-HTML checks; only after they pass does CI repoint and authenticated-readback the registry current pointer to the rollback SHA. The CI production smoke job repeats the public web/API checks, then runs `PRODUCTION_POST_DEPLOY_PROOF_COMMAND` with `RELEASE_SOURCE_SHA`, `LAUNCH_PROOF_ARTIFACT_SHA256`, and `LAUNCH_PROOF_MAX_AGE_SECONDS` in the environment. The API health response includes database, Redis, and RabbitMQ checks; any failed RabbitMQ connection returns `503`, causing the launch gate to fail. Expected result: the release header, both web markers, and health responses are successful; the database, Redis, and RabbitMQ `lunchlineup_dependency_up` series are each `1`; `DEPLOYED_GIT_SHA` matches the pushed GitHub commit; the authenticated current pointer matches the proven live SHA; and no critical alerts fire during the first 15 minutes.

## First Release Registry Bootstrap

When the retained release registry is empty, run the production workflow manually with `bootstrap_release_registry=true`, `bootstrap_live_source_sha=<40-character current live SHA>`, `bootstrap_live_release_bundle_uri=<independently retained v2 bundle URI>`, and `bootstrap_confirmation=bootstrap-current-live-release:<same live SHA>`. CI requires exactly one proof for the configured API health URL and exactly one strict public-HTML proof for the canonical HTTPS root, both serving exact release headers for that live SHA. It validates the retained v2 rollback bundle, creates a deterministic digest-bound index, and keylessly signs both bundle and index with the protected `ci.yml@refs/heads/main` GitHub OIDC identity before conditional publication. Bootstrap cannot deploy a candidate. Launch remains blocked if either signature, expected identity/issuer, source SHA, bundle digest, exact surface URL, or proof fails. Sigstore bundles are retained with the release; runtime bytes remain in runner temporary storage and are never uploaded.

## Legacy PHP Initial VM217 Cutover

Use `scripts/initial-vm217-cutover.sh` exactly once when production is still the legacy PHP service and therefore cannot provide a v2 release identity header or retained v2 rollback bundle. This is an explicit operator path, not a CI registry fallback. Run it only from a protected Linux runner after all normal candidate release, runtime, launch-proof, and public readiness gates pass.

Before invocation, provision three executable files outside the checkout:

- The snapshot executable creates a VM217 recovery snapshot and publishes the required JSON attestation to one immutable `https://` or `s3://` object.
- The proof-fetch executable independently retrieves those exact retained bytes into the new path supplied by `--rollback-proof`.
- The rollback executable restores the attested legacy snapshot if candidate transport fails after mutation starts.

All three executables must be non-symlink regular files, owner-executable, and not group- or world-writable. Snapshot, proof-fetch, and rollback run under independent finite deadlines; a timed-out snapshot is reconciled only by a valid independently fetched durable proof, proof-fetch retries once before blocking mutation, and a timed-out rollback is accepted only after pinned-host readback proves the v2 marker absent. The fetched proof must be mode `0400` or `0600`, fresh, and bind VM ID `217`, `legacySystem=php`, the exact candidate SHA, VM217 host, snapshot reference, retained URI, and SHA-256 digests of the snapshot, proof-fetch, and rollback executables. The proof path must not exist before retrieval and must remain outside the checkout. External executables receive `INITIAL_CUTOVER_PRIVATE_KEY`, `INITIAL_CUTOVER_KNOWN_HOSTS`, and `INITIAL_CUTOVER_SSH_STRICT_HOST_KEY_CHECKING=yes`; they must use those pinned inputs for any SSH operation.

```bash
bash scripts/initial-vm217-cutover.sh \
  --host "$VM217_HOST" --user "$VM217_USER" \
  --private-key "$VM217_PRIVATE_KEY" --known-hosts "$VM217_KNOWN_HOSTS" \
  --release-manifest .release/release-manifest.json \
  --runtime-env "$PRODUCTION_RUNTIME_ENV_PATH" --launch-proof .release/launch-proof.json \
  --source-sha "$RELEASE_SOURCE_SHA" \
  --snapshot-command "$EXTERNAL_SNAPSHOT_EXECUTABLE" \
  --proof-fetch-command "$EXTERNAL_PROOF_FETCH_EXECUTABLE" \
  --rollback-command "$EXTERNAL_ROLLBACK_EXECUTABLE" \
  --rollback-proof "$RUNNER_TEMP/initial-vm217-rollback-proof.json" \
  --durable-proof-uri "$INITIAL_CUTOVER_DURABLE_PROOF_URI" \
  --confirm "initial-vm217-cutover-from-legacy-php:$RELEASE_SOURCE_SHA"
```

The wrapper revalidates the pinned VM217 `known_hosts` entry and refuses the initial path if `/opt/lunchlineup/DEPLOYED_GIT_SHA` already exists, forcing every later v2 deployment back through the strict registry workflow. It delegates the candidate only to `deploy-vm217-transport.sh`, which enforces `StrictHostKeyChecking=yes` and exact staged hashes. If delegated transport fails after mutation starts, the wrapper runs the digest-bound external rollback executable and still exits nonzero. A successful run does not seed, relax, or bypass the retained release registry. Immediately retain the successful v2 bundle and use the existing exact dual-header `bootstrap_release_registry` workflow; all later deploys remain blocked until that strict bootstrap succeeds. Keep the external legacy snapshot and durable proof until the registry baseline and v2 rollback drill are proven.
