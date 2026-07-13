-- Make auto-schedule POST retries reuse one durable job and one billing attempt.

ALTER TABLE "ScheduleSolveJob"
  ADD COLUMN IF NOT EXISTS "requestKeyHash" TEXT,
  ADD COLUMN IF NOT EXISTS "requestHash" TEXT;

-- Existing pre-idempotency jobs receive unique legacy values and remain queryable by job id.
UPDATE "ScheduleSolveJob"
SET
  "requestKeyHash" = COALESCE("requestKeyHash", md5('legacy-request-key:' || "id")),
  "requestHash" = COALESCE("requestHash", md5('legacy-request:' || "id"))
WHERE "requestKeyHash" IS NULL OR "requestHash" IS NULL;

ALTER TABLE "ScheduleSolveJob"
  ALTER COLUMN "requestKeyHash" SET NOT NULL,
  ALTER COLUMN "requestHash" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "ScheduleSolveJob_tenantId_scheduleId_requestKeyHash_key"
  ON "ScheduleSolveJob"("tenantId", "scheduleId", "requestKeyHash");
