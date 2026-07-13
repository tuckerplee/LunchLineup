# Worker Tests

Unit tests for queue-boundary validation and worker job handling.

## Files

- `README.md`: this folder guide.
- `test_billing_usage.py`: durable Stripe usage claim, retry, fresh resubmission identity, immutable logical snapshot upsert, final-attempt crash recovery, last-value-gated dual-identity operator replay, periodic snapshot freshness, current-snapshot exclusion, and over-batch sweep progression coverage.
- `test_password_reset_email.py`: encrypted reset-envelope compatibility, provider success, transient delivery retry, terminal dead-lettering, cycle-level sweep recovery, and liveness/readiness shutdown coverage.
- `test_pdf_parser.py`: parser coverage proving availability imports use extracted PDF text and fail closed for invalid uploads.
- `test_worker.py`: stdlib `unittest` coverage for worker validation, explicit empty availability protobuf mapping, dedicated existing-weekly-minutes and bounded existing-shift gRPC mapping, typed break persistence, break-aware working-demand enforcement, adjacent-segment coalescing and true-overlap rejection, billing and email dispatch routing, required background-task supervision and shutdown, durable redelivery idempotency, valid status/refund SQL, terminal-state settlement, atomic solved-shift/job completion, tenant-first claim/persistence/refund lock order, non-entitled tenant deletion barriers with pre-write rejection, active-location/timezone, monotonic draft revision and shift-snapshot guards, deterministic persistence, rollback behavior, and payload limits.
