-- Separate local completion of immutable GET observation. No original provider backfill.
ALTER TABLE public."TenantSetting"
    ADD COLUMN IF NOT EXISTS "selectedLifecycleObservationFinalizationIntentSha256" TEXT,
    ADD COLUMN IF NOT EXISTS "selectedLifecycleObservationFinalizationReceipt" JSONB,
    ADD COLUMN IF NOT EXISTS "selectedLifecycleObservationTerminalIntentSha256" TEXT,
    ADD COLUMN IF NOT EXISTS "selectedLifecycleObservationTerminalReceipt" JSONB;
ALTER TABLE public."TenantSetting" ADD CONSTRAINT "TenantSetting_observation_finalization_complete" CHECK (
    ("selectedLifecycleObservationFinalizationIntentSha256" IS NULL AND "selectedLifecycleObservationFinalizationReceipt" IS NULL)
    OR ("selectedLifecycleObservationFinalizationIntentSha256" ~ '^[a-f0-9]{64}$'
        AND "selectedLifecycleObservationFinalizationIntentSha256" IS NOT NULL
        AND "selectedLifecycleObservationFinalizationReceipt" IS NOT NULL
        AND jsonb_typeof("selectedLifecycleObservationFinalizationReceipt") = 'object'
        AND "selectedLifecycleIntentSha256" IS NOT NULL AND "selectedLifecycleProviderIntentSha256" IS NOT NULL
        AND "selectedLifecycleTerminalReceipt" IS NULL
        AND ("selectedLifecycleObservationFinalizationReceipt"->>'source') IS NOT DISTINCT FROM 'provider-observation'
        AND ("selectedLifecycleObservationFinalizationReceipt"->>'tenantId') IS NOT DISTINCT FROM "tenantId"
        AND ("selectedLifecycleObservationFinalizationReceipt"->>'operationId') IS NOT DISTINCT FROM "selectedLifecycleOperationId"
        AND ("selectedLifecycleObservationFinalizationReceipt"->>'requestIntentSha256') IS NOT DISTINCT FROM "selectedLifecycleIntentSha256"
        AND ("selectedLifecycleObservationFinalizationReceipt"->>'providerIntentSha256') IS NOT DISTINCT FROM "selectedLifecycleProviderIntentSha256"
        AND ("selectedLifecycleObservationFinalizationReceipt"->>'state') IS NOT DISTINCT FROM 'FINALIZED'
        AND ("selectedLifecycleObservationFinalizationReceipt"->>'backendSettlementProved') IS NOT DISTINCT FROM 'false'
        AND ("selectedLifecycleObservationFinalizationReceipt"->>'retryAllowed') IS NOT DISTINCT FROM 'false'
        AND ("value"->>'state') IS NOT DISTINCT FROM 'FINALIZED' AND ("value"->>'providerMutationOwned') IS NOT DISTINCT FROM 'true'
        AND (("value"->'providerResult') IS NOT DISTINCT FROM ("selectedLifecycleObservationFinalizationReceipt"->'outcome')
            OR ("selectedLifecycleObservationTerminalReceipt" IS NOT NULL
                AND ("value"->'providerResult') IS NOT DISTINCT FROM ("selectedLifecycleObservationTerminalReceipt"->'outcome'))))
);
ALTER TABLE public."TenantSetting" ADD CONSTRAINT "TenantSetting_observation_terminal_complete" CHECK (
    ("selectedLifecycleObservationTerminalIntentSha256" IS NULL AND "selectedLifecycleObservationTerminalReceipt" IS NULL)
    OR ("selectedLifecycleObservationTerminalIntentSha256" IS NOT NULL
        AND "selectedLifecycleObservationTerminalIntentSha256" ~ '^[a-f0-9]{64}$'
        AND "selectedLifecycleObservationTerminalReceipt" IS NOT NULL AND jsonb_typeof("selectedLifecycleObservationTerminalReceipt") = 'object'
        AND "selectedLifecycleObservationFinalizationReceipt" IS NOT NULL
        AND ("selectedLifecycleObservationTerminalReceipt"->>'source') IS NOT DISTINCT FROM 'verified-terminal-event'
        AND ("selectedLifecycleObservationTerminalReceipt"->>'tenantId') IS NOT DISTINCT FROM "tenantId"
        AND ("selectedLifecycleObservationTerminalReceipt"->>'operationId') IS NOT DISTINCT FROM "selectedLifecycleOperationId"
        AND ("selectedLifecycleObservationTerminalReceipt"->>'requestIntentSha256') IS NOT DISTINCT FROM "selectedLifecycleIntentSha256"
        AND ("selectedLifecycleObservationTerminalReceipt"->>'providerIntentSha256') IS NOT DISTINCT FROM "selectedLifecycleProviderIntentSha256"
        AND ("selectedLifecycleObservationTerminalReceipt"->>'state') IS NOT DISTINCT FROM 'FINALIZED'
        AND ("selectedLifecycleObservationTerminalReceipt"->'outcome'->>'action') IS NOT DISTINCT FROM 'already_canceled'
        AND ("selectedLifecycleObservationTerminalReceipt"->>'backendSettlementProved') IS NOT DISTINCT FROM 'false'
        AND ("selectedLifecycleObservationTerminalReceipt"->>'retryAllowed') IS NOT DISTINCT FROM 'false'
        AND ("value"->'providerResult') IS NOT DISTINCT FROM ("selectedLifecycleObservationTerminalReceipt"->'outcome'))
);

