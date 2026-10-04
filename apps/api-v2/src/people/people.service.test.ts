import { performance } from 'node:perf_hooks';
import { profileVersion } from './profile-version';
import type { SessionIdentity } from '@lunchlineup/api-contract';
import { describe, expect, it, vi } from 'vitest';
import { PeopleService } from './people.service';

const publicUserId = 'f6776d21-bb21-4c35-a6ed-5da8df5ed238';
const nextPublicUserId = '176d5a09-622e-40c4-8788-8beb516afedf';
const publicRoleId = '2680ed8d-a36a-43ea-b83a-5f4ebf9bea4f';

const identity: SessionIdentity = {
  sub: 'actor-storage-1',
  publicUserId,
  tenantId: 'tenant-1',
  sessionId: 'session-1',
  role: 'MANAGER',
  legacyRole: 'MANAGER',
  roles: [{ id: publicRoleId, name: 'Manager', isSystem: true, legacyRole: 'MANAGER' }],
  permissions: ['users:read', 'roles:read'],
  mfaVerified: true,
  mfaRequired: false,
};

function assignedRole(overrides: Record<string, unknown> = {}) {
  return {
    id: 'role-storage-1',
    publicId: publicRoleId,
    name: 'Staff',
    slug: 'staff',
    description: null,
    isSystem: true,
    isDefault: true,
    legacyRole: 'STAFF' as const,
    rolePermissions: [{ permission: { key: 'users:read' } }],
    ...overrides,
  };
}

function service(transaction: Record<string, unknown>) {
  const withTenant = vi.fn(async (_tenantId: string, operation: (tx: unknown) => unknown) => operation(transaction));
  return {
    instance: new PeopleService({ withTenant } as never, {
      staffInvitationOutboxEnabled: false,
      staffInvitationOutboxEncryptionKey: '',
      staffInvitationMaxAttempts: 8,
    }, { observeSessionMfa: async selected => {
      expect(selected).toEqual({ sub: identity.sub, tenantId: identity.tenantId, sessionId: identity.sessionId });
      return { ...selected, expiresAtEpochMs: Date.now() + 60_000, expiresAtMonotonicMs: performance.now() + 60_000 };
    } }),
    withTenant,
  };
}

