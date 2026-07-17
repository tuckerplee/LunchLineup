import { createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
    StaffInvitationOutboxService,
    staffInvitationOutboxAad,
} from './staff-invitation-outbox.service';

const key = Buffer.alloc(32, 0x5a);
const contractFixture = JSON.parse(readFileSync(
    resolve(process.cwd(), 'src/users/staff-invitation-outbox.contract-fixture.json'),
    'utf8',
)) as {
    keyHex: string;
    tenantId: string;
    outboxId: string;
    userId: string;
    recipientHash: string;
    purpose: string;
    payloadVersion: number;
    aadUtf8: string;
    nonceBase64: string;
    tagBase64: string;
    ciphertextBase64: string;
    expectedPayload: { recipient: string; template: string };
};

function service(
    configured = key.toString('base64'),
    enabled = 'true',
    maxAttempts = '8',
) {
    return new StaffInvitationOutboxService({
        get: (name: string) => {
            if (name === 'STAFF_INVITATION_OUTBOX_ENABLED') return enabled;
            if (name === 'STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY') return configured;
            if (name === 'STAFF_INVITATION_MAX_ATTEMPTS') return maxAttempts;
            return undefined;
        },
    } as never);
}

function row(overrides: Record<string, unknown> = {}) {
    return {
        id: 'outbox-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        recipientHash: 'a'.repeat(64),
        purpose: 'STAFF_INVITATION',
        encryptedPayload: Buffer.from('ciphertext'),
        status: 'FAILED',
        attempts: 2,
        manualRetryCount: 0,
        retryAt: new Date('2026-07-16T12:00:00.000Z'),
        deliveredAt: null,
        deadLetteredAt: null,
        lastErrorCode: null,
        ...overrides,
    };
}

