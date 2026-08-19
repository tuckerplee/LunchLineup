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
    }),
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
});
