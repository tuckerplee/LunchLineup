import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { normalizeTimeZone } from '../common/location-timezone';
import { TenantPrismaService, type TenantPrismaTransaction } from '../database/tenant-prisma.service';
import {
    childPayrollOperationId,
    normalizePayrollIdempotencyKey,
    payrollRequestIdentity,
} from './payroll-idempotency';
import { readPayrollOperationReplay, writePayrollOperation } from './payroll-operation';
import {
    applyPayrollTransactionTimeouts,
    isPrismaUniqueConflict,
    lockPayrollPeriod,
    lockPayrollTenant,
    PAYROLL_CONCURRENT_CHANGE,
    PAYROLL_TRANSACTION_OPTIONS,
    retryPayrollSerializableMutation,
    type PayrollActor,
    writePayrollAudit,
} from './payroll-transaction';
import { parseAdoption, parseApprovalDecisions, requiredId } from './payroll-validation';

@Injectable()
export class PayrollCardService {
    constructor(private readonly tenantDb: TenantPrismaService) {}

    async adopt(actor: PayrollActor, periodIdRaw: unknown, body: unknown, idempotencyKeyRaw: unknown) {
        const periodId = requiredId(periodIdRaw, 'periodId');
        const cards = parseAdoption(body);
        const identity = payrollRequestIdentity({
            ...actor,
            actorUserId: actor.userId,
            operation: 'ADOPT',
            idempotencyKey: normalizePayrollIdempotencyKey(idempotencyKeyRaw),
            body: { periodId, cards },
        });
        const replay = await this.findReplay(actor, identity, 'ADOPT', periodId);
        if (replay) return replay;

        return retryPayrollSerializableMutation(() => this.tenantDb.withTenant(actor.tenantId, async (tx) => {
            await applyPayrollTransactionTimeouts(tx);
            await lockPayrollTenant(tx, actor.tenantId);
            await lockPayrollPeriod(tx, actor.tenantId, periodId);
            const insideReplay = await readPayrollOperationReplay(tx, actor, identity, 'ADOPT', periodId);
            if (insideReplay) return insideReplay;
            const period = await this.requirePeriod(tx, actor.tenantId, periodId);
            if (period.status !== 'OPEN') throw new ConflictException('Cards can be adopted only into an open payroll period.');
            const rows = await tx.timeCard.findMany({
                where: { tenantId: actor.tenantId, id: { in: cards.map((card) => card.id) } },
                orderBy: { id: 'asc' },
                take: cards.length,
            });
            if (rows.length !== cards.length) throw new NotFoundException('One or more time cards were not found.');
            const expectedById = new Map(cards.map((card) => [card.id, card.expectedRevision]));
            for (const card of rows) this.assertAdoptableCard(card, period, expectedById.get(card.id)!);
            for (const card of rows) {
                const updated = await tx.timeCard.updateMany({
                    where: {
                        id: card.id, tenantId: actor.tenantId, revision: expectedById.get(card.id),
                        payrollPeriodId: null, status: 'CLOSED', deletedAt: null,
                    },
                    data: { payrollPeriodId: period.id, revision: { increment: 1 } },
                });
                if (updated.count !== 1) throw new ConflictException(PAYROLL_CONCURRENT_CHANGE);
            }
            const response = {
                periodId: period.id,
                cards: rows.map((card) => ({ id: card.id, revision: card.revision + 1 })),
            };
            await writePayrollOperation(tx, actor, identity, 'ADOPT', period.id, response);
            await writePayrollAudit(tx, actor, {
                action: 'PAYROLL_TIME_CARDS_ADOPTED', resource: 'PayrollPeriod',
                resourceId: period.id, newValue: response,
            });
            return response;
        }, PAYROLL_TRANSACTION_OPTIONS));
    }

