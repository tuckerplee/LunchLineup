# Testing And Migration Controls

This document maps the first rebuild test layer. It covers SaaS behavior, legacy parity, security hygiene, operations hygiene, and deploy discipline before the platform is pushed to a server.

## Files

- `dependency-audit.md`: production npm audit gate and Next/PostCSS advisory triage.
- `launch-proof-template.json`: fill-in template for retained public-launch proof manifests.
- `README.md`: this testing and migration control map.

## Test Commands

Run the fast migration guardrails:

```bash
npm run test:migration
```

This includes deploy-source, Compose readiness, repository hygiene, migration, and production Terraform contract tests.

Run the full workspace test suite:

```bash
npm test
```

Run the CI unit gate with coverage:

```bash
npx turbo run test -- --coverage
```

The API coverage thresholds are a ratcheted baseline for the current rebuild state: 40% lines, 39% statements, 38% functions, and 34% branches. Raise these thresholds as migration coverage expands. The web Storybook tests run through Vitest browser mode, so CI installs the Playwright Chromium browser before the unit gate.

Run the production dependency audit gate:

```bash
npm run audit:prod
```

`dependency-audit.md` records the current Next/PostCSS moderate advisory triage and the removal rule once a stable Next release carries the patched nested PostCSS dependency.

Run browser smoke tests from the web app when the stack is available:

```bash
npm --workspace @lunchlineup/web run test:e2e
```

Run the focused public status and accessibility smoke:

```bash
npm --workspace @lunchlineup/web run test:e2e -- tests/e2e/public-status-accessibility.spec.ts --project=chromium
```

In CI, the default web E2E gate runs Playwright from the web workspace so only `apps/web/tests/e2e` is discovered, starts the shared mock API plus a Next development server on per-run ports, serializes the shared mock state, and uploads `apps/web/playwright-report/`. Set `BASE_URL` to target an already running environment without local servers; `E2E_FULL_STACK=1` continues to use the DB-backed release-image path instead of the mock-only development behavior.

CI DAST and load smoke generate `.env.smoke`, download `release-manifest.json`, verify every app image is pinned as `<service>:<git-sha>@sha256:<digest>`, pull those digest refs, and start the smoke stack with `--no-build --pull never`. This keeps the smoke checks tied to the image artifacts produced by the build stage instead of silently rebuilding or pulling mutable app tags in the runner.

Run DB-backed public SaaS workflows against an isolated stack:

```bash
DATA_TARGET_ENV=disposable E2E_FULL_STACK=1 E2E_SEED_COMMAND="npm run seed:e2e" npm --workspace @lunchlineup/web run test:e2e
```

The disposable seed requires `DATA_TARGET_ENV=test` or `disposable` and has no production override. It creates separate tenant admin and super-admin PIN users. The full-stack E2E layer uses those accounts to cover tenant dashboard access, schedule editing, lunch/break generation, time cards, platform-admin denial for tenant admins, and super-admin tenant/user inspection.

## Destructive Data Guard Tests

`tests/migration/data-target-guard.test.mjs` verifies that seeds, legacy imports, and migrations require explicit target scopes and a valid database URL before Prisma loads. Seeds reject production-like environments and database URLs. Production legacy cutover additionally requires `NODE_ENV=production`, the exact confirmation `import-legacy-users-production-cutover`, and a matching 64-hex source-export SHA-256. Production migrations require `DATA_TARGET_ENV=production`, `NODE_ENV=production`, and `MIGRATION_PRODUCTION_CONFIRM=apply-lunchlineup-production-migrations`.

## Required Parity Workflows

The migration is not ready for staging until these legacy workflows are covered by tests or captured parity evidence:

- login
- schedule edit/save
- print
- PDF import
- admin
- superadmin
- backup/restore
- production readiness runbook preflight

## SaaS Behavior

The earliest API and Playwright tests must prove:

- tenant scoping for every schedule, staff, store, user, admin, and settings request
- company/store users cannot read or mutate another tenant
- role enforcement is centralized through guards or policy middleware
- superadmin access is explicit and audited
- audit logging is created for admin and superadmin mutations

