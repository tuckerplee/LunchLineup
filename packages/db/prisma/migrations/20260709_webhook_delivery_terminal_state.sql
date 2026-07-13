-- Dead-lettered webhook deliveries are terminal and have no next attempt.

ALTER TABLE "WebhookDelivery"
  ALTER COLUMN "nextAttemptAt" DROP NOT NULL;
