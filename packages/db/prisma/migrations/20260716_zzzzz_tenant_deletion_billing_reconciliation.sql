-- Durable, tenant-scoped ownership for destructive deletion-billing reconciliation.
DO $$
BEGIN
  CREATE TYPE "TenantDeletionBillingReconciliationState" AS ENUM ('PENDING', 'FINALIZED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS public."TenantDeletionBillingReconciliation" (
  "tenantId" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "barrierCreatedAt" TIMESTAMP(3) NOT NULL,
  "state" "TenantDeletionBillingReconciliationState" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastAttemptAt" TIMESTAMP(3),
  "lastFailureAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "leaseOwner" TEXT,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "finalizedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TenantDeletionBillingReconciliation_pkey" PRIMARY KEY ("tenantId")
);

ALTER TABLE public."TenantDeletionBillingReconciliation"
  ADD COLUMN IF NOT EXISTS "operationId" TEXT,
  ADD COLUMN IF NOT EXISTS "barrierCreatedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "state" "TenantDeletionBillingReconciliationState" DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "attemptCount" INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "lastAttemptAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastFailureAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastErrorCode" TEXT,
  ADD COLUMN IF NOT EXISTS "leaseOwner" TEXT,
  ADD COLUMN IF NOT EXISTS "leaseToken" TEXT,
  ADD COLUMN IF NOT EXISTS "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "finalizedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;

INSERT INTO public."TenantDeletionBillingReconciliation" (
  "tenantId",
  "operationId",
  "barrierCreatedAt",
  "state",
  "attemptCount",
  "nextAttemptAt",
  "finalizedAt",
  "createdAt",
  "updatedAt"
)
SELECT
  tenant."id",
  'tenant-deletion-' || barrier."id",
  barrier."createdAt",
  CASE
    WHEN tenant."status" = 'PURGED'::"TenantStatus" AND tenant."deletedAt" IS NOT NULL
      THEN 'FINALIZED'::"TenantDeletionBillingReconciliationState"
    ELSE 'PENDING'::"TenantDeletionBillingReconciliationState"
  END,
  0,
  CURRENT_TIMESTAMP,
  CASE
    WHEN tenant."status" = 'PURGED'::"TenantStatus" AND tenant."deletedAt" IS NOT NULL
      THEN tenant."deletedAt"
    ELSE NULL
  END,
  barrier."createdAt",
  CURRENT_TIMESTAMP
FROM public."Tenant" tenant
CROSS JOIN LATERAL (
  SELECT audit."id", audit."createdAt"
  FROM public."AuditLog" audit
  WHERE audit."tenantId" = tenant."id"
    AND audit."action" = 'TENANT_DELETION_BARRIER_COMMITTED'
    AND audit."resource" = 'Tenant'
    AND audit."resourceId" = tenant."id"
  ORDER BY audit."createdAt", audit."id"
  LIMIT 1
) barrier
WHERE (
    tenant."status" = 'SUSPENDED'::"TenantStatus"
    AND tenant."deletedAt" IS NULL
  ) OR (
    tenant."status" = 'PURGED'::"TenantStatus"
    AND tenant."deletedAt" IS NOT NULL
  )
ON CONFLICT ("tenantId") DO NOTHING;

ALTER TABLE public."TenantDeletionBillingReconciliation"
  ALTER COLUMN "operationId" SET NOT NULL,
  ALTER COLUMN "barrierCreatedAt" SET NOT NULL,
  ALTER COLUMN "state" SET NOT NULL,
  ALTER COLUMN "attemptCount" SET NOT NULL,
  ALTER COLUMN "nextAttemptAt" SET NOT NULL,
  ALTER COLUMN "createdAt" SET NOT NULL,
  ALTER COLUMN "updatedAt" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "TenantDeletionBillingReconciliation_operationId_key"
  ON public."TenantDeletionBillingReconciliation" ("operationId");
CREATE INDEX IF NOT EXISTS "TenantDeletionBillingReconciliation_state_nextAttemptAt_barrierCreatedAt_tenantId_idx"
  ON public."TenantDeletionBillingReconciliation"
  ("state", "nextAttemptAt", "barrierCreatedAt", "tenantId");
CREATE INDEX IF NOT EXISTS "TenantDeletionBillingReconciliation_leaseExpiresAt_idx"
  ON public."TenantDeletionBillingReconciliation" ("leaseExpiresAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'TenantDeletionBillingReconciliation_tenantId_fkey'
      AND conrelid = 'public."TenantDeletionBillingReconciliation"'::regclass
  ) THEN
    ALTER TABLE public."TenantDeletionBillingReconciliation"
      ADD CONSTRAINT "TenantDeletionBillingReconciliation_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES public."Tenant"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

ALTER TABLE public."TenantDeletionBillingReconciliation"
  DROP CONSTRAINT IF EXISTS "TenantDeletionBillingReconciliation_attemptCount_check",
  ADD CONSTRAINT "TenantDeletionBillingReconciliation_attemptCount_check"
    CHECK ("attemptCount" >= 0),
  DROP CONSTRAINT IF EXISTS "TenantDeletionBillingReconciliation_lease_check",
  ADD CONSTRAINT "TenantDeletionBillingReconciliation_lease_check"
    CHECK (
      ("leaseOwner" IS NULL AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL)
      OR
      ("leaseOwner" IS NOT NULL AND "leaseToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL)
    ),
  DROP CONSTRAINT IF EXISTS "TenantDeletionBillingReconciliation_state_check",
  ADD CONSTRAINT "TenantDeletionBillingReconciliation_state_check"
    CHECK (
      ("state" = 'PENDING' AND "finalizedAt" IS NULL)
      OR
      ("state" = 'FINALIZED' AND "finalizedAt" IS NOT NULL
        AND "leaseOwner" IS NULL AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL)
    );

ALTER TABLE public."TenantDeletionBillingReconciliation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."TenantDeletionBillingReconciliation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_deletion_billing_reconciliation_isolation_policy
  ON public."TenantDeletionBillingReconciliation";
CREATE POLICY tenant_deletion_billing_reconciliation_isolation_policy
  ON public."TenantDeletionBillingReconciliation"
  USING (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()))
  WITH CHECK (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()));

COMMENT ON TABLE public."TenantDeletionBillingReconciliation" IS
  'Durable lease, fencing, retry, and ordering state for destructive tenant billing cleanup.';
