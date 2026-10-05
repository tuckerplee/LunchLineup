# Availability Imports

Tenant-scoped, credit-metered PDF availability imports.

## Files

- `README.md`: this folder guide.
- `availability-imports.controller.spec.ts`: upload boundary, tenant authorization, and private error response coverage.
- `availability-imports.controller.ts`: authenticated multipart upload and import-status endpoints.
- `availability-imports.current-authority.spec.ts`: actual controller/service/RBAC/session authority checks over controlled transaction and Redis adapters; physical native acceptance remains separate.
- `availability-imports.module.ts`: NestJS module wiring.
- `availability-imports.publisher.spec.ts`: fast-worker, confirmed-publish crash recovery, lease reclaim, broker-failure state-machine, bounded transport teardown, and drain-readiness coverage.
- `availability-imports.publisher.ts`: leased database outbox publisher that confirms RabbitMQ delivery without overwriting live worker status; fenced expired or missing-owner RUNNING and stranded RETRYING recovery reuses durable publication, stops accepting sweeps before shutdown drain, bounds broker operations, and force-closes stuck transports.
- `availability-imports.service.spec.ts`: PDF validation, public employee-identity/account-binding separation, encrypted-envelope/AAD recovery, idempotency, exact debit/refund ledger settlement, terminal-result erasure, cleanup, and draining-admission contracts.
- `availability-imports.service.ts`: drain-gated atomic AES-256-GCM durable source creation, tenant-scoped public employee-identity and account binding, replay-safe job creation, paid-credit reservation, exact durable debit/refund settlement responses, and stale-file cleanup.

Uploads accept exactly one PDF no larger than 5 MiB and require a manager-visible Employee ID or Staff ID that matches the PDF. The API stores only its normalized hash for document matching; a separate server-only hash binds the job to the active tenant user, so email-only invitees work without showing or asking managers for database UUIDs. The versioned request identity is part of replay comparison, so changing the target user, PDF, or visible identifier conflicts instead of consuming credit again. Before returning `202`, the API requires the publisher to be ready, validates MIME, extension, signature, filename, and size; encrypts the bytes with dedicated `AVAILABILITY_IMPORT_ENCRYPTION_KEY`; authenticates tenant ID, import ID, and SHA-256 as AAD; and commits the envelope in the same transaction as the tenant-RLS job, active paid-subscription check, positive paid-credit reservation/debit, and publication outbox state. Shutdown flips publisher readiness before waiting for the active sweep, rejects new import debits while draining, and bounds RabbitMQ connect/channel/confirm/close work before force-closing a stuck transport. Plaintext filenames, employee identifiers, and PDF bytes are never persisted or logged. Local upload storage is only a verified optimization. The worker can recover after local-file loss from the authenticated database envelope, rechecks size, hash, and PDF signature before parser execution, and treats missing/corrupt durable plus local sources as retryable infrastructure failure. Success, failure, dead-letter, cancellation, user deletion, and retention cleanup erase both the encrypted payload and local reference; raw source normally ends immediately at terminalization. Its hard retention deadline is database `createdAt + 24 hours`, independent of settlement success. The bounded retention sweep prioritizes source past that deadline, clears the encrypted body under the tenant row lock while retaining the current local key, then unlinks that exact returned key after commit. Only successful unlink (including an already missing file) permits a tenant/job/age/current-key conditional update to clear the pointer; unlink, validation or final database failures retain the pointer for retry and keep sweep readiness failed. Unsettled jobs retain recovery bytes only before that deadline; job ownership, parsed results and billing evidence survive independent hard-source erasure. Settlement and erasure failures remain observable through failed sweep readiness and failure metrics. Erasure requires an available worker/database and successful filesystem cleanup; outage or backlog delays are operational failures requiring remediation, not extensions of the 24-hour policy. Parsed results remain review-only and are erased 24 hours after completion.

Retention selection uses a serialized, worker-process rotating keyset over `(hard-source priority, stable job id)`, bounded by the configured batch size. It advances after committed selection even when every selected row fails, wraps on an empty suffix, and resets on a successful empty full scan. Selection failures keep the previous cursor. No job, ownership or billing timestamps are changed for scheduling fairness. Restart resets the in-memory cursor; repeatedly crashing before a second sweep can repeatedly retry the initial failing batch, so this is process-lifetime fairness, not a durable progress guarantee.

Hard-age source cleanup runs before expiration settlement or ordinary retained cleanup. Failure leaves the nonterminal key and job/owner/billing state intact for retry; changed-key CAS failure also stops that sweep row before terminalization. Terminal database constraints require both raw-source fields to be NULL, so this durable pointer guarantee does not extend across successful terminalization of younger jobs. Already-terminal filesystem orphans rely on the existing API bounded filename/mtime orphan sweep; no terminal raw-pointer schema exception is introduced.

Create, matched idempotency replay, unique-race receipt recovery and cancellation
require the exact authenticated requester Session and current `users:write` grant
in the Serializable mutation scope. Ordered Tenant/User/Session/RBAC locking
precedes domain writes; new creation includes the target User in the ordered
User set. One finite trusted MFA observation occurs outside database callbacks
and is reused for the bounded retry and fresh-authorized recovery. Session and
MFA deadlines are checked after dependent waits and before callback completion.
Mutation receipts and durable ledger settlement are read inside that scope.
The standalone status reader and already-accepted background jobs retain their
existing contracts. Session IDs do not enter import request hashes.

Optional local copies belong to the request only after successful exclusive
creation. A request tracks every attempted owned copy across commit conflicts,
retains only the committed winning copy, and settles all other cleanup attempts
without replacing an authorization refusal or committed receipt. Failed unlink
remains subject to the existing bounded orphan sweep. New-job admission repeats
publisher readiness checks after authorization and domain waits.
