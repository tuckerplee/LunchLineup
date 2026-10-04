-- Pending enrollment belongs to the exact Session, not a Redis key. This is
-- additive for old writers, but all enrollment owners must upgrade together:
-- an old Redis-only owner does not obey this authority or generation fence.
ALTER TABLE public."Session"
    ADD COLUMN IF NOT EXISTS "mfaEnrollmentSecret" TEXT,
    ADD COLUMN IF NOT EXISTS "mfaEnrollmentExpiresAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Session_mfaEnrollmentExpiresAt_id_idx"
    ON public."Session" ("mfaEnrollmentExpiresAt", "id");

-- Revocation writers, including raw anonymization and direct User lifecycle
-- triggers, retain Session rows. Erase pending material on every such write.
-- This trigger takes no User/Tenant locks, so Session-only logout and retention
-- do not acquire the reverse of the application's Tenant -> User -> Session.
CREATE OR REPLACE FUNCTION public.fence_session_mfa_enrollment()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND (NEW."userId" IS DISTINCT FROM OLD."userId"
                            OR NEW."id" IS DISTINCT FROM OLD."id") THEN
        RAISE EXCEPTION 'Session ownership is immutable' USING ERRCODE = '42501';
    END IF;
    IF NEW."revokedAt" IS NOT NULL THEN
        NEW."mfaEnrollmentSecret" := NULL;
        NEW."mfaEnrollmentExpiresAt" := NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
REVOKE ALL ON FUNCTION public.fence_session_mfa_enrollment() FROM PUBLIC;

DROP TRIGGER IF EXISTS tr_fence_session_mfa_enrollment ON public."Session";
CREATE TRIGGER tr_fence_session_mfa_enrollment
BEFORE INSERT OR UPDATE ON public."Session"
FOR EACH ROW EXECUTE FUNCTION public.fence_session_mfa_enrollment();

-- Account enable, disable/recovery, secret replacement and tenant rebinding
-- must invalidate ALL generations, including other active Sessions. The User
-- update already owns its row; lock only pending Sessions in deterministic
-- order. No User/Tenant locks are acquired from a Session trigger or sweep.
-- Confirmation first consumes its exact generation under the User fence,
-- then enables the account in the same transaction.
CREATE OR REPLACE FUNCTION public.invalidate_user_mfa_enrollments()
RETURNS TRIGGER AS $$
DECLARE
    pending_session RECORD;
BEGIN
    IF OLD."mfaEnabled" IS NOT DISTINCT FROM NEW."mfaEnabled"
       AND OLD."mfaSecret" IS NOT DISTINCT FROM NEW."mfaSecret"
       AND OLD."tenantId" IS NOT DISTINCT FROM NEW."tenantId" THEN
        RETURN NEW;
    END IF;
    FOR pending_session IN
        SELECT session."id"
        FROM public."Session" session
        WHERE session."userId" = NEW."id"
          AND session."mfaEnrollmentSecret" IS NOT NULL
        ORDER BY session."id"
        FOR UPDATE
    LOOP
        UPDATE public."Session"
        SET "mfaEnrollmentSecret" = NULL, "mfaEnrollmentExpiresAt" = NULL
        WHERE "id" = pending_session."id" AND "userId" = NEW."id";
    END LOOP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.invalidate_user_mfa_enrollments() FROM PUBLIC;

DROP TRIGGER IF EXISTS tr_invalidate_user_mfa_enrollments ON public."User";
CREATE TRIGGER tr_invalidate_user_mfa_enrollments
AFTER UPDATE OF "mfaEnabled", "mfaSecret", "tenantId" ON public."User"
FOR EACH ROW EXECUTE FUNCTION public.invalidate_user_mfa_enrollments();

