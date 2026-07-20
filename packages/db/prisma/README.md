# Prisma

## Files

- `README.md`: this Prisma folder guide.
- `schema.prisma`: canonical Prisma schema for tenants including authoritative Stripe paid-through state, legal holds, durable tenant-deletion billing claims/backoff/fencing, users, auth/RBAC, schedules, time cards, immutable payroll controls, billing with immutable wallet settlement results, notifications/webhooks, tenant exports including cleanup ownership fields/indexes, encrypted staff-invitation intents, and availability-import jobs with nullable encrypted source envelopes for upgrade-compatible recovery.
- `seed.ts`: development seed helper for baseline permissions, system admin RBAC, tenant data, and initial admin data; it requires `DATA_TARGET_ENV=test`, `disposable`, or `development` before loading Prisma and has no production override.
- `migrations/`: SQL migrations and database initialization helpers applied to Postgres.

## Notes

The legacy user import targets this schema through `scripts/import-legacy-users.mjs`. Fresh tenant creation atomically stores exact source-digest zero-wallet/no-ledger provenance in `PlatformConfig`; repeatable legacy-credit cleanup records matching per-tenant reconciliation evidence for older 1,000-credit imports instead of using a global pass marker. Keep schema, migrations, and import assumptions synchronized before running imports against dev, staging, or production.

API v2 exposes `publicId` UUIDs for users, locations, schedules, shifts, solve jobs, time cards, persisted time-card breaks, notification rows, and public payroll resources; internal primary keys remain storage-only. Database defaults keep older v1 writers compatible during the migration window. `ScheduleChangeSet` is the tenant-RLS, idempotent ledger for one atomic scheduling aggregate mutation and one schedule revision increment.

`Tenant.stripeSubscriptionCurrentPeriodEnd` is the authoritative Stripe-paid-through instant. Effective paid entitlement requires `ACTIVE`, a nonblank `stripeSubscriptionId`, and this field strictly in the future; `gracePeriodEndsAt` and wallet credits never substitute for it. Only Stripe synchronization owns population and clearing. `CreditTransaction.balanceAfter` is the immutable result returned by exact replay; pre-migration rows remain nullable and must fail closed when a caller attempts deterministic replay.

OIDC accounts bind the configured issuer and provider subject as an all-or-null pair on `User`. The pair is globally unique, while email remains tenant-scoped; callback logic requires provider-verified email and rejects any binding mismatch.

Run the development seed only with an explicit non-production scope, for example `DATA_TARGET_ENV=development npm run db:seed --workspace @lunchlineup/db`. `DATA_TARGET_ENV=production` is always rejected.

Production application roles must not be superusers or own the tenant tables, otherwise PostgreSQL can bypass row-level security. The API also has to set `app.current_tenant` inside the transaction that runs tenant-scoped queries; the migration helper stores that value transaction-locally to avoid pooled-connection tenant leaks.

Use `MIGRATION_DATABASE_URL` with the database owner only in the migration container. API, worker, webhook replay, and PgBouncer use `DATABASE_URL` built from the distinct `APP_DB_USER` and `APP_DB_PASSWORD`. The migration runner creates or repairs that login as `NOSUPERUSER NOBYPASSRLS`, grants existing schema objects, and installs owner-scoped default privileges for later migrations.
