# API v2

`@lunchlineup/api-v2` is the clean-slate HTTP boundary. It is a contract-first Fastify modular monolith and does not import v1 controllers or business services. API-01 makes it the only browser-facing application API.

The native session slice in `platform/native-identity.ts` validates the signed access-token locator directly against tenant-scoped session, role-assignment, MFA-marker, tenant-policy, and revocation state. It owns `GET /auth/me` and all native scheduling authorization without calling `/v1/auth/me`; `platform/identity.ts` is the narrow interface shared by HTTP modules.

People mutations independently revalidate the current workspace, actor, exact
session, PIN state, role grants and effective session timeout. Administrative
writes obtain a bounded MFA observation from the server's existing identity
owner outside database transactions, then resolve the target and take one final
ordered authority lock set. Guards check session and observation deadlines
before nested writes and at transaction callback completion, including replay
and unchanged-state returns. Serializable conflicts remain controlled conflicts;
the service does not retry them automatically.

Self PIN replacement retains two transactions with bounded asynchronous PIN
verification and hashing between them. Only a currently required temporary-PIN
replacement can bypass MFA; ordinary replacement follows current MFA policy.
Failed guesses commit their shared attempt budget before returning unauthorized.
These process-local checks do not guarantee authority through database commit or
HTTP delivery, or atomicity between database and Redis revocation. Controlled
local tests and synthetic native fixture preparation are not live PostgreSQL,
Redis, browser or release qualification.

Publication billing/notifications and solver queue execution retain mature v1 subsystems behind `scheduling/legacy-scheduling.bridge.ts`. That adapter is a private anti-corruption boundary, not a generic proxy: it accepts only known operations, resolves tenant-scoped public UUIDs, bounds time and response size, sanitizes errors, and translates every result back to the v2 contract. Native scheduling reads, ordinary schedule mutations, and lunch/break generation go directly through API v2's tenant-scoped database services.

The exact 128-operation API catalog includes native session, Location, People, Operations, Time Card, Payroll, Notification, and workspace Settings operations alongside explicitly declared compatibility owners. The People module exposes public UUID staff/role resources, enforces live access revalidation for mutations, and produces encrypted staff-invitation commands while the worker remains the sole sender. The Operations module exposes public schedule/shift/roster read models and direct lunch/break persistence with tenant-RLS, credit settlement, idempotency, and revision fencing. The Time module exposes public time-card and break resources, preserves exact durable clock-in replay and credit settlement across the v1 cutover, and keeps clock-out recovery available after entitlement loss. The Payroll module owns policy versioning, period review/locking, immutable snapshots, amendments, exact-once export settlement, CSV evidence, and provider reconciliation through tenant-RLS transactions and public UUIDs only. The Settings module owns tenant-scoped workspace settings, strict request contracts, OIDC-only safety gating, and redacted security-policy audits. The retained operations preserve mature v1 behavior through `platform/retained-application.bridge.ts`, with fixed upstream authority, bounded request/response sizes, no redirects except the two declared OIDC operations, sanitized RFC 9457 errors, and no wildcard route. Its identifier translators rewrite only declared exact fields and retain no generic-ID fallback. API-02 owns deleting those compatibility operations as typed native domain modules land; the catalog may not grow.

## Files

- `README.md`: this application guide.
- `package.json`: service dependencies and build/test commands.
- `src/`: service entry point, HTTP assembly, platform adapters, and scheduling module.
- `tsconfig.json`: strict TypeScript build settings.

## Public trust boundary

- `/api/v2/*`: tenant application API, routed to this service by Caddy.
- `/api/v2/openapi.json`: generated OpenAPI 3.1 contract.
- `/api/v2/live`, `/api/v2/ready`, `/api/v2/version`: bounded service probes.

Every unsafe cookie-authenticated application request requires a same-origin `Origin` and a matching CSRF header/cookie. Pre-session authentication and reset flows retain their existing auth-owner policy because an application CSRF cookie does not yet exist. Scheduling writes require `Idempotency-Key`; aggregate mutations additionally require `If-Match`.
