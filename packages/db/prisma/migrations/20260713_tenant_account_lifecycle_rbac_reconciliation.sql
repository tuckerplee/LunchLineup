-- Reconcile the tenant lifecycle permission omitted from the forward RBAC seed.
INSERT INTO "Permission" ("id", "key", "label", "description", "category", "createdAt", "updatedAt")
VALUES (
  gen_random_uuid()::text,
  'tenant_account:lifecycle',
  'Manage tenant lifecycle',
  'Cancel or request deletion for a tenant account.',
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
SELECT
  r."id",
  p."id",
  CURRENT_TIMESTAMP
FROM "Role" r
JOIN "Permission" p ON p."key" = 'tenant_account:lifecycle'
WHERE r."isSystem" = true
  AND r."legacyRole" IN ('SUPER_ADMIN', 'ADMIN')
  AND r."deletedAt" IS NULL
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
