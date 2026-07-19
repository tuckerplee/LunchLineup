# Data Retention, Export, and Deletion Runbook

Use this runbook for privacy requests, account cancellation, tenant exports, and tenant deletion requests during public SaaS beta.

## Current Product Surfaces

- `DELETE /api/v2/users/:id`: tenant-admin user deactivation. It sets `deletedAt` and revokes that user's sessions.
- `POST /api/v2/admin/account/export`: starts a tenant-admin workspace export artifact for the caller's tenant. Requires `account:data_export`, writes `TENANT_EXPORT_REQUESTED`, and returns a job contract instead of tenant rows.
- `GET /api/v2/admin/account/exports/:jobId`: returns queued, running, ready, failed, or expired state only to the persisted requesting tenant and user.
- `GET /api/v2/admin/account/exports/:jobId/download`: streams the ready NDJSON artifact with attachment headers. It uses the same tenant and permission checks and never aggregates the artifact in API or browser memory.
- `GET /api/v2/admin/account/status`: tenant-admin account lifecycle status for the caller's tenant. Requires `settings:write` and returns cancellation/deletion state plus the retained-record schedule when deletion has been requested.
- `POST /api/v2/admin/account/cancel`: tenant-admin subscription-renewal cancellation for the caller's tenant. Requires `tenant_account:lifecycle` and tenant slug confirmation. It schedules the verified Stripe subscription to cancel at period end, keeps workspace access active through the paid period, and writes `TENANT_CANCELLATION_SCHEDULED_BY_CUSTOMER` without starting the deletion clock.
- `DELETE /api/v2/admin/account`: tenant-admin deletion request for the caller's tenant. Requires `tenant_account:lifecycle` and tenant slug confirmation. It first commits a `SUSPENDED` access barrier and revokes tenant sessions. Successful Stripe cleanup returns a `FINALIZED` receipt after moving the tenant to `PURGED`; any post-barrier failure returns a `PENDING_BILLING_CLEANUP` receipt with the same durable request timestamp and leaves reconciliation retryable without claiming completion. Retained billing, credit, audit, log, and backup records continue to follow the retention targets below.
- `POST /api/v2/admin/tenants/:id/archive`: platform-admin tenant cancellation/archive. It sets `deletedAt`, marks the tenant cancelled, and revokes tenant sessions.
- `POST /api/v2/admin/tenants/:id/restore`: platform-admin tenant restore.
- `DELETE /api/v2/admin/tenants/:id`: platform-admin hard database purge for a single tenant. The tenant must have a deletion request and the full retained database-record window must be expired; otherwise use the retained-record expiry dry-run for the schedule.
- `POST /api/v1/admin/retention/purge-expired`: two-stage purge contract. Every API replica independently reconciles bounded due `SUSPENDED` deletion barriers from durable skip-locked claims; the first `application_data` page remains an additional operator-visible discovery/retry and dry-run reporting path, and its retry failures increment `failedTenantCount`. That first page applies the global dormant-session boundary: at most 5,000 sessions expired more than 24 hours ago or revoked more than 30 days ago are deleted, their `RefreshTokenReplay` rows cascade, and active credentials are excluded. `stage: "application_data"` becomes eligible after 30 days and requires `executeConfirmation: "purge-expired-application-data"`; it first invokes `public.purge_payroll_operational_time_cards(tenantId)`, then deletes workspace data, availability-import rows, expired export-job metadata, notification outbox rows, and stale signup-attempt identifiers in the same platform-admin transaction. The function fails closed while any time card is open, any payroll period is not terminal `LOCKED`, or a current card revision lacks an immutable locked snapshot; the transaction then rolls back without setting `applicationDataPurgedAt`. The first application-data page also deletes one platform-admin-only, skip-locked batch of at most 5,000 password-reset token hashes 24 hours after consumption or, when unconsumed, expiry; active unexpired reset credentials remain untouched and consumed credentials are never reactivated. Retained audit rows keep immutable event identity, action, resource, tenant attribution, and timestamp while direct user attribution is pseudonymized and payload/IP/user-agent fields are cleared; billing and Stripe usage rows keep financial evidence while provider metadata and retry errors are cleared. Credit, immutable payroll evidence, backup, security records, and the tenant tombstone remain. `stage: "retained_records"` becomes eligible after seven years and requires `executeConfirmation: "purge-expired-retained-records"`; final deletion calls `public.purge_expired_payroll_records(tenantId)` in FK-safe order alongside the audit retention function before user and tenant cleanup.

