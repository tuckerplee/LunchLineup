ALTER TABLE "Tenant"
ADD COLUMN IF NOT EXISTS "applicationDataPurgedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Tenant_status_deletedAt_applicationDataPurgedAt_idx"
ON "Tenant"("status", "deletedAt", "applicationDataPurgedAt");
