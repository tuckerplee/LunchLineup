# Admin Users

## Files

- `admin-user-lifecycle.ts`: shared client status resolver that gives irreversible deletion precedence over reversible suspension and blocks lifecycle mutation of deleted users.
- `AdminUsersWorkspace.tsx`: platform user search, tenant-bound account edits, authoritative role changes, PIN reset, lock/suspension actions, and target-confirmed MFA recovery that revokes all target sessions.
- `page.tsx`: server-authenticated platform user page entrypoint.
- `README.md`: this folder inventory and ownership guide.

## Security

Suspension is represented independently from deletion: suspended users can be activated, while deleted users are immutable tombstones and expose no lifecycle action.

MFA recovery is unavailable for the current platform administrator, suspended users, and users without MFA. It requires exact `reset-mfa:<user-id>` confirmation plus a support reason; the API remains the authorization and transaction boundary.

Tenant assignment is read-only. Cross-tenant reassignment is rejected by the API because role assignments and tenant-owned records are not migrated by account edits. Email and role identity changes are server-authoritative and revoke active sessions.
