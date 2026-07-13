-- Preserve generated/manual lunch-break identity across persisted reads.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BreakType') THEN
    CREATE TYPE "BreakType" AS ENUM ('BREAK1', 'LUNCH', 'BREAK2');
  END IF;
END $$;

ALTER TABLE "Break"
  ADD COLUMN IF NOT EXISTS "type" "BreakType";

CREATE INDEX IF NOT EXISTS "Break_type_idx" ON "Break"("type");
