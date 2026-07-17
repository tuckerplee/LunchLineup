import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const migrationPath = 'packages/db/prisma/migrations/20260715_staff_invitation_outbox.sql';
const preMigrationPath = 'packages/db/prisma/migrations/pre_20260715_staff_invitation_outbox.sql';
const migration = read(migrationPath);
const preMigration = read(preMigrationPath);
const schema = read('packages/db/prisma/schema.prisma');
const migrationInventory = read('packages/db/prisma/migrations/README.md');
const migrationRunner = read('scripts/apply-db-migrations.mjs');

test('staff invitation tenant-first User key is staged before Prisma schema push', () => {
  const preApply = migrationRunner.indexOf('await operations.applyPreMigrations()');
  const schemaPush = migrationRunner.indexOf('await operations.pushSchema()');
  const finalApply = migrationRunner.indexOf('await operations.applyRawMigrations()');

  assert.notEqual(preApply, -1);
  assert.notEqual(schemaPush, -1);
  assert.notEqual(finalApply, -1);
  assert.ok(preApply < schemaPush && schemaPush < finalApply);
  assert.match(migrationRunner, /applyPreMigrations: \(\) => ledger\.applyAll\(inventory\.pre\)/);
  assert.match(migrationRunner, /applyRawMigrations: \(\) => ledger\.applyAll\(inventory\.post\)/);
  assert.doesNotMatch(migrationRunner, /--accept-data-loss/);
  assert.match(schema, /@@unique\(\[tenantId, id\]\)/);
  assert.match(preMigration, /to_regclass\('public\."User"'\) IS NULL/);
  assert.match(preMigration, /LOCK TABLE public\."User" IN SHARE MODE/);
  assert.match(preMigration, /WHERE "id" IS NULL OR "tenantId" IS NULL/);
  assert.match(preMigration, /GROUP BY "tenantId", "id"[\s\S]*HAVING COUNT\(\*\) > 1/);
  assert.match(preMigration, /CREATE UNIQUE INDEX IF NOT EXISTS "User_tenantId_id_key"[\s\S]*ON public\."User" \("tenantId", "id"\)/);
  assert.match(preMigration, /indisunique[\s\S]*indisvalid[\s\S]*indisready/);
  assert.match(preMigration, /access_method\.amname = 'btree'/);
  assert.match(preMigration, /pg_get_indexdef\(index_metadata\.indexrelid, 1, TRUE\) = '"tenantId"'/);
  assert.match(preMigration, /pg_get_indexdef\(index_metadata\.indexrelid, 2, TRUE\) = 'id'/);
  assert.match(preMigration, /exact_index_exists IS DISTINCT FROM TRUE/);
  assert.match(migrationInventory, /pre_20260715_staff_invitation_outbox\.sql/);
});

test('staff invitation outbox schema and migration define the bounded delivery state', () => {
  for (const fragment of [
    'enum StaffInvitationOutboxStatus',
    'PENDING',
    'SENDING',
    'FAILED',
    'DELIVERED',
    'DEAD_LETTERED',
    'CANCELLED',
    'model StaffInvitationOutbox',
    '@@unique([tenantId, userId, purpose])',
    '@relation(fields: [tenantId, userId], references: [tenantId, id], onDelete: Cascade)',
  ]) {
    assert.ok(schema.includes(fragment), `missing Prisma fragment: ${fragment}`);
  }

  for (const fragment of [
    'CREATE TYPE "StaffInvitationOutboxStatus"',
    'CREATE TABLE IF NOT EXISTS public."StaffInvitationOutbox"',
    '"StaffInvitationOutbox_tenantId_userId_fkey"',
    'REFERENCES public."User"("tenantId", "id")',
    '"StaffInvitationOutbox_attempt_bounds_check"',
    '"StaffInvitationOutbox_manual_retry_bounds_check"',
    '"StaffInvitationOutbox_envelope_check"',
    '"StaffInvitationOutbox_lease_check"',
    '"StaffInvitationOutbox_state_check"',
    '"StaffInvitationOutbox_terminal_payload_erased_check"',
  ]) {
    assert.ok(migration.includes(fragment), `missing migration fragment: ${fragment}`);
  }
  assert.match(migrationInventory, /20260715_staff_invitation_outbox\.sql/);
});

test('staff invitation outbox is forced tenant RLS with terminal and lifecycle erasure', () => {
  assert.match(migration, /ALTER TABLE public\."StaffInvitationOutbox" ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /ALTER TABLE public\."StaffInvitationOutbox" FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /CREATE POLICY staff_invitation_outbox_isolation_policy/);
  assert.match(migration, /"tenantId" = \(SELECT get_current_tenant\(\)\)/);
  assert.match(migration, /scrub_terminal_staff_invitation_outbox[\s\S]*"encryptedPayload" := NULL/);
  assert.match(migration, /"StaffInvitationOutbox_terminal_payload_erasure"/);
  assert.match(migration, /"User_cancel_staff_invitation_outbox"[\s\S]*UPDATE OF "email", "suspendedAt", "deletedAt"/);
  assert.match(migration, /"Tenant_cancel_staff_invitation_outbox"[\s\S]*UPDATE OF "status", "deletedAt"/);
  assert.match(migration, /"status" = 'CANCELLED'[\s\S]*"encryptionKeyRef" := NULL|NEW\."encryptionKeyRef" := NULL/);
});

test('staff invitation retention is capability-gated, bounded, and indexed', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.purge_staff_invitation_outbox_diagnostics/);
  assert.match(migration, /IF NOT is_current_platform_admin\(\)/);
  assert.match(migration, /batch_limit < 1 OR batch_limit > 10000/);
  assert.match(migration, /LIMIT batch_limit[\s\S]*FOR UPDATE SKIP LOCKED/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.purge_staff_invitation_outbox_diagnostics/);

  for (const index of [
    'StaffInvitationOutbox_status_retryAt_createdAt_idx',
    'StaffInvitationOutbox_status_leaseExpiresAt_idx',
    'StaffInvitationOutbox_dead_letter_idx',
    'StaffInvitationOutbox_diagnostics_retention_idx',
  ]) {
    assert.ok(migration.includes(index), `missing outbox index: ${index}`);
  }
});
