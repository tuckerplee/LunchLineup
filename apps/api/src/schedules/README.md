# Schedules API

## Files

- `README.md`: this schedules API folder guide.
- `auto-schedule-idempotency.ts`: canonical request hashing and `Idempotency-Key` validation for durable auto-schedule reuse.
- `schedule-availability.ts`: pure helpers for validating and matching local-day staff availability, including overnight windows.
- `schedule-availability.spec.ts`: verifies bounded overnight availability covers midnight and next-day segments without storing a `1440` endpoint.
- `schedule-solve-outbox.publisher.spec.ts`: focused publisher-confirm, transient retry, terminal refund, lease-contention, and compare-and-set recovery tests.
- `schedule-solve-outbox.publisher.ts`: bounded Postgres outbox sweeper that leases exact solve payloads, confirms persistent RabbitMQ messages, retries transient publication failures, and atomically fails and refunds jobs after configured attempt or age limits.
- `schedule-weekly-hours.spec.ts`: calendar-week boundary, DST, and cross-boundary existing-minute aggregation tests.
- `schedule-weekly-hours.ts`: location-calendar-week boundaries and tenant-wide existing-shift minute aggregation for weekly solver limits.
- `schedules.controller.spec.ts`: unit coverage for refreshed-role staff visibility, active-location read and creation serialization, publish/reopen lifecycle, required default break identities, configured availability, tenant-wide local-week publish limits, active-solve reuse and publish serialization, notification results, local-date boundaries, shift-window and break-aware publish gates, replacement confirmation, idempotent request reuse, transactional credit reservation, exact demand windows, draft revision snapshots, and durable auto-schedule jobs.
- `schedules.controller.ts`: tenant-scoped schedule lifecycle with active-location operational reads, location-row-locked creation, published-only staff reads, row-locked publish/reopen/delete transitions, required default break validation, configured-availability and tenant-wide local-week publish gates, active solve reuse, location-local date boundaries, draft demand-window read/replace setup, schedule-window and break-aware demand validation, exact demand-window plus tenant-wide existing-hours and shift-interval solver payloads, durable idempotency, notification results, and transactionally charged auto-schedule outbox jobs. The file is temporarily a compiled-style recovery module; see `docs/code-organization.md`.

## Notes

Staff schedule reads recognize both legacy enum claims and current RBAC role labels, then self-scope to published schedules containing an active assigned shift. Publishing commits before per-recipient notification delivery; the response reports delivered and failed counts without misreporting the committed publish as failed. Publish and new auto-schedule transactions lock the same draft row, and publish locks/rejects active solve jobs before reading shifts, so a queued or running generation cannot race an older draft into publication. Long default-policy shifts require `BREAK1`, `LUNCH`, and `BREAK2`; medium shifts require `LUNCH`. Auto-schedule messages snapshot the monotonic schedule revision and active shift IDs/revisions so workers reject stale solver results, including results queued before a manual break edit.

Assigned staff must have at least one global or matching-location availability rule, and every shift segment must fit those rules. Publish aggregates the candidate schedule with every other active tenant shift for each assigned employee using Monday-to-Sunday boundaries in the schedule location timezone. The most recent successful solve's `max_hours_per_week` applies when valid; otherwise the existing 40-hour solver default applies. API shift mutations and publish take the same tenant scheduling transaction lock before the final locked read/recheck, so concurrent API edits cannot bypass the gate. This behavior uses existing rows and requires no persistence migration.

Only one nonterminal solve job is allowed per schedule transaction. A retry with the original key reuses its exact job; a new browser attempt also receives the already-active job before credits are reserved, preventing duplicate paid requests.

Schedule creation locks and revalidates the active location row before interpreting local dates or inserting a draft. Active schedule reads exclude schedules whose location was soft-deleted. Those schedules and their assignments remain retained in the database for audit and controlled export; the operational API does not present them as current work.

Outbox publication remains durable through transient RabbitMQ failures. A failed broker publication terminalizes the domain job after `SCHEDULE_OUTBOX_MAX_PUBLISH_ATTEMPTS` (default `8`) or `SCHEDULE_OUTBOX_MAX_PUBLICATION_AGE_MS` (default 24 hours), whichever comes first. Terminalization, the deterministic credit-refund ledger insert, and wallet restoration share one database transaction, while terminal domain state releases publish and delete serialization.