describe('native API v2 people service', () => {
  it('lists public staff records with opaque cursors and no user storage identifiers', async () => {
    const transaction = {
      user: {
        findMany: vi.fn(async () => [
          {
            id: 'user-storage-1', publicId: publicUserId, createdAt: new Date('2026-07-19T00:00:00.000Z'),
            name: 'Casey', email: 'casey@example.test', username: null, role: 'STAFF', pinHash: null, pinResetRequired: false,
          },
          {
            id: 'user-storage-2', publicId: nextPublicUserId, createdAt: new Date('2026-07-20T00:00:00.000Z'),
            name: 'Jamie', email: 'jamie@example.test', username: null, role: 'STAFF', pinHash: null, pinResetRequired: false,
          },
        ]),
      },
      roleAssignment: {
        findMany: vi.fn(async () => [{ userId: 'user-storage-1', role: assignedRole() }]),
      },
      $queryRaw: vi.fn(async () => [{ totalUsers: 2, staffCount: 2, managerCount: 0, privilegedUsers: 0, pinAccounts: 0 }]),
    };
    const { instance } = service(transaction);

    const response = await instance.list(identity, { limit: '1' });

    expect(response).toMatchObject({
      data: [{
        id: publicUserId,
        name: 'Casey',
        assignedRoles: [{ id: publicRoleId, permissions: ['users:read'] }],
      }],
      pagination: { limit: 1, returned: 1, hasMore: true, nextCursor: expect.any(String) },
      summary: { totalUsers: 2, staffCount: 2 },
    });
    expect(JSON.stringify(response)).not.toContain('user-storage-1');
    expect(transaction.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ createdAt: 'asc' }, { publicId: 'asc' }],
      take: 2,
    }));
  });

  it('publishes an access catalog with public role UUIDs only', async () => {
    const transaction = {
      permission: {
        findMany: vi.fn(async () => [{ key: 'users:read', label: 'Read staff', description: null, category: 'USERS' }]),
      },
      role: {
        findMany: vi.fn(async () => [{ ...assignedRole(), _count: { assignments: 3 } }]),
      },
      tenantSetting: { findUnique: vi.fn(async () => null) },
    };
    const { instance } = service(transaction);

    const response = await instance.accessCatalog(identity);

    expect(response).toEqual({
      permissions: [{ key: 'users:read', label: 'Read staff', description: null, category: 'USERS' }],
      defaultInviteRoleId: publicRoleId,
      roles: [{
        id: publicRoleId,
        name: 'Staff',
        description: null,
        isSystem: true,
        legacyRole: 'STAFF',
        permissions: ['users:read'],
        slug: 'staff',
        isDefault: true,
        userCount: 3,
        canDelegate: true,
      }],
    });
    expect(JSON.stringify(response)).not.toContain('role-storage-1');
  });

  it('resolves retained user references through tenant-scoped public and internal maps', async () => {
    const findMany = vi.fn()
      .mockResolvedValueOnce([{ id: 'user-storage-1', publicId: publicUserId }])
      .mockResolvedValueOnce([{ id: 'user-storage-1', publicId: publicUserId }]);
    const { instance } = service({ user: { findMany } });

    await expect(instance.resolvePublicUserIds('tenant-1', [publicUserId, publicUserId]))
      .resolves.toEqual(new Map([[publicUserId, 'user-storage-1']]));
    await expect(instance.resolveInternalUserIds('tenant-1', ['user-storage-1']))
      .resolves.toEqual(new Map([['user-storage-1', publicUserId]]));
    expect(findMany).toHaveBeenNthCalledWith(1, {
      where: { tenantId: 'tenant-1', publicId: { in: [publicUserId] }, deletedAt: null },
      select: { id: true, publicId: true },
    });
    expect(findMany).toHaveBeenNthCalledWith(2, {
      where: { tenantId: 'tenant-1', id: { in: ['user-storage-1'] } },
      select: { id: true, publicId: true },
    });
  });

  it('reads tenant-scoped recurring and dated availability with public location identifiers', async () => {
    const locationPublicId = '34aa4812-63f5-4e5c-8b3a-06b564987a1f';
    const transaction = {
      user: {
        findFirst: vi.fn(async () => ({ id: 'user-storage-1', publicId: publicUserId, name: 'Casey' })),
      },
      staffSkill: {
        findMany: vi.fn(async () => [{ skill: 'expo' }]),
      },
      staffAvailability: {
        findMany: vi.fn(async () => [{
          locationId: 'location-storage-1',
          dayOfWeek: 2,
          startTimeMinutes: 540,
          endTimeMinutes: 1020,
          location: { publicId: locationPublicId },
        }]),
      },
      staffAvailabilityException: {
        findMany: vi.fn(async () => [{
          locationId: 'location-storage-1',
          localDate: new Date('2026-08-21T00:00:00.000Z'),
          kind: 'UNAVAILABLE' as const,
          startTimeMinutes: 0,
          endTimeMinutes: 1440,
          location: { publicId: locationPublicId },
        }]),
      },
    };
    const { instance } = service(transaction);

    await expect(instance.schedulingProfile(identity, publicUserId)).resolves.toEqual({
      version: expect.stringMatching(/^[a-f0-9]{64}$/),
      user: { id: publicUserId, name: 'Casey' },
      skills: ['expo'],
      availability: [{
        locationId: locationPublicId,
        dayOfWeek: 2,
        startTimeMinutes: 540,
        endTimeMinutes: 1020,
      }],
      availabilityExceptions: [{
        locationId: locationPublicId,
        date: '2026-08-21',
        kind: 'UNAVAILABLE',
        allDay: true,
        startTimeMinutes: 0,
        endTimeMinutes: 1440,
      }],
      availabilityConfigured: true,
    });
    expect(transaction.staffAvailabilityException.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 'tenant-1', userId: 'user-storage-1' },
      take: 367,
    }));
  });

  it('atomically replaces dated exceptions and invalidates only intersecting draft dates', async () => {
    const locationPublicId = '34aa4812-63f5-4e5c-8b3a-06b564987a1f';
    const draftQueries: any[] = [];
    const lockedUser = (id: string, role: 'MANAGER' | 'STAFF') => ({
      id,
      publicId: id === 'actor-storage-1' ? nextPublicUserId : publicUserId,
      role,
      name: id === 'actor-storage-1' ? 'Manager' : 'Casey',
      email: null,
      username: null,
      suspendedAt: null,
      deletedAt: null,
      lockedUntil: null,
      pinLockedUntil: null,
    });
    const transaction = {
      tenant: { findUnique: vi.fn(async ({ where }) => where.id === identity.tenantId ? { status: 'ACTIVE', deletedAt: null } : null) },
      tenantSetting: { findUnique: vi.fn(async () => null) },
      session: { findFirst: vi.fn(async ({ where }) => where.id === identity.sessionId && where.userId === identity.sub
        ? { id: identity.sessionId, userId: identity.sub, createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000), revokedAt: null } : null) },
      user: {
        findFirst: vi.fn(async ({ where }) => where.id === identity.sub
          ? { id: identity.sub, tenantId: identity.tenantId, pinResetRequired: false, mfaEnabled: false }
          : { id: 'user-storage-1', publicId: publicUserId, name: 'Casey' }),
      },
      roleAssignment: {
        findMany: vi.fn(async () => [{ userId: 'actor-storage-1', roleId: 'role-manager' }]),
      },
      role: {
        findMany: vi.fn(async () => [{
          id: 'role-manager',
          publicId: publicRoleId,
          name: 'Manager',
          slug: 'manager',
          description: null,
          isSystem: true,
          isDefault: false,
          legacyRole: 'MANAGER' as const,
          rolePermissions: [{ permission: { key: 'users:write' } }],
        }]),
      },
      location: {
        findMany: vi.fn(async () => [{ id: 'location-storage-1', publicId: locationPublicId }]),
      },
      staffSkill: {
        findMany: vi.fn(async () => [{ skill: 'expo' }]),
        deleteMany: vi.fn(async () => ({ count: 1 })),
        createMany: vi.fn(async () => ({ count: 1 })),
      },
      staffAvailability: {
        findMany: vi.fn(async () => []),
        deleteMany: vi.fn(async () => ({ count: 0 })),
        createMany: vi.fn(async () => ({ count: 0 })),
      },
      staffAvailabilityException: {
        findMany: vi.fn(async () => [{
          locationId: 'location-storage-1',
          localDate: new Date('2026-08-21T00:00:00.000Z'),
          kind: 'UNAVAILABLE' as const,
          startTimeMinutes: 0,
          endTimeMinutes: 1440,
          location: { publicId: locationPublicId },
        }]),
        deleteMany: vi.fn(async () => ({ count: 1 })),
        createMany: vi.fn(async () => ({ count: 1 })),
      },
      schedule: {
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      $executeRaw: vi.fn(async () => 1),
      $queryRaw: vi.fn(async (query: any) => {
        const sql = Array.isArray(query?.strings) ? query.strings.join(' ') : String(query);
        if (sql.includes('FROM "Tenant"')) return [{ id: 'tenant-1' }];
        if (sql.includes('FROM "Session"')) return [{
          id: identity.sessionId,
          userId: identity.sub,
          expiresAt: new Date('2100-01-01T00:00:00.000Z'),
          revokedAt: null,
        }];
        if (sql.includes('FROM "RolePermission"')) return [];
        if (sql.includes('FROM "Role"')) return [{ id: 'role-manager' }];
        if (sql.includes('FROM "Schedule" schedule')) {
          draftQueries.push(query);
          return [{ id: 'schedule-storage-1' }];
        }
        if (sql.includes('FROM "Location"')) return [{ id: 'location-storage-1' }];
        if (sql.includes('AND "role" IN')) return [{ id: 'user-storage-1' }];
        if (sql.includes('FROM "User"')) {
          return [lockedUser('actor-storage-1', 'MANAGER'), lockedUser('user-storage-1', 'STAFF')];
        }
        return [];
      }),
    };
    const { instance, withTenant } = service(transaction);

    await expect(instance.replaceSchedulingProfile(identity, publicUserId, {
      skills: ['expo'], availability: [], expectedVersion: '0'.repeat(64),
    })).rejects.toMatchObject({ status: 409, code: 'scheduling_profile_changed' });
    expect(transaction.staffSkill.deleteMany).not.toHaveBeenCalled();
    expect(transaction.staffAvailability.deleteMany).not.toHaveBeenCalled();
    expect(transaction.schedule.updateMany).not.toHaveBeenCalled();
    const expectedVersion = profileVersion('user-storage-1', ['expo'], [], await transaction.staffAvailabilityException.findMany());

    await expect(instance.replaceSchedulingProfile(identity, publicUserId, {
      expectedVersion,
      skills: ['expo'],
      availability: [],
      availabilityExceptions: [{
        locationId: locationPublicId,
        date: '2026-08-21',
        kind: 'AVAILABLE',
        allDay: false,
        startTimeMinutes: 720,
        endTimeMinutes: 1020,
      }],
    })).resolves.toMatchObject({
      availabilityExceptions: [{
        locationId: locationPublicId,
        date: '2026-08-21',
        kind: 'AVAILABLE',
        allDay: false,
        startTimeMinutes: 720,
        endTimeMinutes: 1020,
      }],
      availabilityConfigured: true,
    });

    expect(withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function), { isolationLevel: 'Serializable' });
    expect(transaction.staffAvailabilityException.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', userId: 'user-storage-1' },
    });
    expect(transaction.staffAvailabilityException.createMany).toHaveBeenCalledWith({
      data: [{
        tenantId: 'tenant-1',
        userId: 'user-storage-1',
        locationId: 'location-storage-1',
        localDate: new Date('2026-08-21T00:00:00.000Z'),
        kind: 'AVAILABLE',
        startTimeMinutes: 720,
        endTimeMinutes: 1020,
      }],
    });
    expect(draftQueries).toHaveLength(1);
    expect(draftQueries[0].values).toEqual(expect.arrayContaining([
      'tenant-1',
      'location-storage-1',
      '2026-08-21',
    ]));
    expect(transaction.schedule.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['schedule-storage-1'] },
        tenantId: 'tenant-1',
        status: 'DRAFT',
        deletedAt: null,
      },
      data: { revision: { increment: 1 } },
    });
  });

  it('rejects invalid local dates and all-day boundaries before opening a tenant transaction', async () => {
    const { instance, withTenant } = service({});
    await expect(instance.replaceSchedulingProfile(identity, publicUserId, {
      skills: [],
      availability: [],
      availabilityExceptions: [{
        locationId: null,
        date: '2026-02-30',
        kind: 'UNAVAILABLE',
        allDay: true,
        startTimeMinutes: 60,
        endTimeMinutes: 120,
      }],
    })).rejects.toMatchObject({ status: 422, code: 'invalid_scheduling_profile' });
    await expect(instance.replaceSchedulingProfile(identity, publicUserId, {
      skills: [],
      availability: [],
      availabilityExceptions: [{
        locationId: null,
        date: '2026-08-21',
        kind: 'UNAVAILABLE',
        allDay: true,
        startTimeMinutes: 60,
        endTimeMinutes: 120,
      }],
    })).rejects.toMatchObject({ status: 422, code: 'invalid_scheduling_profile' });
    await expect(instance.replaceSchedulingProfile(identity, publicUserId, {
      skills: [],
      availability: [],
      availabilityExceptions: [{
        locationId: null,
        date: '2026-08-21',
        kind: 'UNAVAILABLE',
        allDay: false,
        startTimeMinutes: 0,
        endTimeMinutes: 1440,
      }],
    })).rejects.toMatchObject({ status: 422, code: 'invalid_scheduling_profile' });
    expect(withTenant).not.toHaveBeenCalled();
  });
});


