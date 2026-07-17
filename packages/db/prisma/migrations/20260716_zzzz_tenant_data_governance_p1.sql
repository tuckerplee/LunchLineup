-- Fail closed when platform capability proof is absent and harden the
-- tenant-retention and export-artifact ownership boundaries.

CREATE OR REPLACE FUNCTION public.is_current_platform_admin()
RETURNS BOOLEAN AS $$
DECLARE
    expected_hash TEXT;
BEGIN
    SELECT capability.secret_hash INTO expected_hash
    FROM lunchlineup_private.platform_admin_capability capability
    WHERE capability.singleton = TRUE;

    RETURN COALESCE(
        expected_hash IS NOT NULL
        AND pg_catalog.current_setting('app.platform_admin_proof', TRUE) = expected_hash,
        FALSE
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, lunchlineup_private;

CREATE OR REPLACE FUNCTION public.lock_tenant_lifecycle(target_tenant_id TEXT)
RETURNS VOID AS $$
BEGIN
    IF target_tenant_id IS NULL OR btrim(target_tenant_id) = '' THEN
        RAISE EXCEPTION 'tenant lifecycle lock requires a tenant id'
            USING ERRCODE = '22023';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(target_tenant_id, 20260711)
    );
END;
$$ LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog;

CREATE OR REPLACE FUNCTION public.purge_expired_audit_logs(target_tenant_id TEXT)
RETURNS BIGINT AS $$
DECLARE
    deleted_count BIGINT;
BEGIN
    IF public.is_current_platform_admin() IS NOT TRUE THEN
        RAISE EXCEPTION 'audit log retention purge requires platform admin capability'
            USING ERRCODE = '42501';
    END IF;

    PERFORM public.lock_tenant_lifecycle(target_tenant_id);

    IF target_tenant_id IS NULL OR NOT EXISTS (
        SELECT 1
        FROM public."Tenant"
        WHERE "id" = target_tenant_id
          AND "status" = 'PURGED'::public."TenantStatus"
          AND "deletedAt" IS NOT NULL
          AND "deletedAt" <= CURRENT_TIMESTAMP - INTERVAL '7 years'
          AND "applicationDataPurgedAt" IS NOT NULL
          AND "retentionLegalHoldAt" IS NULL
    ) THEN
        RAISE EXCEPTION 'tenant retained records are not eligible for audit purge'
            USING ERRCODE = '42501';
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

CREATE OR REPLACE FUNCTION public.redact_retained_tenant_audit_logs(target_tenant_id TEXT)
RETURNS BIGINT AS $$
DECLARE
    redacted_count BIGINT;
