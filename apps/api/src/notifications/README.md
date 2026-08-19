# API notifications

## Files

- `README.md`: this notifications folder guide.
- `notification-outbox.processor.spec.ts`: crash recovery, lease retry, deterministic in-app and external-email identity, tenant eligibility, post-commit fan-out, outcome metrics, and terminal dead-letter tests.
- `notification-outbox.processor.ts`: bounded tenant-scoped notification intent claimer that idempotently persists one durable feed entry, completes schedule-publication email before terminal delivery state, retries transient failures, and leaves terminal failures observable.
- `notifications.controller.spec.ts`: controller tests for listing and marking notification feed entries.
- `notifications.controller.ts`: authenticated HTTP routes for notification feed operations.
- `notifications.module.spec.ts`: module-level proof that notification outbox outcomes update the root-owned shared Prometheus registry rather than a duplicate local registry.
- `notifications.module.ts`: Nest module wiring for notification routes and services; the service resolves the root-owned shared metrics provider during module initialization.
- `notifications.service.spec.ts`: service tests for tenant-scoped notification persistence, allowlisted operational diagnostics, identifier-free logs, reads, and durable outbox lifecycle wiring.
- `notifications.service.ts`: notification persistence, durable outbox lifecycle, unread counts, read markers, identifier-free allowlisted operational logs, and post-commit optional Redis fan-out.

Schedule publication inserts one outbox intent per distinct assigned recipient in the same transaction that marks the schedule published. The stable tenant/schedule/revision/recipient dedupe key prevents request retries from creating duplicate feed entries while a corrected republish receives a new identity. The API attempts delivery only after commit; when schedule email is enabled it uses the outbox ID as the Resend idempotency identity and marks the intent delivered only after provider acceptance or an intentional suppression/non-addressable skip. The lifecycle sweeper recovers pending or expired-lease rows after a crash. `FAILED` rows retry with bounded exponential backoff, while `DEAD_LETTERED` rows retain only a fixed allowlisted failure diagnostic and emit an identifier-free error log for operator action.
