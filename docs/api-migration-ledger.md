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

The shared catalog contains 121 explicit application operations. `GET /auth/me`, the six location operations, all 17 People operations, nine Operations resources, six Time Card resources, 17 Payroll operations, three Notification operations, and four workspace Settings resources are native; 58 operations remain behind a compatibility owner:

| Domain | Compatibility operations |
| --- | ---: |
| Authentication | 16 |
| Locations | 0 |
| People and access | 0 |
| Operational reads and lunch/break planning | 0 |
| Time cards | 0 |
| Payroll | 0 |
| Notifications | 0 |
| Settings | 0 |
| Billing | 9 |
| Availability imports | 2 |
| Administration and account lifecycle | 31 |

These sit beside 11 native scheduling operations. The catalog is defined once in `packages/api-contract/src/application.ts`, used by both the browser transport and Fastify route registration, and covered by a migration test that rejects undeclared paths and the removed row-at-a-time shift mutation surface.

## API-02 — Replace retained implementations with native v2 modules

Status: in progress. API-02-LOC, API-02-OPS, API-02-TIME, API-02-PAYROLL, API-02-NOTIFY, API-02-SETTINGS, and API-02-PEOPLE are complete. API-02-AUTH has a native session boundary but retains its credential/lifecycle operations. The remaining domain replacements are open.

The API-01 routes are real, explicit public v2 routes, but their mature implementations remain behind bounded server-side compatibility owners. API-02 removes those dependencies domain by domain:

| Issue | Remaining native owner | Compatibility operations |
| --- | --- | ---: |
| API-02-AUTH | Login, cookie lifecycle, MFA mutation, reset, OTP, PIN, and OIDC; native session validation and `GET /auth/me` are complete | 16 |
| API-02-LOC | Native tenant locations plus exact public/internal identifier translation for declared retained domains | 0 |
| API-02-PEOPLE | Native staff, roles, permissions, PINs, scheduling profiles, invitation commands, deactivation lifecycle, and public identifier translation | 0 |
| API-02-OPS | Native bounded schedule/shift/roster read models plus direct lunch/break planning, policy, generation, setup, and replacement | 0 |
| API-02-TIME | Native public time-card lifecycle, active recovery, correction, payroll fencing, and history | 0 |
| API-02-PAYROLL | Native public payroll policy, period, review, lock, amendment, export, download, and reconciliation | 0 |
| API-02-NOTIFY | Native tenant notification feed, cursor pagination, and read-state commands | 0 |
| API-02-SETTINGS | Native tenant workspace aggregate with OIDC safety gate and audit | 0 |
| API-02-BILLING | Entitlements, recovery, checkout, portal, plan change, and resume | 9 |
| API-02-IMPORTS | Availability import creation and status | 2 |
| API-02-ADMIN | Platform tenant/user/plan/credit/audit plus account export and lifecycle | 31 |
| API-02-SCHED-SEAMS | Publication settlement and solver queue/status | 4 retained scheduling operations |

Each replacement must add specific TypeBox request/response schemas, tenant-scoped native services, public identifiers, authorization tests, and direct database/integration proof before its compatibility operation is deleted. No new operation may be added to the retained catalog; new product work must be native v2.

API-02-AUTH native slice: API v2 now verifies access-token signature, tenant/session revocation, effective role assignments, tenant status, session timeout, MFA policy and Redis MFA marker itself. Cookie sessions rotate at the v2 boundary. Native scheduling rejects incomplete MFA and forced PIN rotation before any domain service runs. The old private `/v1/auth/me` identity adapter has been removed. `/api/v2/auth/me` now serializes a separate browser-safe envelope: public UUID, canonical role/label, workspace display data, opaque signed scope handles, permissions, and required presentation/MFA state only. It never returns JWT `sub`, raw role keys, tenant/session identifiers, or legacy-role fields. The remaining 16 credential and lifecycle operations still need native owners.

