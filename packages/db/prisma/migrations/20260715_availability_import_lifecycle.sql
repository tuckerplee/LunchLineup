-- Complete availability-import identity, deletion, refund, and retention state.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE public."AvailabilityImportJob"
  DROP CONSTRAINT IF EXISTS "AvailabilityImportJob_result_check";
ALTER TABLE public."AvailabilityImportJob"
  DROP CONSTRAINT IF EXISTS "AvailabilityImportJob_terminal_time_check";

-- Recreate the enum only when an older database has not received CANCELLED yet.
-- This avoids PostgreSQL's same-transaction restriction on newly added enum values.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum value
    JOIN pg_type type ON type.oid = value.enumtypid
    JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
    WHERE namespace.nspname = 'public'
      AND type.typname = 'AvailabilityImportStatus'
      AND value.enumlabel = 'CANCELLED'
  ) THEN
    ALTER TABLE public."AvailabilityImportJob"
      ALTER COLUMN "status" DROP DEFAULT;
    ALTER TYPE public."AvailabilityImportStatus"
      RENAME TO "AvailabilityImportStatus_before_lifecycle";
    CREATE TYPE public."AvailabilityImportStatus" AS ENUM (
      'PENDING', 'QUEUED', 'RUNNING', 'RETRYING',
      'SUCCEEDED', 'FAILED', 'DEAD_LETTERED', 'CANCELLED'
    );
    ALTER TABLE public."AvailabilityImportJob"
      ALTER COLUMN "status" TYPE public."AvailabilityImportStatus"
      USING "status"::text::public."AvailabilityImportStatus";
    ALTER TABLE public."AvailabilityImportJob"
      ALTER COLUMN "status" SET DEFAULT 'PENDING';
    DROP TYPE public."AvailabilityImportStatus_before_lifecycle";
  END IF;
END
$$;

ALTER TABLE public."AvailabilityImportJob"
  ADD COLUMN IF NOT EXISTS "targetIdentityHash" TEXT;
ALTER TABLE public."AvailabilityImportJob"
  ADD COLUMN IF NOT EXISTS "resultErasedAt" TIMESTAMP(3);

UPDATE public."AvailabilityImportJob" job
SET "targetIdentityHash" = encode(
  public.digest(
    lower(
      CASE
        WHEN btrim(target."username") ~ '^[-A-Za-z0-9._:@+]{1,128}$'
          THEN btrim(target."username")
        ELSE target."id"
      END
    ),
    'sha256'
  ),
  'hex'
)
FROM public."User" target
WHERE target."id" = job."userId"
  AND target."tenantId" = job."tenantId"
  AND (
    job."targetIdentityHash" IS NULL
    OR job."targetIdentityHash" !~ '^[a-f0-9]{64}$'
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public."AvailabilityImportJob"
    WHERE "targetIdentityHash" IS NULL
       OR "targetIdentityHash" !~ '^[a-f0-9]{64}$'
  ) THEN
    RAISE EXCEPTION 'Cannot enforce availability-import target identity hashes while invalid rows remain';
  END IF;
END
$$;

ALTER TABLE public."AvailabilityImportJob"
  ALTER COLUMN "targetIdentityHash" SET NOT NULL;

