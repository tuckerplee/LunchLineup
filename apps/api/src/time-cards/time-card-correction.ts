import { BadRequestException } from '@nestjs/common';

const UTC_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?Z$/;
const MAX_CORRECTION_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_BREAK_INTERVALS = 24;

export type TimeCardBreakInput = {
    startAt?: string;
    endAt?: string;
};

export type TimeCardCorrectionBody = {
    clockInAt?: string;
    clockOutAt?: string | null;
    breakIntervals?: TimeCardBreakInput[];
    expectedUpdatedAt?: string;
    reason?: string;
};

export type StoredTimeCardBreak = {
    id?: string;
    startAt: Date | string;
    endAt: Date | string;
};

export type CorrectableTimeCard = {
    clockInAt: Date | string;
    clockOutAt?: Date | string | null;
    breakMinutes?: number | null;
    updatedAt: Date | string;
    breaks?: StoredTimeCardBreak[];
};

export type ValidatedTimeCardCorrection = {
    clockInAt: Date;
    clockOutAt: Date | null;
    breakIntervals: Array<{ startAt: Date; endAt: Date }> | null;
    breakMinutes: number;
    expectedUpdatedAt: Date;
    reason: string;
    status: 'OPEN' | 'CLOSED';
};

export function validateTimeCardCorrection(
    body: TimeCardCorrectionBody,
    current: CorrectableTimeCard,
    now = new Date(),
): ValidatedTimeCardCorrection {
    const reason = requiredReason(body.reason);
    const expectedUpdatedAt = parseUtcInstant(body.expectedUpdatedAt, 'expectedUpdatedAt');
    const hasClockIn = hasOwn(body, 'clockInAt');
    const hasClockOut = hasOwn(body, 'clockOutAt');
    const hasBreakIntervals = hasOwn(body, 'breakIntervals');
    if (!hasClockIn && !hasClockOut && !hasBreakIntervals) {
        throw new BadRequestException('Provide at least one time-card field to correct.');
    }

    const clockInAt = hasClockIn
        ? parseUtcInstant(body.clockInAt, 'clockInAt')
        : requiredStoredDate(current.clockInAt, 'clockInAt');
    const clockOutAt = hasClockOut
        ? nullableUtcInstant(body.clockOutAt, 'clockOutAt')
        : optionalStoredDate(current.clockOutAt, 'clockOutAt');
    const currentBreakMinutes = normalizeStoredBreakMinutes(current.breakMinutes);

    assertCorrectionWindow(clockInAt, clockOutAt, now);
    const normalizedBreakIntervals = hasBreakIntervals
        ? validateBreakIntervals(body.breakIntervals, clockInAt, clockOutAt, now)
        : validateStoredBreakIntervals(current.breaks, clockInAt, clockOutAt, now);
    const normalizedBreakMinutes = normalizedBreakIntervals
        .reduce((total, interval) => total + durationMinutes(interval.startAt, interval.endAt), 0);
    if (!hasBreakIntervals && normalizedBreakIntervals.length > 0 && normalizedBreakMinutes !== currentBreakMinutes) {
        throw new BadRequestException('Stored break intervals do not match aggregate break minutes.');
    }
    const breakIntervals = hasBreakIntervals ? normalizedBreakIntervals : null;
    const breakMinutes = hasBreakIntervals ? normalizedBreakMinutes : currentBreakMinutes;
    const effectiveEnd = clockOutAt ?? now;
    const grossMinutes = Math.floor((effectiveEnd.getTime() - clockInAt.getTime()) / 60_000);
    if (breakMinutes > 0 && breakMinutes >= grossMinutes) {
        throw new BadRequestException('Break time must be less than the time-card window.');
    }

    return {
        clockInAt,
        clockOutAt,
        breakIntervals,
        breakMinutes,
        expectedUpdatedAt,
        reason,
        status: clockOutAt ? 'CLOSED' : 'OPEN',
    };
}

export function timeCardAuditValue(card: any) {
    return {
        targetUserId: card.userId,
        locationId: card.locationId ?? null,
        shiftId: card.shiftId ?? null,
        clockInAt: toAuditIso(card.clockInAt),
        clockOutAt: toAuditIso(card.clockOutAt),
        breakMinutes: card.breakMinutes ?? 0,
        breakIntervals: timeCardBreakAuditValue(card.breaks),
        status: card.status,
    };
}
export function parseUtcInstant(value: unknown, field: string): Date {
    if (typeof value !== 'string' || !value.trim()) {
        throw new BadRequestException(`${field} is required`);
    }
    const normalized = value.trim();
    const match = UTC_INSTANT_RE.exec(normalized);
    if (!match) {
        throw new BadRequestException(`Invalid ${field}. Use UTC ISO 8601.`);
    }
    const parsed = new Date(normalized);
    if (!isValidUtcInstant(parsed, match)) {
        throw new BadRequestException(`Invalid ${field}. Use UTC ISO 8601.`);
    }
    return parsed;
}

export function timeCardBreakAuditValue(breaks: StoredTimeCardBreak[] | null | undefined) {
    return (breaks ?? []).map((interval) => ({
        startAt: requiredStoredDate(interval.startAt, 'break start').toISOString(),
        endAt: requiredStoredDate(interval.endAt, 'break end').toISOString(),
    }));
}

