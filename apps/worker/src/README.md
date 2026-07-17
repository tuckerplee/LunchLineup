# Worker Source

Support modules used by the worker entrypoint.

## Files

- `README.md`: this folder guide.
- `availability_import.py`: versioned dedicated-key AES-256-GCM recovery, AAD/size/hash/signature verification, local-source fallback, resource-bounded parser orchestration, normalized public employee-identity result validation, and candidate-token propagation for ambiguous claim acknowledgements.
- `availability_import_store.py`: tenant-bound claims and commits requiring `ACTIVE`, non-`FREE`, a nonblank Stripe subscription ID, and future authoritative `stripeSubscriptionCurrentPeriodEnd`; separately validates manager-visible document identity and server-only active account binding, retrieves encrypted source bytes, proves one exact tenant/import/configured-amount debit plus immutable `balanceAfter`, preserves ordered final-handoff locking, rejects tokenless recovery while a foreign lease is live, atomically erases sources, records exact-once refund `balanceAfter`, and enforces 24-hour completion-based retention.
- `billing_usage.py`: durable periodic Stripe usage snapshot preparation keyed by immutable tenant, metric, and period identity, leased PostgreSQL claims, idempotent delivery, final-attempt crash terminalization, retry-first sweeping including fresh-identity API-reconciled asynchronous errors, last-value-gated fresh-identity dead-letter replay, and fair least-recently-metered batching; persisted retry and terminal reasons use fixed allowlisted codes rather than provider exception text.
- `password_reset_email.py`: encrypted password-reset outbox claiming, claim-time and final-handoff user/tenant lifecycle plus suppression checks, Resend delivery with stable idempotency, lease-owned transitions, bounded retry/dead-letter transitions with encrypted-envelope erasure on blocked or terminal states, cycle-level exception recovery, sweep liveness/readiness metrics, bounded durable plus process-local systemic-provider failure accounting that survives terminal diagnostic erasure, and terminal backlog alerts; persisted failure reasons are fixed allowlisted codes.
- `staff_invitation_outbox.py`: dedicated-key AES-256-GCM invitation recovery with the API AAD contract, one validated schema/config contract, canonical `APP_ORIGIN` links, stable per-outbox Resend idempotency across retries and a distinct provider action for each fresh reactivation/reissue outbox ID, bounded retry/provider-health orchestration, fail-closed freshness/readiness metrics, redacted diagnostics, and cancellation-safe sweep supervision.
- `staff_invitation_store.py`: explicitly platform-capable global PostgreSQL claims, atomic bounded `SKIP LOCKED` leases, expired-lease recovery, bounded terminalization after configured attempt-limit reductions, final lifecycle/suppression barriers, jittered retry scheduling, trigger-compatible terminal transitions, and bounded health queries.
- `parser_health.py`: sanitized bounded subprocess health probe, Prometheus readiness/failure metrics, transition-only diagnostics, and cancellation-safe monitoring for the isolated PDF parser.
- `telemetry.py`: optional queued OTLP trace export and W3C trace-context injection for engine calls.

## Folders

- `parser/`: PDF availability parsing helpers.
