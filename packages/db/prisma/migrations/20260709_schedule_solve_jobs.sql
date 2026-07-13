-- Add tenant-visible lifecycle state for auto-schedule jobs.

CREATE TABLE IF NOT EXISTS "ScheduleSolveJob" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "scheduleId" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "statusReason" TEXT,
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "resultShiftCount" INTEGER,
  "requestedConstraints" JSONB,
  "creditConsumption" JSONB,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScheduleSolveJob_status_check"
    CHECK ("status" IN ('QUEUED', 'RUNNING', 'RETRYING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTERED')),
  CONSTRAINT "ScheduleSolveJob_retryCount_nonnegative"
    CHECK ("retryCount" >= 0),
  CONSTRAINT "ScheduleSolveJob_resultShiftCount_nonnegative"
    CHECK ("resultShiftCount" IS NULL OR "resultShiftCount" >= 0),
  CONSTRAINT "ScheduleSolveJob_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ScheduleSolveJob_scheduleId_tenantId_fkey"
    FOREIGN KEY ("scheduleId", "tenantId") REFERENCES "Schedule"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ScheduleSolveJob_locationId_tenantId_fkey"
    FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ScheduleSolveJob_tenantId_idx"
  ON "ScheduleSolveJob"("tenantId");

CREATE INDEX IF NOT EXISTS "ScheduleSolveJob_scheduleId_idx"
  ON "ScheduleSolveJob"("scheduleId");

CREATE INDEX IF NOT EXISTS "ScheduleSolveJob_locationId_idx"
  ON "ScheduleSolveJob"("locationId");

CREATE INDEX IF NOT EXISTS "ScheduleSolveJob_tenant_schedule_created_idx"
  ON "ScheduleSolveJob"("tenantId", "scheduleId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "ScheduleSolveJob_tenant_status_created_idx"
  ON "ScheduleSolveJob"("tenantId", "status", "createdAt" DESC);

ALTER TABLE "ScheduleSolveJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScheduleSolveJob" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS schedule_solve_job_isolation_policy ON "ScheduleSolveJob";
CREATE POLICY schedule_solve_job_isolation_policy ON "ScheduleSolveJob"
  USING (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()))
  WITH CHECK (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()));
