-- Keep reversible user suspension separate from irreversible deletion and
-- enforce session invalidation even for direct database writes.

ALTER TABLE public."User"
ADD COLUMN IF NOT EXISTS "suspendedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "User_tenantId_deletedAt_suspendedAt_createdAt_id_idx"
ON public."User" ("tenantId", "deletedAt", "suspendedAt", "createdAt", "id");

CREATE INDEX IF NOT EXISTS "User_suspendedAt_idx"
ON public."User" ("suspendedAt");

-- A deleted user is an irreversible tombstone, never a suspended account.
CREATE OR REPLACE FUNCTION public.scrub_deleted_user_row()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."deletedAt" IS NULL THEN
        RETURN NEW;
    END IF;

    NEW."suspendedAt" := NULL;
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

CREATE OR REPLACE FUNCTION public.revoke_suspended_user_sessions()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."deletedAt" IS NOT NULL OR NEW."suspendedAt" IS NULL THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD."suspendedAt" IS NOT DISTINCT FROM NEW."suspendedAt" THEN
        RETURN NEW;
    END IF;

    UPDATE public."Session"
    SET "revokedAt" = NEW."suspendedAt"
    WHERE "userId" = NEW."id" AND "revokedAt" IS NULL;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.revoke_suspended_user_sessions() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.block_suspended_user_session_auth()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."revokedAt" IS NULL AND EXISTS (
        SELECT 1
        FROM public."User"
        WHERE "id" = NEW."userId"
          AND "deletedAt" IS NULL
          AND "suspendedAt" IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'Sessions for suspended users must remain revoked.' USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.block_suspended_user_session_auth() FROM PUBLIC;

DROP TRIGGER IF EXISTS tr_revoke_suspended_user_sessions ON public."User";
CREATE TRIGGER tr_revoke_suspended_user_sessions
AFTER INSERT OR UPDATE ON public."User"
FOR EACH ROW EXECUTE FUNCTION public.revoke_suspended_user_sessions();

DROP TRIGGER IF EXISTS tr_block_suspended_user_session_auth ON public."Session";
CREATE TRIGGER tr_block_suspended_user_session_auth
BEFORE INSERT OR UPDATE ON public."Session"
FOR EACH ROW EXECUTE FUNCTION public.block_suspended_user_session_auth();

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'User_deleted_suspension_exclusive_check'
          AND conrelid = 'public."User"'::regclass
    ) THEN
        ALTER TABLE public."User"
        ADD CONSTRAINT "User_deleted_suspension_exclusive_check"
        CHECK ("deletedAt" IS NULL OR "suspendedAt" IS NULL) NOT VALID;
    END IF;
END;
$$;

ALTER TABLE public."User"
VALIDATE CONSTRAINT "User_deleted_suspension_exclusive_check";
