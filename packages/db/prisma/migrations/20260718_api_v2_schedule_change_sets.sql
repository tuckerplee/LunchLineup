-- Harden the Prisma-created API v2 schedule change-set ledger.

ALTER TABLE "ScheduleChangeSet" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScheduleChangeSet" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS schedule_change_set_tenant_isolation ON "ScheduleChangeSet";
CREATE POLICY schedule_change_set_tenant_isolation ON "ScheduleChangeSet"
  USING (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()))
  WITH CHECK (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()));

ALTER TABLE "ScheduleChangeSet"
  DROP CONSTRAINT IF EXISTS "ScheduleChangeSet_revision_order_check";
ALTER TABLE "ScheduleChangeSet"
  ADD CONSTRAINT "ScheduleChangeSet_revision_order_check"
  CHECK ("baseRevision" >= 0 AND "resultRevision" = "baseRevision" + 1);

ALTER TABLE "ScheduleChangeSet"
  DROP CONSTRAINT IF EXISTS "ScheduleChangeSet_hash_format_check";
ALTER TABLE "ScheduleChangeSet"
  ADD CONSTRAINT "ScheduleChangeSet_hash_format_check"
  CHECK (
    "idempotencyKeyHash" ~ '^[a-f0-9]{64}$'
    AND "requestHash" ~ '^[a-f0-9]{64}$'
  );