describe('staff creation recovery boundaries', () => {
  it('rejects recovery requests without an explicit PIN before opening a transaction', async () => {
    const { instance, withTenant } = service({});
    await expect(instance.invite(identity, { name: 'Casey', username: 'casey', role: 'STAFF' }, 'request-1'))
      .rejects.toMatchObject({ status: 422, code: 'invalid_pin' });
    expect(withTenant).not.toHaveBeenCalled();
  });

  it('rejects a changed payload for a completed request without attempting another create', async () => {
    const create = vi.fn();
    const { instance } = service({
      tenant: { findUnique: vi.fn(async ({ where }: any) => where.id === identity.tenantId ? { status: 'ACTIVE', deletedAt: null } : null) },
      tenantSetting: { findUnique: vi.fn(async ({ where }: any) => where.tenantId_key.key === 'workspace_settings' ? null : { value: { fingerprint: 'different' } }) },
      user: { create, findFirst: vi.fn(async ({ where }: any) => where.id === identity.sub && where.tenantId === identity.tenantId
        ? { id: identity.sub, tenantId: identity.tenantId, pinResetRequired: false, mfaEnabled: false } : null) },
      session: { findFirst: vi.fn(async ({ where }: any) => where.id === identity.sessionId && where.userId === identity.sub
        ? { id: identity.sessionId, userId: identity.sub, createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000), revokedAt: null } : null) },
      roleAssignment: { findMany: vi.fn(async () => [{ userId: identity.sub, roleId: 'recovery-manager' }]) },
      role: { findMany: vi.fn(async () => [{ ...assignedRole(), id: 'recovery-manager', legacyRole: 'MANAGER',
        rolePermissions: [{ permission: { key: 'users:write' } }] }]) },
      $queryRaw: vi.fn(async (query: any) => {
        const sql = query.strings.join('');
        if (sql.includes('FROM "Tenant"')) return [{ id: identity.tenantId }];
        if (sql.includes('FROM "User"')) return [{ id: identity.sub, role: 'MANAGER', deletedAt: null, suspendedAt: null, lockedUntil: null, pinLockedUntil: null }];
        if (sql.includes('FROM "Session"')) return [{ id: identity.sessionId, userId: identity.sub, expiresAt: new Date(Date.now() + 60_000), revokedAt: null }];
        if (sql.includes('FROM "Role"')) return [{ id: 'recovery-manager' }];
        if (sql.includes('FROM "RolePermission"')) return [];
        throw new Error('Unexpected recovery fixture authority read');
      }),
    });
    await expect(instance.invite(identity, { name: 'Casey', username: 'casey', pin: '123456', role: 'STAFF' }, 'request-1'))
      .rejects.toMatchObject({ status: 409, code: 'staff_request_conflict' });
    expect(create).not.toHaveBeenCalled();
  });
});


describe('staff identity validation', () => {
  it.each([
    { name: ' ', username: 'casey', email: '' },
    { name: 'Casey', username: 'casey', email: 'casey@example.test' },
    { name: 'Casey', username: 'invalid username', email: '' },
  ])('rejects invalid identity edits before mutation', async (body) => {
    const { instance, withTenant } = service({});
    await expect(instance.updateIdentity(identity, publicUserId, { ...body, expectedVersion: 'a'.repeat(64) }))
      .rejects.toMatchObject({ status: 422, code: 'invalid_staff' });
    expect(withTenant).not.toHaveBeenCalled();
  });
});
