-- Complete the crash-recovery and soft-delete fields used by schedule and break workflows.

ALTER TABLE "Schedule"
  ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Schedule_tenantId_deletedAt_idx"
  ON "Schedule"("tenantId", "deletedAt");

ALTER TABLE "LunchBreakGenerationRequest"
  ADD COLUMN IF NOT EXISTS "claimToken" TEXT,
  ADD COLUMN IF NOT EXISTS "claimExpiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "creditTransactionId" TEXT,
  ADD COLUMN IF NOT EXISTS "calculationSnapshot" JSONB;

CREATE INDEX IF NOT EXISTS "LunchBreakGenerationRequest_status_claimExpiresAt_idx"
  ON "LunchBreakGenerationRequest"("status", "claimExpiresAt");
