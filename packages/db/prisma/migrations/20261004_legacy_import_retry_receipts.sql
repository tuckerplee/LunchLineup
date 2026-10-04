-- Private, create-only legacy import retry receipts. These are permanent
-- identity tombstones, not foreign keys to application rows. Application purge
-- can remove live targets; the importer must refuse rather than recreate them.
-- Only the separately admitted migration/import owner can access this schema.
-- No role, grant, platform capability or source-lineage approval is created.
DO $install$
DECLARE
    namespace_oid OID;
    owner_oid OID;
    old_search_path TEXT := current_setting('search_path');
    catalog_checksum TEXT;
    recorded_checksum TEXT;
    catalog_query TEXT := $catalog$
        SELECT md5(COALESCE(jsonb_agg(payload ORDER BY identity)::text, '[]'))
        FROM (
            SELECT 'namespace' AS identity,
                jsonb_build_array(n.nspname, pg_get_userbyid(n.nspowner), n.nspacl::text) AS payload
            FROM pg_namespace n WHERE n.nspname = 'legacy_import'
            UNION ALL
            SELECT 'relation:' || c.relname,
                jsonb_build_array(c.relname, c.relkind, c.relpersistence,
                    pg_get_userbyid(c.relowner), c.relacl::text, c.relrowsecurity,
                    c.relforcerowsecurity, c.reloptions)
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'legacy_import'
            UNION ALL
            SELECT 'column:' || c.relname || ':' || a.attnum,
                jsonb_build_array(c.relname, a.attnum, a.attname,
                    format_type(a.atttypid, a.atttypmod), a.attnotnull,
                    a.attidentity, a.attgenerated, pg_get_expr(ad.adbin, ad.adrelid))
            FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
            WHERE n.nspname = 'legacy_import' AND a.attnum > 0 AND NOT a.attisdropped
            UNION ALL
            SELECT 'constraint:' || c.relname || ':' || con.conname,
                jsonb_build_array(c.relname, con.conname, con.contype,
                    con.convalidated, con.condeferrable, con.condeferred,
                    pg_get_constraintdef(con.oid, false))
            FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'legacy_import'
            UNION ALL
            SELECT 'index:' || c.relname,
                jsonb_build_array(c.relname, i.indisvalid, i.indisready,
                    i.indisunique, pg_get_indexdef(i.indexrelid))
            FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'legacy_import'
            UNION ALL
            SELECT 'trigger:' || c.relname || ':' || t.tgname,
                jsonb_build_array(c.relname, t.tgname, t.tgenabled,
                    pg_get_triggerdef(t.oid, false))
            FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'legacy_import' AND NOT t.tgisinternal
            UNION ALL
            SELECT 'function:' || p.proname || ':' || pg_get_function_identity_arguments(p.oid),
                jsonb_build_array(p.proname, pg_get_function_identity_arguments(p.oid),
                    pg_get_userbyid(p.proowner), p.proacl::text, pg_get_functiondef(p.oid))
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'legacy_import'
            UNION ALL
            SELECT 'policy:' || c.relname || ':' || p.polname,
                jsonb_build_array(c.relname, p.polname, p.polcmd, p.polpermissive,
                    p.polroles::text, pg_get_expr(p.polqual, p.polrelid),
                    pg_get_expr(p.polwithcheck, p.polrelid))
            FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'legacy_import'
            UNION ALL
            SELECT 'type:' || t.typname,
                jsonb_build_array(t.typname, t.typtype, pg_get_userbyid(t.typowner),
                    t.typacl::text, format_type(t.typbasetype, t.typtypmod))
            FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = 'legacy_import'
        ) catalog
    $catalog$;
