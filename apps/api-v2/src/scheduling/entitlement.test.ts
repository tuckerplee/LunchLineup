import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertSchedulingEntitled } from './entitlement';

describe('native scheduling entitlement', () => {
  const originalInternalBetaEnabled = process.env.INTERNAL_BETA_ENTITLEMENTS_ENABLED;
  const originalAppOrigin = process.env.APP_ORIGIN;

  afterEach(() => {
    if (originalInternalBetaEnabled === undefined) delete process.env.INTERNAL_BETA_ENTITLEMENTS_ENABLED;
    else process.env.INTERNAL_BETA_ENTITLEMENTS_ENABLED = originalInternalBetaEnabled;
    if (originalAppOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = originalAppOrigin;
  });

  it('preserves default-plan paid scheduling behavior', async () => {
    const transaction = {
      $queryRaw: vi.fn(async () => []),
      tenant: {
        findFirst: vi.fn(async () => ({
          planTier: 'STARTER',
          status: 'ACTIVE',
          stripeSubscriptionId: 'sub_paid',
          stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00.000Z'),
        })),
      },
      tenantSetting: { findUnique: vi.fn(async () => null) },
      planDefinition: { findUnique: vi.fn(async () => ({ metadata: null })) },
    };

    await expect(assertSchedulingEntitled(transaction as never, 'tenant-1')).resolves.toBeUndefined();
  });

  it('admits an approved beta trial only through its exact ledger-backed fallback', async () => {
    process.env.INTERNAL_BETA_ENTITLEMENTS_ENABLED = 'true';
    process.env.APP_ORIGIN = 'https://beta.lunchlineup.com';
    const approvedAt = new Date(Date.now() - 60_000);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const transactionId = 'admin-credit-grant-scheduling-beta';
    const auditId = `${transactionId}-internal-beta-audit`;
    const ledgerReason = 'Internal beta scheduling entitlement: Schedule pilot';
    const entitlement = {
      version: 1,
      source: 'internal_beta',
      status: 'ACTIVE',
      features: ['scheduling'],
      grantId: transactionId,
      auditId,
      creditTransactionId: transactionId,
      creditsGranted: 5,
      ledgerReason,
      reason: 'Schedule pilot',
      approvedAt: approvedAt.toISOString(),
      approvedByUserId: 'platform-admin',
      expiresAt: expiresAt.toISOString(),
    };
    const transaction = {
      $queryRaw: vi.fn(async () => []),
      tenant: {
        findFirst: vi.fn(async () => ({
          planTier: 'STARTER',
          status: 'TRIAL',
          stripeSubscriptionId: null,
          stripeSubscriptionCurrentPeriodEnd: null,
          trialEndsAt: new Date(expiresAt.getTime() + 60_000),
          usageCredits: 5,
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
          amount: 5,
          debtAmount: 0,
          reason: ledgerReason,
          balanceAfter: 5,
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

    await expect(assertSchedulingEntitled(transaction as never, 'tenant-1')).resolves.toBeUndefined();
    expect(transaction.creditTransaction.findUnique).toHaveBeenCalledWith({
      where: { id: transactionId },
      select: expect.any(Object),
    });
  });
});
