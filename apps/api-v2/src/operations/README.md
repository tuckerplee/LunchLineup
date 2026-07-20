# Operations API v2

## Files

- `README.md`: this module guide.
- `entitlement.ts`: scheduling aggregate lock plus compatibility re-exports of the shared native feature-settlement boundary.
- `entitlement.test.ts`: live-plan metadata compatibility regression tests.
- `lunch-breaks.service.ts`: native policy, read, generation, setup-shift, and individual-break persistence owner.
- `operations.service.ts`: bounded public schedule, shift, and roster read models.
- `pagination.ts`: strict UTC-window and opaque public-ID cursor utilities.
- `routes.ts`: Fastify/OpenAPI registration for the nine native Operations resources.
- `serialization.ts`: database-to-public operational and lunch/break response mapping.

This module owns the API-02 Operations surface directly through tenant-RLS transactions. It deliberately accepts and returns only public UUIDs, enforces bounded requests, and never calls the retained application bridge. Paid write paths use one tenant-first scheduling lock, immutable credit settlement, idempotency replay, and draft-schedule revision fencing.