BEGIN
    -- Stable catalog rendering, restored on either successful branch. This
    -- checksum is an owner-local drift detector, not an authentication seal.
    PERFORM set_config('search_path', 'pg_catalog', true);
    SELECT oid INTO owner_oid FROM pg_roles WHERE rolname = current_user;
    SELECT oid INTO namespace_oid FROM pg_namespace WHERE nspname = 'legacy_import';
    IF namespace_oid IS NOT NULL THEN
        IF (SELECT nspowner FROM pg_namespace WHERE oid = namespace_oid) <> owner_oid THEN
            RAISE EXCEPTION 'Legacy import schema has a foreign owner' USING ERRCODE = '42501';
        END IF;
        IF EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = namespace_oid AND relowner <> owner_oid)
           OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = namespace_oid AND proowner <> owner_oid)
           OR EXISTS (SELECT 1 FROM pg_type WHERE typnamespace = namespace_oid AND typowner <> owner_oid) THEN
            RAISE EXCEPTION 'Legacy import catalog has a foreign object owner' USING ERRCODE = '42501';
        END IF;
        recorded_checksum := obj_description(namespace_oid, 'pg_namespace');
        IF recorded_checksum IS NULL OR recorded_checksum !~ '^lunchlineup-legacy-import-receipts-v1:[0-9a-f]{32}$' THEN
            RAISE EXCEPTION 'Preexisting legacy import schema is not the receipt catalog' USING ERRCODE = '55000';
        END IF;
        EXECUTE catalog_query INTO catalog_checksum;
        IF recorded_checksum <> 'lunchlineup-legacy-import-receipts-v1:' || catalog_checksum THEN
            RAISE EXCEPTION 'Legacy import receipt catalog changed' USING ERRCODE = '55000';
        END IF;
        IF (SELECT count(*) FROM legacy_import.target_generation) <> 1 THEN
            RAISE EXCEPTION 'Legacy import target generation is missing' USING ERRCODE = '55000';
        END IF;
        PERFORM set_config('search_path', old_search_path, true);
        RETURN;
    END IF;

    CREATE SCHEMA legacy_import;
    REVOKE ALL ON SCHEMA legacy_import FROM PUBLIC;

    CREATE TABLE legacy_import.target_generation (
        singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton IS TRUE),
        generation_uuid UUID NOT NULL UNIQUE DEFAULT gen_random_uuid()
    );
    CREATE TABLE legacy_import.run (
        -- UTF-8 target contract: reject each line terminator explicitly rather
        -- than relying on PostgreSQL regexp newline/anchor flags.
        namespace TEXT PRIMARY KEY CHECK (namespace ~ '^[a-z][a-z0-9._:-]{2,127}$'
            AND pg_catalog.strpos(namespace, pg_catalog.chr(10)) = 0
            AND pg_catalog.strpos(namespace, pg_catalog.chr(13)) = 0
            AND pg_catalog.strpos(namespace, pg_catalog.chr(8232)) = 0
            AND pg_catalog.strpos(namespace, pg_catalog.chr(8233)) = 0),
        generation_uuid UUID NOT NULL REFERENCES legacy_import.target_generation(generation_uuid),
        source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
        adapter_version TEXT NOT NULL CHECK (octet_length(adapter_version) BETWEEN 1 AND 128),
        role_plan_sha256 TEXT NOT NULL CHECK (role_plan_sha256 ~ '^[0-9a-f]{64}$'),
        approval_plan_sha256 TEXT NOT NULL CHECK (approval_plan_sha256 ~ '^[0-9a-f]{64}$'),
        expected_company_count INTEGER NOT NULL CHECK (expected_company_count >= 0),
        expected_location_count INTEGER NOT NULL CHECK (expected_location_count >= 0),
        expected_user_count INTEGER NOT NULL CHECK (expected_user_count >= 0),
        expected_staff_count INTEGER NOT NULL CHECK (expected_staff_count >= 0),
        status TEXT NOT NULL DEFAULT 'INITIALIZED' CHECK (status IN ('INITIALIZED', 'COMPLETE')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
        completed_at TIMESTAMPTZ,
        CHECK ((status = 'INITIALIZED' AND completed_at IS NULL)
            OR (status = 'COMPLETE' AND completed_at IS NOT NULL
                AND isfinite(completed_at) AND completed_at >= created_at))
    );
    CREATE TABLE legacy_import.company (
        namespace TEXT NOT NULL REFERENCES legacy_import.run(namespace),
        company_id BIGINT NOT NULL CHECK (company_id BETWEEN 1 AND 4294967295),
        target_tenant_id TEXT NOT NULL UNIQUE CHECK (octet_length(target_tenant_id) BETWEEN 1 AND 256),
        source_row_sha256 TEXT NOT NULL CHECK (source_row_sha256 ~ '^[0-9a-f]{64}$'),
        bootstrap_role_ids JSONB NOT NULL,
        PRIMARY KEY (namespace, company_id),
        UNIQUE (namespace, company_id, target_tenant_id),
        CHECK (jsonb_typeof(bootstrap_role_ids) = 'object'
            AND bootstrap_role_ids ?& ARRAY['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF']
            AND bootstrap_role_ids - ARRAY['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF'] = '{}'::jsonb
            AND jsonb_typeof(bootstrap_role_ids->'SUPER_ADMIN') = 'string'
            AND jsonb_typeof(bootstrap_role_ids->'ADMIN') = 'string'
            AND jsonb_typeof(bootstrap_role_ids->'MANAGER') = 'string'
            AND jsonb_typeof(bootstrap_role_ids->'STAFF') = 'string'
            AND octet_length(bootstrap_role_ids->>'SUPER_ADMIN') BETWEEN 1 AND 256
            AND octet_length(bootstrap_role_ids->>'ADMIN') BETWEEN 1 AND 256
            AND octet_length(bootstrap_role_ids->>'MANAGER') BETWEEN 1 AND 256
            AND octet_length(bootstrap_role_ids->>'STAFF') BETWEEN 1 AND 256
            AND bootstrap_role_ids->>'SUPER_ADMIN' <> bootstrap_role_ids->>'ADMIN'
            AND bootstrap_role_ids->>'SUPER_ADMIN' <> bootstrap_role_ids->>'MANAGER'
            AND bootstrap_role_ids->>'SUPER_ADMIN' <> bootstrap_role_ids->>'STAFF'
            AND bootstrap_role_ids->>'ADMIN' <> bootstrap_role_ids->>'MANAGER'
            AND bootstrap_role_ids->>'ADMIN' <> bootstrap_role_ids->>'STAFF'
            AND bootstrap_role_ids->>'MANAGER' <> bootstrap_role_ids->>'STAFF')
    );
    CREATE TABLE legacy_import.entity (
        namespace TEXT NOT NULL,
        company_id BIGINT NOT NULL CHECK (company_id BETWEEN 1 AND 4294967295),
        source_type TEXT NOT NULL CHECK (source_type IN ('location', 'user', 'staff')),
        legacy_id BIGINT NOT NULL CHECK (legacy_id BETWEEN 1 AND 4294967295),
        target_kind TEXT GENERATED ALWAYS AS (CASE WHEN source_type = 'location' THEN 'location' ELSE 'account' END) STORED,
        target_id TEXT NOT NULL CHECK (octet_length(target_id) BETWEEN 1 AND 256),
        target_tenant_id TEXT NOT NULL CHECK (octet_length(target_tenant_id) BETWEEN 1 AND 256),
        initial_role_id TEXT,
        source_row_sha256 TEXT NOT NULL CHECK (source_row_sha256 ~ '^[0-9a-f]{64}$'),
        PRIMARY KEY (namespace, company_id, source_type, legacy_id),
        UNIQUE (target_kind, target_id),
        FOREIGN KEY (namespace, company_id, target_tenant_id)
            REFERENCES legacy_import.company(namespace, company_id, target_tenant_id),
        CHECK ((source_type = 'location' AND initial_role_id IS NULL)
            OR (source_type IN ('user', 'staff') AND initial_role_id IS NOT NULL
                AND octet_length(initial_role_id) BETWEEN 1 AND 256))
    );

    CREATE FUNCTION legacy_import.refuse_receipt_mutation()
    RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, legacy_import AS $immutable$
    BEGIN
        RAISE EXCEPTION 'Legacy import identity receipts are immutable' USING ERRCODE = '42501';
    END;
    $immutable$;

    CREATE FUNCTION legacy_import.guard_run_transition()
    RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, legacy_import AS $run$
    BEGIN
        IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
            RAISE EXCEPTION 'Legacy import admission cannot be removed' USING ERRCODE = '42501';
        END IF;
        IF TG_OP = 'INSERT' THEN
            IF NEW.status <> 'INITIALIZED' OR NEW.completed_at IS NOT NULL THEN
                RAISE EXCEPTION 'Legacy import runs start INITIALIZED' USING ERRCODE = '22023';
            END IF;
            RETURN NEW;
        END IF;
        IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
        IF (to_jsonb(NEW) - 'status' - 'completed_at') IS DISTINCT FROM
           (to_jsonb(OLD) - 'status' - 'completed_at')
           OR OLD.status <> 'INITIALIZED' OR OLD.completed_at IS NOT NULL
           OR NEW.status <> 'COMPLETE' OR NEW.completed_at IS NULL THEN
            RAISE EXCEPTION 'Legacy import admission is immutable' USING ERRCODE = '42501';
        END IF;
        -- UPDATE owns this run row. Every receipt insert locks the same row;
        -- another importer cannot insert a late receipt after completion.
        IF (SELECT count(*) FROM legacy_import.company WHERE namespace = OLD.namespace) <> OLD.expected_company_count
           OR (SELECT count(*) FROM legacy_import.entity WHERE namespace = OLD.namespace AND source_type = 'location') <> OLD.expected_location_count
           OR (SELECT count(*) FROM legacy_import.entity WHERE namespace = OLD.namespace AND source_type = 'user') <> OLD.expected_user_count
           OR (SELECT count(*) FROM legacy_import.entity WHERE namespace = OLD.namespace AND source_type = 'staff') <> OLD.expected_staff_count THEN
            RAISE EXCEPTION 'Legacy import receipt counts are incomplete' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END;
    $run$;

    CREATE FUNCTION legacy_import.guard_receipt_insert()
    RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, legacy_import AS $insert$
    DECLARE
        admitted legacy_import.run%ROWTYPE;
        expected_count INTEGER;
        actual_count BIGINT;
    BEGIN
        SELECT * INTO admitted FROM legacy_import.run WHERE namespace = NEW.namespace FOR UPDATE;
        IF NOT FOUND OR admitted.status <> 'INITIALIZED' THEN
            RAISE EXCEPTION 'Legacy import run is not open' USING ERRCODE = '55000';
        END IF;
        IF TG_TABLE_NAME = 'company' THEN
            expected_count := admitted.expected_company_count;
            SELECT count(*) INTO actual_count FROM legacy_import.company WHERE namespace = NEW.namespace;
        ELSE
            expected_count := CASE NEW.source_type
                WHEN 'location' THEN admitted.expected_location_count
                WHEN 'user' THEN admitted.expected_user_count
                WHEN 'staff' THEN admitted.expected_staff_count
                ELSE NULL END;
            SELECT count(*) INTO actual_count FROM legacy_import.entity
                WHERE namespace = NEW.namespace AND source_type = NEW.source_type;
            IF NEW.source_type IN ('user', 'staff') AND NOT EXISTS (
                SELECT 1 FROM legacy_import.company company,
                    jsonb_each_text(company.bootstrap_role_ids) role_id
                WHERE company.namespace = NEW.namespace AND company.company_id = NEW.company_id
                    AND company.target_tenant_id = NEW.target_tenant_id AND role_id.value = NEW.initial_role_id
            ) THEN
                RAISE EXCEPTION 'Legacy import role is not a company bootstrap role' USING ERRCODE = '23514';
            END IF;
        END IF;
        IF expected_count IS NULL OR actual_count >= expected_count THEN
            RAISE EXCEPTION 'Legacy import receipt count exceeds admission' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END;
    $insert$;

    CREATE TRIGGER target_generation_immutable BEFORE UPDATE OR DELETE ON legacy_import.target_generation
        FOR EACH ROW EXECUTE FUNCTION legacy_import.refuse_receipt_mutation();
    CREATE TRIGGER target_generation_no_truncate BEFORE TRUNCATE ON legacy_import.target_generation
        FOR EACH STATEMENT EXECUTE FUNCTION legacy_import.refuse_receipt_mutation();
    CREATE TRIGGER run_admission_guard BEFORE INSERT OR UPDATE OR DELETE ON legacy_import.run
        FOR EACH ROW EXECUTE FUNCTION legacy_import.guard_run_transition();
    CREATE TRIGGER run_no_truncate BEFORE TRUNCATE ON legacy_import.run
        FOR EACH STATEMENT EXECUTE FUNCTION legacy_import.guard_run_transition();
    CREATE TRIGGER company_insert_guard BEFORE INSERT ON legacy_import.company
        FOR EACH ROW EXECUTE FUNCTION legacy_import.guard_receipt_insert();
    CREATE TRIGGER company_immutable BEFORE UPDATE OR DELETE ON legacy_import.company
        FOR EACH ROW EXECUTE FUNCTION legacy_import.refuse_receipt_mutation();
    CREATE TRIGGER company_no_truncate BEFORE TRUNCATE ON legacy_import.company
        FOR EACH STATEMENT EXECUTE FUNCTION legacy_import.refuse_receipt_mutation();
    CREATE TRIGGER entity_insert_guard BEFORE INSERT ON legacy_import.entity
        FOR EACH ROW EXECUTE FUNCTION legacy_import.guard_receipt_insert();
    CREATE TRIGGER entity_immutable BEFORE UPDATE OR DELETE ON legacy_import.entity
        FOR EACH ROW EXECUTE FUNCTION legacy_import.refuse_receipt_mutation();
    CREATE TRIGGER entity_no_truncate BEFORE TRUNCATE ON legacy_import.entity
        FOR EACH STATEMENT EXECUTE FUNCTION legacy_import.refuse_receipt_mutation();

    ALTER TABLE legacy_import.target_generation ENABLE ROW LEVEL SECURITY;
    ALTER TABLE legacy_import.run ENABLE ROW LEVEL SECURITY;
    ALTER TABLE legacy_import.company ENABLE ROW LEVEL SECURITY;
    ALTER TABLE legacy_import.entity ENABLE ROW LEVEL SECURITY;
    -- No policies: runtime roles are denied; the admitted owner retains the
    -- normal PostgreSQL owner bypass. FORCE RLS would change that ABI.
    REVOKE ALL ON ALL TABLES IN SCHEMA legacy_import FROM PUBLIC;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA legacy_import FROM PUBLIC;

    -- Refuse inherited global default grants rather than silently admitting an
    -- unrelated runtime role or modifying another owner's default privileges.
    IF EXISTS (
        SELECT 1 FROM pg_namespace n,
            LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) permission
        WHERE n.nspname = 'legacy_import' AND permission.grantee <> owner_oid
        UNION ALL
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
            LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) permission
        WHERE n.nspname = 'legacy_import' AND permission.grantee <> owner_oid
        UNION ALL
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
            LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) permission
        WHERE n.nspname = 'legacy_import' AND permission.grantee <> owner_oid
    ) THEN
        RAISE EXCEPTION 'Legacy import schema inherited an unapproved grant' USING ERRCODE = '42501';
    END IF;

    INSERT INTO legacy_import.target_generation(singleton) VALUES (TRUE);
    EXECUTE catalog_query INTO catalog_checksum;
    EXECUTE format('COMMENT ON SCHEMA legacy_import IS %L',
        'lunchlineup-legacy-import-receipts-v1:' || catalog_checksum);
    PERFORM set_config('search_path', old_search_path, true);
END;
$install$;
