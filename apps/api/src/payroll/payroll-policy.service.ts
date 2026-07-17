import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';

import { TenantPrismaService, type TenantPrismaTransaction } from '../database/tenant-prisma.service';
import { normalizePayrollIdempotencyKey, payrollRequestIdentity } from './payroll-idempotency';
import {
    assertFutureEffectiveBoundary,
    assertPayrollAnchorAlignment,
    dateOnlyForPrisma,
    normalizePayrollPolicy,
    serializeDateOnly,
} from './payroll-policy';
import { serializePayrollPolicy } from './payroll-records';
import {
    applyPayrollTransactionTimeouts,
    isPrismaUniqueConflict,
    lockPayrollTenant,
    PAYROLL_REPLAY_CONFLICT,
    PAYROLL_TRANSACTION_OPTIONS,
    retryPayrollSerializableMutation,
    type PayrollActor,
    writePayrollAudit,
} from './payroll-transaction';
import {
    MAX_PAYROLL_HISTORY_PAGE_SIZE,
    parseBoundedLimit,
    parseOpaqueCursor,
} from './payroll-validation';

@Injectable()
export class PayrollPolicyService {
    constructor(private readonly tenantDb: TenantPrismaService) {}

    async list(actor: PayrollActor, limitRaw?: unknown, cursorRaw?: unknown) {
        const limit = parseBoundedLimit(limitRaw, {
            field: 'limit', defaultValue: 25, maximum: MAX_PAYROLL_HISTORY_PAGE_SIZE,
        });
        const cursor = parseOpaqueCursor(cursorRaw, 'cursor');
        const rows = await this.tenantDb.withTenant(actor.tenantId, (tx) => tx.payrollPolicyVersion.findMany({
            where: { tenantId: actor.tenantId },
            orderBy: [{ version: 'desc' }, { id: 'desc' }],
            take: limit + 1,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }));
        const page = rows.slice(0, limit);
        return {
            data: page.map(serializePayrollPolicy),
            nextCursor: rows.length > limit && page.length > 0 ? page[page.length - 1].id : null,
        };
    }

    async latest(actor: PayrollActor) {
        const row = await this.tenantDb.withTenant(actor.tenantId, (tx) => tx.payrollPolicyVersion.findFirst({
            where: { tenantId: actor.tenantId },
            orderBy: [{ version: 'desc' }, { id: 'desc' }],
        }));
        return { data: row ? serializePayrollPolicy(row) : null };
    }

    async create(actor: PayrollActor, body: unknown, idempotencyKeyRaw: unknown) {
        const policy = normalizePayrollPolicy(body);
        assertPayrollAnchorAlignment(policy.effectiveFrom, policy.anchorDate, policy.cadence);
        const identity = payrollRequestIdentity({
            ...actor,
            actorUserId: actor.userId,
            operation: 'POLICY_CREATE',
            idempotencyKey: normalizePayrollIdempotencyKey(idempotencyKeyRaw),
            body: policy,
        });
        const replay = await this.findReplay(actor, identity.operationId, identity.requestHash);
        if (replay) return replay;

        try {
            return await retryPayrollSerializableMutation(() => this.tenantDb.withTenant(actor.tenantId, async (tx) => {
                await applyPayrollTransactionTimeouts(tx);
                await lockPayrollTenant(tx, actor.tenantId);
                const insideReplay = await this.findReplayInTransaction(
                    tx, actor, identity.operationId, identity.requestHash,
                );
                if (insideReplay) return insideReplay;

                const latest = await tx.payrollPolicyVersion.findFirst({
                    where: { tenantId: actor.tenantId },
                    orderBy: [{ version: 'desc' }, { id: 'desc' }],
                });
                if (latest && serializeDateOnly(latest.effectiveFrom) >= policy.effectiveFrom) {
                    throw new ConflictException('effectiveFrom must be after the latest payroll policy boundary.');
                }
                if (latest) assertFutureEffectiveBoundary(policy);
                if (latest && latest.timeZone !== policy.timeZone) {
                    throw new BadRequestException('Payroll policy timezone cannot change after version 1.');
                }
                if (latest) {
                    assertPayrollAnchorAlignment(
                        policy.effectiveFrom,
                        serializeDateOnly(latest.anchorDate),
                        latest.cadence,
                    );
                }
                const created = await tx.payrollPolicyVersion.create({
                    data: {
                        tenantId: actor.tenantId,
                        version: (latest?.version ?? 0) + 1,
                        timeZone: policy.timeZone,
                        cadence: policy.cadence,
                        anchorDate: dateOnlyForPrisma(policy.anchorDate),
                        effectiveFrom: dateOnlyForPrisma(policy.effectiveFrom),
                        operationId: identity.operationId,
                        requestHash: identity.requestHash,
                        createdByUserId: actor.userId,
                    },
                });
                const response = serializePayrollPolicy(created);
                await writePayrollAudit(tx, actor, {
                    action: 'PAYROLL_POLICY_VERSION_CREATED',
                    resource: 'PayrollPolicyVersion',
                    resourceId: created.id,
                    newValue: response,
                });
                return response;
            }, PAYROLL_TRANSACTION_OPTIONS));
        } catch (error) {
            if (isPrismaUniqueConflict(error)) {
                const racedReplay = await this.findReplay(actor, identity.operationId, identity.requestHash);
                if (racedReplay) return racedReplay;
                throw new ConflictException('Payroll policy version conflicts with an existing boundary.');
            }
            throw error;
        }
    }

    private async findReplay(actor: PayrollActor, operationId: string, requestHash: string) {
        return this.tenantDb.withTenant(actor.tenantId, (tx) =>
            this.findReplayInTransaction(tx, actor, operationId, requestHash));
    }

    private async findReplayInTransaction(
        tx: TenantPrismaTransaction,
        actor: PayrollActor,
        operationId: string,
        requestHash: string,
    ) {
        const row = await tx.payrollPolicyVersion.findUnique({ where: { operationId } });
        if (!row) return null;
        if (row.tenantId !== actor.tenantId || row.requestHash !== requestHash) {
            throw new ConflictException(PAYROLL_REPLAY_CONFLICT);
        }
        return serializePayrollPolicy(row);
    }
}
