DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PermissionCategory')
    AND NOT EXISTS (
      SELECT 1
      FROM pg_enum value
      JOIN pg_type enum_type ON enum_type.oid = value.enumtypid
      WHERE enum_type.typname = 'PermissionCategory'
        AND value.enumlabel = 'PAYROLL'
    ) THEN
    ALTER TYPE "PermissionCategory" ADD VALUE 'PAYROLL';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public."Tenant"') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "retentionLegalHoldAt" TIMESTAMP(3);
  ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "retentionLegalHoldReason" TEXT;
  ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "retentionLegalHoldByUserId" TEXT;
END $$;

DO $$
BEGIN
  IF to_regclass('public."TimeCard"') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE "TimeCard" ADD COLUMN IF NOT EXISTS "payrollPeriodId" TEXT;
  ALTER TABLE "TimeCard" ADD COLUMN IF NOT EXISTS "workTimeZone" TEXT;
  ALTER TABLE "TimeCard" ADD COLUMN IF NOT EXISTS "revision" INTEGER NOT NULL DEFAULT 1;

  UPDATE "TimeCard" card
  SET "workTimeZone" = COALESCE(location."timezone", 'UTC')
  FROM "Location" location
  WHERE card."locationId" = location."id"
    AND card."tenantId" = location."tenantId"
    AND card."workTimeZone" IS NULL;

  UPDATE "TimeCard"
  SET "workTimeZone" = 'UTC'
  WHERE "workTimeZone" IS NULL;

  ALTER TABLE "TimeCard" ALTER COLUMN "workTimeZone" SET NOT NULL;
END $$;

DO $$
BEGIN
  IF to_regclass('public."PayrollExportBatch"') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE "PayrollExportBatch"
    ADD COLUMN IF NOT EXISTS "creditTransactionId" TEXT;

  UPDATE "PayrollExportBatch"
  SET "creditTransactionId" = 'feature-usage-payroll-export:' || "operationId"
  WHERE "creditTransactionId" IS NULL;

  IF EXISTS (
    SELECT 1
    FROM "PayrollExportBatch" batch
    LEFT JOIN "CreditTransaction" ledger
      ON ledger."id" = batch."creditTransactionId"
      AND ledger."tenantId" = batch."tenantId"
    WHERE batch."creditTransactionId" <> 'feature-usage-payroll-export:' || batch."operationId"
      OR ledger."id" IS NULL
      OR ledger."amount" <> -batch."consumedCredits"
      OR ledger."reason" <> 'Payroll export (' || batch."periodId" || ')'
      OR ledger."balanceAfter" IS DISTINCT FROM batch."newBalance"
  ) THEN
    RAISE EXCEPTION 'Existing payroll export credit settlement provenance is missing or inconsistent'
      USING ERRCODE = '23514';
  END IF;

  ALTER TABLE "PayrollExportBatch"
    ALTER COLUMN "creditTransactionId" SET NOT NULL;
END $$;
