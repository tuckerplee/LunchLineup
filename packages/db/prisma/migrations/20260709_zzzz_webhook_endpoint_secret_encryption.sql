-- Plaintext rows are encrypted by rotate-webhook-endpoint-secrets.mjs before
-- any DDL runs. This assertion is deliberately non-destructive and fail closed.
DO $$
DECLARE
  endpoint RECORD;
  envelope JSONB;
BEGIN
  FOR endpoint IN
    SELECT "id", "secret"
    FROM "WebhookEndpoint"
    WHERE "secret" IS NOT NULL
  LOOP
    BEGIN
      envelope := endpoint."secret"::JSONB;
    EXCEPTION
      WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'Webhook endpoint secret preflight was not completed';
    END;

    IF jsonb_typeof(envelope) IS DISTINCT FROM 'object'
      OR (
        envelope -> 'v' IS DISTINCT FROM '1'::JSONB
        AND envelope -> 'v' IS DISTINCT FROM '2'::JSONB
      )
      OR envelope ->> 'alg' IS DISTINCT FROM 'aes-256-gcm'
      OR jsonb_typeof(envelope -> 'iv') IS DISTINCT FROM 'string'
      OR jsonb_typeof(envelope -> 'tag') IS DISTINCT FROM 'string'
      OR jsonb_typeof(envelope -> 'ciphertext') IS DISTINCT FROM 'string'
      OR (
        envelope -> 'v' = '2'::JSONB
        AND (
          jsonb_typeof(envelope -> 'keyRef') IS DISTINCT FROM 'string'
          OR envelope ->> 'keyRef' !~ '^[0-9a-f]{16}$'
        )
      )
    THEN
      RAISE EXCEPTION 'Webhook endpoint secret preflight was not completed';
    END IF;
  END LOOP;
END $$;
