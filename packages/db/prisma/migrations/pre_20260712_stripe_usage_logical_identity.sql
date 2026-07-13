DO $$
BEGIN
    IF to_regclass('"StripeUsageEvent"') IS NULL THEN
        RETURN;
    END IF;

    ALTER TABLE "StripeUsageEvent"
        ADD COLUMN IF NOT EXISTS "submittedAt" TIMESTAMP(3);

    LOCK TABLE "StripeUsageEvent" IN SHARE ROW EXCLUSIVE MODE;

    CREATE TEMP TABLE stripe_usage_logical_dedupe ON COMMIT DROP AS
    SELECT
        "id",
        FIRST_VALUE("id") OVER logical_rows AS canonical_id,
        COUNT(*) OVER logical_rows AS duplicate_count,
        ROW_NUMBER() OVER logical_rows AS logical_rank
    FROM "StripeUsageEvent"
    WINDOW logical_rows AS (
        PARTITION BY "tenantId", "metric", "periodStart", "periodEnd"
        ORDER BY
            CASE "status"
                WHEN 'SENT' THEN 0
                WHEN 'SENDING' THEN 1
                WHEN 'FAILED' THEN 2
                WHEN 'PENDING' THEN 3
                WHEN 'DEAD_LETTERED' THEN 4
            END,
            COALESCE("submittedAt", "sentAt", "updatedAt", "createdAt") DESC,
            "updatedAt" DESC,
            "id" ASC
    );

    UPDATE "StripeUsageEvent" usage
    SET "metadata" = COALESCE(usage."metadata", '{}'::jsonb) || jsonb_build_object(
        'logicalDedupeDiscardedCount', dedupe.duplicate_count - 1
    )
    FROM stripe_usage_logical_dedupe dedupe
    WHERE usage."id" = dedupe.canonical_id
      AND dedupe.logical_rank = 1
      AND dedupe.duplicate_count > 1;

    DELETE FROM "StripeUsageEvent" usage
    USING stripe_usage_logical_dedupe dedupe
    WHERE usage."id" = dedupe."id"
      AND dedupe.logical_rank > 1;

    DROP INDEX IF EXISTS "StripeUsageEvent_tenantId_metric_periodStart_periodEnd_idx";
    CREATE UNIQUE INDEX IF NOT EXISTS "StripeUsageEvent_tenantId_metric_periodStart_periodEnd_key"
        ON "StripeUsageEvent"("tenantId", "metric", "periodStart", "periodEnd");
END
$$;
