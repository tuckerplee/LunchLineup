CREATE TABLE IF NOT EXISTS "AvailabilityImportJob" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "requestedByUserId" TEXT,
  "requestKeyHash" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "status" "AvailabilityImportStatus" NOT NULL DEFAULT 'PENDING',
  "publicationStatus" "AvailabilityImportPublicationStatus" NOT NULL DEFAULT 'PENDING',
  "publishToken" TEXT,
  "publishLeaseUntil" TIMESTAMP(3),
  "publishAttempts" INTEGER NOT NULL DEFAULT 0,
  "nextPublishAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publicationAmbiguous" BOOLEAN NOT NULL DEFAULT FALSE,
  "publishLastError" TEXT,
  "publishedAt" TIMESTAMP(3),
  "storageKey" TEXT,
  "fileSha256" TEXT NOT NULL,
  "fileSize" INTEGER NOT NULL,
  "parsedAvailability" JSONB,
  "failureCode" TEXT,
  "creditConsumption" JSONB,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "executionToken" TEXT,
  "executionLeaseUntil" TIMESTAMP(3),
  "queuedAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AvailabilityImportJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AvailabilityImportJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AvailabilityImportJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AvailabilityImportJob_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

ALTER TABLE "AvailabilityImportJob" ADD COLUMN IF NOT EXISTS "publicationStatus" "AvailabilityImportPublicationStatus" NOT NULL DEFAULT 'PENDING';
ALTER TABLE "AvailabilityImportJob" ADD COLUMN IF NOT EXISTS "publishToken" TEXT;
ALTER TABLE "AvailabilityImportJob" ADD COLUMN IF NOT EXISTS "publishLeaseUntil" TIMESTAMP(3);
ALTER TABLE "AvailabilityImportJob" ADD COLUMN IF NOT EXISTS "publishAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AvailabilityImportJob" ADD COLUMN IF NOT EXISTS "nextPublishAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "AvailabilityImportJob" ADD COLUMN IF NOT EXISTS "publicationAmbiguous" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "AvailabilityImportJob" ADD COLUMN IF NOT EXISTS "publishLastError" TEXT;
ALTER TABLE "AvailabilityImportJob" ADD COLUMN IF NOT EXISTS "publishedAt" TIMESTAMP(3);

ALTER TABLE "AvailabilityImportJob" DROP CONSTRAINT IF EXISTS "AvailabilityImportJob_fileSize_check";
ALTER TABLE "AvailabilityImportJob" ADD CONSTRAINT "AvailabilityImportJob_fileSize_check"
  CHECK ("fileSize" > 0 AND "fileSize" <= 5242880);
ALTER TABLE "AvailabilityImportJob" DROP CONSTRAINT IF EXISTS "AvailabilityImportJob_attempts_check";
ALTER TABLE "AvailabilityImportJob" ADD CONSTRAINT "AvailabilityImportJob_attempts_check"
  CHECK ("attempts" >= 0 AND "attempts" <= 10 AND "publishAttempts" >= 0);
ALTER TABLE "AvailabilityImportJob" DROP CONSTRAINT IF EXISTS "AvailabilityImportJob_hashes_check";
ALTER TABLE "AvailabilityImportJob" ADD CONSTRAINT "AvailabilityImportJob_hashes_check"
  CHECK (
    "requestKeyHash" ~ '^[a-f0-9]{64}$'
    AND "requestHash" ~ '^[a-f0-9]{64}$'
    AND "fileSha256" ~ '^[a-f0-9]{64}$'
  );
ALTER TABLE "AvailabilityImportJob" DROP CONSTRAINT IF EXISTS "AvailabilityImportJob_storageKey_check";
ALTER TABLE "AvailabilityImportJob" ADD CONSTRAINT "AvailabilityImportJob_storageKey_check"
  CHECK ("storageKey" IS NULL OR "storageKey" ~ '^[a-f0-9-]{36}\.pdf$');
ALTER TABLE "AvailabilityImportJob" DROP CONSTRAINT IF EXISTS "AvailabilityImportJob_result_check";
ALTER TABLE "AvailabilityImportJob" ADD CONSTRAINT "AvailabilityImportJob_result_check"
  CHECK (("status" = 'SUCCEEDED') = ("parsedAvailability" IS NOT NULL));
ALTER TABLE "AvailabilityImportJob" DROP CONSTRAINT IF EXISTS "AvailabilityImportJob_terminal_time_check";
ALTER TABLE "AvailabilityImportJob" ADD CONSTRAINT "AvailabilityImportJob_terminal_time_check"
  CHECK ("status" NOT IN ('SUCCEEDED', 'FAILED', 'DEAD_LETTERED') OR "completedAt" IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS "AvailabilityImportJob_tenantId_requestKeyHash_key"
  ON "AvailabilityImportJob"("tenantId", "requestKeyHash");
CREATE INDEX IF NOT EXISTS "AvailabilityImportJob_tenantId_userId_createdAt_idx"
  ON "AvailabilityImportJob"("tenantId", "userId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "AvailabilityImportJob_tenantId_status_createdAt_idx"
  ON "AvailabilityImportJob"("tenantId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "AvailabilityImportJob_publicationStatus_nextPublishAt_createdAt_idx"
  ON "AvailabilityImportJob"("publicationStatus", "nextPublishAt", "createdAt");
CREATE INDEX IF NOT EXISTS "AvailabilityImportJob_publishLeaseUntil_idx"
  ON "AvailabilityImportJob"("publishLeaseUntil");
CREATE INDEX IF NOT EXISTS "AvailabilityImportJob_status_executionLeaseUntil_idx"
  ON "AvailabilityImportJob"("status", "executionLeaseUntil");
CREATE INDEX IF NOT EXISTS "AvailabilityImportJob_expiresAt_idx"
  ON "AvailabilityImportJob"("expiresAt");

ALTER TABLE "AvailabilityImportJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AvailabilityImportJob" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS availability_import_job_isolation_policy ON "AvailabilityImportJob";
CREATE POLICY availability_import_job_isolation_policy ON "AvailabilityImportJob"
  USING (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()))
  WITH CHECK (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()));
