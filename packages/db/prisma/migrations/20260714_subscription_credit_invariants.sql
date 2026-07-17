-- Enforce separately purchased/granted wallets and prohibit plan-owned credits.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Tenant"
    WHERE "usageCredits" < 0
  ) THEN
    RAISE EXCEPTION 'Cannot enforce non-negative usage credit wallets while a tenant has a negative balance';
  END IF;
END
$$;

UPDATE "PlanDefinition"
SET
  "creditQuotaLimit" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "creditQuotaLimit" IS NOT NULL;

ALTER TABLE "Tenant"
  DROP CONSTRAINT IF EXISTS "Tenant_usageCredits_nonnegative_check";

ALTER TABLE "Tenant"
  ADD CONSTRAINT "Tenant_usageCredits_nonnegative_check"
  CHECK ("usageCredits" >= 0);

ALTER TABLE "PlanDefinition"
  DROP CONSTRAINT IF EXISTS "PlanDefinition_no_included_credits_check";

ALTER TABLE "PlanDefinition"
  ADD CONSTRAINT "PlanDefinition_no_included_credits_check"
  CHECK ("creditQuotaLimit" IS NULL);
