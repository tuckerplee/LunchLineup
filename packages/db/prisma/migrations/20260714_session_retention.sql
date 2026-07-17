-- Bound expired and revoked authentication sessions while preserving active credentials.

CREATE INDEX IF NOT EXISTS "Session_revokedAt_idx"
    ON public."Session"("revokedAt");

CREATE OR REPLACE FUNCTION public.purge_dormant_sessions(
    p_as_of TIMESTAMP WITHOUT TIME ZONE DEFAULT (clock_timestamp() AT TIME ZONE 'UTC'),
    p_limit INTEGER DEFAULT 5000
)
RETURNS BIGINT AS $$
DECLARE
    deleted_count BIGINT;
BEGIN
    IF NOT public.is_current_platform_admin() THEN
        RAISE EXCEPTION 'dormant session retention purge requires platform admin capability'
            USING ERRCODE = '42501';
    END IF;

    IF p_limit < 1 OR p_limit > 10000 THEN
        RAISE EXCEPTION 'dormant session retention batch limit must be between 1 and 10000'
            USING ERRCODE = '22023';
    END IF;

    WITH expired AS (
        SELECT session."id"
        FROM public."Session" session
        WHERE session."expiresAt" <= p_as_of - INTERVAL '24 hours'
           OR (
                session."revokedAt" IS NOT NULL
                AND session."revokedAt" <= p_as_of - INTERVAL '30 days'
           )
        ORDER BY
            LEAST(
                session."expiresAt",
                COALESCE(session."revokedAt", 'infinity'::TIMESTAMP)
            ) ASC,
            session."id" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT p_limit
    )
    DELETE FROM public."Session" session
    USING expired
    WHERE session."id" = expired."id";

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public.purge_dormant_sessions(TIMESTAMP WITHOUT TIME ZONE, INTEGER)
FROM PUBLIC;