-- Refund legacy imports whose target was already deleted before cancellation
-- became part of the user-deletion transaction.
WITH refundable AS (
  SELECT
    job."id",
    job."tenantId",
    (job."creditConsumption" ->> 'consumedCredits')::INTEGER AS amount
  FROM public."AvailabilityImportJob" job
  JOIN public."User" target
    ON target."id" = job."userId"
   AND target."tenantId" = job."tenantId"
  WHERE target."deletedAt" IS NOT NULL
    AND job."status"::text <> 'SUCCEEDED'
    AND jsonb_typeof(job."creditConsumption" -> 'consumedCredits') = 'number'
    AND job."creditConsumption" ->> 'consumedCredits' ~ '^[1-9][0-9]{0,8}$'
    AND EXISTS (
      SELECT 1
      FROM public."CreditTransaction" debit
      WHERE debit."id" = 'feature-usage-availability-import:' || job."id"
        AND debit."tenantId" = job."tenantId"
        AND debit."amount" = -((job."creditConsumption" ->> 'consumedCredits')::INTEGER)
    )
), inserted_refunds AS (
  INSERT INTO public."CreditTransaction" ("id", "tenantId", "amount", "reason", "createdAt")
  SELECT
    'feature-refund-availability-import:' || refundable."id",
    refundable."tenantId",
    refundable.amount,
    'Availability PDF import refund (' || refundable."id" || ')',
    CURRENT_TIMESTAMP
  FROM refundable
  ON CONFLICT ("id") DO NOTHING
  RETURNING "tenantId", "amount"
), refund_totals AS (
  SELECT "tenantId", sum("amount")::INTEGER AS amount
  FROM inserted_refunds
  GROUP BY "tenantId"
)
UPDATE public."Tenant" tenant
SET "usageCredits" = tenant."usageCredits" + refund_totals.amount,
    "updatedAt" = CURRENT_TIMESTAMP
FROM refund_totals
WHERE tenant."id" = refund_totals."tenantId";

UPDATE public."AvailabilityImportJob" job
SET "storageKey" = NULL,
    "encryptedSourcePayload" = NULL,
    "status" = 'CANCELLED',
    "publicationStatus" = 'FAILED',
    "publishToken" = NULL,
    "publishLeaseUntil" = NULL,
    "publicationAmbiguous" = FALSE,
    "publishLastError" = NULL,
    "parsedAvailability" = NULL,
    "resultErasedAt" = COALESCE(job."resultErasedAt", job."completedAt", CURRENT_TIMESTAMP),
    "failureCode" = 'USER_DELETED',
    "executionToken" = NULL,
    "executionLeaseUntil" = NULL,
    "completedAt" = COALESCE(job."completedAt", CURRENT_TIMESTAMP),
    "updatedAt" = CURRENT_TIMESTAMP
FROM public."User" target
WHERE target."id" = job."userId"
  AND target."tenantId" = job."tenantId"
  AND target."deletedAt" IS NOT NULL
  AND job."status"::text <> 'SUCCEEDED';

UPDATE public."AvailabilityImportJob" job
SET "publishToken" = NULL,
    "publishLeaseUntil" = NULL,
    "publicationAmbiguous" = FALSE,
    "publishLastError" = NULL,
    "storageKey" = NULL,
    "encryptedSourcePayload" = NULL,
    "parsedAvailability" = NULL,
    "resultErasedAt" = COALESCE(job."resultErasedAt", job."completedAt", CURRENT_TIMESTAMP),
    "executionToken" = NULL,
    "executionLeaseUntil" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
FROM public."User" target
WHERE target."id" = job."userId"
  AND target."tenantId" = job."tenantId"
  AND target."deletedAt" IS NOT NULL
  AND job."status"::text = 'SUCCEEDED';

UPDATE public."AvailabilityImportJob"
SET "completedAt" = COALESCE("completedAt", "updatedAt", "createdAt")
WHERE "status"::text IN ('SUCCEEDED', 'FAILED', 'DEAD_LETTERED', 'CANCELLED')
  AND "completedAt" IS NULL;

UPDATE public."AvailabilityImportJob"
SET "parsedAvailability" = NULL,
    "resultErasedAt" = COALESCE("resultErasedAt", "completedAt", "updatedAt", CURRENT_TIMESTAMP)
WHERE "status"::text IN ('FAILED', 'DEAD_LETTERED', 'CANCELLED');

UPDATE public."AvailabilityImportJob"
SET "completedAt" = NULL,
    "parsedAvailability" = NULL,
    "resultErasedAt" = NULL
WHERE "status"::text NOT IN ('SUCCEEDED', 'FAILED', 'DEAD_LETTERED', 'CANCELLED');

ALTER TABLE public."AvailabilityImportJob"
  DROP CONSTRAINT IF EXISTS "AvailabilityImportJob_target_identity_hash_check";
