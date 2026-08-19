import { describe, expect, it, vi } from 'vitest';
import { InvitationOutbox } from './invitation-outbox';

const config = {
  staffInvitationOutboxEnabled: true,
  staffInvitationOutboxEncryptionKey: '11'.repeat(32),
  staffInvitationMaxAttempts: 8,
};

describe('staff invitation outbox', () => {
  it('stores an encrypted producer command without retaining an email address in clear text', async () => {
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...data }));
    const transaction = {
      staffInvitationOutbox: {
        findUnique: vi.fn(async () => null),
        create,
      },
    };
    const outbox = new InvitationOutbox(config);

    const delivery = await outbox.enqueue(transaction as never, {
      tenantId: 'tenant-1',
      userId: 'user-storage-1',
      recipient: 'casey@example.test',
    });

    expect(delivery).toMatchObject({ status: 'PENDING', attempts: 0, canRetry: false, canReissue: false });
    const data = create.mock.calls[0]?.[0].data as Record<string, unknown>;
    expect(data.recipientHash).toMatch(/^[a-f0-9]{64}$/);
    expect(data.purpose).toBe('STAFF_INVITATION');
    expect(data.encryptedPayload).toBeInstanceOf(Buffer);
    expect(Buffer.from(data.encryptedPayload as Buffer).toString('utf8')).not.toContain('casey@example.test');
    expect(data.encryptionNonce).toBeInstanceOf(Buffer);
    expect(data.encryptionTag).toBeInstanceOf(Buffer);
  });

  it('fails before a database write when encrypted invitation delivery is not configured', async () => {
    const findUnique = vi.fn();
    const outbox = new InvitationOutbox({
      staffInvitationOutboxEnabled: false,
      staffInvitationOutboxEncryptionKey: '',
      staffInvitationMaxAttempts: 8,
    });

    await expect(outbox.enqueue({
      staffInvitationOutbox: { findUnique },
    } as never, {
      tenantId: 'tenant-1',
      userId: 'user-storage-1',
      recipient: 'casey@example.test',
    })).rejects.toMatchObject({ status: 503, code: 'staff_invitation_delivery_unavailable' });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('uses the shared worker attempt ceiling when reporting retry eligibility', async () => {
    const outbox = new InvitationOutbox({ ...config, staffInvitationMaxAttempts: 3 });
    const delivery = await outbox.status({
      user: { findFirst: vi.fn(async () => ({ id: 'user-storage-1' })) },
      staffInvitationOutbox: {
        findUnique: vi.fn(async () => ({
          id: '3d5e8293-e43c-4d4e-8dac-ee5915ec2f78',
          status: 'FAILED',
          attempts: 3,
          manualRetryCount: 0,
          encryptedPayload: Buffer.from('opaque'),
          retryAt: new Date('2026-07-19T00:00:00.000Z'),
          deliveredAt: null,
          deadLetteredAt: null,
          lastErrorCode: 'PROVIDER_RETRYABLE',
        })),
      },
    } as never, 'tenant-1', 'user-storage-1');

    expect(delivery).toMatchObject({ status: 'FAILED', attempts: 3, canRetry: false });
  });
});
