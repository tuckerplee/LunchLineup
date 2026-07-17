import {
    BadRequestException,
    ConflictException,
    NotFoundException,
} from '@nestjs/common';
import { TenantPrismaTransaction } from '../database/tenant-prisma.service';
import {
    timeCardAuditValue,
    TimeCardCorrectionBody,
    validateTimeCardCorrection,
} from './time-card-correction';
import {
    lockTimeCardPayrollContext,
    resolveTimeCardPayrollAssignment,
} from './time-card-payroll-lock';

export const TIME_CARD_RELATIONS = {
    user: { select: { id: true, name: true, username: true, role: true } },
    location: { select: { id: true, name: true, timezone: true } },
    shift: { select: { id: true, startTime: true, endTime: true } },
    breaks: { orderBy: { startAt: 'asc' as const } },
} as const;

export async function correctTimeCardInTransaction(
    tx: TenantPrismaTransaction,
    tenantId: string,
    actorUserId: string,
    cardId: string,
    body: TimeCardCorrectionBody,
) {
    const initialCard = await findTimeCard(tx, tenantId, cardId);
    if (initialCard.status === 'VOID') {
        throw new BadRequestException('Voided time cards cannot be corrected.');
    }
    const correction = validateTimeCardCorrection(body, initialCard);
    const assignment = await resolveTimeCardPayrollAssignment(
        tx,
        tenantId,
        correction.clockInAt,
        initialCard.location ? { id: initialCard.location.id, timezone: initialCard.workTimeZone } : null,
    );
    await lockTimeCardPayrollContext(
        tx,
        tenantId,
        cardId,
        [initialCard.payrollPeriodId, assignment.payrollPeriodId],
    );
    const card = await findTimeCard(tx, tenantId, cardId);
    if (card.status === 'VOID') {
        throw new BadRequestException('Voided time cards cannot be corrected.');
    }
    await assertNoTimeCardOverlap(
        tx,
        tenantId,
        card.userId,
        card.id,
        correction.clockInAt,
        correction.clockOutAt,
    );

    const updateResult = await tx.timeCard.updateMany({
        where: {
            id: card.id,
            tenantId,
            deletedAt: null,
            updatedAt: correction.expectedUpdatedAt,
            revision: card.revision,
        },
        data: {
            clockInAt: correction.clockInAt,
            clockOutAt: correction.clockOutAt,
            breakMinutes: correction.breakMinutes,
            status: correction.status,
            payrollPeriodId: assignment.payrollPeriodId,
            workTimeZone: assignment.workTimeZone,
            revision: { increment: 1 },
        },
    });
    if (updateResult.count !== 1) {
        throw new ConflictException('This time card changed while you were editing it. Refresh and try again.');
    }

    if (correction.breakIntervals) {
        await tx.timeCardBreak.deleteMany({ where: { tenantId, timeCardId: card.id } });
        if (correction.breakIntervals.length > 0) {
            await tx.timeCardBreak.createMany({
                data: correction.breakIntervals.map((interval) => ({
                    tenantId,
                    timeCardId: card.id,
                    startAt: interval.startAt,
                    endAt: interval.endAt,
                })),
            });
        }
    }

    const updated = await findTimeCard(tx, tenantId, cardId);
    await tx.auditLog.create({
        data: {
            tenantId,
            userId: actorUserId,
            action: 'TIME_CARD_CORRECTED',
            resource: 'TimeCard',
            resourceId: card.id,
            oldValue: timeCardAuditValue(card),
            newValue: {
                ...timeCardAuditValue(updated),
                correctionReason: correction.reason,
            },
        },
    });
    return updated;
}

async function findTimeCard(
    tx: TenantPrismaTransaction,
    tenantId: string,
    cardId: string,
) {
    const card = await tx.timeCard.findFirst({
        where: {
            id: cardId,
            tenantId,
            deletedAt: null,
        },
        include: TIME_CARD_RELATIONS,
    });
    if (!card) throw new NotFoundException('Time card not found');
    return card;
}

async function assertNoTimeCardOverlap(
    tx: TenantPrismaTransaction,
    tenantId: string,
    userId: string,
    cardId: string,
    clockInAt: Date,
    clockOutAt: Date | null,
): Promise<void> {
    const overlap = await tx.timeCard.findFirst({
        where: {
            tenantId,
            userId,
            id: { not: cardId },
            deletedAt: null,
            status: { not: 'VOID' },
            clockInAt: { lt: clockOutAt ?? new Date('9999-12-31T23:59:59.999Z') },
            OR: [
                { clockOutAt: null },
                { clockOutAt: { gt: clockInAt } },
            ],
        },
        select: { id: true },
    });
    if (overlap) {
        throw new BadRequestException('Corrected time cards cannot overlap another card for this employee.');
    }
}