## Hygiene Behavior

The rebuild must keep these checks green:

- no `.env`, key, token, or secret files are tracked
- no backup payloads are stored under public web paths
- raw error traces are not returned to browsers
- logs live outside public paths
- `/health` exists before route or uptime monitoring is trusted
- CI runs migration hygiene before Docker image build or deploy stages

## Deploy-Source Verification

Before any server deploy, run one of:

```bash
scripts/verify-deploy-source.sh
```

```powershell
scripts\verify-deploy-source.ps1
```

The script must confirm:

- local Git state is clean
- the current commit exists on the upstream GitHub branch
- the target server reports the same `DEPLOYED_GIT_SHA` or the operator explicitly records the first deploy
- the deploy artifact comes from Git, not direct server edits

In GitHub Actions, detached checkouts must prove a push event, branch ref, matching `GITHUB_SHA`, and matching remote branch head instead of relying on local `@{u}` metadata.

## Immutable Release Artifact Verification

Main-branch CI writes `.release/release-manifest.json` from the Docker build digests and uploads it as the `release-manifest` artifact. Before staging or production deploy, CI runs:

```bash
node scripts/verify-release-artifacts.mjs .release/release-manifest.json --source-sha "$GITHUB_SHA" --launch-proof-file .release/launch-proof.json
```

Deploy command variables must call `verify-deploy-source.sh` or `verify-deploy-source.ps1` with `RELEASE_SOURCE_SHA`, consume `RELEASE_MANIFEST_PATH`, and avoid mutable tags or local builds. Public launch requires fresh predeploy runtime, Stripe meter, DAST, load, logical DR, PITR, and alert-route evidence tied to the candidate `sourceSha`. Predeploy proof must not claim external health: after stack mutation, the public health endpoint must serve `X-LunchLineup-Release` equal to the candidate SHA before release pointers advance.

Every candidate launch-proof evidence entry must include matching source, command, exit code, checksum, size, unique URI, and ordered fresh timestamps. CI and VM217 apply the 86,400-second freshness bound to candidates. Known-good rollback proof uses `--launch-proof-mode rollback`: it retains source, checksum, evidence, and timestamp-order validation without expiring after the candidate TTL. Use `launch-proof-template.json` for predeploy evidence; post-deploy external identity evidence is generated by `verify-external-health-release.mjs`.

Production deploys also require the GitHub production environment secret `PRODUCTION_RUNTIME_SECRET_REFERENCE and PRODUCTION_RUNTIME_SECRET_VERSION`. The workflow validates the decoded runtime env and live Stripe meter before mutation. The runtime contract keeps the API loopback-only and retains backup, alert, status-health, and launch-proof references; post-deploy external health then binds the served public release header to the candidate SHA.

Retained-record expiry scheduling is not part of this release artifact proof. Use `docs/runbooks/data-retention-delete-export.md` for the controlled dry-run and reviewed execution path so launch proof does not create overlapping purge schedules.

## Disposable Dev Restore

VM107 restore work uses `docs/runbooks/disposable-dev-server.md` and `scripts/bootstrap-vm107-dev.sh`. Set `VM107_DESTRUCTIVE_CONFIRM=replace-and-restore-disposable-vm107` before the bootstrap can remove `APP_DIR` or restore `BACKUP_FILE`. The disposable path must preserve the same deploy discipline: bootstrap from the GitHub branch, restore only already-available data, write `DEPLOYED_GIT_SHA`, and validate direct plus private proxy health before declaring access restored.

## First Release Registry Bootstrap

Run the protected workflow dispatch with `bootstrap_release_registry=true`, the exact live source SHA, an independently retained current-live v2 bundle URI, and confirmation `bootstrap-current-live-release:<live SHA>`. This bootstrap-only job proves both live endpoints serve that SHA and conditionally creates the empty registry baseline. It cannot stage or deploy a candidate. A later push to `main` resolves that retained baseline before any production mutation.
