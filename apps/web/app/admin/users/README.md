# Admin Users

## Files

- `AdminUsersWorkspace.tsx`: platform user search, account edits, PIN reset, lock/suspension actions, and target-confirmed MFA recovery that revokes all target sessions.
- `page.tsx`: server-authenticated platform user page entrypoint.
- `README.md`: this folder inventory and ownership guide.

## Security

MFA recovery is unavailable for the current platform administrator, suspended users, and users without MFA. It requires exact `reset-mfa:<user-id>` confirmation plus a support reason; the API remains the authorization and transaction boundary.
