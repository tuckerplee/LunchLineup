ALTER TABLE public."User"
    ADD COLUMN IF NOT EXISTS "emailDeliverySuppressedAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "emailDeliverySuppressionReason" TEXT,
    ADD COLUMN IF NOT EXISTS "emailDeliveryLastEventAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "User_emailDeliverySuppressedAt_idx"
    ON public."User"("emailDeliverySuppressedAt");

CREATE INDEX IF NOT EXISTS "User_active_email_delivery_lookup_idx"
    ON public."User"(lower("email"))
    WHERE "deletedAt" IS NULL AND "email" IS NOT NULL;

CREATE OR REPLACE FUNCTION public.scrub_user_email_delivery_state()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."deletedAt" IS NOT NULL
        OR (TG_OP = 'UPDATE' AND NEW."email" IS DISTINCT FROM OLD."email")
    THEN
        NEW."emailDeliverySuppressedAt" := NULL;
        NEW."emailDeliverySuppressionReason" := NULL;
        NEW."emailDeliveryLastEventAt" := NULL;
    END IF;
    RETURN NEW;
END
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS "User_deleted_email_delivery_state_erasure"
    ON public."User";
CREATE TRIGGER "User_deleted_email_delivery_state_erasure"
BEFORE INSERT OR UPDATE OF "deletedAt", "email", "emailDeliverySuppressedAt",
    "emailDeliverySuppressionReason", "emailDeliveryLastEventAt"
ON public."User"
FOR EACH ROW
EXECUTE FUNCTION public.scrub_user_email_delivery_state();

UPDATE public."User"
SET
    "emailDeliverySuppressedAt" = NULL,
    "emailDeliverySuppressionReason" = NULL,
    "emailDeliveryLastEventAt" = NULL
WHERE "deletedAt" IS NOT NULL
  AND (
      "emailDeliverySuppressedAt" IS NOT NULL
      OR "emailDeliverySuppressionReason" IS NOT NULL
      OR "emailDeliveryLastEventAt" IS NOT NULL
  );
