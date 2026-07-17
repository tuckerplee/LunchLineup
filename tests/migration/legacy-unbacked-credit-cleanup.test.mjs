import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8');
const migrationPath = 'packages/db/prisma/migrations/20260716_legacy_unbacked_credit_cleanup.sql';
const migration = read(migrationPath);

test('legacy import and forward cleanup remove only the known unbacked grant', () => {
  const importer = read('scripts/import-legacy-users.mjs');
  const metering = read('apps/api/src/billing/metering.service.ts');

  assert.match(importer, /tx\.tenant\.create\(\{[\s\S]*?status: TenantStatus\.ACTIVE,[\s\S]*?usageCredits: 0,/);
  assert.doesNotMatch(importer, /usageCredits:\s*1000/);
  assert.match(importer, /prisma\.\$transaction\([\s\S]*?pg_advisory_xact_lock[\s\S]*?tx\.tenant\.create[\s\S]*?tx\.platformConfig\.create/);
  assert.match(importer, /legacy-import\.credit-provenance\.v1\.[\s\S]*?sourceSha256[\s\S]*?initialCreditPolicy: 'zero-wallet-no-ledger'[\s\S]*?initialCreditGrant: 0/);
  assert.match(migration, /LOCK TABLE public\."Tenant", public\."CreditTransaction", public\."PlatformConfig"[\s\S]*IN SHARE ROW EXCLUSIVE MODE/);
  assert.doesNotMatch(migration, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
  assert.match(migration, /WHERE tenant\."slug" LIKE 'legacy-company-%'[\s\S]*FOR UPDATE/);
  assert.match(migration, /legacy-import\.credit-provenance\.v1\.' \|\| tenant\."id"/);
  assert.match(migration, /candidate\.wallet_balance = candidate\.ledger_balance \+ 1000[\s\S]*candidate\.ledger_balance >= 0/);
  assert.match(migration, /SET "usageCredits" = candidate\.ledger_balance::INTEGER/);
  assert.doesNotMatch(migration, /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?public\."CreditTransaction"/i);
  const grantBody = metering.slice(
    metering.indexOf('async grantCreditsInTransaction'),
    metering.indexOf('async recordFeatureUsageInTransaction'),
  );
  const tenantTableLock = grantBody.indexOf('await this.lockCreditSettlementTables(tx)');
  const tenantRowLock = grantBody.indexOf('SELECT "id" FROM "Tenant"');
  const ledgerInsert = grantBody.indexOf('tx.creditTransaction.create');
  assert.match(metering, /LOCK TABLE "Tenant", "CreditTransaction" IN ROW EXCLUSIVE MODE/);
  assert.ok(tenantTableLock >= 0 && tenantTableLock < tenantRowLock && tenantRowLock < ledgerInsert);
});

test('legacy cleanup rescans every pass and fails closed on malformed provenance or ambiguous histories', () => {
  assert.match(migration, /candidate\.import_provenance IS NOT NULL[\s\S]*zero-wallet-no-ledger/);
  assert.match(migration, /malformed fixed-import credit provenance/);
  assert.match(migration, /legacy-unbacked-1000-reconciled/);
  assert.match(migration, /per-tenant credit provenance has an imbalanced wallet/);
  assert.match(migration, /ledger_row_count = 0 AND candidate\.wallet_balance = 0[\s\S]*ambiguous fully consumed or manually cleared/);
  assert.match(migration, /ambiguous or consumed credit history[\s\S]*manual reconciliation is required/);
  assert.doesNotMatch(migration, /migration\.legacy-unbacked-1000-credit-cleanup\.v1/);
  assert.doesNotMatch(migration, /\bRETURN;/);
  assert.match(migration, /INSERT INTO public\."PlatformConfig"[\s\S]*legacy-import\.credit-provenance\.v1\.' \|\| candidate\.tenant_id/);
});

test('legacy cleanup has one exact digest-bound expand-contract approval', () => {
  const policy = JSON.parse(read('scripts/raw-migration-rollback-policy.json'));
  const digest = createHash('sha256').update(migration).digest('hex');

  assert.equal(policy.migrations[migrationPath], undefined);
  assert.deepEqual(policy.expandContract[migrationPath], {
    sha256: digest,
    phase: 'expand-contract',
    rollbackSchema: 'retain',
    contractPhase: 'compatibility-proven-inline',
    requiresOldReleaseProof: true,
    rationale: 'the locked repeatable legacy wallet reconciliation and per-tenant import/reconciliation provenance remain during rollback; isolated old-release proof is required before production mutation.',
  });
});
