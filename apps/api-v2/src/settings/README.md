# API v2 Workspace Settings

## Files

- `README.md`: module guide and file inventory.
- `routes.ts`: explicit Fastify/OpenAPI routes for all workspace settings operations.
- `settings.service.ts`: tenant-RLS settings aggregate, OIDC safety gate, and security audit persistence.
- `settings.service.test.ts`: tenant-bound normalization, mutation, audit-redaction, and OIDC-denial regression tests.

The module owns `GET /settings` plus the general, team, and security `PUT` operations. It has no retained-application bridge or caller-selected tenant context.

Every writer uses the existing native `authorizeMutation` helper with `settings:write`. It locks Tenant first, retaining shared aggregate/policy serialization, then checks the current actor, exact request session and current role-derived permission before reading or saving settings. It rejects inactive or locked accounts, revoked/expired sessions, and removed roles/permissions despite stale request claims. Explicit custom-role grants remain valid.

Deploy participating writers together and retire older writers before acceptance; older binaries do not provide this guarantee. Local cross-owner serialization and authority regressions live in `apps/api/src/settings`. Real PostgreSQL blocking, RLS, rollback and cleanup remain native acceptance requirements. Guard authentication is still required: the reusable helper does not refresh tenant lifecycle, forced PIN reset, policy-shortened expiry or Redis MFA verification during the mutation wait.
