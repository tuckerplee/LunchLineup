ALTER TABLE "StripeUsageEvent"
    ADD COLUMN IF NOT EXISTS "submittedAt" TIMESTAMP(3);

UPDATE "StripeUsageEvent"
SET "submittedAt" = COALESCE("sentAt", "updatedAt")
WHERE "submittedAt" IS NULL
  AND "status" IN ('SENT', 'SENDING');

CREATE INDEX IF NOT EXISTS "StripeUsageEvent_eventName_status_submittedAt_idx"
    ON "StripeUsageEvent"("eventName", "status", "submittedAt");
