import { ForbiddenException } from '@nestjs/common';
import { scryptSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AdminUserPinRecoveryService } from './admin-user-pin-recovery.service';

const actor = { userId: 'admin', tenantId: 'platform', sessionId: 'session', ipAddress: null, userAgent: null };
function setup() {
    const target = { id: 'target', publicId: 'public-target', tenantId: 'other-tenant', username: 'worker', deletedAt: null, suspendedAt: null };
    const tx = {
        user: { findUnique: vi.fn(async () => target), updateMany: vi.fn(async () => ({ count: 1 })) },
        session: { updateMany: vi.fn(async () => ({ count: 2 })) },
        auditLog: { create: vi.fn(async () => ({})) },
    };
    const withPlatformAdmin = vi.fn(async (fn: any) => fn(tx));
    const authorize = vi.fn(async () => target);
    const service = new AdminUserPinRecoveryService({ withPlatformAdmin } as never, { authorizePlatformAdminUserMutationInTransaction: authorize } as never);
    return { service, tx, withPlatformAdmin, authorize, target };
}
describe('platform PIN recovery', () => {
    it('checks current platform authority, hashes the returned PIN, revokes sessions and records attribution without credentials', async () => {
        const { service, tx, authorize, withPlatformAdmin } = setup();
        const result = await service.reset('target', actor);
        expect(authorize).toHaveBeenCalledWith(tx, 'target', actor);
        expect(result).toMatchObject({ id: 'public-target', username: 'worker', pinResetRequired: true });
        const data = (tx.user.updateMany.mock.calls as any)[0][0].data;
        const [salt, hash] = data.pinHash.split(':');
        expect(scryptSync(result.temporaryPin, salt, 64).toString('hex')).toBe(hash);
        expect(data).toMatchObject({ pinResetRequired: true, pinLoginAttempts: 0, pinLockedUntil: null });
        expect(tx.session.updateMany).toHaveBeenCalledWith({ where: { userId: 'target', revokedAt: null }, data: { revokedAt: expect.any(Date) } });
        expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ tenantId: 'other-tenant', userId: null, actorUserId: 'admin', actorTenantId: 'platform', action: 'USER_PIN_RESET' }) });
        expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toContain(result.temporaryPin);
        expect(withPlatformAdmin).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
    });
    it('rejects self-reset before database work', async () => {
        const { service, withPlatformAdmin } = setup();
        await expect(service.reset('admin', actor)).rejects.toThrow('own PIN');
        expect(withPlatformAdmin).not.toHaveBeenCalled();
    });
    it('fails closed when current authorization is revoked', async () => {
        const { service, tx, authorize } = setup();
        authorize.mockRejectedValue(new ForbiddenException());
        await expect(service.reset('target', actor)).rejects.toBeInstanceOf(ForbiddenException);
        expect(tx.user.findUnique).not.toHaveBeenCalled();
        expect(tx.user.updateMany).not.toHaveBeenCalled();
        expect(tx.session.updateMany).not.toHaveBeenCalled();
    });
    it.each(['deletedAt', 'suspendedAt', 'username'])('rejects ineligible %s targets without mutation', async field => {
        const { service, tx, target } = setup();
        Object.assign(target, { [field]: field === 'username' ? null : new Date() });
        await expect(service.reset('target', actor)).rejects.toThrow();
        expect(tx.user.updateMany).not.toHaveBeenCalled();
    });
    it('does not return credentials if the audit transaction fails', async () => {
        const { service, tx } = setup();
        tx.auditLog.create.mockRejectedValue(new Error('audit unavailable'));
        await expect(service.reset('target', actor)).rejects.toThrow('audit unavailable');
    });
});
