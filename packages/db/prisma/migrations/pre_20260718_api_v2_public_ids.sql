-- Add stable opaque API identifiers without breaking the currently deployed v1 writers.
-- Database defaults are intentional: old Prisma clients do not know these columns.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- A fresh database has no Prisma-owned tables yet because pre-migrations run
-- before `prisma db push`. Existing databases need the nullable/backfill/not-null
-- sequence so the schema push never attempts a destructive required-column add.
DO $migration$
DECLARE
  target_table TEXT;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'User',
    'Location',
    'Schedule',
    'Shift',
    'ScheduleSolveJob'
  ]
  LOOP
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
