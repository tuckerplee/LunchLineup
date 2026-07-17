import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';

export type PayrollOperationName =
    | 'POLICY_CREATE'
    | 'PERIOD_CREATE'
    | 'ADOPT'
    | 'REVIEW'
    | 'APPROVAL'
    | 'LOCK'
    | 'AMENDMENT_CREATE'
    | 'AMENDMENT_DECISION'
    | 'EXPORT'
    | 'RECONCILE';

export function normalizePayrollIdempotencyKey(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new BadRequestException('Idempotency-Key header is required.');
    }
    const key = value.trim();
    if (key.length > 255 || /[^\x20-\x7E]/.test(key)) {
        throw new BadRequestException('Idempotency-Key must be 255 printable characters or fewer.');
    }
    return key;
}

export function payrollRequestIdentity(args: {
    tenantId: string;
    actorUserId: string;
    operation: PayrollOperationName;
    idempotencyKey: string;
    body: unknown;
}): { operationId: string; requestHash: string } {
    const scope = {
        actorUserId: args.actorUserId,
        idempotencyKey: args.idempotencyKey,
        operation: args.operation,
        tenantId: args.tenantId,
    };
    return {
        operationId: `payroll-${args.operation.toLowerCase().replace(/_/g, '-')}-${canonicalSha256(scope)}`,
        requestHash: canonicalSha256({
            actorUserId: args.actorUserId,
            body: args.body,
            operation: args.operation,
            tenantId: args.tenantId,
        }),
    };
}

export function childPayrollOperationId(parentOperationId: string, discriminator: string): string {
    return `payroll-child-${canonicalSha256({ discriminator, parentOperationId })}`;
}

export function deterministicPayrollId(prefix: 'batch' | 'line', value: unknown): string {
    return `payroll_${prefix}_${canonicalSha256({ prefix, value }).slice(0, 40)}`;
}

export function canonicalSha256(value: unknown): string {
    return createHash('sha256')
        .update(JSON.stringify(canonicalJsonValue(value)), 'utf8')
        .digest('hex');
}

export function canonicalJsonValue(value: unknown): unknown {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map((entry) => canonicalJsonValue(entry));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .filter(([, entry]) => entry !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
    );
}
