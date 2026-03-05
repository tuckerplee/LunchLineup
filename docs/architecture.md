# LunchLineup — Series A Public Beta: Complete Engineering Blueprint

> A system designed so that **no single external failure, manual process, or uncontrolled dependency** can take down the product.
> Architected to survive **hostile networks, hostile users, and hostile dependencies**.
> Every question a prudent CTO would ask before signing off on a public launch has been answered in this document.

---

# Part I: Operational Philosophy

Before any technology choice, these are the principles that govern every decision:

1. **If it's manual, it will fail at 3am.** Every process that touches production must be automated, tested, and reversible.
2. **If it's external, it can disappear.** Every CDN asset, every npm package, every Docker base image — either we vendor it, pin it, or have a fallback. We never depend on a third-party URL being available at deploy time.
3. **If it can't roll back in under 60 seconds, it can't ship.** No deployment, migration, or config change goes live without a proven rollback path.
4. **If it wasn't tested exactly like production, it wasn't tested.** Dev, staging, and production are the same Docker images, same Postgres version, same Redis version, same network topology. Only secrets differ.
5. **If we can't see it, it doesn't exist.** Every request, every error, every slow query, every failed background job must be observable, traceable, and alertable before the first beta user logs in.
6. **Assume the network is hostile.** Every request could be forged, replayed, or redirected. DNS can lie. Browsers can be coerced. Internal services can be probed. We defend at every layer — network, transport, application, and database — because defense-in-depth is the only defense that works.
7. **If it's hardcoded, it's technical debt.** Every threshold, policy, schedule, credential pattern, header value, and behavioral parameter is a variable — set at install, adjustable at runtime, overridable per tenant. The codebase contains logic; the configuration store contains policy.

---

# Part I-A: Configuration Architecture (Zero Hardcoding)

> The single most common source of production incidents in growing SaaS platforms is a value that was "fine for now" baked into source code and never made configurable. We eliminate this class of problem by design.

## 1A.1 — Three-Layer Configuration Hierarchy

Every configurable value in the system lives in exactly one of three layers, evaluated bottom-up with overrides:

```
┌───────────────────────────────────────────────────┐
│  Layer 3: Tenant-Level Config                     │
│  (Per-organization overrides stored in Postgres)  │
│  Example: org_settings.max_concurrent_breaks = 3  │
├───────────────────────────────────────────────────┤
│  Layer 2: Platform-Level Config                   │
│  (Operator-set via Control Plane, stored in DB    │
│   or config file, hot-reloadable)                 │
│  Example: platform.rate_limit.global_rps = 100    │
├───────────────────────────────────────────────────┤
│  Layer 1: System-Level Defaults                   │
│  (Computed from environment or set at install,    │
│   defined in code as fallback defaults)           │
│  Example: postgres.shared_buffers = RAM * 0.25    │
└───────────────────────────────────────────────────┘
```

**Resolution order**: Tenant config > Platform config > System defaults. If a tenant hasn't overridden a value, the platform default applies. If the platform hasn't overridden it, the system default (usually auto-computed) applies.

## 1A.2 — Configuration Store

- **System defaults**: Defined in a `packages/config/defaults.ts` file as a typed, documented object. Every value has a JSDoc comment explaining what it controls, its valid range, and its default derivation logic.
- **Platform config**: Stored in a `platform_config` table in Postgres (key/value with JSONB value column). Editable via the Control Plane UI and API. Changes are **hot-reloaded** — services poll or subscribe to a Redis pub/sub channel for config change notifications. No restart required.
- **Tenant config**: Stored in `tenant_settings` table, scoped by `tenant_id`. Editable by tenant admins via the application UI (within guardrails defined by their plan tier). Also hot-reloaded.

## 1A.3 — Config Schema Validation

- Every configurable value is defined in a **Zod schema** (`packages/config/schema.ts`) that enforces types, ranges, and constraints.
- Example: `rateLimitGlobalRps` is `z.number().int().min(10).max(10000).default(100)`. A tenant cannot set it to `-1` or `999999`.
- Schemas are shared between the config loader, the Control Plane validation layer, and the tenant settings UI. One source of truth.

## 1A.4 — What Is Configurable (Not Exhaustive)

| Category | Examples | Layer |
|---|---|---|
| **Infrastructure** | Postgres memory allocation (auto-computed from detected RAM), Redis max memory, PgBouncer pool size, backup schedule (cron expression), WAL retention days, DR drill frequency | System / Platform |
| **Security** | CSP directives (built from domain + CDN allowlist), CORS allowed origins, HSTS max-age, rate limit thresholds per tier, login lockout attempts/duration, CSRF token lifetime, session timeout, MFA enforcement level, IP allowlist for control plane | Platform / Tenant |
| **Business Logic** | Max concurrent breaks, min floor coverage, break window start/end, shift minimum duration, overtime threshold, schedule publish lead time, chore auto-assignment enabled | Tenant |
| **UX/Frontend** | Theme (dark/light/auto), primary accent color (HSL), animation speed multiplier, locale, timezone, date format, items per page, notification preferences | Tenant / User |
| **Billing** | Plan tier limits (locations, staff, API rate), trial duration days, grace period days, metered billing sync interval | Platform |
| **Observability** | Log retention days, slow query threshold ms, alert thresholds (p99 latency, error rate %, disk usage %), metric scrape interval | Platform |
| **Email/Notifications** | SMTP host/port/credentials, email sender address, notification channels (email/SMS/webhook), digest frequency | Platform / Tenant |

## 1A.5 — Auto-Computed Defaults (Environment-Aware)

The system introspects its runtime environment at startup and computes sensible defaults:

```typescript
// packages/config/defaults.ts (simplified)
export function computeDefaults(env: SystemEnvironment) {
  return {
    postgres: {
      sharedBuffers:  Math.floor(env.totalMemoryGB * 0.25) + 'GB',
      effectiveCache: Math.floor(env.totalMemoryGB * 0.75) + 'GB',
      workMem:        Math.floor(env.totalMemoryGB * 4) + 'MB',
      maintenanceMem: Math.min(Math.floor(env.totalMemoryGB * 0.03125), 2) + 'GB',
      maxParallelWorkers: Math.min(env.cpuCores - 2, 8),
      randomPageCost: env.storageType === 'nvme' ? 1.1 : 4.0,
      effectiveIoConcurrency: env.storageType === 'nvme' ? 200 : 2,
    },
    redis: {
      maxMemory: Math.floor(env.totalMemoryGB * 0.10) + 'GB',
    },
    pgbouncer: {
      defaultPoolSize: Math.floor(env.cpuCores * 2.5),
    },
    security: {
      rateLimitGlobalRps: 100,
      loginLockoutAttempts: 5,
      loginLockoutDurationMin: 15,
      sessionTimeoutMin: 30,
      csrfTokenLifetimeMin: 60,
      jwtAccessTokenLifetimeMin: 15,
      jwtRefreshTokenLifetimeDays: 7,
      keyRotationOverlapHours: 24,
    },
    backup: {
      schedule: '0 3 * * *',     // cron: daily 03:00 UTC
      retentionDays: 90,
      walRetentionDays: 30,
      drDrillSchedule: '0 4 1 * *', // cron: 1st of month 04:00
      offsiteEnabled: true,
    },
    observability: {
      slowQueryThresholdMs: 100,
      logRetentionDays: 30,
      alertP99LatencyMs: 1000,
      alertErrorRatePercent: 2,
      alertDiskUsagePercent: 85,
    },
  };
}
```

**Key point**: These are *fallback defaults*, not hardcoded values. Every single one can be overridden at the platform or tenant level without touching code. The code says "if nobody told me otherwise, here's what makes sense for this hardware."

