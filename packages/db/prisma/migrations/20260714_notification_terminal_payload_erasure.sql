-- Erase duplicate notification content after the outbox reaches a terminal state.
CREATE OR REPLACE FUNCTION public.scrub_terminal_notification_outbox_payload()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."status"::text IN ('DELIVERED', 'DEAD_LETTERED') THEN
        NEW."title" := '';
        NEW."body" := '';
        NEW."lastError" := NULL;
    END IF;
    RETURN NEW;
END
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS "NotificationOutbox_terminal_payload_erasure"
    ON public."NotificationOutbox";
CREATE TRIGGER "NotificationOutbox_terminal_payload_erasure"
BEFORE INSERT OR UPDATE OF "status", "title", "body", "lastError"
ON public."NotificationOutbox"
FOR EACH ROW
EXECUTE FUNCTION public.scrub_terminal_notification_outbox_payload();

UPDATE public."NotificationOutbox"
SET
    "title" = '',
    "body" = '',
    "lastError" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "status"::text IN ('DELIVERED', 'DEAD_LETTERED')
  AND ("title" <> '' OR "body" <> '' OR "lastError" IS NOT NULL);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'NotificationOutbox_terminal_payload_erased_check'
          AND conrelid = 'public."NotificationOutbox"'::regclass
    ) THEN
        ALTER TABLE public."NotificationOutbox"
            ADD CONSTRAINT "NotificationOutbox_terminal_payload_erased_check"
            CHECK (
                "status"::text NOT IN ('DELIVERED', 'DEAD_LETTERED')
                OR ("title" = '' AND "body" = '' AND "lastError" IS NULL)
            );
    END IF;
END
$$;
