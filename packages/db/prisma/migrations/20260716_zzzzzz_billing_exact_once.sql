-- Add authoritative paid-through entitlement and immutable wallet settlement results.

ALTER TABLE public."Tenant"
  ADD COLUMN IF NOT EXISTS "stripeSubscriptionCurrentPeriodEnd" TIMESTAMP(3);

ALTER TABLE public."CreditTransaction"
  ADD COLUMN IF NOT EXISTS "balanceAfter" INTEGER;

ALTER TABLE public."Tenant"
  DROP CONSTRAINT IF EXISTS "Tenant_stripeSubscriptionCurrentPeriodEnd_binding_check";

ALTER TABLE public."Tenant"
  ADD CONSTRAINT "Tenant_stripeSubscriptionCurrentPeriodEnd_binding_check"
  CHECK (
    "stripeSubscriptionCurrentPeriodEnd" IS NULL
    OR (
      "stripeSubscriptionId" IS NOT NULL
      AND BTRIM("stripeSubscriptionId") <> ''
    )
  );

ALTER TABLE public."CreditTransaction"
  DROP CONSTRAINT IF EXISTS "CreditTransaction_balanceAfter_nonnegative_check";

ALTER TABLE public."CreditTransaction"
  ADD CONSTRAINT "CreditTransaction_balanceAfter_nonnegative_check"
  CHECK ("balanceAfter" IS NULL OR "balanceAfter" >= 0);

-- Keep the additive column nullable while the retained old release can still write.
-- Current writers persist balanceAfter and reject nullable replay; database-level
-- required enforcement belongs in a later release after old-writer retirement.
ALTER TABLE public."CreditTransaction"
  DROP CONSTRAINT IF EXISTS "CreditTransaction_balanceAfter_required_check";

CREATE INDEX IF NOT EXISTS "Tenant_paid_subscription_entitlement_idx"
  ON public."Tenant" ("stripeSubscriptionCurrentPeriodEnd", "id")
  WHERE "status" = 'ACTIVE'::"TenantStatus"
    AND "stripeSubscriptionId" IS NOT NULL
    AND BTRIM("stripeSubscriptionId") <> ''
    AND "stripeSubscriptionCurrentPeriodEnd" IS NOT NULL;

CREATE OR REPLACE FUNCTION public.prevent_credit_transaction_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(NEW."id", NEW."tenantId", NEW."amount", NEW."reason", NEW."balanceAfter", NEW."createdAt")
    IS DISTINCT FROM ROW(OLD."id", OLD."tenantId", OLD."amount", OLD."reason", OLD."balanceAfter", OLD."createdAt") THEN
    RAISE EXCEPTION 'CreditTransaction settlement rows are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "CreditTransaction_balanceAfter_immutable" ON public."CreditTransaction";
DROP TRIGGER IF EXISTS "CreditTransaction_settlement_immutable" ON public."CreditTransaction";
CREATE TRIGGER "CreditTransaction_settlement_immutable"
BEFORE UPDATE ON public."CreditTransaction"
FOR EACH ROW
EXECUTE FUNCTION public.prevent_credit_transaction_update();
