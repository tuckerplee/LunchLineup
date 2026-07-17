-- Durable tenant-scoped staff invitation delivery intents.
DO $$
BEGIN
  CREATE TYPE "StaffInvitationOutboxStatus" AS ENUM (
    'PENDING',
    'SENDING',
    'FAILED',
    'DELIVERED',
    'DEAD_LETTERED',
    'CANCELLED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE "StaffInvitationPurpose" AS ENUM ('STAFF_INVITATION');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "User_tenantId_id_key"
ON public."User" ("tenantId", "id");

CREATE TABLE IF NOT EXISTS public."StaffInvitationOutbox" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "recipientHash" TEXT NOT NULL,
  "purpose" "StaffInvitationPurpose" NOT NULL DEFAULT 'STAFF_INVITATION',
  "encryptedPayload" BYTEA,
  "encryptionNonce" BYTEA,
  "encryptionTag" BYTEA,
  "encryptionKeyRef" TEXT,
  "payloadVersion" INTEGER NOT NULL DEFAULT 1,
  "status" "StaffInvitationOutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "manualRetryCount" INTEGER NOT NULL DEFAULT 0,
  "retryAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "providerMessageId" TEXT,
  "lastErrorCode" TEXT,
  "deliveredAt" TIMESTAMP(3),
  "deadLetteredAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "payloadErasedAt" TIMESTAMP(3),
  "diagnosticsEraseAfter" TIMESTAMP(3),
  "diagnosticsErasedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StaffInvitationOutbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StaffInvitationOutbox_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES public."Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "StaffInvitationOutbox_tenantId_userId_fkey"
    FOREIGN KEY ("tenantId", "userId") REFERENCES public."User"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "StaffInvitationOutbox_tenantId_userId_purpose_key"
ON public."StaffInvitationOutbox" ("tenantId", "userId", "purpose");

CREATE INDEX IF NOT EXISTS "StaffInvitationOutbox_status_retryAt_createdAt_idx"
ON public."StaffInvitationOutbox" ("status", "retryAt", "createdAt")
WHERE "status" IN ('PENDING', 'FAILED');

CREATE INDEX IF NOT EXISTS "StaffInvitationOutbox_status_leaseExpiresAt_idx"
ON public."StaffInvitationOutbox" ("status", "leaseExpiresAt")
WHERE "status" = 'SENDING';

CREATE INDEX IF NOT EXISTS "StaffInvitationOutbox_tenantId_status_retryAt_idx"
ON public."StaffInvitationOutbox" ("tenantId", "status", "retryAt");

CREATE INDEX IF NOT EXISTS "StaffInvitationOutbox_tenantId_userId_idx"
ON public."StaffInvitationOutbox" ("tenantId", "userId");

CREATE INDEX IF NOT EXISTS "StaffInvitationOutbox_dead_letter_idx"
ON public."StaffInvitationOutbox" ("tenantId", "deadLetteredAt", "id")
WHERE "status" = 'DEAD_LETTERED';

CREATE INDEX IF NOT EXISTS "StaffInvitationOutbox_diagnostics_retention_idx"
ON public."StaffInvitationOutbox" ("status", "diagnosticsEraseAfter", "id")
WHERE "diagnosticsErasedAt" IS NULL;

ALTER TABLE public."StaffInvitationOutbox"
  DROP CONSTRAINT IF EXISTS "StaffInvitationOutbox_recipient_hash_check",
  DROP CONSTRAINT IF EXISTS "StaffInvitationOutbox_attempt_bounds_check",
  DROP CONSTRAINT IF EXISTS "StaffInvitationOutbox_manual_retry_bounds_check",
  DROP CONSTRAINT IF EXISTS "StaffInvitationOutbox_envelope_check",
  DROP CONSTRAINT IF EXISTS "StaffInvitationOutbox_lease_check",
  DROP CONSTRAINT IF EXISTS "StaffInvitationOutbox_error_code_check",
  DROP CONSTRAINT IF EXISTS "StaffInvitationOutbox_state_check",
  DROP CONSTRAINT IF EXISTS "StaffInvitationOutbox_terminal_payload_erased_check";

ALTER TABLE public."StaffInvitationOutbox"
  ADD CONSTRAINT "StaffInvitationOutbox_recipient_hash_check"
    CHECK ("recipientHash" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "StaffInvitationOutbox_attempt_bounds_check"
    CHECK ("attempts" BETWEEN 0 AND 8),
  ADD CONSTRAINT "StaffInvitationOutbox_manual_retry_bounds_check"
    CHECK ("manualRetryCount" BETWEEN 0 AND 3),
  ADD CONSTRAINT "StaffInvitationOutbox_envelope_check"
    CHECK (
      ("encryptedPayload" IS NULL AND "encryptionNonce" IS NULL AND "encryptionTag" IS NULL AND "encryptionKeyRef" IS NULL)
      OR (
        octet_length("encryptedPayload") BETWEEN 1 AND 16384
        AND octet_length("encryptionNonce") = 12
        AND octet_length("encryptionTag") = 16
        AND "encryptionKeyRef" ~ '^[a-f0-9]{16}$'
        AND "payloadVersion" = 1
      )
    ),
  ADD CONSTRAINT "StaffInvitationOutbox_lease_check"
    CHECK (
      ("status" = 'SENDING' AND "leaseOwner" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL)
      OR ("status" <> 'SENDING' AND "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL)
    ),
  ADD CONSTRAINT "StaffInvitationOutbox_error_code_check"
    CHECK (
      "lastErrorCode" IS NULL
      OR (octet_length("lastErrorCode") <= 64 AND "lastErrorCode" ~ '^[A-Z0-9_:-]+$')
    ),
  ADD CONSTRAINT "StaffInvitationOutbox_state_check"
    CHECK (
      ("status" = 'PENDING' AND "retryAt" IS NOT NULL AND "deliveredAt" IS NULL AND "deadLetteredAt" IS NULL AND "cancelledAt" IS NULL)
      OR ("status" = 'SENDING' AND "deliveredAt" IS NULL AND "deadLetteredAt" IS NULL AND "cancelledAt" IS NULL)
      OR ("status" = 'FAILED' AND "retryAt" IS NOT NULL AND "deliveredAt" IS NULL AND "deadLetteredAt" IS NULL AND "cancelledAt" IS NULL)
      OR ("status" = 'DELIVERED' AND "retryAt" IS NULL AND "deliveredAt" IS NOT NULL AND "deadLetteredAt" IS NULL AND "cancelledAt" IS NULL)
      OR ("status" = 'DEAD_LETTERED' AND "retryAt" IS NULL AND "deliveredAt" IS NULL AND "deadLetteredAt" IS NOT NULL AND "cancelledAt" IS NULL)
      OR ("status" = 'CANCELLED' AND "retryAt" IS NULL AND "deliveredAt" IS NULL AND "deadLetteredAt" IS NULL AND "cancelledAt" IS NOT NULL)
    ),
  ADD CONSTRAINT "StaffInvitationOutbox_terminal_payload_erased_check"
    CHECK (
      (
        "status" NOT IN ('DELIVERED', 'DEAD_LETTERED', 'CANCELLED')
        AND "encryptedPayload" IS NOT NULL
        AND "encryptionNonce" IS NOT NULL
        AND "encryptionTag" IS NOT NULL
        AND "encryptionKeyRef" IS NOT NULL
        AND "payloadErasedAt" IS NULL
        AND "diagnosticsEraseAfter" IS NULL
        AND "diagnosticsErasedAt" IS NULL
      )
      OR (
        "status" IN ('DELIVERED', 'DEAD_LETTERED', 'CANCELLED')
        AND "encryptedPayload" IS NULL
        AND "encryptionNonce" IS NULL
        AND "encryptionTag" IS NULL
        AND "encryptionKeyRef" IS NULL
        AND "payloadErasedAt" IS NOT NULL
        AND "diagnosticsEraseAfter" IS NOT NULL
      )
    );

CREATE OR REPLACE FUNCTION public.scrub_terminal_staff_invitation_outbox()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."status" IN ('DELIVERED', 'DEAD_LETTERED', 'CANCELLED') THEN
    NEW."encryptedPayload" := NULL;
    NEW."encryptionNonce" := NULL;
    NEW."encryptionTag" := NULL;
    NEW."encryptionKeyRef" := NULL;
    NEW."payloadErasedAt" := COALESCE(NEW."payloadErasedAt", CURRENT_TIMESTAMP);
    NEW."diagnosticsEraseAfter" := COALESCE(
      NEW."diagnosticsEraseAfter",
      CURRENT_TIMESTAMP + INTERVAL '30 days'
    );
    NEW."retryAt" := NULL;
    NEW."leaseOwner" := NULL;
    NEW."leaseExpiresAt" := NULL;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS "StaffInvitationOutbox_terminal_payload_erasure"
ON public."StaffInvitationOutbox";
CREATE TRIGGER "StaffInvitationOutbox_terminal_payload_erasure"
BEFORE INSERT OR UPDATE ON public."StaffInvitationOutbox"
FOR EACH ROW EXECUTE FUNCTION public.scrub_terminal_staff_invitation_outbox();

CREATE OR REPLACE FUNCTION public.cancel_user_staff_invitation_outbox()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."deletedAt" IS NOT NULL
     OR NEW."suspendedAt" IS NOT NULL
     OR (TG_OP = 'UPDATE' AND OLD."email" IS DISTINCT FROM NEW."email") THEN
    UPDATE public."StaffInvitationOutbox"
    SET "status" = 'CANCELLED',
        "cancelledAt" = COALESCE("cancelledAt", CURRENT_TIMESTAMP),
        "lastErrorCode" = 'USER_LIFECYCLE_CHANGED',
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "tenantId" = NEW."tenantId"
      AND "userId" = NEW."id"
      AND "status" IN ('PENDING', 'SENDING', 'FAILED');
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.cancel_user_staff_invitation_outbox() FROM PUBLIC;

DROP TRIGGER IF EXISTS "User_cancel_staff_invitation_outbox" ON public."User";
CREATE TRIGGER "User_cancel_staff_invitation_outbox"
AFTER UPDATE OF "email", "suspendedAt", "deletedAt" ON public."User"
FOR EACH ROW EXECUTE FUNCTION public.cancel_user_staff_invitation_outbox();

CREATE OR REPLACE FUNCTION public.cancel_tenant_staff_invitation_outbox()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."deletedAt" IS NOT NULL OR NEW."status" IN ('CANCELLED', 'PURGED') THEN
    UPDATE public."StaffInvitationOutbox"
    SET "status" = 'CANCELLED',
        "cancelledAt" = COALESCE("cancelledAt", CURRENT_TIMESTAMP),
        "lastErrorCode" = 'TENANT_LIFECYCLE_CHANGED',
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "tenantId" = NEW."id"
      AND "status" IN ('PENDING', 'SENDING', 'FAILED');
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.cancel_tenant_staff_invitation_outbox() FROM PUBLIC;

DROP TRIGGER IF EXISTS "Tenant_cancel_staff_invitation_outbox" ON public."Tenant";
CREATE TRIGGER "Tenant_cancel_staff_invitation_outbox"
AFTER UPDATE OF "status", "deletedAt" ON public."Tenant"
FOR EACH ROW EXECUTE FUNCTION public.cancel_tenant_staff_invitation_outbox();

CREATE OR REPLACE FUNCTION public.purge_staff_invitation_outbox_diagnostics(
  as_of TIMESTAMP WITHOUT TIME ZONE,
  batch_limit INTEGER
)
RETURNS BIGINT AS $$
DECLARE
  affected BIGINT;
BEGIN
  IF NOT is_current_platform_admin() THEN
    RAISE EXCEPTION 'staff invitation retention purge requires platform admin capability'
      USING ERRCODE = '42501';
  END IF;
  IF batch_limit < 1 OR batch_limit > 10000 THEN
    RAISE EXCEPTION 'staff invitation retention batch limit must be between 1 and 10000'
      USING ERRCODE = '22023';
  END IF;

  WITH due AS (
    SELECT "id"
    FROM public."StaffInvitationOutbox"
    WHERE "status" IN ('DELIVERED', 'DEAD_LETTERED', 'CANCELLED')
      AND "diagnosticsEraseAfter" <= as_of
      AND "diagnosticsErasedAt" IS NULL
    ORDER BY "diagnosticsEraseAfter", "id"
    LIMIT batch_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public."StaffInvitationOutbox" outbox
  SET "providerMessageId" = NULL,
      "lastErrorCode" = NULL,
      "diagnosticsErasedAt" = as_of,
      "updatedAt" = CURRENT_TIMESTAMP
  FROM due
  WHERE outbox."id" = due."id";

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.purge_staff_invitation_outbox_diagnostics(
  TIMESTAMP WITHOUT TIME ZONE,
  INTEGER
) FROM PUBLIC;

ALTER TABLE public."StaffInvitationOutbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."StaffInvitationOutbox" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_invitation_outbox_isolation_policy
ON public."StaffInvitationOutbox";
CREATE POLICY staff_invitation_outbox_isolation_policy
ON public."StaffInvitationOutbox"
USING (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()))
WITH CHECK (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()));