## 1A.6 — Config-Driven Infrastructure Generation

Infrastructure config files (`postgresql.conf`, `redis.conf`, `pgbouncer.ini`, `Caddyfile`) are **not committed as static files**. They are **generated from templates** at container startup using the resolved configuration values.

- **Templates**: Stored as `.conf.template` (or `.ejs` / Handlebars) files in `infrastructure/`.
- **Entrypoint script**: Each container's Docker entrypoint runs a config-generation step before starting the service:
  1. Read resolved config values (from env vars injected by Vault/Docker secrets + platform config API call).
  2. Render the template with those values.
  3. Write the final `.conf` file to the container's filesystem.
  4. Start the service.
- This means: changing `postgres.shared_buffers` in the Control Plane → triggers a Postgres container restart → the entrypoint re-renders `postgresql.conf.template` with the new value → Postgres starts with the updated config. No manual file editing. No SSH.

Example template:
```ini
# infrastructure/postgres/postgresql.conf.template
shared_buffers = {{postgres.sharedBuffers}}
effective_cache_size = {{postgres.effectiveCache}}
work_mem = {{postgres.workMem}}
maintenance_work_mem = {{postgres.maintenanceMem}}
max_parallel_workers = {{postgres.maxParallelWorkers}}
random_page_cost = {{postgres.randomPageCost}}
effective_io_concurrency = {{postgres.effectiveIoConcurrency}}
log_min_duration_statement = {{observability.slowQueryThresholdMs}}
```

## 1A.7 — Security Headers as Config, Not Strings

The CSP and security header block is not a static string — it is **composed at startup** from configuration:

```typescript
// packages/config/security-headers.ts
export function buildSecurityHeaders(config: PlatformConfig) {
  return {
    'Strict-Transport-Security':
      `max-age=${config.security.hstsMaxAge}; includeSubDomains${config.security.hstsPreload ? '; preload' : ''}`,
    'Content-Security-Policy': buildCSP({
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", ...config.security.cspExtraScriptSrc],
      styleSrc:   ["'self'", "'unsafe-inline'", ...config.security.cspExtraStyleSrc],
      imgSrc:     ["'self'", 'data:', ...config.security.cspExtraImgSrc],
      fontSrc:    ["'self'", ...config.security.cspExtraFontSrc],
      connectSrc: ["'self'", `wss://${config.domain}`, ...config.security.cspExtraConnectSrc],
      frameAncestors: config.security.allowIframeEmbedding ? config.security.iframeAllowedOrigins : ["'none'"],
      baseUri:    ["'self'"],
      formAction: ["'self'"],
    }),
    'X-Frame-Options': config.security.allowIframeEmbedding ? 'SAMEORIGIN' : 'DENY',
    // ...remaining headers built from config values
  };
}
```

This means:
- Adding a new CDN origin = update `cspExtraScriptSrc` in platform config, not editing a header string in source code.
- Allowing iframe embedding for a partner integration = flip `allowIframeEmbedding` and add their origin to `iframeAllowedOrigins`.
- No deploy needed for config-only changes.

## 1A.8 — Rate Limits Driven by Plan Tiers

Rate limits are not magic numbers in middleware — they are resolved from the tenant's billing plan:

```typescript
// packages/config/rate-limits.ts
export function resolveRateLimits(plan: BillingPlan, overrides?: TenantSettings) {
  const defaults = PLAN_RATE_LIMITS[plan.tier]; // 'free' | 'starter' | 'growth' | 'enterprise'
  return {
    globalRps:            overrides?.rateLimitGlobalRps            ?? defaults.globalRps,
    apiReqPerMin:         overrides?.rateLimitApiReqPerMin         ?? defaults.apiReqPerMin,
    authAttemptsPerWindow:overrides?.rateLimitAuthAttempts         ?? defaults.authAttemptsPerWindow,
    expensiveReqPerMin:   overrides?.rateLimitExpensiveReqPerMin   ?? defaults.expensiveReqPerMin,
    webhookDeliveriesPerHour: overrides?.webhookDeliveriesPerHour  ?? defaults.webhookDeliveriesPerHour,
  };
}
```

Upgrading a tenant's plan automatically adjusts their rate limits without any code change or manual intervention.

---

# Part II: Docker-Native Architecture

Docker is not a deployment detail — it is the **entire development, testing, and production paradigm**.

## 2.1 — Everything Is a Container

| Container | Base Image | Purpose |
|---|---|---|
| `lunchlineup-web` | `node:22-alpine` (pinned digest) | Next.js frontend |
| `lunchlineup-api` | `node:22-alpine` (pinned digest) | NestJS TypeScript API Gateway |
| `lunchlineup-engine` | `python:3.12-slim` (pinned digest) | FastAPI scheduling engine |
| `lunchlineup-worker` | `node:22-alpine` (pinned digest) | Background job processor (emails, PDF gen, billing sync) |
| `lunchlineup-postgres` | `postgres:16-alpine` (pinned digest) | PostgreSQL with custom init scripts |
| `lunchlineup-redis` | `redis:7-alpine` (pinned digest) | Caching, sessions, rate limiting, pub/sub |
| `lunchlineup-pgbouncer` | `edoburu/pgbouncer` (pinned digest) | Connection pooling |
| `lunchlineup-proxy` | `caddy:2-alpine` (pinned digest) | Reverse proxy, auto-TLS, request routing |
| `lunchlineup-migrations` | `node:22-alpine` (pinned digest) | One-shot container that runs Prisma migrations then exits |
| `lunchlineup-backup` | `alpine` (pinned digest) | Cron-driven backup agent |
| `lunchlineup-control` | `node:22-alpine` (pinned digest) | Out-of-band management/control plane (port 300X) |

> **Every base image is pinned by SHA256 digest**, not just tag. `node:22-alpine` can change without notice. `node@sha256:abc123...` cannot. Base images are rebuilt and re-pinned monthly via an automated PR.

## 2.2 — Docker Compose: One Command Development

```yaml
# docker-compose.yml — the ONLY way to run the project locally
# `docker compose up` starts everything. No installing Postgres locally, no Redis locally.
```

- All services, databases, and infrastructure containers defined in a single `docker-compose.yml`.
- Volumes for Postgres data, Redis persistence, and hot-reload source code mounts.
- Health checks on every container — `docker compose up` doesn't return "ready" until every service passes its health check.
- `.env.local` for local overrides, never committed. A `.env.example` with every variable documented is committed.

## 2.3 — Multi-Stage Docker Builds

Every application Dockerfile uses multi-stage builds:

```
Stage 1: deps     — Install all dependencies (cached layer)
Stage 2: build    — Compile TypeScript, bundle assets
Stage 3: runtime  — Copy only compiled output + production deps into a minimal image
```

Benefits:
- Final images are **< 150MB** (no dev dependencies, no source code, no build tools).
- Build cache means rebuilds after a code change take < 30 seconds.
- Secrets never appear in any layer (no `.env` files baked in, no `ARG` for secrets).

## 2.4 — Private Container Registry

- All built images pushed to a **self-hosted Docker Registry** (or GitHub Container Registry) — not Docker Hub public.
- Images tagged with: `git SHA`, `branch name`, and `latest` (for staging only). Production always deploys a specific SHA.
- Image retention policy: Keep last 30 tagged images. Garbage collect untagged manifests weekly.

## 2.5 — Production Orchestration (Docker Swarm or K3s)

Given the dedicated Ryzen 7 / 64GB / NVMe server:

- **Docker Swarm** (or K3s for Kubernetes-lite) manages service replicas, health monitoring, and rolling updates.
- **Service replicas**: API gateway runs 3 replicas behind Caddy load balancing. Python engine runs 2 replicas. Frontend runs 2 replicas.
- **Resource limits enforced**: Every container has CPU and memory limits. A runaway process cannot OOM the host.
- **Restart policies**: `on-failure` with max retry count + backoff. Prevents restart loops that mask the real problem.
- **Rolling updates**: `docker service update --update-parallelism 1 --update-delay 30s` — one container at a time, with a 30-second health check window. If the new container fails its health check, the update halts and the old container stays live.

---

# Part III: Automated Build, Upgrade & Rollback Lifecycle

## 3.1 — The CI/CD Pipeline (GitHub Actions)

Every push to any branch triggers the full pipeline. **No human manually builds, deploys, or migrates.**

### Pipeline Stages

```
┌─────────────────────────────────────────────────────────────────────┐
│  1. Lint & Format (ESLint, Prettier, Black, Ruff)                  │
│  2. Type Check (tsc --noEmit, Pyright)                             │
│  3. SAST — Static Security Scan (Semgrep, Bandit)                  │
│  4. Dependency Audit (npm audit, pip audit, license compliance)     │
│  5. Unit Tests (Vitest, PyTest) — 90%+ coverage gate               │
│  6. Build Docker Images (multi-stage, tagged with git SHA)          │
│  7. Push Images to Private Registry                                │
│  8. Spin Up Ephemeral Environment (docker compose in CI)            │
│  9. Run Migrations Container Against Ephemeral DB                  │
│ 10. Integration Tests Against Ephemeral Stack                      │
│ 11. DAST — Dynamic Security Scan (OWASP ZAP against ephemeral)     │
│ 12. E2E Tests (Playwright against ephemeral stack)                 │
│ 13. Load Test Smoke (Artillery, 100 concurrent, fail if p99 > 1s)  │
│ 14. Deploy to Staging (auto on main branch merge)                  │
│ 15. Staging Smoke Tests (Playwright critical path subset)           │
│ 16. Manual Promotion Gate → Production                             │
│ 17. Blue/Green Deploy to Production                                │
│ 18. Production Smoke Tests (health endpoints + critical query)      │
│ 19. If smoke fails → Auto-Rollback to Previous SHA                 │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Details

