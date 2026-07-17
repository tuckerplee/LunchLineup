import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { TenantPrismaTransaction } from '../database/tenant-prisma.service';
import { PAYROLL_REPLAY_CONFLICT, type PayrollActor } from './payroll-transaction';

export type PayrollStoredOperationKind = 'PERIOD_CREATE' | 'ADOPT' | 'REVIEW' | 'APPROVAL';

type RequestIdentity = { operationId: string; requestHash: string };

export async function readPayrollOperationReplay(
    tx: TenantPrismaTransaction,
    actor: PayrollActor,
    identity: RequestIdentity,
    kind: PayrollStoredOperationKind,
    periodId: string,
) {
    const row = await tx.payrollOperation.findUnique({ where: { operationId: identity.operationId } });
    if (!row) return null;
    if (
        row.tenantId !== actor.tenantId
        || row.kind !== kind
        || row.periodId !== periodId
        || row.requestHash !== identity.requestHash
    ) {
        throw new ConflictException(PAYROLL_REPLAY_CONFLICT);
    }
    return storedResponse(row.response);
}

export async function readPayrollPeriodCreateReplay(
    tx: TenantPrismaTransaction,
    actor: PayrollActor,
    identity: RequestIdentity,
) {
    const row = await tx.payrollOperation.findUnique({ where: { operationId: identity.operationId } });
    if (!row) return null;
    if (
        row.tenantId !== actor.tenantId
        || row.kind !== 'PERIOD_CREATE'
        || !row.periodId
        || row.requestHash !== identity.requestHash
    ) {
        throw new ConflictException(PAYROLL_REPLAY_CONFLICT);
    }
    const response = storedResponse(row.response);
    if (response.id !== row.periodId) throw new ConflictException('Stored payroll period response is unavailable.');
    return response;
}

export async function writePayrollOperation(
    tx: TenantPrismaTransaction,
    actor: PayrollActor,
    identity: RequestIdentity,
    kind: PayrollStoredOperationKind,
    periodId: string,
    response: Record<string, unknown>,
): Promise<void> {
    await tx.payrollOperation.create({
        data: {
            operationId: identity.operationId,
            tenantId: actor.tenantId,
            periodId,
            kind,
            requestHash: identity.requestHash,
            response: response as Prisma.InputJsonValue,
        },
    });
}

function storedResponse(value: Prisma.JsonValue): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ConflictException('Stored payroll operation response is unavailable.');
    }
    return value as Record<string, unknown>;
}
