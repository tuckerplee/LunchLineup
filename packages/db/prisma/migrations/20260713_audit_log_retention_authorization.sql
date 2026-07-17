-- Replace the caller-controlled audit-delete GUC with a platform-admin-gated
-- SECURITY DEFINER retention function. The trigger marker is accepted only
-- while that owner function is executing in the same transaction.

CREATE OR REPLACE FUNCTION public.purge_expired_audit_logs(target_tenant_id TEXT)
RETURNS BIGINT AS $$
DECLARE
    deleted_count BIGINT;
BEGIN
    IF NOT public.is_current_platform_admin() THEN
        RAISE EXCEPTION 'audit log retention purge requires platform admin capability' USING ERRCODE = '42501';
    END IF;

    IF target_tenant_id IS NULL OR NOT EXISTS (
        SELECT 1
        FROM public."Tenant"
        WHERE "id" = target_tenant_id
          AND "status" = 'PURGED'::public."TenantStatus"
          AND "deletedAt" IS NOT NULL
          AND "deletedAt" <= CURRENT_TIMESTAMP - INTERVAL '7 years'
          AND "applicationDataPurgedAt" IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'tenant retained records are not eligible for audit purge' USING ERRCODE = '42501';
    END IF;

    PERFORM pg_catalog.set_config(
        'app.audit_log_retention_txid',
        pg_catalog.txid_current()::TEXT,
        TRUE
    );
    DELETE FROM public."AuditLog" WHERE "tenantId" = target_tenant_id;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    PERFORM pg_catalog.set_config('app.audit_log_retention_txid', '', TRUE);
    RETURN deleted_count;
EXCEPTION WHEN OTHERS THEN
    PERFORM pg_catalog.set_config('app.audit_log_retention_txid', '', TRUE);
    RAISE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.purge_expired_audit_logs(TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.audit_actor_pseudonym(
    target_tenant_id TEXT,
    target_user_id TEXT
)
RETURNS TEXT AS $$
    SELECT 'deleted-user:' || encode(
        public.digest(target_tenant_id || ':' || target_user_id, 'sha256'),
        'hex'
    );
$$ LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.audit_actor_pseudonym(TEXT, TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.redact_retained_tenant_audit_logs(target_tenant_id TEXT)
RETURNS BIGINT AS $$
DECLARE
    redacted_count BIGINT;
BEGIN
    IF NOT public.is_current_platform_admin() THEN
        RAISE EXCEPTION 'retained audit-log redaction requires platform admin capability'
            USING ERRCODE = '42501';
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
        RAISE EXCEPTION 'tenant is not eligible for retained audit-log redaction'
            USING ERRCODE = '42501';
    END IF;

    PERFORM pg_catalog.set_config(
        'app.audit_log_redaction_txid',
        pg_catalog.txid_current()::TEXT,
        TRUE
    );
    UPDATE public."AuditLog"
    SET
        "userId" = NULL,
        "actorUserId" = CASE
            WHEN "actorUserId" IS NULL OR "actorUserId" LIKE 'deleted-user:%'
                THEN "actorUserId"
            ELSE public.audit_actor_pseudonym("tenantId", "actorUserId")
        END,
        "oldValue" = NULL,
        "newValue" = NULL,
        "ipAddress" = NULL,
        "userAgent" = NULL
    WHERE "tenantId" = target_tenant_id;
    GET DIAGNOSTICS redacted_count = ROW_COUNT;
    PERFORM pg_catalog.set_config('app.audit_log_redaction_txid', '', TRUE);
    RETURN redacted_count;
EXCEPTION WHEN OTHERS THEN
    PERFORM pg_catalog.set_config('app.audit_log_redaction_txid', '', TRUE);
    RAISE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.redact_retained_tenant_audit_logs(TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.redact_deleted_user_audit_records(
    target_tenant_id TEXT,
    target_user_id TEXT
)
RETURNS BIGINT AS $$
DECLARE
    redacted_count BIGINT;
BEGIN
    IF target_tenant_id IS NULL OR target_user_id IS NULL OR NOT EXISTS (
        SELECT 1
        FROM public."User"
        WHERE "id" = target_user_id
          AND "tenantId" = target_tenant_id
          AND "deletedAt" IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'audit-log user redaction requires a deleted tenant user'
            USING ERRCODE = '42501';
    END IF;

    PERFORM pg_catalog.set_config(
        'app.audit_log_redaction_txid',
        pg_catalog.txid_current()::TEXT,
        TRUE
    );
    UPDATE public."AuditLog"
    SET
        "userId" = CASE
            WHEN "userId" = target_user_id THEN NULL
            ELSE "userId"
        END,
        "actorUserId" = CASE
            WHEN "actorUserId" = target_user_id
                THEN public.audit_actor_pseudonym(target_tenant_id, target_user_id)
            ELSE "actorUserId"
        END,
        "oldValue" = NULL,
        "newValue" = NULL,
        "ipAddress" = NULL,
        "userAgent" = NULL
    WHERE "tenantId" = target_tenant_id
      AND ("userId" = target_user_id OR "actorUserId" = target_user_id);
    GET DIAGNOSTICS redacted_count = ROW_COUNT;
    PERFORM pg_catalog.set_config('app.audit_log_redaction_txid', '', TRUE);
    RETURN redacted_count;
EXCEPTION WHEN OTHERS THEN
    PERFORM pg_catalog.set_config('app.audit_log_redaction_txid', '', TRUE);
    RAISE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.redact_deleted_user_audit_records(TEXT, TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.block_audit_log_modification()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE'
        AND public.is_current_platform_admin()
        AND CURRENT_USER = (
            SELECT pg_catalog.pg_get_userbyid(proowner)
            FROM pg_catalog.pg_proc
            WHERE oid = 'public.purge_expired_audit_logs(text)'::pg_catalog.regprocedure
        )
        AND current_setting('app.audit_log_retention_txid', TRUE) = pg_catalog.txid_current()::TEXT THEN
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE'
        AND CURRENT_USER = (
            SELECT pg_catalog.pg_get_userbyid(proowner)
            FROM pg_catalog.pg_proc
            WHERE oid = 'public.redact_retained_tenant_audit_logs(text)'::pg_catalog.regprocedure
        )
        AND current_setting('app.audit_log_redaction_txid', TRUE) = pg_catalog.txid_current()::TEXT
        AND ROW(
            NEW."id", NEW."tenantId", NEW."actorTenantId", NEW."action",
            NEW."resource", NEW."resourceId", NEW."createdAt"
        ) IS NOT DISTINCT FROM ROW(
            OLD."id", OLD."tenantId", OLD."actorTenantId", OLD."action",
            OLD."resource", OLD."resourceId", OLD."createdAt"
        )
        AND (
            NEW."userId" IS NOT DISTINCT FROM OLD."userId"
            OR NEW."userId" IS NULL
        )
        AND (
            NEW."actorUserId" IS NOT DISTINCT FROM OLD."actorUserId"
            OR NEW."actorUserId" LIKE 'deleted-user:%'
        )
        AND (NEW."oldValue" IS NOT DISTINCT FROM OLD."oldValue" OR NEW."oldValue" IS NULL)
        AND (NEW."newValue" IS NOT DISTINCT FROM OLD."newValue" OR NEW."newValue" IS NULL)
        AND (NEW."ipAddress" IS NOT DISTINCT FROM OLD."ipAddress" OR NEW."ipAddress" IS NULL)
        AND (NEW."userAgent" IS NOT DISTINCT FROM OLD."userAgent" OR NEW."userAgent" IS NULL) THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE'
        AND public.is_current_platform_admin()
        AND current_setting('app.audit_log_user_redaction_tenant', TRUE) = OLD."tenantId"
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

DROP TRIGGER IF EXISTS tr_block_audit_log_update ON public."AuditLog";
CREATE TRIGGER tr_block_audit_log_update BEFORE UPDATE ON public."AuditLog"
FOR EACH ROW EXECUTE FUNCTION public.block_audit_log_modification();
DROP TRIGGER IF EXISTS tr_block_audit_log_delete ON public."AuditLog";
CREATE TRIGGER tr_block_audit_log_delete BEFORE DELETE ON public."AuditLog"
FOR EACH ROW EXECUTE FUNCTION public.block_audit_log_modification();
