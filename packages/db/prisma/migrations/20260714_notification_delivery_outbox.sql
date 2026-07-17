CREATE TABLE IF NOT EXISTS "NotificationOutbox" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "notificationType" "NotificationType" NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "status" "NotificationOutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  "leaseUntil" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "NotificationOutbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NotificationOutbox_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "NotificationOutbox_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "NotificationOutbox"
  DROP CONSTRAINT IF EXISTS "NotificationOutbox_attempts_check";
ALTER TABLE "NotificationOutbox"
  ADD CONSTRAINT "NotificationOutbox_attempts_check" CHECK ("attempts" >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS "NotificationOutbox_tenantId_dedupeKey_key" ON "NotificationOutbox"("tenantId", "dedupeKey");
CREATE INDEX IF NOT EXISTS "NotificationOutbox_status_nextAttemptAt_idx" ON "NotificationOutbox"("status", "nextAttemptAt");
CREATE INDEX IF NOT EXISTS "NotificationOutbox_status_leaseUntil_idx" ON "NotificationOutbox"("status", "leaseUntil");
CREATE INDEX IF NOT EXISTS "NotificationOutbox_tenantId_status_nextAttemptAt_idx" ON "NotificationOutbox"("tenantId", "status", "nextAttemptAt");
CREATE INDEX IF NOT EXISTS "NotificationOutbox_tenantId_userId_idx" ON "NotificationOutbox"("tenantId", "userId");

ALTER TABLE "NotificationOutbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NotificationOutbox" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notification_outbox_isolation_policy ON "NotificationOutbox";
CREATE POLICY notification_outbox_isolation_policy ON "NotificationOutbox"
  USING (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()))
  WITH CHECK (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()));
CREATE OR REPLACE FUNCTION public.cleanup_deleted_user_notification_outbox()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."deletedAt" IS NOT NULL THEN
    DELETE FROM public."NotificationOutbox"
    WHERE "tenantId" = NEW."tenantId"
      AND "userId" = NEW."id";
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.cleanup_deleted_user_notification_outbox() FROM PUBLIC;

DROP TRIGGER IF EXISTS tr_cleanup_deleted_user_notification_outbox ON public."User";
CREATE TRIGGER tr_cleanup_deleted_user_notification_outbox
AFTER INSERT OR UPDATE OF "deletedAt" ON public."User"
FOR EACH ROW EXECUTE FUNCTION public.cleanup_deleted_user_notification_outbox();

DELETE FROM public."NotificationOutbox" outbox
USING public."User" app_user
WHERE app_user."id" = outbox."userId"
  AND app_user."tenantId" = outbox."tenantId"
  AND app_user."deletedAt" IS NOT NULL;
