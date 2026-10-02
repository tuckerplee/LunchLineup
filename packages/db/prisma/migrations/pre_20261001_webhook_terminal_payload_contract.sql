-- Preserve the historical outbox/erasure migration checksums. This additive
-- contract repair runs both before schema reconciliation (upgrade backfill)
-- and after historical raw migrations (fresh database initialization).
DO $$
BEGIN
    IF to_regclass('public."WebhookDelivery"') IS NULL THEN
        RETURN;
    END IF;

    ALTER TABLE public."WebhookDelivery"
        DROP CONSTRAINT IF EXISTS "WebhookDelivery_required_text_nonempty";
    ALTER TABLE public."WebhookDelivery"
        ADD CONSTRAINT "WebhookDelivery_required_text_nonempty" CHECK (
            length(trim("endpointRef")) > 0
            AND length(trim("payloadDigest")) > 0
            AND length(trim("encryptionKeyRef")) > 0
            AND (
                "status"::text IN ('DELIVERED', 'DEAD_LETTERED')
                OR (
                    length(trim("encryptedUrl")) > 0
                    AND length(trim("encryptedPayload")) > 0
                )
            )
        );
END
$$;

-- Terminal ciphertext is permitted by this legacy text-presence constraint
-- only so pre-erasure upgrade rows can reach the original erasure backfill.
-- WebhookDelivery_terminal_payload_erased_check independently requires both
-- ciphertext fields empty, erased-v1 key reference, and NULL lastError in the
-- final migrated schema. Nonterminal rows still require encrypted content.
