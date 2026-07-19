import type { SessionIdentity } from '@lunchlineup/api-contract';
import { describe, expect, it, vi } from 'vitest';
import { LocationService } from './locations.service';

const identity: SessionIdentity = {
  sub: 'user-1',
  tenantId: 'tenant-1',
  sessionId: 'session-1',
  role: 'Manager',
  legacyRole: 'MANAGER',
  roles: [{ id: 'role-1', name: 'Manager', isSystem: true, legacyRole: 'MANAGER' }],
  permissions: ['locations:read', 'locations:write', 'locations:delete'],
  mfaVerified: true,
  mfaRequired: false,
};

const publicId = '34aa4812-63f5-4e5c-8b3a-06b564987a1f';
const nextPublicId = '52bd9b37-1184-4eb3-9c2e-b7cc6c88982c';

function row(overrides: Record<string, unknown> = {}) {
  return {
    publicId,
    name: 'Downtown Diner',
    address: null,
    timezone: 'America/Los_Angeles',
    createdAt: new Date('2026-07-18T00:00:00.000Z'),
    updatedAt: new Date('2026-07-18T00:00:00.000Z'),
    ...overrides,
  };
}

function service(transaction: Record<string, unknown>) {
  const withTenant = vi.fn(async (_tenantId: string, operation: (tx: unknown) => unknown) => operation(transaction));
  return {
    instance: new LocationService({ withTenant } as never),
    withTenant,
  };
}

describe('native API v2 location service', () => {
  it('lists public records with an opaque public-ID cursor and no storage identifiers', async () => {
    const findMany = vi.fn(async () => [
      row({ id: 'storage-1' }),
      row({ id: 'storage-2', publicId: nextPublicId, name: 'Uptown Diner' }),
    ]);
    const { instance } = service({ location: { findMany } });

    const response = await instance.list(identity, { limit: '1' });

    expect(response.data).toEqual([{
      id: publicId,
      name: 'Downtown Diner',
      address: null,
      timezone: 'America/Los_Angeles',
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
    }]);
    expect(response.pagination).toMatchObject({ limit: 1, hasMore: true, nextCursor: expect.any(String) });
    expect(JSON.stringify(response)).not.toContain('storage-1');
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ name: 'asc' }, { publicId: 'asc' }],
      take: 2,
    }));
  });

  it('uses the tenant capacity lock and returns an identical idempotent create replay', async () => {
    let stored: Record<string, unknown> | null = null;
    const location = {
      findFirst: vi.fn(async ({ where }: { where: { creationRequestKeyHash?: string } }) => (
        stored && where.creationRequestKeyHash ? stored : null
      )),
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        stored = row({ ...data });
        return stored;
      }),
    };
    const transaction = {
      $executeRaw: vi.fn(async () => undefined),
      tenant: {
        findUnique: vi.fn(async () => ({
          planTier: 'FREE',
          status: 'ACTIVE',
          stripeSubscriptionId: null,
          stripeSubscriptionCurrentPeriodEnd: null,
          trialEndsAt: null,
        })),
      },
      planDefinition: { findUnique: vi.fn(async () => ({ name: 'Free', locationLimit: 1 })) },
      location,
    };
    const { instance } = service(transaction);
    const request = { name: 'Downtown Diner', timezone: 'America/Los_Angeles' };

    const first = await instance.create(identity, request, 'location-create-key');
    const replay = await instance.create(identity, request, 'location-create-key');

    expect(replay).toEqual(first);
    expect(location.create).toHaveBeenCalledOnce();
    expect(transaction.$executeRaw).toHaveBeenCalledTimes(2);
    expect(location.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ publicId: expect.stringMatching(/^[0-9a-f-]{36}$/i) }),
    }));
  });

  it('locks an active location, invalidates draft schedules after a timezone rewrite, and returns its public record', async () => {
    const location = {
      update: vi.fn(async () => row({ timezone: 'America/Denver' })),
    };
    const schedule = { updateMany: vi.fn(async () => ({ count: 2 })) };
    const transaction = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([{ id: 'location-storage-1', publicId, timezone: 'America/Los_Angeles' }])
        .mockResolvedValueOnce([{ id: 'schedule-1', status: 'DRAFT' }]),
      location,
      schedule,
    };
    const { instance } = service(transaction);

    const result = await instance.update(identity, publicId, {
      name: 'Downtown Diner',
      timezone: 'America/Denver',
    });

    expect(result.id).toBe(publicId);
    expect(location.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'location-storage-1' },
      data: { name: 'Downtown Diner', timezone: 'America/Denver' },
    }));
    expect(schedule.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        locationId: 'location-storage-1',
        status: 'DRAFT',
        deletedAt: null,
      },
      data: { revision: { increment: 1 } },
    });
    expect(location.update.mock.invocationCallOrder[0]).toBeLessThan(schedule.updateMany.mock.invocationCallOrder[0]);
  });

  it('fails closed before a timezone rewrite when published history exists', async () => {
    const location = { update: vi.fn() };
    const transaction = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([{ id: 'location-storage-1', publicId, timezone: 'America/Los_Angeles' }])
        .mockResolvedValueOnce([{ id: 'schedule-1', status: 'PUBLISHED' }]),
      location,
      schedule: { updateMany: vi.fn() },
    };
    const { instance } = service(transaction);

    await expect(instance.update(identity, publicId, { timezone: 'America/Denver' }))
      .rejects.toMatchObject({ status: 409, code: 'location_timezone_locked' });
    expect(location.update).not.toHaveBeenCalled();
  });

  it('resolves public and internal location identifiers through tenant-scoped database reads', async () => {
    const findMany = vi.fn()
      .mockResolvedValueOnce([{ id: 'location-storage-1', publicId }])
      .mockResolvedValueOnce([{ id: 'location-storage-1', publicId }]);
    const { instance } = service({ location: { findMany } });

    await expect(instance.resolvePublicIds('tenant-1', [publicId, publicId]))
      .resolves.toEqual(new Map([[publicId, 'location-storage-1']]));
    await expect(instance.resolveInternalIds('tenant-1', ['location-storage-1']))
      .resolves.toEqual(new Map([['location-storage-1', publicId]]));
    expect(findMany).toHaveBeenNthCalledWith(1, {
      where: { tenantId: 'tenant-1', publicId: { in: [publicId] }, deletedAt: null },
      select: { id: true, publicId: true },
    });
  });
});
