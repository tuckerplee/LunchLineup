# LunchLineup System Rebuild Checklist

This tracking document corresponds to the 12-month Execution Roadmap in the Series A Public Beta plan.

## Month 1: Infrastructure
- [ ] Scaffold Turborepo monorepo (`apps/`, `packages/`, `infrastructure/`)
- [ ] Create `docker-compose.yml` and `docker-compose.ci.yml`
- [ ] Create multi-stage Dockerfiles (`web`, `api`, `engine`, `worker`, `control`, `migrations`, `backup`)
- [ ] Implement central typed configuration package (`packages/config`)
- [ ] Build GitHub Actions CI/CD pipeline (all 19 stages)
- [ ] Write Terraform IaC definitions
- [ ] Setup HashiCorp Vault / Secrets Management
- [ ] **Part VIII-A**: Build `lunchlineup-control` plane service (installation wizard, dashboard, API)

## Month 2: Database
- [ ] Provision Postgres container with custom `postgresql.conf.template`
- [ ] Configure PgBouncer
- [ ] Initialize Prisma schema and connection logic
- [ ] Implement Row-Level Security (RLS) policies
- [ ] Build out migration framework container
- [ ] Create config-driven automated backup loop (`scripts/backup.sh`)
- [ ] Create and automate disaster recovery drill (`scripts/dr-drill.sh`)

## Month 3: Auth & IAM
- [ ] Set up OIDC auth flow
- [ ] Implement multi-factor authentication (MFA)
- [ ] Build secure session management (HttpOnly Strict cookies, Double-submit CSRF)
- [ ] Create Casbin policy-based RBAC engine
- [ ] Implement append-only audit logging system
- [ ] Add initial permission seeding script

## Month 4: Core API
- [ ] Scaffold NestJS API Gateway
- [ ] Define global Zod input validation schemas
- [ ] Implement multi-tier rate limiting (global, auth, per-tenant, expensive)
- [ ] Build API versioning middleware
- [ ] Implement outgoing webhook system with HMAC signatures & DNS pinning SSRF protection
- [ ] Configure Caddy reverse proxy with CSP & security headers builder

## Month 5: Scheduling Engine
- [ ] Scaffold Python FastAPI Engine
- [ ] Set up gRPC communication with Node API
- [ ] Build core constraint solver for shift scheduling
- [ ] Implement PDF parsing pipeline
- [ ] Add break calculator logic
- [ ] Integrate RabbitMQ job queue & background worker

## Month 6: Frontend Foundation
- [ ] Initialize Next.js app scaffolding
- [ ] Define design system tokens (custom Tailwind/CSS)
- [ ] Set up Storybook for visual components
- [ ] Create initial vendor-asset downloader for CDN sovereignity
- [ ] Configure font self-hosting strategy
- [ ] Build offline Service Worker caching shell

## Month 7: UX Implementation
- [ ] Build responsive Drag-and-Drop scheduling table
- [ ] Add Framer Motion micro-interactions
- [ ] Implement real-time WebSocket state sync via Redis Pub/Sub
- [ ] Add optimistic UI updates on mutations
- [ ] Create specialized mobile & tablet responsive views

## Month 8: Billing & Onboarding
- [ ] Integrate Stripe (Subscriptions, usage-based, portal)
- [ ] Build plan management and metering logic
- [ ] Create tenant onboarding wizard
- [ ] Add pre-built seed data integration for new accounts
- [ ] Complete in-app notification system

## Month 9: Testing
- [ ] Reach 90%+ unit test coverage (`Vitest`/`PyTest`)
- [ ] Complete integration test suite against ephemeral DB
- [ ] Build E2E test suite (Playwright - 7 critical flows)
- [ ] Set up load testing tools (Artillery/k6)
- [ ] Implement Chaos engineering scripts
- [ ] Add accessibility audit checks (axe-core)

## Month 10: Observability
- [ ] Set up structured JSON logging (Loki + Grafana)
- [ ] Add Prometheus metric scraping & Grafana dashboards
- [ ] Implement OpenTelemetry distributed tracing (Tempo)
- [ ] Define PagerDuty/Opsgenie alerting rules
- [ ] Write incident runbooks for top 5 alerts
- [ ] Setup public-facing status page

## Month 11: Hardening & Compliance
- [ ] Run Dynamic Application Security Testing (DAST - OWASP ZAP)
- [ ] Lock down Docker networks (External, App, Data, Management)
- [ ] Enforce automated SBOM generation
- [ ] Set up automated base-image vulnerability scans
- [ ] Finalize GDPR/CCPA compliance and privacy policies
- [ ] Conduct external penetration test

## Month 12: Launch
- [ ] Execute test production deployment via Control Plane
- [ ] Open closed beta to initial invite list
- [ ] Gather feedback and deploy first patch cycles
- [ ] Stabilize operations
- [ ] **Open Public Beta**
