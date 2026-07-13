# API Users

## Files

- `README.md`: this users folder guide.
- `staff-scheduling-profile.spec.ts`: skill normalization, input caps, overnight availability, duplicate-window, and invalid-input coverage.
- `staff-scheduling-profile.ts`: bounded scheduling-profile input normalization shared by the staff API replacement route.
- `users.controller.spec.ts`: user invite, role delegation, access assignment, PIN hierarchy/takeover, scheduling-profile atomicity, permission, and tenant-boundary regression tests.
- `users.controller.ts`: tenant user directory, invite, role/access assignment, scheduling-profile read/replace, hierarchy-checked PIN administration, and deactivation routes.

## Security Notes

Role delegation is subset-based: a caller may invite or assign only roles whose effective permissions are all present in the caller's current server-resolved permission set. Legacy role updates also validate the existing target before mutation: self changes and changes to equal/higher-rank users or users with permissions the caller does not hold are rejected. Custom role creation and updates enforce the same rule from live database assignments inside the mutation transaction, including when the caller edits an assigned role. Protected platform permissions and the `SUPER_ADMIN` legacy role additionally require an actual system-admin identity.

Invite user creation, RBAC role assignment, and invite audit logging share one tenant transaction. A role validation or assignment failure rolls back the user creation instead of leaving an account without access assignments.

The admin PIN reset route re-reads both users and their active RBAC assignments. A non-super-admin actor must have a strictly higher legacy-role rank and a strict superset of the target's permissions. Self reset, same-rank reset, missing target permissions, and a stale `SUPER_ADMIN` user row without an active system-super-admin assignment fail closed. Only a live user with both the `SUPER_ADMIN` legacy role and active system `SUPER_ADMIN` assignment receives the exceptional override.

Email-only invitations require `auth:login_email`; `auth:login_password` alone is not accepted because invitations do not bootstrap a password. The default Staff role includes email OTP so invited staff can authenticate when OIDC is disabled.

Scheduling-profile reads require `users:read`; atomic replacements require `users:write`. Replacement locks and revalidates the active tenant staff row and every optional active tenant location before deleting or creating skills and availability. Empty availability is returned explicitly and is passed to the solver as unavailable, not omitted as unrestricted.
