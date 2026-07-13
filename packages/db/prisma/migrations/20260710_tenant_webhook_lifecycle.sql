-- Terminalize webhook delivery only when tenant deletion reaches PURGED, and
-- repair the lunch-break generation request tenant FK on upgraded databases.

DO $$
BEGIN
    IF to_regclass('"LunchBreakGenerationRequest"') IS NULL THEN
        RETURN;
    END IF;

    ALTER TABLE "LunchBreakGenerationRequest"
        DROP CONSTRAINT IF EXISTS "LunchBreakGenerationRequest_tenantId_fkey";
    ALTER TABLE "LunchBreakGenerationRequest"
        ADD CONSTRAINT "LunchBreakGenerationRequest_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
END $$;

CREATE OR REPLACE FUNCTION terminalize_purged_tenant_webhooks()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."status" = 'PURGED'::"TenantStatus" THEN
        UPDATE "WebhookEndpoint"
        SET "active" = false,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "tenantId" = NEW."id"
          AND "active" = true;

        UPDATE "WebhookDelivery"
        SET "status" = 'DEAD_LETTERED'::"WebhookDeliveryStatus",
            "nextAttemptAt" = NULL,
            "lastError" = 'Tenant account was purged',
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "tenantId" = NEW."id"
          AND "status" IN (
              'PENDING'::"WebhookDeliveryStatus",
              'QUEUED'::"WebhookDeliveryStatus",
              'SENDING'::"WebhookDeliveryStatus",
              'FAILED'::"WebhookDeliveryStatus"
          );
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenant_webhook_lifecycle_guard ON "Tenant";
DROP FUNCTION IF EXISTS terminalize_inactive_tenant_webhooks();
CREATE TRIGGER tenant_webhook_lifecycle_guard
AFTER UPDATE OF "status", "deletedAt" ON "Tenant"
FOR EACH ROW
WHEN (NEW."status" = 'PURGED'::"TenantStatus")
EXECUTE FUNCTION terminalize_purged_tenant_webhooks();

UPDATE "WebhookEndpoint" AS endpoint
SET "active" = false,
    "updatedAt" = CURRENT_TIMESTAMP
FROM "Tenant" AS tenant
WHERE endpoint."tenantId" = tenant."id"
  AND endpoint."active" = true
  AND tenant."status" = 'PURGED'::"TenantStatus";

UPDATE "WebhookDelivery" AS delivery
SET "status" = 'DEAD_LETTERED'::"WebhookDeliveryStatus",
    "nextAttemptAt" = NULL,
    "lastError" = 'Tenant account was purged',
    "updatedAt" = CURRENT_TIMESTAMP
FROM "Tenant" AS tenant
WHERE delivery."tenantId" = tenant."id"
  AND delivery."status" IN (
      'PENDING'::"WebhookDeliveryStatus",
      'QUEUED'::"WebhookDeliveryStatus",
      'SENDING'::"WebhookDeliveryStatus",
      'FAILED'::"WebhookDeliveryStatus"
  )
  AND tenant."status" = 'PURGED'::"TenantStatus";
