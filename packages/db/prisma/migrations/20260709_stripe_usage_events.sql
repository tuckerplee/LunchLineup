DO $$
BEGIN
    CREATE TYPE "StripeUsageMetric" AS ENUM ('ACTIVE_STAFF');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

ALTER TYPE "StripeUsageMetric" ADD VALUE IF NOT EXISTS 'ACTIVE_STAFF';

DO $$
BEGIN
    CREATE TYPE "StripeUsageEventStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'DEAD_LETTERED');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

ALTER TYPE "StripeUsageEventStatus" ADD VALUE IF NOT EXISTS 'PENDING';
ALTER TYPE "StripeUsageEventStatus" ADD VALUE IF NOT EXISTS 'SENDING';
ALTER TYPE "StripeUsageEventStatus" ADD VALUE IF NOT EXISTS 'SENT';
ALTER TYPE "StripeUsageEventStatus" ADD VALUE IF NOT EXISTS 'FAILED';
ALTER TYPE "StripeUsageEventStatus" ADD VALUE IF NOT EXISTS 'DEAD_LETTERED';

CREATE TABLE IF NOT EXISTS "StripeUsageEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "metric" "StripeUsageMetric" NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "eventName" TEXT NOT NULL,
    "stripeCustomerId" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "StripeUsageEventStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "stripeObjectId" TEXT,
    "stripeRequestId" TEXT,
    "lastError" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StripeUsageEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StripeUsageEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "StripeUsageEvent_identifier_key" ON "StripeUsageEvent"("identifier");
CREATE UNIQUE INDEX IF NOT EXISTS "StripeUsageEvent_idempotencyKey_key" ON "StripeUsageEvent"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "StripeUsageEvent_tenantId_idx" ON "StripeUsageEvent"("tenantId");
CREATE INDEX IF NOT EXISTS "StripeUsageEvent_status_nextAttemptAt_idx" ON "StripeUsageEvent"("status", "nextAttemptAt");
CREATE INDEX IF NOT EXISTS "StripeUsageEvent_tenantId_metric_periodStart_periodEnd_idx" ON "StripeUsageEvent"("tenantId", "metric", "periodStart", "periodEnd");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'StripeUsageEvent_quantity_nonnegative'
    ) THEN
        ALTER TABLE "StripeUsageEvent"
            ADD CONSTRAINT "StripeUsageEvent_quantity_nonnegative" CHECK ("quantity" >= 0);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'StripeUsageEvent_attempts_nonnegative'
    ) THEN
        ALTER TABLE "StripeUsageEvent"
            ADD CONSTRAINT "StripeUsageEvent_attempts_nonnegative" CHECK ("attempts" >= 0);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'StripeUsageEvent_period_valid'
    ) THEN
        ALTER TABLE "StripeUsageEvent"
            ADD CONSTRAINT "StripeUsageEvent_period_valid" CHECK ("periodEnd" > "periodStart");
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'StripeUsageEvent_required_text_nonempty'
    ) THEN
        ALTER TABLE "StripeUsageEvent"
            ADD CONSTRAINT "StripeUsageEvent_required_text_nonempty" CHECK (
                length(trim("eventName")) > 0
                AND length(trim("stripeCustomerId")) > 0
                AND length(trim("identifier")) > 0
                AND length(trim("idempotencyKey")) > 0
            );
    END IF;
END $$;

ALTER TABLE "StripeUsageEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StripeUsageEvent" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stripe_usage_event_isolation_policy ON "StripeUsageEvent";
CREATE POLICY stripe_usage_event_isolation_policy ON "StripeUsageEvent"
    USING (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()))
    WITH CHECK (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()));
