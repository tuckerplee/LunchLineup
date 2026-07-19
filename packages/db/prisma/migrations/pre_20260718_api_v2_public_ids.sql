-- Add stable opaque API identifiers without breaking the currently deployed v1 writers.
-- Database defaults are intentional: old Prisma clients do not know these columns.

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "publicId" UUID;
UPDATE "User"
SET "publicId" = gen_random_uuid()
WHERE "publicId" IS NULL;
ALTER TABLE "User"
  ALTER COLUMN "publicId" SET DEFAULT gen_random_uuid(),
  ALTER COLUMN "publicId" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "User_publicId_key"
  ON "User"("publicId");

ALTER TABLE "Location"
  ADD COLUMN IF NOT EXISTS "publicId" UUID;
UPDATE "Location"
SET "publicId" = gen_random_uuid()
WHERE "publicId" IS NULL;
ALTER TABLE "Location"
  ALTER COLUMN "publicId" SET DEFAULT gen_random_uuid(),
  ALTER COLUMN "publicId" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "Location_publicId_key"
  ON "Location"("publicId");

ALTER TABLE "Schedule"
  ADD COLUMN IF NOT EXISTS "publicId" UUID;
UPDATE "Schedule"
SET "publicId" = gen_random_uuid()
WHERE "publicId" IS NULL;
ALTER TABLE "Schedule"
  ALTER COLUMN "publicId" SET DEFAULT gen_random_uuid(),
  ALTER COLUMN "publicId" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "Schedule_publicId_key"
  ON "Schedule"("publicId");

ALTER TABLE "Shift"
  ADD COLUMN IF NOT EXISTS "publicId" UUID;
UPDATE "Shift"
SET "publicId" = gen_random_uuid()
WHERE "publicId" IS NULL;
ALTER TABLE "Shift"
  ALTER COLUMN "publicId" SET DEFAULT gen_random_uuid(),
  ALTER COLUMN "publicId" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "Shift_publicId_key"
  ON "Shift"("publicId");

ALTER TABLE "ScheduleSolveJob"
  ADD COLUMN IF NOT EXISTS "publicId" UUID;
UPDATE "ScheduleSolveJob"
SET "publicId" = gen_random_uuid()
WHERE "publicId" IS NULL;
ALTER TABLE "ScheduleSolveJob"
  ALTER COLUMN "publicId" SET DEFAULT gen_random_uuid(),
  ALTER COLUMN "publicId" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "ScheduleSolveJob_publicId_key"
  ON "ScheduleSolveJob"("publicId");
