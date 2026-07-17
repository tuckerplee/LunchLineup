# API database helpers

## Files

- `README.md`: this database helper folder guide.
- `tenant-prisma.service.spec.ts`: unit coverage for tenant-scoped and platform-admin Prisma transaction contexts, void-function execution, and Nest-managed client shutdown.
- `tenant-prisma.service.ts`: lifecycle-owned Prisma service that executes PostgreSQL void context setters inside parameterized transactions, accepts explicit interactive-transaction limits for tenant-scoped or platform-admin work, and disconnects during module shutdown.
- `transaction-error.spec.ts`: strict Prisma/PostgreSQL transaction-conflict and unique-constraint classification coverage.
- `transaction-error.ts`: shared classifiers for controlled Serializable retry failures and operation-scoped Prisma uniqueness conflicts without message matching.

## Raw SQL contract

PostgreSQL functions that return `void`, including transaction context setters and `pg_advisory_xact_lock`, must use parameterized `$executeRaw` so Prisma does not attempt row deserialization. Queries that return rows, including `SELECT ... FOR UPDATE` locks, remain on parameterized `$queryRaw`.
