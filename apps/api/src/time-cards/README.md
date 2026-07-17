# API time-cards

## Files

- `README.md`: this time-cards folder guide.
- `time-card-correction.spec.ts`: correction reason, timestamp range, and break ordering/non-overlap validation tests.
- `time-card-correction.ts`: strict UTC parsing and pure correction-window/break-interval validation.
- `time-card-correction.workflow.ts`: tenant-scoped optimistic correction transaction, overlap guard, break replacement, and immutable audit orchestration.
- `time-card-idempotency.spec.ts`: clock-in key validation and tenant-scoped stable identity tests.
- `time-card-idempotency.ts`: bounded Idempotency-Key normalization and stable clock-in operation/request hashing.
- `time-card-payroll-lock.spec.ts`: locked-period preflight, exact cutoff acceptance, cutoff-crossing rejection, and database-constraint diagnostic tests.
- `time-card-payroll-lock.ts`: tenant-scoped current/proposed clock-in locks, assigned-period clock-out cutoff enforcement, and fixed payroll-lock conflict recognition.
- `time-cards.entitlement.spec.ts`: active-paid zero-credit read, correction-time `PAST_DUE` transition rollback, and post-entitlement-loss active-card recovery boundary tests.
- `time-cards.controller.ts`: tenant-scoped timecard reads with location timezones, atomic billable clock-in, compare-and-set clock-out, and tenant-lock-entitled audited manager correction endpoints.
- `time-cards.controller.spec.ts`: focused tests for permissions, billing, retries, concurrency, assigned-period clock-out/correction cutoffs, location timezone responses, correction-time entitlement rollback, authorization, overlap rejection, optimistic locking, break persistence, and immutable audits.

## Notes

Time-card histories are capped at 100 rows by default and 250 rows maximum, expose an opaque next cursor, and use stable clock-in/id ordering. Active-card recovery uses the same stable ordering. Tenant/deletion/clock-in and tenant/user/deletion/clock-in composites cover team and employee timelines without relying on single-column bitmap scans.

Users with both `users:read` and `shifts:read` can view and manage team timecards when `time_cards` is enabled; the API uses effective permissions rather than legacy role labels so custom roles and revoked permissions behave consistently with the web UI. Other users can view and manage only their own cards. Self-service clock events use server time only; manual timestamps are reserved for team time-card managers. Tenant-scoped reads, writes, validators, and audit events run through `TenantPrismaService.withTenant`, prevent duplicate open cards, and validate location, shift, and tenant ownership. Clock-in requires an `Idempotency-Key`; active-paid entitlement, exact positive wallet cost, card creation, one credit debit, and audit creation commit in one transaction. Replays return the original card, while conflicting keys or duplicate open-card requests do not consume usage. Active-paid history/detail/correction controls use entitlement-only access and remain available at zero credits without a ledger mutation. Corrections recheck that entitlement only after acquiring the tenant row inside the exact mutation transaction, so a concurrent `PAST_DUE` transition commits no card, break, or audit write. The active-card recovery lookup and clock-out remain available after entitlement loss so an already-paid open card can be closed; clock-out does not perform a new entitlement check or debit and uses an `OPEN`/null-timestamp compare-and-set, so only the winning request closes and audits a card. Assigned payroll cards reject clock-out after the exact period cutoff, and corrections perform the same check after reassignment inside the transaction so the card and audit roll back together. Team-manager timestamps and filters must be UTC ISO 8601 instants. Corrections require effective team-management permissions, a bounded reason, the card version, non-overlapping timestamps and break intervals, and commit the card, interval rows, and immutable old/new audit values atomically. A manager cannot backdate or move a card into a locked payroll period, and both API preflight plus database triggers prevent card or break mutation after payroll lock. API responses include the work location IANA timezone; locationless legacy cards explicitly use UTC.

Clock-in and correction retain the entitlement-acquired `Tenant` row before taking tenant and period payroll advisory locks. Payroll export follows the same order, so a concurrent export cannot hold payroll advisory ownership while waiting back on the time-card tenant row. Barrier-controlled PostgreSQL integration coverage proves clock-in/export and correction/export each finish without `40P01`, partial cards/audits/exports, or duplicate charges.

Time cards are beta operational records. They become payroll-final only through the implemented period assignment, independent approval, terminal lock, paid export, and exact provider reconciliation workflow.
