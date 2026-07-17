import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';
import type { SchedulePublishAcceptedContract } from './schedule-publish-settlement';

export function normalizeSchedulePublishIdempotencyKey(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new BadRequestException('Idempotency-Key header is required for schedule publication.');
    }
    const key = value.trim();
    if (key.length > 255 || /[^\x20-\x7E]/.test(key)) {
        throw new BadRequestException('Idempotency-Key must be 255 printable characters or fewer.');
    }
    return key;
}

export function schedulePublishOperationId(tenantId: string, scheduleId: string, idempotencyKey: string): string {
    return `schedule-publish-${hashJson({ idempotencyKey, scheduleId, tenantId })}`;
}

export function schedulePublishRequestHash(
    tenantId: string,
    scheduleId: string,
    acceptedContract: SchedulePublishAcceptedContract,
): string {
    return hashJson({ action: 'schedule.publish', acceptedContract, scheduleId, tenantId, version: 2 });
}

function hashJson(value: Record<string, unknown>): string {
    return createHash('sha256')
        .update(JSON.stringify(sortJsonValue(value)), 'utf8')
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
