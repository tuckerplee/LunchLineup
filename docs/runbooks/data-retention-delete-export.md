# Data Retention, Export, and Deletion Runbook

Use this runbook for privacy requests, account cancellation, tenant exports, and tenant deletion requests during public SaaS beta.

## Current Product Surfaces

- `DELETE /api/v1/users/:id`: tenant-admin user deactivation. It sets `deletedAt` and revokes that user's sessions.
- `POST /api/v1/admin/account/export`: starts a tenant-admin workspace export artifact for the caller's tenant. Requires `account:data_export`, writes `TENANT_EXPORT_REQUESTED`, and returns a job contract instead of tenant rows.
- `GET /api/v1/admin/account/exports/:jobId`: returns queued, running, ready, failed, or expired state only to the persisted requesting tenant and user.
- `GET /api/v1/admin/account/exports/:jobId/download`: streams the ready NDJSON artifact with attachment headers. It uses the same tenant and permission checks and never aggregates the artifact in API or browser memory.
- `GET /api/v1/admin/account/status`: tenant-admin account lifecycle status for the caller's tenant. Requires `settings:write` and returns cancellation/deletion state plus the retained-record schedule when deletion has been requested.
- `POST /api/v1/admin/account/cancel`: tenant-admin workspace cancellation for the caller's tenant. Requires `tenant_account:lifecycle` and tenant slug confirmation. It sets status `CANCELLED`, sets `deletedAt`, revokes tenant sessions, and writes `TENANT_CANCELLED_BY_CUSTOMER`.
- `DELETE /api/v1/admin/account`: tenant-admin deletion request for the caller's tenant. Requires `tenant_account:lifecycle` and tenant slug confirmation. It moves the tenant to `PURGED`, revokes tenant sessions, returns the retained-record schedule, and writes `TENANT_DELETION_REQUESTED_BY_CUSTOMER`. Retained billing, credit, audit, log, and backup records continue to follow the retention targets below.
- `POST /api/v1/admin/tenants/:id/archive`: platform-admin tenant cancellation/archive. It sets `deletedAt`, marks the tenant cancelled, and revokes tenant sessions.
- `POST /api/v1/admin/tenants/:id/restore`: platform-admin tenant restore.
- `DELETE /api/v1/admin/tenants/:id`: platform-admin hard database purge for a single tenant. The tenant must have a deletion request and the full retained database-record window must be expired; otherwise use the retained-record expiry dry-run for the schedule.
- `POST /api/v1/admin/retention/purge-expired`: two-stage purge contract. On its first `application_data` page it also discovers and retries bounded `SUSPENDED` deletion barriers whose Stripe cleanup did not finish; dry-run reports them without external calls, and retry failures increment `failedTenantCount`. `stage: "application_data"` becomes eligible after 30 days and requires `executeConfirmation: "purge-expired-application-data"`; it deletes workspace data while retaining billing, Stripe usage, credit, audit, backup, and security records plus the tenant tombstone. `stage: "retained_records"` becomes eligible after seven years and requires `executeConfirmation: "purge-expired-retained-records"` for final database deletion.

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

Prefer `POST /api/v1/admin/account/export` with an authenticated tenant admin session, poll the returned `statusPath`, and download the returned `downloadPath` before `expiresAt`. PostgreSQL persists the requesting tenant/user, state, lease, progress/error, expiry, row counts, and opaque artifact key. Any API replica can claim an expired lease after restart with `FOR UPDATE SKIP LOCKED`. Generation uses one repeatable-read tenant snapshot and ordered cursor pages; every query is row-bounded, serialized pages are byte-bounded, and output honors stream backpressure. Only one export may run per tenant and starts are rate-limited.

Production must set `TENANT_EXPORT_ARTIFACT_DIRECTORY` to an absolute path on storage shared by every API replica and set `TENANT_EXPORT_SHARED_STORAGE=true`. Compose uses `/var/lib/lunchlineup/tenant-exports` backed by the `tenant_export_artifacts` named volume. The API fails closed in production or multi-replica mode without that explicit contract. It creates the directory as `0700`, artifacts as `0600`, derives paths only from validated opaque keys, and sweeps expiry on the worker timer independently of requests. Do not bind this directory into the web container or expose it through a static file server.

Include:

