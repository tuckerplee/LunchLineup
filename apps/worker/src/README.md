# Worker Source

Support modules used by the worker entrypoint.

## Files

- `README.md`: this folder guide.
- `billing_usage.py`: durable periodic Stripe usage snapshot preparation keyed by immutable tenant, metric, and period identity, leased PostgreSQL claims, idempotent delivery, final-attempt crash terminalization, retry-first sweeping including fresh-identity API-reconciled asynchronous errors, last-value-gated fresh-identity dead-letter replay, and fair least-recently-metered batching.
- `password_reset_email.py`: encrypted password-reset outbox claiming, Resend delivery with stable idempotency, bounded retry/dead-letter transitions, cycle-level exception recovery, sweep liveness/readiness metrics, and terminal backlog alerts.
- `telemetry.py`: optional queued OTLP trace export and W3C trace-context injection for engine calls.

## Folders

- `parser/`: PDF availability parsing helpers.
