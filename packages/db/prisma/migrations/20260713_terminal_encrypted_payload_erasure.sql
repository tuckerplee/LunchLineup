CREATE OR REPLACE FUNCTION public.scrub_terminal_password_reset_email_payload()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NEW."status"::text IN ('DELIVERED', 'DEAD_LETTERED') THEN
        NEW."tokenHash" := 'erased-v1:' || encode(public.digest(NEW."id", 'sha256'), 'hex');
        NEW."encryptedPayload" := '';
        NEW."encryptionKeyRef" := 'erased-v1';
        NEW."lastError" := NULL;
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS "PasswordResetEmailOutbox_terminal_payload_erasure"
    ON public."PasswordResetEmailOutbox";
CREATE TRIGGER "PasswordResetEmailOutbox_terminal_payload_erasure"
BEFORE INSERT OR UPDATE OF "status", "tokenHash", "encryptedPayload", "encryptionKeyRef", "lastError"
ON public."PasswordResetEmailOutbox"
FOR EACH ROW
EXECUTE FUNCTION public.scrub_terminal_password_reset_email_payload();

UPDATE public."PasswordResetEmailOutbox"
SET
    "tokenHash" = 'erased-v1:' || encode(public.digest("id", 'sha256'), 'hex'),
    "encryptedPayload" = '',
    "encryptionKeyRef" = 'erased-v1',
    "lastError" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "status"::text IN ('DELIVERED', 'DEAD_LETTERED')
  AND (
      "tokenHash" NOT LIKE 'erased-v1:%'
      OR "encryptedPayload" <> ''
      OR "encryptionKeyRef" <> 'erased-v1'
      OR "lastError" IS NOT NULL
  );

CREATE OR REPLACE FUNCTION public.scrub_terminal_webhook_delivery_payload()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NEW."status"::text IN ('DELIVERED', 'DEAD_LETTERED') THEN
        NEW."encryptedUrl" := '';
        NEW."encryptedPayload" := '';
        NEW."encryptionKeyRef" := 'erased-v1';
        NEW."lastError" := NULL;
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS "WebhookDelivery_terminal_payload_erasure"
    ON public."WebhookDelivery";
CREATE TRIGGER "WebhookDelivery_terminal_payload_erasure"
BEFORE INSERT OR UPDATE OF "status", "encryptedUrl", "encryptedPayload", "encryptionKeyRef", "lastError"
ON public."WebhookDelivery"
FOR EACH ROW
EXECUTE FUNCTION public.scrub_terminal_webhook_delivery_payload();

UPDATE public."WebhookDelivery"
SET
    "encryptedUrl" = '',
    "encryptedPayload" = '',
    "encryptionKeyRef" = 'erased-v1',
    "lastError" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "status"::text IN ('DELIVERED', 'DEAD_LETTERED')
  AND (
      "encryptedUrl" <> ''
      OR "encryptedPayload" <> ''
      OR "encryptionKeyRef" <> 'erased-v1'
      OR "lastError" IS NOT NULL
  );

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'PasswordResetEmailOutbox_terminal_payload_erased_check'
          AND conrelid = 'public."PasswordResetEmailOutbox"'::regclass
    ) THEN
        ALTER TABLE public."PasswordResetEmailOutbox"
            ADD CONSTRAINT "PasswordResetEmailOutbox_terminal_payload_erased_check"
            CHECK (
                "status"::text NOT IN ('DELIVERED', 'DEAD_LETTERED')
                OR (
                    "tokenHash" LIKE 'erased-v1:%'
                    AND "encryptedPayload" = ''
                    AND "encryptionKeyRef" = 'erased-v1'
                    AND "lastError" IS NULL
                )
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'WebhookDelivery_terminal_payload_erased_check'
          AND conrelid = 'public."WebhookDelivery"'::regclass
    ) THEN
        ALTER TABLE public."WebhookDelivery"
            ADD CONSTRAINT "WebhookDelivery_terminal_payload_erased_check"
            CHECK (
                "status"::text NOT IN ('DELIVERED', 'DEAD_LETTERED')
                OR (
                    "encryptedUrl" = ''
                    AND "encryptedPayload" = ''
                    AND "encryptionKeyRef" = 'erased-v1'
                    AND "lastError" IS NULL
                )
            );
    END IF;
END
$$;
