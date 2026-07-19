# API v2

`@lunchlineup/api-v2` is the clean-slate HTTP boundary. It is a contract-first Fastify modular monolith and does not import v1 controllers or business services. API-01 makes it the only browser-facing application API.

The native session slice in `platform/native-identity.ts` validates the signed access-token locator directly against tenant-scoped session, role-assignment, MFA-marker, tenant-policy, and revocation state. It owns `GET /auth/me` and all native scheduling authorization without calling `/v1/auth/me`; `platform/identity.ts` is the narrow interface shared by HTTP modules.

Publication billing/notifications, solver queue execution, and charged break generation retain mature v1 subsystems behind `scheduling/legacy-scheduling.bridge.ts`. That adapter is a private anti-corruption boundary, not a generic proxy: it accepts only known operations, resolves tenant-scoped public UUIDs, bounds time and response size, sanitizes errors, and translates every result back to the v2 contract. Native scheduling reads and ordinary schedule mutations go directly through API v2's tenant-scoped database services.

The exact 121-operation API-01 catalog includes one native session operation and 120 retained operations. The retained operations preserve mature v1 behavior through `platform/retained-application.bridge.ts`, with fixed upstream authority, bounded request/response sizes, no redirects except the two declared OIDC operations, sanitized RFC 9457 errors, and no wildcard route. API-02 owns deleting those compatibility operations as typed native domain modules land; the catalog may not grow.

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
