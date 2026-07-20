-- Payroll resources cross the API-02 public boundary. Preserve deployed v1
-- writers by adding opaque UUIDs with database defaults rather than replacing
-- private primary keys. pre_20260718_api_v2_public_ids.sql owns pgcrypto.
--
-- Some deployed payroll rows have immutable-evidence triggers. This migration
-- runs through the owner-only transactional migration connection, so disable
-- user triggers only for this backfill transaction; the setting is reset on
-- commit and cannot weaken normal application writes.

SET LOCAL session_replication_role = replica;

DO $migration$
DECLARE
  target_table TEXT;
BEGIN
  -- Fresh databases create Prisma-owned tables after pre-migrations run.
  -- Existing databases need a nullable/backfill/not-null expansion first.
  FOREACH target_table IN ARRAY ARRAY[
    'PayrollPolicyVersion',
    'PayrollPeriod',
    'PayrollLockedEntry',
    'PayrollAmendment',
    'PayrollExportBatch',
    'PayrollExportLine',
    'PayrollReconciliationReceipt'
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
