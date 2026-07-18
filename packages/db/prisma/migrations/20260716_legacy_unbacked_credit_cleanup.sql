LOCK TABLE public."Tenant", public."CreditTransaction", public."PlatformConfig"
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  candidate RECORD;
  reconciled_tenant_count INTEGER := 0;
  reconciled_wallet_balance INTEGER;
  reconciliation_provenance JSONB;
  provenance_consumed_credits INTEGER;
  provenance_removed_credits INTEGER;
BEGIN
  PERFORM tenant."id"
  FROM public."Tenant" tenant
  WHERE tenant."slug" LIKE 'legacy-company-%'
  ORDER BY tenant."id"
  FOR UPDATE;

  FOR candidate IN
    SELECT
      tenant."id" AS tenant_id,
      tenant."usageCredits" AS wallet_balance,
      COUNT(credit."id")::INTEGER AS ledger_row_count,
      COUNT(credit."id") FILTER (
        WHERE credit."amount" < 0
          AND credit."debtAmount" = 0
      )::INTEGER AS ledger_debit_row_count,
      COALESCE(SUM(credit."amount"), 0)::BIGINT AS ledger_balance,
      provenance."value" AS import_provenance
    FROM public."Tenant" tenant
    LEFT JOIN public."CreditTransaction" credit
      ON credit."tenantId" = tenant."id"
    LEFT JOIN public."PlatformConfig" provenance
      ON provenance."key" = 'legacy-import.credit-provenance.v1.' || tenant."id"
    WHERE tenant."slug" LIKE 'legacy-company-%'
    GROUP BY tenant."id", tenant."usageCredits", provenance."value"
    ORDER BY tenant."id"
  LOOP
    IF candidate.import_provenance IS NOT NULL THEN
      IF jsonb_typeof(candidate.import_provenance) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'Legacy tenant % has malformed fixed-import credit provenance; manual reconciliation is required.', candidate.tenant_id
          USING ERRCODE = '23514';
      END IF;

      IF candidate.import_provenance->>'initialCreditPolicy' = 'zero-wallet-no-ledger' THEN
        IF candidate.import_provenance IS DISTINCT FROM jsonb_build_object(
             'version', 1,
             'tenantId', candidate.tenant_id,
             'sourceSha256', candidate.import_provenance->>'sourceSha256',
             'initialCreditPolicy', 'zero-wallet-no-ledger',
             'initialCreditGrant', 0
           )
           OR COALESCE(candidate.import_provenance->>'sourceSha256', '') !~ '^[0-9a-f]{64}$' THEN
          RAISE EXCEPTION 'Legacy tenant % has malformed fixed-import credit provenance; manual reconciliation is required.', candidate.tenant_id
            USING ERRCODE = '23514';
        END IF;
      ELSIF candidate.import_provenance->>'initialCreditPolicy' = 'legacy-unbacked-1000-reconciled' THEN
        IF candidate.import_provenance IS DISTINCT FROM jsonb_build_object(
             'version', 1,
             'tenantId', candidate.tenant_id,
             'initialCreditPolicy', 'legacy-unbacked-1000-reconciled',
             'initialCreditGrant', 1000
           ) THEN
          RAISE EXCEPTION 'Legacy tenant % has malformed reconciliation credit provenance; manual reconciliation is required.', candidate.tenant_id
            USING ERRCODE = '23514';
        END IF;
      ELSIF candidate.import_provenance->>'initialCreditPolicy' = 'legacy-unbacked-1000-consumed-reconciled' THEN
        IF jsonb_typeof(candidate.import_provenance->'consumedCreditValue') IS DISTINCT FROM 'number'
           OR jsonb_typeof(candidate.import_provenance->'removedUnspentCredits') IS DISTINCT FROM 'number'
           OR candidate.import_provenance->>'consumedCreditValue' !~ '^[1-9][0-9]{0,3}$'
           OR candidate.import_provenance->>'removedUnspentCredits' !~ '^(0|[1-9][0-9]{0,3})$' THEN
          RAISE EXCEPTION 'Legacy tenant % has malformed consumed-credit reconciliation provenance; manual reconciliation is required.', candidate.tenant_id
            USING ERRCODE = '23514';
        END IF;

        provenance_consumed_credits := (candidate.import_provenance->>'consumedCreditValue')::INTEGER;
        provenance_removed_credits := (candidate.import_provenance->>'removedUnspentCredits')::INTEGER;
        IF provenance_consumed_credits + provenance_removed_credits <> 1000
           OR candidate.import_provenance IS DISTINCT FROM jsonb_build_object(
             'version', 1,
             'tenantId', candidate.tenant_id,
             'initialCreditPolicy', 'legacy-unbacked-1000-consumed-reconciled',
             'initialCreditGrant', 1000,
             'consumedCreditValue', provenance_consumed_credits,
             'removedUnspentCredits', provenance_removed_credits
           ) THEN
          RAISE EXCEPTION 'Legacy tenant % has malformed consumed-credit reconciliation provenance; manual reconciliation is required.', candidate.tenant_id
            USING ERRCODE = '23514';
        END IF;
      ELSE
        RAISE EXCEPTION 'Legacy tenant % has unknown credit provenance; manual reconciliation is required.', candidate.tenant_id
          USING ERRCODE = '23514';
      END IF;

      IF candidate.import_provenance->>'initialCreditPolicy' = 'legacy-unbacked-1000-consumed-reconciled' THEN
        IF candidate.wallet_balance IS DISTINCT FROM candidate.ledger_balance + provenance_consumed_credits THEN
          RAISE EXCEPTION 'Legacy tenant % with consumed-credit provenance has an imbalanced wallet (wallet %, ledger %, consumed %); manual reconciliation is required.',
            candidate.tenant_id,
            candidate.wallet_balance,
            candidate.ledger_balance,
            provenance_consumed_credits
            USING ERRCODE = '23514';
        END IF;
      ELSIF candidate.wallet_balance IS DISTINCT FROM candidate.ledger_balance THEN
        RAISE EXCEPTION 'Legacy tenant % with per-tenant credit provenance has an imbalanced wallet (wallet %, ledger %); manual reconciliation is required.',
          candidate.tenant_id,
          candidate.wallet_balance,
          candidate.ledger_balance
          USING ERRCODE = '23514';
      END IF;
      CONTINUE;
    END IF;

    IF candidate.ledger_row_count = 0 AND candidate.wallet_balance = 0 THEN
      RAISE EXCEPTION 'Legacy tenant % has an ambiguous fully consumed or manually cleared unbacked credit history.', candidate.tenant_id
        USING ERRCODE = '23514';
    END IF;

    IF candidate.wallet_balance = candidate.ledger_balance THEN
      CONTINUE;
    END IF;

    reconciled_wallet_balance := NULL;
    reconciliation_provenance := NULL;
    IF candidate.wallet_balance = candidate.ledger_balance + 1000
       AND candidate.ledger_balance >= 0 THEN
      reconciled_wallet_balance := candidate.ledger_balance::INTEGER;
      reconciliation_provenance := jsonb_build_object(
        'version', 1,
        'tenantId', candidate.tenant_id,
        'initialCreditPolicy', 'legacy-unbacked-1000-reconciled',
        'initialCreditGrant', 1000
      );
    ELSIF candidate.wallet_balance = candidate.ledger_balance + 1000
       AND candidate.ledger_balance BETWEEN -1000 AND -1
       AND candidate.ledger_debit_row_count = candidate.ledger_row_count THEN
      reconciled_wallet_balance := 0;
      reconciliation_provenance := jsonb_build_object(
        'version', 1,
        'tenantId', candidate.tenant_id,
        'initialCreditPolicy', 'legacy-unbacked-1000-consumed-reconciled',
        'initialCreditGrant', 1000,
        'consumedCreditValue', -candidate.ledger_balance,
        'removedUnspentCredits', candidate.wallet_balance
      );
    END IF;

    IF reconciled_wallet_balance IS NOT NULL THEN
      UPDATE public."Tenant"
      SET "usageCredits" = reconciled_wallet_balance,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = candidate.tenant_id
        AND "usageCredits" = candidate.wallet_balance;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Legacy tenant % changed during unbacked credit reconciliation.', candidate.tenant_id
          USING ERRCODE = '40001';
      END IF;
      INSERT INTO public."PlatformConfig" (
        "id",
        "key",
        "value",
        "updatedAt",
        "updatedBy"
      ) VALUES (
        'legacy-credit-provenance-v1-' || candidate.tenant_id,
        'legacy-import.credit-provenance.v1.' || candidate.tenant_id,
        reconciliation_provenance,
        CURRENT_TIMESTAMP,
        'raw-migration'
      );
      reconciled_tenant_count := reconciled_tenant_count + 1;
      CONTINUE;
    END IF;

    RAISE EXCEPTION 'Legacy tenant % has an ambiguous or consumed credit history (wallet %, ledger %); manual reconciliation is required.',
      candidate.tenant_id,
      candidate.wallet_balance,
      candidate.ledger_balance
      USING ERRCODE = '23514';
  END LOOP;

  RAISE NOTICE 'Legacy unbacked credit cleanup reconciled % tenant(s).', reconciled_tenant_count;
END $$;
