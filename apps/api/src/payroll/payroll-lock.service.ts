import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { TenantPrismaService, type TenantPrismaTransaction } from '../database/tenant-prisma.service';
import { payrollWorkedMinutes } from './payroll-csv';
import { normalizePayrollIdempotencyKey, payrollRequestIdentity } from './payroll-idempotency';
import { materializeLockedSnapshots, type LockedEntrySource } from './payroll-lock-snapshot';
import {
    lockPayrollCandidateCards,
    type PayrollCandidateCard,
    validatePayrollCandidateCards,
} from './payroll-period-cards';
import { serializePayrollPeriod } from './payroll-records';
import {
    applyPayrollTransactionTimeouts,
    lockPayrollPeriod,
    lockPayrollTenant,
    PAYROLL_CONCURRENT_CHANGE,
    PAYROLL_REPLAY_CONFLICT,
    PAYROLL_TRANSACTION_OPTIONS,
    retryPayrollSerializableMutation,
    type PayrollActor,
    writePayrollAudit,
} from './payroll-transaction';
import { MAX_PAYROLL_LOCK_ENTRIES, parseExpectedRevision, requiredId } from './payroll-validation';

type LockedBreak = {
    id: string;
    timeCardId: string;
    startAt: Date;
    endAt: Date;
};

@Injectable()
export class PayrollLockService {
    constructor(private readonly tenantDb: TenantPrismaService) {}

    async lock(actor: PayrollActor, periodIdRaw: unknown, body: unknown, idempotencyKeyRaw: unknown) {
        const periodId = requiredId(periodIdRaw, 'periodId');
        const request = body && typeof body === 'object' && !Array.isArray(body)
            ? body as Record<string, unknown>
            : {};
        const expectedRevision = parseExpectedRevision(request.expectedRevision);
        const identity = payrollRequestIdentity({
            tenantId: actor.tenantId,
            actorUserId: actor.userId,
            operation: 'LOCK',
            idempotencyKey: normalizePayrollIdempotencyKey(idempotencyKeyRaw),
            body: { periodId, expectedRevision },
        });
        const replay = await this.findReplay(actor, periodId, identity);
        if (replay) return replay;

        return retryPayrollSerializableMutation(() => this.tenantDb.withTenant(actor.tenantId, async (tx) => {
            await applyPayrollTransactionTimeouts(tx);
            await lockPayrollTenant(tx, actor.tenantId);
            await lockPayrollPeriod(tx, actor.tenantId, periodId);
            await this.lockPeriodRow(tx, actor.tenantId, periodId);
            const insideReplay = await this.findReplayInTransaction(tx, actor, periodId, identity);
            if (insideReplay) return insideReplay;

            const period = await tx.payrollPeriod.findFirst({ where: { id: periodId, tenantId: actor.tenantId } });
            if (!period) throw new NotFoundException('Payroll period not found.');
            if (period.status !== 'REVIEW') {
                throw new ConflictException('Only a payroll period in review can be locked.');
            }
            if (period.revision !== expectedRevision) throw new ConflictException(PAYROLL_CONCURRENT_CHANGE);
            if (period.endsAt.getTime() > Date.now()) {
                throw new BadRequestException('Payroll period cannot be locked before it ends.');
            }

            const cards = await lockPayrollCandidateCards(tx, actor.tenantId, period);
            const assignedCards = validatePayrollCandidateCards(cards, period);
            const breaksByCard = await this.lockAndValidateBreaks(tx, actor.tenantId, assignedCards);
            const cardSources = await this.approvedCardSources(
                tx,
                actor.tenantId,
                period.id,
                assignedCards,
                breaksByCard,
            );
            const amendmentSources = await this.approvedAmendmentSources(tx, actor.tenantId, period.id);
            if (cardSources.length + amendmentSources.length > MAX_PAYROLL_LOCK_ENTRIES) {
                throw new BadRequestException(`Payroll period exceeds the ${MAX_PAYROLL_LOCK_ENTRIES}-entry lock limit.`);
            }

            let snapshot;
            try {
                snapshot = materializeLockedSnapshots({
                    tenantId: actor.tenantId,
                    periodId: period.id,
                    sources: [...cardSources, ...amendmentSources],
                });
            } catch {
                throw new BadRequestException('Payroll source data is invalid for locking.');
            }
            if (snapshot.entries.length > 0) await tx.payrollLockedEntry.createMany({
                data: snapshot.entries.map((entry) => ({
                    tenantId: actor.tenantId,
                    periodId: period.id,
                    sequence: entry.sequence,
                    sourceType: entry.sourceType,
                    sourceId: entry.sourceId,
                    sourceRevision: entry.sourceRevision,
                    employeeId: entry.employeeId,
                    locationId: entry.locationId,
                    workTimeZone: entry.workTimeZone,
                    clockInAt: new Date(entry.clockInAt),
                    clockOutAt: new Date(entry.clockOutAt),
                    breakMinutes: entry.breakMinutes,
                    payableMinutes: entry.payableMinutes,
                    approvedAt: new Date(entry.approvedAt),
                    approvedByUserId: entry.approvedByUserId,
                    canonicalSha256: entry.canonicalSha256,
                })),
            });
            const changed = await tx.payrollPeriod.updateMany({
                where: {
                    id: period.id,
                    tenantId: actor.tenantId,
                    status: 'REVIEW',
                    revision: expectedRevision,
                },
                data: {
                    status: 'LOCKED',
                    revision: { increment: 1 },
                    lockedAt: new Date(),
                    lockedByUserId: actor.userId,
                    lockOperationId: identity.operationId,
                    lockRequestHash: identity.requestHash,
                    lockedEntrySha256: snapshot.aggregateSha256,
                    lockedEntryCount: snapshot.entries.length,
                    totalPayableMinutes: snapshot.totalPayableMinutes,
                },
            });
            if (changed.count !== 1) throw new ConflictException(PAYROLL_CONCURRENT_CHANGE);
            const updated = await tx.payrollPeriod.findFirst({ where: { id: period.id, tenantId: actor.tenantId } });
            if (!updated) throw new NotFoundException('Payroll period not found.');
            const response = serializePayrollPeriod(updated);
            await writePayrollAudit(tx, actor, {
                action: 'PAYROLL_PERIOD_LOCKED',
                resource: 'PayrollPeriod',
                resourceId: period.id,
                oldValue: serializePayrollPeriod(period),
                newValue: response,
            });
            return response;
        }, PAYROLL_TRANSACTION_OPTIONS));
    }