Use the tenant-admin endpoints first when the requester can authenticate. Use operator handling when the requester cannot authenticate, legal hold review is needed, or backup/log expiry proof must be verified outside the API.

## Intake Checklist

1. Verify the requester identity and authority:
   - Tenant owner/admin for workspace export or cancellation.
   - Affected user or tenant admin for user access/deletion requests.
   - Platform admin approval for permanent tenant deletion.
2. Record tenant ID, tenant slug, requester, request type, request date, due date, and approving operator.
3. Check for legal hold, active security incident, unpaid billing dispute, or restore-in-progress state.
4. Prefer read-only export first. Do not delete data until the requester confirms the export is complete or declines export.
5. Log the operator action in the ticket and, where an API path exists, rely on the API audit log instead of manual database writes.

## Export Procedure

Prefer `POST /api/v2/admin/account/export` with an authenticated tenant admin session, poll the returned `statusPath`, and download the returned `downloadPath` before `expiresAt`. PostgreSQL persists the requesting tenant/user, state, lease, internal progress/error, expiry, row counts, database-derived snapshot watermark, and opaque artifact key. Any API replica can claim an expired lease after restart with `FOR UPDATE SKIP LOCKED`. Generation captures the watermark inside one repeatable-read tenant snapshot and uses ordered cursor pages; every query is row-bounded, serialized pages are byte-bounded, and output honors stream backpressure. A job becomes `READY` only after the writer closes, the partial file is fsynced, same-directory atomic rename succeeds, and the artifact directory is fsynced; any failure remains non-ready and keeps cleanup/quota ownership until durable cleanup succeeds. Status and download calculate expiry against server time, download fails closed at the deadline even before the sweeper runs, successful downloads create an attributed audit event, and customer responses never expose the internal worker error. Only one export may run per tenant and starts are rate-limited.

Production must set `TENANT_EXPORT_ARTIFACT_DIRECTORY` to an absolute path on storage shared by every API replica and set `TENANT_EXPORT_SHARED_STORAGE=true`. Compose uses `/var/lib/lunchlineup/tenant-exports` backed by the `tenant_export_artifacts` named volume. The API fails closed in production or multi-replica mode without that explicit contract. It creates the directory as `0700`, artifacts as `0600`, derives paths only from validated opaque keys, and sweeps expiry on the worker timer independently of requests. Download responses are attachment-only, `private, no-store`, and `nosniff`. Do not bind this directory into the web container or expose it through a static file server.

Include:

- Tenant profile, plan, status, trial/grace dates, settings, and locations.
- Active and deactivated users with name, email or username, role, assigned roles, permissions, and lifecycle timestamps.
- Schedules, shifts, lunch breaks, lunch-break generation results/snapshots, break rules, time-card records, and normalized availability-import results/metadata still inside their one-hour retention window.
- Every payroll table through bounded explicit projections: `PayrollPolicyVersion`, `PayrollPeriod`, `PayrollTimeCardApproval`, `PayrollLockedEntry`, `PayrollAmendment`, `PayrollAmendmentDecision`, `PayrollOperation` audit summaries, `PayrollExportBatch`, `PayrollExportLine`, `PayrollReconciliationReceipt`, `PayrollReconciliationLineEvent`, and `PayrollReconciliationLineState`.
- Billing events, Stripe usage event rows, credit transactions, webhook endpoint metadata, redacted webhook delivery metadata, notifications, and audit-log rows relevant to the tenant.

Exclude or redact:

- Password hashes, PIN hashes, MFA secrets and TOTP replay-prevention claims, onboarding signup recovery/idempotency records, refresh/access tokens, session IDs, webhook secrets, internal Redis keys, metrics tokens, and infrastructure secrets.
- Availability PDF plaintext, encrypted source envelopes, source filenames, content/file hashes, idempotency hashes, publication/execution tokens or leases, provider retry metadata/errors, and internal publisher/parser errors.
- Payroll request hashes, lock request hashes, operation identifiers, and stored idempotency responses. Keep operational actor IDs, decisions, statuses, timestamps, counts, provider event references, and immutable evidence/content hashes.
- Security investigation notes that include another tenant's data.

The product artifact is NDJSON: a manifest line, one line per collection record, and a final completion line with collection counts. Package and encrypt it before external transfer, and record the transfer channel and checksum in the ticket.

