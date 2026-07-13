import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../database/tenant-prisma.service';

export type AdminMfaRecoveryRequest = {
    targetUserId: string;
    confirmation: string;
    reason: string;
    actorUserId: string;
    actorTenantId: string;
    ipAddress: string | null;
    userAgent: string | null;
};

@Injectable()
export class AdminUserMfaRecoveryService {
    constructor(private readonly tenantDb: TenantPrismaService) {}

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

        return this.tenantDb.withPlatformAdmin(async (tx) => {
            const rows = await tx.$queryRaw<Array<{ id: string; tenantId: string; mfaEnabled: boolean; deletedAt: Date | null }>>`
                SELECT "id", "tenantId", "mfaEnabled", "deletedAt"
                FROM "User"
                WHERE "id" = ${request.targetUserId}
                FOR UPDATE
            `;
            const target = rows[0];
            if (!target || target.deletedAt) throw new BadRequestException('Active user not found.');
            if (!target.mfaEnabled) throw new ConflictException('User does not have MFA enabled.');

            const updated = await tx.user.updateMany({
                where: { id: target.id, tenantId: target.tenantId, deletedAt: null, mfaEnabled: true },
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
        });
    }
}
