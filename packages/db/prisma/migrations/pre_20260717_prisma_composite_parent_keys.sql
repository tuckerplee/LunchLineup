-- Composite tenant foreign keys depend on parent indexes that Prisma must also
-- own. Stage and verify the exact canonical indexes before schema sync so an
-- upgraded database cannot lose them between raw migration ledger runs.

DO $$
DECLARE
  target RECORD;
  table_oid REGCLASS;
  quoted_columns TEXT;
  null_predicate TEXT;
  invalid_rows_exist BOOLEAN;
  exact_index_exists BOOLEAN;
  actual_columns TEXT[];
BEGIN
  FOR target IN
    SELECT *
    FROM (
      VALUES
        ('User', 'User_id_tenantId_key', ARRAY['id', 'tenantId']::TEXT[]),
        ('Role', 'Role_id_tenantId_key', ARRAY['id', 'tenantId']::TEXT[]),
        ('Location', 'Location_id_tenantId_key', ARRAY['id', 'tenantId']::TEXT[]),
        ('Schedule', 'Schedule_id_tenantId_key', ARRAY['id', 'tenantId']::TEXT[]),
        (
          'Schedule',
          'Schedule_id_tenantId_locationId_key',
          ARRAY['id', 'tenantId', 'locationId']::TEXT[]
        ),
        ('Shift', 'Shift_id_tenantId_key', ARRAY['id', 'tenantId']::TEXT[])
    ) AS targets(table_name, index_name, column_names)
  LOOP
    table_oid := to_regclass(format('public.%I', target.table_name));
    IF table_oid IS NULL THEN
      CONTINUE;
    END IF;

    SELECT
      string_agg(format('%I', column_name), ', ' ORDER BY ordinal),
      string_agg(format('%I IS NULL', column_name), ' OR ' ORDER BY ordinal)
    INTO quoted_columns, null_predicate
    FROM unnest(target.column_names) WITH ORDINALITY AS columns(column_name, ordinal);

    EXECUTE format('LOCK TABLE public.%I IN SHARE MODE', target.table_name);

    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM public.%I WHERE %s)',
      target.table_name,
      null_predicate
    )
    INTO invalid_rows_exist;

    IF invalid_rows_exist THEN
      RAISE EXCEPTION 'Cannot stage % while null parent identity values remain', target.index_name
        USING ERRCODE = '23502';
    END IF;

    EXECUTE format(
      'SELECT EXISTS (
        SELECT 1
        FROM public.%I
        GROUP BY %s
        HAVING COUNT(*) > 1
      )',
      target.table_name,
      quoted_columns
    )
    INTO invalid_rows_exist;

    IF invalid_rows_exist THEN
      RAISE EXCEPTION 'Cannot stage % while duplicate parent identities remain', target.index_name
        USING ERRCODE = '23505';
    END IF;

    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS %I ON public.%I (%s)',
      target.index_name,
      target.table_name,
      quoted_columns
    );

    SELECT
      index_metadata.indisunique
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND index_metadata.indpred IS NULL
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnkeyatts = cardinality(target.column_names)
      AND index_metadata.indnatts = cardinality(target.column_names)
      AND access_method.amname = 'btree',
      (
        SELECT array_agg(attribute.attname ORDER BY key_position.ordinal)
        FROM unnest(index_metadata.indkey::SMALLINT[])
          WITH ORDINALITY AS key_position(attribute_number, ordinal)
        JOIN pg_catalog.pg_attribute attribute
          ON attribute.attrelid = table_relation.oid
          AND attribute.attnum = key_position.attribute_number
      )
    INTO exact_index_exists, actual_columns
    FROM pg_catalog.pg_index index_metadata
    JOIN pg_catalog.pg_class index_relation
      ON index_relation.oid = index_metadata.indexrelid
    JOIN pg_catalog.pg_class table_relation
      ON table_relation.oid = index_metadata.indrelid
    JOIN pg_catalog.pg_namespace relation_namespace
      ON relation_namespace.oid = table_relation.relnamespace
    JOIN pg_catalog.pg_am access_method
      ON access_method.oid = index_relation.relam
    WHERE relation_namespace.nspname = 'public'
      AND table_relation.oid = table_oid
      AND index_relation.relname = target.index_name;

    IF exact_index_exists IS DISTINCT FROM TRUE
      OR actual_columns IS DISTINCT FROM target.column_names THEN
      RAISE EXCEPTION '% does not match the Prisma parent identity', target.index_name
        USING ERRCODE = '42P17';
    END IF;
  END LOOP;
END
$$;
