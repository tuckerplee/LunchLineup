-- Prisma refuses to add unique indexes to populated tables without bypassing
-- its data-loss safeguard, even when every new key column is nullable. Stage
-- the nullable columns and exact canonical indexes before synchronization.

DO $$
BEGIN
  IF to_regclass('public."Location"') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE public."Location"
    ADD COLUMN IF NOT EXISTS "creationRequestKeyHash" TEXT,
    ADD COLUMN IF NOT EXISTS "creationRequestHash" TEXT;

  LOCK TABLE public."Location" IN SHARE ROW EXCLUSIVE MODE;

  IF EXISTS (
    SELECT 1
    FROM public."Location"
    WHERE "creationRequestKeyHash" IS NOT NULL
    GROUP BY "tenantId", "creationRequestKeyHash"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot stage Location request identity while duplicate tenant request keys remain'
      USING ERRCODE = '23505';
  END IF;

  CREATE UNIQUE INDEX IF NOT EXISTS "Location_tenantId_creationRequestKeyHash_key"
    ON public."Location" ("tenantId", "creationRequestKeyHash");

  IF NOT EXISTS (
    SELECT 1
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
      AND table_relation.relname = 'Location'
      AND index_relation.relname = 'Location_tenantId_creationRequestKeyHash_key'
      AND index_metadata.indisunique
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND index_metadata.indpred IS NULL
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnkeyatts = 2
      AND index_metadata.indnatts = 2
      AND access_method.amname = 'btree'
      AND pg_catalog.pg_get_indexdef(index_metadata.indexrelid, 1, TRUE) = '"tenantId"'
      AND pg_catalog.pg_get_indexdef(index_metadata.indexrelid, 2, TRUE) = '"creationRequestKeyHash"'
  ) THEN
    RAISE EXCEPTION 'Location_tenantId_creationRequestKeyHash_key does not match the Prisma schema';
  END IF;
END
$$;

DO $$
BEGIN
  IF to_regclass('public."Session"') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE public."Session"
    ADD COLUMN IF NOT EXISTS "selectorHash" TEXT;

  LOCK TABLE public."Session" IN SHARE ROW EXCLUSIVE MODE;

  IF EXISTS (
    SELECT 1
    FROM public."Session"
    WHERE "selectorHash" IS NOT NULL
    GROUP BY "selectorHash"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot stage Session selector identity while duplicate selectors remain'
      USING ERRCODE = '23505';
  END IF;

  CREATE UNIQUE INDEX IF NOT EXISTS "Session_selectorHash_key"
    ON public."Session" ("selectorHash");

  IF NOT EXISTS (
    SELECT 1
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
      AND table_relation.relname = 'Session'
      AND index_relation.relname = 'Session_selectorHash_key'
      AND index_metadata.indisunique
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND index_metadata.indpred IS NULL
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnkeyatts = 1
      AND index_metadata.indnatts = 1
      AND access_method.amname = 'btree'
      AND pg_catalog.pg_get_indexdef(index_metadata.indexrelid, 1, TRUE) = '"selectorHash"'
  ) THEN
    RAISE EXCEPTION 'Session_selectorHash_key does not match the Prisma schema';
  END IF;
END
$$;

DO $$
BEGIN
  IF to_regclass('public."User"') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE public."User"
    ADD COLUMN IF NOT EXISTS "oidcIssuer" TEXT,
    ADD COLUMN IF NOT EXISTS "oidcSubject" TEXT;

  LOCK TABLE public."User" IN SHARE ROW EXCLUSIVE MODE;

  IF EXISTS (
    SELECT 1
    FROM public."User"
    WHERE ("oidcIssuer" IS NULL) <> ("oidcSubject" IS NULL)
  ) THEN
    RAISE EXCEPTION 'Cannot stage User OIDC identity while partial issuer-subject pairs remain'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public."User"
    WHERE "oidcIssuer" IS NOT NULL
      AND "oidcSubject" IS NOT NULL
    GROUP BY "tenantId", "oidcIssuer", "oidcSubject"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot stage User OIDC identity while duplicate tenant identities remain'
      USING ERRCODE = '23505';
  END IF;

  CREATE UNIQUE INDEX IF NOT EXISTS "User_tenantId_oidcIssuer_oidcSubject_key"
    ON public."User" ("tenantId", "oidcIssuer", "oidcSubject");

  IF NOT EXISTS (
    SELECT 1
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
      AND index_relation.relname = 'User_tenantId_oidcIssuer_oidcSubject_key'
      AND index_metadata.indisunique
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND index_metadata.indpred IS NULL
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnkeyatts = 3
      AND index_metadata.indnatts = 3
      AND access_method.amname = 'btree'
      AND pg_catalog.pg_get_indexdef(index_metadata.indexrelid, 1, TRUE) = '"tenantId"'
      AND pg_catalog.pg_get_indexdef(index_metadata.indexrelid, 2, TRUE) = '"oidcIssuer"'
      AND pg_catalog.pg_get_indexdef(index_metadata.indexrelid, 3, TRUE) = '"oidcSubject"'
  ) THEN
    RAISE EXCEPTION 'User_tenantId_oidcIssuer_oidcSubject_key does not match the Prisma schema';
  END IF;
END
$$;
