-- Current-schema replacement for the superseded historical RBAC seed.
INSERT INTO "Permission" ("id", "key", "label", "description", "category", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'dashboard:access', 'Access dashboard', 'Sign in to the tenant dashboard.', 'AUTH', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'admin_portal:access', 'Access admin portal', 'Access the system administration portal.', 'ADMIN', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'auth:login_email', 'Email login', 'Authenticate with work email and one-time passcode.', 'AUTH', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'auth:login_pin', 'PIN login', 'Authenticate with username and PIN.', 'AUTH', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'auth:login_password', 'Password login', 'Authenticate with migrated username and password.', 'AUTH', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'users:read', 'View staff', 'Read staff directory and user details.', 'USERS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'users:write', 'Create staff', 'Invite staff and update basic account details.', 'USERS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'users:admin', 'Administer staff', 'Reset login credentials and deactivate users.', 'USERS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'roles:read', 'View access roles', 'Read role and permission definitions.', 'USERS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'roles:write', 'Manage access roles', 'Create, edit, and delete tenant-defined roles.', 'USERS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'roles:assign', 'Assign access roles', 'Assign or revoke roles for staff members.', 'USERS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'locations:read', 'View locations', 'Read location records.', 'LOCATIONS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'locations:write', 'Manage locations', 'Create and update locations.', 'LOCATIONS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'locations:delete', 'Delete locations', 'Delete locations.', 'LOCATIONS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'shifts:read', 'View shifts', 'Read shifts.', 'SHIFTS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'shifts:write', 'Manage shifts', 'Create and update shifts.', 'SHIFTS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'shifts:delete', 'Delete shifts', 'Delete shifts.', 'SHIFTS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'schedules:read', 'View schedules', 'Read schedules.', 'SCHEDULES', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'schedules:write', 'Manage schedules', 'Create and update schedules.', 'SCHEDULES', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'schedules:publish', 'Publish schedules', 'Publish schedules.', 'SCHEDULES', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'lunch_breaks:read', 'View breaks', 'Read lunch and break plans.', 'LUNCH_BREAKS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'lunch_breaks:write', 'Manage breaks', 'Create and update lunch and break plans.', 'LUNCH_BREAKS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'lunch_breaks:delete', 'Delete breaks', 'Delete lunch and break plans.', 'LUNCH_BREAKS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'notifications:read', 'View notifications', 'Read notifications.', 'NOTIFICATIONS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'notifications:write', 'Manage notifications', 'Create and mark notifications.', 'NOTIFICATIONS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'billing:read', 'View billing', 'Read billing and credits data.', 'BILLING', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'billing:write', 'Manage billing', 'Modify billing and credits data.', 'BILLING', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'settings:read', 'View settings', 'Read tenant settings.', 'SETTINGS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'settings:write', 'Manage settings', 'Update tenant settings.', 'SETTINGS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO UPDATE
SET
  "label" = EXCLUDED."label",
  "description" = EXCLUDED."description",
  "category" = EXCLUDED."category",
  "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "Role" ("id", "tenantId", "name", "slug", "description", "isSystem", "isDefault", "legacyRole", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  t."id",
  r."name",
  r."slug",
  r."description",
  true,
  r."isDefault",
  r."legacyRole"::"UserRole",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Tenant" t
CROSS JOIN (
  VALUES
    ('System Admin', 'super-admin', 'Full platform access.', false, 'SUPER_ADMIN'),
    ('Admin', 'admin', 'Tenant administrator with staff and operations access.', true, 'ADMIN'),
    ('Manager', 'manager', 'Store manager with scheduling and people access.', false, 'MANAGER'),
    ('Staff', 'staff', 'Frontline staff member.', false, 'STAFF')
) AS r("name", "slug", "description", "isDefault", "legacyRole")
ON CONFLICT ("tenantId", "name") DO UPDATE
SET
  "slug" = EXCLUDED."slug",
  "description" = EXCLUDED."description",
  "isSystem" = true,
  "isDefault" = EXCLUDED."isDefault",
  "legacyRole" = EXCLUDED."legacyRole",
  "deletedAt" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "RolePermission" ("roleId", "permissionId", "createdAt")
SELECT
  r."id",
  p."id",
  CURRENT_TIMESTAMP
FROM "Role" r
JOIN "Permission" p ON
  (r."slug" = 'super-admin')
  OR (r."slug" = 'admin' AND p."key" IN (
    'dashboard:access','auth:login_email','auth:login_pin','auth:login_password','users:read','users:write','users:admin','roles:read','roles:write','roles:assign',
    'locations:read','locations:write','locations:delete','shifts:read','shifts:write','shifts:delete','schedules:read',
    'schedules:write','schedules:publish','lunch_breaks:read','lunch_breaks:write','lunch_breaks:delete','notifications:read',
    'notifications:write','billing:read','billing:write','settings:read','settings:write'
  ))
  OR (r."slug" = 'manager' AND p."key" IN (
    'dashboard:access','auth:login_email','auth:login_pin','auth:login_password','users:read','users:write','roles:read','locations:read',
    'shifts:read','shifts:write','schedules:read','schedules:write','schedules:publish','lunch_breaks:read','lunch_breaks:write',
    'notifications:read','notifications:write'
  ))
  OR (r."slug" = 'staff' AND p."key" IN (
    'dashboard:access','auth:login_pin','auth:login_password','locations:read','shifts:read','schedules:read','lunch_breaks:read',
    'notifications:read','notifications:write'
  ))
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- Reconcile databases that previously replayed the superseded Staff write grant.
DELETE FROM "RolePermission" rp
USING "Role" r, "Permission" p
WHERE rp."roleId" = r."id"
  AND rp."permissionId" = p."id"
  AND r."slug" = 'staff'
  AND r."isSystem" = true
  AND p."key" = 'lunch_breaks:write';

INSERT INTO "RoleAssignment" ("tenantId", "userId", "roleId", "createdAt")
SELECT
  u."tenantId",
  u."id",
  r."id",
  CURRENT_TIMESTAMP
FROM "User" u
JOIN "Role" r
  ON r."tenantId" = u."tenantId"
 AND r."legacyRole" = u."role"
 AND r."deletedAt" IS NULL
WHERE u."deletedAt" IS NULL
  AND u."role" <> 'SUPER_ADMIN'::"UserRole"
  AND NOT EXISTS (
    SELECT 1
    FROM "RoleAssignment" existing_ra
    WHERE existing_ra."userId" = u."id"
  );
