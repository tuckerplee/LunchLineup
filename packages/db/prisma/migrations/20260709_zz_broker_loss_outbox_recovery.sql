-- Reclaim broker-confirmed rows after RabbitMQ-only data loss while preserving
-- terminal work and keeping recovery scans bounded by partial indexes.

UPDATE "PlanDefinition"
SET
  "metadata" = jsonb_set(
    COALESCE("metadata", '{}'::jsonb),
    '{features}',
    COALESCE("metadata"->'features', '[]'::jsonb) || '["webhooks"]'::jsonb,
    true
  ),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" IN ('GROWTH', 'ENTERPRISE')
  AND NOT (COALESCE("metadata"->'features', '[]'::jsonb) ? 'webhooks');

CREATE INDEX IF NOT EXISTS "ScheduleSolveJob_confirmed_incomplete_idx"
  ON "ScheduleSolveJob"("publishedAt", "updatedAt", "createdAt")
  WHERE "publicationStatus" = 'PUBLISHED'
    AND "status" IN ('QUEUED', 'RUNNING', 'RETRYING');

CREATE INDEX IF NOT EXISTS "WebhookDelivery_confirmed_queued_idx"
  ON "WebhookDelivery"("queuedAt", "createdAt")
  WHERE "status" = 'QUEUED'::"WebhookDeliveryStatus"
    AND "nextAttemptAt" IS NULL;
