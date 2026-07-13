-- Force row-level security and cover tenant-scoped relation tables.

ALTER TABLE "Tenant" FORCE ROW LEVEL SECURITY;
ALTER TABLE "User" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Location" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Schedule" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Shift" FORCE ROW LEVEL SECURITY;
ALTER TABLE "TimeCard" FORCE ROW LEVEL SECURITY;
ALTER TABLE "TenantSetting" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Role" FORCE ROW LEVEL SECURITY;
ALTER TABLE "BillingEvent" FORCE ROW LEVEL SECURITY;
ALTER TABLE "StripeUsageEvent" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Notification" FORCE ROW LEVEL SECURITY;
ALTER TABLE "WebhookEndpoint" FORCE ROW LEVEL SECURITY;
ALTER TABLE "CreditTransaction" FORCE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog" FORCE ROW LEVEL SECURITY;

ALTER TABLE "Session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Session" FORCE ROW LEVEL SECURITY;

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

ALTER TABLE "RolePermission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RolePermission" FORCE ROW LEVEL SECURITY;

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

ALTER TABLE "RoleAssignment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RoleAssignment" FORCE ROW LEVEL SECURITY;

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

ALTER TABLE "Break" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Break" FORCE ROW LEVEL SECURITY;

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
