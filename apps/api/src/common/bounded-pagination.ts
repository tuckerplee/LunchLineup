import { BadRequestException } from '@nestjs/common';

const UTC_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?Z$/;

export const DEFAULT_BOUNDED_LIST_LIMIT = 100;
export const MAX_BOUNDED_LIST_LIMIT = 200;

export type BoundedListCursor = {
    timestamp: Date;
    id: string;
};

export type BoundedListWindow = {
    startDate?: Date;
    endDate?: Date;
};

export type BoundedPagination = {
    limit: number;
    maxLimit: number;
    returned: number;
    hasMore: boolean;
    nextCursor: string | null;
    window: {
        startDate: string | null;
        endDate: string | null;
    };
};

export function parseBoundedListLimit(value: unknown): number {
    if (value === undefined || value === null || value === '') return DEFAULT_BOUNDED_LIST_LIMIT;
    const normalized = typeof value === 'number' ? String(value) : String(value).trim();
    if (!/^\d+$/.test(normalized)) {
        throw new BadRequestException('Invalid limit. Use a positive integer.');
    }
    const limit = Number(normalized);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BOUNDED_LIST_LIMIT) {
        throw new BadRequestException(`Invalid limit. Use 1 through ${MAX_BOUNDED_LIST_LIMIT}.`);
    }
    return limit;
}

export function parseOptionalBoundedDate(value: unknown, field: string): Date | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string') {
        throw new BadRequestException(`Invalid ${field}. Use UTC ISO 8601.`);
    }
    const normalized = value.trim();
    const match = UTC_INSTANT_RE.exec(normalized);
    const parsed = new Date(normalized);
    if (!match || !isValidUtcInstant(parsed, match)) {
        throw new BadRequestException(`Invalid ${field}. Use UTC ISO 8601.`);
    }
    return parsed;
}

export function assertBoundedListWindow(window: BoundedListWindow): void {
    if (window.startDate && window.endDate && window.endDate <= window.startDate) {
        throw new BadRequestException('endDate must be after startDate.');
    }
}

export function encodeBoundedListCursor(timestamp: Date, id: string): string {
    if (!Number.isFinite(timestamp.getTime()) || typeof id !== 'string' || !id || id.length > 200) {
        throw new BadRequestException('Cannot create pagination cursor.');
    }
    return Buffer.from(JSON.stringify({
        v: 1,
        timestamp: timestamp.toISOString(),
        id,
    }), 'utf8').toString('base64url');
}

export function decodeBoundedListCursor(value: unknown): BoundedListCursor | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' || value.length > 512) {
        throw new BadRequestException('Invalid cursor.');
    }
    try {
        const payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
            v?: unknown;
            timestamp?: unknown;
            id?: unknown;
        };
        if (payload.v !== 1 || typeof payload.timestamp !== 'string' || typeof payload.id !== 'string') {
            throw new Error('Invalid payload');
        }
        const timestamp = new Date(payload.timestamp);
        if (
            !Number.isFinite(timestamp.getTime())
            || timestamp.toISOString() !== payload.timestamp
            || !payload.id
            || payload.id.length > 200
        ) {
            throw new Error('Invalid payload');
        }
        return { timestamp, id: payload.id };
    } catch {
        throw new BadRequestException('Invalid cursor.');
    }
}

export function buildBoundedListPage<T extends { id: string }>(
    rows: T[],
    limit: number,
    timestamp: (row: T) => Date,
    window: BoundedListWindow,
): { data: T[]; pagination: BoundedPagination } {
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const last = hasMore ? data.at(-1) : undefined;
    return {
        data,
        pagination: {
            limit,
            maxLimit: MAX_BOUNDED_LIST_LIMIT,
            returned: data.length,
            hasMore,
            nextCursor: last ? encodeBoundedListCursor(timestamp(last), last.id) : null,
            window: {
                startDate: window.startDate?.toISOString() ?? null,
                endDate: window.endDate?.toISOString() ?? null,
            },
        },
    };
}

function isValidUtcInstant(date: Date, match: RegExpExecArray): boolean {
    return Number.isFinite(date.getTime())
        && date.getUTCFullYear() === Number(match[1])
        && date.getUTCMonth() === Number(match[2]) - 1
        && date.getUTCDate() === Number(match[3])
        && date.getUTCHours() === Number(match[4])
        && date.getUTCMinutes() === Number(match[5])
        && date.getUTCSeconds() === Number(match[6] ?? 0);
}
