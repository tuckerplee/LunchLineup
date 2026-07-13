-- Replace the caller-controlled platform-admin GUC with a private,
-- capability-authenticated proof that direct SQL cannot self-assert.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS lunchlineup_private;
REVOKE ALL ON SCHEMA lunchlineup_private FROM PUBLIC;

CREATE TABLE IF NOT EXISTS lunchlineup_private.platform_admin_capability (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    secret_hash TEXT NOT NULL
);
REVOKE ALL ON lunchlineup_private.platform_admin_capability FROM PUBLIC;

DROP FUNCTION IF EXISTS set_current_platform_admin(BOOLEAN);
CREATE OR REPLACE FUNCTION set_current_platform_admin(enabled BOOLEAN, capability TEXT) RETURNS VOID AS $$
DECLARE
    expected_hash TEXT;
BEGIN
    SELECT secret_hash INTO expected_hash
    FROM lunchlineup_private.platform_admin_capability
    WHERE singleton = TRUE;
    IF expected_hash IS NULL THEN
        RAISE EXCEPTION 'platform admin database capability is not provisioned' USING ERRCODE = '42501';
    END IF;
    IF enabled AND (capability IS NULL OR encode(public.digest(capability, 'sha256'), 'hex') <> expected_hash) THEN
        RAISE EXCEPTION 'invalid platform admin database capability' USING ERRCODE = '42501';
    END IF;
    PERFORM pg_catalog.set_config('app.platform_admin_proof', CASE WHEN enabled THEN expected_hash ELSE '' END, true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, lunchlineup_private;
REVOKE ALL ON FUNCTION set_current_platform_admin(BOOLEAN, TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION is_current_platform_admin() RETURNS BOOLEAN AS $$
DECLARE
    expected_hash TEXT;
BEGIN
    SELECT secret_hash INTO expected_hash
    FROM lunchlineup_private.platform_admin_capability
    WHERE singleton = TRUE;
    RETURN expected_hash IS NOT NULL
        AND current_setting('app.platform_admin_proof', true) = expected_hash;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, lunchlineup_private;