BEGIN
    IF public.is_current_platform_admin() IS NOT TRUE THEN
        RAISE EXCEPTION 'retained audit-log redaction requires platform admin capability'
            USING ERRCODE = '42501';
    END IF;

    PERFORM public.lock_tenant_lifecycle(target_tenant_id);

    IF target_tenant_id IS NULL OR NOT EXISTS (
        SELECT 1
        FROM public."Tenant"
        WHERE "id" = target_tenant_id
          AND "status" = 'PURGED'::public."TenantStatus"
          AND "deletedAt" IS NOT NULL
          AND "deletedAt" <= CURRENT_TIMESTAMP - INTERVAL '30 days'
          AND "applicationDataPurgedAt" IS NULL
          AND "retentionLegalHoldAt" IS NULL
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
    IF public.is_current_platform_admin() IS NOT TRUE
       AND pg_catalog.pg_trigger_depth() < 1 THEN
        RAISE EXCEPTION 'audit-log user redaction requires platform admin capability or the user-deletion trigger'
            USING ERRCODE = '42501';
    END IF;

    PERFORM public.lock_tenant_lifecycle(target_tenant_id);

    IF target_tenant_id IS NULL OR NOT EXISTS (
        SELECT 1
        FROM public."Tenant"
        WHERE "id" = target_tenant_id
          AND "retentionLegalHoldAt" IS NULL
    ) THEN
        RAISE EXCEPTION 'audit-log user redaction is blocked by tenant retention policy'
            USING ERRCODE = '42501';
    END IF;

    IF target_user_id IS NULL OR NOT EXISTS (
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

CREATE OR REPLACE FUNCTION public.block_audit_actor_identity_modification()
RETURNS TRIGGER AS $$
BEGIN
    IF pg_catalog.current_setting('app.audit_log_redaction_txid', TRUE)
            = pg_catalog.txid_current()::TEXT
       AND NEW."actorTenantId" IS NOT DISTINCT FROM OLD."actorTenantId"
       AND (
           NEW."actorUserId" IS NOT DISTINCT FROM OLD."actorUserId"
           OR NEW."actorUserId" LIKE 'deleted-user:%'
       ) THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Audit actor identity is immutable.';
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION public.block_audit_actor_identity_modification() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.invalidate_deleted_user_auth_artifacts()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."deletedAt" IS NULL THEN
        RETURN NEW;
    END IF;

    PERFORM public.lock_tenant_lifecycle(NEW."tenantId");
    IF EXISTS (
        SELECT 1
        FROM public."Tenant"
        WHERE "id" = NEW."tenantId"
          AND "retentionLegalHoldAt" IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'user deletion is blocked by tenant retention legal hold'
            USING ERRCODE = '42501';
    END IF;

    DELETE FROM public."RefreshTokenReplay"
    WHERE "sessionId" IN (
        SELECT "id" FROM public."Session" WHERE "userId" = NEW."id"
    );
    UPDATE public."Session"
    SET "selectorHash" = NULL,
        "refreshToken" = encode(public.digest('deleted-session:' || "id", 'sha256'), 'hex'),
        "ipAddress" = '[deleted]',
        "userAgent" = '[deleted]',
        "revokedAt" = NEW."deletedAt"
    WHERE "userId" = NEW."id";

    DELETE FROM public."PasswordResetEmailOutbox"
    WHERE "tenantId" = NEW."tenantId" AND "userId" = NEW."id";
    DELETE FROM public."PasswordResetToken"
    WHERE "tenantId" = NEW."tenantId" AND "userId" = NEW."id";
    DELETE FROM public."MfaTotpClaim"
    WHERE "tenantId" = NEW."tenantId" AND "userId" = NEW."id";
    DELETE FROM public."RoleAssignment"
    WHERE "tenantId" = NEW."tenantId" AND "userId" = NEW."id";
    DELETE FROM public."OnboardingSignupAttempt"
    WHERE "tenantId" = NEW."tenantId" AND "userId" = NEW."id";
    DELETE FROM public."Notification"
    WHERE "tenantId" = NEW."tenantId" AND "userId" = NEW."id";

    PERFORM public.redact_deleted_user_audit_records(NEW."tenantId", NEW."id");
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.invalidate_deleted_user_auth_artifacts() FROM PUBLIC;

UPDATE public."TenantExportJob"
SET "artifactCleanupState" = 'PENDING',
    "bytes" = CASE
        WHEN "bytes" = 0 AND ("artifactKey" IS NOT NULL OR "claimToken" IS NOT NULL)
            THEN 2147483647
        ELSE "bytes"
    END
WHERE "artifactCleanupState" = 'NONE'
  AND ("artifactKey" IS NOT NULL OR "claimToken" IS NOT NULL OR "bytes" > 0)
  AND "state" IN ('FAILED', 'EXPIRED');

ALTER TABLE public."TenantExportJob"
    DROP CONSTRAINT IF EXISTS "TenantExportJob_artifact_cleanup_state_check",
    DROP CONSTRAINT IF EXISTS "TenantExportJob_artifact_cleanup_attempts_check",
    DROP CONSTRAINT IF EXISTS "TenantExportJob_artifact_cleanup_owner_check";

ALTER TABLE public."TenantExportJob"
    ADD CONSTRAINT "TenantExportJob_artifact_cleanup_state_check"
        CHECK ("artifactCleanupState" IN ('NONE', 'PENDING', 'COMPLETE')),
    ADD CONSTRAINT "TenantExportJob_artifact_cleanup_attempts_check"
        CHECK ("artifactCleanupAttempts" >= 0),
    ADD CONSTRAINT "TenantExportJob_artifact_cleanup_owner_check"
        CHECK (
            ("artifactCleanupState" = 'NONE'
                AND "artifactCleanupOwner" IS NULL
                AND "artifactCleanupLeaseExpiresAt" IS NULL)
            OR ("artifactCleanupState" = 'PENDING'
                AND ("bytes" > 0 OR "artifactKey" IS NOT NULL OR "claimToken" IS NOT NULL))
            OR ("artifactCleanupState" = 'COMPLETE'
                AND "artifactCleanupOwner" IS NULL
                AND "artifactCleanupLeaseExpiresAt" IS NULL
                AND "bytes" = 0
                AND "artifactKey" IS NULL
                AND "claimToken" IS NULL
                AND "claimExpiresAt" IS NULL)
        );

CREATE OR REPLACE FUNCTION public.enforce_tenant_export_artifact_cleanup()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD."bytes" > 0
           OR OLD."artifactKey" IS NOT NULL
           OR OLD."claimToken" IS NOT NULL
           OR OLD."artifactCleanupState" = 'PENDING' THEN
            RAISE EXCEPTION 'tenant export artifact cleanup is not complete'
                USING ERRCODE = '55000';
        END IF;
        RETURN OLD;
    END IF;

    IF (
        NEW."bytes" IS DISTINCT FROM OLD."bytes"
        OR NEW."artifactKey" IS DISTINCT FROM OLD."artifactKey"
        OR NEW."claimToken" IS DISTINCT FROM OLD."claimToken"
        OR NEW."claimExpiresAt" IS DISTINCT FROM OLD."claimExpiresAt"
        OR NEW."artifactCleanupState" IS DISTINCT FROM OLD."artifactCleanupState"
        OR NEW."artifactCleanupOwner" IS DISTINCT FROM OLD."artifactCleanupOwner"
        OR NEW."artifactCleanupLeaseExpiresAt" IS DISTINCT FROM OLD."artifactCleanupLeaseExpiresAt"
        OR NEW."artifactCleanupAttempts" IS DISTINCT FROM OLD."artifactCleanupAttempts"
    ) AND public.is_current_platform_admin() IS NOT TRUE THEN
        RAISE EXCEPTION 'tenant export artifact ownership requires platform capability'
            USING ERRCODE = '42501';
    END IF;

    IF OLD."artifactCleanupState" = 'PENDING'
       AND NEW."artifactCleanupState" <> 'COMPLETE'
       AND (
           NEW."bytes" < OLD."bytes"
           OR (OLD."artifactKey" IS NOT NULL AND NEW."artifactKey" IS NULL)
           OR (OLD."claimToken" IS NOT NULL AND NEW."claimToken" IS NULL)
       ) THEN
        RAISE EXCEPTION 'tenant export artifact ownership cannot be released before cleanup'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.enforce_tenant_export_artifact_cleanup() FROM PUBLIC;

DROP TRIGGER IF EXISTS tr_enforce_tenant_export_artifact_cleanup
    ON public."TenantExportJob";
CREATE TRIGGER tr_enforce_tenant_export_artifact_cleanup
BEFORE UPDATE OR DELETE ON public."TenantExportJob"
FOR EACH ROW EXECUTE FUNCTION public.enforce_tenant_export_artifact_cleanup();
