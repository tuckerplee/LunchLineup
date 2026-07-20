# API Migration Ledger

This ledger is the ordered source of truth for replacing the retained LunchLineup API serving `beta.lunchlineup.com`.

## API-01 — Browser cutover to API v2

Status: complete for the beta release containing this ledger. API-02 and API-03 remain open below.

Exit criteria:

- every application request made by browser code, Next.js authorization middleware, and the logout revocation route targets `/api/v2`;
- the API-v2 server exposes a shared exact catalog, not a wildcard or caller-selected upstream path;
- native calendar writes remain aggregate schedule change sets;
- old `POST|PUT|DELETE /shifts/{id}` browser mutations cannot be addressed through API v2;
- build, unit, migration, browser, deployment, and live-beta checks pass.

The shared catalog contains 121 explicit application operations. `GET /auth/me`, the six location operations, 16 People operations, nine Operations resources, six Time Card resources, three Notification operations, and four workspace Settings resources are native; 76 operations remain behind a compatibility owner:

| Domain | Compatibility operations |
| --- | ---: |
| Authentication | 16 |
| Locations | 0 |
| People and access | 1 |
| Operational reads and lunch/break planning | 0 |
| Time cards | 0 |
| Payroll | 17 |
| Notifications | 0 |
| Settings | 0 |
| Billing | 9 |
| Availability imports | 2 |
| Administration and account lifecycle | 31 |

These sit beside 11 native scheduling operations. The catalog is defined once in `packages/api-contract/src/application.ts`, used by both the browser transport and Fastify route registration, and covered by a migration test that rejects undeclared paths and the removed row-at-a-time shift mutation surface.

## API-02 — Replace retained implementations with native v2 modules

Status: in progress. API-02-LOC, API-02-OPS, API-02-TIME, API-02-NOTIFY, and API-02-SETTINGS are complete. API-02-AUTH has a native session boundary but retains its credential/lifecycle operations; API-02-PEOPLE owns 16 of 17 operations and retains the separately tracked staff-deactivation lifecycle extraction. The remaining domain replacements are open.

The API-01 routes are real, explicit public v2 routes, but their mature implementations remain behind bounded server-side compatibility owners. API-02 removes those dependencies domain by domain:

| Issue | Remaining native owner | Compatibility operations |
| --- | --- | ---: |
| API-02-AUTH | Login, cookie lifecycle, MFA mutation, reset, OTP, PIN, and OIDC; native session validation and `GET /auth/me` are complete | 16 |
| API-02-LOC | Native tenant locations plus exact public/internal identifier translation for declared retained domains | 0 |
| API-02-PEOPLE | Native staff, roles, permissions, PINs, scheduling profiles, invitation commands, and public identifier translation; staff deactivation remains pending lifecycle extraction | 1 |
| API-02-OPS | Native bounded schedule/shift/roster read models plus direct lunch/break planning, policy, generation, setup, and replacement | 0 |
| API-02-TIME | Native public time-card lifecycle, active recovery, correction, payroll fencing, and history | 0 |
| API-02-PAYROLL | Policy, period, review, lock, amendment, export, download, and reconciliation | 17 |
| API-02-NOTIFY | Native tenant notification feed, cursor pagination, and read-state commands | 0 |
| API-02-SETTINGS | Native tenant workspace aggregate with OIDC safety gate and audit | 0 |
| API-02-BILLING | Entitlements, recovery, checkout, portal, plan change, and resume | 9 |
| API-02-IMPORTS | Availability import creation and status | 2 |
| API-02-ADMIN | Platform tenant/user/plan/credit/audit plus account export and lifecycle | 31 |
| API-02-SCHED-SEAMS | Publication settlement and solver queue/status | 4 retained scheduling operations |

Each replacement must add specific TypeBox request/response schemas, tenant-scoped native services, public identifiers, authorization tests, and direct database/integration proof before its compatibility operation is deleted. No new operation may be added to the retained catalog; new product work must be native v2.

API-02-AUTH native slice: API v2 now verifies access-token signature, tenant/session revocation, effective role assignments, tenant status, session timeout, MFA policy and Redis MFA marker itself. Cookie sessions rotate at the v2 boundary. Native scheduling rejects incomplete MFA and forced PIN rotation before any domain service runs. The old private `/v1/auth/me` identity adapter has been removed. The remaining 16 credential and lifecycle operations still need native owners, and the public `/auth/me` envelope must be split from the internal authorization context before it stops exposing private storage `sub` and role-key fields to browser consumers.

API-02-LOC native slice: `/v2/locations` now owns list, summary, create, read, update, and soft delete with `Location.publicId` as the only browser identifier. It uses TypeBox contracts, tenant-RLS transactions, opaque `name, publicId` pagination, tenant capacity serialization, durable create replay, timezone-history fencing, and draft-revision invalidation. The temporary retained-domain seam translates only exact `locationId` and `locationIds` fields at the server boundary, never arbitrary `id` fields; disposable database proof plus beta deployment, authenticated browser workflow, and live API proof passed.

API-02-PEOPLE native slice: `/v2/users` now owns the tenant directory, role catalog and lifecycle, staff access assignments, invitations and durable encrypted invitation commands, invitation retry/reissue state, PIN reset/rotation, and scheduling profiles. `User.publicId` and `Role.publicId` are the only browser-visible identifiers. Direct native paths use tenant-RLS transactions, live authorization revalidation for mutations, CSRF/MFA gates, public UUID schemas, and tests for public-only serialization. The retained seam translates only exact `userId` and `userIds` fields for declared People/Time/Payroll/Notifications/Imports operations, including the one retained `DELETE /users/:userId` deactivation path. That deletion remains retained until its availability-import cancellation, credit-refund, and storage-cleanup lifecycle can be extracted as a single safe native owner.

