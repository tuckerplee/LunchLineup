-- Allow already-created tenant roles to use username/PIN and migrated password login.

INSERT INTO "Permission" ("id", "key", "label", "description", "category", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'auth:login_password', 'Password login', 'Authenticate with migrated username and password.', 'AUTH', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
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
JOIN "Permission" p
  ON p."key" IN ('auth:login_pin', 'auth:login_password')
WHERE r."slug" IN ('admin', 'manager', 'staff')
  AND r."deletedAt" IS NULL
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
