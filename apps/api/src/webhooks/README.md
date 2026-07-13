# Webhooks

## Files

- `README.md`: this webhook folder guide.
- `webhook-delivery.crypto.spec.ts`: current/previous key overlap, envelope version, and invalid-key regression coverage.
- `webhook-delivery.crypto.ts`: shared AES-256-GCM envelope helper for webhook endpoint signing secrets.
- `webhook-delivery.store.ts`: Postgres persistence for every encrypted webhook event before first delivery, ACTIVE/TRIAL delivery eligibility, pause-safe first-attempt and replay leases, concurrency-safe recoverable-publication claims, and terminal-only dead-letter transitions.
- `webhook-endpoints.controller.spec.ts`: endpoint lifecycle, tenant scoping, atomic audit attribution, rollback, and credential-redaction coverage for durable webhook destinations.
- `webhook-endpoints.controller.ts`: tenant-scoped webhook endpoint registration, rotation, enablement, and deletion API with atomic immutable actor audit records.
- `webhook-pending-recovery.ts`: bounded non-overlapping sweeps that broker-confirm recovery publications for due `PENDING`, legacy `QUEUED`, and `FAILED` deliveries.
- `webhook-replay.worker.spec.ts`: focused tests for publisher-confirm ordering, source-message ack/retry/dead-letter behavior, bounded stranded-row recovery, runtime health/metrics, and retry queue helpers.
- `webhook-replay.worker.ts`: compiled worker entrypoint that consumes opaque webhook retry IDs, confirms replacement publications before acking source messages, recovers bounded due rows, replays durable delivery envelopes, and exposes internal health/metrics endpoints.
- `webhook-retry-queue.ts`: durable queue topology and broker-confirmed publication helpers for webhook retry, delay, and ready queues.
- `webhooks.module.ts`: Nest module wiring for webhook delivery services.
- `webhooks.service.spec.ts`: focused tests for durable-before-network signed delivery, broker-confirmed opaque retry publication, encrypted event storage, first-attempt and replay claims, recoverable state, replay-envelope loading, and delivery-ID replay.
- `webhooks.service.ts`: webhook delivery service that persists and claims events before outbound HTTP, signs requests, enforces payload limits, broker-confirms queued delivery IDs, replays failed deliveries from durable envelopes, and marks max-attempt failures dead-lettered.

## Notes

Endpoint creation, configuration updates, signing-secret rotation, and deactivation write their AuditLog records inside the same tenant transaction as the endpoint mutation. Audit attribution includes the immutable actor identity plus bounded request metadata. Endpoint snapshots retain only the HTTPS origin, supported event names, and active state; URL paths, queries, fragments, signing secrets, encrypted envelopes, and hashes are never written to audit values.

RabbitMQ retry messages must stay opaque and must not include raw webhook URLs, payloads, secrets, or signatures. Every accepted event is inserted into `WebhookDelivery` under tenant RLS before any provider request, with URL and payload stored only in encrypted envelopes. The API then conditionally claims `PENDING` as `SENDING`; a crash leaves a stale lease that the recovery sweep converts to retryable work. Producers use confirm channels and wait for publisher confirms before changing durable queue state; replay workers also wait for the replacement publish confirm before acking the source message.

Endpoint signing secrets and queued delivery envelopes are encrypted with `WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT`. During rotation, `WEBHOOK_DELIVERY_ENCRYPTION_KEY_PREVIOUS` provides a bounded overlap key; the pre-DDL rotation command validates every envelope and re-encrypts it under the current key before the previous key can be removed. Any undecryptable row fails the release without printing or destroying credential material.

`QUEUED` with `nextAttemptAt = null` means RabbitMQ confirmed durable ownership. A non-null due `nextAttemptAt` on `PENDING`, legacy `QUEUED`, or `FAILED`, or a `SENDING` row older than the bounded replay lease, means publication needs recovery. The worker periodically claims at most `WEBHOOK_PENDING_RECOVERY_BATCH_SIZE` rows with `FOR UPDATE SKIP LOCKED`; stale `SENDING` becomes `FAILED`, `nextAttemptAt` is advanced by `WEBHOOK_PENDING_CLAIM_LEASE_MS`, and a confirmed recovery clears it. Conditional updates cannot overwrite `DELIVERED` or `DEAD_LETTERED` state. If a post-confirm state update fails, the source message is still acked because its durable replacement exists, while the leased database row remains available to bounded recovery instead of hot-looping duplicate publications.

Replay claims atomically move an eligible row to `SENDING`; `updatedAt` is the bounded lease timestamp, so a worker crash can be reclaimed after `WEBHOOK_REPLAY_LEASE_MS` (default 60 seconds, bounded to 10 seconds through 5 minutes). Redelivery during an active lease is routed through the delay queue for the remaining lease. The `webhook-replay` Compose service consumes IDs from `webhook_retries`, republishes failed deliveries through `webhook_retries.delay`, and rejects max-attempt messages without requeue so the queue's configured DLX moves them to `webhook_retries.dead` while the durable row becomes `DEAD_LETTERED`. Its internal runtime server defaults to `WEBHOOK_REPLAY_METRICS_PORT=3004` and serves `/health` for Compose healthchecks plus `/metrics` for Prometheus.

Tenant lifecycle delivery is eligible for `ACTIVE` and valid `TRIAL` tenants. `PAST_DUE`, `SUSPENDED`, and `CANCELLED` pause new claims without changing endpoint configuration or terminalizing queued work; an in-flight send that observes a pause returns to due `FAILED` state. Recovery to `ACTIVE` resumes the same durable rows. Only the terminal `PURGED` deletion lifecycle disables endpoints and dead-letters retryable deliveries; explicit endpoint deactivation remains terminal for that endpoint's work.
