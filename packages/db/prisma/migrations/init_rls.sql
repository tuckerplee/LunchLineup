-- packages/db/prisma/migrations/init_rls.sql
-- This migration initializes Row-Level Security (RLS) policies for multi-tenancy.

-- 1. Create a function to set the current tenant context
CREATE OR REPLACE FUNCTION set_current_tenant(tenant_id TEXT) RETURNS VOID AS $$
BEGIN
    PERFORM set_config('app.current_tenant', tenant_id, false);
END;
$$ LANGUAGE plpgsql;

-- 2. Create a function to get the current tenant context
CREATE OR REPLACE FUNCTION get_current_tenant() RETURNS TEXT AS $$
BEGIN
    RETURN current_setting('app.current_tenant', true);
END;
$$ LANGUAGE plpgsql;

-- 3. Enable RLS on all multi-tenant tables
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;

-- 4. Define policies for tenants
-- A tenant can only see themselves
CREATE POLICY tenant_isolation_policy ON tenants
    USING (id = get_current_tenant());

-- 5. Define policies for users
CREATE POLICY user_isolation_policy ON users
    USING (tenant_id = get_current_tenant());

-- 6. Define policies for locations
CREATE POLICY location_isolation_policy ON locations
    USING (tenant_id = get_current_tenant());

-- 7. Define policies for shifts
-- Shifts are scoped by location, and locations are scoped by tenant.
CREATE POLICY shift_isolation_policy ON shifts
    USING (
        location_id IN (
            SELECT id FROM locations WHERE tenant_id = get_current_tenant()
        )
    );
