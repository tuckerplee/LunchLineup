-- Allow already-created tenant admin roles to use username/PIN login.

INSERT INTO "RolePermission" ("roleId", "permissionId", "createdAt")
SELECT
  r."id",
  p."id",
  CURRENT_TIMESTAMP
FROM "Role" r
JOIN "Permission" p
  ON p."key" = 'auth:login_pin'
WHERE r."slug" = 'admin'
  AND r."deletedAt" IS NULL
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