API-02-LOC native slice: `/v2/locations` now owns list, summary, create, read, update, and soft delete with `Location.publicId` as the only browser identifier. It uses TypeBox contracts, tenant-RLS transactions, opaque `name, publicId` pagination, tenant capacity serialization, durable create replay, timezone-history fencing, and draft-revision invalidation. The temporary retained-domain seam translates only exact `locationId` and `locationIds` fields at the server boundary, never arbitrary `id` fields; disposable database proof plus beta deployment, authenticated browser workflow, and live API proof passed.

API-02-PEOPLE native slice: `/v2/users` now owns the tenant directory, role catalog and lifecycle, staff access assignments, invitations and durable encrypted invitation commands, invitation retry/reissue state, PIN reset/rotation, scheduling profiles, and deactivation. `User.publicId` and `Role.publicId` are the only browser-visible identifiers. Direct native paths use tenant-RLS transactions, live authorization revalidation for mutations, CSRF/MFA gates, public UUID schemas, and tests for public-only serialization. Native deactivation locks the tenant and live administrator session, rejects self/equal-or-greater access changes, clears only editable shift assignments, fences each affected draft schedule once, cancels/refunds unfinished availability imports with provenance checks, tombstones credentials/PII, revokes sessions, and clears bounded local source files after commit. The retained seam now translates only exact `userId` and `userIds` fields for declared Time/Payroll/Notifications/Imports operations.

API-02-OPS native slice: `/v2/schedules`, `/v2/shifts`, `/v2/shifts/staff-roster`, and the six lunch/break planning resources now use one direct tenant-RLS Operations owner. Every identifier and cursor is a public UUID; Staff receives only its own published assignments. Policy reads and updates remain ledger-free, while persisted generation, setup shifts, and changed individual break plans use tenant-first aggregate locking, paid feature authorization, immutable credit debits, idempotency replay, and draft revision fencing. The existing `/v2/break-generations` scheduling endpoint now calls this owner directly as well, leaving publication and solver behavior as the only retained scheduling seams. Contract, route, and restricted-PostgreSQL integration coverage prove the native owner and its public-ID, replay, credit, no-op, revision, and tenant-isolation boundaries.

API-02-TIME native slice: `/v2/time-cards` now owns history, active-card recovery, one-card reads, clock-in, clock-out, and corrections directly through tenant-RLS transactions. `TimeCard.publicId` and `TimeCardBreak.publicId` are the only browser-visible IDs; list cursors are opaque `clockInAt, publicId` positions. Clock-in preserves the prior durable operation/request identity exactly so a retry across the v1 cutover reuses its original row and immutable credit debit. New clock-ins require active paid entitlement and credits; reads and corrections require paid entitlement without debit; active reads and closing an existing card remain available after entitlement loss. Public contract, route, migration, browser-cutover, and restricted-PostgreSQL coverage prove no private storage IDs, tenant isolation, correction fencing, payroll cutoffs, exact replay, and recovery behavior.

API-02-PAYROLL native slice: `/v2/payroll` now owns all 17 browser payroll operations directly through tenant-RLS PostgreSQL transactions. `PayrollPolicyVersion`, `PayrollPeriod`, `PayrollLockedEntry`, `PayrollAmendment`, `PayrollExportBatch`, `PayrollExportLine`, and `PayrollReconciliationReceipt` use opaque public UUIDs at the browser boundary; internal IDs remain inside policy, snapshot, credit, CSV-integrity, and reconciliation transactions. The owner preserves policy/DST validation, period and card revision fencing, immutable lock hashes, amendment ordering and approval, exact-once time-card credit settlement, verified CSV download, and provider receipt/replay evidence without a retained HTTP bridge. Contract, route, browser-cutover, and restricted-PostgreSQL coverage prove public-only serialization, tenant isolation, durable replay, immutable export evidence, and reconciliation state.

