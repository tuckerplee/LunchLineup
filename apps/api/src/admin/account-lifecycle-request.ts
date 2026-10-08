import type { TenantPrismaTransaction } from '../database/tenant-prisma.service';

export const ACCOUNT_LIFECYCLE_REQUEST_PREFIX = 'internal:account-lifecycle-request:';
export type AccountLifecycleRequestKind = 'CANCELLATION' | 'DELETION';
export type AccountLifecycleRequestState = 'PENDING' | 'COMPLETED' | 'BLOCKED' | 'SUPERSEDED';

// A customer-visible receipt, separate from provider leases and audit payloads.
// Call only inside the transaction that persists the corresponding lifecycle state.
export async function recordAccountLifecycleRequest(
    tx: TenantPrismaTransaction,
    input: { tenantId: string; requestId: string; kind: AccountLifecycleRequestKind;
        state: AccountLifecycleRequestState; requestedAt?: Date },
): Promise<void> {
    const key = `${ACCOUNT_LIFECYCLE_REQUEST_PREFIX}${input.requestId}`;
    const where = { tenantId_key: { tenantId: input.tenantId, key } };
    const existing = await tx.tenantSetting.findUnique({ where, select: { value: true } });
    const prior = projectAccountLifecycleRequest(existing?.value);
    const value = {
        requestId: input.requestId, kind: input.kind, state: input.state,
        requestedAt: prior?.requestedAt ?? (input.requestedAt ?? new Date()).toISOString(),
        updatedAt: new Date().toISOString(),
    };
    await tx.tenantSetting.upsert({ where,
        create: { tenantId: input.tenantId, key, value }, update: { value } });
}

export function projectAccountLifecycleRequest(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (typeof row.requestId !== 'string' || !row.requestId || row.requestId.length > 255
        || !['CANCELLATION', 'DELETION'].includes(String(row.kind))
        || !['PENDING', 'COMPLETED', 'BLOCKED', 'SUPERSEDED'].includes(String(row.state))
        || typeof row.requestedAt !== 'string' || !Number.isFinite(Date.parse(row.requestedAt))
        || typeof row.updatedAt !== 'string' || !Number.isFinite(Date.parse(row.updatedAt))) return null;
    return { requestId: row.requestId, kind: row.kind as AccountLifecycleRequestKind,
        state: row.state as AccountLifecycleRequestState,
        requestedAt: row.requestedAt, updatedAt: row.updatedAt };
}
