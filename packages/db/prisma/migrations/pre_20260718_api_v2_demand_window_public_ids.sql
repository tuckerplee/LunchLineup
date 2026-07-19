-- Give demand windows stable opaque API identifiers without rewriting legacy
-- internal primary keys. The database default keeps retained writers compatible.

DO $migration$
BEGIN
  -- Fresh databases have no Prisma-owned tables until the later schema push.
  IF to_regclass('public."ScheduleDemandWindow"') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE "ScheduleDemandWindow"
    ADD COLUMN IF NOT EXISTS "publicId" UUID;

  UPDATE "ScheduleDemandWindow"
  SET "publicId" = gen_random_uuid()
  WHERE "publicId" IS NULL;

  ALTER TABLE "ScheduleDemandWindow"
    ALTER COLUMN "publicId" SET DEFAULT gen_random_uuid(),
    ALTER COLUMN "publicId" SET NOT NULL;

  CREATE UNIQUE INDEX IF NOT EXISTS "ScheduleDemandWindow_publicId_key"
    ON "ScheduleDemandWindow"("publicId");
END
$migration$;
