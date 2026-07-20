import { Prisma } from '@prisma/client';
import type { TenantTransaction } from '../platform/database';
import { ProblemError } from '../platform/problem';

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
  transaction: TenantTransaction,
  tenantId: string,
  clockInAt: Date,
  location: { id: string; timezone: string } | null,
): Promise<TimeCardPayrollAssignment> {
  let policy: { id: string; version: number; timeZone: string; effectiveFrom: Date } | undefined;
  let cursorId: string | undefined;
  do {
    const policies = await transaction.payrollPolicyVersion.findMany({
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
    cursorId = policies.at(-1)?.id;
  } while (cursorId);

  if (!policy) return { payrollPeriodId: null, workTimeZone: location?.timezone ?? 'UTC' };
  if (!location) {
    throw new ProblemError(422, 'time_card_location_required', 'Payroll-enabled time cards require a location.', 'Time-card validation failed');
  }
  const period = await transaction.payrollPeriod.findFirst({
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
    throw new ProblemError(409, 'no_open_payroll_period', 'No open payroll period covers this clock-in time.', 'Payroll period unavailable');
  }
  await lockPayrollTenant(transaction, tenantId);
  await lockPayrollPeriod(transaction, tenantId, period.id);
  const current = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "PayrollPeriod"
    WHERE "id" = ${period.id}
      AND "tenantId" = ${tenantId}
      AND "policyVersionId" = ${policy.id}
      AND "status" = 'OPEN'::"PayrollPeriodStatus"
      AND "startsAt" <= ${clockInAt}
      AND "endsAt" > ${clockInAt}
    FOR UPDATE
  `);
  if (current.length !== 1) {
    throw new ProblemError(409, 'payroll_period_changed', 'The payroll period changed while this time card was being created.', 'Concurrent change');
  }
  return { payrollPeriodId: period.id, workTimeZone: location.timezone };
}

export async function lockTimeCardPayrollContext(
  transaction: TenantTransaction,
  tenantId: string,
  timeCardId: string,
  periodIds: Array<string | null | undefined>,
): Promise<LockedPayrollPeriodWindow[]> {
  await transaction.$executeRaw`SET LOCAL lock_timeout = '5s'`;
  await lockPayrollTenant(transaction, tenantId);
  const orderedPeriodIds = [...new Set(periodIds.filter((value): value is string => Boolean(value)))].sort();
  const locked: LockedPayrollPeriodWindow[] = [];
  for (const periodId of orderedPeriodIds) {
    await lockPayrollPeriod(transaction, tenantId, periodId);
    const periods = await transaction.$queryRaw<Array<LockedPayrollPeriodWindow & { status: string }>>(Prisma.sql`
      SELECT "id", "startsAt", "endsAt", "status"::text AS "status"
      FROM "PayrollPeriod"
      WHERE "id" = ${periodId} AND "tenantId" = ${tenantId}
      FOR UPDATE
    `);
    if (periods.length !== 1) {
      throw new ProblemError(409, 'payroll_period_changed', 'The payroll period changed while this time card was being updated.', 'Concurrent change');
    }
    if (periods[0].status === 'LOCKED') {
      throw new ProblemError(409, 'payroll_period_locked', 'This time card belongs to a locked payroll period and cannot be changed.', 'Payroll period locked');
    }
    locked.push(periods[0]);
  }
  await transaction.$queryRaw(Prisma.sql`
    SELECT "id" FROM "TimeCard"
    WHERE "id" = ${timeCardId} AND "tenantId" = ${tenantId}
    FOR UPDATE
  `);
  await transaction.$queryRaw(Prisma.sql`
    SELECT "id" FROM "TimeCardBreak"
    WHERE "timeCardId" = ${timeCardId} AND "tenantId" = ${tenantId}
    ORDER BY "id" ASC
    FOR UPDATE
  `);
  return locked;
}

export function assertClockOutWithinPayrollPeriod(
  payrollPeriodId: string | null,
  clockOutAt: Date,
  periods: LockedPayrollPeriodWindow[],
): void {
  if (!payrollPeriodId) return;
  const period = periods.find((candidate) => candidate.id === payrollPeriodId);
  if (!period) {
    throw new ProblemError(409, 'payroll_period_changed', 'The assigned payroll period changed while this time card was being closed.', 'Concurrent change');
  }
  if (clockOutAt > period.endsAt) {
    throw new ProblemError(409, 'payroll_period_cutoff', 'Clock out cannot cross the assigned payroll period cutoff.', 'Payroll period cutoff');
  }
}

function dateValueInTimeZone(value: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(value);
    const byType = new Map(parts.map((part) => [part.type, part.value]));
    return `${byType.get('year')}-${byType.get('month')}-${byType.get('day')}`;
  } catch {
    throw new ProblemError(500, 'invalid_time_card_timezone', 'A saved time-card location timezone is invalid.', 'Time-card data error');
  }
}

async function lockPayrollTenant(transaction: TenantTransaction, tenantId: string): Promise<void> {
  await transaction.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${`lunchlineup:payroll:${tenantId}`}, 0))
  `;
}

async function lockPayrollPeriod(transaction: TenantTransaction, tenantId: string, periodId: string): Promise<void> {
  await transaction.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${`lunchlineup:payroll:${tenantId}:${periodId}`}, 0))
  `;
}
