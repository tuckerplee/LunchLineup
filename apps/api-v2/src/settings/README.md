# API v2 Workspace Settings

## Files

- `README.md`: module guide and file inventory.
- `routes.ts`: explicit Fastify/OpenAPI routes for all workspace settings operations.
- `settings.service.ts`: tenant-RLS settings aggregate, OIDC safety gate, and security audit persistence.
- `settings.service.test.ts`: tenant-bound normalization, mutation, audit-redaction, and OIDC-denial regression tests.

The module owns `GET /settings` plus the general, team, and security `PUT` operations. It has no retained-application bridge or caller-selected tenant context.

Every writer uses the existing native `authorizeMutation` helper with `settings:write`. It locks Tenant first, retaining shared aggregate/policy serialization, then checks the current actor, exact request session and current role-derived permission before reading or saving settings. It rejects inactive or locked accounts, revoked/expired sessions, and removed roles/permissions despite stale request claims. Explicit custom-role grants remain valid.

Deploy participating writers together and retire older writers before acceptance; older binaries do not provide this guarantee. Local cross-owner serialization and authority regressions live in `apps/api/src/settings`. Real PostgreSQL blocking, RLS, rollback and cleanup remain native acceptance requirements. The settings owner additionally rechecks current workspace eligibility, scoped forced PIN reset and current-policy effective expiry. Writes validate database authority in a first read-only tenant transaction, observe the exact session MFA deadline outside database locks through the same lifecycle-owned identity adapter/store, then repeat authorization in a second transaction. Merge and audit use the second-pass aggregate and canonical actor. Missing observer capability or dependency failure returns 503; missing or expired proof returns 403.

Verification always applies to `settings:write` even when JWT or workspace flags say otherwise. A read-only Redis script reads the verified value and PTTL atomically. Wall and process-monotonic deadlines start before readiness/read and are rechecked after the final database waits. Decision timeouts bound authorization without claiming I/O cancellation. Marker deletion after observation is a later boundary; no cross-store atomicity is claimed. Guards and native Redis/PostgreSQL acceptance are still required. The PostgreSQL integration fixture uses an explicitly controlled observer and cannot establish real MFA correctness.
