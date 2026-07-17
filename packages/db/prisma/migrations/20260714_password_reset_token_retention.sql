-- Bound terminal password-reset token hashes while preserving active credentials.

CREATE INDEX IF NOT EXISTS "PasswordResetToken_retentionDeadline_id_idx"
    ON public."PasswordResetToken" ((COALESCE("consumedAt", "expiresAt")), "id");

CREATE OR REPLACE FUNCTION public.purge_expired_password_reset_tokens(
    p_as_of TIMESTAMP WITHOUT TIME ZONE DEFAULT (clock_timestamp() AT TIME ZONE 'UTC'),
    p_limit INTEGER DEFAULT 5000
)
RETURNS BIGINT AS $$
DECLARE
    deleted_count BIGINT;
BEGIN
    IF NOT public.is_current_platform_admin() THEN
        RAISE EXCEPTION 'password reset token retention purge requires platform admin capability'
            USING ERRCODE = '42501';
    END IF;

    IF p_limit < 1 OR p_limit > 10000 THEN
        RAISE EXCEPTION 'password reset token retention batch limit must be between 1 and 10000'
            USING ERRCODE = '22023';
    END IF;

    WITH eligible AS (
        SELECT token."id"
        FROM public."PasswordResetToken" token
        WHERE COALESCE(token."consumedAt", token."expiresAt")
            <= p_as_of - INTERVAL '24 hours'
        ORDER BY COALESCE(token."consumedAt", token."expiresAt") ASC, token."id" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT p_limit
    )
    DELETE FROM public."PasswordResetToken" token
    USING eligible
    WHERE token."id" = eligible."id";

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public.purge_expired_password_reset_tokens(TIMESTAMP WITHOUT TIME ZONE, INTEGER)
FROM PUBLIC;