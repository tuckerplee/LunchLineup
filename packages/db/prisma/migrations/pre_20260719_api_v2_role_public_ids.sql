-- Roles are browser-visible access resources. Add a stable opaque UUID while
-- retaining the private text primary key for deployed v1 writers and joins.
-- The ordered pre_20260718_api_v2_public_ids.sql migration establishes the
-- pgcrypto extension used by this same public-ID rollout family.

DO $migration$
BEGIN
  -- Fresh databases have no Prisma-owned tables until the later schema push.
  IF to_regclass('public."Role"') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE "Role"
    ADD COLUMN IF NOT EXISTS "publicId" UUID;

  UPDATE "Role"
  SET "publicId" = gen_random_uuid()
  WHERE "publicId" IS NULL;

  ALTER TABLE "Role"
    ALTER COLUMN "publicId" SET DEFAULT gen_random_uuid(),
    ALTER COLUMN "publicId" SET NOT NULL;

  CREATE UNIQUE INDEX IF NOT EXISTS "Role_publicId_key"
    ON "Role" ("publicId");
END
$migration$;
