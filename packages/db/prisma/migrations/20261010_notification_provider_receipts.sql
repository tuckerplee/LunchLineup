-- Additive selected-provider custody. No legacy delivery is reclassified as provider acceptance.
ALTER TABLE public."NotificationOutbox"
    ADD COLUMN IF NOT EXISTS "providerIntentSha256" VARCHAR(64),
    ADD COLUMN IF NOT EXISTS "providerRecipientSha256" VARCHAR(64),
    ADD COLUMN IF NOT EXISTS "providerPayloadSha256" VARCHAR(64),
    ADD COLUMN IF NOT EXISTS "providerMessageId" VARCHAR(255),
    ADD COLUMN IF NOT EXISTS "providerOutcome" VARCHAR(32),
    ADD COLUMN IF NOT EXISTS "providerCompletedAt" TIMESTAMP(3);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
        WHERE conname = 'NotificationOutbox_provider_receipt_check'
          AND conrelid = 'public."NotificationOutbox"'::regclass) THEN
        ALTER TABLE public."NotificationOutbox"
            ADD CONSTRAINT "NotificationOutbox_provider_receipt_check" CHECK (
                (
                    ("providerIntentSha256" IS NULL AND "providerRecipientSha256" IS NULL AND "providerPayloadSha256" IS NULL)
                    OR ("providerIntentSha256" IS NOT NULL AND "providerRecipientSha256" IS NOT NULL AND "providerPayloadSha256" IS NOT NULL
                        AND "providerIntentSha256" ~ '^[a-f0-9]{64}$'
                        AND "providerRecipientSha256" ~ '^[a-f0-9]{64}$'
                        AND "providerPayloadSha256" ~ '^[a-f0-9]{64}$')
                )
                AND (
                    ("providerOutcome" IS NULL AND "providerMessageId" IS NULL AND "providerCompletedAt" IS NULL)
                    OR ("providerOutcome" IS NOT NULL AND "providerCompletedAt" IS NOT NULL AND "providerIntentSha256" IS NOT NULL
                        AND (("providerOutcome" = 'ACCEPTED' AND "providerMessageId" IS NOT NULL AND length("providerMessageId") BETWEEN 1 AND 255)
                            OR ("providerOutcome" IN ('SKIPPED_SUPPRESSED', 'SKIPPED_NOT_ADDRESSABLE') AND "providerMessageId" IS NULL)))
                )
            );
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.preserve_notification_provider_receipt()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."providerIntentSha256" IS NOT NULL OR NEW."providerOutcome" IS NOT NULL THEN
            RAISE EXCEPTION 'Provider custody requires an existing initial outbox row' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD."providerIntentSha256" IS NULL AND NEW."providerIntentSha256" IS NOT NULL THEN
        IF OLD."status"::text <> 'PENDING' OR OLD."attempts" <> 0
            OR NEW."status"::text <> 'PROCESSING' OR NEW."attempts" <> 1
            OR NEW."leaseUntil" IS NULL OR NEW."leaseUntil" <= clock_timestamp()
            OR NEW."providerOutcome" IS NOT NULL THEN
            RAISE EXCEPTION 'Provider custody requires one initial claim' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW."providerIntentSha256" IS NOT NULL THEN
        IF ROW(NEW."id", NEW."tenantId", NEW."userId", NEW."notificationType", NEW."dedupeKey", NEW."createdAt", NEW."failureCount")
            IS DISTINCT FROM ROW(OLD."id", OLD."tenantId", OLD."userId", OLD."notificationType", OLD."dedupeKey", OLD."createdAt", OLD."failureCount") THEN
            RAISE EXCEPTION 'Provider custody identity is immutable' USING ERRCODE = '23514';
        END IF;
        -- This trigger sorts after terminal_payload_erasure. Only a concrete receipt
        -- can terminalize a selected claim; the original digest survives plaintext erasure.
        IF NEW."status"::text <> 'DELIVERED'
            AND ROW(NEW."title", NEW."body") IS DISTINCT FROM ROW(OLD."title", OLD."body") THEN
            RAISE EXCEPTION 'Selected provider payload is immutable before terminal erasure' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF OLD."providerIntentSha256" IS NOT NULL THEN
        IF NEW."attempts" IS DISTINCT FROM OLD."attempts" THEN
            RAISE EXCEPTION 'Selected provider generation cannot be reclaimed' USING ERRCODE = '23514';
        END IF;
        IF OLD."providerOutcome" IS NULL AND NEW."providerOutcome" IS NOT NULL THEN
            IF OLD."status"::text <> 'PROCESSING' OR OLD."leaseUntil" IS NULL
                OR OLD."leaseUntil" <= clock_timestamp() OR NEW."status"::text <> 'DELIVERED'
                OR NEW."leaseUntil" IS NOT NULL OR NEW."nextAttemptAt" IS NOT NULL
                OR NEW."deliveredAt" IS NULL THEN
                RAISE EXCEPTION 'Provider receipt requires the live original claim' USING ERRCODE = '23514';
            END IF;
        ELSIF ROW(NEW."status", NEW."leaseUntil", NEW."nextAttemptAt", NEW."deliveredAt")
            IS DISTINCT FROM ROW(OLD."status", OLD."leaseUntil", OLD."nextAttemptAt", OLD."deliveredAt") THEN
            RAISE EXCEPTION 'Selected provider state is fenced across retry and rollback' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF (OLD."providerIntentSha256" IS NOT NULL AND NEW."providerIntentSha256" IS DISTINCT FROM OLD."providerIntentSha256")
        OR (OLD."providerRecipientSha256" IS NOT NULL AND NEW."providerRecipientSha256" IS DISTINCT FROM OLD."providerRecipientSha256")
        OR (OLD."providerPayloadSha256" IS NOT NULL AND NEW."providerPayloadSha256" IS DISTINCT FROM OLD."providerPayloadSha256")
        OR (OLD."providerMessageId" IS NOT NULL AND NEW."providerMessageId" IS DISTINCT FROM OLD."providerMessageId")
        OR (OLD."providerOutcome" IS NOT NULL AND NEW."providerOutcome" IS DISTINCT FROM OLD."providerOutcome")
        OR (OLD."providerCompletedAt" IS NOT NULL AND NEW."providerCompletedAt" IS DISTINCT FROM OLD."providerCompletedAt") THEN
        RAISE EXCEPTION 'Notification provider custody/receipt is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS "NotificationOutbox_zz_provider_receipt_immutable" ON public."NotificationOutbox";
CREATE TRIGGER "NotificationOutbox_zz_provider_receipt_immutable"
BEFORE INSERT OR UPDATE ON public."NotificationOutbox"
FOR EACH ROW EXECUTE FUNCTION public.preserve_notification_provider_receipt();

-- Existing tenant RLS, user/tenant cascades and terminal title/body erasure remain authoritative.
