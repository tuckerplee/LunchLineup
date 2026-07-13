-- Permit only purge-time AuditLog.userId redaction for one explicitly authorized
-- tenant while retaining the append-only contract for every other mutation.

CREATE OR REPLACE FUNCTION set_audit_log_user_redaction_tenant(target_tenant_id TEXT)
RETURNS VOID AS $$
BEGIN
    IF NOT public.is_current_platform_admin() THEN
        RAISE EXCEPTION 'audit log user redaction requires platform admin capability' USING ERRCODE = '42501';
    END IF;

    IF target_tenant_id IS NULL OR NOT EXISTS (
        SELECT 1
        FROM public."Tenant"
        WHERE "id" = target_tenant_id
          AND "status" = 'PURGED'::public."TenantStatus"
          AND "deletedAt" IS NOT NULL
          AND "deletedAt" <= CURRENT_TIMESTAMP - INTERVAL '30 days'
          AND "applicationDataPurgedAt" IS NULL
    ) THEN
        RAISE EXCEPTION 'tenant is not eligible for audit log user redaction' USING ERRCODE = '42501';
    END IF;

    PERFORM pg_catalog.set_config('app.audit_log_user_redaction_tenant', target_tenant_id, true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION set_audit_log_user_redaction_tenant(TEXT) FROM PUBLIC;

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
