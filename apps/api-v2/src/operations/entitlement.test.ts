import { describe, expect, it, vi } from 'vitest';
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
});
