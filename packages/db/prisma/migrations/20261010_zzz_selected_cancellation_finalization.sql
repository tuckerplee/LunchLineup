-- Forward-only exact local finalization. No historical receipt snapshot backfill.
ALTER TABLE public."Tenant" ADD COLUMN IF NOT EXISTS "selectedBillingRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public."TenantSetting"
    ADD COLUMN IF NOT EXISTS "selectedLifecycleProviderBillingRevision" INTEGER,
    ADD COLUMN IF NOT EXISTS "selectedLifecycleFinalizationIntentSha256" VARCHAR(64),
    ADD COLUMN IF NOT EXISTS "selectedLifecycleFinalizationReceipt" JSONB;

-- This covers old binaries, Prisma and raw SQL writers alike. No caller can choose/reset a revision.
CREATE OR REPLACE FUNCTION public.advance_selected_billing_revision()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."selectedBillingRevision" IS DISTINCT FROM 0::integer THEN
            RAISE EXCEPTION 'Initial billing revision is database owned' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW."selectedBillingRevision" IS DISTINCT FROM OLD."selectedBillingRevision" THEN
        RAISE EXCEPTION 'Billing revision is database owned' USING ERRCODE = '23514';
    END IF;
    -- Deliberately conservative: every Tenant UPDATE invalidates an unconsumed snapshot,
    -- including no-op updates used by the BillingEvent ordering trigger below.
    NEW."selectedBillingRevision" := OLD."selectedBillingRevision" + 1;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;
CREATE TRIGGER "Tenant_selected_billing_revision"
BEFORE INSERT OR UPDATE ON public."Tenant"
FOR EACH ROW EXECUTE FUNCTION public.advance_selected_billing_revision();

-- BillingEvent is also the webhook ordering ledger. Even an event that leaves all
-- Tenant values unchanged invalidates prior receipt chronology. Cover inserts,
-- updates and authorized retention deletes, including old/raw writers.
CREATE OR REPLACE FUNCTION public.invalidate_selected_receipt_on_billing_event()
RETURNS TRIGGER AS $$
DECLARE tenant_ids TEXT[]; target_id TEXT;
BEGIN
    IF TG_OP = 'INSERT' THEN tenant_ids := ARRAY[NEW."tenantId"];
    ELSIF TG_OP = 'DELETE' THEN tenant_ids := ARRAY[OLD."tenantId"];
    ELSE tenant_ids := ARRAY[OLD."tenantId", NEW."tenantId"];
    END IF;
    FOR target_id IN SELECT DISTINCT id FROM unnest(tenant_ids) AS ids(id) WHERE id IS NOT NULL ORDER BY id LOOP
        -- Do not introduce a BillingEvent -> waiting-Tenant lock inversion.
        PERFORM "id" FROM public."Tenant" WHERE "id" = target_id FOR UPDATE NOWAIT;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Billing event invalidation requires its visible retained tenant' USING ERRCODE = '23514';
        END IF;
        UPDATE public."Tenant" SET "selectedBillingRevision" = "selectedBillingRevision" WHERE "id" = target_id;
    END LOOP;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;
CREATE TRIGGER "BillingEvent_selected_cancellation_revision"
AFTER INSERT OR UPDATE OR DELETE ON public."BillingEvent"
FOR EACH ROW EXECUTE FUNCTION public.invalidate_selected_receipt_on_billing_event();

