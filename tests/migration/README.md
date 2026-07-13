# Migration Tests

## Files

- `README.md`: this migration test folder guide.
- `audit-log-retention.test.mjs`: verifies retained-record deletion and purge-time audit actor redaction remain separately scoped, transaction-local append-only exceptions.
- `data-target-guard.test.mjs`: verifies destructive seed, import, migration, and VM107 restore guards fail before Prisma or host mutation.
- `database-role-isolation.test.mjs`: verifies runtime services use a restricted Postgres role while migrations retain the owner URL, and checks idempotent role attributes, grants, and default privileges.
- `legacy-parity-inventory.test.mjs`: validates that the legacy PHP source, legacy tests, TypeScript platform surfaces, Prisma schema, and migration documentation cover the required parity workflows.
- `platform-admin-audit-attribution.test.mjs`: verifies target-tenant audit semantics, non-relational platform actor identity, immutable actor columns, and unchanged audit RLS.
- `platform-admin-rls.test.mjs`: evaluates final migration ordering and RLS policy contracts so capability-authenticated platform operations can read cross-tenant workspace, RBAC, and audit rows while tenant context remains isolated.
- `prisma-migration-contract.test.mjs`: verifies raw SQL migrations target Prisma's quoted identifiers, stage existing solve-job request hashes before required-column schema push, keep RBAC replay least-privilege and assignment-safe, cover schema changes such as `TimeCard`, first-location request identity, and persisted scheduler inputs, and retain public-SaaS database integrity contracts.
- `scheduling-public-launch-integrity.test.mjs`: verifies shift/schedule window triggers and durable auto-schedule request uniqueness.
- `shift-overlap-constraint.test.mjs`: verifies assigned-shift no-overlap, schedule window/overlap, shift tenant/location, and break window database constraints plus their schema prerequisites.
- `staff-availability-overnight.test.mjs`: verifies overnight endpoints plus forced tenant RLS, tenant policies, and composite staff/location integrity for persisted scheduling profiles.
- `stripe-usage-logical-identity.test.mjs`: verifies deterministic Stripe usage snapshot dedupe and immutable tenant, metric, and period uniqueness.
- `tenant-account-lifecycle-rbac.test.mjs`: verifies fresh and upgrade ordering, duplicate-safe lifecycle permission reconciliation, and active system Admin-only grants without custom-role privilege expansion.
- `webhook-reliability.test.mjs`: verifies fresh migration helper ordering, nullable terminal retry timestamps, durable-before-network first-attempt crash recovery, ACTIVE/TRIAL delivery eligibility, nonterminal pause recovery, and PURGED-only lifecycle terminalization.
- `webhook-secret-preflight.test.mjs`: verifies v2 encryption output and legacy v1 envelopes pass structural preflight while plaintext or malformed values fail without destructive SQL.

## Purpose

These tests protect the migration contract between the live PHP behavior and the TypeScript SaaS platform.
