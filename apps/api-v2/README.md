# API v2

`@lunchlineup/api-v2` is the clean-slate HTTP boundary. It is a contract-first Fastify modular monolith and does not import v1 controllers or business services.

The first vertical slice owns scheduling board reads, schedule creation, demand replacement, reopening, and atomic schedule change sets. During migration, `platform/identity.ts` asks the existing authentication boundary to validate the current cookie or bearer session. This preserves session revocation, MFA, PIN rotation, and effective RBAC without copying the legacy auth service.

Publication billing/notifications, solver queue execution, and charged break generation retain mature v1 subsystems behind `scheduling/legacy-scheduling.bridge.ts`. That adapter is a private anti-corruption boundary, not a generic proxy: it accepts only known operations, resolves tenant-scoped public UUIDs, bounds time and response size, sanitizes errors, and translates every result back to the v2 contract. Native scheduling reads and ordinary schedule mutations go directly through API v2's tenant-scoped database services.

## Files

- `README.md`: this application guide.
- `package.json`: service dependencies and build/test commands.
- `src/`: service entry point, HTTP assembly, platform adapters, and scheduling module.
- `tsconfig.json`: strict TypeScript build settings.

## Public trust boundary

- `/api/v2/*`: tenant application API, routed to this service by Caddy.
- `/api/v2/openapi.json`: generated OpenAPI 3.1 contract.
- `/api/v2/live`, `/api/v2/ready`, `/api/v2/version`: bounded service probes.

Every unsafe cookie-authenticated request requires a same-origin `Origin` and a matching CSRF header/cookie. Scheduling writes require `Idempotency-Key`; aggregate mutations additionally require `If-Match`.
