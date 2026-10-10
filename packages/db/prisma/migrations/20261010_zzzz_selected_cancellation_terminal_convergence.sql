-- Forward-only authenticated terminal application evidence; no historical backfill.
CREATE TABLE IF NOT EXISTS public."TenantCancellationTerminalEvent" (
    "eventId" TEXT PRIMARY KEY REFERENCES public."BillingEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "tenantId" TEXT NOT NULL REFERENCES public."Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    "receipt" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "TenantCancellationTerminalEvent_tenantId_idx" ON public."TenantCancellationTerminalEvent"("tenantId");
ALTER TABLE public."TenantCancellationTerminalEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."TenantCancellationTerminalEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY terminal_cancellation_event_tenant_policy ON public."TenantCancellationTerminalEvent"
USING (public.is_current_platform_admin() OR "tenantId" = (SELECT public.get_current_tenant()))
WITH CHECK (public.is_current_platform_admin() OR "tenantId" = (SELECT public.get_current_tenant()));

-- These guards validate atomic storage correspondence, not an invented SQL verified:true.
-- Signature provenance is minted only by the module-private verified-ingress capability.
CREATE OR REPLACE FUNCTION public.guard_terminal_cancellation_application()
RETURNS TRIGGER AS $$
DECLARE event_row public."BillingEvent"%ROWTYPE; tenant_row public."Tenant"%ROWTYPE;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'Terminal application evidence is immutable' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'DELETE' THEN
        -- Parent event mutation invalidates evidence; explicit privacy removal retains its existing boundary.
        IF pg_trigger_depth() <= 1 AND (public.is_current_platform_admin() IS DISTINCT FROM TRUE OR NOT EXISTS (
            SELECT 1 FROM public."Tenant" WHERE "id" = OLD."tenantId" AND "status"::text = 'PURGED'
                AND "deletedAt" IS NOT NULL AND "retentionLegalHoldAt" IS NULL
        )) THEN
            RAISE EXCEPTION 'Terminal evidence deletion requires event invalidation or authorized privacy purge' USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
    END IF;
    SELECT * INTO STRICT tenant_row FROM public."Tenant" WHERE "id" = NEW."tenantId" FOR UPDATE NOWAIT;
    SELECT * INTO STRICT event_row FROM public."BillingEvent" WHERE "id" = NEW."eventId" AND "tenantId" = NEW."tenantId" FOR UPDATE NOWAIT;
    IF event_row."type" IS DISTINCT FROM 'customer.subscription.deleted' OR event_row."stripeEventId" IS NULL
        OR (event_row."metadata"->>'sideEffectDisposition') IS DISTINCT FROM 'applied'
        OR (event_row."metadata"->>'stripeEventLivemode') IS DISTINCT FROM 'false'
        OR (event_row."metadata"->>'status') IS DISTINCT FROM 'canceled'
        OR (NEW."receipt"->>'version') IS DISTINCT FROM '1'
        OR (NEW."receipt"->>'provenance') IS DISTINCT FROM 'verified-stripe-terminal-webhook-v1'
        OR (NEW."receipt"->>'providerEventId') IS DISTINCT FROM event_row."stripeEventId"
        OR (NEW."receipt"->>'tenantId') IS DISTINCT FROM NEW."tenantId"
        OR (NEW."receipt"->>'operationId') IS NULL
        OR (NEW."receipt"->>'operationId') IS DISTINCT FROM (event_row."metadata"->>'cancellationOperationId')
        OR (NEW."receipt"->>'customerId') IS DISTINCT FROM (event_row."metadata"->>'customerId')
        OR (NEW."receipt"->>'subscriptionId') IS DISTINCT FROM (event_row."metadata"->>'subscriptionId')
        OR (NEW."receipt"->>'livemode') IS DISTINCT FROM 'false'
        OR (NEW."receipt"->>'accountMode') IS DISTINCT FROM 'direct'
        OR (NEW."receipt"->>'apiVersion') IS DISTINCT FROM '2024-04-10'
        OR (NEW."receipt"->'outcome'->>'action') IS DISTINCT FROM 'already_canceled'
        OR (NEW."receipt"->'postState') IS DISTINCT FROM jsonb_build_object(
            'status', 'CANCELLED', 'deletedAt', NULL, 'customerId', tenant_row."stripeCustomerId",
            'subscriptionId', NULL, 'currentPeriodEnd', NULL, 'billingRevision', tenant_row."selectedBillingRevision")
        OR tenant_row."status"::text IS DISTINCT FROM 'CANCELLED' OR tenant_row."deletedAt" IS NOT NULL
        OR tenant_row."stripeSubscriptionId" IS NOT NULL OR tenant_row."stripeSubscriptionCurrentPeriodEnd" IS NOT NULL
        OR (NEW."receipt"->>'customerId') IS DISTINCT FROM tenant_row."stripeCustomerId"
        OR NOT EXISTS (SELECT 1 FROM public."TenantSetting" WHERE "tenantId" = NEW."tenantId"
            AND "key" = 'internal:tenant-lifecycle-intent:customer_cancellation'
            AND ("value"->>'kind') = 'CUSTOMER_CANCELLATION'
            AND ("value"->>'operationId') = (NEW."receipt"->>'operationId')
            AND ("value"->>'providerSubscriptionId') = (NEW."receipt"->>'subscriptionId')) THEN
        RAISE EXCEPTION 'Exact committed terminal application correspondence required' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;
CREATE TRIGGER "TenantCancellationTerminalEvent_guard"
BEFORE INSERT OR UPDATE OR DELETE ON public."TenantCancellationTerminalEvent"
FOR EACH ROW EXECUTE FUNCTION public.guard_terminal_cancellation_application();

CREATE OR REPLACE FUNCTION public.invalidate_terminal_cancellation_application()
RETURNS TRIGGER AS $$
BEGIN
    -- NOWAIT prevents event-row -> waiting-receipt inversions. Missing evidence remains absent.
    PERFORM "eventId" FROM public."TenantCancellationTerminalEvent" WHERE "eventId" = OLD."id" FOR UPDATE NOWAIT;
    DELETE FROM public."TenantCancellationTerminalEvent" WHERE "eventId" = OLD."id";
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;
CREATE TRIGGER "BillingEvent_invalidate_terminal_application"
BEFORE UPDATE OR DELETE ON public."BillingEvent"
FOR EACH ROW EXECUTE FUNCTION public.invalidate_terminal_cancellation_application();

ALTER TABLE public."TenantSetting"
    ADD COLUMN IF NOT EXISTS "selectedLifecycleTerminalIntentSha256" VARCHAR(64),
    ADD COLUMN IF NOT EXISTS "selectedLifecycleTerminalReceipt" JSONB;
ALTER TABLE public."TenantSetting" ADD CONSTRAINT "TenantSetting_terminal_convergence_complete" CHECK (
    ("selectedLifecycleTerminalIntentSha256" IS NULL AND "selectedLifecycleTerminalReceipt" IS NULL)
    OR ("selectedLifecycleTerminalIntentSha256" IS NOT NULL AND "selectedLifecycleTerminalIntentSha256" ~ '^[a-f0-9]{64}$'
        AND "selectedLifecycleTerminalReceipt" IS NOT NULL AND jsonb_typeof("selectedLifecycleTerminalReceipt") = 'object'
        AND "selectedLifecycleIntentSha256" IS NOT NULL AND "selectedLifecycleProviderIntentSha256" IS NOT NULL
        AND "selectedLifecycleProviderReceipt" IS NOT NULL AND "selectedLifecycleProviderBillingRevision" IS NOT NULL
        AND ("selectedLifecycleProviderReceipt"->'outcome'->>'providerMutationOwned') IS NOT DISTINCT FROM 'true'
        AND ("selectedLifecycleTerminalReceipt"->>'tenantId') IS NOT DISTINCT FROM "tenantId"
        AND ("selectedLifecycleTerminalReceipt"->>'operationId') IS NOT DISTINCT FROM "selectedLifecycleOperationId"
        AND ("selectedLifecycleTerminalReceipt"->>'requestIntentSha256') IS NOT DISTINCT FROM "selectedLifecycleIntentSha256"
        AND ("selectedLifecycleTerminalReceipt"->>'providerIntentSha256') IS NOT DISTINCT FROM "selectedLifecycleProviderIntentSha256"
        AND ("selectedLifecycleTerminalReceipt"->>'state') IS NOT DISTINCT FROM 'FINALIZED'
        AND ("selectedLifecycleTerminalReceipt"->'outcome'->>'action') IS NOT DISTINCT FROM 'already_canceled'
        AND ("value"->>'state') IS NOT DISTINCT FROM 'FINALIZED'
        AND ("value"->'providerResult') IS NOT DISTINCT FROM ("selectedLifecycleTerminalReceipt"->'outcome')
        AND ("value"->>'providerMutationOwned') IS NOT DISTINCT FROM 'true'
        AND ("selectedLifecycleTerminalReceipt"->>'providerReceiptSha256') IS NOT NULL
        AND ("selectedLifecycleTerminalReceipt"->>'providerReceiptSha256') ~ '^[a-f0-9]{64}$'
        AND ("selectedLifecycleTerminalReceipt"->>'applicationReceiptSha256') IS NOT NULL
        AND ("selectedLifecycleTerminalReceipt"->>'applicationReceiptSha256') ~ '^[a-f0-9]{64}$'
    )
);

CREATE OR REPLACE FUNCTION public.guard_selected_terminal_convergence()
RETURNS TRIGGER AS $$
DECLARE tenant_row public."Tenant"%ROWTYPE; application_row public."TenantCancellationTerminalEvent"%ROWTYPE;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."selectedLifecycleTerminalIntentSha256" IS NOT NULL OR NEW."selectedLifecycleTerminalReceipt" IS NOT NULL THEN
            RAISE EXCEPTION 'Terminal convergence requires an existing selected request' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD."selectedLifecycleTerminalReceipt" IS NULL AND NEW."selectedLifecycleTerminalReceipt" IS NOT NULL THEN
        SELECT * INTO STRICT tenant_row FROM public."Tenant" WHERE "id" = NEW."tenantId" FOR UPDATE NOWAIT;
        -- Match application's ordering: parent event before the invalidatable receipt.
        PERFORM "id" FROM public."BillingEvent" WHERE "id" = (NEW."selectedLifecycleTerminalReceipt"->>'eventId')
            AND "tenantId" = NEW."tenantId" FOR UPDATE NOWAIT;
        IF NOT FOUND THEN RAISE EXCEPTION 'Terminal parent event is absent' USING ERRCODE = '23514'; END IF;
        SELECT * INTO STRICT application_row FROM public."TenantCancellationTerminalEvent"
            WHERE "eventId" = (NEW."selectedLifecycleTerminalReceipt"->>'eventId') AND "tenantId" = NEW."tenantId" FOR UPDATE NOWAIT;
        IF OLD."selectedLifecycleTerminalIntentSha256" IS NOT NULL
            OR OLD."selectedLifecycleProviderReceipt" IS NULL OR OLD."selectedLifecycleProviderBillingRevision" IS NULL
            OR ((OLD."value"->>'state') IS DISTINCT FROM 'PENDING_PROVIDER' AND (OLD."value"->>'state') IS DISTINCT FROM 'FINALIZED')
            OR (NEW."value"->>'state') IS DISTINCT FROM 'FINALIZED'
            OR ((OLD."selectedLifecycleProviderReceipt"->'outcome'->>'action') IS DISTINCT FROM 'scheduled' AND (OLD."selectedLifecycleProviderReceipt"->'outcome'->>'action') IS DISTINCT FROM 'already_scheduled')
            OR (NEW."selectedLifecycleTerminalReceipt"->'applicationReceipt') IS DISTINCT FROM jsonb_build_object(
                'eventId', application_row."eventId", 'tenantId', application_row."tenantId", 'receipt', application_row."receipt")
            OR (NEW."selectedLifecycleTerminalReceipt"->'outcome') IS DISTINCT FROM (application_row."receipt"->'outcome')
            OR (application_row."receipt"->>'operationId') IS DISTINCT FROM OLD."selectedLifecycleOperationId"
            OR (application_row."receipt"->>'customerId') IS DISTINCT FROM OLD."selectedLifecycleProviderCustomerId"
            OR (application_row."receipt"->>'subscriptionId') IS DISTINCT FROM (OLD."value"->>'providerSubscriptionId')
            OR (application_row."receipt"->'postState'->>'billingRevision') IS DISTINCT FROM tenant_row."selectedBillingRevision"::text
            OR tenant_row."selectedBillingRevision" <= OLD."selectedLifecycleProviderBillingRevision"
            OR tenant_row."status"::text IS DISTINCT FROM 'CANCELLED' OR tenant_row."deletedAt" IS NOT NULL
            OR tenant_row."stripeSubscriptionId" IS NOT NULL OR tenant_row."stripeSubscriptionCurrentPeriodEnd" IS NOT NULL
            OR tenant_row."stripeCustomerId" IS DISTINCT FROM OLD."selectedLifecycleProviderCustomerId"
            OR EXISTS (SELECT 1 FROM public."TenantSetting" WHERE "tenantId" = NEW."tenantId"
                AND "key" = 'internal:tenant-lifecycle-intent:platform_archive') THEN
            RAISE EXCEPTION 'Exact current terminal application evidence required' USING ERRCODE = '23514';
        END IF;
    ELSIF ROW(NEW."selectedLifecycleTerminalIntentSha256", NEW."selectedLifecycleTerminalReceipt")
        IS DISTINCT FROM ROW(OLD."selectedLifecycleTerminalIntentSha256", OLD."selectedLifecycleTerminalReceipt") THEN
        RAISE EXCEPTION 'Selected terminal convergence is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;
CREATE TRIGGER "TenantSetting_selected_cancellation_1_terminal"
BEFORE INSERT OR UPDATE ON public."TenantSetting"
FOR EACH ROW EXECUTE FUNCTION public.guard_selected_terminal_convergence();

ALTER TABLE public."TenantSetting" DROP CONSTRAINT IF EXISTS "TenantSetting_selected_finalization_complete";
ALTER TABLE public."TenantSetting" ADD CONSTRAINT "TenantSetting_selected_finalization_complete" CHECK (
    ("selectedLifecycleFinalizationIntentSha256" IS NULL AND "selectedLifecycleFinalizationReceipt" IS NULL
        AND ("selectedLifecycleIntentSha256" IS NULL OR ("value"->>'state') IS DISTINCT FROM 'FINALIZED'
            OR "selectedLifecycleTerminalReceipt" IS NOT NULL))
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
