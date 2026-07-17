import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(path, 'utf8');
const migration = read('packages/db/prisma/migrations/20260714_subscription_credit_invariants.sql');
const signup = read('apps/api/src/auth/onboarding-signup.service.ts');
const admin = read('apps/api/src/admin/admin.controller.ts');
const billingController = read('apps/api/src/billing/billing.controller.ts');
const featureAccess = read('apps/api/src/billing/feature-access.service.ts');
const metering = read('apps/api/src/billing/metering.service.ts');

test('new tenants and trials start with zero credits and no signup ledger grant', () => {
  assert.match(signup, /status: TenantStatus\.TRIAL[\s\S]*usageCredits: 0/);
  assert.doesNotMatch(signup, /PUBLIC_SIGNUP_TRIAL_CREDITS|public-trial-credit|Starter trial credits/);
  assert.match(admin, /New tenants start with zero credits/);
  assert.match(admin, /const usageCredits = 0/);
  assert.match(admin, /'usageCredits',[\s\S]*'stripeSubscriptionCurrentPeriodEnd'/);
});

test('admin grants have one idempotent ledger-owned API surface', () => {
  assert.doesNotMatch(billingController, /@Post\('credits\/grant'\)/);
  assert.match(admin, /@Post\('credits\/grant'\)[\s\S]*normalizeCreditGrantIdempotencyKey/);
  assert.match(metering, /async grantCreditsInTransaction\([\s\S]*tx: TenantPrismaTransaction/);
  assert.match(metering, /admin-credit-grant-[\s\S]*normalizedTenantId[\s\S]*normalizedKey/);
  assert.match(admin, /withPlatformAdminUserMutation[\s\S]*grantCreditsInTransaction[\s\S]*TENANT_CREDITS_GRANTED/);
  assert.doesNotMatch(metering, /async consumeCredits\(/);
});

test('billable debits accept only positive wallet-backed resolutions', () => {
  assert.match(featureAccess, /resolution\.source !== 'credits'/);
  assert.match(featureAccess, /Number\.isSafeInteger\(creditCost\)/);
  assert.match(metering, /args\.source !== 'credits'/);
  assert.match(metering, /Number\.isSafeInteger\(args\.cost\) \|\| args\.cost <= 0/);
});

test('database constraints prohibit negative wallets and plan-owned credit quotas', () => {
  assert.match(migration, /WHERE "usageCredits" < 0/);
  assert.match(migration, /CHECK \("usageCredits" >= 0\)/);
  assert.match(migration, /UPDATE "PlanDefinition"[\s\S]*"creditQuotaLimit" = NULL/);
  assert.match(migration, /CHECK \("creditQuotaLimit" IS NULL\)/);
  assert.match(admin, /assertPlanCreditInvariant\(body\)/);
  assert.match(admin, /Plan metadata cannot define included, unlimited, or wallet credits/);
});