Terminal delivery and solve rows do not remain secondary payload stores. Delivered or dead-lettered password-reset rows replace the duplicate token hash with an irreversible row pseudonym and clear ciphertext, key reference, and last error. Terminal webhook and notification outboxes clear encrypted/content payloads and last errors. Terminal schedule-solve rows clear the queued payload, publication lease/error, and execution claim.

## Backup Restore Proof Records

`scripts/dr-drill.sh` writes a JSON proof file for launch and disaster-recovery tickets. That proof should contain only operational evidence such as backup hash, off-host source URI, restored table count, and timestamps; do not attach backup payloads, SQL dumps, tenant exports, or customer rows to the proof record. A DR proof file does not satisfy a tenant export request.

## User Deactivation

1. Confirm the user belongs to the requester's tenant.
2. Use the tenant admin surface or call `DELETE /api/v2/users/:id` with a tenant admin session.
3. Verify the user is absent from `GET /api/v2/users`, has `deletedAt` set, and active sessions are revoked. In the same transaction, target availability imports must be cancelled/refunded and cleared of parsed results, encrypted PDF envelopes, and local storage references before the deletion trigger accepts the tombstone. The local unlink is retried after commit; no database PII copy remains.
4. Do not hard-delete historical schedule, shift, break, or time-card records solely because a user was deactivated. Those records may be operational or employment records for the customer.

## Time-Card Records

Clock-in and clock-out writes create tenant audit-log events. A time card becomes payroll evidence only after approval of its current revision and terminal period locking creates the immutable snapshot; later corrections use append-only amendments and reconciliation evidence rather than rewriting locked rows. The 30-day application purge must fail if a card is open, a period is not `LOCKED`, or a current immutable snapshot is missing. Customer payroll systems remain the source of truth for wages, taxes, and legal payroll filings.

## Tenant Archive and Deletion

1. Export tenant data unless the customer declined export in writing. Prefer `POST /api/v2/admin/account/export` when the requester can authenticate.
2. If the customer only wants to stop renewal, prefer `POST /api/v2/admin/account/cancel` with tenant slug confirmation. Verify the returned Stripe effective date and leave access active through the paid period. Use `POST /api/v2/admin/tenants/:id/archive` only for an operator-managed access shutdown.
3. If the customer requests deletion, use `DELETE /api/v2/admin/account` while the requester can still authenticate. Preserve the returned receipt before sign-out. `FINALIZED` proves the tenant reached `PURGED`; `PENDING_BILLING_CLEANUP` proves only that the irreversible `SUSPENDED` access barrier and original request timestamp committed, with scheduled reconciliation still required. Cancellation, platform archive, and deletion share the canonical tenant lifecycle lock and durable barrier check, so do not manually replace `SUSPENDED` with `CANCELLED`; an overlap must converge to the deletion `PURGED` result. Both deletion audit stages retain `actorTenantId` and a direct `actorUserId` until the 30-day minimization owner replaces the latter with its deterministic `deleted-user:` pseudonym.
4. Verify the tenant cannot authenticate and tenant sessions are revoked.
5. Hold retained records for the configured retention windows unless legal hold, billing, audit, abuse-prevention, or backup integrity requires longer retention.
6. Keep `scripts/invoke-retained-record-purge.mjs` scheduled for confirmed `application_data` execution and a separate `retained_records` dry-run. The service token uses API server time, may execute only the 30-day stage, and may only list seven-year candidates. Verify both proof files; the application-data proof also reports `sessionEligibleCount`, `sessionPurgedCount`, `pendingDeletionBillingCandidates`, `reconciledDeletionTenants`, and `failedTenantCount`.
7. When the retained-record review raises candidates, verify external backup/log expiry and legal holds, obtain platform-admin approval, then run the same script manually with a platform-admin bearer token, `RETENTION_PURGE_DRY_RUN=false`, and `RETENTION_PURGE_EXECUTE_CONFIRM=purge-expired-retained-records`. Alternatively use `DELETE /api/v2/admin/tenants/:id` for one eligible tenant. Attach the review and execution proof JSON plus Prometheus alert recovery to the ticket.
8. Verify the 30-day stage removed tenant-scoped `TimeCardBreak`, `PayrollTimeCardApproval`, and `TimeCard` rows only after its payroll preconditions passed. Verify final platform deletion removed all 12 retained payroll tables in FK-safe order plus sessions, signup-attempt identifiers, export-job metadata, availability-import metadata, notifications, breaks, shifts, schedules, locations, settings, billing events, Stripe usage events, webhook endpoints, credit transactions, audit logs, roles, users, and the tenant row.
9. Record backup/log expiry expectations. Do not claim immediate removal from immutable backups or security logs.

