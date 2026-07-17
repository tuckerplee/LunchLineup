import { BadRequestException, ConflictException } from '@nestjs/common';
import { dateValueInTimeZone } from '../common/location-timezone';
import { TenantPrismaTransaction } from '../database/tenant-prisma.service';
import { lockPayrollPeriod, lockPayrollTenant } from '../payroll/payroll-transaction';

const POLICY_ASSIGNMENT_PAGE_SIZE = 100;

export type TimeCardPayrollAssignment = {
    payrollPeriodId: string | null;
    workTimeZone: string;
};

export type LockedPayrollPeriodWindow = {
    id: string;
    startsAt: Date;
    endsAt: Date;
};

export async function resolveTimeCardPayrollAssignment(
    tx: TenantPrismaTransaction,
    tenantId: string,
    clockInAt: Date,
    location: { id: string; timezone: string } | null,
): Promise<TimeCardPayrollAssignment> {
    let policy: { id: string; version: number; timeZone: string; effectiveFrom: Date } | undefined;
    let cursorId: string | undefined;
    do {
        const policies = await tx.payrollPolicyVersion.findMany({
            where: { tenantId },
            orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
            take: POLICY_ASSIGNMENT_PAGE_SIZE,
            ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
            select: { id: true, version: true, timeZone: true, effectiveFrom: true },
        });
        policy = policies.find((candidate) => (
            candidate.effectiveFrom.toISOString().slice(0, 10)
            <= dateValueInTimeZone(clockInAt, candidate.timeZone)
        ));
        if (policy || policies.length < POLICY_ASSIGNMENT_PAGE_SIZE) break;
        cursorId = policies[policies.length - 1].id;
    } while (cursorId);
    if (!policy) {
        return {
            payrollPeriodId: null,
            workTimeZone: location?.timezone ?? 'UTC',
        };
    }
    if (!location) {
        throw new BadRequestException('Payroll-enabled time cards require a location.');
    }
    const period = await tx.payrollPeriod.findFirst({
        where: {
            tenantId,
            policyVersionId: policy.id,
            status: 'OPEN',
            startsAt: { lte: clockInAt },
            endsAt: { gt: clockInAt },
        },
        select: { id: true },
    });
    if (!period) {
        throw new ConflictException('No open payroll period covers this clock-in time.');
    }
    await lockPayrollTenant(tx, tenantId);
    await lockPayrollPeriod(tx, tenantId, period.id);
    const current = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "PayrollPeriod"
        WHERE "id" = ${period.id}
          AND "tenantId" = ${tenantId}
          AND "policyVersionId" = ${policy.id}
          AND "status" = 'OPEN'::"PayrollPeriodStatus"
          AND "startsAt" <= ${clockInAt}
          AND "endsAt" > ${clockInAt}
        FOR UPDATE
    `;
    if (current.length !== 1) {
        throw new ConflictException('Payroll period changed while the time card was being created.');
    }
    return {
        payrollPeriodId: period.id,
        workTimeZone: location.timezone,
    };
}

export async function lockTimeCardPayrollContext(
    tx: TenantPrismaTransaction,
    tenantId: string,
    timeCardId: string,
    periodIds: Array<string | null | undefined>,
): Promise<LockedPayrollPeriodWindow[]> {
    await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
    await lockPayrollTenant(tx, tenantId);
    const orderedPeriodIds = [...new Set(periodIds.filter((value): value is string => Boolean(value)))].sort();
    const lockedPeriods: LockedPayrollPeriodWindow[] = [];
    for (const periodId of orderedPeriodIds) {
        await lockPayrollPeriod(tx, tenantId, periodId);
        const periods = await tx.$queryRaw<Array<LockedPayrollPeriodWindow & { status: string }>>`
            SELECT "id", "startsAt", "endsAt", "status"::text AS "status"
            FROM "PayrollPeriod"
            WHERE "id" = ${periodId} AND "tenantId" = ${tenantId}
            FOR UPDATE
        `;
        if (periods.length !== 1) {
            throw new ConflictException('Payroll period changed while the time card was being updated.');
        }
        if (periods[0].status === 'LOCKED') {
            throw new ConflictException('This time card belongs to a locked payroll period and cannot be changed.');
        }
        lockedPeriods.push(periods[0]);
    }
    await tx.$queryRaw`
        SELECT "id"
        FROM "TimeCard"
        WHERE "id" = ${timeCardId} AND "tenantId" = ${tenantId}
        FOR UPDATE
    `;
    await tx.$queryRaw`
        SELECT "id"
        FROM "TimeCardBreak"
        WHERE "timeCardId" = ${timeCardId} AND "tenantId" = ${tenantId}
        ORDER BY "id" ASC
        FOR UPDATE
    `;
    return lockedPeriods;
}

export function assertClockOutWithinPayrollPeriod(
    payrollPeriodId: string | null,
    clockOutAt: Date,
    periods: LockedPayrollPeriodWindow[],
): void {
    if (!payrollPeriodId) return;
    const period = periods.find((candidate) => candidate.id === payrollPeriodId);
    if (!period) {
        throw new ConflictException('The assigned payroll period changed while the time card was being closed.');
    }
    if (clockOutAt > period.endsAt) {
        throw new ConflictException('Clock out cannot cross the assigned payroll period cutoff.');
    }
}

export function isPayrollLockConstraint(error: unknown): boolean {
    if (error instanceof Error && error.message.includes('payroll_period_locked')) return true;
    try {
        return JSON.stringify(error).includes('payroll_period_locked');
    } catch {
        return false;
    }
}
