-- Add a capability-authenticated transaction-local platform-admin context for
-- cross-tenant operational routes while preserving tenant RLS isolation.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS lunchlineup_private;
REVOKE ALL ON SCHEMA lunchlineup_private FROM PUBLIC;

CREATE TABLE IF NOT EXISTS lunchlineup_private.platform_admin_capability (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    secret_hash TEXT NOT NULL
);
REVOKE ALL ON lunchlineup_private.platform_admin_capability FROM PUBLIC;

DROP FUNCTION IF EXISTS set_current_platform_admin(BOOLEAN);
CREATE OR REPLACE FUNCTION set_current_platform_admin(enabled BOOLEAN, capability TEXT) RETURNS VOID AS $$
DECLARE
    expected_hash TEXT;
BEGIN
    SELECT secret_hash INTO expected_hash
    FROM lunchlineup_private.platform_admin_capability
    WHERE singleton = TRUE;
    IF expected_hash IS NULL THEN
        RAISE EXCEPTION 'platform admin database capability is not provisioned' USING ERRCODE = '42501';
    END IF;
    IF enabled AND (capability IS NULL OR encode(public.digest(capability, 'sha256'), 'hex') <> expected_hash) THEN
        RAISE EXCEPTION 'invalid platform admin database capability' USING ERRCODE = '42501';
    END IF;
    PERFORM pg_catalog.set_config('app.platform_admin_proof', CASE WHEN enabled THEN expected_hash ELSE '' END, true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, lunchlineup_private;
REVOKE ALL ON FUNCTION set_current_platform_admin(BOOLEAN, TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION is_current_platform_admin() RETURNS BOOLEAN AS $$
DECLARE
    expected_hash TEXT;
BEGIN
    SELECT secret_hash INTO expected_hash
    FROM lunchlineup_private.platform_admin_capability
    WHERE singleton = TRUE;
    RETURN expected_hash IS NOT NULL
        AND current_setting('app.platform_admin_proof', true) = expected_hash;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, lunchlineup_private;

DROP POLICY IF EXISTS tenant_isolation_policy ON "Tenant";
CREATE POLICY tenant_isolation_policy ON "Tenant"
    USING (is_current_platform_admin() OR "id" = (SELECT get_current_tenant()))
    WITH CHECK (is_current_platform_admin() OR "id" = (SELECT get_current_tenant()));

DROP POLICY IF EXISTS user_isolation_policy ON "User";
CREATE POLICY user_isolation_policy ON "User"
    USING (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()))
    WITH CHECK (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()));

DROP POLICY IF EXISTS location_isolation_policy ON "Location";
CREATE POLICY location_isolation_policy ON "Location"
    USING (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()))
    WITH CHECK (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()));

DROP POLICY IF EXISTS schedule_isolation_policy ON "Schedule";
CREATE POLICY schedule_isolation_policy ON "Schedule"
    USING (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()))
    WITH CHECK (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()));

DROP POLICY IF EXISTS shift_isolation_policy ON "Shift";
CREATE POLICY shift_isolation_policy ON "Shift"
    USING (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()))
    WITH CHECK (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()));

DROP POLICY IF EXISTS time_card_isolation_policy ON "TimeCard";
CREATE POLICY time_card_isolation_policy ON "TimeCard"
    USING (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()))
    WITH CHECK (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()));

DROP POLICY IF EXISTS tenant_setting_isolation_policy ON "TenantSetting";
CREATE POLICY tenant_setting_isolation_policy ON "TenantSetting"
    USING (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()))
    WITH CHECK (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()));

DROP POLICY IF EXISTS role_isolation_policy ON "Role";
CREATE POLICY role_isolation_policy ON "Role"
    USING (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()))
    WITH CHECK (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()));

DROP POLICY IF EXISTS billing_event_isolation_policy ON "BillingEvent";
CREATE POLICY billing_event_isolation_policy ON "BillingEvent"
    USING (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()))
    WITH CHECK (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()));

DROP POLICY IF EXISTS stripe_usage_event_isolation_policy ON "StripeUsageEvent";
CREATE POLICY stripe_usage_event_isolation_policy ON "StripeUsageEvent"
    USING (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()))
    WITH CHECK (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()));

