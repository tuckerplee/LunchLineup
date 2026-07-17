import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8');

test('legacy tenant imports create no implicit usage-credit grant', () => {
  const importer = read('scripts/import-legacy-users.mjs');

  assert.match(importer, /create:\s*\{[\s\S]*?status: TenantStatus\.ACTIVE,[\s\S]*?usageCredits: 0,/);
  assert.doesNotMatch(importer, /usageCredits:\s*1000/);
  assert.doesNotMatch(importer, /prisma\.creditTransaction\.(?:create|createMany|upsert)/);
});

test('schedule refund migration fails closed on debit drift and refunds from the ledger row once', () => {
  const migration = read('packages/db/prisma/migrations/20260709_yyyyyy_schedule_solve_credit_refund_provenance_guard.sql');

  assert.match(migration, /LOCK TABLE "Tenant"[\s\S]*LOCK TABLE "ScheduleSolveJob"[\s\S]*LOCK TABLE "CreditTransaction"/);
  assert.doesNotMatch(migration, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
  assert.match(migration, /COUNT\(\*\)::integer AS "rowCount"/);
  assert.match(migration, /debit\."rowCount" <> 1/);
  assert.match(migration, /debit\."tenantId" IS DISTINCT FROM job\."tenantId"/);
  assert.match(migration, /debit\."amount" IS DISTINCT FROM -configured\."amount"/);
  assert.match(migration, /RAISE EXCEPTION 'Schedule solve credit refund provenance is missing, mismatched, or duplicated'/);
  assert.match(migration, /'schedule-credit-' \|\| job\."id"/);
  assert.match(migration, /'schedule-credit-refund-' \|\| candidate\."jobId"/);
  assert.match(migration, /-candidate\."debitAmount"/);
  assert.doesNotMatch(migration, /SELECT[\s\S]{0,180}\("creditConsumption"->>'consumedCredits'\)::integer,[\s\S]{0,80}'Schedule generation refund/);
  assert.match(migration, /ON CONFLICT \("id"\) DO NOTHING[\s\S]*RETURNING "tenantId", "amount"/);
  assert.match(migration, /FROM inserted_refunds[\s\S]*GROUP BY "tenantId"/);
  assert.ok(
    '20260709_yyyyyy_schedule_solve_credit_refund_provenance_guard.sql'
      .localeCompare('20260709_zzzzzz_schedule_solve_credit_refunds.sql') < 0,
    'the exact-provenance settlement must run before the retained historical backfill',
  );
});
