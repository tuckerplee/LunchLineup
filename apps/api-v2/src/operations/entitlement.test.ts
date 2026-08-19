import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertFeatureEntitled } from './entitlement';

function transaction(metadata: unknown) {
  return {
    $queryRaw: vi.fn(async () => []),
    tenant: {
      findFirst: vi.fn(async () => ({
        planTier: 'GROWTH',
        status: 'ACTIVE',
        stripeSubscriptionId: 'sub_paid',
        stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00.000Z'),
        usageCredits: 4,
        creditDebt: 0,
      })),
    },
    tenantSetting: {
      findUnique: vi.fn(async () => null),
    },
    planDefinition: {
      findUnique: vi.fn(async () => ({ metadata })),
    },
  };
}

describe('Operations entitlement', () => {
  const originalInternalBetaEnabled = process.env.INTERNAL_BETA_ENTITLEMENTS_ENABLED;
  const originalAppOrigin = process.env.APP_ORIGIN;

  afterEach(() => {
    if (originalInternalBetaEnabled === undefined) delete process.env.INTERNAL_BETA_ENTITLEMENTS_ENABLED;
    else process.env.INTERNAL_BETA_ENTITLEMENTS_ENABLED = originalInternalBetaEnabled;
    if (originalAppOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = originalAppOrigin;
  });

  it('keeps supported feature access when a live plan metadata list contains other product features', async () => {
    const database = transaction({
      features: ['scheduling', 'webhooks', 'lunch_breaks', 'time_cards'],
    });

    await expect(assertFeatureEntitled(database as never, 'tenant-1', 'lunch_breaks', false)).resolves.toBeNull();
    await expect(assertFeatureEntitled(database as never, 'tenant-1', 'lunch_breaks', true)).resolves.toEqual({
      feature: 'lunch_breaks',
      creditCost: 1,
    });
  });

  it('authorizes scheduling only for an unexpired beta trial with exact positive-credit provenance', async () => {
    process.env.INTERNAL_BETA_ENTITLEMENTS_ENABLED = 'true';
    process.env.APP_ORIGIN = 'https://beta.lunchlineup.com';
    const approvedAt = new Date(Date.now() - 60_000);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const transactionId = 'admin-credit-grant-api-v2-beta';
    const auditId = `${transactionId}-internal-beta-audit`;
    const ledgerReason = 'Internal beta scheduling entitlement: API v2 pilot';
    const entitlement = {
      version: 1,
      source: 'internal_beta',
      status: 'ACTIVE',
      features: ['scheduling'],
      grantId: transactionId,
      auditId,
      creditTransactionId: transactionId,
      creditsGranted: 8,
      ledgerReason,
      reason: 'API v2 pilot',
      approvedAt: approvedAt.toISOString(),
      approvedByUserId: 'platform-admin',
      expiresAt: expiresAt.toISOString(),
    };
    const database = {
      $queryRaw: vi.fn(async () => []),
      tenant: {
        findFirst: vi.fn(async () => ({
          planTier: 'STARTER',
          status: 'TRIAL',
          stripeSubscriptionId: null,
          stripeSubscriptionCurrentPeriodEnd: null,
          trialEndsAt: new Date(expiresAt.getTime() + 60_000),
          usageCredits: 8,
          creditDebt: 0,
        })),
      },
      tenantSetting: {
        findUnique: vi.fn(async (args: any) => (
          args.where.tenantId_key.key === 'internal_beta_entitlement'
            ? { value: entitlement }
            : null
        )),
      },
      creditTransaction: {
        findUnique: vi.fn(async () => ({
          tenantId: 'tenant-1',
          amount: 8,
          debtAmount: 0,
          reason: ledgerReason,
          balanceAfter: 8,
          debtAfter: 0,
        })),
      },
      auditLog: {
        findUnique: vi.fn(async () => ({
          tenantId: 'tenant-1',
          action: 'INTERNAL_BETA_ENTITLEMENT_GRANTED',
          resource: 'TenantSetting',
          resourceId: transactionId,
          newValue: { entitlement },
        })),
      },
      planDefinition: {
        findUnique: vi.fn(async () => ({ metadata: { features: ['scheduling'] } })),
      },
    };

    await expect(assertFeatureEntitled(database as never, 'tenant-1', 'scheduling', false)).resolves.toBeNull();
    await expect(assertFeatureEntitled(database as never, 'tenant-1', 'scheduling', true)).resolves.toEqual({
      feature: 'scheduling',
      creditCost: 1,
    });
    await expect(assertFeatureEntitled(database as never, 'tenant-1', 'lunch_breaks', false)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('fails closed for the same beta row when the runtime flag is not explicitly enabled', async () => {
    process.env.INTERNAL_BETA_ENTITLEMENTS_ENABLED = 'false';
    process.env.APP_ORIGIN = 'https://beta.lunchlineup.com';
    const database = transaction({ features: ['scheduling'] });
    database.tenant.findFirst.mockResolvedValue({
      planTier: 'STARTER',
      status: 'TRIAL',
      stripeSubscriptionId: null,
      stripeSubscriptionCurrentPeriodEnd: null,
      trialEndsAt: new Date('2099-01-01T00:00:00.000Z'),
      usageCredits: 10,
      creditDebt: 0,
    });

    await expect(assertFeatureEntitled(database as never, 'tenant-1', 'scheduling', false)).rejects.toMatchObject({
      status: 403,
    });
  });
});
