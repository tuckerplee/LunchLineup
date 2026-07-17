import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL('../../' + path, import.meta.url), 'utf8');

test('availability imports persist a leased publication outbox and forced tenant isolation', async () => {
  const [schema, enumMigration, migration, lifecycleMigration, encryptedSourceMigration] = await Promise.all([
    read('packages/db/prisma/schema.prisma'),
    read('packages/db/prisma/migrations/20260714_availability_import_enums.sql'),
    read('packages/db/prisma/migrations/20260714_availability_import_jobs.sql'),
    read('packages/db/prisma/migrations/20260715_availability_import_lifecycle.sql'),
    read('packages/db/prisma/migrations/20260715_availability_import_encrypted_source.sql'),
  ]);

  assert.match(schema, /model AvailabilityImportJob \{/);
  for (const field of [
    'publicationStatus',
    'publishToken',
    'publishLeaseUntil',
    'publishAttempts',
    'nextPublishAt',
    'publicationAmbiguous',
    'executionToken',
    'executionLeaseUntil',
    'expiresAt',
    'targetIdentityHash',
    'resultErasedAt',
    'encryptedSourcePayload',
  ]) {
    assert.match(schema, new RegExp('\\b' + field + '\\b'));
    assert.match(migration + '\n' + lifecycleMigration + '\n' + encryptedSourceMigration, new RegExp('"' + field + '"'));
  }
  assert.match(schema, /@@index\(\[publicationStatus, nextPublishAt, createdAt\]\)/);
  assert.match(schema, /@@index\(\[status, completedAt\]\)/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /AvailabilityImportJob_publicationStatus_nextPublishAt_createdAt_idx/);
  assert.match(migration, /AvailabilityImportJob_publishLeaseUntil_idx/);
  assert.match(migration, /AvailabilityImportJob_status_executionLeaseUntil_idx/);
  assert.match(migration, /AvailabilityImportJob_result_check/);
  assert.match(lifecycleMigration, /AvailabilityImportJob_status_completedAt_idx/);
  assert.match(enumMigration, /CREATE TYPE "AvailabilityImportStatus"/);
  assert.match(enumMigration, /ALTER TYPE "AvailabilityImportPublicationStatus" ADD VALUE IF NOT EXISTS 'FAILED'/);
  assert.doesNotMatch(migration, /ALTER TYPE "AvailabilityImport(?:Publication)?Status" ADD VALUE/);
  assert.ok(
    '20260714_availability_import_enums.sql'.localeCompare('20260714_availability_import_jobs.sql') < 0,
    'enum values must commit in a ledger transaction before table defaults consume them',
  );
});


test('encrypted source expansion is nullable, bounded, replay-safe, and terminally erased', async () => {
  const [schema, migration, deletion, workerStore, compose] = await Promise.all([
    read('packages/db/prisma/schema.prisma'),
    read('packages/db/prisma/migrations/20260715_availability_import_encrypted_source.sql'),
    read('apps/api/src/users/user-deletion.ts'),
    read('apps/worker/src/availability_import_store.py'),
    read('docker-compose.yml'),
  ]);

  assert.match(schema, /encryptedSourcePayload\s+Bytes\?/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "encryptedSourcePayload" BYTEA/);
  assert.match(migration, /octet_length\("encryptedSourcePayload"\) BETWEEN 34 AND 5242913/);
  assert.match(migration, /AvailabilityImportJob_terminal_source_erasure_check/);
  assert.match(migration, /"encryptedSourcePayload" IS NULL AND "storageKey" IS NULL/);
  assert.match(migration, /job\."encryptedSourcePayload" IS NOT NULL/);
  assert.match(migration, /Completed availability imports must be erased; undelivered imports must be refunded/);
  assert.match(migration, /END;\s*\$\$ LANGUAGE plpgsql SECURITY DEFINER/);
  assert.match(deletion, /encryptedSourcePayload: null/);
  assert.match(workerStore, /"status" = 'SUCCEEDED'[\s\S]*"encryptedSourcePayload" = NULL/);
  assert.match(workerStore, /def terminalize_import[\s\S]*"encryptedSourcePayload" = NULL/);
  assert.match(workerStore, /"completedAt" <= CURRENT_TIMESTAMP - INTERVAL '24 hours'[\s\S]*"encryptedSourcePayload" = NULL/);
  assert.equal((compose.match(/AVAILABILITY_IMPORT_ENCRYPTION_KEY=/g) ?? []).length, 2);
  assert.match(compose, /api:[\s\S]*AVAILABILITY_IMPORT_ENCRYPTION_KEY=[\s\S]*worker:[\s\S]*AVAILABILITY_IMPORT_ENCRYPTION_KEY=/);
});
test('required target identity pre-migration no-ops fresh, replays populated, and finalizes afterward', async () => {
  const [schema, preMigration, lifecycleMigration, runner] = await Promise.all([
    read('packages/db/prisma/schema.prisma'),
    read('packages/db/prisma/migrations/pre_20260715_availability_import_lifecycle.sql'),
    read('packages/db/prisma/migrations/20260715_availability_import_lifecycle.sql'),
    read('scripts/apply-db-migrations.mjs'),
  ]);

  const preApply = runner.indexOf('await operations.applyPreMigrations()');
  const schemaPush = runner.indexOf('await operations.pushSchema()');
  const finalApply = runner.indexOf('await operations.applyRawMigrations()');

  assert.match(schema, /targetIdentityHash\s+String\b/);
  assert.ok(preApply >= 0 && preApply < schemaPush, 'pre-migration must run before required schema synchronization');
  assert.ok(schemaPush < finalApply, 'final lifecycle migration must run after schema synchronization');
  assert.match(runner, /applyPreMigrations: \(\) => ledger\.applyAll\(inventory\.pre\)/);
  assert.match(runner, /applyRawMigrations: \(\) => ledger\.applyAll\(inventory\.post\)/);
  assert.match(preMigration, /CREATE EXTENSION IF NOT EXISTS pgcrypto/);
  assert.match(preMigration, /to_regclass\('public\."AvailabilityImportJob"'\) IS NULL/);
  assert.match(preMigration, /ADD COLUMN IF NOT EXISTS "targetIdentityHash" TEXT/);
  assert.doesNotMatch(preMigration, /ALTER COLUMN "targetIdentityHash" SET NOT NULL/);
  assert.match(preMigration, /job\."targetIdentityHash" IS NULL[\s\S]*job\."targetIdentityHash" !~ '\^\[a-f0-9\]\{64\}\$'/);
  assert.match(preMigration, /IF EXISTS \([\s\S]*"targetIdentityHash" IS NULL[\s\S]*RAISE EXCEPTION/);
  assert.match(preMigration, /lower\([\s\S]*btrim\(target\."username"\)[\s\S]*target\."id"/);
  assert.match(preMigration, /public\.digest\([\s\S]*'sha256'/);
  assert.match(preMigration, /target\."id" = job\."userId"[\s\S]*target\."tenantId" = job\."tenantId"/);
  assert.match(preMigration, /Cannot stage availability-import target identity hashes while invalid rows remain/);
  assert.match(lifecycleMigration, /ALTER COLUMN "targetIdentityHash" SET NOT NULL/);
});

test('CANCELLED enum recreation releases and restores every prior migration dependency', async () => {
  const migration = await read('packages/db/prisma/migrations/20260715_availability_import_lifecycle.sql');
  const resultConstraintDrop = migration.indexOf('DROP CONSTRAINT IF EXISTS "AvailabilityImportJob_result_check"');
  const terminalConstraintDrop = migration.indexOf('DROP CONSTRAINT IF EXISTS "AvailabilityImportJob_terminal_time_check"');
  const defaultDrop = migration.indexOf('ALTER COLUMN "status" DROP DEFAULT');
  const enumRename = migration.indexOf('RENAME TO "AvailabilityImportStatus_before_lifecycle"');
  const columnConversion = migration.indexOf('USING "status"::text::public."AvailabilityImportStatus"');
  const defaultRestore = migration.indexOf('ALTER COLUMN "status" SET DEFAULT');
  const oldTypeDrop = migration.indexOf('DROP TYPE public."AvailabilityImportStatus_before_lifecycle"');

  assert.ok(resultConstraintDrop >= 0 && resultConstraintDrop < enumRename);
  assert.ok(terminalConstraintDrop >= 0 && terminalConstraintDrop < enumRename);
  assert.ok(defaultDrop >= 0 && defaultDrop < enumRename);
  assert.ok(enumRename < columnConversion && columnConversion < defaultRestore);
  assert.ok(defaultRestore < oldTypeDrop);
  assert.match(migration, /value\.enumlabel = 'CANCELLED'[\s\S]*IF NOT EXISTS/);
});

test('publisher recovery never writes worker-owned processing status', async () => {
  const [publisher, service, workerStore] = await Promise.all([
    read('apps/api/src/availability-imports/availability-imports.publisher.ts'),
    read('apps/api/src/availability-imports/availability-imports.service.ts'),
    read('apps/worker/src/availability_import_store.py'),
  ]);

  assert.match(publisher, /FOR UPDATE SKIP LOCKED/);
  assert.match(publisher, /job\."publishLeaseUntil" <=/);
  assert.match(publisher, /publicationStatus: 'PUBLISHED'/);
  assert.doesNotMatch(publisher, /status:\s*'QUEUED'/);
  assert.doesNotMatch(service, /publishMessage|waitForConfirms|createConfirmChannel/);
  assert.match(workerStore, /"status" = 'RUNNING'/);
  assert.match(workerStore, /'feature-refund-availability-import:'/);
  assert.match(workerStore, /"deletedAt" IS NULL/);
  assert.match(workerStore, /"suspendedAt" IS NULL/);
  assert.match(workerStore, /job\."targetIdentityHash"/);
  assert.match(workerStore, /job\."expiresAt" > CURRENT_TIMESTAMP/);
});

test('lifecycle migration backfills identity and permits erased successful results', async () => {
  const migration = await read('packages/db/prisma/migrations/20260715_availability_import_lifecycle.sql');

  assert.match(migration, /'CANCELLED'/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "targetIdentityHash" TEXT/);
  assert.match(migration, /ALTER COLUMN "targetIdentityHash" SET NOT NULL/);
  assert.match(migration, /lower\([\s\S]*btrim\(target\."username"\)[\s\S]*target\."id"/);
  assert.match(migration, /public\.digest\([\s\S]*'sha256'/);
  assert.match(migration, /AvailabilityImportJob_target_identity_hash_check/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "resultErasedAt" TIMESTAMP\(3\)/);
  assert.match(migration, /AvailabilityImportJob_terminal_completion_check/);
  assert.match(migration, /AvailabilityImportJob_result_lifecycle_check/);
  assert.match(migration, /"status"::text = 'SUCCEEDED'[\s\S]*"parsedAvailability" IS NULL AND "resultErasedAt" IS NOT NULL/);
  assert.match(migration, /AvailabilityImportJob_result_erasure_time_check/);
  assert.match(migration, /AvailabilityImportJob_status_completedAt_idx/);
});

test('lifecycle cancellation erases both source copies in the same terminal update', async () => {
  const migration = await read('packages/db/prisma/migrations/20260715_availability_import_lifecycle.sql');
  const cancellationStart = migration.indexOf('UPDATE public."AvailabilityImportJob" job\nSET "storageKey" = NULL');
  const successErasureStart = migration.indexOf(
    'UPDATE public."AvailabilityImportJob" job\nSET "publishToken" = NULL',
    cancellationStart,
  );
  assert.ok(cancellationStart >= 0 && successErasureStart > cancellationStart);
  const cancellation = migration.slice(cancellationStart, successErasureStart);

  assert.match(cancellation, /"storageKey" = NULL/);
  assert.match(cancellation, /"encryptedSourcePayload" = NULL/);
  assert.match(cancellation, /"status" = 'CANCELLED'/);
  assert.ok(cancellation.indexOf('"encryptedSourcePayload" = NULL') < cancellation.indexOf('"status" = \'CANCELLED\''));
  assert.match(cancellation, /job\."status"::text <> 'SUCCEEDED'/);
});

test('lifecycle migration blocks unsafe final handoff and user deletion', async () => {
  const [migration, deletion, workerStore] = await Promise.all([
    read('packages/db/prisma/migrations/20260715_availability_import_lifecycle.sql'),
    read('apps/api/src/users/user-deletion.ts'),
    read('apps/worker/src/availability_import_store.py'),
  ]);

  assert.match(migration, /enforce_availability_import_final_handoff/);
  assert.match(migration, /tenant\."status"::text = 'ACTIVE'/);
  assert.match(migration, /tenant\."stripeSubscriptionId"/);
  assert.match(migration, /target\."deletedAt" IS NULL/);
  assert.match(migration, /target\."suspendedAt" IS NULL/);
  assert.match(migration, /feature-usage-availability-import:/);
  assert.match(migration, /feature-refund-availability-import:/);
  assert.match(migration, /refund\."amount" = -debit\."amount"/);
  assert.match(migration, /block_user_deletion_with_live_availability_imports/);
  assert.match(migration, /job\."publicationStatus"::text <> 'FAILED'/);
  assert.match(migration, /job\."failureCode" IS DISTINCT FROM 'USER_DELETED'/);
  assert.match(migration, /job\."status"::text <> 'SUCCEEDED'/);
  assert.match(migration, /Completed availability imports must be erased; undelivered imports must be refunded/);

  assert.match(deletion, /FOR UPDATE OF job/);
  assert.match(deletion, /status:\s*["']CANCELLED["']/);
  assert.match(deletion, /status:\s*["']SUCCEEDED["']/);
  assert.match(deletion, /resultErasedAt: deletedAt/);
  assert.match(deletion, /failureCode:\s*["']USER_DELETED["']/);
  assert.match(workerStore, /"completedAt" <= CURRENT_TIMESTAMP - INTERVAL '24 hours'/);
  assert.match(workerStore, /job\."requestHash"/);
  assert.match(workerStore, /expected_identity_hash = _expected_source_identity_hash\(state\)/);
  assert.match(workerStore, /source_identity_hash != expected_identity_hash/);
  const completionPath = workerStore.slice(
    workerStore.indexOf('def complete_import'),
    workerStore.indexOf('def mark_retrying'),
  );
  assert.ok(
    completionPath.indexOf('target = _lock_active_target') < completionPath.indexOf('state = _lock_job'),
    'worker must lock and revalidate the target before the job final-handoff lock',
  );
});
