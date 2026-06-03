# Prisma

## Files

- `README.md`: this Prisma folder guide.
- `schema.prisma`: canonical Prisma schema for tenants, users, RBAC, schedules, billing, notifications, and webhooks.
- `seed.ts`: development seed helper for baseline permissions, tenant data, and initial admin data.
- `migrations/`: SQL migrations and database initialization helpers applied to Postgres.

## Notes

The legacy user import targets this schema through `scripts/import-legacy-users.mjs`. Keep schema, migrations, and import assumptions synchronized before running imports against dev, staging, or production.
