-- Persist tenant export authorization, queue leases, progress, expiry, and opaque artifact identity.

CREATE TABLE IF NOT EXISTS "TenantExportJob" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "requestedByUserId" TEXT NOT NULL,
  "tenantSlug" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'QUEUED',
  "watermark" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "artifactKey" TEXT,
  "bytes" INTEGER NOT NULL DEFAULT 0,
  "rowCounts" JSONB,
  "progressCollection" TEXT,
  "progressRows" INTEGER NOT NULL DEFAULT 0,
  "claimToken" TEXT,
  "claimExpiresAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TenantExportJob_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TenantExportJob_state_check"
    CHECK ("state" IN ('QUEUED', 'RUNNING', 'READY', 'FAILED', 'EXPIRED')),
  CONSTRAINT "TenantExportJob_bytes_nonnegative" CHECK ("bytes" >= 0),
  CONSTRAINT "TenantExportJob_progressRows_nonnegative" CHECK ("progressRows" >= 0),
  CONSTRAINT "TenantExportJob_attempts_nonnegative" CHECK ("attempts" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "TenantExportJob_artifactKey_key"
  ON "TenantExportJob"("artifactKey");
CREATE INDEX IF NOT EXISTS "TenantExportJob_tenant_user_created_idx"
  ON "TenantExportJob"("tenantId", "requestedByUserId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "TenantExportJob_claim_idx"
  ON "TenantExportJob"("state", "claimExpiresAt", "createdAt");
CREATE INDEX IF NOT EXISTS "TenantExportJob_expiry_idx"
  ON "TenantExportJob"("expiresAt", "state");
CREATE UNIQUE INDEX IF NOT EXISTS "TenantExportJob_one_active_per_tenant_idx"
  ON "TenantExportJob"("tenantId") WHERE "state" IN ('QUEUED', 'RUNNING');

ALTER TABLE "TenantExportJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantExportJob" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_export_job_isolation_policy ON "TenantExportJob";
CREATE POLICY tenant_export_job_isolation_policy ON "TenantExportJob"
  USING (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()))
  WITH CHECK (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()));
