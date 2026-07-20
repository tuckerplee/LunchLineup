import type { SessionIdentity } from '@lunchlineup/api-contract';
import { describe, expect, it, vi } from 'vitest';
import { NotificationService } from './notifications.service';

const identity: SessionIdentity = {
  sub: 'user-storage-id',
  publicUserId: 'f6776d21-bb21-4c35-a6ed-5da8df5ed238',
  tenantId: 'tenant-storage-id',
  sessionId: 'session-1',
  role: 'ADMIN',
  legacyRole: 'ADMIN',
  roles: [],
  permissions: ['notifications:read', 'notifications:write'],
  mfaVerified: true,
  mfaRequired: false,
};

const firstId = '1ca23c44-76c9-4f5d-b3a7-3d35f8629c63';
const secondId = '1ca23c44-76c9-4f5d-b3a7-3d35f8629c64';

function harness() {
  const rows = [
    {
      publicId: firstId,
      type: 'INFO' as const,
      title: 'Newest',
      body: 'Newest message',
      readAt: null,
      createdAt: new Date('2026-07-19T01:00:00.000Z'),
    },
    {
      publicId: secondId,
      type: 'SUCCESS' as const,
      title: 'Older',
      body: 'Older message',
      readAt: null,
      createdAt: new Date('2026-07-19T00:00:00.000Z'),
    },
  ];
  const transaction = {
    notification: {
      findMany: vi.fn(async () => rows),
      count: vi.fn(async () => rows.filter((row) => row.readAt === null).length),
      updateMany: vi.fn(async ({ where }: { where: { publicId?: { in: string[] } } }) => ({
        count: where.publicId?.in.length ?? rows.filter((row) => row.readAt === null).length,
      })),
    },
  };
  const withTenant = vi.fn(async (_tenantId: string, operation: (tx: unknown) => unknown) => operation(transaction));
  return {
    instance: new NotificationService({ withTenant } as never),
    transaction,
    withTenant,
  };
}

describe('native API v2 notification owner', () => {
  it('serializes only public notification IDs and emits opaque pagination', async () => {
    const { instance, withTenant } = harness();

    const result = await instance.list(identity, { limit: '1', status: 'all' });

    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.id).toBe(firstId);
    expect(result.pagination).toMatchObject({ limit: 1, maxLimit: 100, hasMore: true });
    expect(result.pagination.nextCursor).toEqual(expect.any(String));
    expect(JSON.stringify(result)).not.toContain(identity.tenantId);
    expect(JSON.stringify(result)).not.toContain(identity.sub);
    expect(withTenant).toHaveBeenCalledWith(identity.tenantId, expect.any(Function));
  });

  it('uses only tenant/session scoped public IDs for read-state changes', async () => {
    const { instance, transaction } = harness();

    const result = await instance.markRead(identity, [firstId]);

    expect(result).toEqual({ updated: 1, unreadCount: 2 });
    expect(transaction.notification.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        tenantId: identity.tenantId,
        userId: identity.sub,
        publicId: { in: [firstId] },
      }),
    }));
  });

  it('rejects malformed cursor and private/non-UUID read targets', async () => {
    const { instance } = harness();

    await expect(instance.list(identity, { cursor: 'not-a-cursor' }))
      .rejects.toMatchObject({ code: 'invalid_notification_cursor' });
    await expect(instance.markRead(identity, ['notification-storage-id']))
      .rejects.toMatchObject({ code: 'invalid_notification_ids' });
  });
});
