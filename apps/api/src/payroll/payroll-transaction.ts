import { Prisma } from '@prisma/client';
import type { MfaSessionObserver } from '@lunchlineup/rbac';

import { RbacService } from '../auth/rbac.service';
import type { TenantPrismaTransaction } from '../database/tenant-prisma.service';

export const PAYROLL_TRANSACTION_OPTIONS = {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000,
    timeout: 20_000,
} as const;

export const PAYROLL_SERIALIZABLE_ATTEMPTS = 2;

export const PAYROLL_REPLAY_CONFLICT = 'Idempotency-Key was already used for a different payroll request.';
export const PAYROLL_CONCURRENT_CHANGE = 'Payroll records changed before the request could be committed. Retry safely.';
export const PAYROLL_INTEGRITY_FAILURE = 'Payroll evidence failed integrity verification.';

export type PayrollActor = {
    tenantId: string;
    userId: string;
    sessionId?: string;
};

type PayrollCurrentOperation<T> = (
    tx: TenantPrismaTransaction,
    assertCurrent: () => void,
    actor: PayrollActor,
) => Promise<T>;

/** One current-authority scope for domain attempts and receipt-only recovery.
 * Session is deliberately excluded from existing payroll request digests.
 */
export function runCurrentPayrollMutation<T>(
    rbac: RbacService,
    observer: MfaSessionObserver,
    actor: PayrollActor,
    requiredPermission: string,
    operation: PayrollCurrentOperation<T>,
    recovery?: {
        isRecoverable: (error: unknown) => boolean;
        operation: (tx: TenantPrismaTransaction, assertCurrent: () => void,
            actor: PayrollActor, error: unknown) => Promise<T>;
    },
): Promise<T> {
    const recoveryOperation = recovery?.operation;
    return rbac.runCurrentMutation({
        actor: { userId: actor.userId, tenantId: actor.tenantId, sessionId: actor.sessionId ?? '' },
        requiredPermission,
        mfaObserver: observer,
        conflictMessage: PAYROLL_CONCURRENT_CHANGE,
        isConflict: isPayrollSerializationConflict,
        transactionOptions: PAYROLL_TRANSACTION_OPTIONS,
    }, (tx, selected) => rbac.authorizeActorMutationInTransaction(tx, selected, requiredPermission),
    async (tx, _authority, assertCurrent, selected) => {
        assertCurrent();
        await applyPayrollTransactionTimeouts(tx);
        assertCurrent();
        return operation(tx, assertCurrent, selected);
    }, recovery && recoveryOperation ? {
        isRecoverable: recovery.isRecoverable,
        operation: async (tx, _authority, assertCurrent, selected, error) => {
            assertCurrent();
            await applyPayrollTransactionTimeouts(tx);
            assertCurrent();
            return recoveryOperation(tx, assertCurrent, selected, error);
        },
    } : undefined);
}

export async function applyPayrollTransactionTimeouts(tx: TenantPrismaTransaction): Promise<void> {
    await tx.$queryRaw`
        SELECT
            set_config('lock_timeout', '2000ms', true),
            set_config('statement_timeout', '12000ms', true)
    `;
}

export async function lockPayrollTenant(tx: TenantPrismaTransaction, tenantId: string): Promise<void> {
    await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`lunchlineup:payroll:${tenantId}`}, 0))
    `;
}

export async function lockPayrollPeriod(
    tx: TenantPrismaTransaction,
    tenantId: string,
    periodId: string,
): Promise<void> {
    await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`lunchlineup:payroll:${tenantId}:${periodId}`}, 0))
    `;
}

export async function writePayrollAudit(
    tx: TenantPrismaTransaction,
    actor: PayrollActor,
    args: {
        action: string;
        resource: string;
        resourceId: string;
        oldValue?: Record<string, unknown> | null;
        newValue?: Record<string, unknown> | null;
    },
    assertCurrent: () => void = () => {},
): Promise<void> {
    assertCurrent();
    await tx.auditLog.create({
        data: {
            tenantId: actor.tenantId,
            userId: actor.userId,
            actorUserId: actor.userId,
            actorTenantId: actor.tenantId,
            action: args.action,
            resource: args.resource,
            resourceId: args.resourceId,
            ...(args.oldValue !== undefined
                ? { oldValue: args.oldValue as Prisma.InputJsonValue }
                : {}),
            ...(args.newValue !== undefined
                ? { newValue: args.newValue as Prisma.InputJsonValue }
                : {}),
        },
    });
    assertCurrent();
}

export function isPrismaUniqueConflict(error: unknown): boolean {
    return error !== null
        && typeof error === 'object'
        && 'code' in error
        && (error as { code?: unknown }).code === 'P2002';
}

export function isPayrollLockTimeout(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as { code?: unknown; meta?: unknown };
    if (candidate.code === '55P03') return true;
    if (candidate.code !== 'P2010' || !candidate.meta || typeof candidate.meta !== 'object') return false;
    return (candidate.meta as { code?: unknown }).code === '55P03';
}

export function isPayrollSerializationConflict(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as { code?: unknown; meta?: unknown };
    if (candidate.code === 'P2034' || candidate.code === '40001') return true;
    if (candidate.code !== 'P2010' || !candidate.meta || typeof candidate.meta !== 'object') return false;
    return (candidate.meta as { code?: unknown }).code === '40001';
}

export async function retryPayrollSerializableMutation<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < PAYROLL_SERIALIZABLE_ATTEMPTS; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            if (attempt + 1 < PAYROLL_SERIALIZABLE_ATTEMPTS && isPayrollSerializationConflict(error)) continue;
            throw error;
        }
    }
    throw new Error('Payroll serializable retry limit is invalid.');
}
