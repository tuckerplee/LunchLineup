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
2. **Dependency Sovereignty**: If a third-party CDN or registry goes down, we still build and we still serve. All assets, fonts, and base images are vendored/pinned.
3. **If it wasn't tested exactly like production, it wasn't tested**: Development, CI, and Production use the exact same Docker images and network topologies.
4. **Assume Hostility**: DNS rebinding protection, strict CSP, tenant-scoped Data (RLS), and zero-trust internal network segmentation are default baseline features.

---

## 🏗 Architecture & Stack

LunchLineup utilizes a **Turborepo** monorepo structure, orchestrating a suite of specialized microservices deployed entirely via Docker.

### The Stack
*   **Web (Frontend)**: Next.js 14+ (React), Tailwind CSS, Zod.
*   **API Gateway**: NestJS (TypeScript), REST & GraphQL.
*   **Engine**: Python 3.12 (FastAPI), used for complex scheduling algorithms, constraint solving, and data extraction.
*   **Worker**: Node.js background job processor (emails, PDF generation, async tasks).
*   **Database**: PostgreSQL 16 with Row-Level Security (RLS) managed via Prisma ORM.
*   **Caching & Queues**: Redis 7 and RabbitMQ.
*   **Infrastructure**: Caddy (Reverse Proxy/Auto-TLS), PgBouncer (Connection Pooling), Docker Swarm / K3s.

---

## 📂 Project Structure

```text
lunchlineup/
├── .github/               # CI/CD workflows and CODEOWNERS
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

Copy the example environment file. The default values are designed to work out-of-the-box for local testing.

```bash
cp .env.example .env
```

*Note: Never commit `.env` or `.env.local` to version control.*

### 3. Start the Stack

The **only** supported way to run the application locally is via Docker Compose:

```bash
docker compose up --build
```

This single command will:
1. Spin up Postgres, Redis, RabbitMQ, and PgBouncer.
2. Build and launch the API, Web, Engine, Worker, and Control Plane containers.
3. Automatically run database migrations.

### 4. Access the Application

*   **Web Frontend**: `http://localhost:3000`
*   **API Gateway**: `http://localhost:4000`
*   **Control Plane (Ops)**: `http://localhost:3001`

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

1.  **Static Analysis**: ESLint, Prettier, Pyright, and SAST scanning (Semgrep).
2.  **Unit Tests (Fast-fail)**: Vitest and PyTest (`npm run test`). 90%+ coverage required.
3.  **Integration & E2E**: Ephemeral Docker Compose stacks are spun up in GitHub Actions. Playwright tests execute critical paths against live, networked containers.
4.  **Load Testing**: Artillery smoke tests to ensure `p99` latencies remain within acceptable bounds under load.

---

## 🚢 CI/CD & Deployment

Deployments are entirely automated—no human manually runs migrations or builds images.

1.  **Continuous Integration**: Every push triggers the full testing suite.
2.  **Artifact Generation**: Successful builds create immutable Docker images tagged with the exact Git SHA, pushed to our private registry.
3.  **Zero-Downtime Deployment**: 
    *   The `lunchlineup-migrations` container applies DB schema changes.
    *   New application containers are rolled out incrementally. Caddy drains traffic from old containers to new ones only after health checks pass.
4.  **Automated Rollbacks**: If post-deployment smoke tests fail, the system automatically replaces the containers with the previous known-good Git SHA within 60 seconds.

---

## 🛡 Security & Compliance

*   **Row-Level Security (RLS)**: Enforced directly inside PostgreSQL. An application bug cannot expose another tenant's data. Everything is tenant-scoped by default.
*   **Network Isolation**: Data containers (DB, Redis, RabbitMQ) cannot route to the public internet. Only the Caddy reverse proxy faces external traffic.
*   **Dependency Sovereignty**: Supply chain attacks are mitigated via strict lockfiles (`npm ci`), npm audits, and our internal asset-vendoring policy (`scripts/vendor-assets.sh`). External CDNs are used for speed but fall back to local copies verified by SRI hashes if tampered with or offline.
*   **Configuration over Code**: CSPs, HSTS, CORS, and Rate Limits are configured dynamically, not hard-coded.

---

## 🤝 Contributing

1. Review the existing Architecture Decision Records (`docs/adr/`) before proposing structural changes.
2. Ensure your code passes all linting and type-checking.
3. Run the test suite before submitting a Pull Request.
4. If modifying database schemas, confirm you've followed the backward-compatibility guidelines for migrations.

---
*Built with operational paranoia and engineering excellence.*
