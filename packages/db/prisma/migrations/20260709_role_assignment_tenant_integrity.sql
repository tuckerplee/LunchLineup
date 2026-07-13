DO $$
BEGIN
  ALTER TABLE "RoleAssignment" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

  IF EXISTS (
    SELECT 1
    FROM "RoleAssignment" ra
    JOIN "User" u ON u."id" = ra."userId"
    JOIN "Role" r ON r."id" = ra."roleId"
    WHERE u."tenantId" <> r."tenantId"
  ) THEN
    RAISE EXCEPTION 'RoleAssignment contains cross-tenant user-role pairs; fix data before applying tenant integrity migration.';
  END IF;

  UPDATE "RoleAssignment" ra
  SET "tenantId" = u."tenantId"
  FROM "User" u
  WHERE u."id" = ra."userId"
    AND ra."tenantId" IS NULL;

  IF EXISTS (
    SELECT 1
    FROM "RoleAssignment"
    WHERE "tenantId" IS NULL
  ) THEN
    RAISE EXCEPTION 'RoleAssignment tenantId backfill failed; every assignment must map to a tenant user.';
  END IF;

  ALTER TABLE "RoleAssignment" ALTER COLUMN "tenantId" SET NOT NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "User_id_tenantId_key" ON "User"("id", "tenantId");
CREATE UNIQUE INDEX IF NOT EXISTS "Role_id_tenantId_key" ON "Role"("id", "tenantId");
CREATE INDEX IF NOT EXISTS "RoleAssignment_tenantId_idx" ON "RoleAssignment"("tenantId");
CREATE INDEX IF NOT EXISTS "RoleAssignment_tenantId_userId_idx" ON "RoleAssignment"("tenantId", "userId");
CREATE INDEX IF NOT EXISTS "RoleAssignment_tenantId_roleId_idx" ON "RoleAssignment"("tenantId", "roleId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'RoleAssignment_tenantId_fkey'
      AND conrelid = '"RoleAssignment"'::regclass
  ) THEN
    ALTER TABLE "RoleAssignment"
      ADD CONSTRAINT "RoleAssignment_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
      ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'RoleAssignment_userId_tenantId_fkey'
      AND conrelid = '"RoleAssignment"'::regclass
  ) THEN
    ALTER TABLE "RoleAssignment"
      ADD CONSTRAINT "RoleAssignment_userId_tenantId_fkey"
      FOREIGN KEY ("userId", "tenantId") REFERENCES "User"("id", "tenantId")
      ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'RoleAssignment_roleId_tenantId_fkey'
      AND conrelid = '"RoleAssignment"'::regclass
  ) THEN
    ALTER TABLE "RoleAssignment"
      ADD CONSTRAINT "RoleAssignment_roleId_tenantId_fkey"
      FOREIGN KEY ("roleId", "tenantId") REFERENCES "Role"("id", "tenantId")
      ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
  END IF;
END $$;

ALTER TABLE "RoleAssignment" VALIDATE CONSTRAINT "RoleAssignment_tenantId_fkey";
ALTER TABLE "RoleAssignment" VALIDATE CONSTRAINT "RoleAssignment_userId_tenantId_fkey";
ALTER TABLE "RoleAssignment" VALIDATE CONSTRAINT "RoleAssignment_roleId_tenantId_fkey";