describe('StaffInvitationOutboxService', () => {
    it('matches the canonical version-bound worker decryption fixture', () => {
        const aad = staffInvitationOutboxAad({
            tenantId: contractFixture.tenantId,
            outboxId: contractFixture.outboxId,
            userId: contractFixture.userId,
            recipientHash: contractFixture.recipientHash,
            purpose: contractFixture.purpose,
            payloadVersion: contractFixture.payloadVersion,
        });
        expect(aad.toString('utf8')).toBe(contractFixture.aadUtf8);

        const decipher = createDecipheriv(
            'aes-256-gcm',
            Buffer.from(contractFixture.keyHex, 'hex'),
            Buffer.from(contractFixture.nonceBase64, 'base64'),
        );
        decipher.setAAD(aad);
        decipher.setAuthTag(Buffer.from(contractFixture.tagBase64, 'base64'));
        const plaintext = Buffer.concat([
            decipher.update(Buffer.from(contractFixture.ciphertextBase64, 'base64')),
            decipher.final(),
        ]);
        expect(JSON.parse(plaintext.toString('utf8'))).toEqual(contractFixture.expectedPayload);
    });

    it('encrypts recipient and template with per-record AES-256-GCM AAD', async () => {
        const tx = {
            staffInvitationOutbox: {
                findUnique: vi.fn().mockResolvedValue(null),
                create: vi.fn().mockImplementation(async ({ data }) => data),
            },
        };

        const created = await service().enqueueInTransaction(tx as never, {
            tenantId: 'tenant-1',
            userId: 'user-1',
            recipient: ' Invitee@Example.com ',
        });
        const data = tx.staffInvitationOutbox.create.mock.calls[0][0].data;
        expect(data.encryptionNonce).toHaveLength(12);
        expect(data.encryptionTag).toHaveLength(16);
        expect(data.recipientHash).toMatch(/^[a-f0-9]{64}$/);
        expect(data.encryptionKeyRef).toMatch(/^[a-f0-9]{16}$/);
        expect(JSON.stringify(data)).not.toContain('invitee@example.com');
        expect(JSON.stringify(data)).not.toContain('staff_invitation');

        const aad = staffInvitationOutboxAad({
            tenantId: data.tenantId,
            outboxId: data.id,
            userId: data.userId,
            recipientHash: data.recipientHash,
            purpose: data.purpose,
            payloadVersion: data.payloadVersion,
        });
        const decipher = createDecipheriv('aes-256-gcm', key, data.encryptionNonce);
        decipher.setAAD(aad);
        decipher.setAuthTag(data.encryptionTag);
        const plaintext = Buffer.concat([
            decipher.update(data.encryptedPayload),
            decipher.final(),
        ]);
        expect(JSON.parse(plaintext.toString('utf8'))).toEqual({
            recipient: 'invitee@example.com',
            template: 'staff_invitation',
        });
        expect(created.id).toBe(data.id);

        const wrong = createDecipheriv('aes-256-gcm', key, data.encryptionNonce);
        wrong.setAAD(staffInvitationOutboxAad({
            tenantId: 'tenant-2',
            outboxId: data.id,
            userId: data.userId,
            recipientHash: data.recipientHash,
            purpose: data.purpose,
            payloadVersion: data.payloadVersion,
        }));
        wrong.setAuthTag(data.encryptionTag);
        expect(() => Buffer.concat([wrong.update(data.encryptedPayload), wrong.final()])).toThrow();
    });

    it.each(['DELIVERED', 'DEAD_LETTERED', 'CANCELLED'])(
        'creates a fresh provider action when re-enqueuing an archived user from %s',
        async (status) => {
        const tx = {
            staffInvitationOutbox: {
                findUnique: vi.fn().mockResolvedValue({ id: 'archived-outbox', status }),
                update: vi.fn().mockImplementation(async ({ data }) => ({
                    ...row(),
                    ...data,
                })),
            },
        };

        const result = await service(key.toString('hex')).enqueueInTransaction(tx as never, {
            tenantId: 'tenant-1',
            userId: 'user-1',
            recipient: 'returning@example.com',
        });

        expect(result.id).not.toBe('archived-outbox');
        expect(tx.staffInvitationOutbox.update).toHaveBeenCalledWith({
            where: { id: 'archived-outbox' },
            data: expect.objectContaining({
                id: result.id,
                status: 'PENDING',
                attempts: 0,
                manualRetryCount: 0,
                diagnosticsErasedAt: null,
            }),
        });
    });

    it('retries a failed delivery once without creating a duplicate', async () => {
        const retryAt = new Date('2026-07-16T13:00:00.000Z');
        const tx = {
            user: { findFirst: vi.fn().mockResolvedValue({ id: 'user-1' }) },
            staffInvitationOutbox: {
                findUnique: vi.fn()
                    .mockResolvedValueOnce(row())
                    .mockResolvedValueOnce(row({
                        status: 'PENDING',
                        manualRetryCount: 1,
                        retryAt,
                    })),
                updateMany: vi.fn().mockResolvedValue({ count: 1 }),
                create: vi.fn(),
            },
            auditLog: { create: vi.fn().mockResolvedValue({}) },
        };

        const result = await service().retryInTransaction(tx as never, {
            tenantId: 'tenant-1',
            userId: 'user-1',
            actorUserId: 'admin-1',
        });

        expect(tx.staffInvitationOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                id: 'outbox-1',
                tenantId: 'tenant-1',
                userId: 'user-1',
                status: 'FAILED',
            }),
            data: expect.objectContaining({
                status: 'PENDING',
                manualRetryCount: { increment: 1 },
                lastErrorCode: null,
            }),
        }));
        expect(tx.staffInvitationOutbox.create).not.toHaveBeenCalled();
        expect(tx.auditLog.create).toHaveBeenCalledWith({
            data: {
                tenantId: 'tenant-1',
                userId: 'admin-1',
                action: 'USER_INVITATION_DELIVERY_RETRIED',
                resource: 'User',
                resourceId: 'user-1',
            },
        });
        expect(result).toEqual({
            deliveryId: 'outbox-1',
            status: 'queued',
            attempts: 2,
            nextAttemptAt: retryAt,
            canRetry: false,
            canReissue: false,
        });
    });

    it('makes repeated retry idempotent once delivery is pending', async () => {
        const pending = row({ status: 'PENDING' });
        const tx = {
            user: { findFirst: vi.fn().mockResolvedValue({ id: 'user-1' }) },
            staffInvitationOutbox: {
                findUnique: vi.fn().mockResolvedValue(pending),
                updateMany: vi.fn(),
            },
            auditLog: { create: vi.fn() },
        };

        await expect(service().retryInTransaction(tx as never, {
            tenantId: 'tenant-1',
            userId: 'user-1',
            actorUserId: 'admin-1',
        })).resolves.toMatchObject({ status: 'queued', attempts: 2 });

        expect(tx.staffInvitationOutbox.updateMany).not.toHaveBeenCalled();
        expect(tx.auditLog.create).not.toHaveBeenCalled();
    });

    it('denies cross-tenant and terminal retries', async () => {
        const crossTenant = {
            user: { findFirst: vi.fn().mockResolvedValue(null) },
            staffInvitationOutbox: { findUnique: vi.fn(), updateMany: vi.fn() },
        };
        await expect(service().retryInTransaction(crossTenant as never, {
            tenantId: 'tenant-1',
            userId: 'foreign-user',
            actorUserId: 'admin-1',
        })).rejects.toThrow('User not found');
        expect(crossTenant.staffInvitationOutbox.findUnique).not.toHaveBeenCalled();

        const terminal = {
            user: { findFirst: vi.fn().mockResolvedValue({ id: 'user-1' }) },
            staffInvitationOutbox: {
                findUnique: vi.fn().mockResolvedValue(row({
                    status: 'DEAD_LETTERED',
                    encryptedPayload: null,
                    retryAt: null,
                })),
                updateMany: vi.fn(),
            },
        };
        await expect(service().retryInTransaction(terminal as never, {
            tenantId: 'tenant-1',
            userId: 'user-1',
            actorUserId: 'admin-1',
        })).rejects.toThrow('terminal');
        expect(terminal.staffInvitationOutbox.updateMany).not.toHaveBeenCalled();
    });

    it('reissues a dead letter as one fresh encrypted delivery identity and audits the terminal evidence', async () => {
        const deadLetteredAt = new Date('2026-07-16T12:30:00.000Z');
        const terminal = row({
            id: 'dead-outbox',
            status: 'DEAD_LETTERED',
            attempts: 8,
            manualRetryCount: 3,
            encryptedPayload: null,
            retryAt: null,
            deadLetteredAt,
            lastErrorCode: 'PROVIDER_REJECTED',
        });
        let pending: ReturnType<typeof row> | undefined;
        const tx = {
            user: {
                findFirst: vi.fn().mockResolvedValue({
                    id: 'user-1',
                    email: ' Invitee@Example.com ',
                }),
            },
            staffInvitationOutbox: {
                findUnique: vi.fn()
                    .mockResolvedValueOnce(null)
                    .mockResolvedValueOnce(terminal)
                    .mockImplementationOnce(async ({ where }) => pending?.id === where.id ? pending : null),
                updateMany: vi.fn().mockImplementation(async ({ data }) => {
                    pending = row({ ...data, id: data.id });
                    return { count: 1 };
                }),
            },
            auditLog: {
                findFirst: vi.fn().mockResolvedValue(null),
                create: vi.fn().mockResolvedValue({}),
            },
        };

        const result = await service().reissueInTransaction(tx as never, {
            tenantId: 'tenant-1',
            userId: 'user-1',
            actorUserId: 'admin-1',
            idempotencyKey: 'reissue-attempt-1',
        });

        expect(result).toMatchObject({
            deliveryId: expect.stringMatching(/^[a-f0-9-]{36}$/),
            status: 'queued',
            attempts: 0,
            canRetry: false,
            canReissue: false,
        });
        expect(result.deliveryId).not.toBe('dead-outbox');
        expect(tx.staffInvitationOutbox.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'dead-outbox',
                tenantId: 'tenant-1',
                userId: 'user-1',
                purpose: 'STAFF_INVITATION',
                status: 'DEAD_LETTERED',
            },
            data: expect.objectContaining({
                id: result.deliveryId,
                status: 'PENDING',
                attempts: 0,
                manualRetryCount: 0,
                encryptedPayload: expect.any(Buffer),
                encryptionNonce: expect.any(Buffer),
                encryptionTag: expect.any(Buffer),
                deadLetteredAt: null,
                lastErrorCode: null,
            }),
        });
        const mutation = tx.staffInvitationOutbox.updateMany.mock.calls[0][0].data;
        const decipher = createDecipheriv('aes-256-gcm', key, mutation.encryptionNonce);
        decipher.setAAD(staffInvitationOutboxAad({
            tenantId: 'tenant-1',
            outboxId: mutation.id,
            userId: 'user-1',
            recipientHash: mutation.recipientHash,
            purpose: mutation.purpose,
            payloadVersion: mutation.payloadVersion,
        }));
        decipher.setAuthTag(mutation.encryptionTag);
        expect(JSON.parse(Buffer.concat([
            decipher.update(mutation.encryptedPayload),
            decipher.final(),
        ]).toString('utf8'))).toEqual({
            recipient: 'invitee@example.com',
            template: 'staff_invitation',
        });
        expect(tx.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                tenantId: 'tenant-1',
                userId: 'admin-1',
                actorUserId: 'admin-1',
                actorTenantId: 'tenant-1',
                action: 'USER_INVITATION_DELIVERY_REISSUED',
                resource: 'StaffInvitationOutbox',
                resourceId: result.deliveryId,
                oldValue: {
                    deliveryId: 'dead-outbox',
                    status: 'DEAD_LETTERED',
                    attempts: 8,
                    manualRetryCount: 3,
                    deadLetteredAt: deadLetteredAt.toISOString(),
                    lastErrorCode: 'PROVIDER_REJECTED',
                },
                newValue: expect.objectContaining({
                    deliveryId: result.deliveryId,
                    status: 'PENDING',
                    attempts: 0,
                    requestKeyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
                }),
            }),
        });
        expect(tx.user.findFirst).toHaveBeenCalledTimes(1);
    });

    it('replays the current reissue by key and refuses reuse after that action is historical', async () => {
        const current = row({
            id: 'placeholder',
            status: 'PENDING',
            attempts: 0,
            manualRetryCount: 0,
        });
        const replayTx = {
            staffInvitationOutbox: {
                findUnique: vi.fn().mockImplementation(async ({ where }) => ({
                    ...current,
                    id: where.id,
                })),
                updateMany: vi.fn(),
            },
            auditLog: { findFirst: vi.fn(), create: vi.fn() },
            user: { findFirst: vi.fn() },
        };
        const input = {
            tenantId: 'tenant-1',
            userId: 'user-1',
            actorUserId: 'admin-1',
            idempotencyKey: 'stable-reissue-key',
        };

        const first = await service().reissueInTransaction(replayTx as never, input);
        const second = await service().reissueInTransaction(replayTx as never, input);
        expect(second.deliveryId).toBe(first.deliveryId);
        expect(replayTx.staffInvitationOutbox.updateMany).not.toHaveBeenCalled();
        expect(replayTx.auditLog.create).not.toHaveBeenCalled();
        expect(replayTx.user.findFirst).not.toHaveBeenCalled();

        const historicalTx = {
            staffInvitationOutbox: { findUnique: vi.fn().mockResolvedValue(null) },
            auditLog: {
                findFirst: vi.fn().mockResolvedValue({ id: 'audit-1' }),
                create: vi.fn(),
            },
            user: { findFirst: vi.fn() },
        };
        await expect(service().reissueInTransaction(historicalTx as never, input))
            .rejects.toThrow('already completed');
        expect(historicalTx.user.findFirst).not.toHaveBeenCalled();
    });

    it('requires a bounded key and an active tenant-scoped email account for reissue', async () => {
        const missingKeyTx = {
            staffInvitationOutbox: { findUnique: vi.fn() },
        };
        await expect(service().reissueInTransaction(missingKeyTx as never, {
            tenantId: 'tenant-1',
            userId: 'user-1',
            actorUserId: 'admin-1',
            idempotencyKey: undefined,
        })).rejects.toThrow('Idempotency-Key');
        expect(missingKeyTx.staffInvitationOutbox.findUnique).not.toHaveBeenCalled();

        const foreignTx = {
            staffInvitationOutbox: { findUnique: vi.fn().mockResolvedValue(null) },
            auditLog: { findFirst: vi.fn().mockResolvedValue(null) },
            user: { findFirst: vi.fn().mockResolvedValue(null) },
        };
        await expect(service().reissueInTransaction(foreignTx as never, {
            tenantId: 'tenant-1',
            userId: 'foreign-user',
            actorUserId: 'admin-1',
            idempotencyKey: 'reissue-attempt-2',
        })).rejects.toThrow('User not found');
    });

    it('uses the worker-configured attempt bound for status and manual retry', async () => {
        const failedAtBound = row({ attempts: 2 });
        const tx = {
            user: { findFirst: vi.fn().mockResolvedValue({ id: 'user-1' }) },
            staffInvitationOutbox: {
                findUnique: vi.fn().mockResolvedValue(failedAtBound),
                updateMany: vi.fn(),
            },
        };

        expect(service(key.toString('base64'), 'true', '2').toResponse(failedAtBound))
            .toMatchObject({ status: 'failed', attempts: 2, canRetry: false });
        await expect(service(key.toString('base64'), 'true', '2').retryInTransaction(
            tx as never,
            { tenantId: 'tenant-1', userId: 'user-1', actorUserId: 'admin-1' },
        )).rejects.toThrow('retry limit reached');
        expect(tx.staffInvitationOutbox.updateMany).not.toHaveBeenCalled();
    });

    it('fails closed unless enabled with a dedicated exact 32-byte key', () => {
        expect(() => service(key.toString('base64'), 'false').validateConfiguration()).toThrow('unavailable');
        expect(() => service(key.toString('base64'), 'TRUE').validateConfiguration()).toThrow('unavailable');
        expect(() => service('').validateConfiguration()).toThrow('unavailable');
        expect(() => service(Buffer.alloc(31).toString('base64')).validateConfiguration())
            .toThrow('unavailable');
        expect(() => service(key.toString('base64'), 'true', '0').validateConfiguration())
            .toThrow('unavailable');
        expect(() => service(key.toString('base64'), 'true', '9').validateConfiguration())
            .toThrow('unavailable');
    });
});
