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

The shared catalog currently contains 121 explicit retained application operations:

| Domain | Operations |
| --- | ---: |
| Authentication | 17 |
| Locations | 6 |
| People and access | 17 |
| Operational reads and lunch/break planning | 9 |
| Time cards | 6 |
| Payroll | 17 |
| Notifications | 3 |
| Settings | 4 |
| Billing | 9 |
| Availability imports | 2 |
| Administration and account lifecycle | 31 |

These sit beside 11 native scheduling operations. The catalog is defined once in `packages/api-contract/src/application.ts`, used by both the browser transport and Fastify route registration, and covered by a migration test that rejects undeclared paths and the removed row-at-a-time shift mutation surface.

## API-02 — Replace retained implementations with native v2 modules

Status: open. This is the next API blocker after API-01.

The API-01 routes are real, explicit public v2 routes, but their mature implementations remain behind bounded server-side compatibility owners. API-02 removes those dependencies domain by domain:

| Issue | Remaining native owner | Compatibility operations |
| --- | --- | ---: |
| API-02-AUTH | Authentication, session validation, cookie lifecycle, MFA, reset, OTP, PIN, and OIDC | 17 plus the private identity adapter |
| API-02-LOC | Tenant locations and public identifier translation | 6 |
| API-02-PEOPLE | Staff, roles, permissions, invitations, and public identifier translation | 17 |
| API-02-OPS | Operational schedule/roster reads and aggregate lunch/break planning | 9 |
| API-02-TIME | Clock events, active-card reads, corrections, and time-card history | 6 |
| API-02-PAYROLL | Policy, period, review, lock, amendment, export, download, and reconciliation | 17 |
| API-02-NOTIFY | Notification feed and read-state commands | 3 |
| API-02-SETTINGS | General, team, security, and workspace settings | 4 |
| API-02-BILLING | Entitlements, recovery, checkout, portal, plan change, and resume | 9 |
| API-02-IMPORTS | Availability import creation and status | 2 |
| API-02-ADMIN | Platform tenant/user/plan/credit/audit plus account export and lifecycle | 31 |
| API-02-SCHED-SEAMS | Publication settlement, solver queue/status, and charged break generation | 5 retained scheduling operations |

Each replacement must add specific TypeBox request/response schemas, tenant-scoped native services, public identifiers, authorization tests, and direct database/integration proof before its compatibility operation is deleted. No new operation may be added to the retained catalog; new product work must be native v2.

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
