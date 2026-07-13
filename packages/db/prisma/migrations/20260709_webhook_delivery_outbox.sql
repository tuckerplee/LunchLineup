-- Persist replayable webhook retry state in Postgres while keeping RabbitMQ
-- messages limited to an opaque delivery id.

DO $$
BEGIN
    CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'QUEUED', 'SENDING', 'DELIVERED', 'FAILED', 'DEAD_LETTERED');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

ALTER TYPE "WebhookDeliveryStatus" ADD VALUE IF NOT EXISTS 'PENDING';
ALTER TYPE "WebhookDeliveryStatus" ADD VALUE IF NOT EXISTS 'QUEUED';
ALTER TYPE "WebhookDeliveryStatus" ADD VALUE IF NOT EXISTS 'SENDING';
ALTER TYPE "WebhookDeliveryStatus" ADD VALUE IF NOT EXISTS 'DELIVERED';
ALTER TYPE "WebhookDeliveryStatus" ADD VALUE IF NOT EXISTS 'FAILED';
ALTER TYPE "WebhookDeliveryStatus" ADD VALUE IF NOT EXISTS 'DEAD_LETTERED';

CREATE TABLE IF NOT EXISTS "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "endpointId" TEXT,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "eventType" TEXT,
    "endpointRef" TEXT NOT NULL,
    "payloadDigest" TEXT NOT NULL,
    "payloadBytes" INTEGER NOT NULL,
    "encryptedUrl" TEXT NOT NULL,
    "encryptedPayload" TEXT NOT NULL,
    "encryptionKeyRef" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "queuedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WebhookDelivery_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "WebhookDelivery_tenantId_idx"
    ON "WebhookDelivery"("tenantId");

CREATE INDEX IF NOT EXISTS "WebhookDelivery_endpointId_idx"
    ON "WebhookDelivery"("endpointId");

CREATE INDEX IF NOT EXISTS "WebhookDelivery_status_nextAttemptAt_idx"
    ON "WebhookDelivery"("status", "nextAttemptAt");

CREATE INDEX IF NOT EXISTS "WebhookDelivery_tenantId_status_nextAttemptAt_idx"
    ON "WebhookDelivery"("tenantId", "status", "nextAttemptAt");

CREATE INDEX IF NOT EXISTS "WebhookDelivery_payloadDigest_idx"
    ON "WebhookDelivery"("payloadDigest");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'WebhookDelivery_payloadBytes_nonnegative'
    ) THEN
        ALTER TABLE "WebhookDelivery"
            ADD CONSTRAINT "WebhookDelivery_payloadBytes_nonnegative" CHECK ("payloadBytes" >= 0);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'WebhookDelivery_attempts_nonnegative'
    ) THEN
        ALTER TABLE "WebhookDelivery"
            ADD CONSTRAINT "WebhookDelivery_attempts_nonnegative" CHECK ("attempts" >= 0);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'WebhookDelivery_required_text_nonempty'
    ) THEN
        ALTER TABLE "WebhookDelivery"
            ADD CONSTRAINT "WebhookDelivery_required_text_nonempty" CHECK (
                length(trim("endpointRef")) > 0
                AND length(trim("payloadDigest")) > 0
                AND length(trim("encryptedUrl")) > 0
                AND length(trim("encryptedPayload")) > 0
                AND length(trim("encryptionKeyRef")) > 0
            );
    END IF;
END $$;

ALTER TABLE "WebhookDelivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WebhookDelivery" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS webhook_delivery_isolation_policy ON "WebhookDelivery";
CREATE POLICY webhook_delivery_isolation_policy ON "WebhookDelivery"
    USING (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()))
    WITH CHECK (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()));
