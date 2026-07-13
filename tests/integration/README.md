# Integration Tests

This folder contains service-backed smoke tests for the rebuild CI ephemeral stack. These tests require the GitHub Actions Postgres and Redis services and are intentionally separate from the fast migration hygiene suite.

## Files

- `README.md`: this integration test folder guide.
- `ephemeral-stack.test.mjs`: checks CI service connectivity, replays pre-schema and forward SQL through the production runner's shared ordering/filter contract, proves repeated RBAC seed execution preserves custom assignments and removes Staff break-write access, and verifies migrated worker persistence paths.

## Command

Run from the repo root against disposable Postgres 16 and Redis 7 services. The test command does not start services or provision the restricted application database role.

Set `MIGRATION_DATABASE_URL` to the disposable database owner URL, `DATABASE_URL` to the matching restricted application-role URL, and `REDIS_URL` to the disposable Redis URL. Before the test, run the same migration step as CI with `APP_DB_USER`, `APP_DB_PASSWORD`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `PLATFORM_ADMIN_DB_CONTEXT_SECRET`, `WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT`, and `DATA_TARGET_ENV=test` set:

```bash
node scripts/apply-db-migrations.mjs
npm run test:integration
```

Tenant-scoped setup and verification statements use explicit transactions because `set_current_tenant` is transaction-local.
