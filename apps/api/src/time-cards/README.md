# API time-cards

## Files

- `README.md`: this time-cards folder guide.
- `time-card-idempotency.spec.ts`: clock-in key validation and tenant-scoped stable identity tests.
- `time-card-idempotency.ts`: bounded Idempotency-Key normalization and stable clock-in operation/request hashing.
- `time-cards.controller.ts`: tenant-scoped timecard list, active-card lookup, atomic billable clock-in, and compare-and-set clock-out endpoints.
- `time-cards.controller.spec.ts`: focused tests for permissions, billing, retries, concurrent clock-in/clock-out, rollback, and self-service behavior.

## Notes

Users with both `users:read` and `shifts:read` can view and manage team timecards when `time_cards` is enabled; the API uses effective permissions rather than legacy role labels so custom roles and revoked permissions behave consistently with the web UI. Other users can view and manage only their own cards. Self-service clock events use server time only; manual timestamps are reserved for team time-card managers. Tenant-scoped reads, writes, validators, and audit events run through `TenantPrismaService.withTenant`, prevent duplicate open cards, and validate location, shift, and tenant ownership. Clock-in requires an `Idempotency-Key`; card creation, one credit debit or included-usage ledger entry, and audit creation commit in one transaction. Replays return the original card, while conflicting keys or duplicate open-card requests do not consume usage. The active-card recovery lookup and clock-out remain available after entitlement loss so an already-paid open card can be closed; clock-out does not perform a new entitlement check or debit and uses an `OPEN`/null-timestamp compare-and-set, so only the winning request closes and audits a card. History and new clock-ins remain entitlement-gated. Team-manager timestamps and filters must be UTC ISO 8601 instants.

Time cards are beta operational records. They are not payroll-final until approval, locking, timezone/pay-period policy, correction workflows, and payroll export reconciliation are implemented.
