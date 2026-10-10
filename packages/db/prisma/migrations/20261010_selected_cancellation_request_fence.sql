-- Request-only stage. Provider claims/finalization require a separately reviewed successor.
ALTER TABLE public."TenantSetting"
    ADD COLUMN IF NOT EXISTS "selectedLifecycleIntentSha256" VARCHAR(64),
    ADD COLUMN IF NOT EXISTS "selectedLifecycleOperationId" VARCHAR(128);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
        WHERE conname = 'TenantSetting_selected_lifecycle_complete'
          AND conrelid = 'public."TenantSetting"'::regclass) THEN
        ALTER TABLE public."TenantSetting" ADD CONSTRAINT "TenantSetting_selected_lifecycle_complete" CHECK (
            ("selectedLifecycleIntentSha256" IS NULL AND "selectedLifecycleOperationId" IS NULL)
            OR ("selectedLifecycleIntentSha256" IS NOT NULL AND "selectedLifecycleOperationId" IS NOT NULL
                AND "selectedLifecycleIntentSha256" ~ '^[a-f0-9]{64}$'
                AND length("selectedLifecycleOperationId") BETWEEN 1 AND 128
                AND "key" = 'internal:tenant-lifecycle-intent:customer_cancellation'
                AND ("value"->>'tenantId') IS NOT DISTINCT FROM "tenantId"
                AND ("value"->>'operationId') IS NOT DISTINCT FROM "selectedLifecycleOperationId"
                AND ("value"->>'kind') IS NOT DISTINCT FROM 'CUSTOMER_CANCELLATION'
                AND ("value"->>'state') IS NOT DISTINCT FROM 'PENDING_PROVIDER'
                AND ("value"->>'providerAttempts') IS NOT DISTINCT FROM '0'
                AND ("value"->>'providerLeaseOwner') IS NULL
                AND ("value"->>'providerLeaseExpiresAt') IS NULL
                AND ("value"->>'providerResult') IS NULL)
        );
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.preserve_selected_cancellation_request()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD."selectedLifecycleIntentSha256" IS NOT NULL THEN
            -- Existing platform retention path owns eligibility/time/holds. This
            -- exception preserves its deletion, not arbitrary reset/recreate.
            IF public.is_current_platform_admin() IS DISTINCT FROM TRUE OR NOT EXISTS (
                SELECT 1 FROM public."Tenant" WHERE "id" = OLD."tenantId"
                    AND "status"::text = 'PURGED' AND "deletedAt" IS NOT NULL
                    AND "retentionLegalHoldAt" IS NULL
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
        IF ROW(NEW."id", NEW."tenantId", NEW."key", NEW."value", NEW."selectedLifecycleIntentSha256", NEW."selectedLifecycleOperationId")
            IS DISTINCT FROM ROW(OLD."id", OLD."tenantId", OLD."key", OLD."value", OLD."selectedLifecycleIntentSha256", OLD."selectedLifecycleOperationId") THEN
            RAISE EXCEPTION 'Selected cancellation request cannot be claimed, reset or replaced by an ordinary writer' USING ERRCODE = '23514';
        END IF;
    ELSIF NEW."selectedLifecycleIntentSha256" IS NOT NULL THEN
        IF ROW(NEW."id", NEW."tenantId", NEW."key", NEW."value")
            IS DISTINCT FROM ROW(OLD."id", OLD."tenantId", OLD."key", OLD."value") THEN
            RAISE EXCEPTION 'Selected request fence must bind the exact recorded predecessor' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS "TenantSetting_selected_cancellation_request_fence" ON public."TenantSetting";
CREATE TRIGGER "TenantSetting_selected_cancellation_request_fence"
BEFORE INSERT OR UPDATE OR DELETE ON public."TenantSetting"
FOR EACH ROW EXECUTE FUNCTION public.preserve_selected_cancellation_request();

-- No historical backfill or lifecycle/lease/counter reset. Existing RLS remains.
