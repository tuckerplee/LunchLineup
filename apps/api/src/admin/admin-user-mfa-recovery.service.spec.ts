import { BadRequestException, ConflictException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { AdminUserMfaRecoveryService } from './admin-user-mfa-recovery.service';

describe('AdminUserMfaRecoveryService', () => {
    let prisma: any;
    let service: AdminUserMfaRecoveryService;
    const request = {
        targetUserId: 'user-1',
        confirmation: 'reset-mfa:user-1',
        reason: 'Lost authenticator and all recovery codes',
        actorUserId: 'platform-admin-1',
        actorTenantId: 'platform-tenant',
        ipAddress: '203.0.113.10',
        userAgent: 'vitest',
    };

    beforeEach(() => {
        prisma = {
            $queryRaw: vi.fn().mockResolvedValue([{ id: 'user-1', tenantId: 'tenant-1', mfaEnabled: true, deletedAt: null }]),
            $executeRaw: vi.fn().mockResolvedValue(1),
            $transaction: vi.fn(async (operation: any) => operation(prisma)),
            user: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
            mfaTotpClaim: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
            session: { updateMany: vi.fn().mockResolvedValue({ count: 3 }) },
            auditLog: { create: vi.fn().mockResolvedValue({}) },
        };
        service = new AdminUserMfaRecoveryService(new TenantPrismaService(prisma));
    });

    it('clears factors, claims, and sessions in one attributed transaction', async () => {
        await expect(service.reset(request)).resolves.toEqual({ id: 'user-1', mfaEnabled: false, sessionsRevoked: 3 });
        expect(prisma.$queryRaw.mock.calls.some((call: any[]) => String(call[0]).includes('FOR UPDATE'))).toBe(true);
        expect(prisma.user.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: { mfaEnabled: false, mfaSecret: null, mfaBackupCodes: [] },
        }));
        expect(prisma.mfaTotpClaim.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 'tenant-1', userId: 'user-1' } });
        expect(prisma.session.updateMany).toHaveBeenCalledWith({ where: { userId: 'user-1', revokedAt: null }, data: { revokedAt: expect.any(Date) } });
        expect(prisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
            action: 'USER_MFA_RECOVERY_RESET', actorUserId: 'platform-admin-1', actorTenantId: 'platform-tenant',
            userId: null, oldValue: { mfaEnabled: true }, newValue: { mfaEnabled: false, reason: request.reason },
        }) });
    });

    it('rejects self-reset and malformed confirmation before database work', async () => {
        await expect(service.reset({ ...request, targetUserId: request.actorUserId, confirmation: `reset-mfa:${request.actorUserId}` })).rejects.toBeInstanceOf(BadRequestException);
        await expect(service.reset({ ...request, confirmation: 'wrong' })).rejects.toBeInstanceOf(BadRequestException);
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects inactive or unenrolled targets without mutation', async () => {
        prisma.$queryRaw.mockImplementation(async (query: any) => String(query).includes('FROM "User"')
            ? [{ id: 'user-1', tenantId: 'tenant-1', mfaEnabled: false, deletedAt: null }]
            : [{ set_current_platform_admin: null }]);
        await expect(service.reset(request)).rejects.toBeInstanceOf(ConflictException);
        expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('fails closed when enrollment changes after the row lock', async () => {
        prisma.user.updateMany.mockResolvedValue({ count: 0 });
        await expect(service.reset(request)).rejects.toBeInstanceOf(ConflictException);
        expect(prisma.mfaTotpClaim.deleteMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });
});
