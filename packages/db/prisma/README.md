# Prisma

## Files

- `README.md`: this Prisma folder guide.
- `schema.prisma`: canonical Prisma schema for tenants, users, durable onboarding signup attempts, OIDC identity bindings, RBAC, selector-based sessions, TOTP replay claims, password-reset delivery outbox, schedules, persisted scheduler inputs, schedule solve jobs, lunch breaks, time cards, billing, audit logs, notifications, webhooks, encrypted webhook delivery retries, and durable tenant export jobs.
- `seed.ts`: development seed helper for baseline permissions, system admin RBAC, tenant data, and initial admin data; it requires `DATA_TARGET_ENV=test`, `disposable`, or `development` before loading Prisma and has no production override.
- `migrations/`: SQL migrations and database initialization helpers applied to Postgres.

## Notes

The legacy user import targets this schema through `scripts/import-legacy-users.mjs`. Keep schema, migrations, and import assumptions synchronized before running imports against dev, staging, or production.

OIDC accounts bind the configured issuer and provider subject as an all-or-null pair on `User`. The pair is globally unique, while email remains tenant-scoped; callback logic requires provider-verified email and rejects any binding mismatch.

Run the development seed only with an explicit non-production scope, for example `DATA_TARGET_ENV=development npm run db:seed --workspace @lunchlineup/db`. `DATA_TARGET_ENV=production` is always rejected.

Production application roles must not be superusers or own the tenant tables, otherwise PostgreSQL can bypass row-level security. The API also has to set `app.current_tenant` inside the transaction that runs tenant-scoped queries; the migration helper stores that value transaction-locally to avoid pooled-connection tenant leaks.

Use `MIGRATION_DATABASE_URL` with the database owner only in the migration container. API, worker, webhook replay, and PgBouncer use `DATABASE_URL` built from the distinct `APP_DB_USER` and `APP_DB_PASSWORD`. The migration runner creates or repairs that login as `NOSUPERUSER NOBYPASSRLS`, grants existing schema objects, and installs owner-scoped default privileges for later migrations.
