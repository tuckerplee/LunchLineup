-- Bound stable onboarding identity and organization hashes to the active
-- challenge/recovery period plus a 24-hour abuse-prevention buffer.

CREATE INDEX IF NOT EXISTS "OnboardingSignupAttempt_retentionDeadline_idx"
ON public."OnboardingSignupAttempt" (
    GREATEST(
        "updatedAt",
        "otpExpiresAt",
        COALESCE("recoveryExpiresAt", '-infinity'::TIMESTAMP)
    )
);

CREATE OR REPLACE FUNCTION public.purge_expired_onboarding_signup_attempts(
    p_as_of TIMESTAMP WITHOUT TIME ZONE DEFAULT (clock_timestamp() AT TIME ZONE 'UTC')
)
RETURNS BIGINT AS $$
DECLARE
    deleted_count BIGINT;
BEGIN
    IF NOT public.is_current_platform_admin() THEN
        RAISE EXCEPTION 'onboarding signup-attempt retention purge requires platform admin capability'
            USING ERRCODE = '42501';
    END IF;

    DELETE FROM public."OnboardingSignupAttempt"
    WHERE GREATEST(
        "updatedAt",
        "otpExpiresAt",
        COALESCE("recoveryExpiresAt", '-infinity'::TIMESTAMP)
    ) <= p_as_of - INTERVAL '24 hours';

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public.purge_expired_onboarding_signup_attempts(TIMESTAMP WITHOUT TIME ZONE)
FROM PUBLIC;