    private async findReplay(
        actor: PayrollActor,
        periodId: string,
        identity: { operationId: string; requestHash: string },
    ) {
        return this.tenantDb.withTenant(actor.tenantId, (tx) =>
            this.findReplayInTransaction(tx, actor, periodId, identity));
    }

    private async findReplayInTransaction(
        tx: TenantPrismaTransaction,
        actor: PayrollActor,
        periodId: string,
        identity: { operationId: string; requestHash: string },
    ) {
        const period = await tx.payrollPeriod.findFirst({ where: { id: periodId, tenantId: actor.tenantId } });
        if (!period || period.status !== 'LOCKED') return null;
        if (period.lockOperationId !== identity.operationId || period.lockRequestHash !== identity.requestHash) {
            throw new ConflictException(PAYROLL_REPLAY_CONFLICT);
        }
        return serializePayrollPeriod(period);
    }

    private async lockPeriodRow(tx: TenantPrismaTransaction, tenantId: string, periodId: string): Promise<void> {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id"
            FROM "PayrollPeriod"
            WHERE "tenantId" = ${tenantId} AND "id" = ${periodId}
            FOR UPDATE
        `;
        if (rows.length !== 1) throw new NotFoundException('Payroll period not found.');
    }

    private async lockAndValidateBreaks(
        tx: TenantPrismaTransaction,
        tenantId: string,
        cards: PayrollCandidateCard[],
    ): Promise<Map<string, LockedBreak[]>> {
        const byCard = new Map<string, LockedBreak[]>();
        cards.forEach((card) => byCard.set(card.id, []));
        if (cards.length === 0) return byCard;
        const breaks = await tx.$queryRaw<LockedBreak[]>`
            SELECT "id", "timeCardId", "startAt", "endAt"
            FROM "TimeCardBreak"
            WHERE "tenantId" = ${tenantId}
              AND "timeCardId" IN (${Prisma.join(cards.map((card) => card.id))})
            ORDER BY "timeCardId" ASC, "startAt" ASC, "id" ASC
            FOR UPDATE
        `;
        const cardById = new Map(cards.map((card) => [card.id, card]));
        for (const interval of breaks) byCard.get(interval.timeCardId)?.push(interval);
        for (const [cardId, intervals] of byCard) {
            const card = cardById.get(cardId)!;
            let previousEnd = card.clockInAt;
            let total = 0;
            for (const interval of intervals) {
                if (
                    interval.startAt < card.clockInAt
                    || !card.clockOutAt
                    || interval.endAt > card.clockOutAt
                    || interval.endAt <= interval.startAt
                    || interval.startAt < previousEnd
                ) {
                    throw new BadRequestException('Time-card break evidence is invalid for payroll locking.');
                }
                total += Math.floor((interval.endAt.getTime() - interval.startAt.getTime()) / 60_000);
                previousEnd = interval.endAt;
            }
            if (intervals.length > 0 && total !== card.breakMinutes) {
                throw new BadRequestException('Time-card breaks do not match aggregate break minutes.');
            }
        }
        return byCard;
    }

    private async approvedCardSources(
        tx: TenantPrismaTransaction,
        tenantId: string,
        periodId: string,
        cards: PayrollCandidateCard[],
        breaksByCard: Map<string, LockedBreak[]>,
    ): Promise<LockedEntrySource[]> {
        if (cards.length === 0) return [];
        const approvals = await tx.payrollTimeCardApproval.findMany({
            where: {
                tenantId,
                periodId,
                OR: cards.map((card) => ({
                    timeCardId: card.id,
                    timeCardRevision: card.revision,
                })),
            },
            orderBy: [{ timeCardId: 'asc' }],
            take: cards.length,
        });
        const exact = new Map(approvals.map((approval) => [
            `${approval.timeCardId}:${approval.timeCardRevision}`,
            approval,
        ]));
        return cards.map((card) => {
            const approval = exact.get(`${card.id}:${card.revision}`);
            if (!approval || approval.decision !== 'APPROVED') {
                throw new BadRequestException('Every current time-card revision must have an approved decision.');
            }
            return {
                sourceType: 'TIME_CARD',
                sourceId: card.id,
                sourceRevision: card.revision,
                employeeId: card.userId,
                locationId: card.locationId,
                workTimeZone: card.workTimeZone,
                clockInAt: card.clockInAt,
                clockOutAt: card.clockOutAt!,
                breakMinutes: card.breakMinutes,
                payableMinutes: payrollWorkedMinutes({
                    clockInAt: card.clockInAt,
                    clockOutAt: card.clockOutAt!,
                    breakMinutes: card.breakMinutes,
                }),
                approvedAt: approval.decidedAt,
                approvedByUserId: approval.decidedByUserId,
                breakIntervals: breaksByCard.get(card.id) ?? [],
            };
        });
    }

    private async approvedAmendmentSources(
        tx: TenantPrismaTransaction,
        tenantId: string,
        adjustmentPeriodId: string,
    ): Promise<LockedEntrySource[]> {
        const amendments = await tx.payrollAmendment.findMany({
            where: { tenantId, adjustmentPeriodId },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: MAX_PAYROLL_LOCK_ENTRIES + 1,
        });
        if (amendments.length > MAX_PAYROLL_LOCK_ENTRIES) {
            throw new BadRequestException(`Payroll period exceeds the ${MAX_PAYROLL_LOCK_ENTRIES}-amendment lock limit.`);
        }
        if (amendments.length === 0) return [];
        const decisions = await tx.payrollAmendmentDecision.findMany({
            where: { tenantId, amendmentId: { in: amendments.map((amendment) => amendment.id) } },
            orderBy: { amendmentId: 'asc' },
            take: amendments.length,
        });
        const decisionByAmendment = new Map(decisions.map((decision) => [decision.amendmentId, decision]));
        if (amendments.some((amendment) => !decisionByAmendment.has(amendment.id))) {
            throw new BadRequestException('Pending payroll amendments block payroll locking.');
        }
        const approved = amendments.filter((amendment) => (
            decisionByAmendment.get(amendment.id)?.decision === 'APPROVED'
        ));
        if (approved.length === 0) return [];
        const originals = await tx.payrollLockedEntry.findMany({
            where: { tenantId, id: { in: approved.map((amendment) => amendment.lockedEntryId) } },
            orderBy: { id: 'asc' },
            take: approved.length,
        });
        const originalById = new Map(originals.map((entry) => [entry.id, entry]));
        return approved.map((amendment) => {
            const original = originalById.get(amendment.lockedEntryId);
            const decision = decisionByAmendment.get(amendment.id)!;
            if (!original) throw new NotFoundException('Amendment source entry not found.');
            return {
                sourceType: 'AMENDMENT',
                sourceId: amendment.id,
                sourceRevision: 1,
                employeeId: original.employeeId,
                locationId: original.locationId,
                workTimeZone: original.workTimeZone,
                clockInAt: amendment.replacementClockInAt,
                clockOutAt: amendment.replacementClockOutAt,
                breakMinutes: amendment.replacementBreakMinutes,
                payableMinutes: amendment.minuteDelta,
                approvedAt: decision.decidedAt,
                approvedByUserId: decision.decidedByUserId,
            };
        });
    }
}
