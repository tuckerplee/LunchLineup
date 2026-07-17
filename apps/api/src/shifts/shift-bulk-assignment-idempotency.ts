import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';

export type ShiftBulkAssignmentIdentity = {
    assignments: Array<{
        shiftId: string;
        userId: string | null;
    }>;
};

export function normalizeShiftBulkAssignmentIdempotencyKey(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new BadRequestException('Idempotency-Key header is required for bulk shift assignment.');
    }
    const key = value.trim();
    if (key.length > 255 || /[^\x20-\x7E]/.test(key)) {
        throw new BadRequestException('Idempotency-Key must be 255 printable characters or fewer.');
    }
    return key;
}

export function shiftBulkAssignmentOperationId(tenantId: string, key: string): string {
    return createHash('sha256')
        .update(`shift-bulk-assignment:${tenantId}:${key}`, 'utf8')
        .digest('hex');
}

export function shiftBulkAssignmentRequestHash(request: ShiftBulkAssignmentIdentity): string {
    const canonicalRequest = {
        assignments: request.assignments
            .map((assignment) => ({
                shiftId: assignment.shiftId,
                userId: assignment.userId,
            }))
            .sort((left, right) => left.shiftId < right.shiftId ? -1 : left.shiftId > right.shiftId ? 1 : 0),
    };
    return createHash('sha256')
        .update(JSON.stringify(canonicalRequest), 'utf8')
        .digest('hex');
}