Each purge request selects one stable `deletedAt,id` page of at most 25 candidates and returns `nextContinuation`. The first `application_data` page also runs one platform-admin-only, skip-locked session batch and exposes at most the same bounded count of eligible deletion-billing barriers. Deletion-billing provider work is admitted only after a durable row records the original audit `createdAt`, attempt count, next-attempt time, replica lease owner, expiry, and fencing token. The scheduler claims one row just in time, excludes every tenant already attempted in that sweep, and revalidates plus renews the exact owner/token/unexpired lease immediately before provider entry. It never preclaims a serial batch. Only that exact owner/token may finalize; failures release only their own claim and move `nextAttemptAt` forward with bounded exponential backoff. The autonomous reconciler orders due rows by `nextAttemptAt,barrierCreatedAt,tenantId` and uses `FOR UPDATE SKIP LOCKED`, so a full limit of old failures is deferred and a newer healthy barrier advances on the next run.

Provider waiting is bounded by `TENANT_DELETION_BILLING_RECONCILE_ATTEMPT_TIMEOUT_MS` (default 90 seconds). Deadline or shutdown abort stops the claim heartbeat and persists exact-fence release/backoff as `PROVIDER_ATTEMPT_DEADLINE_EXCEEDED` or `RECONCILER_STOPPED`; a late stale owner cannot finalize tenant state. The injected deletion-cleanup provider facade remains responsible for replay-safe provider effects after an unknowable network completion. Module shutdown aborts the active reconciliation and waits at most `TENANT_DELETION_BILLING_RECONCILE_STOP_DRAIN_MS` (default 10 seconds); if database cleanup itself cannot drain inside that bound, the durable lease expires and fencing still rejects stale settlement. The retention scheduler wrapper still follows at most `RETENTION_PURGE_MAX_PAGES` pages (default 20). Purge execution uses one bounded transaction per tenant, acquires a tenant-keyed PostgreSQL advisory transaction lock, and re-checks eligibility. Review the proof's `sessionEligibleCount`, `sessionPurgedCount`, `processedTenantCount`, `failedTenantCount`, and `skippedTenantCount`; any failed tenant or exhausted page bound makes the overall wrapper exit nonzero after isolated attempts complete.

## Production Scheduler Installation

The deployable retention schedules live in `infrastructure/systemd/`. Install `lunchlineup-retention-purge.service`, `lunchlineup-retention-purge.timer`, `lunchlineup-retained-record-review.service`, `lunchlineup-retained-record-review.timer`, and a production-edited `/etc/lunchlineup/retention-purge.env` only from a clean, GitHub-pushed release checkout.

The schedules are safe by construction:

- `lunchlineup-retention-purge.service` pins `RETENTION_PURGE_STAGE=application_data`, `RETENTION_PURGE_DRY_RUN=false`, and `RETENTION_PURGE_EXECUTE_CONFIRM=purge-expired-application-data`; this daily run also applies the dormant-session batch boundary.
- `lunchlineup-retained-record-review.service` pins `RETENTION_PURGE_STAGE=retained_records` and `RETENTION_PURGE_DRY_RUN=true`. It has separate proof, metrics, and lock paths.
- Both target `RETENTION_PURGE_URL=https://lunchlineup.com/api/v1/admin/retention/purge-expired` and read `RETENTION_PURGE_TOKEN_FILE=/run/secrets/retention_purge_token`. The API container mounts the same generated secret through `RETENTION_PURGE_SERVICE_TOKEN_FILE` and `RETENTION_PURGE_SERVICE_TOKEN_SECRET_FILE`.
- Application-data evidence uses `RETENTION_PURGE_PROOF_FILE=/var/lib/lunchlineup/proofs/retention-purge-latest.json`, `RETENTION_PURGE_METRICS_FILE=/var/lib/node_exporter/textfile_collector/lunchlineup_retention_purge.prom`, and `RETENTION_PURGE_LOCK_FILE=/run/lunchlineup/retention-purge.lock`.
- Seven-year review evidence uses `RETENTION_PURGE_PROOF_FILE=/var/lib/lunchlineup/proofs/retained-record-review-latest.json`, `RETENTION_PURGE_METRICS_FILE=/var/lib/node_exporter/textfile_collector/lunchlineup_retained_record_review.prom`, and `RETENTION_PURGE_LOCK_FILE=/run/lunchlineup/retained-record-review.lock`.
- The API accepts the service identity for retained records only when `dryRun=true`, so scheduler configuration cannot trigger final deletion.

