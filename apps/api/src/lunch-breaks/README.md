# API lunch-breaks

## Files

- `README.md`: this lunch-breaks folder guide.
- `lunch-break-generation-idempotency.spec.ts`: request-key validation and canonical request-hash coverage.
- `lunch-break-generation-idempotency.ts`: bounded `Idempotency-Key` validation plus hashed key and canonical request identities.
- `lunch-breaks.controller.spec.ts`: controller coverage for all-of setup-shift authorization, including Admin and Manager success plus missing-permission rejection, and mandatory normalized generation attempt keys.
- `lunch-breaks.controller.ts`: authenticated lunch/break policy, list, generation, setup, and edit endpoints.
- `lunch-breaks.module.ts`: Nest module wiring for lunch/break services and tenant-scoped Prisma access.
- `lunch-breaks.service.ts`: tenant-scoped lunch/break policy, feasibility-bounded generation, durable schedule revision updates for break mutations, credit-first durable generation outcomes, and shift mapping logic using RLS-aware Prisma transactions. The file is temporarily a compiled-style recovery module; see `docs/code-organization.md`.
- `lunch-breaks.service.spec.ts`: focused tests for short-shift feasibility, durable retry reuse, credit reservation and compensation, schedule revision updates, refreshed-role published visibility, publish-race locks, tenant-scoped Prisma usage, standalone/shared generation, persisted break mapping, setup persistence, and manual edits.

## Notes

Shared schedule reads and persisted lunch/break actions run through `TenantPrismaService.withTenant` so PostgreSQL RLS receives the current tenant context. Setup-shift batches require both `lunch_breaks:write` and `shifts:write` because they create or update authoritative Shift rows. Setup-shift batches, individual shift edits, and persisted generation require an explicit tenant-owned location; shift edits include it in the tenant-scoped lookup, while generation rejects shifts from any other location before the idempotency claim, credit charge, or schedule mutation. The API never guesses the tenant's first location. Preview generation remains standalone and does not require a location. Staff reads recognize current RBAC role labels, self-scope to the authenticated employee, and require a published schedule; draft break plans remain manager-only. Generation requires an `Idempotency-Key`; a tenant/key uniqueness boundary stores the canonical request hash, credit reservation, and terminal response or failure so response-loss retries never charge or mutate twice. Credits are reserved before schedule mutation, and wallet credits are restored when persistence fails. Break replacement and the reusable success outcome commit atomically after schedule rows are locked and re-checked as drafts. Admins and super admins remain excluded from assignment surfaces. Persisted break rows store optional `break1`, `lunch`, or `break2` identity, while older untyped rows remain compatible.
