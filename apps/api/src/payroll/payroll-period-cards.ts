import { BadRequestException, ConflictException } from '@nestjs/common';

import { normalizeTimeZone } from '../common/location-timezone';
import type { TenantPrismaTransaction } from '../database/tenant-prisma.service';
import { MAX_PAYROLL_LOCK_ENTRIES } from './payroll-validation';

export type PayrollCandidateCard = {
    id: string;
    tenantId: string;
    userId: string;
    locationId: string | null;
    payrollPeriodId: string | null;
    workTimeZone: string;
    revision: number;
    clockInAt: Date;
    clockOutAt: Date | null;
    breakMinutes: number;
    status: 'OPEN' | 'CLOSED' | 'VOID';
    deletedAt: Date | null;
};

type PayrollPeriodWindow = { id: string; startsAt: Date; endsAt: Date };

export function isHistoricalPayrollCardInWindow(
    card: {
        payrollPeriodId: string | null;
        status: 'OPEN' | 'CLOSED' | 'VOID';
        deletedAt?: Date | null;
        clockInAt: Date;
        clockOutAt: Date | null;
    },
    period: Pick<PayrollPeriodWindow, 'startsAt' | 'endsAt'>,
): boolean {
    return card.payrollPeriodId === null
        && card.status === 'CLOSED'
        && !card.deletedAt
        && card.clockOutAt !== null
        && card.clockInAt >= period.startsAt
        && card.clockInAt < period.endsAt
        && card.clockOutAt <= period.endsAt;
}

export async function lockPayrollCandidateCards(
    tx: TenantPrismaTransaction,
    tenantId: string,
    period: PayrollPeriodWindow,
): Promise<PayrollCandidateCard[]> {
    const cards = await tx.$queryRaw<PayrollCandidateCard[]>`
        SELECT card."id", card."tenantId", card."userId", card."locationId",
               card."payrollPeriodId", card."workTimeZone", card."revision",
               card."clockInAt", card."clockOutAt", card."breakMinutes",
               card."status", card."deletedAt"
        FROM "TimeCard" card
        WHERE card."tenantId" = ${tenantId}
          AND (
            card."payrollPeriodId" = ${period.id}
            OR (
                card."deletedAt" IS NULL
                AND card."clockInAt" < ${period.endsAt}
                AND (card."clockOutAt" IS NULL OR card."clockOutAt" > ${period.startsAt})
            )
          )
        ORDER BY card."id" ASC
        LIMIT ${MAX_PAYROLL_LOCK_ENTRIES + 1}
        FOR UPDATE
    `;
    if (cards.length > MAX_PAYROLL_LOCK_ENTRIES) {
        throw new BadRequestException(`Payroll period exceeds the ${MAX_PAYROLL_LOCK_ENTRIES}-card limit.`);
    }
    return cards;
}

export function validatePayrollCandidateCards(
    cards: PayrollCandidateCard[],
    period: PayrollPeriodWindow,
): PayrollCandidateCard[] {
    const assigned = cards.filter((card) => card.payrollPeriodId === period.id);
    if (cards.some((card) => card.status === 'OPEN')) {
        throw new ConflictException('Open time cards overlap or belong to this payroll period.');
    }
    if (cards.some((card) => card.status === 'VOID' || card.deletedAt)) {
        throw new ConflictException('Void or deleted assigned time cards block payroll review and locking.');
    }
    if (cards.some((card) => card.payrollPeriodId !== period.id)) {
        throw new ConflictException('Unassigned or other-period time cards overlap this payroll period.');
    }
    if (assigned.some((card) => (
        card.status !== 'CLOSED'
        || !card.clockOutAt
        || card.clockInAt < period.startsAt
        || card.clockOutAt > period.endsAt
    ))) {
        throw new ConflictException('Assigned time cards must be closed and wholly within the payroll period.');
    }
    for (const card of assigned) {
        if (!card.userId?.trim()) throw new ConflictException('Time card is missing its employee identity.');
        if (!card.workTimeZone?.trim()) throw new ConflictException('Time card is missing its work timezone.');
        try {
            normalizeTimeZone(card.workTimeZone);
        } catch {
            throw new ConflictException('Time card has an invalid work timezone.');
        }
    }
    return assigned;
}
