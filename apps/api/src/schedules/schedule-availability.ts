import { BadRequestException } from '@nestjs/common';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

export type PersistedAvailabilityWindow = {
    dayOfWeek: number;
    startTimeMinutes: number;
    endTimeMinutes: number;
};

export function assertAvailabilityWindow(window: PersistedAvailabilityWindow): void {
    const day = Number(window.dayOfWeek);
    const start = Number(window.startTimeMinutes);
    const end = Number(window.endTimeMinutes);
    if (!Number.isInteger(day) || day < 0 || day > 6) {
        throw new BadRequestException('Invalid availability dayOfWeek. Use 0 through 6.');
    }
    if (
        !Number.isInteger(start)
        || !Number.isInteger(end)
        || start < 0
        || start >= 1440
        || end < 0
        || end >= 1440
        || start === end
    ) {
        throw new BadRequestException('Invalid availability window. Use distinct minute values from 0 to 1439.');
    }
}

export function availabilityDayName(dayOfWeek: number): string {
    const day = Number(dayOfWeek);
    if (!Number.isInteger(day) || day < 0 || day > 6) {
        throw new BadRequestException('Invalid availability dayOfWeek. Use 0 through 6.');
    }
    return WEEKDAYS[day];
}

export function availabilityTime(minutesValue: number, field: string): string {
    const minutes = Number(minutesValue);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes >= 1440) {
        throw new BadRequestException(`Invalid ${field}. Use minutes from 0 to 1439.`);
    }
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function availabilityWindowCoversLocalSegment(
    window: PersistedAvailabilityWindow,
    weekday: string,
    segmentStartMinutes: number,
    segmentEndMinutes: number,
): boolean {
    assertAvailabilityWindow(window);
    const start = Number(window.startTimeMinutes);
    const end = Number(window.endTimeMinutes);
    const day = Number(window.dayOfWeek);
    if (end > start) {
        return availabilityDayName(day) === weekday
            && start <= segmentStartMinutes
            && end >= segmentEndMinutes;
    }
    if (availabilityDayName(day) === weekday) {
        return start <= segmentStartMinutes && segmentEndMinutes <= 1440;
    }
    return availabilityDayName((day + 1) % 7) === weekday
        && segmentStartMinutes >= 0
        && end >= segmentEndMinutes;
}
