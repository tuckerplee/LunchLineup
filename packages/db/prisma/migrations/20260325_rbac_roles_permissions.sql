-- Add tenant-scoped RBAC roles, permissions, and user-role assignments.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PermissionCategory') THEN
    CREATE TYPE "PermissionCategory" AS ENUM (
      'AUTH',
      'ADMIN',
      'USERS',
      'LOCATIONS',
      'SHIFTS',
      'SCHEDULES',
      'LUNCH_BREAKS',
      'NOTIFICATIONS',
      'BILLING',
      'SETTINGS'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "Permission" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "key" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "description" TEXT,
  "category" "PermissionCategory" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Permission_key_key" ON "Permission"("key");
CREATE INDEX IF NOT EXISTS "Permission_category_idx" ON "Permission"("category");

CREATE TABLE IF NOT EXISTS "Role" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "description" TEXT,
  "isSystem" BOOLEAN NOT NULL DEFAULT false,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "legacyRole" "UserRole",
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "Role_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Role_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "Role_tenantId_slug_key" ON "Role"("tenantId", "slug");
CREATE UNIQUE INDEX IF NOT EXISTS "Role_tenantId_name_key" ON "Role"("tenantId", "name");
CREATE INDEX IF NOT EXISTS "Role_tenantId_idx" ON "Role"("tenantId");
CREATE INDEX IF NOT EXISTS "Role_legacyRole_idx" ON "Role"("legacyRole");
CREATE INDEX IF NOT EXISTS "Role_deletedAt_idx" ON "Role"("deletedAt");

CREATE TABLE IF NOT EXISTS "RolePermission" (
  "roleId" TEXT NOT NULL,
  "permissionId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("roleId", "permissionId"),
  CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "RolePermission_permissionId_idx" ON "RolePermission"("permissionId");

CREATE TABLE IF NOT EXISTS "RoleAssignment" (
  "userId" TEXT NOT NULL,
  "roleId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RoleAssignment_pkey" PRIMARY KEY ("userId", "roleId"),
  CONSTRAINT "RoleAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RoleAssignment_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "RoleAssignment_roleId_idx" ON "RoleAssignment"("roleId");

INSERT INTO "Permission" ("id", "key", "label", "description", "category", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'dashboard:access', 'Access dashboard', 'Sign in to the tenant dashboard.', 'AUTH', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'admin_portal:access', 'Access admin portal', 'Access the system administration portal.', 'ADMIN', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'auth:login_email', 'Email login', 'Authenticate with work email and one-time passcode.', 'AUTH', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'auth:login_pin', 'PIN login', 'Authenticate with username and PIN.', 'AUTH', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
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
    'dashboard:access','auth:login_email','users:read','users:write','users:admin','roles:read','roles:write','roles:assign',
    'locations:read','locations:write','locations:delete','shifts:read','shifts:write','shifts:delete','schedules:read',
    'schedules:write','schedules:publish','lunch_breaks:read','lunch_breaks:write','lunch_breaks:delete','notifications:read',
    'notifications:write','billing:read','billing:write','settings:read','settings:write'
  ))
  OR (r."slug" = 'manager' AND p."key" IN (
    'dashboard:access','auth:login_email','auth:login_pin','users:read','users:write','roles:read','locations:read',
    'shifts:read','shifts:write','schedules:read','schedules:write','schedules:publish','lunch_breaks:read','lunch_breaks:write',
    'notifications:read','notifications:write'
  ))
  OR (r."slug" = 'staff' AND p."key" IN (
    'dashboard:access','auth:login_pin','locations:read','shifts:read','schedules:read','lunch_breaks:read','lunch_breaks:write',
    'notifications:read','notifications:write'
  ))
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

INSERT INTO "RoleAssignment" ("userId", "roleId", "createdAt")
SELECT
  u."id",
  r."id",
  CURRENT_TIMESTAMP
FROM "User" u
JOIN "Role" r
  ON r."tenantId" = u."tenantId"
 AND r."legacyRole" = u."role"
 AND r."deletedAt" IS NULL
LEFT JOIN "RoleAssignment" ra
  ON ra."userId" = u."id"
 AND ra."roleId" = r."id"
WHERE u."deletedAt" IS NULL
  AND ra."userId" IS NULL;
