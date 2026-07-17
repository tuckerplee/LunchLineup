<div align="center">
  <h1>🍱 LunchLineup</h1>
  <p><strong>A highly resilient, multi-tenant scheduling & operations platform for modern shift work.</strong></p>

  <p>
    <a href="#core-philosophy">Philosophy</a> •
    <a href="#architecture-stack">Architecture</a> •
    <a href="#project-structure">Structure</a> •
    <a href="#local-development">Getting Started</a> •
    <a href="#ci-cd--deployment">Deployment</a>
  </p>
</div>

---

## 📖 Project Overview

**LunchLineup** is an enterprise-grade SaaS platform designed to handle complex scheduling, compliance, and operational tasks for physical locations. 

It is engineered from the ground up for **extreme resilience and operational sovereignty**. We assume networks are hostile, dependencies can vanish, and hardware fails. Every layer of the system is built with defense-in-depth, automated self-healing, and a "zero hardcoding" configuration philosophy.

## 🧠 Core Philosophy

Before touching the codebase, understand the principles that govern this project:

1. **Zero Hardcoding**: Every threshold, policy, and configuration is dynamic. Logic lives in code; policy lives in configuration (Tenant -> Platform -> System layers).
2. **Dependency Sovereignty**: If a third-party CDN or registry goes down, we still build and we still serve. All assets, fonts, Docker base images, and production third-party service images are vendored or digest-pinned.
3. **If it wasn't tested exactly like production, it wasn't tested**: Development, CI, and Production use the exact same Docker images and network topologies.
4. **Assume Hostility**: DNS rebinding protection, strict CSP, tenant-scoped Data (RLS), and zero-trust internal network segmentation are default baseline features.

---

## 🏗 Architecture & Stack

LunchLineup utilizes a **Turborepo** monorepo structure, orchestrating a suite of specialized microservices deployed entirely via Docker.

### The Stack
*   **Web (Frontend)**: Next.js 14+ (React), Tailwind CSS, Zod.
*   **API Gateway**: NestJS (TypeScript), REST & GraphQL.
*   **Engine**: Python 3.12 (FastAPI), used for complex scheduling algorithms, constraint solving, and data extraction.
*   **Worker**: Python background job consumer for scheduling, email, PDF, billing, and webhook jobs.
*   **Database**: PostgreSQL 16 with Row-Level Security (RLS) managed via Prisma ORM.
*   **Caching & Queues**: Redis 7 and RabbitMQ.
*   **Infrastructure**: Caddy (Reverse Proxy/Auto-TLS), PgBouncer (Connection Pooling), Docker Swarm / K3s.

---

## 📂 Project Structure

```text
lunchlineup/
├── .github/               # CI/CD, CodeQL, and Dependabot automation
├── apps/
│   ├── web/               # Next.js user-facing frontend
│   ├── api/               # NestJS API Gateway
│   ├── engine/            # Python scheduling/optimization engine
│   ├── worker/            # Background job processor
│   └── control-plane/     # Out-of-band infrastructure management (Port 300X)
├── packages/
│   ├── db/                # Prisma schema, migrations, and generated client
│   ├── config/            # 3-layer hierarchical configuration engine
│   ├── rbac/              # Policy-based permission definitions
│   ├── shared-types/      # Shared Zod schemas (frontend/backend boundary)
│   └── ui/                # Shared React component library
├── infrastructure/        # Dockerfiles, Caddyfiles, PG configs (templates)
├── scripts/               # Backup, restore, and disaster recovery scripts
└── docs/                  # Architecture Decision Records (ADRs) and Runbooks
```

### Root Files

