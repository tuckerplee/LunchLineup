import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';

export function normalizeTimeCardIdempotencyKey(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new BadRequestException('Idempotency-Key header is required for clock-in requests.');
    }

    const key = value.trim();
    if (key.length > 255 || /[\u0000-\u001f\u007f]/.test(key)) {
        throw new BadRequestException('Idempotency-Key must be 255 printable characters or fewer.');
    }
    return key;
}

export function timeCardClockInOperationId(tenantId: string, idempotencyKey: string): string {
    return createHash('sha256')
        .update(`${tenantId}:${idempotencyKey}`, 'utf8')
        .digest('hex');
}

export function timeCardClockInRequestHash(request: {
    actorUserId: string;
    targetUserId: string;
    locationId: string | null;
    shiftId: string | null;
    clockInAt: string | null;
    notes: string | null;
}): string {
    return createHash('sha256')
        .update(JSON.stringify(request), 'utf8')
        .digest('hex');
}
