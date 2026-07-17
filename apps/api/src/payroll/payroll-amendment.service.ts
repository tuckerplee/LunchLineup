import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { TenantPrismaService, type TenantPrismaTransaction } from '../database/tenant-prisma.service';
import { payrollWorkedMinutes } from './payroll-csv';
import { normalizePayrollIdempotencyKey, payrollRequestIdentity } from './payroll-idempotency';
import { serializePayrollAmendment } from './payroll-records';
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
import { parseAmendment, parseAmendmentDecision, requiredId } from './payroll-validation';

@Injectable()
export class PayrollAmendmentService {
    constructor(private readonly tenantDb: TenantPrismaService) {}

    async create(actor: PayrollActor, entryIdRaw: unknown, body: unknown, idempotencyKeyRaw: unknown) {
        const entryId = requiredId(entryIdRaw, 'entryId');
        const amendment = parseAmendment(body);
        const identity = payrollRequestIdentity({
            ...actor,
            actorUserId: actor.userId,
            operation: 'AMENDMENT_CREATE',
            idempotencyKey: normalizePayrollIdempotencyKey(idempotencyKeyRaw),
            body: {
                entryId,
                ...amendment,
                replacementClockInAt: amendment.replacementClockInAt.toISOString(),
                replacementClockOutAt: amendment.replacementClockOutAt.toISOString(),
            },
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
                const entry = await tx.payrollLockedEntry.findFirst({
                    where: { id: entryId, tenantId: actor.tenantId },
                });
                if (!entry) throw new NotFoundException('Payroll locked entry not found.');
                if (entry.sourceType !== 'TIME_CARD') {
                    throw new BadRequestException('Only original time-card entries can be amended.');
                }
                if (entry.employeeId === actor.userId) {
                    throw new ConflictException('Employees cannot request amendments to their own payroll entries.');
                }
                const adjustmentPeriod = await this.requirePeriod(tx, actor.tenantId, amendment.adjustmentPeriodId);
                if (adjustmentPeriod.status !== 'OPEN') {
                    throw new ConflictException('The adjustment payroll period must be open.');
                }
                const sourcePeriod = await this.requirePeriod(tx, actor.tenantId, entry.periodId);
                if (adjustmentPeriod.startsAt < sourcePeriod.endsAt) {
                    throw new ConflictException(
                        'The adjustment payroll period must begin after the source payroll period ends.',
                    );
                }
                const replacementPayableMinutes = payrollWorkedMinutes({
                    clockInAt: amendment.replacementClockInAt,
                    clockOutAt: amendment.replacementClockOutAt,
                    breakMinutes: amendment.replacementBreakMinutes,
                });
                const minuteDelta = replacementPayableMinutes - entry.payableMinutes;
                if (!Number.isSafeInteger(minuteDelta)) throw new BadRequestException('Amendment minute delta is invalid.');
                const created = await tx.payrollAmendment.create({
                    data: {
                        tenantId: actor.tenantId,
                        lockedEntryId: entry.id,
                        adjustmentPeriodId: adjustmentPeriod.id,
                        operationId: identity.operationId,
                        requestHash: identity.requestHash,
                        requestedByUserId: actor.userId,
                        reason: amendment.reason,
                        replacementClockInAt: amendment.replacementClockInAt,
                        replacementClockOutAt: amendment.replacementClockOutAt,
                        replacementBreakMinutes: amendment.replacementBreakMinutes,
                        replacementPayableMinutes,
                        minuteDelta,
                    },
                });
                const response = serializePayrollAmendment(created);
                await writePayrollAudit(tx, actor, {
                    action: 'PAYROLL_AMENDMENT_REQUESTED',
                    resource: 'PayrollAmendment',
                    resourceId: created.id,
                    newValue: response,
                });
                return response;
            }, PAYROLL_TRANSACTION_OPTIONS));
        } catch (error) {
            if (isPrismaUniqueConflict(error)) {
                const racedReplay = await this.findReplay(actor, identity.operationId, identity.requestHash);
                if (racedReplay) return racedReplay;
                throw new ConflictException(PAYROLL_REPLAY_CONFLICT);
            }
            throw error;
        }
    }

    async decide(actor: PayrollActor, amendmentIdRaw: unknown, body: unknown, idempotencyKeyRaw: unknown) {
        const amendmentId = requiredId(amendmentIdRaw, 'amendmentId');
        const decision = parseAmendmentDecision(body);
        const identity = payrollRequestIdentity({
            ...actor,
            actorUserId: actor.userId,
            operation: 'AMENDMENT_DECISION',
            idempotencyKey: normalizePayrollIdempotencyKey(idempotencyKeyRaw),
            body: { amendmentId, ...decision },
        });
        const replay = await this.findDecisionReplay(actor, identity.operationId, identity.requestHash);
        if (replay) return replay;

        try {
            return await retryPayrollSerializableMutation(() => this.tenantDb.withTenant(actor.tenantId, async (tx) => {
                await applyPayrollTransactionTimeouts(tx);
                await lockPayrollTenant(tx, actor.tenantId);
                const insideReplay = await this.findDecisionReplayInTransaction(
                    tx, actor, identity.operationId, identity.requestHash,
                );
                if (insideReplay) return insideReplay;
                const amendment = await tx.payrollAmendment.findFirst({
                    where: { id: amendmentId, tenantId: actor.tenantId },
                });
                if (!amendment) throw new NotFoundException('Payroll amendment not found.');
                const [period, entry, existing] = await Promise.all([
                    this.requirePeriod(tx, actor.tenantId, amendment.adjustmentPeriodId),
                    tx.payrollLockedEntry.findFirst({
                        where: { id: amendment.lockedEntryId, tenantId: actor.tenantId },
                    }),
                    tx.payrollAmendmentDecision.findFirst({
                        where: { tenantId: actor.tenantId, amendmentId: amendment.id },
                        select: { id: true },
                    }),
                ]);
                if (!entry) throw new NotFoundException('Payroll locked entry not found.');
                if (period.status !== 'REVIEW') {
                    throw new ConflictException('Amendment decisions require an adjustment period in review.');
                }
                if (actor.userId === amendment.requestedByUserId || actor.userId === entry.employeeId) {
                    throw new ConflictException('Amendments require an independent approver.');
                }
                if (existing) throw new ConflictException('This amendment already has a decision.');
                const created = await tx.payrollAmendmentDecision.create({
                    data: {
                        tenantId: actor.tenantId,
                        amendmentId: amendment.id,
                        decision: decision.decision,
                        reason: decision.reason,
                        operationId: identity.operationId,
                        requestHash: identity.requestHash,
                        decidedByUserId: actor.userId,
                    },
                });
                const response = this.serializeDecision(created);
                await writePayrollAudit(tx, actor, {
                    action: 'PAYROLL_AMENDMENT_DECIDED',
                    resource: 'PayrollAmendment',
                    resourceId: amendment.id,
                    newValue: response,
                });
                return response;
            }, PAYROLL_TRANSACTION_OPTIONS));
        } catch (error) {
            if (isPrismaUniqueConflict(error)) {
                const racedReplay = await this.findDecisionReplay(
                    actor, identity.operationId, identity.requestHash,
                );
                if (racedReplay) return racedReplay;
                throw new ConflictException('This amendment already has a decision.');
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
        const row = await tx.payrollAmendment.findUnique({ where: { operationId } });
        if (!row) return null;
        this.assertReplay(row, actor.tenantId, requestHash);
        return serializePayrollAmendment(row);
    }

    private async findDecisionReplay(actor: PayrollActor, operationId: string, requestHash: string) {
        return this.tenantDb.withTenant(actor.tenantId, (tx) =>
            this.findDecisionReplayInTransaction(tx, actor, operationId, requestHash));
    }

    private async findDecisionReplayInTransaction(
        tx: TenantPrismaTransaction,
        actor: PayrollActor,
        operationId: string,
        requestHash: string,
    ) {
        const row = await tx.payrollAmendmentDecision.findUnique({ where: { operationId } });
        if (!row) return null;
        this.assertReplay(row, actor.tenantId, requestHash);
        return this.serializeDecision(row);
    }

    private serializeDecision(row: any) {
        return {
            id: row.id,
            amendmentId: row.amendmentId,
            decision: row.decision,
            reason: row.reason,
            decidedByUserId: row.decidedByUserId,
            decidedAt: row.decidedAt.toISOString(),
        };
    }

    private assertReplay(row: { tenantId: string; requestHash: string }, tenantId: string, requestHash: string) {
        if (row.tenantId !== tenantId || row.requestHash !== requestHash) {
            throw new ConflictException(PAYROLL_REPLAY_CONFLICT);
        }
    }

    private async requirePeriod(tx: TenantPrismaTransaction, tenantId: string, periodId: string) {
        const period = await tx.payrollPeriod.findFirst({ where: { id: periodId, tenantId } });
        if (!period) throw new NotFoundException('Payroll period not found.');
        return period;
    }
}
