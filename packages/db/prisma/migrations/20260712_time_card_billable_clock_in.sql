-- Bind each billable clock-in to one durable logical operation.

ALTER TABLE "TimeCard"
  ADD COLUMN IF NOT EXISTS "clockInOperationId" TEXT,
  ADD COLUMN IF NOT EXISTS "clockInRequestHash" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "TimeCard_clockInOperationId_key"
  ON "TimeCard"("clockInOperationId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'TimeCard_clock_in_identity_pair'
      AND conrelid = '"TimeCard"'::regclass
  ) THEN
    ALTER TABLE "TimeCard"
      ADD CONSTRAINT "TimeCard_clock_in_identity_pair"
      CHECK (("clockInOperationId" IS NULL) = ("clockInRequestHash" IS NULL)) NOT VALID;
  END IF;
END $$;

ALTER TABLE "TimeCard" VALIDATE CONSTRAINT "TimeCard_clock_in_identity_pair";