- **Steps 1–5**: Fast-fail loop. Takes < 3 minutes. Catches 90% of issues before we even build an image.
- **Steps 6–7**: Images tagged with the exact git SHA. Every image is traceable to a commit.
- **Steps 8–13**: The ephemeral environment is a complete Docker Compose stack spun up inside CI with real Postgres, real Redis, real service containers. Tests run against *production-identical infrastructure*, not mocks.
- **Step 16**: Manual gate. A senior engineer clicks "Deploy to Production" in the GitHub Actions UI after reviewing staging. No auto-deploy to production.
- **Step 19**: If production smoke tests fail, the pipeline automatically rolls back to the previous known-good image SHA. Rollback takes < 60 seconds (it's just re-deploying the old image).

## 3.2 — Automated Database Migrations

Migrations are **never run manually**. They are an automated, gated step in the deployment pipeline.

1. **Migration Container**: A dedicated Docker container (`lunchlineup-migrations`) that runs `prisma migrate deploy` and exits.
2. **Pre-deploy check**: Before applying migrations, the container runs `prisma migrate diff` and logs the exact SQL that will execute. This is captured in CI logs for audit.
3. **Backward-compatible only**: Every migration must be backward-compatible with the *currently running* application version. This means:
   - **Adding** a column: Allowed. Old code ignores it.
   - **Dropping** a column: Never in one step. Phase 1: stop reading it. Phase 2 (next deploy): drop it.
   - **Renaming**: Never. Add new → backfill → deprecate old → drop old (across 3 separate deployments).
4. **Rollback migrations**: Every migration has a corresponding `down` migration tested in CI. If a deploy fails post-migration, the rollback pipeline runs the down migration automatically.
5. **Migration lock**: Postgres advisory locks prevent two migration containers from running simultaneously (e.g., during a race in CI).

## 3.3 — Automated Upgrade Process (Self-Healing)

When a new version is deployed to production:

1. **Pull new images** from the private registry (by SHA tag).
2. **Run migration container** — applies any pending schema changes. If it fails, deployment halts. Alert fires.
3. **Rolling update** — new API containers brought up one at a time. Each must pass its health check (`/health` endpoint verifying DB connectivity, Redis connectivity, and config loaded) within 30 seconds.
4. **Traffic cutover** — Caddy reverse proxy drains connections from old containers and routes to new ones.
5. **Old containers kept alive for 5 minutes** — allows in-flight requests to complete. Then terminated.
6. **Post-deploy smoke tests** — automated Playwright test hits 3 critical endpoints. If any fail, **automatic rollback** triggers.

### Self-Healing

- **Container crash**: Docker Swarm restarts it (with backoff). If it crashes 5 times in 5 minutes, an alert fires and the container is left stopped for manual investigation.
- **Health check failure**: Caddy removes the unhealthy container from the load balancer pool. Swarm starts a replacement. If all replicas are unhealthy, alert fires immediately.
- **Disk space**: A monitoring cron job checks disk usage every 5 minutes. At 80%, it triggers log rotation and Docker image pruning. At 90%, it fires a critical alert.
- **Memory pressure**: Containers have hard memory limits. OOM kills are caught by Docker, logged, and trigger a restart + alert. The host system is protected.
- **Certificate renewal**: Caddy handles TLS certificate renewal automatically via ACME. Renewal is attempted 30 days before expiry. Failure to renew fires an alert 7 days before expiry.

---

# Part IV: Dependency Sovereignty (Vendoring & Pinning)

> If Bootstrap's CDN goes down, our app still works. If npm has a bad day, we can still build. If a maintainer unpads their package, our build doesn't break.

## 4.1 — Frontend Asset Vendoring

**Every CDN-hosted library is also vendored locally as a controlled fallback.**

Strategy:
1. A CI job (`scripts/vendor-assets.sh`) downloads every CDN dependency (Bootstrap CSS/JS, fonts, icon libraries) at their **exact pinned version with SRI hash verification**.
2. Downloaded assets are committed to `packages/ui/vendor/` in the monorepo.
3. The application loads from CDN first (for edge caching performance), but includes a `<script onerror>` / `<link onerror>` fallback that loads from the vendored local copy.
4. **SRI (Subresource Integrity) hashes** are enforced on every `<script>` and `<link>` tag pointing to a CDN. If the CDN serves a tampered or different file, the browser refuses to execute it, and the local fallback loads.
5. The CI job runs monthly and creates a PR if any dependency has a new version — the team reviews before merging. No silent CDN version drift.

```html
<!-- Example: Bootstrap with CDN + local fallback + SRI -->
<link rel="stylesheet"
      href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css"
      integrity="sha384-EXACT_HASH_HERE"
      crossorigin="anonymous"
      onerror="this.href='/vendor/bootstrap-5.3.3/bootstrap.min.css'">
```

## 4.2 — npm/pip Dependency Lockfiles & Mirroring

- **Lockfiles committed**: `package-lock.json` and `requirements.lock` (pip-tools) are committed and enforced in CI via `npm ci` (fails if lockfile is out of date) and `pip install --require-hashes`.
- **Dependency license audit**: CI step scans all dependencies for license compatibility. GPL-licensed transitive dependencies block the build.
- **Vulnerability scanning**: Dependabot + `npm audit` + `pip audit` in CI. High/critical CVEs block merge. Medium CVEs create a tracking issue.
- **Optional: Private npm/PyPI mirror**: Verdaccio (npm) or devpi (PyPI) running as a Docker container on the server, caching all downloaded packages. If npmjs.org goes down, builds still succeed from the local cache.

## 4.3 — Docker Base Image Pinning & Scanning

- Base images pinned by **SHA256 digest**, not tag.
- A monthly CI job (`scripts/update-base-images.sh`):
  1. Pulls the latest tag for each base image.
  2. Scans it with Trivy for vulnerabilities.
  3. If clean, updates the digest in all Dockerfiles.
  4. Opens a PR with the diff for review.
- **If the upstream image has a critical CVE**, the PR is flagged and the old (safe) digest continues to be used until the upstream fixes it.

## 4.4 — Font Vendoring

- Google Fonts (Inter, Geist, etc.) are **downloaded at build time** and served from `/public/fonts/`, not loaded from `fonts.googleapis.com`.
- This eliminates a runtime dependency on Google's infrastructure and prevents Google from tracking users via font requests.
- The `@font-face` declarations reference local files only.

---

# Part V: Monorepo & Code Architecture

## 5.1 — Turborepo Monorepo Structure

```
lunchlineup/
├── .github/                        # GitHub Actions workflows
│   ├── workflows/
│   │   ├── ci.yml                  # Full CI pipeline
│   │   ├── deploy-staging.yml      # Staging deploy
│   │   ├── deploy-production.yml   # Production deploy (manual trigger)
│   │   ├── vendor-update.yml       # Monthly dependency vendoring
│   │   └── base-image-update.yml   # Monthly base image re-pin
│   └── CODEOWNERS                  # Enforce review requirements per path
├── apps/
│   ├── web/                        # Next.js 14+ frontend
│   ├── api/                        # NestJS TypeScript API Gateway
│   ├── engine/                     # Python FastAPI scheduling engine
│   ├── worker/                     # Background job processor
│   └── control-plane/              # Out-of-band management service (port 300X)
├── packages/
│   ├── db/                         # Prisma schema, migrations, generated client
│   ├── shared-types/               # Zod schemas shared between frontend & backend
│   ├── rbac/                       # Permission definitions, Casbin policies
│   ├── ui/                         # React component library + Storybook
│   │   └── vendor/                 # Vendored CDN assets (Bootstrap, fonts, icons)
│   ├── config/                     # Central config package (Part I-A)
│   │   ├── defaults.ts             # Auto-computed system defaults
│   │   ├── schema.ts               # Zod schemas for all config values
│   │   ├── security-headers.ts     # CSP/header builder functions
│   │   ├── rate-limits.ts          # Plan-tier rate limit resolver
│   │   └── loader.ts               # 3-layer config resolution engine
│   ├── lint-config/                # Shared ESLint, TypeScript, Prettier configs
│   └── testing/                    # Shared test utilities, fixtures, factories
├── infrastructure/
│   ├── terraform/                  # IaC definitions for all environments
│   ├── docker/
│   │   ├── docker-compose.yml      # Local development (THE way to run locally)
│   │   ├── docker-compose.ci.yml   # CI ephemeral environment
│   │   ├── docker-compose.prod.yml # Production orchestration
│   │   ├── Dockerfile.web
│   │   ├── Dockerfile.api
│   │   ├── Dockerfile.engine
│   │   ├── Dockerfile.worker
│   │   ├── Dockerfile.control
│   │   ├── Dockerfile.migrations
│   │   └── Dockerfile.backup
│   ├── caddy/
│   │   └── Caddyfile.template      # Template rendered from config at startup
│   ├── postgres/
│   │   ├── postgresql.conf.template # Template rendered from config at startup
│   │   ├── pg_hba.conf.template    # Connection security (IPs from config)
│   │   └── init.sql.template       # Initial DB/role creation
│   ├── redis/
│   │   └── redis.conf.template     # Template rendered from config at startup
│   └── pgbouncer/
│       └── pgbouncer.ini.template  # Pool sizes from config at startup
├── scripts/
│   ├── vendor-assets.sh             # Download + verify CDN assets
│   ├── update-base-images.sh        # Re-pin Docker base images
│   ├── backup.sh                    # Encrypted pg_dump + offsite sync
│   ├── restore.sh                   # Restore from encrypted backup
│   ├── dr-drill.sh                  # Automated disaster recovery drill
│   ├── generate-secrets.sh          # Generate all required secrets for a new env
│   └── seed.ts                      # Seed development database with realistic data
├── docs/
│   ├── architecture.md              # System architecture overview
│   ├── runbooks/                    # Incident response procedures
│   │   ├── database-failover.md
│   │   ├── high-cpu.md
│   │   ├── deployment-rollback.md
│   │   └── security-incident.md
│   ├── api/                         # Auto-generated OpenAPI docs
│   └── adr/                         # Architecture Decision Records
│       ├── 001-monorepo.md
│       ├── 002-postgres-rls.md
│       └── 003-docker-swarm-vs-k3s.md
├── turbo.json                       # Turborepo pipeline definitions
├── package.json                     # Root workspace config
└── .env.example                     # Every env var, documented, no values
```

## 5.2 — Architecture Decision Records (ADRs)

Every significant technical decision is documented in `docs/adr/` with:
- **Context**: Why are we making this decision now?
- **Decision**: What did we choose?
- **Alternatives Considered**: What did we reject and why?
- **Consequences**: What are the tradeoffs?

This prevents re-litigating settled decisions and gives new team members context.

---

# Part VI: PostgreSQL — Auto-Tuned for the Hardware

## 6.1 — Config-Generated `postgresql.conf`

Postgres configuration is **not a static file**. It is generated at container startup from the `postgresql.conf.template` using auto-computed defaults from Part I-A (derived from detected RAM, CPU cores, and storage type), overridable via the Control Plane.

On a 64GB RAM / 12-core Ryzen 7 / NVMe server, the auto-computed defaults resolve to:

| Parameter | Formula | Resolved Value |
|---|---|---|
| `shared_buffers` | `RAM × 0.25` | `16GB` |
| `effective_cache_size` | `RAM × 0.75` | `48GB` |
| `work_mem` | `RAM × 4 MB` | `256MB` |
| `maintenance_work_mem` | `min(RAM × 0.03, 2GB)` | `2GB` |
| `max_parallel_workers` | `min(cores − 2, 8)` | `8` |
| `random_page_cost` | `NVMe ? 1.1 : 4.0` | `1.1` |
| `effective_io_concurrency` | `NVMe ? 200 : 2` | `200` |
| `log_min_duration_statement` | `config.observability.slowQueryThresholdMs` | `100ms` |
| `max_connections` | `config.postgres.maxConnections` | `200` |

All values adjustable via Control Plane → Platform Config → Postgres section. Changes trigger a container restart with the re-rendered template.

## 6.2 — Schema Design

All design principles from the previous revision apply, plus:

- **Row-Level Security (RLS)**: Enforced at the Postgres level. The application DB user cannot bypass it. Even a SQL injection attack is tenant-scoped.
- **Indexes strategy**: B-tree on all foreign keys. GIN indexes on JSONB columns. Partial indexes on `deleted_at IS NULL` for soft-delete performance. BRIN indexes on time-series tables (audit_log, shifts) for range queries.
- **Partitioning**: `audit_log` table partitioned by month (declarative partitioning). Old partitions can be archived to cold storage without affecting query performance on recent data.
- **Automated VACUUM tuning**: `autovacuum_naptime = 30s`, aggressive settings for high-churn tables (shifts, audit_log).

## 6.3 — Backup & Disaster Recovery (Config-Driven)

All backup parameters are configurable via the Control Plane (Part I-A, `config.backup.*`):

| Mechanism | Config Key | Default | Storage |
|---|---|---|---|
| **WAL Archiving (PITR)** | `backup.walRetentionDays` | `30` days | Encrypted local + offsite |
| **Full pg_dump** | `backup.schedule` (cron) | `0 3 * * *` (daily 03:00 UTC) | Encrypted, GPG + AES-256 |
| **Offsite Sync** | `backup.offsiteEnabled` | `true` | Rsync target configurable |
| **Retention** | `backup.retentionDays` | `90` | Auto-pruned by backup agent |
| **DR Drill** | `backup.drDrillSchedule` (cron) | `0 4 1 * *` (1st of month) | Restored to isolated container |

- `scripts/backup.sh`: Runs `pg_dump --format=custom`, compresses with `zstd`, encrypts with `gpg --symmetric --cipher-algo AES256`, syncs to the configured offsite target.
- `scripts/restore.sh`: Decrypts, decompresses, restores to a target database. Can target an isolated container for verification.
- `scripts/dr-drill.sh`: Automatically restores the latest backup to an ephemeral Postgres container, runs configurable validation queries, logs success/failure, and sends a notification to the configured alerting channel.
- **RTO/RPO targets** are configurable (`backup.rtoTargetMinutes`, `backup.rpoTargetMinutes`) and monitored by the observability layer. Default: RTO < 60 min, RPO < 5 min.

---

# Part VII: IAM & RBAC (Zero Trust, Default Deny)

- OIDC auth with MFA on admin accounts
- Short-lived access tokens (15 min) + server-side refresh tokens in HttpOnly cookies
- Policy-based RBAC: User → Role → Permission → Resource → Action, scoped to tenant/location
- Default deny enforced at middleware level and DB RLS level (defense in depth)
- East/West m2m JWT with user context propagation
- Append-only audit log with no UPDATE/DELETE permissions for the app DB user
- IP anomaly detection, concurrent session limits, per-session revocation

---

# Part VII-A: Security Hardening (Hostile Environment Assumptions)

> **This system holds employee names, emails, phone numbers, work schedules, and pay-related data.**
> We assume: the network is hostile, the browser is compromised, the user is malicious, and every internal service is a potential pivot point.

## 7A.1 — DNS Rebinding / Pigeon-Hole Protection

DNS rebinding attacks trick a browser into believing a malicious domain resolves to `127.0.0.1` or an internal IP, bypassing same-origin policy and accessing internal services.

**Defenses:**
- **Host header validation**: Every service (Caddy, NestJS, FastAPI) validates the incoming `Host` header against a strict allowlist of known domains. Any request with an unrecognized `Host` header is rejected with `421 Misdirected Request` before reaching any application logic.
- **Caddy reverse proxy**: Configured to reject requests where the `Host` header does not match the expected production/staging domain. No wildcard matching.
- **Internal services bind to Docker network only**: Postgres, Redis, PgBouncer, the Python engine, and RabbitMQ are **not** exposed on `0.0.0.0`. They bind only to the internal Docker bridge network. There is no port on the host machine that reaches them directly — only the Caddy reverse proxy and the API gateway have externally-reachable ports.
- **DNS pinning in application HTTP clients**: When the API gateway makes outbound requests (e.g., webhook delivery), the HTTP client is configured to pin DNS results and reject responses that resolve to private IP ranges (`10.x`, `172.16.x`, `192.168.x`, `127.x`, `::1`). This prevents SSRF-via-DNS-rebinding.

## 7A.2 — CSRF Protection (Cross-Site Request Forgery)

CSRF is a direct threat because the app uses cookies for session management.

**Defenses (layered — not just one):**
1. **SameSite=Strict cookies**: All session and auth cookies set with `SameSite=Strict`. The browser will not send the cookie on any cross-origin request. This blocks the most common CSRF vector entirely.
2. **Double-submit CSRF token**: For browsers/scenarios where SameSite is insufficient (e.g., older browsers, subdomain attacks):
   - On session creation, the server generates a cryptographically random CSRF token and stores it server-side.
   - The token is sent to the client as a `Set-Cookie` with `HttpOnly=false` (readable by JS) AND embedded in a `<meta>` tag in every server-rendered page.
   - On every state-changing request (`POST`, `PUT`, `PATCH`, `DELETE`), the frontend reads the token from the cookie and sends it as an `X-CSRF-Token` header.
   - The server validates that the header value matches the cookie value AND the server-side stored value. Triple-check.
3. **Origin / Referer header validation**: On every state-changing request, the API gateway checks the `Origin` (or `Referer` if `Origin` is absent) header. If it does not match the known production domain, the request is rejected with `403 Forbidden`. Requests with no `Origin` and no `Referer` are also rejected for non-API routes.
4. **CORS strict allowlist**: `Access-Control-Allow-Origin` is set to the **exact production domain** (never `*`). Pre-flight `OPTIONS` requests are handled by Caddy, not the application. `Access-Control-Allow-Credentials: true` is set, requiring the browser to enforce origin checks.
5. **API routes (JWT-authenticated)**: API calls authenticated via `Authorization: Bearer <token>` header (not cookies) are inherently CSRF-immune. The JWT is never sent automatically by the browser — JavaScript must explicitly attach it. This is the primary auth mechanism for API consumers.

## 7A.3 — HTTP Security Headers (Config-Driven, Enforced at Caddy Layer)

Security headers are **built from configuration** at startup, not hardcoded strings (see Part I-A, §1A.7). The Caddyfile is rendered from a template using resolved config values. The resulting headers include:

- **HSTS**: `max-age` from `config.security.hstsMaxAge` (default: `63072000`). `includeSubDomains` and `preload` toggleable.
- **CSP**: Composed by the `buildCSP()` function from `config.security.cspExtra*` arrays. Adding a new CDN or integration origin = config change, not code change.
- **Frame policy**: `X-Frame-Options` and `frame-ancestors` driven by `config.security.allowIframeEmbedding` (default: `false` → `DENY`/`'none'`). Partner iframe integrations can be enabled per-domain without a deploy.
- **COOP/CORP/COEP**: Isolates the browsing context against Spectre-class side-channels. Configurable for environments needing cross-origin resource sharing.
- **Permissions-Policy**: Disabled hardware APIs (camera, mic, geo, payment) configurable via `config.security.permissionsPolicy` map.
- **X-XSS-Protection: 0**: Intentionally disabled — the legacy XSS auditor is itself a vulnerability vector. CSP replaces it.
- **Referrer-Policy**: Configurable, default `strict-origin-when-cross-origin`.

All header values are logged at startup for audit. Changes via Control Plane trigger a Caddy config reload (zero-downtime).

## 7A.4 — SSRF Protection (Server-Side Request Forgery)

The API gateway makes outbound HTTP requests for: webhook delivery, PDF import from URL, and OAuth callbacks. Each of these is an SSRF vector.

**Defenses:**
- **URL allowlisting**: Webhook URLs are validated against a regex allowlist at registration time. IPs in private ranges, localhost, link-local, and cloud metadata endpoints (`169.254.169.254`) are blocked.
- **DNS resolution validation**: Before making any outbound request, the application resolves the hostname and validates the IP is not in a private range. This catches DNS rebinding where `evil.com` resolves to `10.0.0.1` at request time.
- **Outbound request timeout**: All outbound HTTP requests have a hard 10-second timeout. No open-ended connections.
- **Egress firewall rules (Docker network)**: The API container's Docker network has iptables rules restricting outbound traffic to: port 443 (HTTPS), port 587 (SMTP), and the internal Docker DNS. All other outbound traffic is dropped. This is a last-resort defense even if application-level checks are bypassed.
- **Separate outbound HTTP client**: Webhook delivery and PDF import use a dedicated HTTP client class (`SecureHttpClient`) that wraps `fetch`/`axios` with all the above checks. Direct `fetch()` calls to external URLs are banned by linting rules.

## 7A.5 — Request Smuggling & Protocol-Level Attacks

- **Caddy reverse proxy**: Handles HTTP/1.1 → HTTP/2 translation and normalizes request framing. Caddy's architecture avoids the classic request smuggling vectors caused by proxy/backend disagreements on `Content-Length` vs `Transfer-Encoding`.
- **Request size limits**: Caddy enforces maximum request body sizes (10MB for file uploads, 1MB for JSON payloads). Oversized requests are rejected at the proxy before reaching any application container.
- **Slow-loris protection**: Caddy's built-in timeouts: `read_timeout 10s`, `write_timeout 30s`, `idle_timeout 120s`. Slow clients are disconnected before consuming server resources.
- **HTTP/2 rapid reset protection**: Caddy and Go's net/http are patched against CVE-2023-44487 (HTTP/2 rapid reset DoS). Max concurrent streams set to 100 per connection.

## 7A.6 — Network Isolation (Docker Network Segmentation)

Not all containers trust each other. Internal networks are segmented into **four zones**:

```
┌───────────────────────────────────────────────────────┐
│  External Network (internet-facing)                    │
│  ┌────────┐                                            │
│  │ Caddy  │ ← Only user-facing container exposed       │
│  └───┬────┘                                            │
├──────┼────────────────────────────────────────────────-┤
│  App Network (internal)                                │
│  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐       │
│  │  Web   │  │  API   │  │ Worker │  │ Engine │       │
│  └────────┘  └───┬────┘  └───┬────┘  └────────┘       │
├──────────────────┼───────────┼─────────────────────────┤
│  Data Network (restricted)                             │
│  ┌──────────┐  ┌───────┐  ┌───────────┐  ┌──────────┐ │
│  │ Postgres │  │ Redis │  │ PgBouncer │  │ RabbitMQ │ │
│  └──────────┘  └───────┘  └───────────┘  └──────────┘ │
├───────────────────────────────────────────────────────-┤
│  Management Network (isolated, separate port)          │
│  ┌─────────────────┐                                   │
│  │  Control Plane   │ ← Port 300X, host-local only     │
│  │  (lunchlineup-   │                                   │
│  │   control)       │                                   │
│  └────────┬────────┘                                   │
│           │ Direct access to Data Network               │
└───────────────────────────────────────────────────────-┘
```

- **Caddy** is the only user-facing container on the external network. It has no direct access to the data network.
- **App containers** (API, Worker, Engine, Web) live on the app network. They can reach the data network but not the external network (except through Caddy for outbound, governed by egress rules).
- **Data containers** (Postgres, Redis, PgBouncer, RabbitMQ) are on the data network only. They have **zero** external network access. They cannot reach the internet.
- **Control Plane** lives on a dedicated management network with direct access to the data network. It listens on a separate port (300X) bound to `127.0.0.1` or the server's LAN IP only — **never exposed to the public internet**. It bypasses Caddy entirely.

## 7A.7 — Input Sanitization & Output Encoding

- **Input**: All user input validated and sanitized via Zod schemas at the API boundary. Invalid types, unexpected fields, and oversized strings are rejected before reaching business logic.
- **Output**: All API responses are JSON-serialized through a consistent serializer that HTML-encodes special characters (`<`, `>`, `&`, `"`, `'`) in string values. Server-rendered pages (Next.js) use React's built-in JSX escaping — no `dangerouslySetInnerHTML` without explicit security review (banned by ESLint rule).
- **SQL**: Prisma's parameterized queries prevent SQL injection by design. Raw SQL queries are banned by linting rule; any exception requires a security-review CODEOWNERS approval.
- **File uploads**: File type validation by magic bytes (not file extension). Uploaded files stored outside the web root. Filenames are replaced with UUIDs — user-supplied filenames are never used in the filesystem. Antivirus scan (ClamAV container) before processing.

## 7A.8 — Secrets & Credential Hygiene

- **No secrets in environment variables at rest**: Secrets injected at container startup via HashiCorp Vault agent sidecar or Docker secrets. They exist only in memory, not in `/proc/*/environ`.
- **No secrets in Docker images**: Build arguments (`ARG`) never contain secrets. Images can be safely inspected with `docker history` without exposing credentials.
- **No secrets in logs**: Structured logging middleware automatically redacts fields matching patterns: `password`, `token`, `secret`, `authorization`, `cookie`, `x-csrf-token`. Redaction happens at the logger level, not at the call site, so a developer can't accidentally log a password.
- **API key rotation**: All API keys, JWT secrets, and encryption keys are rotatable without downtime. The application accepts both the old and new key during a configurable overlap window (default: 24 hours) to prevent disruption during rotation.

## 7A.9 — Rate Limiting & Abuse Prevention (Plan-Tier Driven)

All rate limits are resolved from the tenant's billing plan tier via `resolveRateLimits()` (see Part I-A, §1A.8), with per-tenant overrides possible:

- **Multi-tier rate limiting**:
  - **Global**: Caddy limits per-IP RPS from `config.security.rateLimitGlobalRps` (default: `100`). Exceeding returns `429`.
  - **Authentication**: Login attempts per window from `config.security.loginLockoutAttempts` (default: `5`) over `config.security.loginLockoutDurationMin` (default: `15`). Lockout applies to the account regardless of IP (preventing distributed brute force).
  - **API**: Per-tenant from plan tier. Tier defaults configurable in platform config (`PLAN_RATE_LIMITS`). Tenants can request custom overrides stored in `tenant_settings`.
  - **Expensive endpoints**: Separate limits from `config.security.rateLimitExpensiveReqPerMin` (default: `10`). Which endpoints qualify as "expensive" is defined in a configurable list, not hardcoded per-route.
- **CAPTCHA**: Triggered after `config.security.captchaThreshold` failed attempts (default: `3`). CAPTCHA provider configurable (`config.security.captchaProvider`: `hcaptcha` | `turnstile` | `recaptcha`).
- **Account enumeration prevention**: Login and password-reset endpoints return the same generic response regardless of whether the email/username exists. Timing normalized via `config.security.authResponseDelayMs` (default: `200`).

## 7A.10 — Dependency Supply Chain Security

- **npm/pip lockfiles with integrity hashes**: `npm ci` and `pip install --require-hashes` in CI. If a dependency's hash changes (indicating tampering or silent republish), the build fails.
- **Dependabot + manual review**: Automated PRs for dependency updates. No auto-merge — a human reviews every dependency update before it enters the codebase.
- **No `postinstall` scripts**: ESLint rule + CI check prevents packages with `postinstall` scripts from being added without explicit allowlisting. This is a common supply-chain attack vector.
- **SBOM generation**: A Software Bill of Materials (SBOM) in CycloneDX format is generated on every release. Enables rapid response to newly discovered CVEs in transitive dependencies.

---

# Part VIII: Backend Services

- NestJS API Gateway: Zod validation, Redis rate limiting, API versioning, webhook delivery with HMAC-SHA256
- Python FastAPI Engine: gRPC-only (no direct HTTP exposure), handles scheduling optimization, PDF parsing, constraint solving
- Redis: Per-tenant keyspace, caching, sessions, pub/sub for real-time
- RabbitMQ: Async job queue for emails, PDF generation, billing sync, large imports
- Background Worker: Consumes queue messages, processes jobs with retry logic and dead-letter queue

---

# Part VIII-A: Control Plane Service (Out-of-Band Management)

> A dedicated service running on a **separate port** (e.g., `3001`) that manages the entire LunchLineup platform from outside the application's own auth and RBAC system. This is the operator's interface — not the user's.

## 8A.1 — Why a Separate Service?

The main application (port 443 via Caddy) serves end users. But operators need to:
- Install the system from scratch on a fresh server.
- Start, stop, and restart individual services.
- Run database migrations or schema upgrades.
- View system-level diagnostics that should never be visible to any tenant.
- Manage backups and restore from disaster recovery.
- Update the platform itself (pull new images, roll out upgrades).

None of these actions belong in the tenant-facing RBAC system. They are **infrastructure operations**, not business operations. Mixing them into the main app creates a dangerous escalation surface.

## 8A.2 — State Machine: Installation → Running → Maintenance

The control plane is context-aware. It detects the current system state and presents the appropriate interface.

```
┌─────────────┐     ┌──────────────┐     ┌──────────────────┐
│  UNINSTALLED │────▶│  INSTALLING  │────▶│     RUNNING      │
│             │     │              │     │                  │
│ Shows setup │     │ Wizard steps │     │ Dashboard with   │
│ wizard      │     │ executing    │     │ service controls │
└─────────────┘     └──────────────┘     └───────┬──────────┘
                                                 │
                                         ┌───────▼──────────┐
                                         │  MAINTENANCE     │
                                         │                  │
                                         │ Upgrade in       │
                                         │ progress, backup │
                                         │ running, etc.    │
                                         └──────────────────┘
```

### State: UNINSTALLED (Fresh Server)
When the operator navigates to `http://server-ip:3001` and no `.installed` lock file or database exists:
- **Installation Wizard** walks through:
  1. **System check**: Verifies Docker, Docker Compose, required ports, disk space, and permissions.
  2. **Secrets generation**: Auto-generates `JWT_SECRET`, `APP_KEY`, database passwords, and encryption keys. Operator can override.
  3. **Database setup**: Creates the Postgres database, runs initial migrations, seeds system tables.
  4. **First super admin account**: Operator creates the initial platform admin.
  5. **TLS configuration**: Configure domain name, DNS records, and Caddy auto-TLS (or provide custom certs).
  6. **Summary & launch**: Review all settings, write config, start all services.
- After completion, a `.installed` lock file is created. The wizard cannot be re-entered without explicit operator action (to prevent re-init attacks).

### State: RUNNING (Normal Operation)
Dashboard showing:
- **Service status**: Live/stopped/unhealthy for each container (API, Web, Engine, Worker, Postgres, Redis, etc.) with uptime, CPU, and memory per container.
- **Quick actions**:
  - Start / Stop / Restart any individual service.
  - Restart all services.
  - Pull latest images and redeploy (with blue/green rollout).
  - Trigger a manual backup.
  - Restore from a previous backup (dropdown of available encrypted dumps).
  - View recent logs (tail of structured log output, filterable by service).
  - Run pending migrations (with diff preview before applying).
  - Clear Redis caches (per-tenant or global).
- **System diagnostics**:
  - Postgres: active connections, replication status, table sizes, slow query log.
  - Redis: memory usage, keyspace stats, connected clients.
  - Disk: usage by volume (data, backups, WAL archive, Docker images).
  - Network: open ports, Docker network connectivity tests between containers.
  - TLS: certificate expiry countdown, ACME status.

### State: MAINTENANCE
Triggered automatically during:
- Database migrations (services temporarily drained).
- Platform upgrades (rolling image replacements).
- Backup/restore operations.
- The main application shows a maintenance page to users during this state.
- The control plane shows progress bars, real-time log output, and ETA.

## 8A.3 — Automated Upgrade Workflow (via Control Plane)

When the operator clicks "Upgrade" or triggers it via the control plane API:

1. **Pre-flight checks**: Verify disk space, verify Postgres replication is current, run a backup.
2. **Pull new images**: Download new image SHAs from the private registry. Verify integrity.
3. **Stage migration**: Run `prisma migrate diff` and display the SQL changes for operator review. Operator must confirm.
4. **Enter maintenance mode**: Drain active connections gracefully (Caddy returns `503` with `Retry-After` header to new requests). In-flight requests complete.
5. **Apply migration**: Run the migration container. If it fails, **auto-rollback** the migration and exit maintenance mode. Alert operator.
6. **Rolling deploy**: Replace containers one at a time. Each must pass health checks. If any fail, halt and rollback to previous image SHA.
7. **Exit maintenance mode**: Caddy resumes accepting traffic.
8. **Post-upgrade smoke test**: Automated health check hits 5 critical endpoints. Results shown in control plane.
9. **Log the upgrade**: Everything recorded in the audit log — who triggered it, what version, what migrations ran, success/failure.

## 8A.4 — Control Plane Security

This service has **god-level access** to the infrastructure. It must be locked down harder than anything else.

- **Bind address**: Listens on `127.0.0.1:3001` by default. If the operator needs remote access, they configure it to bind to the server's LAN IP — **never** to `0.0.0.0` or a public interface.
- **Separate authentication**: Control plane has its own credential store (file-based, not in the main Postgres DB). Username + password + MFA (TOTP). This is the operator's key to the kingdom.
- **No Caddy / no public reverse proxy**: The control plane is NOT routed through Caddy. It runs its own embedded HTTPS server with a self-signed or internal CA certificate. It is invisible to the internet.
- **IP allowlisting**: Configurable list of IPs/CIDRs permitted to connect. Default: `127.0.0.1` only.
- **Session timeout**: 15-minute inactivity timeout. No long-lived sessions.
- **Audit trail**: Every action (start, stop, backup, restore, upgrade, config change) logged to a local file AND the database audit_log (if the database is accessible).
- **Emergency access**: If the database is down, the control plane still functions using its local file-based credential store and can display diagnostics, restart services, and restore from backup.
- **Docker socket access**: The control plane container mounts `/var/run/docker.sock` (read-write) to manage other containers. This is why it's on an isolated network — if this container is compromised, the blast radius must be contained.

## 8A.5 — Control Plane API

For automation and scripting (CI/CD integration, cron jobs, external monitoring):

```
POST   /api/auth/login              # Authenticate, get session token
GET    /api/status                   # System state + all container statuses
GET    /api/services                 # List all services with health
POST   /api/services/:name/restart   # Restart a specific service
POST   /api/services/restart-all     # Restart all services
POST   /api/upgrade/check            # Check for available updates
POST   /api/upgrade/apply            # Trigger upgrade workflow
POST   /api/backup/create            # Trigger manual backup
GET    /api/backup/list              # List available backups
POST   /api/backup/restore           # Restore from a specific backup
GET    /api/diagnostics/postgres     # DB health, connections, slow queries
GET    /api/diagnostics/redis        # Memory, keyspace, clients
GET    /api/diagnostics/disk         # Volume usage
GET    /api/diagnostics/network      # Container connectivity tests
GET    /api/logs/:service            # Tail logs for a service
POST   /api/maintenance/enter        # Enter maintenance mode
POST   /api/maintenance/exit         # Exit maintenance mode
GET    /api/migrations/pending       # List pending migrations with SQL diff
POST   /api/migrations/apply         # Apply pending migrations
POST   /api/cache/clear              # Clear Redis caches
```

All endpoints require the control plane session token. All actions are logged.

---

# Part IX: Frontend Architecture & Premium UX

*(Unchanged from prior revision, plus:)*

## 9.1 — Asset Loading Strategy

- **Critical CSS inlined** in the initial HTML response. No render-blocking stylesheet requests.
- **Fonts**: Self-hosted (vendored), served from `/fonts/` with `font-display: swap` and preload hints.
- **CDN assets**: Loaded with SRI hashes and local fallback (see Part IV).
- **Code splitting**: Next.js automatic route-based code splitting. No user downloads the admin dashboard code if they're a staff member.
- **Image optimization**: Next.js `<Image>` component with automatic WebP/AVIF conversion and responsive srcsets.
- **Service Worker**: Caches the app shell and critical assets for offline-capable schedule viewing (staff can check their shifts even with poor connectivity).

## 9.2 — Design System & Storybook

- Full component library documented in Storybook with visual regression testing (Chromatic or Percy).
- Every component shows: all states, all sizes, accessibility notes, usage code.
- Storybook deployed to a static URL for design/QA collaboration.

---

# Part X: Comprehensive Testing Architecture

## 10.1 — Test Pyramid

```
                    ┌──────────┐
                    │   E2E    │  ← Playwright (7 critical workflows)
                   ┌┴──────────┴┐
                   │ Integration │ ← Real DB, real Redis, real containers
                  ┌┴────────────┴┐
                  │    Unit       │ ← Vitest, PyTest (90%+ coverage)
                 ┌┴──────────────┴┐
                 │  Static Analysis│ ← ESLint, TypeScript, Semgrep
                 └────────────────┘
```

## 10.2 — Beyond the Pyramid

| Test Type | Tool | What It Validates |
|---|---|---|
| **Load (baseline)** | Artillery | 500 concurrent users, p99 < 200ms |
| **Load (stress)** | k6 | 5,000 req/s to auth endpoint |
| **Load (spike)** | k6 | Instant 10x traffic jump |
| **Load (soak)** | k6 | 72-hour sustained 2x load, detect memory leaks |
| **Chaos** | Custom scripts | Redis down, DB replica lag, engine crash mid-request |
| **Fuzz** | Custom + Atheris | Malformed PDFs, random inputs to constraint solver |
| **Security (SAST)** | Semgrep, Bandit | SQL injection patterns, secret exposure |
| **Security (DAST)** | OWASP ZAP | Running application vulnerability scan |
| **Security (pentest)** | External firm | Pre-launch manual penetration test |
| **Visual regression** | Chromatic/Percy | UI component screenshot diffing |
| **Accessibility** | axe-core + Playwright | WCAG 2.1 AA automated checks in E2E |
| **Contract** | Zod schema validation | Frontend/backend type agreement |

## 10.3 — Test Data Strategy

- **Factories**: Each entity (tenant, user, schedule, shift) has a factory function that generates realistic test data with sensible defaults and overrides.
- **Seed script**: `scripts/seed.ts` populates a development database with 3 tenants, 10 locations, 50 users, and 6 months of schedule history. New developers have a working dataset in one command.
- **Ephemeral DBs in CI**: Every test suite gets its own Postgres database (created/dropped within the CI run). Tests are fully isolated.

---

# Part XI: Observability & Incident Management

## 11.1 — The Three Pillars

| Pillar | Tool | Key Details |
|---|---|---|
| **Logs** | Loki + Grafana (self-hosted) | Structured JSON, correlation IDs, 30-day retention |
| **Metrics** | Prometheus + Grafana | Request latency, error rates, queue depth, cache hit/miss, DB connections |
| **Traces** | OpenTelemetry → Tempo | Full distributed traces across all services |

## 11.2 — Dashboards (Pre-Built Before Beta)

1. **System Health**: CPU, memory, disk, network per container.
2. **Application Health**: Request rate, error rate, p50/p95/p99 latency per endpoint.
3. **Business Metrics**: Active tenants, schedules published/day, staffed shifts/day.
4. **Database**: Active connections, query latency, replication lag, table bloat, cache hit ratio.
5. **Security**: Failed login attempts, rate limit hits, RBAC denials by endpoint.

## 11.3 — Alerting & Runbooks

- **PagerDuty/Opsgenie** for routing.
- Every alert links to a runbook in `docs/runbooks/`.
- **Alert tiers**:
  - **P1 (page immediately)**: All replicas down, DB unreachable, backup failure, TLS cert expiring in < 3 days.
  - **P2 (page during business hours)**: p99 > 1s for 5 min, error rate > 2%, disk > 85%.
  - **P3 (ticket)**: Dependency CVE detected, base image update available, slow query > 500ms.

## 11.4 — Public Status Page

- Self-hosted (Cachet) or managed (Instatus).
- Shows real-time status of: API, Web App, Scheduling Engine, Database.
- Users can subscribe to incident updates. Transparency builds trust with beta users.

---

# Part XII: Billing & Multi-Tenant SaaS Infrastructure

- **Stripe**: Subscriptions, usage-based billing, invoicing, customer portal.
- **Plans**: Free trial (14 days), Starter (2 locations), Growth (10 locations), Enterprise (unlimited + SSO + SLA).
- **Metered billing**: Per-active-staff-member, synced to Stripe monthly.
- **Grace periods**: 7-day grace on failed payments before feature restriction.
- **Tenant lifecycle**: Signup → Trial → Active → Past Due → Suspended → Cancelled → Data Purged (after 90 days, with email warnings).
- **Billing events** logged to a dedicated `billing_events` table for audit and debugging.

---

# Part XIII: Data Security, Privacy & Compliance

*See also: Part VII-A for full hostile-environment security hardening (DNS rebinding, CSRF, security headers, SSRF, network isolation, supply chain security).*

- **Encryption at rest**: LUKS full-disk on the server. Postgres tablespace on encrypted NVMe.
- **Encryption in transit**: TLS 1.3 everywhere (external and internal service-to-service). HSTS preloaded.
- **Application-level PII encryption**: AES-256-GCM on email, phone, full name. Hash columns for lookup. Key rotation supported without downtime.
- **GDPR/CCPA**: Right-to-erasure workflow (anonymize PII, log the action, confirm).
- **SOC 2 readiness**: Audit logging, access controls, change management, retention policies documented.
- **Privacy**: Fonts self-hosted (no Google tracking). No third-party analytics without explicit consent. Privacy policy acceptance timestamped per user.
- **Incident response plan**: Documented in `docs/runbooks/security-incident.md`. Covers: breach detection, containment, notification (within 72 hours per GDPR), forensics, and post-mortem.

---

# Part XIV: Execution Roadmap

| Month | Milestone | Key Deliverables |
|---|---|---|
| **1** | **Infrastructure** | Monorepo scaffold, Docker Compose, CI/CD pipeline (all 19 stages), Terraform IaC, secrets management, private container registry, **control plane service (install wizard + service lifecycle management)**. |
| **2** | **Database** | Postgres schema, custom postgresql.conf, PgBouncer, RLS policies, migration framework, backup/PITR/DR drill automation. |
| **3** | **Auth & IAM** | OIDC auth, MFA, session management, RBAC engine, audit logging, permission seeding, security middleware. |
| **4** | **Core API** | NestJS API gateway (all CRUD routes), Zod validation, rate limiting, API versioning, webhook system. |
| **5** | **Scheduling Engine** | Python FastAPI gRPC service, constraint solver, PDF parser, break calculator, message queue integration. |
| **6** | **Frontend Foundation** | Next.js scaffold, design system tokens, Storybook component library, vendored assets, font self-hosting, asset fallback system. |
| **7** | **UX Implementation** | Schedule table, drag-and-drop, Framer Motion animations, real-time WebSocket sync, optimistic UI, responsive tablet/mobile. |
| **8** | **Billing & Onboarding** | Stripe integration, plan management, onboarding wizard, seed data, notification system. |
| **9** | **Testing** | Full test suite (unit, integration, E2E, load, chaos, fuzz), visual regression, accessibility audit. |
| **10** | **Observability** | Prometheus/Grafana/Loki/Tempo stack, all dashboards, alerting, runbooks, public status page. |
| **11** | **Hardening** | External pentest, DAST scans, dependency audit, performance tuning, DR drill validation, compliance docs. |
| **12** | **Launch** | Closed beta (invite list), stabilize, iterate on feedback, open public beta. |
