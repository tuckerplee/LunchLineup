import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { normalizeTimeZone } from '../common/location-timezone';
import { AuthService } from '../auth/auth.service';
import { RbacService } from '../auth/rbac.service';
import { TenantPrismaService, type TenantPrismaTransaction } from '../database/tenant-prisma.service';
import {
    childPayrollOperationId,
    normalizePayrollIdempotencyKey,
    payrollRequestIdentity,
} from './payroll-idempotency';
import { readPayrollOperationReplay, writePayrollOperation } from './payroll-operation';
import {
    isPrismaUniqueConflict,
    lockPayrollPeriod,
    lockPayrollTenant,
    PAYROLL_CONCURRENT_CHANGE,
    runCurrentPayrollMutation,
    type PayrollActor,
    writePayrollAudit,
} from './payroll-transaction';
import { parseAdoption, parseApprovalDecisions, requiredId } from './payroll-validation';

@Injectable()
export class PayrollCardService {
    constructor(
        private readonly tenantDb: TenantPrismaService,
        private readonly rbac: RbacService,
        private readonly authService: AuthService,
    ) {}

    async adopt(actor: PayrollActor, periodIdRaw: unknown, body: unknown, idempotencyKeyRaw: unknown) {
        actor = Object.freeze({ ...actor });
        const periodId = requiredId(periodIdRaw, 'periodId');
        const cards = parseAdoption(body);
        const identity = payrollRequestIdentity({
            ...actor,
            actorUserId: actor.userId,
            operation: 'ADOPT',
            idempotencyKey: normalizePayrollIdempotencyKey(idempotencyKeyRaw),
            body: { periodId, cards },
        });
        return runCurrentPayrollMutation(this.rbac, this.authService, actor, 'payroll:policy_write',
            async (tx, assertCurrent, actor) => {
                assertCurrent();
                const replay = await readPayrollOperationReplay(tx, actor, identity, 'ADOPT', periodId);
                assertCurrent();
                if (replay) return replay;

                assertCurrent();
                await lockPayrollTenant(tx, actor.tenantId);
                assertCurrent();
                await lockPayrollPeriod(tx, actor.tenantId, periodId);
                assertCurrent();
                const insideReplay = await readPayrollOperationReplay(tx, actor, identity, 'ADOPT', periodId);
                assertCurrent();
                if (insideReplay) return insideReplay;
                assertCurrent();
                const period = await this.requirePeriod(tx, actor.tenantId, periodId);
                assertCurrent();
                if (period.status !== 'OPEN') throw new ConflictException('Cards can be adopted only into an open payroll period.');
                assertCurrent();
                const rows = await tx.timeCard.findMany({
                    where: { tenantId: actor.tenantId, id: { in: cards.map((card) => card.id) } },
                    orderBy: { id: 'asc' },
                    take: cards.length,
                });
                assertCurrent();
                if (rows.length !== cards.length) throw new NotFoundException('One or more time cards were not found.');
                const expectedById = new Map(cards.map((card) => [card.id, card.expectedRevision]));
                for (const card of rows) this.assertAdoptableCard(card, period, expectedById.get(card.id)!);
                for (const card of rows) {
                    assertCurrent();
                    const updated = await tx.timeCard.updateMany({
                        where: {
                            id: card.id, tenantId: actor.tenantId, revision: expectedById.get(card.id),
                            payrollPeriodId: null, status: 'CLOSED', deletedAt: null,
                        },
                        data: { payrollPeriodId: period.id, revision: { increment: 1 } },
                    });
                    assertCurrent();
                    if (updated.count !== 1) throw new ConflictException(PAYROLL_CONCURRENT_CHANGE);
                }
                const response = {
                    periodId: period.id,
                    cards: rows.map((card) => ({ id: card.id, revision: card.revision + 1 })),
                };
                assertCurrent();
                await writePayrollOperation(tx, actor, identity, 'ADOPT', period.id, response, assertCurrent);
                assertCurrent();
                await writePayrollAudit(tx, actor, {
                    action: 'PAYROLL_TIME_CARDS_ADOPTED', resource: 'PayrollPeriod',
                    resourceId: period.id, newValue: response,
                }, assertCurrent);
                assertCurrent();
                return response;
            });
    }

    async decide(actor: PayrollActor, periodIdRaw: unknown, body: unknown, idempotencyKeyRaw: unknown) {
        actor = Object.freeze({ ...actor });
        const periodId = requiredId(periodIdRaw, 'periodId');
        const decisions = parseApprovalDecisions(body);
        const identity = payrollRequestIdentity({
            ...actor,
            actorUserId: actor.userId,
            operation: 'APPROVAL',
            idempotencyKey: normalizePayrollIdempotencyKey(idempotencyKeyRaw),
            body: { periodId, decisions },
        });
        return runCurrentPayrollMutation(this.rbac, this.authService, actor, 'time_cards:approve',
            async (tx, assertCurrent, actor) => {
                assertCurrent();
                const replay = await readPayrollOperationReplay(tx, actor, identity, 'APPROVAL', periodId);
                assertCurrent();
                if (replay) return replay;

                assertCurrent();
                await lockPayrollTenant(tx, actor.tenantId);
                assertCurrent();
                await lockPayrollPeriod(tx, actor.tenantId, periodId);
                assertCurrent();
                const insideReplay = await readPayrollOperationReplay(tx, actor, identity, 'APPROVAL', periodId);
                assertCurrent();
                if (insideReplay) return insideReplay;
                assertCurrent();
                const period = await this.requirePeriod(tx, actor.tenantId, periodId);
                assertCurrent();
                if (period.status !== 'REVIEW') {
                    throw new ConflictException('Time-card decisions require a payroll period in review.');
                }
                assertCurrent();
                const rows = await tx.timeCard.findMany({
                    where: {
                        tenantId: actor.tenantId, payrollPeriodId: period.id,
                        id: { in: decisions.map((decision) => decision.timeCardId) },
                    },
                    orderBy: { id: 'asc' }, take: decisions.length,
                });
                assertCurrent();
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
                assertCurrent();
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
                assertCurrent();
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
                    assertCurrent();
                    created.push(await tx.payrollTimeCardApproval.create({
                        data: {
                            tenantId: actor.tenantId, periodId: period.id,
                            timeCardId: decision.timeCardId, timeCardRevision: decision.expectedRevision,
                            decision: decision.decision, reason: decision.reason,
                            operationId: childIdentity.operationId, requestHash: childIdentity.requestHash,
                            decidedByUserId: actor.userId,
                        },
                    }));
                    assertCurrent();
                }
                const response = {
                    periodId: period.id,
                    decisions: created.map((decision) => this.serializeApproval(decision)),
                };
                assertCurrent();
                await writePayrollOperation(tx, actor, identity, 'APPROVAL', period.id, response, assertCurrent);
                assertCurrent();
                await writePayrollAudit(tx, actor, {
                    action: 'PAYROLL_TIME_CARD_DECISIONS_RECORDED', resource: 'PayrollPeriod',
                    resourceId: period.id, newValue: response,
                }, assertCurrent);
                assertCurrent();
                return response;
            }, {
            isRecoverable: isPrismaUniqueConflict,
            operation: async (tx, assertCurrent, actor, error) => {
                assertCurrent();
                const replay = await readPayrollOperationReplay(tx, actor, identity, 'APPROVAL', periodId);
                assertCurrent();
                if (replay) return replay;
                throw new ConflictException('A payroll decision already exists for this request or revision.');
            },
        });
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
