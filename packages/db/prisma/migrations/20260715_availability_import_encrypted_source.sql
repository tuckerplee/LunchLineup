-- Add a bounded encrypted recovery source for accepted availability imports.

ALTER TABLE public."AvailabilityImportJob"
  ADD COLUMN IF NOT EXISTS "encryptedSourcePayload" BYTEA;

-- Terminal rows must never retain either source copy. Local files are removed
-- by the worker/API orphan sweep after the opaque reference is erased.
UPDATE public."AvailabilityImportJob"
SET "encryptedSourcePayload" = NULL,
    "storageKey" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "status"::text IN ('SUCCEEDED', 'FAILED', 'DEAD_LETTERED', 'CANCELLED')
  AND ("encryptedSourcePayload" IS NOT NULL OR "storageKey" IS NOT NULL);

ALTER TABLE public."AvailabilityImportJob"
  DROP CONSTRAINT IF EXISTS "AvailabilityImportJob_encrypted_source_size_check";
ALTER TABLE public."AvailabilityImportJob"
  ADD CONSTRAINT "AvailabilityImportJob_encrypted_source_size_check"
  CHECK (
    "encryptedSourcePayload" IS NULL
    OR octet_length("encryptedSourcePayload") BETWEEN 34 AND 5242913
  ) NOT VALID;

ALTER TABLE public."AvailabilityImportJob"
  DROP CONSTRAINT IF EXISTS "AvailabilityImportJob_terminal_source_erasure_check";
ALTER TABLE public."AvailabilityImportJob"
  ADD CONSTRAINT "AvailabilityImportJob_terminal_source_erasure_check"
  CHECK (
    "status"::text NOT IN ('SUCCEEDED', 'FAILED', 'DEAD_LETTERED', 'CANCELLED')
    OR ("encryptedSourcePayload" IS NULL AND "storageKey" IS NULL)
  ) NOT VALID;

ALTER TABLE public."AvailabilityImportJob"
  VALIDATE CONSTRAINT "AvailabilityImportJob_encrypted_source_size_check";
ALTER TABLE public."AvailabilityImportJob"
  VALIDATE CONSTRAINT "AvailabilityImportJob_terminal_source_erasure_check";

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
