import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';

export type ShiftUpdateIdentity = {
    shiftId: string;
    userId?: string | null;
    startTime?: string;
    endTime?: string;
    role?: string | null;
};

export function normalizeShiftUpdateIdempotencyKey(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new BadRequestException('Idempotency-Key header is required for shift updates.');
    }
    const key = value.trim();
    if (key.length > 255 || /[^\x20-\x7E]/.test(key)) {
        throw new BadRequestException('Idempotency-Key must be 255 printable characters or fewer.');
    }
    return key;
}

export function shiftUpdateOperationId(tenantId: string, key: string): string {
    return createHash('sha256')
        .update(`shift-update:${tenantId}:${key}`, 'utf8')
        .digest('hex');
}

export function shiftUpdateRequestHash(request: ShiftUpdateIdentity): string {
    const canonicalRequest = {
        shiftId: request.shiftId,
        ...(request.userId === undefined ? {} : { userId: request.userId }),
        ...(request.startTime === undefined ? {} : { startTime: request.startTime }),
        ...(request.endTime === undefined ? {} : { endTime: request.endTime }),
        ...(request.role === undefined ? {} : { role: request.role }),
    };
    return createHash('sha256')
        .update(JSON.stringify(canonicalRequest), 'utf8')
        .digest('hex');
}
