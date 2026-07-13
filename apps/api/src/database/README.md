# API database helpers

## Files

- `README.md`: this database helper folder guide.
- `tenant-prisma.service.spec.ts`: unit coverage for tenant-scoped and platform-admin Prisma transaction contexts.
- `tenant-prisma.service.ts`: shared Prisma owner that sets transaction-local RLS context and accepts explicit interactive-transaction limits for tenant-scoped or platform-admin work.
