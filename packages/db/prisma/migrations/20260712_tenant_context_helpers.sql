-- Install transaction-local tenant context before any RLS policy references it.
CREATE OR REPLACE FUNCTION set_current_tenant(tenant_id TEXT) RETURNS VOID AS $$
BEGIN
  PERFORM set_config('app.current_tenant', tenant_id, true);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_current_tenant() RETURNS TEXT AS $$
BEGIN
  RETURN current_setting('app.current_tenant', true);
END;
$$ LANGUAGE plpgsql STABLE;