function toAuditIso(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    return new Date(value).toISOString();
}
function validateBreakIntervals(
    value: unknown,
    clockInAt: Date,
    clockOutAt: Date | null,
    now: Date,
): Array<{ startAt: Date; endAt: Date }> {
    if (!Array.isArray(value)) {
        throw new BadRequestException('breakIntervals must be an array.');
    }
    const intervals = value.map((raw, index) => {
        if (!raw || typeof raw !== 'object') {
            throw new BadRequestException(`Break ${index + 1} must include startAt and endAt.`);
        }
        const interval = raw as TimeCardBreakInput;
        return {
            startAt: parseUtcInstant(interval.startAt, `breakIntervals[${index}].startAt`),
            endAt: parseUtcInstant(interval.endAt, `breakIntervals[${index}].endAt`),
        };
    });
    return validateNormalizedBreakIntervals(intervals, clockInAt, clockOutAt, now);
}

function validateStoredBreakIntervals(
    value: StoredTimeCardBreak[] | null | undefined,
    clockInAt: Date,
    clockOutAt: Date | null,
    now: Date,
): Array<{ startAt: Date; endAt: Date }> {
    const intervals = (value ?? []).map((interval) => ({
        startAt: requiredStoredDate(interval.startAt, 'break start'),
        endAt: requiredStoredDate(interval.endAt, 'break end'),
    }));
    return validateNormalizedBreakIntervals(intervals, clockInAt, clockOutAt, now);
}

function validateNormalizedBreakIntervals(
    intervals: Array<{ startAt: Date; endAt: Date }>,
    clockInAt: Date,
    clockOutAt: Date | null,
    now: Date,
): Array<{ startAt: Date; endAt: Date }> {
    if (intervals.length > MAX_BREAK_INTERVALS) {
        throw new BadRequestException(`A time card cannot contain more than ${MAX_BREAK_INTERVALS} break intervals.`);
    }
    const cardEnd = clockOutAt ?? now;
    let previousEnd: Date | null = null;
    intervals.forEach(({ startAt, endAt }, index) => {
        if (endAt <= startAt) {
            throw new BadRequestException(`Break ${index + 1} must end after it starts.`);
        }
        if ((endAt.getTime() - startAt.getTime()) % 60_000 !== 0) {
            throw new BadRequestException(`Break ${index + 1} must use whole-minute boundaries.`);
        }
        if (startAt < clockInAt || endAt > cardEnd) {
            throw new BadRequestException(`Break ${index + 1} must be inside the time-card window.`);
        }
        if (previousEnd && startAt < previousEnd) {
            throw new BadRequestException('Break intervals must be chronological and cannot overlap.');
        }
        previousEnd = endAt;
    });
    return intervals;
}

function assertCorrectionWindow(clockInAt: Date, clockOutAt: Date | null, now: Date): void {
    const latestAllowed = now.getTime() + MAX_FUTURE_SKEW_MS;
    if (clockInAt.getTime() > latestAllowed || (clockOutAt && clockOutAt.getTime() > latestAllowed)) {
        throw new BadRequestException('Corrected timestamps cannot be more than five minutes in the future.');
    }
    const effectiveEnd = clockOutAt ?? now;
    if (effectiveEnd <= clockInAt) {
        throw new BadRequestException('Clock out must be after clock in.');
    }
    if (effectiveEnd.getTime() - clockInAt.getTime() > MAX_CORRECTION_WINDOW_MS) {
        throw new BadRequestException('A corrected time card cannot span more than 31 days.');
    }
}

function requiredReason(value: unknown): string {
    if (typeof value !== 'string') {
        throw new BadRequestException('A correction reason is required.');
    }
    const reason = value.trim();
    if (reason.length < 5 || reason.length > 500) {
        throw new BadRequestException('Correction reason must be between 5 and 500 characters.');
    }
    return reason;
}

function nullableUtcInstant(value: unknown, field: string): Date | null {
    if (value === null) return null;
    return parseUtcInstant(value, field);
}

function optionalStoredDate(value: Date | string | null | undefined, field: string): Date | null {
    return value == null ? null : requiredStoredDate(value, field);
}

function requiredStoredDate(value: Date | string, field: string): Date {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
        throw new BadRequestException(`Stored ${field} is invalid.`);
    }
    return date;
}

function normalizeStoredBreakMinutes(value: number | null | undefined): number {
    const minutes = Number(value ?? 0);
    if (!Number.isInteger(minutes) || minutes < 0) {
        throw new BadRequestException('Stored break minutes are invalid.');
    }
    return minutes;
}

function durationMinutes(startAt: Date, endAt: Date): number {
    return (endAt.getTime() - startAt.getTime()) / 60_000;
}

function isValidUtcInstant(parsed: Date, match: RegExpExecArray): boolean {
    return Number.isFinite(parsed.getTime())
        && parsed.getUTCFullYear() === Number(match[1])
        && parsed.getUTCMonth() === Number(match[2]) - 1
        && parsed.getUTCDate() === Number(match[3])
        && parsed.getUTCHours() === Number(match[4])
        && parsed.getUTCMinutes() === Number(match[5])
        && parsed.getUTCSeconds() === Number(match[6] ?? 0);
}

function hasOwn(value: object, field: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, field);
}
