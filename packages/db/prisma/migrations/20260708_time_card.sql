-- Add persisted employee clock-in/clock-out records.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TimeCardStatus') THEN
    CREATE TYPE "TimeCardStatus" AS ENUM ('OPEN', 'CLOSED', 'VOID');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "TimeCard" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "locationId" TEXT,
  "shiftId" TEXT,
  "clockInAt" TIMESTAMP(3) NOT NULL,
  "clockOutAt" TIMESTAMP(3),
  "breakMinutes" INTEGER NOT NULL DEFAULT 0,
  "notes" TEXT,
  "status" "TimeCardStatus" NOT NULL DEFAULT 'OPEN',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "TimeCard_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'TimeCard_tenantId_fkey'
      AND conrelid = '"TimeCard"'::regclass
  ) THEN
    ALTER TABLE "TimeCard"
      ADD CONSTRAINT "TimeCard_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'TimeCard_userId_fkey'
      AND conrelid = '"TimeCard"'::regclass
  ) THEN
    ALTER TABLE "TimeCard"
      ADD CONSTRAINT "TimeCard_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'TimeCard_locationId_fkey'
      AND conrelid = '"TimeCard"'::regclass
  ) THEN
    ALTER TABLE "TimeCard"
      ADD CONSTRAINT "TimeCard_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'TimeCard_shiftId_fkey'
      AND conrelid = '"TimeCard"'::regclass
  ) THEN
    ALTER TABLE "TimeCard"
      ADD CONSTRAINT "TimeCard_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "TimeCard_tenantId_idx" ON "TimeCard"("tenantId");
CREATE INDEX IF NOT EXISTS "TimeCard_userId_idx" ON "TimeCard"("userId");
CREATE INDEX IF NOT EXISTS "TimeCard_locationId_idx" ON "TimeCard"("locationId");
CREATE INDEX IF NOT EXISTS "TimeCard_shiftId_idx" ON "TimeCard"("shiftId");
CREATE INDEX IF NOT EXISTS "TimeCard_clockInAt_idx" ON "TimeCard"("clockInAt");
CREATE INDEX IF NOT EXISTS "TimeCard_status_idx" ON "TimeCard"("status");
CREATE INDEX IF NOT EXISTS "TimeCard_deletedAt_idx" ON "TimeCard"("deletedAt");
