import { ConflictException } from '@nestjs/common';

export type ShiftBreakWindow = {
    id: string;
    startTime: Date;
    endTime: Date;
};

const BREAK_RESIZE_CONFLICT =
    'The resized shift would place an existing lunch/break outside the shift window. Move the breaks first or choose a larger shift window.';
const DATABASE_INVARIANT_CONFLICT =
    'The shift changed concurrently or would violate a schedule, assignment, or break invariant. Refresh and retry.';
const DATABASE_INVARIANT_MARKERS = [
    'shift_window_valid',
    'shift_assigned_no_overlap',
    'shift_within_schedule_window',
    'shift_break_windows',
    'break_window_valid',
    'break_no_overlap',
    'break_within_shift_window',
    'must stay within its shift window',
    'cannot move outside one of its break windows',
    'must stay within schedule',
];

export function assertShiftUpdateWindow(startTime: Date, endTime: Date): void {
    if (endTime <= startTime) {
        throw new ConflictException('Shift end time must be after start time.');
    }
}

export function assertShiftUpdateWithinSchedule(
    startTime: Date,
    endTime: Date,
    schedule: { startDate: Date; endDate: Date },
): void {
    if (!(schedule.startDate instanceof Date) || !(schedule.endDate instanceof Date)) {
        throw new ConflictException('Schedule window is invalid.');
    }
    if (startTime < schedule.startDate || endTime > schedule.endDate) {
        throw new ConflictException('Shift must stay within its schedule window.');
    }
}

export function translateShiftBreakWindows(
    rows: ShiftBreakWindow[],
    previousStartTime: Date,
    nextStartTime: Date,
    nextEndTime: Date,
): ShiftBreakWindow[] {
    const deltaMs = nextStartTime.getTime() - previousStartTime.getTime();
    const translated = rows.map((row) => ({
        id: row.id,
        startTime: new Date(row.startTime.getTime() + deltaMs),
        endTime: new Date(row.endTime.getTime() + deltaMs),
    }));
    const ordered = [...translated].sort((left, right) =>
        left.startTime.getTime() - right.startTime.getTime() || left.id.localeCompare(right.id));
    const invalidWindow = ordered.some((row, index) =>
        !Number.isFinite(row.startTime.getTime())
        || !Number.isFinite(row.endTime.getTime())
        || row.endTime <= row.startTime
        || row.startTime < nextStartTime
        || row.endTime > nextEndTime
        || (index > 0 && row.startTime < ordered[index - 1].endTime));
    if (invalidWindow || new Set(ordered.map((row) => row.id)).size !== ordered.length) {
        throw new ConflictException(BREAK_RESIZE_CONFLICT);
    }
    return translated;
}

export function mapShiftUpdateInvariantError(error: unknown): unknown {
    if (error instanceof ConflictException) return error;
    const details = collectErrorDetails(error).toLowerCase();
    if (DATABASE_INVARIANT_MARKERS.some((marker) => details.includes(marker))) {
        return new ConflictException(DATABASE_INVARIANT_CONFLICT);
    }
    return error;
}

function collectErrorDetails(value: unknown, seen = new Set<unknown>(), depth = 0): string {
    if (value === null || value === undefined || depth > 4 || seen.has(value)) return '';
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (typeof value !== 'object') return '';
    seen.add(value);
    const record = value as Record<string, unknown>;
    const details = value instanceof Error ? [value.name, value.message] : [];
    for (const key of ['code', 'constraint', 'message', 'database_error', 'meta', 'cause', 'originalError']) {
        if (key in record) details.push(collectErrorDetails(record[key], seen, depth + 1));
    }
    return details.join(' ');
}
