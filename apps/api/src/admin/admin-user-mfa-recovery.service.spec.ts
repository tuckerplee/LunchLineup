import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { AdminUserMfaRecoveryService } from './admin-user-mfa-recovery.service';

describe('AdminUserMfaRecoveryService', () => {
    let prisma: any;
    let service: AdminUserMfaRecoveryService;
    let authorizePlatformAdminUserMutationInTransaction: ReturnType<typeof vi.fn>;
    const request = {
        targetUserId: 'user-1',
        confirmation: 'reset-mfa:user-1',
        reason: 'Lost authenticator and all recovery codes',
        actorUserId: 'platform-admin-1',
        actorTenantId: 'platform-tenant',
        actorSessionId: 'platform-session-1',
        ipAddress: '203.0.113.10',
        userAgent: 'vitest',
    };

    beforeEach(() => {
        vi.stubEnv('PLATFORM_ADMIN_DB_CONTEXT_SECRET', 'test-capability');
        prisma = {
            $executeRaw: vi.fn().mockResolvedValue(1),
            $transaction: vi.fn(async (operation: any) => operation(prisma)),
            user: {
                findUnique: vi.fn().mockResolvedValue({ id: 'user-1', tenantId: 'tenant-1', mfaEnabled: true, suspendedAt: null, deletedAt: null }),
                updateMany: vi.fn().mockResolvedValue({ count: 1 }),
            },
            mfaTotpClaim: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
            session: { updateMany: vi.fn().mockResolvedValue({ count: 3 }) },
            auditLog: { create: vi.fn().mockResolvedValue({}) },
        };
        authorizePlatformAdminUserMutationInTransaction = vi.fn().mockResolvedValue({
            id: 'user-1',
            tenantId: 'tenant-1',
            role: 'STAFF',
            suspendedAt: null,
            deletedAt: null,
        });
        service = new AdminUserMfaRecoveryService(
            new TenantPrismaService(prisma),
            { authorizePlatformAdminUserMutationInTransaction } as any,
        );
    });

    it('clears factors, claims, and sessions in one attributed transaction', async () => {
        await expect(service.reset(request)).resolves.toEqual({ id: 'user-1', mfaEnabled: false, sessionsRevoked: 3 });
        expect(authorizePlatformAdminUserMutationInTransaction).toHaveBeenCalledWith(
            prisma,
            'user-1',
            {
                userId: 'platform-admin-1',
                tenantId: 'platform-tenant',
                sessionId: 'platform-session-1',
            },
        );
        expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
            isolationLevel: 'Serializable',
        });
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
        prisma.user.findUnique.mockResolvedValue({
            id: 'user-1', tenantId: 'tenant-1', mfaEnabled: false, suspendedAt: null, deletedAt: null,
        });
        await expect(service.reset(request)).rejects.toBeInstanceOf(ConflictException);
        expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('fails closed before reading or mutating the target when the exact actor session is stale', async () => {
        authorizePlatformAdminUserMutationInTransaction.mockRejectedValue(
            new ForbiddenException('Platform administrator session is no longer active'),
        );

        await expect(service.reset(request)).rejects.toBeInstanceOf(ForbiddenException);

        expect(prisma.user.findUnique).not.toHaveBeenCalled();
        expect(prisma.user.updateMany).not.toHaveBeenCalled();
        expect(prisma.mfaTotpClaim.deleteMany).not.toHaveBeenCalled();
        expect(prisma.session.updateMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('denies delegated MFA recovery for a dual-source system admin target with zero effects', async () => {
        authorizePlatformAdminUserMutationInTransaction.mockRejectedValue(
            new ForbiddenException('Only system admins can administer system admins'),
        );

        await expect(service.reset(request))
            .rejects.toThrow('Only system admins can administer system admins');

        expect(prisma.user.findUnique).not.toHaveBeenCalled();
        expect(prisma.user.updateMany).not.toHaveBeenCalled();
        expect(prisma.mfaTotpClaim.deleteMany).not.toHaveBeenCalled();
        expect(prisma.session.updateMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('fails closed when enrollment changes after the row lock', async () => {
        prisma.user.updateMany.mockResolvedValue({ count: 0 });
        await expect(service.reset(request)).rejects.toBeInstanceOf(ConflictException);
        expect(prisma.mfaTotpClaim.deleteMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('retries one transaction conflict and maps two conflicts without duplicate audit', async () => {
        prisma.$transaction.mockRejectedValueOnce({ code: 'P2034' });

        await expect(service.reset(request)).resolves.toBeDefined();
        expect(prisma.$transaction).toHaveBeenCalledTimes(2);
        expect(prisma.auditLog.create).toHaveBeenCalledOnce();

        vi.clearAllMocks();
        prisma.$transaction
            .mockRejectedValueOnce({ code: 'P2034' })
            .mockRejectedValueOnce({ code: 'P2034' });
        await expect(service.reset(request)).rejects.toBeInstanceOf(ConflictException);
        expect(prisma.$transaction).toHaveBeenCalledTimes(2);
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });
});
