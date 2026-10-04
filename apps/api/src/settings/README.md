# Settings API

Tenant-scoped workspace settings endpoints. Security policy changes are persisted and append an audit record in the same tenant transaction when the effective policy changes. Audit metadata contains only MFA enforcement, session timeout, SSO-only enforcement, and whether an OIDC issuer is configured; issuer URLs, credentials, secrets, and tokens are excluded.

## Files

- `README.md` - Folder inventory and settings behavior notes.
- `settings.controller.spec.ts` - Focused controller, tenant transaction, validation, RBAC, and security audit tests.
- `settings.controller.ts` - Tenant-scoped general, team, and security settings endpoints.
- `workspace-settings-concurrency.spec.ts` - Deterministic overlapping-save regressions across Nest and API-v2, including first creation and an independent tenant. Uses transaction doubles; it does not qualify PostgreSQL locking.
- `settings-mutation-authority.spec.ts` - Both owners' current actor, exact session and role-permission decisions after a controlled Tenant wait, with refused-write and custom-role positive controls.

All three settings writers lock their Tenant row before reading and replacing the shared `workspace_settings` JSON. API-v2 settings and initial Nest session issuance use the same row lock. A general or team save therefore reads a preceding committed security save instead of restoring stale security fields. Lock failure aborts before settings reads or writes; security audit persistence remains in the mutation transaction.

The same transaction reauthorizes the actor, exact request session and current role-derived `settings:write` grant through the shared RBAC mutation helper before reading settings. Account deletion, suspension or lockout, session revocation/expiry, and removed role assignments/permissions refuse the save without aggregate or audit writes. Legacy role labels and request permission claims cannot substitute for current grants.

This guarantee requires all live writers to use this protocol. Retire older writers before admitting a mixed-runtime candidate; an older binary without the Tenant lock can still overwrite settings. The protocol assumes the existing READ COMMITTED transaction behavior. Native acceptance must demonstrate actual database blocking and settlement on the admitted candidate. Guard checks remain necessary: these helpers do not refresh tenant lifecycle eligibility, forced PIN reset, policy-shortened expiry or Redis MFA verification during the wait. Those stronger mutation-boundary requirements remain separate open coverage.
