import { ForbiddenException } from '@nestjs/common';
import { scryptSync } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { AdminUserPinRecoveryService } from './admin-user-pin-recovery.service';
import { adminAuthorityFixture } from './admin-user-authority.fixture';

const actor = { userId: 'admin-1', tenantId: 'platform-tenant', sessionId: 'admin-session-1', ipAddress: null, userAgent: null };
function setup() {
    const h = adminAuthorityFixture();
    const target = h.state.users[1]; target.publicId = 'public-target'; target.username = 'worker';
    const tx = h.prisma;
    const withPlatformAdmin = vi.spyOn(h.tenantDb, 'withPlatformAdmin');
    const authorize = vi.spyOn(h.rbac, 'authorizePlatformAdminUserMutationInTransaction');
    const service = new AdminUserPinRecoveryService(h.tenantDb, h.rbac, h.observer);
    return { service, tx, withPlatformAdmin, authorize, target };
}
beforeEach(() => vi.stubEnv('PLATFORM_ADMIN_DB_CONTEXT_SECRET', 'synthetic-admin-test-capability'));
afterEach(() => vi.unstubAllEnvs());
describe('platform PIN recovery', () => {
    it('checks current platform authority, hashes the returned PIN, revokes sessions and records attribution without credentials', async () => {
        const { service, tx, authorize, withPlatformAdmin } = setup();
        const result = await service.reset('user-1', actor);
        expect(authorize).toHaveBeenCalledWith(tx, 'user-1', { userId: actor.userId, tenantId: actor.tenantId, sessionId: actor.sessionId });
        expect(result).toMatchObject({ id: 'public-target', username: 'worker', pinResetRequired: true });
        const data = (tx.user.updateMany.mock.calls as any)[0][0].data;
        const [salt, hash] = data.pinHash.split(':');
        expect(scryptSync(result.temporaryPin, salt, 64).toString('hex')).toBe(hash);
        expect(data).toMatchObject({ pinResetRequired: true, pinLoginAttempts: 0, pinLockedUntil: null });
        expect(tx.session.updateMany).toHaveBeenCalledWith({ where: { userId: 'user-1', revokedAt: null }, data: { revokedAt: expect.any(Date) } });
        expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ tenantId: 'tenant-1', userId: null, actorUserId: 'admin-1', actorTenantId: 'platform-tenant', action: 'USER_PIN_RESET' }) });
        expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toContain(result.temporaryPin);
        expect(withPlatformAdmin).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
    });
    it('rejects self-reset before database work', async () => {
        const { service, withPlatformAdmin } = setup();
        await expect(service.reset('admin-1', actor)).rejects.toThrow('own PIN');
        expect(withPlatformAdmin).not.toHaveBeenCalled();
    });
    it('fails closed when current authorization is revoked', async () => {
        const { service, tx, authorize } = setup();
        authorize.mockRejectedValue(new ForbiddenException());
        await expect(service.reset('user-1', actor)).rejects.toBeInstanceOf(ForbiddenException);
        expect(tx.user.findUnique).not.toHaveBeenCalled();
        expect(tx.user.updateMany).not.toHaveBeenCalled();
        expect(tx.session.updateMany).not.toHaveBeenCalled();
    });
    it.each(['deletedAt', 'suspendedAt', 'username'])('rejects ineligible %s targets without mutation', async field => {
        const { service, tx, target } = setup();
        Object.assign(target, { [field]: field === 'username' ? null : new Date() });
        await expect(service.reset('user-1', actor)).rejects.toThrow();
        expect(tx.user.updateMany).not.toHaveBeenCalled();
    });
    it('does not return credentials if the audit transaction fails', async () => {
        const { service, tx } = setup();
        tx.auditLog.create.mockRejectedValue(new Error('audit unavailable'));
        await expect(service.reset('user-1', actor)).rejects.toThrow('audit unavailable');
    });
});
