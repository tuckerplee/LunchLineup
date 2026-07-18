-- Track credit debt so refunded or disputed purchased credits cannot remain
-- spendable after the original wallet balance has already been consumed.

LOCK TABLE public."Tenant", public."CreditTransaction" IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public."Tenant"
  ADD COLUMN IF NOT EXISTS "creditDebt" INTEGER;

ALTER TABLE public."Tenant"
  ALTER COLUMN "creditDebt" SET DEFAULT 0;

UPDATE public."Tenant"
SET "creditDebt" = 0
WHERE "creditDebt" IS NULL;

ALTER TABLE public."Tenant"
  ALTER COLUMN "creditDebt" SET NOT NULL;

ALTER TABLE public."Tenant"
  DROP CONSTRAINT IF EXISTS "Tenant_creditDebt_nonnegative_check";

ALTER TABLE public."Tenant"
  ADD CONSTRAINT "Tenant_creditDebt_nonnegative_check"
  CHECK ("creditDebt" >= 0);

ALTER TABLE public."CreditTransaction"
  ADD COLUMN IF NOT EXISTS "debtAmount" INTEGER,
  ADD COLUMN IF NOT EXISTS "debtAfter" INTEGER;

ALTER TABLE public."CreditTransaction"
  ALTER COLUMN "debtAmount" SET DEFAULT 0;

UPDATE public."CreditTransaction"
SET "debtAmount" = 0
WHERE "debtAmount" IS NULL;

ALTER TABLE public."CreditTransaction"
  ALTER COLUMN "debtAmount" SET NOT NULL;

-- Debt did not exist before this migration, so every historical settlement
-- has an exact zero debt result.
UPDATE public."CreditTransaction"
SET "debtAfter" = 0
WHERE "debtAfter" IS NULL;

ALTER TABLE public."CreditTransaction"
  DROP CONSTRAINT IF EXISTS "CreditTransaction_debtAfter_nonnegative_check";

ALTER TABLE public."CreditTransaction"
  ADD CONSTRAINT "CreditTransaction_debtAfter_nonnegative_check"
  CHECK ("debtAfter" IS NULL OR "debtAfter" >= 0);

-- Retained old releases omit the additive debt fields. Fill their immutable
-- debt snapshot from the tenant row while the two-release compatibility
-- window remains open, but fail closed if they try to settle while debt exists.
CREATE OR REPLACE FUNCTION public.populate_credit_transaction_debt_settlement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  tenant_credit_debt INTEGER;
BEGIN
  SELECT tenant."creditDebt"
  INTO STRICT tenant_credit_debt
  FROM public."Tenant" tenant
  WHERE tenant."id" = NEW."tenantId";

  IF NEW."debtAmount" IS NULL THEN
    NEW."debtAmount" := 0;
  END IF;

  IF NEW."debtAmount" = 0 AND tenant_credit_debt > 0 THEN
    RAISE EXCEPTION 'legacy credit settlement is blocked while tenant credit debt exists'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."debtAfter" IS NULL THEN
    NEW."debtAfter" := tenant_credit_debt;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "CreditTransaction_debt_settlement_default" ON public."CreditTransaction";
CREATE TRIGGER "CreditTransaction_debt_settlement_default"
BEFORE INSERT ON public."CreditTransaction"
FOR EACH ROW
EXECUTE FUNCTION public.populate_credit_transaction_debt_settlement();

