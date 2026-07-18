import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(path, 'utf8');
const schema = read('packages/db/prisma/schema.prisma');
const migration = read('packages/db/prisma/migrations/20260717_credit_refund_debt.sql');
const migrationsReadme = read('packages/db/prisma/migrations/README.md');
const metering = read('apps/api/src/billing/metering.service.ts');
const featureAccess = read('apps/api/src/billing/feature-access.service.ts');
const stripePurchases = read('apps/api/src/billing/stripe-credit-purchase.service.ts');
const tenantDeletion = read('apps/api/src/admin/tenant-deletion-billing.service.ts');
const userDeletion = read('apps/api/src/users/user-deletion.ts');
const schedulePublisher = read('apps/api/src/schedules/schedule-solve-outbox.publisher.ts');
const webhookStore = read('apps/api/src/webhooks/webhook-delivery.store.ts');
const availabilityStore = read('apps/worker/src/availability_import_store.py');
const workerMain = read('apps/worker/main.py');

test('credit debt is schema-owned, nonnegative, and backfilled exactly', () => {
  assert.match(schema, /creditDebt\s+Int\s+@default\(0\)/);
  assert.match(schema, /debtAmount\s+Int\s+@default\(0\)/);
  assert.match(schema, /debtAfter\s+Int\?/);
  assert.match(migration, /SET "creditDebt" = 0[\s\S]*WHERE "creditDebt" IS NULL/);
  assert.match(migration, /Tenant_creditDebt_nonnegative_check[\s\S]*CHECK \("creditDebt" >= 0\)/);
  assert.match(migration, /SET "debtAmount" = 0[\s\S]*WHERE "debtAmount" IS NULL/);
  assert.match(migration, /SET "debtAfter" = 0[\s\S]*WHERE "debtAfter" IS NULL/);
  assert.match(migration, /CreditTransaction_debtAfter_nonnegative_check/);
});

test('old writers receive a debt snapshot and cannot mutate it later', () => {
  assert.match(migration, /populate_credit_transaction_debt_settlement/);
  assert.match(migration, /BEFORE INSERT ON public\."CreditTransaction"/);
  assert.match(migration, /SELECT tenant\."creditDebt"[\s\S]*INTO STRICT tenant_credit_debt/);
  assert.match(migration, /NEW\."debtAmount" = 0 AND tenant_credit_debt > 0/);
  assert.match(migration, /legacy credit settlement is blocked while tenant credit debt exists/);
  assert.match(migration, /NEW\."debtAfter" := tenant_credit_debt/);
  assert.match(migration, /NEW\."debtAmount"[\s\S]*NEW\."debtAfter"/);
  assert.match(migration, /OLD\."debtAmount"[\s\S]*OLD\."debtAfter"/);
});

test('runtime policy repays debt before adding spendable value and blocks new debits', () => {
  assert.match(metering, /Math\.min\(currentDebt, amount\)/);
  assert.match(metering, /usageCredits: \{ increment: spendableAmount \}/);
  assert.match(metering, /creditDebt: \{ decrement: repaidDebt \}/);
  assert.match(metering, /creditDebt: 0[\s\S]*usageCredits: \{ gte: args\.cost \}/);
  assert.match(featureAccess, /tenant\.creditDebt !== 0/);
});

test('the database owns debt-first positive settlement for API and worker refunds', () => {
  assert.match(migration, /FUNCTION public\.settle_positive_credit_value/);
  assert.match(migration, /SECURITY INVOKER/);
  assert.match(migration, /FOR UPDATE/);
  assert.match(migration, /repaid_debt := LEAST\(current_debt, p_value\)/);
  assert.match(migration, /spendable_amount := p_value - repaid_debt/);
  assert.match(migration, /"creditDebt" = settled_debt/);
  assert.match(migration, /"debtAmount"[\s\S]*-repaid_debt/);
  assert.match(migration, /existing_settlement\."amount"::BIGINT[\s\S]*existing_settlement\."debtAmount"::BIGINT/);
});

test('runtime positive-value writers delegate to one debt-first owner per runtime', () => {
  assert.match(stripePurchases, /recordPositiveCreditSettlementInTransaction/);
  assert.doesNotMatch(stripePurchases, /usageCredits:\s*\{\s*increment/);
  assert.doesNotMatch(stripePurchases, /creditTransaction\.create/);

  for (const source of [
    tenantDeletion,
    userDeletion,
    schedulePublisher,
    webhookStore,
    availabilityStore,
    workerMain,
  ]) {
    assert.match(source, /public\.settle_positive_credit_value/);
    assert.doesNotMatch(source, /SET "usageCredits"\s*=\s*"usageCredits"\s*\+/);
    assert.doesNotMatch(source, /INSERT INTO "CreditTransaction"/);
  }
});

test('the forward migration is documented', () => {
  assert.match(migrationsReadme, /20260717_credit_refund_debt\.sql/);
});
