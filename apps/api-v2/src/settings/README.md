# API v2 Workspace Settings

## Files

- `README.md`: module guide and file inventory.
- `routes.ts`: explicit Fastify/OpenAPI routes for all workspace settings operations.
- `settings.service.ts`: tenant-RLS settings aggregate, OIDC safety gate, and security audit persistence.
- `settings.service.test.ts`: tenant-bound normalization, mutation, audit-redaction, and OIDC-denial regression tests.

The module owns `GET /settings` plus the general, team, and security `PUT` operations. It has no retained-application bridge or caller-selected tenant context.
