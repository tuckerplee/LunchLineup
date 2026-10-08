import type { MfaSessionObserver } from '@lunchlineup/rbac';
import { RbacService } from '../auth/rbac.service';
import type { TenantPrismaService, TenantPrismaTransaction } from '../database/tenant-prisma.service';
import type { TenantLifecycleActor } from './tenant-account-lifecycle.service';

// Request admission only. Committed intents are reconciled without replaying the
// originating session; provider work must remain outside this transaction.
export function withCustomerLifecycleAdmission<T>(
    database: TenantPrismaService,
    rbac: RbacService | undefined,
    observer: MfaSessionObserver | undefined,
    actor: TenantLifecycleActor,
    operation: (tx: TenantPrismaTransaction, assertCurrent: () => void) => Promise<T>,
    lockDomain?: (tx: TenantPrismaTransaction) => Promise<void>,
): Promise<T> {
    const owner = rbac ?? new RbacService(database);
    return owner.runCurrentMutation({
        actor: { tenantId: actor.tenantId, userId: actor.userId ?? '', sessionId: actor.sessionId ?? '' },
        requiredPermission: 'tenant_account:lifecycle', mfaObserver: observer,
        transactionOptions: { maxWait: 5_000, timeout: 60_000 },
    }, async (tx, current) => {
        await tx.$executeRaw`SELECT public.lock_tenant_lifecycle(${current.tenantId})`;
        if (lockDomain) await lockDomain(tx);
        await owner.authorizeActorMutationInTransaction(tx, current, 'tenant_account:lifecycle');
    }, (tx, _authority, assertCurrent) => operation(tx, assertCurrent));
}
