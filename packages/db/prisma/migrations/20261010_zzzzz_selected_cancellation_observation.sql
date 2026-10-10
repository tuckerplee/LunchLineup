-- Forward-only separate observation custody. No original provider field is changed.
CREATE TABLE IF NOT EXISTS public."TenantCancellationObservation" (
    "id" TEXT PRIMARY KEY CHECK ("id" ~ '^[ -~]{1,128}$'),
    "tenantId" TEXT NOT NULL REFERENCES public."Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    "operationId" TEXT NOT NULL CHECK ("operationId" ~ '^[ -~]{1,128}$'),
    "requestIntentSha256" TEXT NOT NULL CHECK ("requestIntentSha256" ~ '^[a-f0-9]{64}$'),
    "providerIntentSha256" TEXT NOT NULL CHECK ("providerIntentSha256" ~ '^[a-f0-9]{64}$'),
    "observationIntentSha256" TEXT NOT NULL UNIQUE CHECK ("observationIntentSha256" ~ '^[a-f0-9]{64}$'),
    "customerId" TEXT NOT NULL CHECK ("customerId" ~ '^cus_[A-Za-z0-9]{1,251}$'),
    "subscriptionId" TEXT NOT NULL CHECK ("subscriptionId" ~ '^sub_[A-Za-z0-9]{1,251}$'),
    "priorReceiptSha256" TEXT CHECK ("priorReceiptSha256" ~ '^[a-f0-9]{64}$'),
    "processFence" JSONB NOT NULL,
    "original" JSONB NOT NULL,
    "leaseOwner" TEXT NOT NULL,
    "leaseUntil" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL CHECK ("attempts" = 1),
    "receipt" JSONB,
    "billingRevision" INTEGER CHECK ("billingRevision" >= 0),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "TenantCancellationObservation_provider_once" UNIQUE ("tenantId", "providerIntentSha256"),
    CONSTRAINT "TenantCancellationObservation_complete" CHECK (
        ("receipt" IS NULL AND "billingRevision" IS NULL AND "completedAt" IS NULL)
        OR ("receipt" IS NOT NULL AND "billingRevision" IS NOT NULL AND "completedAt" IS NOT NULL))
);
ALTER TABLE public."TenantCancellationObservation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."TenantCancellationObservation" FORCE ROW LEVEL SECURITY;
CREATE POLICY cancellation_observation_tenant_policy ON public."TenantCancellationObservation"
USING (public.is_current_platform_admin() OR "tenantId" = (SELECT public.get_current_tenant()))
WITH CHECK (public.is_current_platform_admin() OR "tenantId" = (SELECT public.get_current_tenant()));

-- Storage correspondence only. Original process signatures and fixed provider GET
-- provenance are checked by the private selected consumer; SQL does not invent them.
CREATE OR REPLACE FUNCTION public.guard_selected_cancellation_observation()
RETURNS TRIGGER AS $$
DECLARE tenant_row public."Tenant"%ROWTYPE; setting_row public."TenantSetting"%ROWTYPE;
    expected_original JSONB; provider JSONB; snapshot JSONB;