-- Repeatable migration reconciliation clears revoked material, but never
-- repairs ambiguous active pairs or plaintext by guessing a valid generation.
UPDATE public."Session"
SET "mfaEnrollmentSecret" = NULL, "mfaEnrollmentExpiresAt" = NULL
WHERE "revokedAt" IS NOT NULL
  AND ("mfaEnrollmentSecret" IS NOT NULL OR "mfaEnrollmentExpiresAt" IS NOT NULL);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid = 'public."Session"'::regclass
                     AND conname = 'Session_mfa_enrollment_pair_check') THEN
        ALTER TABLE public."Session" ADD CONSTRAINT "Session_mfa_enrollment_pair_check"
            CHECK (("mfaEnrollmentSecret" IS NULL) = ("mfaEnrollmentExpiresAt" IS NULL)
                   AND ("mfaEnrollmentExpiresAt" IS NULL OR isfinite("mfaEnrollmentExpiresAt"))) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid = 'public."Session"'::regclass
                     AND conname = 'Session_revoked_mfa_enrollment_check') THEN
        ALTER TABLE public."Session" ADD CONSTRAINT "Session_revoked_mfa_enrollment_check"
            CHECK ("revokedAt" IS NULL OR
                   ("mfaEnrollmentSecret" IS NULL AND "mfaEnrollmentExpiresAt" IS NULL)) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid = 'public."Session"'::regclass
                     AND conname = 'Session_mfa_enrollment_encrypted_check') THEN
        ALTER TABLE public."Session" ADD CONSTRAINT "Session_mfa_enrollment_encrypted_check"
            CHECK ("mfaEnrollmentSecret" IS NULL OR (
                octet_length("mfaEnrollmentSecret") <= 4096 AND (
                    "mfaEnrollmentSecret" ~ '^enc:v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]+$'
                    OR "mfaEnrollmentSecret" ~ '^enc:v2:[0-9a-f]{16}:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]+$'
                )
            )) NOT VALID;
    END IF;
END;
$$;
ALTER TABLE public."Session" VALIDATE CONSTRAINT "Session_mfa_enrollment_pair_check";
ALTER TABLE public."Session" VALIDATE CONSTRAINT "Session_revoked_mfa_enrollment_check";
ALTER TABLE public."Session" VALIDATE CONSTRAINT "Session_mfa_enrollment_encrypted_check";

-- Erase expired pending material without deleting otherwise active Sessions.
-- The same platform capability as dormant-session retention is required.
-- Dry-run counts without row locks/writes. Execution is bounded and skips
-- locked Sessions; the locked current deadline is repeated in the UPDATE so
-- a fresh replacement generation is never erased by stale eligibility.
CREATE OR REPLACE FUNCTION public.clear_expired_mfa_enrollments(
    p_as_of TIMESTAMP WITHOUT TIME ZONE DEFAULT (clock_timestamp() AT TIME ZONE 'UTC'),
    p_limit INTEGER DEFAULT 5000,
    p_dry_run BOOLEAN DEFAULT FALSE
)
RETURNS TABLE ("eligibleCount" BIGINT, "clearedCount" BIGINT) AS $$
DECLARE
    cutoff TIMESTAMP WITHOUT TIME ZONE;
    eligible_count BIGINT;
    cleared_count BIGINT := 0;
BEGIN
    IF public.is_current_platform_admin() IS NOT TRUE THEN
        RAISE EXCEPTION 'MFA enrollment retention requires platform admin capability'
            USING ERRCODE = '42501';
    END IF;
    IF p_as_of IS NULL OR NOT isfinite(p_as_of)
       OR p_limit IS NULL OR p_limit < 1 OR p_limit > 10000
       OR p_dry_run IS NULL THEN
        RAISE EXCEPTION 'Invalid MFA enrollment retention parameters'
            USING ERRCODE = '22023';
    END IF;
    cutoff := LEAST(p_as_of, clock_timestamp() AT TIME ZONE 'UTC');
    SELECT COUNT(*) INTO eligible_count
    FROM public."Session" session
    WHERE session."mfaEnrollmentSecret" IS NOT NULL
      AND session."mfaEnrollmentExpiresAt" <= cutoff;

    IF NOT p_dry_run AND eligible_count > 0 THEN
        WITH expired AS (
            SELECT session."id"
            FROM public."Session" session
            WHERE session."mfaEnrollmentSecret" IS NOT NULL
              AND session."mfaEnrollmentExpiresAt" <= cutoff
            ORDER BY session."mfaEnrollmentExpiresAt", session."id"
            FOR UPDATE SKIP LOCKED
            LIMIT p_limit
        )
        UPDATE public."Session" session
        SET "mfaEnrollmentSecret" = NULL, "mfaEnrollmentExpiresAt" = NULL
        FROM expired
        WHERE session."id" = expired."id"
          AND session."mfaEnrollmentSecret" IS NOT NULL
          AND session."mfaEnrollmentExpiresAt" <= cutoff;
        GET DIAGNOSTICS cleared_count = ROW_COUNT;
    END IF;
    RETURN QUERY SELECT eligible_count, cleared_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.clear_expired_mfa_enrollments(TIMESTAMP WITHOUT TIME ZONE, INTEGER, BOOLEAN)
FROM PUBLIC;
