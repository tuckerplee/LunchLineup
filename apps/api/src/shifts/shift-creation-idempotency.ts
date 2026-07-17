import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';

export type ShiftCreationIdentity = {
    locationId: string;
    scheduleId: string | null;
    userId: string | null;
    startTime: string;
    endTime: string;
    role: string | null;
};

export function normalizeShiftCreationIdempotencyKey(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new BadRequestException('Idempotency-Key header is required for shift creation.');
    }
    const key = value.trim();
    if (key.length > 255 || /[^\x20-\x7E]/.test(key)) {
        throw new BadRequestException('Idempotency-Key must be 255 printable characters or fewer.');
    }
    return key;
}

export function shiftCreationOperationId(tenantId: string, key: string): string {
    return createHash('sha256').update(`${tenantId}:${key}`, 'utf8').digest('hex');
}

export function shiftCreationRequestHash(request: ShiftCreationIdentity): string {
    return createHash('sha256')
        .update(JSON.stringify(request), 'utf8')
        .digest('hex');
}