- Tenant profile, plan, status, trial/grace dates, settings, and locations.
- Active and deactivated users with name, email or username, role, assigned roles, permissions, and lifecycle timestamps.
- Schedules, shifts, lunch breaks, lunch-break generation results/snapshots, break rules, and time-card records.
- Billing events, Stripe usage event rows, credit transactions, webhook endpoint metadata, redacted webhook delivery metadata, notifications, and audit-log rows relevant to the tenant.

Exclude or redact:

- Password hashes, PIN hashes, MFA secrets and TOTP replay-prevention claims, onboarding signup recovery/idempotency records, refresh/access tokens, session IDs, webhook secrets, internal Redis keys, metrics tokens, and infrastructure secrets.
- Security investigation notes that include another tenant's data.

The product artifact is NDJSON: a manifest line, one line per collection record, and a final completion line with collection counts. Package and encrypt it before external transfer, and record the transfer channel and checksum in the ticket.

## Backup Restore Proof Records

`scripts/dr-drill.sh` writes a JSON proof file for launch and disaster-recovery tickets. That proof should contain only operational evidence such as backup hash, off-host source URI, restored table count, and timestamps; do not attach backup payloads, SQL dumps, tenant exports, or customer rows to the proof record. A DR proof file does not satisfy a tenant export request.

## User Deactivation

1. Confirm the user belongs to the requester's tenant.
2. Use the tenant admin surface or call `DELETE /api/v1/users/:id` with a tenant admin session.
3. Verify the user is absent from `GET /api/v1/users`, has `deletedAt` set, and active sessions for that user are revoked.
4. Do not hard-delete historical schedule, shift, break, or time-card records solely because a user was deactivated. Those records may be operational or employment records for the customer.

## Time-Card Records

Clock-in and clock-out writes create tenant audit-log events. Current time cards are beta operational records only; do not describe them as payroll-final until approval, locking, timezone/pay-period policy, correction workflows, and payroll export reconciliation are implemented. Customer payroll systems remain the source of truth for wages, taxes, and legal payroll filings.

## Tenant Archive and Deletion

1. Export tenant data unless the customer declined export in writing. Prefer `POST /api/v1/admin/account/export` when the requester can authenticate.
2. If the customer only wants cancellation, prefer `POST /api/v1/admin/account/cancel` with tenant slug confirmation; use `POST /api/v1/admin/tenants/:id/archive` only for operator-managed cases.
3. If the customer requests deletion, use `DELETE /api/v1/admin/account` while the requester can still authenticate. This records the customer deletion request, moves the tenant to `PURGED`, and revokes tenant sessions.
4. Verify the tenant cannot authenticate and tenant sessions are revoked.
5. Hold retained records for the configured retention windows unless legal hold, billing, audit, abuse-prevention, or backup integrity requires longer retention.
6. Keep `scripts/invoke-retained-record-purge.mjs` scheduled for the confirmed `application_data` stage. The service token is API-restricted to that stage, API server time, and the 30-day cutoff. The same call retries any durable deletion barrier left `SUSPENDED` by a prior Stripe failure; verify `pendingDeletionBillingCandidates`, `reconciledDeletionTenants`, and `failedTenantCount` in the proof after every run.
7. After platform-admin approval and external backup/log expiry checks, run the same script with `RETENTION_PURGE_DRY_RUN=false` and `RETENTION_PURGE_EXECUTE_CONFIRM=purge-expired-retained-records`, or use `DELETE /api/v1/admin/tenants/:id` for a reviewed single-tenant operator action that has reached the same full retained database-record eligibility date. Attach the execution proof JSON and Prometheus alert recovery to the ticket.
8. Verify platform deletion removed tenant-scoped sessions, notifications, breaks, time cards, shifts, schedules, locations, settings, billing events, Stripe usage events, webhook endpoints, credit transactions, audit logs, roles, users, and the tenant row.
9. Record backup/log expiry expectations. Do not claim immediate removal from immutable backups or security logs.

Each purge request selects one stable `deletedAt,id` page of at most 25 candidates and returns `nextContinuation`. The first `application_data` page also selects at most the same bounded count of pending deletion-billing barriers, preserves their original audit `createdAt` as the deletion and retention timestamp, and retries each tenant independently before application-data purges. The scheduler wrapper follows at most `RETENTION_PURGE_MAX_PAGES` pages (default 20), so an old failing tenant cannot keep newer due candidates off every run. Execution uses one bounded transaction per tenant, acquires a tenant-keyed PostgreSQL advisory transaction lock, and re-checks eligibility. Review the proof's `processedTenantCount`, `failedTenantCount`, and `skippedTenantCount`; any failed tenant or exhausted page bound makes the overall wrapper exit nonzero after isolated attempts complete.

