import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RbacService } from '../auth/rbac.service';
import { runSerializableMutationWithRetry } from '../auth/serializable-mutation';
import { TenantPrismaService } from '../database/tenant-prisma.service';

export type AdminMfaRecoveryRequest = {
    targetUserId: string;
    confirmation: string;
    reason: string;
    actorUserId: string;
    actorTenantId: string;
    actorSessionId: string;
    ipAddress: string | null;
    userAgent: string | null;
};

@Injectable()
export class AdminUserMfaRecoveryService {
    constructor(
        private readonly tenantDb: TenantPrismaService,
        private readonly rbac: RbacService,
    ) {}

    async reset(request: AdminMfaRecoveryRequest) {
        const reason = request.reason?.trim();
        if (request.actorUserId === request.targetUserId) {
            throw new BadRequestException('Platform administrators cannot reset their own MFA.');
        }
        if (request.confirmation !== `reset-mfa:${request.targetUserId}`) {
            throw new BadRequestException(`confirmation must exactly equal reset-mfa:${request.targetUserId}`);
        }
        if (!reason || reason.length < 10 || reason.length > 500) {
            throw new BadRequestException('reason must contain 10 to 500 characters.');
        }

        return runSerializableMutationWithRetry(
            () => this.tenantDb.withPlatformAdmin(async (tx) => {
                const authorizedTarget = await this.rbac.authorizePlatformAdminUserMutationInTransaction(
                    tx,
                    request.targetUserId,
                    {
                        userId: request.actorUserId,
                        tenantId: request.actorTenantId,
                        sessionId: request.actorSessionId,
                    },
                );
                const target = await tx.user.findUnique({
                    where: { id: authorizedTarget.id },
                    select: {
                        id: true,
                        tenantId: true,
                        mfaEnabled: true,
                        suspendedAt: true,
                        deletedAt: true,
                    },
                });
                if (!target
                    || target.tenantId !== authorizedTarget.tenantId
                    || target.deletedAt
                    || target.suspendedAt) {
                    throw new BadRequestException('Active user not found.');
                }
                if (!target.mfaEnabled) throw new ConflictException('User does not have MFA enabled.');

                const updated = await tx.user.updateMany({
                    where: { id: target.id, tenantId: target.tenantId, deletedAt: null, suspendedAt: null, mfaEnabled: true },
                    data: { mfaEnabled: false, mfaSecret: null, mfaBackupCodes: [] },
                });
                if (updated.count !== 1) throw new ConflictException('MFA enrollment changed before it could be reset.');

                await tx.mfaTotpClaim.deleteMany({ where: { tenantId: target.tenantId, userId: target.id } });
                const sessions = await tx.session.updateMany({
                    where: { userId: target.id, revokedAt: null },
                    data: { revokedAt: new Date() },
                });
                await tx.auditLog.create({
                    data: {
                        tenantId: target.tenantId,
                        userId: request.actorTenantId === target.tenantId ? request.actorUserId : null,
                        actorUserId: request.actorUserId,
                        actorTenantId: request.actorTenantId,
                        ipAddress: request.ipAddress,
                        userAgent: request.userAgent,
                        action: 'USER_MFA_RECOVERY_RESET',
                        resource: 'User',
                        resourceId: target.id,
                        oldValue: { mfaEnabled: true },
                        newValue: { mfaEnabled: false, reason },
                    },
                });

                return { id: target.id, mfaEnabled: false, sessionsRevoked: sessions.count };
            }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
            { conflictMessage: 'Authorization or MFA state changed concurrently; retry the request.' },
        );
    }
}