- `.dockerignore`: Docker build ignore rules.
- `.env.example`: local environment variable template.
- `.github/`: GitHub workflow and repository automation configuration.
- `.gitignore`: Git ignore rules for local, generated, and sensitive files.
- `.zap-rules.tsv`: OWASP ZAP baseline scan rule severity configuration.
- `README.md`: this project overview and repository map.
- `apps/`: application workspaces for web, API, engine, worker, and control-plane services.
- `docker-compose.yml`: local and deployment service topology, including project-scoped persistent Postgres, Redis, and RabbitMQ volumes, loopback-only Alertmanager access, and the one-shot `ops` backup job.
- `docs/`: architecture, testing, and runbook documentation.
- `eslint.config.mjs`: repository ESLint configuration.
- `infrastructure/`: deployment infrastructure templates and service configuration.
- `old/`: legacy PHP application snapshot retained for migration parity.
- `package-lock.json`: pinned npm dependency lockfile.
- `package.json`: root workspace scripts and dependency metadata.
- `packages/`: shared database, configuration, RBAC, type, and UI packages.
- `scripts/`: operational, migration, deploy, and recovery scripts.
- `task.md`: historical 12-month rebuild roadmap; current launch gates live in `docs/runbooks/production-readiness.md`.
- `tests/`: repository-level deploy, hygiene, integration, and migration tests.
- `tsconfig.base.json`: shared TypeScript compiler baseline.
- `turbo.json`: Turborepo pipeline configuration.

---

## 🚀 Local Development (Getting Started)

Local development exactly mirrors production. There is no "mocking" of databases—you run the real stack.

### Prerequisites

1.  **Docker Desktop** (or equivalent Docker daemon).
2.  **Node.js 22+**
3.  **Git**

*Note: You do not need Postgres or Redis installed on your host machine.*

### 1. Initial Setup

Clone the repository and install workspace dependencies:

```bash
git clone https://github.com/tuckerplee/LunchLineup.git
cd LunchLineup
npm install
```

### 2. Environment Variables

Copy the example environment file, then set explicit local service credentials before starting Compose. The example intentionally leaves passwords and signing secrets blank so Compose fails fast instead of booting with copyable defaults.

```bash
cp .env.example .env
mkdir -p secrets
openssl rand -hex 32 > secrets/metrics_token
```

*Note: Never commit `.env` or `.env.local` to version control.*

At minimum, set `APP_ORIGIN` to the browser-visible origin (`https://...` in production), `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `APP_DB_USER`, `APP_DB_PASSWORD`, `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `RABBITMQ_USER`, `RABBITMQ_PASSWORD`, `GRAFANA_USER`, `GRAFANA_PASSWORD`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `SESSION_SECRET`, `MFA_SECRET_ENCRYPTION_KEY_CURRENT`, `CSRF_SECRET`, `METRICS_TOKEN_FILE`, and `CONTROL_PLANE_ADMIN_TOKEN_SECRET_FILE`. `POSTGRES_*` and `MIGRATION_DATABASE_URL` are owner credentials for migration, backup, and recovery only; runtime services use the distinct restricted `APP_DB_*`/`DATABASE_URL` credential so tenant RLS is not bypassed. Compose uses separate files for the metrics bearer token and the control-plane admin bearer token; production control-plane startup fails if no admin token is configured. Use `CADDY_SITE_ADDRESSES=https://your-domain.example.com` for public TLS deployments; keep the default localhost/private HTTP addresses only for CI or private development. `COOKIE_SECURE` defaults to `true`; set `COOKIE_SECURE=false` only for explicit HTTP-only dev deployments so browsers accept login cookies on private `http://` routes. Public SaaS deployments must also set `NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL`, `NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL`, and `NEXT_PUBLIC_DPA_CONTACT_EMAIL` to monitored production addresses; align `PUBLIC_SIGNUP_MODE` and `NEXT_PUBLIC_SIGNUP_MODE` to `closed_beta`, `invite_only`, or `open`; use generated `PUBLIC_SIGNUP_INVITE_CODES` for `invite_only`; and require `NEXT_PUBLIC_TURNSTILE_SITE_KEY` plus `TURNSTILE_SECRET_KEY` with API and frontend enforcement for `open`.

### 3. Start the Stack

The **only** supported way to run the application locally is via Docker Compose:

```bash
docker compose up --build
```

This single command will:
1. Spin up Postgres, Redis, RabbitMQ, and PgBouncer.
2. Build and launch the API, Web, Engine, Worker, and Control Plane containers.
3. Automatically run database migrations.
4. Start Prometheus, node-exporter, Loki, Tempo, and Grafana on private management networking.

### 4. Access the Application