-- Runs before the existing selected-request trigger by lexical trigger name.
-- Taking a Tenant row lock at capture prevents a concurrent billing write crossing the snapshot.
CREATE OR REPLACE FUNCTION public.capture_selected_cancellation_revision()
RETURNS TRIGGER AS $$
DECLARE current_revision INTEGER;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."selectedLifecycleProviderBillingRevision" IS NOT NULL
            OR NEW."selectedLifecycleFinalizationIntentSha256" IS NOT NULL
            OR NEW."selectedLifecycleFinalizationReceipt" IS NOT NULL THEN
            RAISE EXCEPTION 'Selected receipt metadata requires existing custody' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD."selectedLifecycleProviderReceipt" IS NULL AND NEW."selectedLifecycleProviderReceipt" IS NOT NULL THEN
        IF OLD."selectedLifecycleProviderBillingRevision" IS NOT NULL
            OR NEW."selectedLifecycleProviderBillingRevision" IS NOT NULL THEN
            RAISE EXCEPTION 'Provider billing revision cannot be supplied' USING ERRCODE = '23514';
        END IF;
        SELECT "selectedBillingRevision" INTO STRICT current_revision FROM public."Tenant"
            WHERE "id" = NEW."tenantId" FOR UPDATE NOWAIT;
        NEW."selectedLifecycleProviderBillingRevision" := current_revision;
    ELSIF NEW."selectedLifecycleProviderBillingRevision" IS DISTINCT FROM OLD."selectedLifecycleProviderBillingRevision" THEN
        RAISE EXCEPTION 'Captured billing revision cannot be backfilled or changed' USING ERRCODE = '23514';
    END IF;
    IF OLD."selectedLifecycleFinalizationReceipt" IS NULL AND NEW."selectedLifecycleFinalizationReceipt" IS NOT NULL THEN
        SELECT "selectedBillingRevision" INTO STRICT current_revision FROM public."Tenant"
            WHERE "id" = NEW."tenantId" FOR UPDATE NOWAIT;
        IF OLD."selectedLifecycleProviderReceipt" IS NULL OR OLD."selectedLifecycleProviderBillingRevision" IS NULL
            OR OLD."selectedLifecycleProviderBillingRevision" IS DISTINCT FROM current_revision
            OR OLD."selectedLifecycleFinalizationIntentSha256" IS NOT NULL
            OR (OLD."value"->>'state') IS DISTINCT FROM 'PENDING_PROVIDER'
            OR (NEW."value"->>'state') IS DISTINCT FROM 'FINALIZED' THEN
            RAISE EXCEPTION 'Finalization requires an unchanged exact captured receipt' USING ERRCODE = '23514';
        END IF;
    ELSIF ROW(NEW."selectedLifecycleFinalizationIntentSha256", NEW."selectedLifecycleFinalizationReceipt")
        IS DISTINCT FROM ROW(OLD."selectedLifecycleFinalizationIntentSha256", OLD."selectedLifecycleFinalizationReceipt") THEN
        RAISE EXCEPTION 'Selected local finalization is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;
CREATE TRIGGER "TenantSetting_selected_cancellation_0_revision"
BEFORE INSERT OR UPDATE ON public."TenantSetting"
FOR EACH ROW EXECUTE FUNCTION public.capture_selected_cancellation_revision();

ALTER TABLE public."TenantSetting" ADD CONSTRAINT "TenantSetting_selected_finalization_complete" CHECK (
    ("selectedLifecycleFinalizationIntentSha256" IS NULL AND "selectedLifecycleFinalizationReceipt" IS NULL
        AND ("selectedLifecycleIntentSha256" IS NULL OR ("value"->>'state') IS DISTINCT FROM 'FINALIZED'))
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
                AND "selectedLifecycleFinalizationReceipt" IS NOT NULL
                AND ("value"->'providerResult') IS NOT DISTINCT FROM jsonb_build_object(
                    'action', "selectedLifecycleProviderReceipt"->'outcome'->'action',
                    'cancelAtPeriodEnd', "selectedLifecycleProviderReceipt"->'outcome'->'cancelAtPeriodEnd',
                    'currentPeriodEnd', "selectedLifecycleProviderReceipt"->'outcome'->'currentPeriodEnd',
                    'cancelAt', "selectedLifecycleProviderReceipt"->'outcome'->'cancelAt',
                    'canceledAt', "selectedLifecycleProviderReceipt"->'outcome'->'canceledAt',
                    'cancellationBehavior', 'cancel_at_period_end')
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
