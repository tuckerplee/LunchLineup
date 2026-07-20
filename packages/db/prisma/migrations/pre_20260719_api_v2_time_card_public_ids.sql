-- Time cards and their persisted break intervals are browser-visible API
-- resources. Add opaque UUIDs while keeping existing storage IDs untouched so
-- the deployed v1 writer remains compatible during API-02-TIME rollout.

-- pre_20260718_api_v2_public_ids.sql runs first and owns pgcrypto setup for
-- this public-ID migration family.

DO $migration$
DECLARE
  target_table TEXT;
BEGIN
  FOREACH target_table IN ARRAY ARRAY['TimeCard', 'TimeCardBreak']
  LOOP
    -- Fresh databases create Prisma-owned tables after pre-migrations run.
    IF to_regclass(format('%I.%I', 'public', target_table)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE %I.%I ADD COLUMN IF NOT EXISTS "publicId" UUID',
      'public',
      target_table
    );
    EXECUTE format(
      'UPDATE %I.%I SET "publicId" = gen_random_uuid() WHERE "publicId" IS NULL',
      'public',
      target_table
    );
    EXECUTE format(
      'ALTER TABLE %I.%I '
      || 'ALTER COLUMN "publicId" SET DEFAULT gen_random_uuid(), '
      || 'ALTER COLUMN "publicId" SET NOT NULL',
      'public',
      target_table
    );
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I.%I ("publicId")',
      target_table || '_publicId_key',
      'public',
      target_table
    );
  END LOOP;
END
$migration$;