    async decide(actor: PayrollActor, periodIdRaw: unknown, body: unknown, idempotencyKeyRaw: unknown) {
        const periodId = requiredId(periodIdRaw, 'periodId');
        const decisions = parseApprovalDecisions(body);
        const identity = payrollRequestIdentity({
            ...actor,
            actorUserId: actor.userId,
            operation: 'APPROVAL',
            idempotencyKey: normalizePayrollIdempotencyKey(idempotencyKeyRaw),
            body: { periodId, decisions },
        });
        const replay = await this.findReplay(actor, identity, 'APPROVAL', periodId);
        if (replay) return replay;

        try {
            return await retryPayrollSerializableMutation(() => this.tenantDb.withTenant(actor.tenantId, async (tx) => {
                await applyPayrollTransactionTimeouts(tx);
                await lockPayrollTenant(tx, actor.tenantId);
                await lockPayrollPeriod(tx, actor.tenantId, periodId);
                const insideReplay = await readPayrollOperationReplay(tx, actor, identity, 'APPROVAL', periodId);
                if (insideReplay) return insideReplay;
                const period = await this.requirePeriod(tx, actor.tenantId, periodId);
                if (period.status !== 'REVIEW') {
                    throw new ConflictException('Time-card decisions require a payroll period in review.');
                }
                const rows = await tx.timeCard.findMany({
                    where: {
                        tenantId: actor.tenantId, payrollPeriodId: period.id,
                        id: { in: decisions.map((decision) => decision.timeCardId) },
                    },
                    orderBy: { id: 'asc' }, take: decisions.length,
                });
                if (rows.length !== decisions.length) throw new NotFoundException('One or more time cards were not found.');
                const decisionById = new Map(decisions.map((decision) => [decision.timeCardId, decision]));
                for (const card of rows) {
                    const decision = decisionById.get(card.id)!;
                    if (card.status !== 'CLOSED' || card.deletedAt || card.revision !== decision.expectedRevision) {
                        throw new ConflictException('A time-card decision references a stale or ineligible revision.');
                    }
                    if (card.userId === actor.userId) {
                        throw new ConflictException('Employees cannot approve or reject their own time cards.');
                    }
                }
                const existing = await tx.payrollTimeCardApproval.findMany({
                    where: {
                        tenantId: actor.tenantId,
                        OR: decisions.map((decision) => ({
                            timeCardId: decision.timeCardId,
                            timeCardRevision: decision.expectedRevision,
                        })),
                    },
                    take: decisions.length,
                    select: { id: true },
                });
                if (existing.length > 0) throw new ConflictException('A decision already exists for a time-card revision.');
                const created = [];
                for (const decision of decisions) {
                    const childIdentity = payrollRequestIdentity({
                        ...actor,
                        actorUserId: actor.userId,
                        operation: 'APPROVAL',
                        idempotencyKey: childPayrollOperationId(
                            identity.operationId, `${decision.timeCardId}:${decision.expectedRevision}`,
                        ),
                        body: decision,
                    });
                    created.push(await tx.payrollTimeCardApproval.create({
                        data: {
                            tenantId: actor.tenantId, periodId: period.id,
                            timeCardId: decision.timeCardId, timeCardRevision: decision.expectedRevision,
                            decision: decision.decision, reason: decision.reason,
                            operationId: childIdentity.operationId, requestHash: childIdentity.requestHash,
                            decidedByUserId: actor.userId,
                        },
                    }));
                }
                const response = {
                    periodId: period.id,
                    decisions: created.map((decision) => this.serializeApproval(decision)),
                };
                await writePayrollOperation(tx, actor, identity, 'APPROVAL', period.id, response);
                await writePayrollAudit(tx, actor, {
                    action: 'PAYROLL_TIME_CARD_DECISIONS_RECORDED', resource: 'PayrollPeriod',
                    resourceId: period.id, newValue: response,
                });
                return response;
            }, PAYROLL_TRANSACTION_OPTIONS));
        } catch (error) {
            if (isPrismaUniqueConflict(error)) {
                const racedReplay = await this.findReplay(actor, identity, 'APPROVAL', periodId);
                if (racedReplay) return racedReplay;
                throw new ConflictException('A payroll decision already exists for this request or revision.');
            }
            throw error;
        }
    }

    private async findReplay(
        actor: PayrollActor,
        identity: { operationId: string; requestHash: string },
        kind: 'ADOPT' | 'APPROVAL',
        periodId: string,
    ) {
        return this.tenantDb.withTenant(actor.tenantId, (tx) =>
            readPayrollOperationReplay(tx, actor, identity, kind, periodId));
    }

    private async requirePeriod(tx: TenantPrismaTransaction, tenantId: string, periodId: string) {
        const period = await tx.payrollPeriod.findFirst({ where: { id: periodId, tenantId } });
        if (!period) throw new NotFoundException('Payroll period not found.');
        return period;
    }

    private assertAdoptableCard(card: any, period: any, expectedRevision: number): void {
        if (card.revision !== expectedRevision) throw new ConflictException(PAYROLL_CONCURRENT_CHANGE);
        if (card.status !== 'CLOSED' || card.deletedAt || !card.clockOutAt || card.payrollPeriodId) {
            throw new BadRequestException('Only unassigned closed time cards can be adopted.');
        }
        if (card.clockInAt < period.startsAt || card.clockOutAt > period.endsAt) {
            throw new BadRequestException('Time card must be wholly within the payroll period.');
        }
        if (typeof card.workTimeZone !== 'string' || !card.workTimeZone.trim()) {
            throw new BadRequestException('Time card is missing its work timezone snapshot.');
        }
        normalizeTimeZone(card.workTimeZone);
    }

    private serializeApproval(value: any) {
        return {
            id: value.id,
            timeCardId: value.timeCardId,
            timeCardRevision: value.timeCardRevision,
            decision: value.decision,
            reason: value.reason ?? null,
            decidedAt: value.decidedAt.toISOString(),
            decidedByUserId: value.decidedByUserId,
        };
    }
}