API-02-OPS native slice: `/v2/schedules`, `/v2/shifts`, `/v2/shifts/staff-roster`, and the six lunch/break planning resources now use one direct tenant-RLS Operations owner. Every identifier and cursor is a public UUID; Staff receives only its own published assignments. Policy reads and updates remain ledger-free, while persisted generation, setup shifts, and changed individual break plans use tenant-first aggregate locking, paid feature authorization, immutable credit debits, idempotency replay, and draft revision fencing. The existing `/v2/break-generations` scheduling endpoint now calls this owner directly as well, leaving publication and solver behavior as the only retained scheduling seams. Contract, route, and restricted-PostgreSQL integration coverage prove the native owner and its public-ID, replay, credit, no-op, revision, and tenant-isolation boundaries.

API-02-TIME native slice: `/v2/time-cards` now owns history, active-card recovery, one-card reads, clock-in, clock-out, and corrections directly through tenant-RLS transactions. `TimeCard.publicId` and `TimeCardBreak.publicId` are the only browser-visible IDs; list cursors are opaque `clockInAt, publicId` positions. Clock-in preserves the prior durable operation/request identity exactly so a retry across the v1 cutover reuses its original row and immutable credit debit. New clock-ins require active paid entitlement and credits; reads and corrections require paid entitlement without debit; active reads and closing an existing card remain available after entitlement loss. Public contract, route, migration, browser-cutover, and restricted-PostgreSQL coverage prove no private storage IDs, tenant isolation, correction fencing, payroll cutoffs, exact replay, and recovery behavior.

API-02-NOTIFY native slice: `/v2/notifications` now owns the authenticated user feed and both read-state commands directly through tenant-RLS transactions. `Notification.publicId` is the only browser-visible notification identifier; the feed uses an opaque `createdAt, publicId` cursor and a bounded limit. Same-origin CSRF plus `notifications:write` protects reads-state mutations, and every update scopes both tenant and session user so callers cannot mark another worker's notifications. The retained scheduling outbox may continue to create durable feed rows during its separate publication seam, but no browser notification operation crosses the retained application bridge. Contract, route, unit, browser-cutover, and restricted-PostgreSQL coverage prove public-only serialization, pagination, tenant isolation, unread counts, and read-state containment.

API-02-SETTINGS native slice: `/v2/settings` now owns the general, team, and security workspace aggregate directly through tenant-RLS transactions. Every unsafe update requires same-origin CSRF and `settings:write`; request schemas are closed and require an explicit bounded change. Security policy writes create one append-only audit only when effective policy changes, recording MFA/session/SSO state and whether an issuer exists without retaining the issuer URL. SSO-only configuration fails closed unless API and web OIDC dependencies are present. Contract, route, unit, browser-cutover, and restricted-PostgreSQL coverage prove tenant isolation, no caller-selected tenant, OIDC safety, and audit redaction.

## Current known operational residuals

- Beta email delivery: password-email OTP and native staff invitation delivery remain unusable until VM107 receives a valid Resend API key and a provider-verified sender. The API container now resolves and reaches `api.resend.com`; the current runtime key is rejected by the provider with `400 validation_error: API key is invalid`. API-02-AUTH retains OTP transport work; native People invitations durably queue but must not be relied on for delivery until this external credential is updated. The beta password sign-in path remains verified.
- API-02-AUTH public-envelope cleanup: `/api/v2/auth/me` now includes `publicUserId`, but it still returns private storage `sub` and role-key fields because existing retained browser consumers use them for self-comparisons and recovery payloads. Replace those callers with public resource identifiers, then publish a separate browser-safe session schema with only public identifiers.

## API-03 — Retire public API v1 exposure

Status: open and blocked by API-02 plus external integration migration.

| Issue | Remaining public-v1 caller or edge | Required closure evidence |
| --- | --- | --- |
| API-03-OIDC | OIDC callback configuration | Provider configuration readback and a complete signed login round trip on the replacement path |
| API-03-STRIPE | Stripe webhook ingress | Endpoint readback, signature/replay tests, and a provider-observed delivery |
| API-03-METER | Meter-error webhook ingress | Signed replay tests and producer configuration readback |
| API-03-EMAIL | Email-delivery provider events | Signature/replay tests and provider configuration readback |
| API-03-RETENTION | Scheduled retention service-token ingress | Private or v2 replacement, systemd environment readback, dry-run proof, and one bounded execution proof |
| API-03-OPERATORS | Platform-admin runbook commands | Updated commands, authorization proof, and operator rehearsal against the replacement path |
| API-03-CLIENTS | Legacy or currently unknown API clients | Dated deprecation notice plus live route/edge telemetry showing zero required v1 traffic |
| API-03-EDGE | Caddy `/api/v1/*` matcher and Next.js v1 rewrite | Removal only after every preceding API-03 issue closes; verify v1 is unreachable and all v2 health/behavior checks stay green |

Each caller needs an explicit v2 or private ingress replacement, configuration readback, replay/signature tests where applicable, a dated deprecation window, and live traffic evidence showing no remaining v1 application use before the public v1 edge is removed.

Health and private metrics are service probes, not tenant application API operations, and remain separately routed.
