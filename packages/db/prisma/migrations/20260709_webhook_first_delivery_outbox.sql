-- Recover API crashes after a durable webhook row is claimed but before delivery completes.

CREATE INDEX IF NOT EXISTS "WebhookDelivery_sending_lease_idx"
  ON "WebhookDelivery"("updatedAt")
  WHERE "status" = 'SENDING';
