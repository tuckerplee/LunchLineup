# API shifts

## Files

- `README.md`: this shifts folder guide.
- `shifts.controller.ts`: tenant-scoped and scheduling-entitled shift CRUD, staff roster, and bulk assignment endpoints with active-location and schedule-row mutation locks plus schedule-window containment.
- `shifts.controller.spec.ts`: focused tests for active-location read and assignment safety, location mutation serialization, schedule-window and DST containment, refreshed-role published-only staff reads, publish and solver race locking, atomic guarded bulk writes, draft notification silence, tenant-scoped staff roster, scheduling entitlement gates, and shift controller behavior.

## Notes

Shift reads include linked staff and break records for calendar consumers. Active reads exclude shifts whose location was soft-deleted; retained historical rows remain available only to audit and controlled export paths. Scheduler-facing reads and rosters only include open shifts, managers, and staff; admins and super admins are excluded from planner/lunch-break assignment surfaces. Staff reads recognize current RBAC role labels and self-scope to assigned shifts on published schedules. Create and assignment paths lock and revalidate active locations before mutation; create, update, delete, and bulk assignment paths also acquire the tenant scheduling transaction lock and associated schedule rows `FOR UPDATE` so location lifecycle, weekly-hour publish validation, and writes cannot race. Bulk assignment performs its authoritative shift read after deterministic schedule locking and rolls back the transaction if any guarded row update misses. Shift timestamps remain UTC ISO 8601 instants; auto-created draft schedules use local calendar day boundaries. Draft mutations do not notify staff; schedule publish is the notification boundary.

When manual shift creation omits `scheduleId`, the API reuses a tenant- and location-scoped `DRAFT` schedule containing the full `[startTime,endTime)` interval. Only when none exists may it create a local-calendar fallback spanning the complete interval; any overlapping published or too-short draft schedule blocks fallback creation.
