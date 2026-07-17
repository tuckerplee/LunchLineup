# API Locations

## Files

- `README.md`: this locations folder guide.
- `locations.controller.spec.ts`: deterministic bounded-list/cursor/summary, tenant isolation, required IANA timezone rejection, non-Eastern creation, workspace-bound first-location recovery, lost-response idempotency, plan capacity, active-row mutation serialization, published-history timezone protection, and queued-solve invalidation regression tests.
- `locations.controller.ts`: tenant-scoped location CRUD with required valid IANA timezones on create/update, a 100-row default/200-row maximum deterministic name/id cursor list, count-only summary, signed-in workspace binding for first-location recovery, serialized plan-limit enforcement, durable create idempotency, and schedule-safe lifecycle mutations.

## Notes

Location creation takes a tenant-specific transaction advisory lock before reading the active location count and inserting a location. This keeps the plan limit check and create operation atomic across concurrent API requests. First-location requests must pair `tenantName` with the verified `workspaceSlug`; the API compares that slug with the signed-in tenant and refuses organization-name changes after any active location exists. When `Idempotency-Key` is supplied, tenant-scoped hashes include the workspace-bound normalized payload; an identical retry returns the original row, while payload drift returns a conflict. Paid location limits apply only to an active current subscription or an unexpired trial; expired trials and delinquent or terminal tenants fall back to the free-tier cap.

Create and update requests must send a nonblank valid IANA timezone. The controller validates it before opening a tenant transaction, and the Prisma schema plus `20260716_location_timezone_drop_default.sql` remove the database's legacy Eastern default without rewriting existing rows. Edits send their current timezone explicitly even when only name or address changes.

Location timezone changes and soft deletion lock the active location before advancing associated active draft schedule revisions. This makes previously queued solve payloads stale without changing published schedule revisions. Because published and archived schedule views interpret stored UTC instants using the location timezone, timezone changes are rejected once any non-deleted published history exists; name-only and address-only edits remain allowed.

Active location lists use stable name/id ordering backed by a tenant/deletion/name composite index, avoiding separate tenant and tombstone index scans as a workspace grows.

Soft deletion prevents new schedules, shifts, or staff assignments at the location while preserving existing schedules and shifts for audit/history. Active operational schedule and shift reads exclude those retained rows.

GET `/api/v1/locations` is always bounded and returns `pagination.hasMore` plus an opaque `nextCursor`; callers must request continuation explicitly. `GET /api/v1/locations/summary` returns the exact active count without materializing location rows, and `GET /api/v1/locations/:id` supports exact selected-location recovery.
