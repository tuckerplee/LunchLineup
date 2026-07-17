import { BadRequestException } from '@nestjs/common';

import {
    dateValueInTimeZone,
    localDateBoundaryUtc,
    normalizeTimeZone,
} from '../common/location-timezone';

export const PAYROLL_CADENCES = ['WEEKLY', 'BIWEEKLY'] as const;
export type PayrollCadenceValue = (typeof PAYROLL_CADENCES)[number];

export type NormalizedPayrollPolicy = {
    timeZone: string;
    cadence: PayrollCadenceValue;
    anchorDate: string;
    effectiveFrom: string;
};

export type PayrollPeriodBoundaries = {
    localStartDate: string;
    localEndDateExclusive: string;
    startsAt: Date;
    endsAt: Date;
};

export function normalizePayrollPolicy(value: unknown): NormalizedPayrollPolicy {
    const input = requiredRecord(value, 'Payroll policy is required.');
    const rawTimeZone = typeof input.timeZone === 'string' ? input.timeZone.trim() : '';
    if (!rawTimeZone || rawTimeZone.length > 100) {
        throw new BadRequestException('timeZone must be a valid IANA time zone.');
    }
    return {
        timeZone: normalizeTimeZone(rawTimeZone),
        cadence: normalizePayrollCadence(input.cadence),
        anchorDate: normalizeLocalDate(input.anchorDate, 'anchorDate'),
        effectiveFrom: normalizeLocalDate(input.effectiveFrom, 'effectiveFrom'),
    };
}

export function assertFutureEffectiveBoundary(
    policy: NormalizedPayrollPolicy,
    now = new Date(),
): void {
    const today = dateValueInTimeZone(now, policy.timeZone);
    if (policy.effectiveFrom <= today) {
        throw new BadRequestException('effectiveFrom must be a future local date.');
    }
    assertPayrollAnchorAlignment(policy.effectiveFrom, policy.anchorDate, policy.cadence);
}

export function normalizePayrollCadence(value: unknown): PayrollCadenceValue {
    if (typeof value !== 'string' || !PAYROLL_CADENCES.includes(value as PayrollCadenceValue)) {
        throw new BadRequestException('cadence must be WEEKLY or BIWEEKLY.');
    }
    return value as PayrollCadenceValue;
}

export function normalizeLocalDate(value: unknown, field = 'localStartDate'): string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
        throw new BadRequestException(`${field} must use YYYY-MM-DD.`);
    }
    const normalized = value.trim();
    const [year, month, day] = normalized.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
        date.getUTCFullYear() !== year
        || date.getUTCMonth() + 1 !== month
        || date.getUTCDate() !== day
    ) {
        throw new BadRequestException(`${field} must be a valid calendar date.`);
    }
    return normalized;
}

export function payrollPeriodBoundaries(
    localStartDateValue: unknown,
    policy: Pick<NormalizedPayrollPolicy, 'timeZone' | 'cadence' | 'anchorDate'>,
): PayrollPeriodBoundaries {
    const localStartDate = normalizeLocalDate(localStartDateValue);
    assertPayrollAnchorAlignment(localStartDate, policy.anchorDate, policy.cadence);
    const localEndDateExclusive = addLocalDateDays(localStartDate, cadenceDays(policy.cadence));
    return {
        localStartDate,
        localEndDateExclusive,
        startsAt: localDateBoundaryUtc(localStartDate, policy.timeZone),
        endsAt: localDateBoundaryUtc(localEndDateExclusive, policy.timeZone),
    };
}

export function assertPayrollAnchorAlignment(
    localStartDateValue: unknown,
    anchorDateValue: unknown,
    cadenceValue: unknown,
): void {
    const localStartDate = normalizeLocalDate(localStartDateValue);
    const anchorDate = normalizeLocalDate(anchorDateValue, 'anchorDate');
    const cadence = normalizePayrollCadence(cadenceValue);
    const difference = calendarDayNumber(localStartDate) - calendarDayNumber(anchorDate);
    if (positiveModulo(difference, cadenceDays(cadence)) !== 0) {
        throw new BadRequestException('Date must align with the payroll policy anchor and cadence.');
    }
}

export function dateOnlyForPrisma(value: string): Date {
    const normalized = normalizeLocalDate(value);
    return new Date(`${normalized}T00:00:00.000Z`);
}

export function serializeDateOnly(value: Date | string): string {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error('Stored payroll date is invalid.');
    return date.toISOString().slice(0, 10);
}

function cadenceDays(cadence: PayrollCadenceValue): 7 | 14 {
    return cadence === 'WEEKLY' ? 7 : 14;
}

function addLocalDateDays(value: string, days: number): string {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function calendarDayNumber(value: string): number {
    const [year, month, day] = value.split('-').map(Number);
    return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function positiveModulo(value: number, divisor: number): number {
    return ((value % divisor) + divisor) % divisor;
}

function requiredRecord(value: unknown, message: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new BadRequestException(message);
    }
    return value as Record<string, unknown>;
}