ALTER TABLE public."AvailabilityImportJob"
  ADD CONSTRAINT "AvailabilityImportJob_target_identity_hash_check"
  CHECK ("targetIdentityHash" ~ '^[a-f0-9]{64}$') NOT VALID;

ALTER TABLE public."AvailabilityImportJob"
  DROP CONSTRAINT IF EXISTS "AvailabilityImportJob_terminal_completion_check";
ALTER TABLE public."AvailabilityImportJob"
  ADD CONSTRAINT "AvailabilityImportJob_terminal_completion_check"
  CHECK (
    ("status"::text IN ('SUCCEEDED', 'FAILED', 'DEAD_LETTERED', 'CANCELLED'))
      = ("completedAt" IS NOT NULL)
  ) NOT VALID;

ALTER TABLE public."AvailabilityImportJob"
  DROP CONSTRAINT IF EXISTS "AvailabilityImportJob_result_lifecycle_check";
ALTER TABLE public."AvailabilityImportJob"
  ADD CONSTRAINT "AvailabilityImportJob_result_lifecycle_check"
  CHECK (
    CASE
      WHEN "status"::text = 'SUCCEEDED' THEN
        (("parsedAvailability" IS NOT NULL AND "resultErasedAt" IS NULL)
          OR ("parsedAvailability" IS NULL AND "resultErasedAt" IS NOT NULL))
      WHEN "status"::text IN ('FAILED', 'DEAD_LETTERED', 'CANCELLED') THEN
        "parsedAvailability" IS NULL AND "resultErasedAt" IS NOT NULL
      ELSE
        "parsedAvailability" IS NULL AND "resultErasedAt" IS NULL
    END
  ) NOT VALID;

ALTER TABLE public."AvailabilityImportJob"
  DROP CONSTRAINT IF EXISTS "AvailabilityImportJob_result_erasure_time_check";
ALTER TABLE public."AvailabilityImportJob"
  ADD CONSTRAINT "AvailabilityImportJob_result_erasure_time_check"
  CHECK ("resultErasedAt" IS NULL OR "resultErasedAt" >= "completedAt") NOT VALID;

ALTER TABLE public."AvailabilityImportJob"
  VALIDATE CONSTRAINT "AvailabilityImportJob_target_identity_hash_check";
ALTER TABLE public."AvailabilityImportJob"
  VALIDATE CONSTRAINT "AvailabilityImportJob_terminal_completion_check";
ALTER TABLE public."AvailabilityImportJob"
  VALIDATE CONSTRAINT "AvailabilityImportJob_result_lifecycle_check";
ALTER TABLE public."AvailabilityImportJob"
  VALIDATE CONSTRAINT "AvailabilityImportJob_result_erasure_time_check";

CREATE INDEX IF NOT EXISTS "AvailabilityImportJob_status_completedAt_idx"
  ON public."AvailabilityImportJob" ("status", "completedAt");

CREATE OR REPLACE FUNCTION public.enforce_availability_import_final_handoff()
RETURNS TRIGGER AS $$
DECLARE
  active_identity TEXT;
  consumed_credits INTEGER;
  tenant_is_paid_active BOOLEAN;
