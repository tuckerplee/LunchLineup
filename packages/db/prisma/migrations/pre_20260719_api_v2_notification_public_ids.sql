-- Notification feed rows cross the API-02 public boundary. Keep the private
-- primary key for deployed v1 writers while adding a durable opaque UUID.
-- pre_20260718_api_v2_public_ids.sql owns pgcrypto setup for this family.

DO $migration$
BEGIN
  -- Fresh databases create Prisma-owned tables after pre-migrations run.
  IF to_regclass('public."Notification"') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE "Notification"
    ADD COLUMN IF NOT EXISTS "publicId" UUID;

  UPDATE "Notification"
  SET "publicId" = gen_random_uuid()
  WHERE "publicId" IS NULL;

  ALTER TABLE "Notification"
    ALTER COLUMN "publicId" SET DEFAULT gen_random_uuid(),
    ALTER COLUMN "publicId" SET NOT NULL;

  CREATE UNIQUE INDEX IF NOT EXISTS "Notification_publicId_key"
    ON "Notification" ("publicId");
END
$migration$;
