# API v2 Workspace Settings

## Files

- `README.md`: module guide and file inventory.
- `routes.ts`: explicit Fastify/OpenAPI routes for all workspace settings operations.
- `settings.service.ts`: tenant-RLS settings aggregate, OIDC safety gate, and security audit persistence.
- `settings.service.test.ts`: tenant-bound normalization, mutation, audit-redaction, and OIDC-denial regression tests.

The module owns `GET /settings` plus the general, team, and security `PUT` operations. It has no retained-application bridge or caller-selected tenant context.

Every writer locks its Tenant row before reading the shared settings aggregate, including first creation. This replaces the settings-only advisory lock so Nest writers and initial Nest session issuance participate in the same policy serialization. Deploy participating writers together and retire older writers before acceptance; older binaries do not provide this guarantee. The cross-owner transaction-double regressions live in `apps/api/src/settings/workspace-settings-concurrency.spec.ts`; real PostgreSQL blocking, RLS, rollback and cleanup remain native acceptance requirements. Boundary authentication is distinct from reauthorizing an actor after waiting for the mutation lock.
