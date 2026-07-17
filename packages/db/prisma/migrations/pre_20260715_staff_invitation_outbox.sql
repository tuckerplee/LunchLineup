-- Stage the tenant-first User key before Prisma creates the staff-invitation
-- composite foreign key. User.id is already globally unique, so any duplicate
-- (tenantId, id) rows indicate invalid pre-existing state and must fail closed.

DO $$
DECLARE
  exact_index_exists BOOLEAN;
BEGIN
  IF to_regclass('public."User"') IS NULL THEN
    RETURN;
  END IF;

  LOCK TABLE public."User" IN SHARE MODE;

  IF EXISTS (
    SELECT 1
    FROM public."User"
    WHERE "id" IS NULL OR "tenantId" IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM public."User"
    GROUP BY "tenantId", "id"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot stage User tenant-first identity while invalid or duplicate rows remain';
  END IF;

  CREATE UNIQUE INDEX IF NOT EXISTS "User_tenantId_id_key"
    ON public."User" ("tenantId", "id");

  SELECT
    index_metadata.indisunique
    AND index_metadata.indisvalid
    AND index_metadata.indisready
    AND index_metadata.indpred IS NULL
    AND index_metadata.indexprs IS NULL
    AND index_metadata.indnkeyatts = 2
    AND index_metadata.indnatts = 2
    AND access_method.amname = 'btree'
    AND pg_catalog.pg_get_indexdef(index_metadata.indexrelid, 1, TRUE) = '"tenantId"'
    AND pg_catalog.pg_get_indexdef(index_metadata.indexrelid, 2, TRUE) = 'id'
  INTO exact_index_exists
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
    AND table_relation.relname = 'User'
    AND index_relation.relname = 'User_tenantId_id_key';

  IF exact_index_exists IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'User_tenantId_id_key does not match Prisma tenant-first identity';
  END IF;
END
$$;
