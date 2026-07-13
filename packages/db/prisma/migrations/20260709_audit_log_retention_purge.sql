-- Allow the retained-record expiry purge to remove audit rows only after the
-- application sets a transaction-local flag. Ordinary audit UPDATE/DELETE stays blocked.

CREATE OR REPLACE FUNCTION block_audit_log_modification()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE'
        AND current_setting('app.allow_audit_log_delete', true) = 'retention_expired' THEN
        RETURN OLD;
    END IF;

    RAISE EXCEPTION 'Audit logs are append-only and cannot be modified or deleted.';
END;
$$ LANGUAGE plpgsql;
