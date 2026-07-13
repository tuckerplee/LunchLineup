# Privacy and Security Commitments

This document is the public beta source of truth for privacy and security copy. Keep public pages aligned with this file before launch.

## Data Categories

LunchLineup stores the minimum tenant data needed to run workforce scheduling:

- Workspace records: tenant name, slug, plan, status, locations, settings, and usage credits.
- User records: name, email or username, role, assigned permissions, MFA/PIN state, lockout state, and session metadata.
- Scheduling records: schedules, shifts, lunch breaks, break rules, locations, and time-card records when enabled.
- Billing and operations records: plan configuration, metering, billing events, credit transactions, webhook endpoints, notifications, audit logs, and security telemetry.

LunchLineup must not expose password hashes, PIN hashes, MFA secrets, refresh tokens, session identifiers, webhook secrets, or internal security telemetry in customer exports or public support replies.

## Beta Privacy Commitments

- Customer workspace data is used to provide scheduling, lunch-break planning, time cards, support, abuse prevention, incident response, and service reliability.
- Customer data is not sold.
- Each workspace is tenant-scoped. Application queries must run with the active tenant context, and production database roles must not bypass row-level security.
- Users can be deactivated by a tenant admin. Tenant admins can export, cancel, and request deletion for their own workspace through tenant-scoped account lifecycle endpoints.
- Security and audit logs may be retained after account deletion when needed for abuse prevention, incident response, legal hold, billing, or backup integrity.
- Public privacy copy must route to monitored, owner-approved privacy, support, and DPA contacts before paid general availability. Public pages read `NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL`, `NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL`, and `NEXT_PUBLIC_DPA_CONTACT_EMAIL`; missing, invalid, or template-style values render as pending owner signoff instead of public email links.

## Security Commitments

Current implementation evidence:

- Authentication uses secure session cookies, JWT access tokens, refresh flow validation, MFA support, OTP email delivery, PIN lockout, and tenant status checks.
- Authorization uses RBAC permissions and route guards for tenant and platform administration.
- Tenant isolation is reinforced by database row-level security and the tenant Prisma transaction helper.
- Public API bootstrap blocks unsafe production CORS, host, cookie, metrics, body-limit, and email-sender configuration.
- Caddy and API layers include security headers, protected metrics access, and no-store API cache behavior.
- Sensitive operations are intended to create audit-log entries.
- Incident response, production readiness, rollback, database failover, high CPU, and high error-rate runbooks exist under `docs/runbooks/`.

## Account Lifecycle State

Implemented:

- Tenant admins can soft-delete users through `DELETE /api/v1/users/:id`, which sets `deletedAt` and revokes that user's sessions.
- Tenant admins can start an expiring NDJSON workspace artifact through `POST /api/v1/admin/account/export`. Generation is tenant-scoped, audited, repeatable-read, cursor-paged, byte-bounded, and streamed; status and download authorization re-check the tenant and `account:data_export`. The artifact omits password hashes, PIN hashes, MFA secrets, backup codes, refresh tokens, session identifiers, webhook signing secrets, encrypted PII ciphertexts, encrypted webhook payloads, and raw audit value payloads.
- Tenant admins can inspect their account lifecycle status through `GET /api/v1/admin/account/status`. When deletion is requested, the response includes retained-record categories and purge eligibility dates.
- Tenant admins can cancel their own workspace through `POST /api/v1/admin/account/cancel` after confirming the tenant slug. Cancellation marks the tenant `CANCELLED`, sets `deletedAt`, revokes tenant sessions, and writes an audit-log event without storing export contents or secret values.
- Tenant admins can request deletion for their workspace through `DELETE /api/v1/admin/account` after confirming the tenant slug. The request marks the tenant `PURGED`, revokes tenant sessions, and records the retained-record categories and eligibility dates that remain subject to billing, audit, log, and backup retention.
- Platform admins can archive tenants through `POST /api/v1/admin/tenants/:id/archive`, restore tenants through `POST /api/v1/admin/tenants/:id/restore`, and hard-delete deletion-requested tenants through `DELETE /api/v1/admin/tenants/:id` only after retained database records expire.
- Platform tenant hard deletion removes tenant-scoped sessions, notifications, breaks, shifts, schedules, locations, settings, billing events, webhook endpoints, credit transactions, audit logs, users, and the tenant row only after the full retained database-record window has expired.
- The retention endpoint purges application data after 30 days while preserving billing, Stripe usage, credit, audit, backup, and security records plus a tenant tombstone. A distinct platform-admin confirmation removes retained database records only after seven years; immutable backups and external security logs are verified separately.
- Retained-record expiry has a dry-run-default scheduler wrapper, proof-file contract, metrics output, and alerting contract in `docs/runbooks/data-retention-delete-export.md`.

Implemented as public beta wording and docs; still needs production legal/contact confirmation before paid GA:

- Public `/subprocessors` route and `docs/compliance/subprocessors.md` list current beta subprocessors.
- Public privacy, security, and status pages expose configured privacy, support, and DPA contact addresses, or owner-signoff gating text when those values are not approved for production use.
- `docs/compliance/dpa-readiness.md` records customer-facing DPA request wording and paid GA legal blockers.

Not implemented yet:

- Durable customer-facing lifecycle request status tracking beyond the API response, lifecycle status endpoint, and audit log.
- Production installation of the retained-record expiry scheduler.
- Self-service physical deletion of retained billing, audit, log, or backup records where retention duties require delayed expiry.

Use `docs/runbooks/data-retention-delete-export.md` for retained-record handling, delayed physical deletion, legal holds, and operator-only platform deletion.

## Launch Gate

Before public SaaS beta:

- Publish `/privacy` and `/security` routes from this policy source.
- Publish `/subprocessors` from `docs/compliance/subprocessors.md`.
- Set `NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL`, `NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL`, and `NEXT_PUBLIC_DPA_CONTACT_EMAIL` to monitored, owner-approved production addresses.
- Confirm legal approval for the DPA template and customer signature process.
- Confirm production backup and log retention match the retention runbook.
- Record legal/support owner signoff for privacy, security, status, subprocessors, and DPA request routing.
- Add tracked tickets for lifecycle request status tracking and production retained-record scheduler installation if they are not shipped before beta.
