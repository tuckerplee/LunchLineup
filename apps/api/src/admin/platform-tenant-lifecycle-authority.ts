import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { MfaSessionObserver } from '@lunchlineup/rbac';
import type { RbacService } from '../auth/rbac.service';
import type { TenantPrismaTransaction } from '../database/tenant-prisma.service';
import type { AdminUserLifecycleActor } from './admin-user-lifecycle.service';

export function capturePlatformTenantActor(actor: AdminUserLifecycleActor): Readonly<AdminUserLifecycleActor> {
    if (!actor || [actor.userId, actor.tenantId, actor.sessionId].some(
        (value) => typeof value !== 'string' || !value.trim(),
    )) {
        throw new ForbiddenException('A live platform administrator session is required');
    }
    return Object.freeze({ ...actor });
}

export function platformTenantLifecycleAuditActor(actor: AdminUserLifecycleActor, targetTenantId: string) {
    return {
        userId: actor.tenantId === targetTenantId ? actor.userId : null,
        actorUserId: actor.userId,
        actorTenantId: actor.tenantId,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
    };
}

export function capturePlatformTenantObserver(observer: MfaSessionObserver | undefined): MfaSessionObserver | undefined {
    const observe = observer?.observeSessionMfa;
    return typeof observe === 'function' ? Object.freeze({ observeSessionMfa: observe.bind(observer) }) : undefined;
}

// This is request admission, never autonomous intent reconciliation. Acquire the
// lifecycle advisory lock before the authorizer's sorted actor/target row locks.
// Provider I/O must happen outside this bounded transaction/retry closure.
export function withPlatformTenantLifecycleAdmission<T>(
    rbac: RbacService,
    targetTenantId: string,
    actorInput: AdminUserLifecycleActor,
    mfaObserver: MfaSessionObserver | undefined,
    operation: (tx: TenantPrismaTransaction, actor: Readonly<AdminUserLifecycleActor>, assertCurrent: () => void) => Promise<T>,
): Promise<T> {
    const actor = capturePlatformTenantActor(actorInput);
    if (typeof targetTenantId !== 'string' || !targetTenantId.trim()) throw new BadRequestException('Tenant not found');
    return rbac.runCurrentMutation({
        actor, requiredPermission: 'admin_portal:access', scope: 'platform',
        mfaObserver: capturePlatformTenantObserver(mfaObserver),
        conflictMessage: 'Authorization or access state changed concurrently; retry the request',
    }, async (tx, frozenActor) => {
        await tx.$executeRaw`SELECT public.lock_tenant_lifecycle(${targetTenantId})`;
        await rbac.authorizePlatformAdminTenantMutationInTransaction(tx, targetTenantId, frozenActor);
    }, (tx, _authority, assertCurrent, frozenActor) => operation(tx,
        Object.freeze({ ...actor, ...frozenActor }), assertCurrent));
}
