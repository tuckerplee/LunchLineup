import { BadRequestException, ConflictException } from '@nestjs/common';
import { randomBytes, randomInt, scryptSync } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { RbacService } from '../auth/rbac.service';
import { runSerializableMutationWithRetry } from '../auth/serializable-mutation';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import type { AdminUserLifecycleActor } from './admin-user-lifecycle.service';

export class AdminUserPinRecoveryService {
    constructor(private readonly tenantDb: TenantPrismaService, private readonly rbac: RbacService) {}

    async reset(targetUserId: string, actor: AdminUserLifecycleActor) {
        if (targetUserId === actor.userId) throw new BadRequestException('Use your account settings to change your own PIN.');
        const temporaryPin = randomInt(100_000, 1_000_000).toString();
        const salt = randomBytes(16).toString('hex');
        const pinHash = `${salt}:${scryptSync(temporaryPin, salt, 64).toString('hex')}`;
        return runSerializableMutationWithRetry(
            () => this.tenantDb.withPlatformAdmin(async tx => {
                const authorizedTarget = await this.rbac.authorizePlatformAdminUserMutationInTransaction(tx, targetUserId, actor);
                const target = await tx.user.findUnique({
                    where: { id: authorizedTarget.id },
                    select: { id: true, publicId: true, tenantId: true, username: true, deletedAt: true, suspendedAt: true },
                });
                if (!target || target.tenantId !== authorizedTarget.tenantId || target.deletedAt || target.suspendedAt) {
                    throw new BadRequestException('Active user not found.');
                }
                if (!target.username) throw new BadRequestException('PIN reset is only available for username accounts.');
                const now = new Date();
                const updated = await tx.user.updateMany({
                    where: { id: target.id, tenantId: target.tenantId, deletedAt: null, suspendedAt: null },
                    data: { pinHash, pinSetAt: now, pinResetRequired: true, pinLoginAttempts: 0, pinLockedUntil: null },
                });
                if (updated.count !== 1) throw new ConflictException('User changed before the PIN could be reset.');
                const sessions = await tx.session.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: now } });
                await tx.auditLog.create({ data: {
                    tenantId: target.tenantId,
                    userId: actor.tenantId === target.tenantId ? actor.userId : null,
                    actorUserId: actor.userId, actorTenantId: actor.tenantId,
                    ipAddress: actor.ipAddress, userAgent: actor.userAgent,
                    action: 'USER_PIN_RESET', resource: 'User', resourceId: target.id,
                    newValue: { pinResetRequired: true, sessionsRevoked: sessions.count },
                } });
                return { id: target.publicId, username: target.username, temporaryPin, pinResetRequired: true };
            }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
            { conflictMessage: 'Authorization or user state changed concurrently; retry the request.' },
        );
    }
}
