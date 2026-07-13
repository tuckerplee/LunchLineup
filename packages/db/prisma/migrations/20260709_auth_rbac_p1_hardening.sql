-- Add explicit tenant export authority and keep email-only staff accounts usable.

INSERT INTO "Permission" ("id", "key", "label", "description", "category", "createdAt", "updatedAt")
VALUES (
  gen_random_uuid()::text,
  'account:data_export',
  'Export tenant data',
  'Export the complete tenant account data set.',
  'ADMIN',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO UPDATE
SET
  "label" = EXCLUDED."label",
  "description" = EXCLUDED."description",
  "category" = EXCLUDED."category",
  "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "RolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", CURRENT_TIMESTAMP
FROM "Role" r
JOIN "Permission" p ON p."key" = 'account:data_export'
WHERE r."isSystem" = true
  AND r."legacyRole" IN ('SUPER_ADMIN', 'ADMIN')
  AND r."deletedAt" IS NULL
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", CURRENT_TIMESTAMP
FROM "Role" r
JOIN "Permission" p ON p."key" = 'auth:login_email'
WHERE r."isSystem" = true
  AND r."legacyRole" = 'STAFF'
  AND r."deletedAt" IS NULL
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