BEGIN
  IF NEW."status"::text NOT IN ('RUNNING', 'SUCCEEDED') THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public."Tenant" tenant
    WHERE tenant."id" = NEW."tenantId"
      AND tenant."status"::text = 'ACTIVE'
      AND btrim(COALESCE(tenant."stripeSubscriptionId", '')) <> ''
  )
  INTO tenant_is_paid_active;

  IF NOT tenant_is_paid_active THEN
    RAISE EXCEPTION 'Availability import requires an active paid subscription.' USING ERRCODE = '23514';
  END IF;

  SELECT
    lower(
      CASE
        WHEN btrim(target."username") ~ '^[-A-Za-z0-9._:@+]{1,128}$'
          THEN btrim(target."username")
        ELSE target."id"
      END
    )
  INTO active_identity
  FROM public."User" target
  WHERE target."id" = NEW."userId"
    AND target."tenantId" = NEW."tenantId"
    AND target."deletedAt" IS NULL
    AND target."suspendedAt" IS NULL;

  IF active_identity IS NULL
     OR NEW."targetIdentityHash" IS DISTINCT FROM encode(public.digest(active_identity, 'sha256'), 'hex') THEN
    RAISE EXCEPTION 'Availability import target must remain active and identity-bound.' USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(NEW."creditConsumption" -> 'consumedCredits') <> 'number'
     OR NEW."creditConsumption" ->> 'consumedCredits' !~ '^[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION 'Availability import requires a positive paid-credit reservation.' USING ERRCODE = '23514';
  END IF;
  consumed_credits := (NEW."creditConsumption" ->> 'consumedCredits')::INTEGER;

  IF NOT EXISTS (
    SELECT 1
    FROM public."CreditTransaction" debit
    WHERE debit."id" = 'feature-usage-availability-import:' || NEW."id"
      AND debit."tenantId" = NEW."tenantId"
      AND debit."amount" = -consumed_credits
  ) OR EXISTS (
    SELECT 1
    FROM public."CreditTransaction" refund
    WHERE refund."id" = 'feature-refund-availability-import:' || NEW."id"
      AND refund."tenantId" = NEW."tenantId"
      AND refund."amount" > 0
  ) THEN
    RAISE EXCEPTION 'Availability import paid-credit reservation is missing or refunded.' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.enforce_availability_import_final_handoff() FROM PUBLIC;

DROP TRIGGER IF EXISTS tr_enforce_availability_import_final_handoff
  ON public."AvailabilityImportJob";
CREATE TRIGGER tr_enforce_availability_import_final_handoff
BEFORE INSERT OR UPDATE OF "status", "tenantId", "userId", "targetIdentityHash", "creditConsumption"
ON public."AvailabilityImportJob"
FOR EACH ROW EXECUTE FUNCTION public.enforce_availability_import_final_handoff();

CREATE OR REPLACE FUNCTION public.block_user_deletion_with_live_availability_imports()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."deletedAt" IS NOT NULL OR NEW."deletedAt" IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public."AvailabilityImportJob" job
    WHERE job."tenantId" = NEW."tenantId"
      AND job."userId" = NEW."id"
      AND (
        job."publishToken" IS NOT NULL
        OR job."publishLeaseUntil" IS NOT NULL
        OR job."publicationAmbiguous"
        OR job."completedAt" IS NULL
        OR job."parsedAvailability" IS NOT NULL
        OR job."storageKey" IS NOT NULL
        OR job."encryptedSourcePayload" IS NOT NULL
        OR job."resultErasedAt" IS NULL
        OR job."executionToken" IS NOT NULL
        OR job."executionLeaseUntil" IS NOT NULL
        OR (
          job."status"::text <> 'SUCCEEDED'
          AND (
            job."status"::text <> 'CANCELLED'
            OR job."publicationStatus"::text <> 'FAILED'
            OR job."failureCode" IS DISTINCT FROM 'USER_DELETED'
            OR EXISTS (
              SELECT 1
              FROM public."CreditTransaction" debit
              WHERE debit."id" = 'feature-usage-availability-import:' || job."id"
                AND debit."tenantId" = job."tenantId"
                AND debit."amount" < 0
                AND NOT EXISTS (
                  SELECT 1
                  FROM public."CreditTransaction" refund
                  WHERE refund."id" = 'feature-refund-availability-import:' || job."id"
                    AND refund."tenantId" = job."tenantId"
                    AND refund."amount" = -debit."amount"
                )
            )
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'Completed availability imports must be erased; undelivered imports must be refunded, cancelled, and erased before deleting a user.' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.block_user_deletion_with_live_availability_imports() FROM PUBLIC;

DROP TRIGGER IF EXISTS tr_block_user_deletion_with_live_availability_imports
  ON public."User";
CREATE TRIGGER tr_block_user_deletion_with_live_availability_imports
BEFORE UPDATE OF "deletedAt" ON public."User"
FOR EACH ROW EXECUTE FUNCTION public.block_user_deletion_with_live_availability_imports();