DROP POLICY IF EXISTS notification_isolation_policy ON "Notification";
CREATE POLICY notification_isolation_policy ON "Notification"
    USING (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()))
    WITH CHECK (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()));

DROP POLICY IF EXISTS webhook_endpoint_isolation_policy ON "WebhookEndpoint";
CREATE POLICY webhook_endpoint_isolation_policy ON "WebhookEndpoint"
    USING (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()))
    WITH CHECK (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()));

DROP POLICY IF EXISTS credit_transaction_isolation_policy ON "CreditTransaction";
CREATE POLICY credit_transaction_isolation_policy ON "CreditTransaction"
    USING (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()))
    WITH CHECK (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()));

DROP POLICY IF EXISTS audit_log_tenant_isolation_policy ON "AuditLog";
CREATE POLICY audit_log_tenant_isolation_policy ON "AuditLog"
    USING (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()))
    WITH CHECK (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()));

DROP POLICY IF EXISTS session_tenant_isolation_policy ON "Session";
CREATE POLICY session_tenant_isolation_policy ON "Session"
    USING (
        is_current_platform_admin()
        OR EXISTS (
            SELECT 1
            FROM "User" u
            WHERE u."id" = "userId"
              AND u."tenantId" = (SELECT get_current_tenant())
        )
    )
    WITH CHECK (
        is_current_platform_admin()
        OR EXISTS (
            SELECT 1
            FROM "User" u
            WHERE u."id" = "userId"
              AND u."tenantId" = (SELECT get_current_tenant())
        )
    );

DROP POLICY IF EXISTS role_permission_tenant_isolation_policy ON "RolePermission";
CREATE POLICY role_permission_tenant_isolation_policy ON "RolePermission"
    USING (
        is_current_platform_admin()
        OR EXISTS (
            SELECT 1
            FROM "Role" r
            WHERE r."id" = "roleId"
              AND r."tenantId" = (SELECT get_current_tenant())
        )
    )
    WITH CHECK (
        is_current_platform_admin()
        OR EXISTS (
            SELECT 1
            FROM "Role" r
            WHERE r."id" = "roleId"
              AND r."tenantId" = (SELECT get_current_tenant())
        )
    );

DROP POLICY IF EXISTS role_assignment_tenant_isolation_policy ON "RoleAssignment";
CREATE POLICY role_assignment_tenant_isolation_policy ON "RoleAssignment"
    USING (
        is_current_platform_admin()
        OR (
            "tenantId" = (SELECT get_current_tenant())
            AND
            EXISTS (
                SELECT 1
                FROM "User" u
                WHERE u."id" = "userId"
                  AND u."tenantId" = (SELECT get_current_tenant())
            )
            AND EXISTS (
                SELECT 1
                FROM "Role" r
                WHERE r."id" = "roleId"
                  AND r."tenantId" = (SELECT get_current_tenant())
            )
        )
    )
    WITH CHECK (
        is_current_platform_admin()
        OR (
            "tenantId" = (SELECT get_current_tenant())
            AND
            EXISTS (
                SELECT 1
                FROM "User" u
                WHERE u."id" = "userId"
                  AND u."tenantId" = (SELECT get_current_tenant())
            )
            AND EXISTS (
                SELECT 1
                FROM "Role" r
                WHERE r."id" = "roleId"
                  AND r."tenantId" = (SELECT get_current_tenant())
            )
        )
    );

DROP POLICY IF EXISTS break_tenant_isolation_policy ON "Break";
CREATE POLICY break_tenant_isolation_policy ON "Break"
    USING (
        is_current_platform_admin()
        OR EXISTS (
            SELECT 1
            FROM "Shift" s
            WHERE s."id" = "shiftId"
              AND s."tenantId" = (SELECT get_current_tenant())
        )
    )
    WITH CHECK (
        is_current_platform_admin()
        OR EXISTS (
            SELECT 1
            FROM "Shift" s
            WHERE s."id" = "shiftId"
              AND s."tenantId" = (SELECT get_current_tenant())
        )
    );
