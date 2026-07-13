-- Forward replacement for superseded legacy bootstrap policies and audit SQL.
-- Tenant-context helpers are installed first by their dedicated migration.

DO $$
DECLARE
  table_name TEXT;
  policy_name TEXT;
BEGIN
  FOR table_name, policy_name IN VALUES
    ('Tenant', 'tenant_isolation_policy'),
    ('User', 'user_isolation_policy'),
    ('Location', 'location_isolation_policy'),
    ('Schedule', 'schedule_isolation_policy'),
    ('Shift', 'shift_isolation_policy'),
    ('TimeCard', 'time_card_isolation_policy'),
    ('TenantSetting', 'tenant_setting_isolation_policy'),
    ('Role', 'role_isolation_policy'),
    ('BillingEvent', 'billing_event_isolation_policy'),
    ('StripeUsageEvent', 'stripe_usage_event_isolation_policy'),
    ('Notification', 'notification_isolation_policy'),
    ('WebhookEndpoint', 'webhook_endpoint_isolation_policy'),
    ('CreditTransaction', 'credit_transaction_isolation_policy')
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_name, table_name);
    IF table_name = 'Tenant' THEN
      EXECUTE format('CREATE POLICY %I ON %I USING (is_current_platform_admin() OR "id" = (SELECT get_current_tenant())) WITH CHECK (is_current_platform_admin() OR "id" = (SELECT get_current_tenant()))', policy_name, table_name);
    ELSE
      EXECUTE format('CREATE POLICY %I ON %I USING (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant())) WITH CHECK (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()))', policy_name, table_name);
    END IF;
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS "AuditLog" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT,
  "action" TEXT NOT NULL,
  "resource" TEXT NOT NULL,
  "resourceId" TEXT,
  "oldValue" JSONB,
  "newValue" JSONB,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AuditLog_tenant_createdAt_idx" ON "AuditLog"("tenantId", "createdAt");
ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_log_isolation_policy ON "AuditLog";
CREATE POLICY audit_log_isolation_policy ON "AuditLog"
  USING (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()))
  WITH CHECK (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()));

CREATE OR REPLACE FUNCTION block_audit_log_modification()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE'
    AND current_setting('app.allow_audit_log_delete', true) = 'retention_expired' THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
    AND public.is_current_platform_admin()
    AND current_setting('app.audit_log_user_redaction_tenant', true) = OLD."tenantId"
    AND OLD."userId" IS NOT NULL
    AND NEW."userId" IS NULL
    AND ROW(
      NEW."id", NEW."tenantId", NEW."action", NEW."resource", NEW."resourceId",
      NEW."oldValue", NEW."newValue", NEW."ipAddress", NEW."userAgent", NEW."createdAt"
    ) IS NOT DISTINCT FROM ROW(
      OLD."id", OLD."tenantId", OLD."action", OLD."resource", OLD."resourceId",
      OLD."oldValue", OLD."newValue", OLD."ipAddress", OLD."userAgent", OLD."createdAt"
    ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Audit logs are append-only and cannot be modified or deleted.';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS tr_block_audit_log_update ON "AuditLog";
CREATE TRIGGER tr_block_audit_log_update BEFORE UPDATE ON "AuditLog"
FOR EACH ROW EXECUTE FUNCTION block_audit_log_modification();
DROP TRIGGER IF EXISTS tr_block_audit_log_delete ON "AuditLog";
CREATE TRIGGER tr_block_audit_log_delete BEFORE DELETE ON "AuditLog"
FOR EACH ROW EXECUTE FUNCTION block_audit_log_modification();
