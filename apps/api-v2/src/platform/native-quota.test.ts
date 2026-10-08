import type { SessionIdentity } from '@lunchlineup/api-contract';
import type { FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { TenantDatabase } from './database';
import { NativePlanQuota, nativeQuotaKey, nativeRateLimitPlan } from './native-quota';
import type { NativeQuotaRecord } from './native-quota-storage';

const now = new Date('2030-01-01T00:00:00Z');
const paid = { planTier: 'GROWTH', status: 'ACTIVE', stripeSubscriptionId: 'sub_1', stripeSubscriptionCurrentPeriodEnd: '2030-01-02T00:00:00Z' };
const actor = { tenantId: 'tenant-1', sub: 'user-1' } as SessionIdentity;
const allowed: NativeQuotaRecord = { totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 };
function harness(snapshot: typeof paid | null = { ...paid, planTier: 'FREE' }) {
  const findUnique = vi.fn(async () => snapshot);
  const withTenant = vi.fn(async (_tenant: string, operation: (tx: unknown) => Promise<unknown>) => operation({ tenant: { findUnique } }));
  const database = { withTenant } as unknown as TenantDatabase;
  const storage = { ready: vi.fn(async () => undefined), increment: vi.fn(async () => ({ ...allowed })) };
  const header = vi.fn();
  const reply = { header } as unknown as FastifyReply;
  return { quota: new NativePlanQuota(database, storage), withTenant, findUnique, storage, header, reply };
}
describe('native plan quota', () => {
  it.each([['STARTER', 'starter'], ['BASIC', 'starter'], ['GROWTH', 'growth'], ['PRO', 'growth'], ['ENTERPRISE', 'enterprise'], ['FREE', 'free'], ['unknown', 'free']] as const)(
    'resolves server billing tier %s', (planTier, expected) => {
      expect(nativeRateLimitPlan({ ...paid, planTier }, now)).toBe(expected);
    },
  );
  it.each([
    { status: 'TRIAL' },
    { status: 'PAST_DUE' },
    { stripeSubscriptionId: '  ' },
    { stripeSubscriptionCurrentPeriodEnd: '2030-01-01T00:00:00Z' },
    { stripeSubscriptionCurrentPeriodEnd: 'invalid' },
  ])('applies the free rate to an ineligible paid snapshot %j', (override) => {
    expect(nativeRateLimitPlan({ ...paid, ...override }, now)).toBe('free');
  });
  it('uses retained operation, principal and independent tenant key protocols', () => {
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    expect(nativeQuotaKey('listLocations', ' tenant-1 ', ' user-1 ', 'default')).toBe(
      hash('LocationsController-findAll-default-sha256:' + hash('api-principal:tenant-1:user-1')),
    );
    expect(nativeQuotaKey('listLocations', 'tenant-1', 'user-1', 'tenantCeiling')).toBe(
      hash('LocationsController-findAll-tenantCeiling-sha256:' + hash('api-tenant:tenant-1')),
    );
    expect(nativeQuotaKey('listLocations', 'tenant-1', 'user-1', 'default')).not.toBe(nativeQuotaKey('listLocations', 'tenant-1', 'user-2', 'default'));
    expect(nativeQuotaKey('listLocations', 'tenant-1', 'user-1', 'tenantCeiling')).toBe(nativeQuotaKey('listLocations', 'tenant-1', 'user-2', 'tenantCeiling'));
    expect(nativeQuotaKey('generateLunchBreakPlan', 'tenant-1', 'user-1', 'default')).toBe(nativeQuotaKey('generateScheduleBreaks', 'tenant-1', 'user-1', 'default'));
    expect(nativeQuotaKey('getScheduleBoard', 'tenant-1', 'user-1', 'default')).not.toBe(nativeQuotaKey('listScheduleSummaries', 'tenant-1', 'user-1', 'default'));
  });
  it.each([['FREE', 60], ['STARTER', 300], ['GROWTH', 1000], ['ENTERPRISE', 5000]] as const)('charges both %s budgets in order', async (planTier, limit) => {
    const h = harness({ ...paid, planTier, stripeSubscriptionCurrentPeriodEnd: '9999-01-01T00:00:00Z' });
    await h.quota.consume('listLocations', actor, h.reply);
    expect(h.withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function), { maxWait: 500, timeout: 1500 });
    expect(h.findUnique).toHaveBeenCalledWith({ where: { id: 'tenant-1' }, select: {
      planTier: true, status: true, stripeSubscriptionId: true, stripeSubscriptionCurrentPeriodEnd: true,
    } });
    expect(h.storage.increment).toHaveBeenNthCalledWith(1, nativeQuotaKey('listLocations', 'tenant-1', 'user-1', 'default'), 60_000, limit, 60_000, 'default');
    expect(h.storage.increment).toHaveBeenNthCalledWith(2, nativeQuotaKey('listLocations', 'tenant-1', 'user-1', 'tenantCeiling'), 60_000, limit * 10, 60_000, 'tenantCeiling');
    expect(h.header).toHaveBeenCalledWith('X-RateLimit-Limit', limit);
    expect(h.header).toHaveBeenCalledWith('X-RateLimit-Limit-tenantCeiling', limit * 10);
  });
  it('does not cache a preceding plan lookup across requests', async () => {
    const h = harness();
    await h.quota.consume('listLocations', actor, h.reply);
    await h.quota.consume('listLocations', actor, h.reply);
    expect(h.findUnique).toHaveBeenCalledTimes(2);
    expect(h.storage.increment).toHaveBeenCalledTimes(4);
  });
  it('denies an unknown or failed plan without charging or exposing provider messages', async () => {
    for (const fail of [false, true]) {
      const h = harness(null);
      if (fail) h.withTenant.mockRejectedValueOnce(new Error('credential-sensitive-database-message'));
      await expect(h.quota.consume('listLocations', actor, h.reply)).rejects.toMatchObject({
        status: 503, code: 'rate_limit_plan_unavailable', message: 'Request limits are temporarily unavailable.',
      });
      expect(h.storage.increment).not.toHaveBeenCalled();
    }
  });
  it('does not charge the tenant when the principal is already blocked', async () => {
    const h = harness();
    h.storage.increment.mockResolvedValueOnce({ ...allowed, totalHits: 61, isBlocked: true, timeToBlockExpire: 60 });
    await expect(h.quota.consume('listLocations', actor, h.reply)).rejects.toMatchObject({ status: 429, code: 'rate_limited' });
    expect(h.storage.increment).toHaveBeenCalledTimes(1);
    expect(h.header).toHaveBeenCalledWith('Retry-After', 60);
  });
  it('keeps the first charge and emits standard Retry-After when the tenant is blocked', async () => {
    const h = harness();
    h.storage.increment.mockResolvedValueOnce(allowed).mockResolvedValueOnce({ ...allowed, totalHits: 601, isBlocked: true, timeToBlockExpire: 59 });
    await expect(h.quota.consume('listLocations', actor, h.reply)).rejects.toMatchObject({ status: 429, extensions: { retryAfterSeconds: 59 } });
    expect(h.storage.increment).toHaveBeenCalledTimes(2);
    expect(h.header).toHaveBeenCalledWith('Retry-After', 59);
    expect(h.header).toHaveBeenCalledWith('Retry-After-tenantCeiling', 59);
  });
  it('checks storage readiness without looking up a tenant', async () => {
    const h = harness();
    await h.quota.ready();
    expect(h.storage.ready).toHaveBeenCalledOnce();
    expect(h.withTenant).not.toHaveBeenCalled();
  });
});
