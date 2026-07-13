# API Locations

## Files

- `README.md`: this locations folder guide.
- `locations.controller.spec.ts`: tenant isolation, write validation, lost-response idempotency, plan-capacity, active-row mutation serialization, published-history timezone protection, and queued-solve invalidation regression tests.
- `locations.controller.ts`: tenant-scoped location CRUD with serialized plan-limit enforcement, durable create idempotency, active-row mutation locking, published-history timezone protection, and atomic draft-solve invalidation on safe timezone changes or deletion.

## Notes

Location creation takes a tenant-specific transaction advisory lock before reading the active location count and inserting a location. This keeps the plan limit check and create operation atomic across concurrent API requests. When `Idempotency-Key` is supplied, the API stores tenant-scoped hashes of the key and normalized payload on the location; an identical retry returns that row, while payload drift returns a conflict. Paid location limits apply only to an active current subscription or an unexpired trial; expired trials and delinquent or terminal tenants fall back to the free-tier cap.

Location timezone changes and soft deletion lock the active location before advancing associated active draft schedule revisions. This makes previously queued solve payloads stale without changing published schedule revisions. Because published and archived schedule views interpret stored UTC instants using the location timezone, timezone changes are rejected once any non-deleted published history exists; name-only and address-only edits remain allowed.

Soft deletion prevents new schedules, shifts, or staff assignments at the location while preserving existing schedules and shifts for audit/history. Active operational schedule and shift reads exclude those retained rows.