BEGIN
    IF TG_OP = 'DELETE' THEN
        SELECT * INTO STRICT tenant_row FROM public."Tenant" WHERE "id" = OLD."tenantId" FOR UPDATE NOWAIT;
        IF public.is_current_platform_admin() IS DISTINCT FROM TRUE OR tenant_row."status"::text IS DISTINCT FROM 'PURGED'
            OR tenant_row."deletedAt" IS NULL OR tenant_row."retentionLegalHoldAt" IS NOT NULL THEN
            RAISE EXCEPTION 'Observation deletion requires authorized privacy purge' USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE' AND (
        OLD."receipt" IS NOT NULL OR NEW."receipt" IS NULL
        OR (to_jsonb(NEW) - ARRAY['receipt', 'billingRevision', 'completedAt'])
            IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['receipt', 'billingRevision', 'completedAt'])
    ) THEN
        RAISE EXCEPTION 'Observation custody is immutable and one-use' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' AND (NEW."receipt" IS NOT NULL OR NEW."billingRevision" IS NOT NULL OR NEW."completedAt" IS NOT NULL) THEN
        RAISE EXCEPTION 'Observation must first commit its empty claim' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO STRICT tenant_row FROM public."Tenant" WHERE "id" = NEW."tenantId" FOR UPDATE NOWAIT;
    SELECT * INTO STRICT setting_row FROM public."TenantSetting" WHERE "tenantId" = NEW."tenantId"
        AND "key" = 'internal:tenant-lifecycle-intent:customer_cancellation' FOR UPDATE NOWAIT;
    expected_original := jsonb_build_object('value', setting_row."value", 'requestIntentSha256', setting_row."selectedLifecycleIntentSha256",
        'operationId', setting_row."selectedLifecycleOperationId", 'providerIntentSha256', setting_row."selectedLifecycleProviderIntentSha256",
        'customerId', setting_row."selectedLifecycleProviderCustomerId",
        'providerLeaseUntil', to_char(setting_row."selectedLifecycleProviderLeaseUntil", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'providerReceipt', setting_row."selectedLifecycleProviderReceipt", 'providerBillingRevision', setting_row."selectedLifecycleProviderBillingRevision",
        'finalizationReceipt', setting_row."selectedLifecycleFinalizationReceipt", 'terminalReceipt', setting_row."selectedLifecycleTerminalReceipt");
    IF tenant_row."deletedAt" IS NOT NULL OR tenant_row."status"::text IN ('PURGED', 'SUSPENDED')
        OR tenant_row."stripeCustomerId" IS DISTINCT FROM NEW."customerId"
        OR NOT (tenant_row."stripeSubscriptionId" IS NOT DISTINCT FROM NEW."subscriptionId"
            OR (tenant_row."status"::text = 'CANCELLED' AND tenant_row."stripeSubscriptionId" IS NULL
                AND tenant_row."stripeSubscriptionCurrentPeriodEnd" IS NULL))
        OR NEW."original" IS DISTINCT FROM expected_original
        OR NEW."requestIntentSha256" IS DISTINCT FROM setting_row."selectedLifecycleIntentSha256"
        OR NEW."providerIntentSha256" IS DISTINCT FROM setting_row."selectedLifecycleProviderIntentSha256"
        OR NEW."operationId" IS DISTINCT FROM setting_row."selectedLifecycleOperationId"
        OR NEW."customerId" IS DISTINCT FROM setting_row."selectedLifecycleProviderCustomerId"
        OR (setting_row."value"->>'tenantId') IS DISTINCT FROM NEW."tenantId"
        OR (setting_row."value"->>'operationId') IS DISTINCT FROM NEW."operationId"
        OR (setting_row."value"->>'kind') IS DISTINCT FROM 'CUSTOMER_CANCELLATION'
        OR COALESCE(setting_row."value"->>'state', '') NOT IN ('PENDING_PROVIDER', 'FINALIZED')
        OR (setting_row."value"->>'providerAttempts') IS DISTINCT FROM '1'
        OR (setting_row."value"->>'providerSubscriptionId') IS DISTINCT FROM NEW."subscriptionId"
        OR (setting_row."value"->>'providerLeaseOwner') IS NULL
        OR (setting_row."value"->>'providerLeaseExpiresAt') IS NULL
        OR setting_row."selectedLifecycleProviderLeaseUntil" IS NULL
        OR ((setting_row."value"->>'providerLeaseExpiresAt')::timestamp)
            IS DISTINCT FROM setting_row."selectedLifecycleProviderLeaseUntil"
        OR (setting_row."value"->>'compensationResult') IS NOT NULL
        OR (setting_row."value"->>'state' = 'PENDING_PROVIDER' AND setting_row."value"->>'providerResult' IS NOT NULL)
        OR (NEW."priorReceiptSha256" IS NULL) IS DISTINCT FROM (setting_row."selectedLifecycleProviderReceipt" IS NULL)
        OR (NEW."processFence"->>'applicationProcessSettled') IS DISTINCT FROM 'true'
        OR (NEW."processFence"->>'backendSettlementProved') IS DISTINCT FROM 'false'
        OR (NEW."processFence"->>'retryAllowed') IS DISTINCT FROM 'false'
        OR COALESCE(NEW."processFence"->>'evidenceSha256', '') !~ '^[a-f0-9]{64}$'
        OR COALESCE(NEW."processFence"->>'historySha256', '') !~ '^[a-f0-9]{64}$'
        OR COALESCE(NEW."processFence"->>'recoveryFenceSha256', '') !~ '^[a-f0-9]{64}$'
        OR NEW."leaseUntil" <= clock_timestamp() OR NEW."attempts" IS DISTINCT FROM 1
        OR length(NEW."leaseOwner") < 1 OR NEW."id" = NEW."operationId"
        OR EXISTS (SELECT 1 FROM public."TenantSetting" WHERE "tenantId" = NEW."tenantId"
            AND "key" = 'internal:tenant-lifecycle-intent:platform_archive') THEN
        RAISE EXCEPTION 'Exact original cancellation observation custody required' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        provider := NEW."receipt"->'provider';
        snapshot := jsonb_build_object('status', tenant_row."status"::text,
            'customerId', tenant_row."stripeCustomerId", 'subscriptionId', tenant_row."stripeSubscriptionId",
            'currentPeriodEnd', CASE WHEN tenant_row."stripeSubscriptionCurrentPeriodEnd" IS NULL THEN NULL
                ELSE to_char(tenant_row."stripeSubscriptionCurrentPeriodEnd", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
            'billingRevision', tenant_row."selectedBillingRevision");
        IF NEW."billingRevision" IS DISTINCT FROM tenant_row."selectedBillingRevision" OR NEW."completedAt" IS NULL
            OR (NEW."receipt"->>'version') IS DISTINCT FROM '1'
            OR COALESCE(NEW."receipt"->>'originalSha256', '') !~ '^[a-f0-9]{64}$'
            OR (NEW."receipt"->>'tenantId') IS DISTINCT FROM NEW."tenantId"
            OR (NEW."receipt"->>'operationId') IS DISTINCT FROM NEW."operationId"
            OR (NEW."receipt"->>'observationId') IS DISTINCT FROM NEW."id"
            OR (NEW."receipt"->>'observationIntentSha256') IS DISTINCT FROM NEW."observationIntentSha256"
            OR (NEW."receipt"->>'requestIntentSha256') IS DISTINCT FROM NEW."requestIntentSha256"
            OR (NEW."receipt"->>'providerIntentSha256') IS DISTINCT FROM NEW."providerIntentSha256"
            OR (NEW."receipt"->>'priorReceiptSha256') IS DISTINCT FROM NEW."priorReceiptSha256"
            OR (NEW."receipt"->'processFence') IS DISTINCT FROM NEW."processFence"
            OR (NEW."receipt"->'snapshot') IS DISTINCT FROM snapshot
            OR (NEW."receipt"->>'backendSettlementProved') IS DISTINCT FROM 'false'
            OR (NEW."receipt"->>'retryAllowed') IS DISTINCT FROM 'false'
            OR (provider->>'tenantId') IS DISTINCT FROM NEW."tenantId"
            OR (provider->>'operationId') IS DISTINCT FROM NEW."operationId"
            OR (provider->>'customerId') IS DISTINCT FROM NEW."customerId"
            OR (provider->'outcome'->>'stripeSubscriptionId') IS DISTINCT FROM NEW."subscriptionId"
            OR COALESCE(provider->>'providerRequestId', '') = ''
            OR COALESCE(provider->>'disposition', '') NOT IN ('OBSERVED_OWNED_CANCELLATION', 'OBSERVED_UNOWNED_OR_NOT_CANCELING')
            OR (provider->>'backendSettlementProved') IS DISTINCT FROM 'false'
            OR (provider->>'retryAllowed') IS DISTINCT FROM 'false' THEN
            RAISE EXCEPTION 'Exact separate observation receipt required' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;
CREATE TRIGGER "TenantCancellationObservation_guard"
BEFORE INSERT OR UPDATE OR DELETE ON public."TenantCancellationObservation"
FOR EACH ROW EXECUTE FUNCTION public.guard_selected_cancellation_observation();
