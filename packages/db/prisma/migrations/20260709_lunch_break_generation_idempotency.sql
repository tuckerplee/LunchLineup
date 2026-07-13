-- Persist one billing and mutation outcome for each lunch/break generation attempt.

CREATE TABLE IF NOT EXISTS "LunchBreakGenerationRequest" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "requestKeyHash" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "creditConsumption" JSONB,
  "response" JSONB,
  "failureStatus" INTEGER,
  "failureMessage" TEXT,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LunchBreakGenerationRequest_status_check"
    CHECK ("status" IN ('PENDING', 'RESERVED', 'SUCCEEDED', 'FAILED')),
  CONSTRAINT "LunchBreakGenerationRequest_failureStatus_check"
    CHECK ("failureStatus" IS NULL OR "failureStatus" BETWEEN 400 AND 599),
  CONSTRAINT "LunchBreakGenerationRequest_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "LunchBreakGenerationRequest_tenantId_requestKeyHash_key"
  ON "LunchBreakGenerationRequest"("tenantId", "requestKeyHash");

CREATE INDEX IF NOT EXISTS "LunchBreakGenerationRequest_tenant_status_created_idx"
  ON "LunchBreakGenerationRequest"("tenantId", "status", "createdAt" DESC);

ALTER TABLE "LunchBreakGenerationRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LunchBreakGenerationRequest" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lunch_break_generation_request_isolation_policy ON "LunchBreakGenerationRequest";
CREATE POLICY lunch_break_generation_request_isolation_policy ON "LunchBreakGenerationRequest"
  USING (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()))
  WITH CHECK (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()));
