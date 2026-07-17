import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(path, 'utf8');
const schema = read('packages/db/prisma/schema.prisma');
const migration = read('packages/db/prisma/migrations/20260716_zzzzzz_billing_exact_once.sql');
const plans = read('apps/api/src/billing/plan-definitions.ts');
const featureAccess = read('apps/api/src/billing/feature-access.service.ts');
const userCapacity = read('apps/api/src/billing/user-capacity.ts');
const locationCapacity = read('apps/api/src/locations/locations.controller.ts');
const rateLimits = read('apps/api/src/common/guards/rate-limits.guard.ts');
const metering = read('apps/api/src/billing/metering.service.ts');
const creditPurchases = read('apps/api/src/billing/stripe-credit-purchase.service.ts');
const admin = read('apps/api/src/admin/admin.controller.ts');
const worker = read('apps/worker/src/availability_import_store.py');

test('authoritative Stripe paid-through is schema-owned and required by every API snapshot', () => {
  assert.match(schema, /stripeSubscriptionCurrentPeriodEnd\s+DateTime\?/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "stripeSubscriptionCurrentPeriodEnd" TIMESTAMP\(3\)/);
  assert.match(migration, /Tenant_stripeSubscriptionCurrentPeriodEnd_binding_check/);
  assert.match(migration, /Tenant_paid_subscription_entitlement_idx/);
  assert.match(plans, /status === 'ACTIVE'[\s\S]*hasNonBlankStripeSubscriptionId[\s\S]*hasFutureStripeSubscriptionCurrentPeriodEnd/);
  for (const snapshot of [featureAccess, userCapacity, locationCapacity]) {
    assert.match(snapshot, /stripeSubscriptionCurrentPeriodEnd: true/);
  }
  assert.match(rateLimits, /stripeSubscriptionCurrentPeriodEnd: true/);
  assert.match(rateLimits, /hasNonBlankStripeSubscriptionId/);
  assert.match(rateLimits, /hasFutureStripeSubscriptionCurrentPeriodEnd/);
  assert.match(rateLimits, /Math\.min\(normalExpiry, paidThroughEpoch\)/);
  assert.match(admin, /'stripeSubscriptionCurrentPeriodEnd'[\s\S]*cannot be updated through generic tenant edit/);
});

test('admin credit grants have one exact-session Serializable transaction owner', () => {
  assert.match(admin, /adminUserLifecycleActor\(req\)/);
  assert.match(admin, /withPlatformAdminUserMutation\(async \(tx\)/);
  assert.match(admin, /authorizePlatformAdminTenantMutationInTransaction\(tx, tenantId, actor\)/);
  assert.match(admin, /grantCreditsInTransaction\(tx/);
  assert.match(admin, /TENANT_CREDITS_GRANTED/);
  assert.match(admin, /settlement\.replayed[\s\S]*auditLog\.findUnique/);
  assert.doesNotMatch(admin, /meteringService\.grantCredits\(/);
});

test('wallet settlement replay is immutable and returns the stored original balance', () => {
  assert.match(schema, /balanceAfter\s+Int\?/);
  assert.match(migration, /CreditTransaction_balanceAfter_nonnegative_check/);
  assert.match(migration, /CreditTransaction_balanceAfter_required_check[\s\S]*CHECK \("balanceAfter" IS NOT NULL\) NOT VALID/);
  assert.match(migration, /CreditTransaction_settlement_immutable/);
  assert.match(migration, /ROW\(NEW\."id", NEW\."tenantId", NEW\."amount", NEW\."reason", NEW\."balanceAfter", NEW\."createdAt"\)/);
  assert.doesNotMatch(migration, /BEFORE UPDATE OF "balanceAfter"/);
  assert.match(metering, /balanceAfter: newBalance/);
  assert.match(metering, /existing\.balanceAfter/);
  assert.match(metering, /Existing credit grant is missing its immutable settlement balance/);
  assert.match(metering, /Existing feature usage is missing its immutable settlement balance/);
  assert.match(creditPurchases, /balanceAfter: wallet\.usageCredits/);
  assert.match(creditPurchases, /newBalance: existing\.balanceAfter/);
  assert.match(creditPurchases, /Existing Stripe credit purchase settlement is malformed or mismatched/);
});

test('availability claim, commit, debit, and refund use authoritative paid-through settlement proof', () => {
  assert.match(worker, /"stripeSubscriptionCurrentPeriodEnd" > CURRENT_TIMESTAMP/);
  assert.match(worker, /tenant\[1\]\.strip\(\)\.upper\(\) != "FREE"[\s\S]*tenant\[2\][\s\S]*tenant\[3\] is not None[\s\S]*tenant\[4\] is True/);
  assert.match(worker, /debit_balance_after == configured_balance/);
  assert.match(worker, /"balanceAfter", "createdAt"/);
  assert.match(worker, /refund_balance_after/);
});