*   **Web Frontend**: `http://localhost`
*   **API Gateway**: `http://localhost:4000` (loopback-only by default; set `API_HOST_BIND` explicitly for controlled dev exposure)
*   **Control Plane (Ops)**: `http://localhost:3001` (loopback-only; `/api/status` and `/api/control/*` require `Authorization: Bearer $(cat secrets/control_plane_admin_token)`, while `/api/metrics` uses `secrets/metrics_token`)

---

## 🛠 Commands & Scripts (Turborepo)

From the root directory, you can utilize the following `turbo` commands:

| Command | Action |
| :--- | :--- |
| `npx turbo run build` | Builds all apps and packages in the correct topological order. |
| `npx turbo run lint` | Runs ESLint and Prettier across the monorepo. |
| `npx turbo run test` | Executes unit and integration tests (Vitest/PyTest). |
| `npx turbo run typecheck`| Runs TypeScript checks across the workspace. |

---

## 🧪 Testing Strategy

Our CI pipeline enforces a strict testing hierarchy before any image is tagged for deployment:

1.  **Static Analysis**: ESLint, type checking, Semgrep SARIF, and CodeQL for JavaScript/TypeScript and Python.
2.  **Unit Tests (Fast-fail)**: Vitest and PyTest (`npm run test`). 90%+ coverage required.
3.  **Integration & E2E**: Ephemeral Docker Compose stacks are spun up in GitHub Actions. Playwright tests execute critical paths against live, networked containers.
4.  **Load Testing**: Artillery smoke tests to ensure `p99` latencies remain within acceptable bounds under load.

---

## 🚢 CI/CD & Deployment

Deployments are entirely automated—no human manually runs migrations or builds images.

1.  **Continuous Integration**: Every push triggers the full testing suite.
2.  **Artifact Generation**: Successful builds create immutable Docker images tagged with the exact Git SHA, pushed to our private registry, and verified against digest-pinned Docker bases plus Compose third-party service images.
3.  **Guarded In-Place Deployment**:
    *   The `lunchlineup-migrations` container applies DB schema changes with `MIGRATION_DATABASE_URL`, then creates or repairs the restricted application role and its grants.
    *   Compose replaces application containers from immutable release images after pre-mutation compatibility, backup, and release-proof gates pass.
    *   Each signed release retains a bounded secret-free version-2 source archive with exact package/lock/workspace manifests, schema/migrations, integration owners, rollback scripts, Compose/infrastructure inputs, and systemd units; materialization rejects missing, extra, or one-byte-drifted content.
4.  **Automated Rollbacks**: If post-deployment smoke tests fail, the system restores the retained previous release inputs. INT/TERM after rollback mutation begins triggers one bounded authenticated reconciliation before staging cleanup; activation is not blindly retried. Recovery time is measured during drills and is not assumed to be sub-minute.

---

## 🛡 Security & Compliance

*   **Row-Level Security (RLS)**: Enforced directly inside PostgreSQL. An application bug cannot expose another tenant's data. Everything is tenant-scoped by default.
*   **Network Isolation**: Data containers (DB, Redis, RabbitMQ) cannot route to the public internet. Only the Caddy reverse proxy faces external traffic.
*   **Container Runtime**: Production services deny privilege escalation and use read-only root filesystems. Application and stateless services drop all Linux capabilities, with only Caddy retaining `NET_BIND_SERVICE`; writable state, caches, uploads, and temp space are explicit volumes or bounded `noexec,nosuid,nodev` tmpfs mounts.
*   **Dependency Sovereignty**: Supply chain attacks are mitigated via strict lockfiles (`npm ci`), npm audits, digest-pinned container images, and our internal asset-vendoring policy (`scripts/vendor-assets.sh`). External CDNs are used for speed but fall back to local copies verified by SRI hashes if tampered with or offline.
*   **Configuration over Code**: CSPs, HSTS, CORS, and Rate Limits are configured dynamically, not hard-coded.

---

## 🤝 Contributing

1. Review the existing Architecture Decision Records (`docs/adr/`) before proposing structural changes.
2. Ensure your code passes all linting and type-checking.
3. Run the test suite before submitting a Pull Request.
4. If modifying database schemas, confirm you've followed the backward-compatibility guidelines for migrations.

---
*Built with operational paranoia and engineering excellence.*