## Production Scheduler Installation

The deployable retained-record expiry scheduler lives in `infrastructure/systemd/`. Install `lunchlineup-retention-purge.service`, `lunchlineup-retention-purge.timer`, and a production-edited `/etc/lunchlineup/retention-purge.env` only from a clean, GitHub-pushed release checkout.

The scheduled service is safe by construction:

- It pins `RETENTION_PURGE_STAGE=application_data`, `RETENTION_PURGE_DRY_RUN=false`, and `RETENTION_PURGE_EXECUTE_CONFIRM=purge-expired-application-data` in `ExecStart` after the environment file is loaded.
- It targets `RETENTION_PURGE_URL=https://lunchlineup.com/api/v1/admin/retention/purge-expired`.
- It requires `RETENTION_PURGE_TOKEN_FILE=/run/secrets/retention_purge_token`, and the API container must use the same generated service token through `RETENTION_PURGE_SERVICE_TOKEN_FILE=/run/secrets/retention_purge_token` mounted from `RETENTION_PURGE_SERVICE_TOKEN_SECRET_FILE`.
- It writes `RETENTION_PURGE_PROOF_FILE=/var/lib/lunchlineup/proofs/retention-purge-latest.json`.
- It writes `RETENTION_PURGE_METRICS_FILE=/var/lib/node_exporter/textfile_collector/lunchlineup_retention_purge.prom`.
- It uses `RETENTION_PURGE_LOCK_FILE=/run/lunchlineup/retention-purge.lock` to avoid overlapping runs.
- The service token is rejected for `retained_records`, so scheduler configuration cannot trigger final deletion.

Deployment handoff is verify-first. Before declaring the scheduler installed, run `systemd-analyze verify` on both unit files, `systemctl enable --now lunchlineup-retention-purge.timer`, `systemctl start lunchlineup-retention-purge.service`, then verify the journal, `/var/lib/lunchlineup/proofs/retention-purge-latest.json`, and `/var/lib/node_exporter/textfile_collector/lunchlineup_retention_purge.prom`.

Prometheus gets these metrics through the Compose `node-exporter` textfile collector. Keep `NODE_EXPORTER_TEXTFILE_DIR` aligned with `RETENTION_PURGE_METRICS_FILE`; the default for both is `/var/lib/node_exporter/textfile_collector`.

Do not schedule the `retained_records` stage. After seven-year eligibility, verify external backup/log expiry, get platform-admin approval, and run that stage manually with its distinct confirmation.

## Monitoring and Alert Ownership

Platform on-call owns `RetentionPurgeTelemetryMissing`, `RetentionPurgeStale`, `RetentionPurgeFailed`, and `RetentionPurgeCandidatesReady`. Missing, stale, or failed dry-run telemetry means the scheduler install, generated service token, API secret mount, endpoint, or textfile collector is broken and must be investigated before any retained-record execution is approved. `RetentionPurgeCandidatesReady` opens a reviewed data-retention ticket with the dry-run proof attached; do not execute deletion from the scheduler or alert.

## Retention Targets

| Data class | Target retention |
| --- | --- |
| Active tenant workspace data | Retain while the subscription or trial is active. |
| Deactivated users | Retain with tenant workspace data unless the customer requests account-level purge and no legal hold applies. |
| Archived tenant application data | Purge after 30 days through the scheduled `application_data` stage. |
| Database backups | Retain up to 35 days unless the backup policy is changed and documented. |
| Application and security logs | Retain 90 days for incident response and abuse prevention. |
| Billing, Stripe usage, credit, and audit records | Retain 7 years where required for financial, compliance, or security evidence. |
| OTPs, reset tokens, and short-lived sessions | Expire according to the configured authentication TTLs. |

If production backup or log retention differs from these targets, update this runbook and `docs/runbooks/production-readiness.md` before launch.

## Remaining Product Work

- Add durable requester-facing status tracking for privacy requests beyond the API response, lifecycle status endpoint, and audit log.
- Confirm the production scheduler is enabled during deploy handoff and attach the first dry-run proof plus Prometheus alert recovery to the launch ticket.
