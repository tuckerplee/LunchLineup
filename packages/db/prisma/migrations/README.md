# Prisma Migrations

## Files

- `README.md`: this migrations folder guide.
- `20260310_username_pin_auth.sql`: adds username and PIN fields for non-email login.
- `20260321_plan_definitions.sql`: adds plan definitions and seeds legacy tenant plan tiers.
- `20260325_rbac_roles_permissions.sql`: creates RBAC permissions, roles, role permissions, and role assignments.
- `20260603_admin_pin_login.sql`: backfills username/PIN and migrated password login permissions onto existing tenant roles for imported accounts.
- `audit_log.sql`: creates audit-log database support.
- `init_rls.sql`: initializes row-level-security database support.

## Notes

These SQL files are part of the rebuild migration contract. Apply new forward migrations to already-created dev databases instead of relying only on edits to older seed migrations.
