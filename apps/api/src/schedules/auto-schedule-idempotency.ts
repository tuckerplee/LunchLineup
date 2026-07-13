import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';

export function normalizeAutoScheduleIdempotencyKey(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new BadRequestException('Idempotency-Key header is required for auto-schedule requests.');
    }
    const key = value.trim();
    if (key.length > 255 || /[\u0000-\u001f\u007f]/.test(key)) {
        throw new BadRequestException('Idempotency-Key must be 255 printable characters or fewer.');
    }
    return key;
}

export function hashAutoScheduleIdempotencyKey(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function autoScheduleRequestHash(
    constraints: Record<string, unknown>,
    confirmReplace: boolean,
): string {
    return createHash('sha256')
        .update(JSON.stringify(sortJsonValue({ confirmReplace, constraints })), 'utf8')
        .digest('hex');
}

function sortJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((entry) => sortJsonValue(entry));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => [key, sortJsonValue(entry)]),
    );
}
