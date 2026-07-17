import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';

export type ShiftBreakUpdateIdentity = {
    locationId: string;
    breaks: Array<{
        type: 'break1' | 'lunch' | 'break2';
        startTime?: string;
        durationMinutes?: number;
        skip: boolean;
    }>;
};

export function normalizeShiftBreakUpdateIdempotencyKey(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new BadRequestException('Idempotency-Key header is required for shift lunch/break replacement.');
    }
    const key = value.trim();
    if (key.length > 255 || /[^\x20-\x7E]/.test(key)) {
        throw new BadRequestException('Idempotency-Key must be 255 printable characters or fewer.');
    }
    return key;
}

export function shiftBreakUpdateOperationId(tenantId: string, shiftId: string, key: string): string {
    return createHash('sha256')
        .update(`lunch-break-shift-update:${tenantId}:${shiftId}:${key}`, 'utf8')
        .digest('hex');
}

export function shiftBreakUpdateRequestHash(request: ShiftBreakUpdateIdentity): string {
    const canonicalRequest = {
        locationId: request.locationId,
        breaks: [...request.breaks]
            .sort((left, right) => left.type.localeCompare(right.type))
            .map((entry) => entry.skip
                ? { type: entry.type, skip: true }
                : {
                    type: entry.type,
                    startTime: entry.startTime,
                    ...(entry.durationMinutes === undefined ? {} : { durationMinutes: entry.durationMinutes }),
                    skip: false,
                }),
    };
    return createHash('sha256')
        .update(JSON.stringify(canonicalRequest), 'utf8')
        .digest('hex');
}
