import { BadRequestException } from '@nestjs/common';

export const DEFAULT_LOCATION_TIME_ZONE = 'America/New_York';

type ZonedParts = {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
};

export function normalizeTimeZone(value: unknown): string {
    const timeZone = typeof value === 'string' ? value.trim() : '';
    if (!timeZone) return DEFAULT_LOCATION_TIME_ZONE;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
        return timeZone;
    } catch {
        throw new BadRequestException('Location timezone must be a valid IANA timezone.');
    }
}

export function localDateBoundaryUtc(dateValue: string, timeZoneValue: unknown): Date {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
    if (!match) throw new BadRequestException('Date must use YYYY-MM-DD.');
    return zonedDateTimeToUtc({
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
        hour: 0,
        minute: 0,
        second: 0,
    }, normalizeTimeZone(timeZoneValue));
}

export function dateValueInTimeZone(value: Date | string, timeZoneValue: unknown): string {
    const parts = zonedParts(requiredDate(value), normalizeTimeZone(timeZoneValue));
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function weekdayNameInTimeZone(value: Date | string, timeZoneValue: unknown): string {
    return new Intl.DateTimeFormat('en-US', {
        timeZone: normalizeTimeZone(timeZoneValue),
        weekday: 'long',
    }).format(requiredDate(value));
}

export function formatDateInTimeZone(value: Date | string, timeZoneValue: unknown): string {
    return new Intl.DateTimeFormat('en-US', {
        timeZone: normalizeTimeZone(timeZoneValue),
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    }).format(requiredDate(value));
}

export function formatDateTimeInTimeZone(value: Date | string, timeZoneValue: unknown): string {
    const timeZone = normalizeTimeZone(timeZoneValue);
    return `${new Intl.DateTimeFormat('en-US', {
        timeZone,
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    }).format(requiredDate(value))} ${shortTimeZoneName(timeZone, value)}`;
}

export function nextLocalDateBoundaryUtc(value: Date | string, timeZoneValue: unknown): Date {
    const timeZone = normalizeTimeZone(timeZoneValue);
    const dateValue = dateValueInTimeZone(value, timeZone);
    return localDateBoundaryUtc(addDateValues(dateValue, 1), timeZone);
}

export function splitInstantRangeByLocalDay(
    startValue: Date | string,
    endValue: Date | string,
    timeZoneValue: unknown,
): Array<{ weekday: string; startMinutes: number; endMinutes: number }> {
    const timeZone = normalizeTimeZone(timeZoneValue);
    const start = requiredDate(startValue);
    const end = requiredDate(endValue);
    const segments: Array<{ weekday: string; startMinutes: number; endMinutes: number }> = [];
    let cursor = start;
    while (cursor < end) {
        const parts = zonedParts(cursor, timeZone);
        const nextBoundary = localDateBoundaryUtc(addDateValues(
            `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`,
            1,
        ), timeZone);
        const segmentEnd = nextBoundary < end ? nextBoundary : end;
        const endParts = zonedParts(segmentEnd, timeZone);
        const crossesBoundary = segmentEnd.getTime() === nextBoundary.getTime();
        segments.push({
            weekday: weekdayNameInTimeZone(cursor, timeZone),
            startMinutes: parts.hour * 60 + parts.minute,
            endMinutes: crossesBoundary ? 1440 : endParts.hour * 60 + endParts.minute,
        });
        cursor = segmentEnd;
    }
    return segments;
}

function zonedDateTimeToUtc(target: ZonedParts, timeZone: string): Date {
    const targetUtc = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, target.second);
    const calendarCheck = new Date(targetUtc);
    if (
        calendarCheck.getUTCFullYear() !== target.year ||
        calendarCheck.getUTCMonth() + 1 !== target.month ||
        calendarCheck.getUTCDate() !== target.day
    ) {
        throw new BadRequestException('Date is not a valid calendar day.');
    }

    let guess = targetUtc;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const actual = zonedParts(new Date(guess), timeZone);
        const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
        const delta = targetUtc - actualUtc;
        guess += delta;
        if (delta === 0) break;
    }
    const result = new Date(guess);
    const verified = zonedParts(result, timeZone);
    if (Object.keys(target).some((key) => verified[key as keyof ZonedParts] !== target[key as keyof ZonedParts])) {
        throw new BadRequestException('Local date/time does not exist in the location timezone.');
    }
    return result;
}

function zonedParts(value: Date, timeZone: string): ZonedParts {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(value);
    const map = new Map(parts.map((part) => [part.type, part.value]));
    return {
        year: Number(map.get('year')),
        month: Number(map.get('month')),
        day: Number(map.get('day')),
        hour: Number(map.get('hour')),
        minute: Number(map.get('minute')),
        second: Number(map.get('second')),
    };
}

function addDateValues(dateValue: string, days: number): string {
    const [year, month, day] = dateValue.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + days));
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function shortTimeZoneName(timeZone: string, value: Date | string): string {
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
        .formatToParts(requiredDate(value))
        .find((item) => item.type === 'timeZoneName');
    return part?.value ?? timeZone;
}

function requiredDate(value: Date | string): Date {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new BadRequestException('Invalid date/time value.');
    return date;
}

function pad(value: number): string {
    return String(value).padStart(2, '0');
}
