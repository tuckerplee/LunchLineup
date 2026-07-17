import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';

export type SetupShiftIdentity = {
    shiftId?: string;
    userId?: string | null;
    startTime: string;
    endTime: string;
};

export type SetupShiftsIdentity = {
    locationId: string;
    rows: SetupShiftIdentity[];
};

export function normalizeSetupShiftsIdempotencyKey(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new BadRequestException('Idempotency-Key header is required for setup shift persistence.');
    }
    const key = value.trim();
    if (key.length > 255 || /[^\x20-\x7E]/.test(key)) {
        throw new BadRequestException('Idempotency-Key must be 255 printable characters or fewer.');
    }
    return key;
}

export function setupShiftsOperationId(tenantId: string, key: string): string {
    return createHash('sha256')
        .update(`lunch-break-setup-shifts:${tenantId}:${key}`, 'utf8')
        .digest('hex');
}

export function setupShiftsNeedsSemanticReplay(request: SetupShiftsIdentity): boolean {
    return request.rows.some((row) => row.shiftId === undefined && (row.userId === undefined || row.userId === null));
}

export function setupShiftsSemanticOperationId(tenantId: string, requestHash: string): string {
    return createHash('sha256')
        .update(`lunch-break-setup-shifts-semantic:${tenantId}:${requestHash}`, 'utf8')
        .digest('hex');
}

export function setupShiftsRequestHash(request: SetupShiftsIdentity): string {
    const canonicalRequest = {
        locationId: request.locationId,
        rows: request.rows.map((row) => ({
            ...(row.shiftId === undefined ? {} : { shiftId: row.shiftId }),
            ...(row.shiftId === undefined && (row.userId === undefined || row.userId === null)
                ? { userId: null }
                : row.userId === undefined
                    ? {}
                    : { userId: row.userId }),
            startTime: row.startTime,
            endTime: row.endTime,
        })),
    };
    return createHash('sha256')
        .update(JSON.stringify(canonicalRequest), 'utf8')
        .digest('hex');
}
