import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RbacService, type PlatformAdminMutationTarget } from '../auth/rbac.service';
import { runSerializableMutationWithRetry } from '../auth/serializable-mutation';
import { assertTenantCanAddActiveUser } from '../billing/user-capacity';
import { unassignEditableShiftsForIneligibleUser } from '../common/schedulable-user';
import { TenantPrismaService } from '../database/tenant-prisma.service';

export type AdminUserLifecycleActor = {
    userId: string;
    tenantId: string;
    sessionId: string;
    ipAddress: string | null;
    userAgent: string | null;
};

@Injectable()
export class AdminUserLifecycleService {
    constructor(
        private readonly tenantDb: TenantPrismaService,
        private readonly rbac: RbacService,
    ) {}

    async suspend(targetUserId: string, actor: AdminUserLifecycleActor) {
        if (targetUserId === actor.userId) {
            throw new BadRequestException('Platform administrators cannot suspend their own account.');
        }

        return this.runSerializableMutation(async (tx) => {
            const target = await this.lockAndAuthorizeUsers(tx, targetUserId, actor);
            this.assertNotDeleted(target);
            const now = new Date();
            const shiftsUnassigned = await unassignEditableShiftsForIneligibleUser(
                tx,
                target.tenantId,
                target.id,
            );
            const sessions = await tx.session.updateMany({
                where: { userId: target.id, revokedAt: null },
                data: { revokedAt: now },
            });

            if (target.suspendedAt) {
                if (shiftsUnassigned > 0) {
                    await tx.auditLog.create({
                        data: {
                            ...this.auditActor(actor, target.tenantId),
                            action: 'USER_SUSPENSION_SCHEDULE_REPAIRED',
                            resource: 'User',
                            resourceId: target.id,
                            oldValue: { suspendedAt: target.suspendedAt.toISOString() },
                            newValue: {
                                suspendedAt: target.suspendedAt.toISOString(),
                                shiftsUnassigned,
                            },
                        },
                    });
                }
                return {
                    id: target.id,
                    tenantId: target.tenantId,
                    status: 'SUSPENDED' as const,
                    suspendedAt: target.suspendedAt,
                    changed: false,
                    sessionsRevoked: sessions.count,
                };
            }

            const updated = await tx.user.updateMany({
                where: {
                    id: target.id,
                    tenantId: target.tenantId,
                    deletedAt: null,
                    suspendedAt: null,
                },
                data: { suspendedAt: now },
            });
            if (updated.count !== 1) {
                throw new ConflictException('User lifecycle changed before suspension completed.');
            }

            await tx.auditLog.create({
                data: {
                    ...this.auditActor(actor, target.tenantId),
                    action: 'USER_SUSPENDED',
                    resource: 'User',
                    resourceId: target.id,
                    oldValue: { suspendedAt: null },
                    newValue: { suspendedAt: now.toISOString(), shiftsUnassigned },
                },
            });

            return {
                id: target.id,
                tenantId: target.tenantId,
                status: 'SUSPENDED' as const,
                suspendedAt: now,
                changed: true,
                sessionsRevoked: sessions.count,
            };
        });
    }

    async activate(targetUserId: string, actor: AdminUserLifecycleActor) {
        if (targetUserId === actor.userId) {
            throw new BadRequestException('Platform administrators cannot activate their own account.');
        }

        return this.runSerializableMutation(async (tx) => {
            const target = await this.lockAndAuthorizeUsers(tx, targetUserId, actor);
            this.assertNotDeleted(target);

            if (!target.suspendedAt) {
                return {
                    id: target.id,
                    tenantId: target.tenantId,
                    status: 'ACTIVE' as const,
                    suspendedAt: null,
                    changed: false,
                };
            }

            await assertTenantCanAddActiveUser(tx as any, target.tenantId);
            const updated = await tx.user.updateMany({
                where: {
                    id: target.id,
                    tenantId: target.tenantId,
                    deletedAt: null,
                    suspendedAt: target.suspendedAt,
                },
                data: { suspendedAt: null },
            });
            if (updated.count !== 1) {
                throw new ConflictException('User lifecycle changed before activation completed.');
            }

            await tx.auditLog.create({
                data: {
                    ...this.auditActor(actor, target.tenantId),
                    action: 'USER_ACTIVATED',
                    resource: 'User',
                    resourceId: target.id,
                    oldValue: { suspendedAt: target.suspendedAt.toISOString() },
                    newValue: { suspendedAt: null },
                },
            });

            return {
                id: target.id,
                tenantId: target.tenantId,
                status: 'ACTIVE' as const,
                suspendedAt: null,
                changed: true,
            };
        });
    }

    private async runSerializableMutation<T>(
        operation: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> {
        return runSerializableMutationWithRetry(
            () => this.tenantDb.withPlatformAdmin(operation, {
                isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            }),
            { conflictMessage: 'Authorization or user lifecycle changed concurrently; retry the request.' },
        );
    }

    private async lockAndAuthorizeUsers(
        tx: Prisma.TransactionClient,
        targetUserId: string,
        actor: AdminUserLifecycleActor,
    ): Promise<PlatformAdminMutationTarget> {
        return this.rbac.authorizePlatformAdminUserMutationInTransaction(
            tx,
            targetUserId,
            {
                userId: actor.userId,
                tenantId: actor.tenantId,
                sessionId: actor.sessionId,
            },
            undefined,
            { lockTargetSchedulingMutations: true },
        );
    }

    private assertNotDeleted(target: PlatformAdminMutationTarget): void {
        if (target.deletedAt) {
            throw new ConflictException('Deleted users cannot be suspended or activated.');
        }
    }

    private auditActor(actor: AdminUserLifecycleActor, targetTenantId: string) {
        return {
            tenantId: targetTenantId,
            userId: actor.tenantId === targetTenantId ? actor.userId : null,
            actorUserId: actor.userId,
            actorTenantId: actor.tenantId,
            ipAddress: actor.ipAddress,
            userAgent: actor.userAgent,
        };
    }
}
