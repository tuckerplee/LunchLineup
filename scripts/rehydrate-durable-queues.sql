-- Run only with API and workers stopped after RabbitMQ state was lost.
-- Terminal jobs and delivered/dead-lettered webhooks are intentionally untouched.
BEGIN;

WITH schedule_reset AS (
  UPDATE "ScheduleSolveJob"
  SET
    "publicationStatus" = 'FAILED',
    "queuePayload" = CASE
      WHEN "status" IN ('RUNNING', 'RETRYING')
        THEN jsonb_set("queuePayload", '{retry_count}', to_jsonb("retryCount"), true)
      ELSE "queuePayload"
    END,
    "nextPublishAt" = CURRENT_TIMESTAMP,
    "publishLeaseUntil" = NULL,
    "publishedAt" = NULL,
    "publishLastError" = 'RabbitMQ state rehydration requested after broker data loss',
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "publicationStatus" = 'PUBLISHED'
    AND "queuePayload" IS NOT NULL
    AND "status" IN ('QUEUED', 'RUNNING', 'RETRYING')
  RETURNING 1
),
webhook_reset AS (
  UPDATE "WebhookDelivery"
  SET
    "status" = 'FAILED'::"WebhookDeliveryStatus",
    "nextAttemptAt" = CURRENT_TIMESTAMP,
    "queuedAt" = NULL,
    "lastError" = 'RabbitMQ state rehydration requested after broker data loss',
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "status" = 'QUEUED'::"WebhookDeliveryStatus"
    AND "nextAttemptAt" IS NULL
  RETURNING 1
)
SELECT
  (SELECT count(*) FROM schedule_reset) AS schedule_publications_rehydrated,
  (SELECT count(*) FROM webhook_reset) AS webhook_deliveries_rehydrated;

COMMIT;