CREATE OR REPLACE FUNCTION public.guard_selected_observation_settlement()
RETURNS TRIGGER AS $$
DECLARE tenant_row public."Tenant"%ROWTYPE; observation public."TenantCancellationObservation"%ROWTYPE;
    application public."TenantCancellationTerminalEvent"%ROWTYPE; receipt JSONB; original JSONB;
    expected_outcome JSONB; expected_snapshot JSONB; terminal_phase BOOLEAN; changes_billing BOOLEAN;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."selectedLifecycleObservationFinalizationIntentSha256" IS NOT NULL OR NEW."selectedLifecycleObservationFinalizationReceipt" IS NOT NULL
            OR NEW."selectedLifecycleObservationTerminalIntentSha256" IS NOT NULL OR NEW."selectedLifecycleObservationTerminalReceipt" IS NOT NULL THEN
            RAISE EXCEPTION 'Observed settlement requires existing request custody' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD."selectedLifecycleObservationFinalizationReceipt" IS NOT NULL AND (
        ROW(NEW."selectedLifecycleProviderReceipt", NEW."selectedLifecycleProviderBillingRevision", NEW."selectedLifecycleTerminalReceipt")
        IS DISTINCT FROM ROW(OLD."selectedLifecycleProviderReceipt", OLD."selectedLifecycleProviderBillingRevision", OLD."selectedLifecycleTerminalReceipt")
    ) THEN
        RAISE EXCEPTION 'Observed settlement preserves original provider nulls and terminal chain' USING ERRCODE = '23514';
    END IF;
    IF OLD."selectedLifecycleObservationFinalizationReceipt" IS NULL AND NEW."selectedLifecycleObservationFinalizationReceipt" IS NOT NULL THEN
        IF OLD."selectedLifecycleObservationFinalizationIntentSha256" IS NOT NULL
            OR OLD."selectedLifecycleObservationTerminalReceipt" IS NOT NULL OR NEW."selectedLifecycleObservationTerminalReceipt" IS NOT NULL
            OR NEW."selectedLifecycleObservationTerminalIntentSha256" IS NOT NULL THEN
            RAISE EXCEPTION 'Only initial observation settlement may consume its slot' USING ERRCODE = '23514';
        END IF;
        terminal_phase := FALSE; receipt := NEW."selectedLifecycleObservationFinalizationReceipt";
    ELSIF OLD."selectedLifecycleObservationTerminalReceipt" IS NULL AND NEW."selectedLifecycleObservationTerminalReceipt" IS NOT NULL THEN
        IF OLD."selectedLifecycleObservationTerminalIntentSha256" IS NOT NULL OR OLD."selectedLifecycleObservationFinalizationReceipt" IS NULL
            OR ROW(NEW."selectedLifecycleObservationFinalizationIntentSha256", NEW."selectedLifecycleObservationFinalizationReceipt")
                IS DISTINCT FROM ROW(OLD."selectedLifecycleObservationFinalizationIntentSha256", OLD."selectedLifecycleObservationFinalizationReceipt") THEN
            RAISE EXCEPTION 'Observed terminal append preserves initial completion' USING ERRCODE = '23514';
        END IF;
        terminal_phase := TRUE; receipt := NEW."selectedLifecycleObservationTerminalReceipt";
    ELSE
        IF ROW(NEW."selectedLifecycleObservationFinalizationIntentSha256", NEW."selectedLifecycleObservationFinalizationReceipt",
            NEW."selectedLifecycleObservationTerminalIntentSha256", NEW."selectedLifecycleObservationTerminalReceipt")
            IS DISTINCT FROM ROW(OLD."selectedLifecycleObservationFinalizationIntentSha256", OLD."selectedLifecycleObservationFinalizationReceipt",
                OLD."selectedLifecycleObservationTerminalIntentSha256", OLD."selectedLifecycleObservationTerminalReceipt") THEN
            RAISE EXCEPTION 'Observed settlement receipts are immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    SELECT * INTO STRICT tenant_row FROM public."Tenant" WHERE "id" = NEW."tenantId" FOR UPDATE NOWAIT;
    SELECT * INTO STRICT observation FROM public."TenantCancellationObservation"
        WHERE "id" = (receipt->>'observationId') AND "tenantId" = NEW."tenantId" FOR UPDATE NOWAIT;
    original := jsonb_build_object('value', OLD."value", 'requestIntentSha256', OLD."selectedLifecycleIntentSha256",
        'operationId', OLD."selectedLifecycleOperationId", 'providerIntentSha256', OLD."selectedLifecycleProviderIntentSha256",
        'customerId', OLD."selectedLifecycleProviderCustomerId",
        'providerLeaseUntil', to_char(OLD."selectedLifecycleProviderLeaseUntil", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'providerReceipt', OLD."selectedLifecycleProviderReceipt", 'providerBillingRevision', OLD."selectedLifecycleProviderBillingRevision",
        'finalizationReceipt', OLD."selectedLifecycleFinalizationReceipt", 'terminalReceipt', OLD."selectedLifecycleTerminalReceipt");
    expected_snapshot := jsonb_build_object('status', tenant_row."status"::text, 'customerId', tenant_row."stripeCustomerId",
        'subscriptionId', tenant_row."stripeSubscriptionId", 'currentPeriodEnd', CASE WHEN tenant_row."stripeSubscriptionCurrentPeriodEnd" IS NULL THEN NULL
            ELSE to_char(tenant_row."stripeSubscriptionCurrentPeriodEnd", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
        'billingRevision', tenant_row."selectedBillingRevision");
    IF observation."receipt" IS NULL OR observation."completedAt" IS NULL OR observation."billingRevision" IS NULL OR observation."attempts" <> 1
        OR observation."operationId" IS DISTINCT FROM OLD."selectedLifecycleOperationId"
        OR observation."requestIntentSha256" IS DISTINCT FROM OLD."selectedLifecycleIntentSha256"
        OR observation."providerIntentSha256" IS DISTINCT FROM OLD."selectedLifecycleProviderIntentSha256"
        OR observation."customerId" IS DISTINCT FROM OLD."selectedLifecycleProviderCustomerId"
        OR observation."subscriptionId" IS DISTINCT FROM (OLD."value"->>'providerSubscriptionId')
        OR (receipt->>'version') IS DISTINCT FROM '1' OR (receipt->>'tenantId') IS DISTINCT FROM NEW."tenantId"
        OR (receipt->>'operationId') IS DISTINCT FROM observation."operationId"
        OR (receipt->>'requestIntentSha256') IS DISTINCT FROM observation."requestIntentSha256"
        OR (receipt->>'providerIntentSha256') IS DISTINCT FROM observation."providerIntentSha256"
        OR (receipt->>'observationIntentSha256') IS DISTINCT FROM observation."observationIntentSha256"
        OR (receipt->>'priorReceiptSha256') IS DISTINCT FROM observation."priorReceiptSha256"
        OR COALESCE(receipt->>'observationReceiptSha256', '') !~ '^[a-f0-9]{64}$'
        OR (receipt->>'backendSettlementProved') IS DISTINCT FROM 'false' OR (receipt->>'retryAllowed') IS DISTINCT FROM 'false'
        OR (receipt->>'state') IS DISTINCT FROM 'FINALIZED'
        OR (receipt->>'observationBillingRevision') IS DISTINCT FROM observation."billingRevision"::text
        OR (receipt->>'billingRevisionBefore') IS DISTINCT FROM tenant_row."selectedBillingRevision"::text
        OR (NEW."value"->>'state') IS DISTINCT FROM 'FINALIZED' OR (NEW."value"->>'providerMutationOwned') IS DISTINCT FROM 'true'
        OR (NEW."value"->'providerResult') IS DISTINCT FROM (receipt->'outcome')
        OR (NEW."value" - ARRAY['state','providerResult','providerMutationOwned']) IS DISTINCT FROM (OLD."value" - ARRAY['state','providerResult','providerMutationOwned'])
        OR OLD."selectedLifecycleTerminalReceipt" IS NOT NULL OR (OLD."value"->>'providerAttempts') IS DISTINCT FROM '1'
        OR tenant_row."deletedAt" IS NOT NULL OR tenant_row."status"::text IN ('PURGED', 'SUSPENDED')
        OR tenant_row."stripeCustomerId" IS DISTINCT FROM observation."customerId"
        OR EXISTS (SELECT 1 FROM public."TenantSetting" WHERE "tenantId" = NEW."tenantId"
            AND "key" = 'internal:tenant-lifecycle-intent:platform_archive') THEN
        RAISE EXCEPTION 'Exact current observed cancellation custody required' USING ERRCODE = '23514';
    END IF;
    IF NOT terminal_phase THEN
        expected_outcome := jsonb_build_object('action', observation."receipt"->'provider'->'outcome'->'action',
            'cancelAtPeriodEnd', observation."receipt"->'provider'->'outcome'->'cancelAtPeriodEnd',
            'currentPeriodEnd', observation."receipt"->'provider'->'outcome'->'currentPeriodEnd',
            'cancelAt', observation."receipt"->'provider'->'outcome'->'cancelAt', 'canceledAt', observation."receipt"->'provider'->'outcome'->'canceledAt',
            'cancellationBehavior', 'cancel_at_period_end');
        IF (receipt->>'source') IS DISTINCT FROM 'provider-observation' OR original IS DISTINCT FROM observation."original"
            OR observation."billingRevision" IS DISTINCT FROM tenant_row."selectedBillingRevision"
            OR (observation."receipt"->'snapshot') IS DISTINCT FROM expected_snapshot
            OR (observation."receipt"->'provider'->>'disposition') IS DISTINCT FROM 'OBSERVED_OWNED_CANCELLATION'
            OR (observation."receipt"->'provider'->'outcome'->>'providerMutationOwned') IS DISTINCT FROM 'true'
            OR (receipt->'outcome') IS DISTINCT FROM expected_outcome
            OR COALESCE(expected_outcome->>'action', '') NOT IN ('already_scheduled','already_canceled')
            OR COALESCE(OLD."value"->>'state', '') NOT IN ('PENDING_PROVIDER','FINALIZED')
            OR (OLD."value"->>'state' = 'PENDING_PROVIDER' AND (OLD."value"->>'providerResult') IS NOT NULL)
            OR (OLD."value"->>'state' = 'FINALIZED' AND COALESCE(OLD."value"->'providerResult'->>'action', '') NOT IN ('scheduled','already_scheduled'))
            OR NOT (tenant_row."stripeSubscriptionId" IS NOT DISTINCT FROM observation."subscriptionId"
                OR (expected_outcome->>'action' = 'already_canceled' AND tenant_row."status"::text = 'CANCELLED'
                    AND tenant_row."stripeSubscriptionId" IS NULL AND tenant_row."stripeSubscriptionCurrentPeriodEnd" IS NULL)) THEN
            RAISE EXCEPTION 'Exact unchanged positive observation snapshot required' USING ERRCODE = '23514';
        END IF;
        IF expected_outcome->>'action' = 'already_scheduled' THEN
            IF tenant_row."status"::text = 'CANCELLED' OR (expected_outcome->>'cancelAtPeriodEnd') IS DISTINCT FROM 'true'
                OR (expected_outcome->>'currentPeriodEnd') IS NULL
                OR ((expected_outcome->>'currentPeriodEnd')::timestamptz AT TIME ZONE 'UTC') < tenant_row."stripeSubscriptionCurrentPeriodEnd" THEN
                RAISE EXCEPTION 'Observed schedule cannot shorten or resurrect access' USING ERRCODE = '23514';
            END IF;
            changes_billing := (expected_snapshot->>'currentPeriodEnd') IS DISTINCT FROM (expected_outcome->>'currentPeriodEnd');
        ELSE
            changes_billing := tenant_row."status"::text <> 'CANCELLED' OR tenant_row."stripeSubscriptionId" IS NOT NULL
                OR tenant_row."stripeSubscriptionCurrentPeriodEnd" IS NOT NULL;
        END IF;
        IF (receipt->>'billingRevisionAfter') IS DISTINCT FROM (tenant_row."selectedBillingRevision" + CASE WHEN changes_billing THEN 1 ELSE 0 END)::text THEN
            RAISE EXCEPTION 'Exact observed local transition revision required' USING ERRCODE = '23514';
        END IF;
    ELSE
        IF (receipt->>'source') IS DISTINCT FROM 'verified-terminal-event'
            OR (OLD."selectedLifecycleObservationFinalizationReceipt"->'outcome'->>'action') IS DISTINCT FROM 'already_scheduled'
            OR (OLD."value"->'providerResult') IS DISTINCT FROM (OLD."selectedLifecycleObservationFinalizationReceipt"->'outcome')
            OR (original - 'value') IS DISTINCT FROM (observation."original" - 'value')
            OR (OLD."value" - ARRAY['state','providerResult','providerMutationOwned']) IS DISTINCT FROM ((observation."original"->'value') - ARRAY['state','providerResult','providerMutationOwned'])
            OR COALESCE(receipt->>'observationFinalizationSha256', '') !~ '^[a-f0-9]{64}$'
            OR COALESCE(receipt->>'applicationReceiptSha256', '') !~ '^[a-f0-9]{64}$' THEN
            RAISE EXCEPTION 'Exact observation-finalized terminal predecessor required' USING ERRCODE = '23514';
        END IF;
        PERFORM "id" FROM public."BillingEvent" WHERE "id" = (receipt->>'eventId') AND "tenantId" = NEW."tenantId" FOR UPDATE NOWAIT;
        IF NOT FOUND THEN RAISE EXCEPTION 'Observed terminal parent is absent' USING ERRCODE = '23514'; END IF;
        SELECT * INTO STRICT application FROM public."TenantCancellationTerminalEvent"
            WHERE "eventId" = (receipt->>'eventId') AND "tenantId" = NEW."tenantId" FOR UPDATE NOWAIT;
        IF (receipt->'applicationReceipt') IS DISTINCT FROM jsonb_build_object('eventId', application."eventId", 'tenantId', application."tenantId", 'receipt', application."receipt")
            OR (receipt->'outcome') IS DISTINCT FROM (application."receipt"->'outcome')
            OR (application."receipt"->>'operationId') IS DISTINCT FROM observation."operationId"
            OR (application."receipt"->>'customerId') IS DISTINCT FROM observation."customerId"
            OR (application."receipt"->>'subscriptionId') IS DISTINCT FROM observation."subscriptionId"
            OR (application."receipt"->'postState'->>'billingRevision') IS DISTINCT FROM tenant_row."selectedBillingRevision"::text
            OR tenant_row."selectedBillingRevision" <= (OLD."selectedLifecycleObservationFinalizationReceipt"->>'billingRevisionAfter')::integer
            OR tenant_row."status"::text IS DISTINCT FROM 'CANCELLED' OR tenant_row."stripeSubscriptionId" IS NOT NULL
            OR tenant_row."stripeSubscriptionCurrentPeriodEnd" IS NOT NULL
            OR (receipt->>'billingRevisionAfter') IS DISTINCT FROM tenant_row."selectedBillingRevision"::text THEN
            RAISE EXCEPTION 'Exact later authenticated observed-terminal application required' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF (receipt->'postState') IS DISTINCT FROM jsonb_build_object(
        'status', CASE WHEN receipt->'outcome'->>'action' = 'already_canceled' THEN 'CANCELLED' ELSE tenant_row."status"::text END,
        'deletedAt', NULL, 'customerId', observation."customerId",
        'subscriptionId', CASE WHEN receipt->'outcome'->>'action' = 'already_canceled' THEN NULL ELSE observation."subscriptionId" END,
        'currentPeriodEnd', CASE WHEN receipt->'outcome'->>'action' = 'already_canceled' THEN NULL ELSE receipt->'outcome'->>'currentPeriodEnd' END,
        'billingRevision', (receipt->>'billingRevisionAfter')::integer) THEN
        RAISE EXCEPTION 'Exact observed post-settlement projection required' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;
CREATE TRIGGER "TenantSetting_selected_cancellation_2_observed"
BEFORE INSERT OR UPDATE ON public."TenantSetting"
FOR EACH ROW EXECUTE FUNCTION public.guard_selected_observation_settlement();

ALTER TABLE public."TenantSetting" DROP CONSTRAINT IF EXISTS "TenantSetting_selected_finalization_complete";
ALTER TABLE public."TenantSetting" ADD CONSTRAINT "TenantSetting_selected_finalization_complete" CHECK (
    ("selectedLifecycleFinalizationIntentSha256" IS NULL AND "selectedLifecycleFinalizationReceipt" IS NULL
        AND ("selectedLifecycleIntentSha256" IS NULL OR ("value"->>'state') IS DISTINCT FROM 'FINALIZED'
            OR "selectedLifecycleTerminalReceipt" IS NOT NULL OR "selectedLifecycleObservationFinalizationReceipt" IS NOT NULL))
    OR ("selectedLifecycleFinalizationIntentSha256" IS NOT NULL
        AND "selectedLifecycleFinalizationIntentSha256" ~ '^[a-f0-9]{64}$'
        AND "selectedLifecycleIntentSha256" IS NOT NULL AND "selectedLifecycleProviderIntentSha256" IS NOT NULL
        AND "selectedLifecycleProviderReceipt" IS NOT NULL AND "selectedLifecycleProviderBillingRevision" IS NOT NULL
        AND "selectedLifecycleFinalizationReceipt" IS NOT NULL AND jsonb_typeof("selectedLifecycleFinalizationReceipt") = 'object'
        AND ("value"->>'state') IS NOT DISTINCT FROM 'FINALIZED'
        AND ("selectedLifecycleFinalizationReceipt"->>'tenantId') IS NOT DISTINCT FROM "tenantId"
        AND ("selectedLifecycleFinalizationReceipt"->>'operationId') IS NOT DISTINCT FROM "selectedLifecycleOperationId"
        AND ("selectedLifecycleFinalizationReceipt"->>'requestIntentSha256') IS NOT DISTINCT FROM "selectedLifecycleIntentSha256"
        AND ("selectedLifecycleFinalizationReceipt"->>'providerIntentSha256') IS NOT DISTINCT FROM "selectedLifecycleProviderIntentSha256"
        AND ("selectedLifecycleFinalizationReceipt"->>'providerReceiptSha256') IS NOT NULL
        AND ("selectedLifecycleFinalizationReceipt"->>'providerReceiptSha256') ~ '^[a-f0-9]{64}$'
        AND ("selectedLifecycleFinalizationReceipt"->>'billingRevision') IS NOT DISTINCT FROM "selectedLifecycleProviderBillingRevision"::text
        AND ("selectedLifecycleFinalizationReceipt"->>'state') IS NOT DISTINCT FROM 'FINALIZED'
        AND ("selectedLifecycleFinalizationReceipt"->>'action') IS NOT DISTINCT FROM ("selectedLifecycleProviderReceipt"->'outcome'->>'action')
    )
);

-- Atomically replace the request0-only CHECK with request0 OR consumed provider1.
ALTER TABLE public."TenantSetting" DROP CONSTRAINT IF EXISTS "TenantSetting_selected_lifecycle_complete";
ALTER TABLE public."TenantSetting" ADD CONSTRAINT "TenantSetting_selected_lifecycle_complete" CHECK (
    ("selectedLifecycleIntentSha256" IS NULL AND "selectedLifecycleOperationId" IS NULL
        AND "selectedLifecycleProviderIntentSha256" IS NULL AND "selectedLifecycleProviderCustomerId" IS NULL
        AND "selectedLifecycleProviderLeaseUntil" IS NULL AND "selectedLifecycleProviderRequestId" IS NULL
        AND "selectedLifecycleProviderReceipt" IS NULL AND "selectedLifecycleProviderCompletedAt" IS NULL)
    OR ("selectedLifecycleIntentSha256" IS NOT NULL AND "selectedLifecycleOperationId" IS NOT NULL
        AND "selectedLifecycleIntentSha256" ~ '^[a-f0-9]{64}$'
        AND length("selectedLifecycleOperationId") BETWEEN 1 AND 128
        AND "key" = 'internal:tenant-lifecycle-intent:customer_cancellation'
        AND ("value"->>'tenantId') IS NOT DISTINCT FROM "tenantId"
        AND ("value"->>'operationId') IS NOT DISTINCT FROM "selectedLifecycleOperationId"
        AND ("value"->>'kind') IS NOT DISTINCT FROM 'CUSTOMER_CANCELLATION'
        AND (
            (("value"->>'state') IS NOT DISTINCT FROM 'PENDING_PROVIDER' AND ("value"->>'providerResult') IS NULL)
            OR (("value"->>'state') IS NOT DISTINCT FROM 'FINALIZED'
                AND ("selectedLifecycleFinalizationReceipt" IS NOT NULL OR "selectedLifecycleTerminalReceipt" IS NOT NULL)
                AND (("value"->'providerResult') IS NOT DISTINCT FROM jsonb_build_object(
                    'action', "selectedLifecycleProviderReceipt"->'outcome'->'action',
                    'cancelAtPeriodEnd', "selectedLifecycleProviderReceipt"->'outcome'->'cancelAtPeriodEnd',
                    'currentPeriodEnd', "selectedLifecycleProviderReceipt"->'outcome'->'currentPeriodEnd',
                    'cancelAt', "selectedLifecycleProviderReceipt"->'outcome'->'cancelAt',
                    'canceledAt', "selectedLifecycleProviderReceipt"->'outcome'->'canceledAt',
                    'cancellationBehavior', 'cancel_at_period_end')
                    OR ("selectedLifecycleTerminalReceipt" IS NOT NULL AND ("value"->'providerResult') IS NOT DISTINCT FROM ("selectedLifecycleTerminalReceipt"->'outcome')))
                AND ("value"->'providerMutationOwned') IS NOT DISTINCT FROM ("selectedLifecycleProviderReceipt"->'outcome'->'providerMutationOwned'))
            OR (("value"->>'state') IS NOT DISTINCT FROM 'FINALIZED'
                AND "selectedLifecycleObservationFinalizationReceipt" IS NOT NULL
                AND ("value"->>'providerMutationOwned') IS NOT DISTINCT FROM 'true'
                AND (("value"->'providerResult') IS NOT DISTINCT FROM ("selectedLifecycleObservationFinalizationReceipt"->'outcome')
                    OR ("selectedLifecycleObservationTerminalReceipt" IS NOT NULL
                        AND ("value"->'providerResult') IS NOT DISTINCT FROM ("selectedLifecycleObservationTerminalReceipt"->'outcome'))))
        )
        AND (
            ("selectedLifecycleProviderIntentSha256" IS NULL AND "selectedLifecycleProviderCustomerId" IS NULL
                AND "selectedLifecycleProviderLeaseUntil" IS NULL AND "selectedLifecycleProviderRequestId" IS NULL
                AND "selectedLifecycleProviderReceipt" IS NULL AND "selectedLifecycleProviderCompletedAt" IS NULL
                AND ("value"->>'providerAttempts') IS NOT DISTINCT FROM '0'
                AND ("value"->>'providerLeaseOwner') IS NULL AND ("value"->>'providerLeaseExpiresAt') IS NULL)
            OR ("selectedLifecycleProviderIntentSha256" IS NOT NULL
                AND "selectedLifecycleProviderIntentSha256" ~ '^[a-f0-9]{64}$'
                AND "selectedLifecycleProviderLeaseUntil" IS NOT NULL
                AND ("value"->>'providerAttempts') IS NOT DISTINCT FROM '1'
                AND ("value"->>'providerLeaseOwner') IS NOT NULL
                AND length("value"->>'providerLeaseOwner') BETWEEN 1 AND 128
                AND CASE WHEN ("value"->>'providerLeaseExpiresAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
                    THEN (("value"->>'providerLeaseExpiresAt')::timestamptz AT TIME ZONE 'UTC') = "selectedLifecycleProviderLeaseUntil"
                    ELSE FALSE END
                AND (("value"->>'providerSubscriptionId') IS NULL OR "selectedLifecycleProviderCustomerId" IS NOT NULL)
                AND (
                    ("selectedLifecycleProviderReceipt" IS NULL AND "selectedLifecycleProviderRequestId" IS NULL
                        AND "selectedLifecycleProviderCompletedAt" IS NULL)
                    OR ("selectedLifecycleProviderReceipt" IS NOT NULL AND "selectedLifecycleProviderCompletedAt" IS NOT NULL
                        AND jsonb_typeof("selectedLifecycleProviderReceipt") = 'object'
                        AND ("selectedLifecycleProviderReceipt"->>'tenantId') IS NOT DISTINCT FROM "tenantId"
                        AND ("selectedLifecycleProviderReceipt"->>'operationId') IS NOT DISTINCT FROM "selectedLifecycleOperationId"
                        AND ("selectedLifecycleProviderReceipt"->>'customerId') IS NOT DISTINCT FROM "selectedLifecycleProviderCustomerId"
                        AND ("selectedLifecycleProviderReceipt"->>'providerRequestId') IS NOT DISTINCT FROM "selectedLifecycleProviderRequestId"
                        AND jsonb_typeof("selectedLifecycleProviderReceipt"->'outcome') IS NOT DISTINCT FROM 'object'
                        AND ("selectedLifecycleProviderReceipt"->'outcome'->>'stripeSubscriptionId') IS NOT DISTINCT FROM ("value"->>'providerSubscriptionId')
                        AND (
                            (("selectedLifecycleProviderReceipt"->>'disposition') IS NOT DISTINCT FROM 'NO_SUBSCRIPTION'
                                AND "selectedLifecycleProviderRequestId" IS NULL AND ("value"->>'providerSubscriptionId') IS NULL
                                AND ("selectedLifecycleProviderReceipt"->'outcome'->>'action') IS NOT DISTINCT FROM 'none')
                            OR ("selectedLifecycleProviderRequestId" IS NOT NULL AND length("selectedLifecycleProviderRequestId") BETWEEN 1 AND 255
                                AND ("value"->>'providerSubscriptionId') IS NOT NULL
                                AND (("selectedLifecycleProviderReceipt"->>'disposition') IS NOT DISTINCT FROM 'READBACK'
                                    OR (("selectedLifecycleProviderReceipt"->>'disposition') IS NOT DISTINCT FROM 'MUTATION_ACCEPTED'
                                        AND ("selectedLifecycleProviderReceipt"->'outcome'->>'providerMutationOwned') IS NOT DISTINCT FROM 'true')))
                        ))
                ))
        ))
);

CREATE OR REPLACE FUNCTION public.preserve_selected_cancellation_request()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD."selectedLifecycleIntentSha256" IS NOT NULL THEN
            IF public.is_current_platform_admin() IS DISTINCT FROM TRUE OR NOT EXISTS (
                SELECT 1 FROM public."Tenant" WHERE "id" = OLD."tenantId"
                    AND "status"::text = 'PURGED' AND "deletedAt" IS NOT NULL AND "retentionLegalHoldAt" IS NULL
            ) THEN
                RAISE EXCEPTION 'Selected request deletion requires authorized tenant retention purge' USING ERRCODE = '23514';
            END IF;
        END IF;
        RETURN OLD;
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW."selectedLifecycleIntentSha256" IS NOT NULL OR NEW."selectedLifecycleOperationId" IS NOT NULL THEN
            RAISE EXCEPTION 'Selected request fence requires an existing recorded request' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD."selectedLifecycleIntentSha256" IS NOT NULL THEN
        IF ROW(NEW."id", NEW."tenantId", NEW."key", NEW."selectedLifecycleIntentSha256", NEW."selectedLifecycleOperationId")
            IS DISTINCT FROM ROW(OLD."id", OLD."tenantId", OLD."key", OLD."selectedLifecycleIntentSha256", OLD."selectedLifecycleOperationId") THEN
            RAISE EXCEPTION 'Selected request identity is immutable' USING ERRCODE = '23514';
        END IF;
        IF OLD."selectedLifecycleProviderIntentSha256" IS NULL AND NEW."selectedLifecycleProviderIntentSha256" IS NOT NULL THEN
            IF (OLD."value"->>'providerAttempts') IS DISTINCT FROM '0'
                OR (NEW."value"->>'providerAttempts') IS DISTINCT FROM '1'
                OR NEW."selectedLifecycleProviderLeaseUntil" IS NULL OR NEW."selectedLifecycleProviderLeaseUntil" <= clock_timestamp()
                OR NEW."selectedLifecycleProviderReceipt" IS NOT NULL
                OR (NEW."value" - ARRAY['providerAttempts','providerLeaseOwner','providerLeaseExpiresAt'])
                    IS DISTINCT FROM (OLD."value" - ARRAY['providerAttempts','providerLeaseOwner','providerLeaseExpiresAt']) THEN
                RAISE EXCEPTION 'Provider claim must consume the exact initial request once' USING ERRCODE = '23514';
            END IF;
        ELSIF (OLD."selectedLifecycleObservationFinalizationReceipt" IS NULL AND NEW."selectedLifecycleObservationFinalizationReceipt" IS NOT NULL)
            OR (OLD."selectedLifecycleObservationTerminalReceipt" IS NULL AND NEW."selectedLifecycleObservationTerminalReceipt" IS NOT NULL) THEN
            IF OLD."selectedLifecycleProviderIntentSha256" IS NULL
                OR COALESCE(OLD."value"->>'state', '') NOT IN ('PENDING_PROVIDER','FINALIZED')
                OR (NEW."value"->>'state') IS DISTINCT FROM 'FINALIZED'
                OR (NEW."value" - ARRAY['state','providerResult','providerMutationOwned'])
                    IS DISTINCT FROM (OLD."value" - ARRAY['state','providerResult','providerMutationOwned']) THEN
                RAISE EXCEPTION 'Only exact observation completion may change selected intent' USING ERRCODE = '23514';
            END IF;
        ELSIF OLD."selectedLifecycleTerminalReceipt" IS NULL AND NEW."selectedLifecycleTerminalReceipt" IS NOT NULL THEN
            IF OLD."selectedLifecycleProviderReceipt" IS NULL
                OR ((OLD."value"->>'state') IS DISTINCT FROM 'PENDING_PROVIDER' AND (OLD."value"->>'state') IS DISTINCT FROM 'FINALIZED')
                OR (NEW."value"->>'state') IS DISTINCT FROM 'FINALIZED'
                OR (NEW."value" - ARRAY['state','providerResult','providerMutationOwned'])
                    IS DISTINCT FROM (OLD."value" - ARRAY['state','providerResult','providerMutationOwned']) THEN
                RAISE EXCEPTION 'Only exact terminal convergence may change selected intent' USING ERRCODE = '23514';
            END IF;
        ELSIF OLD."selectedLifecycleFinalizationReceipt" IS NULL AND NEW."selectedLifecycleFinalizationReceipt" IS NOT NULL THEN
            IF OLD."selectedLifecycleProviderReceipt" IS NULL
                OR (OLD."value"->>'state') IS DISTINCT FROM 'PENDING_PROVIDER'
                OR (NEW."value"->>'state') IS DISTINCT FROM 'FINALIZED'
                OR (NEW."value" - ARRAY['state','providerResult','providerMutationOwned'])
                    IS DISTINCT FROM (OLD."value" - ARRAY['state','providerResult','providerMutationOwned']) THEN
                RAISE EXCEPTION 'Only exact receipt finalization may change selected intent' USING ERRCODE = '23514';
            END IF;
        ELSIF NEW."value" IS DISTINCT FROM OLD."value" THEN
            RAISE EXCEPTION 'Selected cancellation value cannot be reset or reclaimed' USING ERRCODE = '23514';
        END IF;
        IF OLD."selectedLifecycleProviderIntentSha256" IS NOT NULL THEN
            IF ROW(NEW."selectedLifecycleProviderIntentSha256", NEW."selectedLifecycleProviderCustomerId", NEW."selectedLifecycleProviderLeaseUntil")
                IS DISTINCT FROM ROW(OLD."selectedLifecycleProviderIntentSha256", OLD."selectedLifecycleProviderCustomerId", OLD."selectedLifecycleProviderLeaseUntil") THEN
                RAISE EXCEPTION 'Selected provider generation/resources/lease are immutable' USING ERRCODE = '23514';
            END IF;
            IF OLD."selectedLifecycleProviderReceipt" IS NULL AND NEW."selectedLifecycleProviderReceipt" IS NOT NULL THEN
                IF OLD."selectedLifecycleProviderLeaseUntil" <= clock_timestamp() THEN
                    RAISE EXCEPTION 'Selected provider receipt requires the original live lease' USING ERRCODE = '23514';
                END IF;
            ELSIF ROW(NEW."selectedLifecycleProviderReceipt", NEW."selectedLifecycleProviderRequestId", NEW."selectedLifecycleProviderCompletedAt")
                IS DISTINCT FROM ROW(OLD."selectedLifecycleProviderReceipt", OLD."selectedLifecycleProviderRequestId", OLD."selectedLifecycleProviderCompletedAt") THEN
                RAISE EXCEPTION 'Selected provider receipt is immutable' USING ERRCODE = '23514';
            END IF;
        END IF;
    ELSIF NEW."selectedLifecycleIntentSha256" IS NOT NULL THEN
        IF ROW(NEW."id", NEW."tenantId", NEW."key", NEW."value")
            IS DISTINCT FROM ROW(OLD."id", OLD."tenantId", OLD."key", OLD."value")
            OR NEW."selectedLifecycleProviderIntentSha256" IS NOT NULL THEN
            RAISE EXCEPTION 'Selected request fence must precede any provider claim' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

-- Original provider generation/resources/lease and receipt remain immutable, including after finalization.
