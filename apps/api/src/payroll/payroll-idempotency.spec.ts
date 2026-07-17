import { describe, expect, it } from 'vitest';

import {
    canonicalSha256,
    deterministicPayrollId,
    normalizePayrollIdempotencyKey,
    payrollRequestIdentity,
} from './payroll-idempotency';

describe('payroll request identity', () => {
    it('keeps operation identity stable while request drift changes the request hash', () => {
        const base = {
            tenantId: 'tenant-1', actorUserId: 'manager-1', operation: 'LOCK' as const, idempotencyKey: 'key-1',
        };
        const left = payrollRequestIdentity({ ...base, body: { expectedRevision: 1 } });
        const right = payrollRequestIdentity({ ...base, body: { expectedRevision: 2 } });
        expect(left.operationId).toBe(right.operationId);
        expect(left.requestHash).not.toBe(right.requestHash);
    });

    it('binds request hashes to tenant, actor, operation, and canonical body order', () => {
        expect(canonicalSha256({ b: 2, a: 1 })).toBe(canonicalSha256({ a: 1, b: 2 }));
        const one = payrollRequestIdentity({
            tenantId: 'tenant-1', actorUserId: 'manager-1', operation: 'EXPORT', idempotencyKey: 'key', body: {},
        });
        const other = payrollRequestIdentity({
            tenantId: 'tenant-2', actorUserId: 'manager-1', operation: 'EXPORT', idempotencyKey: 'key', body: {},
        });
        expect(one.operationId).not.toBe(other.operationId);
        expect(deterministicPayrollId('batch', one.operationId)).toBe(deterministicPayrollId('batch', one.operationId));
    });

    it('rejects missing, non-printable, and oversized idempotency keys', () => {
        expect(() => normalizePayrollIdempotencyKey('')).toThrow('required');
        expect(() => normalizePayrollIdempotencyKey('bad\nkey')).toThrow('printable');
        expect(() => normalizePayrollIdempotencyKey('x'.repeat(256))).toThrow('255');
    });
});
