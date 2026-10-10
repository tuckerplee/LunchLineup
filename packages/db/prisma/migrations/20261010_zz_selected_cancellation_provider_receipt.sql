-- Forward-only extension of the exact request0 fence; no historical SQL/backfill/reset.
ALTER TABLE public."TenantSetting"
    ADD COLUMN IF NOT EXISTS "selectedLifecycleProviderIntentSha256" VARCHAR(64),
    ADD COLUMN IF NOT EXISTS "selectedLifecycleProviderCustomerId" VARCHAR(255),
    ADD COLUMN IF NOT EXISTS "selectedLifecycleProviderLeaseUntil" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "selectedLifecycleProviderRequestId" VARCHAR(255),
    ADD COLUMN IF NOT EXISTS "selectedLifecycleProviderReceipt" JSONB,
    ADD COLUMN IF NOT EXISTS "selectedLifecycleProviderCompletedAt" TIMESTAMP(3);

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
        AND ("value"->>'state') IS NOT DISTINCT FROM 'PENDING_PROVIDER'
        AND ("value"->>'providerResult') IS NULL
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
END
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

-- Existing trigger invokes this replaced function, including guarded privacy deletion.
-- No local paid-through synchronization, finalization, lease release or retry is admitted.