-- Cross-runtime refund and correction owner. API and Python workers call this
-- inside their existing transaction after proving the operation's provenance.
CREATE OR REPLACE FUNCTION public.settle_positive_credit_value(
  p_tenant_id TEXT,
  p_value INTEGER,
  p_reason TEXT,
  p_transaction_id TEXT
)
RETURNS TABLE (
  "transactionId" TEXT,
  "creditedValue" INTEGER,
  "spendableAmount" INTEGER,
  "repaidDebt" INTEGER,
  "newBalance" INTEGER,
  "debtAfter" INTEGER,
  "replayed" BOOLEAN
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_balance INTEGER;
  current_debt INTEGER;
  repaid_debt INTEGER;
  spendable_amount INTEGER;
  settled_balance INTEGER;
  settled_debt INTEGER;
  existing_settlement public."CreditTransaction"%ROWTYPE;
BEGIN
  IF p_tenant_id IS NULL OR btrim(p_tenant_id) = '' THEN
    RAISE EXCEPTION 'tenant id is required' USING ERRCODE = '22023';
  END IF;
  IF p_value IS NULL OR p_value <= 0 THEN
    RAISE EXCEPTION 'positive credit value is required' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' OR char_length(p_reason) > 500 THEN
    RAISE EXCEPTION 'credit settlement reason is invalid' USING ERRCODE = '22023';
  END IF;
  IF p_transaction_id IS NULL
     OR btrim(p_transaction_id) = ''
     OR char_length(p_transaction_id) > 255
     OR p_transaction_id ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'credit settlement transaction id is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT tenant."usageCredits", tenant."creditDebt"
  INTO current_balance, current_debt
  FROM public."Tenant" tenant
  WHERE tenant."id" = p_tenant_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit settlement tenant was not found' USING ERRCODE = 'P0002';
  END IF;
  IF current_balance < 0 OR current_debt < 0 THEN
    RAISE EXCEPTION 'credit settlement tenant state is invalid' USING ERRCODE = '22003';
  END IF;

  SELECT ledger.*
  INTO existing_settlement
  FROM public."CreditTransaction" ledger
  WHERE ledger."id" = p_transaction_id;
  IF FOUND THEN
    IF existing_settlement."tenantId" IS DISTINCT FROM p_tenant_id
       OR existing_settlement."reason" IS DISTINCT FROM p_reason
       OR existing_settlement."amount" < 0
       OR existing_settlement."debtAmount" > 0
       OR existing_settlement."balanceAfter" IS NULL
       OR existing_settlement."balanceAfter" < 0
       OR existing_settlement."debtAfter" IS NULL
       OR existing_settlement."debtAfter" < 0
       OR existing_settlement."amount"::BIGINT
          - existing_settlement."debtAmount"::BIGINT <> p_value::BIGINT THEN
      RAISE EXCEPTION 'credit settlement identity has conflicting billing details'
        USING ERRCODE = '23505';
    END IF;

    RETURN QUERY SELECT
      p_transaction_id,
      p_value,
      existing_settlement."amount",
      -existing_settlement."debtAmount",
      existing_settlement."balanceAfter",
      existing_settlement."debtAfter",
      TRUE;
    RETURN;
  END IF;

  repaid_debt := LEAST(current_debt, p_value);
  spendable_amount := p_value - repaid_debt;
  settled_balance := current_balance + spendable_amount;
  settled_debt := current_debt - repaid_debt;

  UPDATE public."Tenant"
  SET
    "usageCredits" = settled_balance,
    "creditDebt" = settled_debt,
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = p_tenant_id;

  INSERT INTO public."CreditTransaction" (
    "id",
    "tenantId",
    "amount",
    "debtAmount",
    "reason",
    "balanceAfter",
    "debtAfter",
    "createdAt"
  )
  VALUES (
    p_transaction_id,
    p_tenant_id,
    spendable_amount,
    -repaid_debt,
    p_reason,
    settled_balance,
    settled_debt,
    CURRENT_TIMESTAMP
  );

  RETURN QUERY SELECT
    p_transaction_id,
    p_value,
    spendable_amount,
    repaid_debt,
    settled_balance,
    settled_debt,
    FALSE;
END;
$$;

-- Replace the existing function in place so the installed trigger also makes
-- the new debt fields append-only.
CREATE OR REPLACE FUNCTION public.prevent_credit_transaction_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
      NEW."id",
      NEW."tenantId",
      NEW."amount",
      NEW."debtAmount",
      NEW."reason",
      NEW."balanceAfter",
      NEW."debtAfter",
      NEW."createdAt"
    ) IS DISTINCT FROM ROW(
      OLD."id",
      OLD."tenantId",
      OLD."amount",
      OLD."debtAmount",
      OLD."reason",
      OLD."balanceAfter",
      OLD."debtAfter",
      OLD."createdAt"
    ) THEN
    RAISE EXCEPTION 'CreditTransaction settlement rows are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON COLUMN public."Tenant"."creditDebt" IS
  'Purchased credit value already consumed before a provider refund or dispute';
COMMENT ON COLUMN public."CreditTransaction"."debtAmount" IS
  'Immutable credit-debt delta; positive incurs debt and negative repays it';
COMMENT ON COLUMN public."CreditTransaction"."debtAfter" IS
  'Immutable debt result; old-writer inserts are populated by a compatibility trigger';
COMMENT ON FUNCTION public.settle_positive_credit_value(TEXT, INTEGER, TEXT, TEXT) IS
  'Atomically repays credit debt before exposing positive credit value as spendable wallet balance';