Deployment handoff is verify-first. Run `systemd-analyze verify` on all four unit files; enable both timers; start both services once; inspect both journals; and require all four proof/metrics files above before declaring the schedules installed.

Prometheus reads both metric files through the Compose `node-exporter` textfile collector. Keep `NODE_EXPORTER_TEXTFILE_DIR` aligned with both configured metric paths. Every metric carries both `mode` and `stage`: the automatic purge must report `mode="execute",stage="application_data"`, while retained-record review reports `mode="dry_run",stage="retained_records"`.

Do not schedule retained-record execution. After seven-year candidates appear, verify external backup/log expiry and legal holds, get platform-admin approval, and execute manually with the distinct confirmation.
## Monitoring and Alert Ownership

Platform on-call owns `ApplicationDataRetentionExecutionTelemetryMissing`, `ApplicationDataRetentionExecutionStale`, `RetentionPurgeTelemetryMissing`, `RetentionPurgeStale`, `RetentionPurgeFailed`, and `RetentionPurgeCandidatesReady`. The application-data alerts select only `mode="execute",stage="application_data"`: missing telemetry pages after 30 minutes, and an execution attempt older than 26 hours pages after 15 minutes. A successful retained-record or application-data dry-run cannot satisfy either execution alert. Verify the timer, latest proof JSON, textfile labels/timestamp, API response, and Prometheus series before resolving. Missing, stale, or failed retained-record dry-run telemetry separately blocks approval of any final retained-record execution. `RetentionPurgeCandidatesReady` opens a reviewed data-retention ticket with the dry-run proof attached; do not execute deletion from the scheduler or alert.

Engineering on-call owns `TenantDeletionBillingBacklogSustained` and `TenantDeletionBillingSweepStale`. For backlog, compare the backlog and oldest-pending-age gauges with the bounded `outcome` counter, then inspect only reconciliation tenant IDs, attempt counts, next-attempt times, error codes, and lease timestamps; do not log provider payloads or tenant billing content. For stale sweep, verify the API process, `/metrics` scrape, last-sweep timestamp, last-success timestamp, exported maximum staleness, database/platform-capability health, and scheduler logs. Do not clear or manually overwrite lease tokens. Recovery is a normal later sweep after the exact claim expires or records backoff.

## Retention Targets

| Data class | Target retention |
| --- | --- |
| Active tenant workspace data | Retain while the subscription or trial is active. |
| Deactivated users | Retain with tenant workspace data unless the customer requests account-level purge and no legal hold applies. |
| Archived tenant application data | Purge after 30 days through the scheduled `application_data` stage. |
| Time cards, card breaks, and approval rows | Purge after 30 days only when every card is closed/currently snapshotted and every payroll period is `LOCKED`; any failed precondition rolls back the tenant stage. |
| Immutable payroll policy, locked-entry, amendment, export, and reconciliation evidence | Retain with financial/compliance records for 7 years, then purge through the reviewed platform-admin retained-record stage. |
| Database backups | Retain up to 35 days unless the backup policy is changed and documented. |
| Application and security logs | Retain 90 days for incident response and abuse prevention. |
| Billing, Stripe usage, credit, and audit records | Retain 7 years where required for financial, compliance, or security evidence. |
| Availability import PDFs and job/parsed metadata | Plaintext exists only in bounded process/local scratch. PostgreSQL stores only a dedicated-key AES-256-GCM envelope, erased on every terminal/cancellation/deletion path. Nonterminal jobs expire after one hour and the 24-hour completion sweep erases any residual envelope/reference, so source payload retention is no more than 24 hours. Parsed results are erased 24 hours after completion; metadata follows tenant retention. |
| OTPs and reset tokens | Expire according to the configured authentication TTLs; terminal reset-delivery rows immediately erase duplicate token hashes and encrypted payloads. |
| Authentication sessions and refresh replay claims | Active sessions follow configured TTLs. The daily application-data retention run deletes up to 5,000 sessions expired more than 24 hours ago or revoked more than 30 days ago; replay claims cascade from deleted sessions. |

If production backup or log retention differs from these targets, update this runbook and `docs/runbooks/production-readiness.md` before launch.

## Remaining Product Work

- Add durable requester-facing status tracking for privacy requests beyond the API response, lifecycle status endpoint, and audit log.
- Confirm the production scheduler is enabled during deploy handoff and attach the first dry-run proof plus Prometheus alert recovery to the launch ticket.
