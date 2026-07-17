-- Enforce irreversible user-row anonymization and authentication-material
-- invalidation for both API deletions and direct database soft deletes.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.scrub_deleted_user_row()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."deletedAt" IS NULL THEN
        RETURN NEW;
    END IF;

    NEW."name" := 'Deleted user';
    NEW."email" := NULL;
    NEW."username" := NULL;
    NEW."emailEncrypted" := NULL;
    NEW."emailHash" := NULL;
    NEW."nameEncrypted" := NULL;
    NEW."phone" := NULL;
    NEW."phoneEncrypted" := NULL;
    NEW."phoneHash" := NULL;
    NEW."oidcIssuer" := NULL;
    NEW."oidcSubject" := NULL;
    NEW."passwordHash" := NULL;
    NEW."pinHash" := NULL;
    NEW."pinSetAt" := NULL;
    NEW."pinResetRequired" := FALSE;
    NEW."pinLoginAttempts" := 0;
    NEW."pinLockedUntil" := NULL;
    NEW."mfaEnabled" := FALSE;
    NEW."mfaSecret" := NULL;
    NEW."mfaBackupCodes" := ARRAY[]::TEXT[];
    NEW."loginAttempts" := 0;
    NEW."lockedUntil" := NULL;
    NEW."lastLoginAt" := NULL;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
REVOKE ALL ON FUNCTION public.scrub_deleted_user_row() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.invalidate_deleted_user_auth_artifacts()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."deletedAt" IS NULL THEN
        RETURN NEW;
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

CREATE OR REPLACE FUNCTION public.block_deleted_user_session_auth()
RETURNS TRIGGER AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public."User"
        WHERE "id" = NEW."userId" AND "deletedAt" IS NOT NULL
    ) AND (
        NEW."revokedAt" IS NULL
        OR NEW."selectorHash" IS NOT NULL
        OR NEW."refreshToken" IS DISTINCT FROM encode(public.digest('deleted-session:' || NEW."id", 'sha256'), 'hex')
        OR NEW."ipAddress" IS DISTINCT FROM '[deleted]'
        OR NEW."userAgent" IS DISTINCT FROM '[deleted]'
    ) THEN
        RAISE EXCEPTION 'Sessions for deleted users must remain revoked and anonymized.' USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.block_deleted_user_session_auth() FROM PUBLIC;

DROP TRIGGER IF EXISTS tr_block_deleted_user_session_auth ON public."Session";
CREATE TRIGGER tr_block_deleted_user_session_auth
BEFORE INSERT OR UPDATE ON public."Session"
FOR EACH ROW EXECUTE FUNCTION public.block_deleted_user_session_auth();
DROP TRIGGER IF EXISTS tr_scrub_deleted_user_row ON public."User";
CREATE TRIGGER tr_scrub_deleted_user_row
BEFORE INSERT OR UPDATE ON public."User"
FOR EACH ROW EXECUTE FUNCTION public.scrub_deleted_user_row();

DROP TRIGGER IF EXISTS tr_invalidate_deleted_user_auth_artifacts ON public."User";
CREATE TRIGGER tr_invalidate_deleted_user_auth_artifacts
AFTER INSERT OR UPDATE ON public."User"
FOR EACH ROW EXECUTE FUNCTION public.invalidate_deleted_user_auth_artifacts();

-- Reconcile historical soft-deleted users through the same trigger contract.
UPDATE public."User"
SET "deletedAt" = "deletedAt"
WHERE "deletedAt" IS NOT NULL;
