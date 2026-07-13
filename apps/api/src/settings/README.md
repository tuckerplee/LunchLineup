# Settings API

Tenant-scoped workspace settings endpoints. Security policy changes are persisted and append an audit record in the same tenant transaction when the effective policy changes. Audit metadata contains only MFA enforcement, session timeout, SSO-only enforcement, and whether an OIDC issuer is configured; issuer URLs, credentials, secrets, and tokens are excluded.

## Files

- `README.md` - Folder inventory and settings behavior notes.
- `settings.controller.spec.ts` - Focused controller, tenant transaction, validation, RBAC, and security audit tests.
- `settings.controller.ts` - Tenant-scoped general, team, and security settings endpoints.