API-02-NOTIFY native slice: `/v2/notifications` now owns the authenticated user feed and both read-state commands directly through tenant-RLS transactions. `Notification.publicId` is the only browser-visible notification identifier; the feed uses an opaque `createdAt, publicId` cursor and a bounded limit. Same-origin CSRF plus `notifications:write` protects reads-state mutations, and every update scopes both tenant and session user so callers cannot mark another worker's notifications. The retained scheduling outbox may continue to create durable feed rows during its separate publication seam, but no browser notification operation crosses the retained application bridge. Contract, route, unit, browser-cutover, and restricted-PostgreSQL coverage prove public-only serialization, pagination, tenant isolation, unread counts, and read-state containment.

API-02-SETTINGS native slice: `/v2/settings` now owns the general, team, and security workspace aggregate directly through tenant-RLS transactions. Every unsafe update requires same-origin CSRF and `settings:write`; request schemas are closed and require an explicit bounded change. Security policy writes create one append-only audit only when effective policy changes, recording MFA/session/SSO state and whether an issuer exists without retaining the issuer URL. SSO-only configuration fails closed unless API and web OIDC dependencies are present. Contract, route, unit, browser-cutover, and restricted-PostgreSQL coverage prove tenant isolation, no caller-selected tenant, OIDC safety, and audit redaction.

## Current known operational residuals

- Beta email delivery: password-email OTP and native staff invitation delivery remain unusable until VM107 receives a valid Resend API key and a provider-verified sender. The API container now resolves and reaches `api.resend.com`; the current runtime key is rejected by the provider with `400 validation_error: API key is invalid`. API-02-AUTH retains OTP transport work; native People invitations durably queue but must not be relied on for delivery until this external credential is updated. The beta password sign-in path remains verified.
- API-02-AUTH credential/lifecycle migration: the browser-safe session boundary is complete, but the 16 retained authentication operations (login, cookie lifecycle, MFA mutation, reset, OTP, PIN, and OIDC) still execute through the bounded private compatibility owner until native domain services replace them.

## API-03 — Retire public API v1 exposure

Status: public `/api/v1/*` is retired now: Caddy returns terminal `410 Gone` and production Next.js has no v1 rewrite. The legacy NestJS service remains private while API-02 migrates its 58 retained operations. Named provider adapters and the retention operator route are intentionally separate ingress boundaries and still need external configuration/readback proof before their individual rows close.

| Issue | Remaining public-v1 caller or edge | Required closure evidence |
| --- | --- | --- |
| API-03-OIDC | `/api/v2/auth/callback` is the replacement callback; beta currently has no enabled OIDC settings | Provider configuration readback and a complete signed login round trip on the replacement path before enabling OIDC |
| API-03-STRIPE | Stable raw ingress `/api/webhooks/stripe` privately adapts to the retained handler | Endpoint readback, signature/replay tests, and a provider-observed delivery |
| API-03-METER | Stable raw ingress `/api/webhooks/stripe/meter-errors` privately adapts to the retained handler | Signed replay tests and producer configuration readback |
| API-03-EMAIL | Stable raw ingress `/api/webhooks/resend/delivery-events` privately adapts to the retained handler | Signature/replay tests and provider configuration readback after the Resend key/sender update |
| API-03-RETENTION | `/api/v2/admin/retention/purge-expired` is the v2-only service-token ingress | Systemd environment readback, dry-run proof, and one bounded execution proof |
| API-03-OPERATORS | Public runbooks target v2; private retained domain work remains behind bounded adapters | Updated commands, authorization proof, and operator rehearsal against the replacement path |
| API-03-CLIENTS | Unknown external callers now receive terminal `410` | Dated deprecation notice plus live route/edge telemetry showing no required legacy traffic |
| API-03-EDGE | Complete for public browser/application ingress: terminal v1 response and no production Next.js rewrite | Live `410` proof plus v2 health/behavior checks |

Each remaining caller needs configuration readback, replay/signature tests where applicable, a dated deprecation window, and live traffic evidence. The edge is already closed; no new public v1 exception may be added.

Health and private metrics are service probes, not tenant application API operations, and remain separately routed.
