-- Prepare existing solve-job rows before Prisma requires request identity columns.

DO $$
BEGIN
  IF to_regclass('"ScheduleSolveJob"') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE "ScheduleSolveJob"
    ADD COLUMN IF NOT EXISTS "requestKeyHash" TEXT,
    ADD COLUMN IF NOT EXISTS "requestHash" TEXT;

  UPDATE "ScheduleSolveJob"
  SET
    "requestKeyHash" = COALESCE("requestKeyHash", md5('legacy-request-key:' || "id")),
    "requestHash" = COALESCE("requestHash", md5('legacy-request:' || "id"))
  WHERE "requestKeyHash" IS NULL OR "requestHash" IS NULL;

  IF EXISTS (
    SELECT 1
    FROM "ScheduleSolveJob"
    WHERE "requestKeyHash" IS NULL OR "requestHash" IS NULL
  ) THEN
    RAISE EXCEPTION 'ScheduleSolveJob request identity backfill failed; every existing job requires request hashes.';
  END IF;

  ALTER TABLE "ScheduleSolveJob"
    ALTER COLUMN "requestKeyHash" SET NOT NULL,
    ALTER COLUMN "requestHash" SET NOT NULL;
END $$;
