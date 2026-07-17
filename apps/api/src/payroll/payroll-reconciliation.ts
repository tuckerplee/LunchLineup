import { BadRequestException } from '@nestjs/common';

import { canonicalSha256 } from './payroll-idempotency';

export const MAX_RECONCILIATION_OUTCOMES = 500;
export type ReconciliationLineStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED';

export type NormalizedReconciliation = {
    provider: string;
    providerEventId: string;
    providerTotalMinutes: number;
    outcomes: Array<{
        lineId: string;
        status: ReconciliationLineStatus;
        reason: string | null;
    }>;
};

export function normalizeReconciliation(value: unknown): NormalizedReconciliation {
    const body = requiredRecord(value, 'Reconciliation request is required.');
    const provider = boundedText(body.provider, 'provider', 100);
    const providerEventId = boundedText(body.providerEventId, 'providerEventId', 200);
    if (!Number.isSafeInteger(body.providerTotalMinutes)) {
        throw new BadRequestException('providerTotalMinutes must be an integer.');
    }
    if (!Array.isArray(body.outcomes) || body.outcomes.length < 1 || body.outcomes.length > MAX_RECONCILIATION_OUTCOMES) {
        throw new BadRequestException(
            `outcomes must contain between 1 and ${MAX_RECONCILIATION_OUTCOMES} items.`,
        );
    }
    const outcomes: NormalizedReconciliation['outcomes'] = body.outcomes.map((entry, index) => {
        const outcome = requiredRecord(entry, `outcomes[${index}] is invalid.`);
        const lineId = boundedText(outcome.lineId, `outcomes[${index}].lineId`, 200);
        const status = outcome.status;
        if (status !== 'PENDING' && status !== 'ACCEPTED' && status !== 'REJECTED') {
            throw new BadRequestException(`outcomes[${index}].status is invalid.`);
        }
        return {
            lineId,
            status: status as ReconciliationLineStatus,
            reason: optionalText(outcome.reason, `outcomes[${index}].reason`, 500),
        };
    }).sort((left, right) => compareText(left.lineId, right.lineId));
    if (new Set(outcomes.map((outcome) => outcome.lineId)).size !== outcomes.length) {
        throw new BadRequestException('outcomes must not repeat line IDs.');
    }
    return {
        provider,
        providerEventId,
        providerTotalMinutes: Number(body.providerTotalMinutes),
        outcomes,
    };
}

export function reconciliationPayloadSha256(args: {
    tenantId: string;
    actorUserId: string;
    batchId: string;
    payload: NormalizedReconciliation;
}): string {
    return canonicalSha256({
        actorUserId: args.actorUserId,
        body: args.payload,
        operation: 'RECONCILE',
        batchId: args.batchId,
        tenantId: args.tenantId,
    });
}

export function reconciliationCounts(payload: NormalizedReconciliation): {
    acceptedCount: number;
    rejectedCount: number;
    pendingCount: number;
} {
    return {
        acceptedCount: payload.outcomes.filter((outcome) => outcome.status === 'ACCEPTED').length,
        rejectedCount: payload.outcomes.filter((outcome) => outcome.status === 'REJECTED').length,
        pendingCount: payload.outcomes.filter((outcome) => outcome.status === 'PENDING').length,
    };
}

function boundedText(value: unknown, field: string, maximum: number): string {
    if (typeof value !== 'string') throw new BadRequestException(`${field} is required.`);
    const normalized = value.trim();
    if (!normalized || normalized.length > maximum || /[\u0000-\u001F\u007F]/.test(normalized)) {
        throw new BadRequestException(`${field} is invalid.`);
    }
    return normalized;
}

function optionalText(value: unknown, field: string, maximum: number): string | null {
    if (value === undefined || value === null || value === '') return null;
    return boundedText(value, field, maximum);
}

function requiredRecord(value: unknown, message: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new BadRequestException(message);
    }
    return value as Record<string, unknown>;
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
