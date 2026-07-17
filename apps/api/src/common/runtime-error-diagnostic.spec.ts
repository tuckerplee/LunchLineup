import { describe, expect, it } from 'vitest';
import { runtimeErrorDiagnostic, runtimeErrorText, safeCorrelationId } from './runtime-error-diagnostic';

describe('runtime error diagnostics', () => {
    it('never serializes exception messages, stacks, credentials, or provider payload text', () => {
        const secret = 'postgresql://user:db-secret@private-db/app?token=query-secret';
        const error = Object.assign(
            new Error(`Authorization: Bearer access-secret Cookie: session=session-secret ${secret}`),
            { code: `UNSAFE_${secret}`, providerPayload: { email: 'owner@example.com' } },
        );

        const text = runtimeErrorText(error);

        expect(text).toBe('category=unknown class=Error');
        expect(text).not.toContain('access-secret');
        expect(text).not.toContain('session-secret');
        expect(text).not.toContain('db-secret');
        expect(text).not.toContain('owner@example.com');
        expect(text).not.toContain('UNSAFE_');
    });

    it('retains only allowlisted operational codes and numeric provider status', () => {
        expect(runtimeErrorDiagnostic(Object.assign(new Error('private host'), { code: 'ECONNREFUSED' }))).toEqual({
            category: 'connectivity',
            errorClass: 'Error',
            code: 'ECONNREFUSED',
        });
        expect(runtimeErrorDiagnostic(Object.assign(new Error('private response'), { status: 503 }))).toEqual({
            category: 'unavailable',
            errorClass: 'Error',
            httpStatus: 503,
        });
    });

    it('does not let hostile diagnostic property getters replace the original failure', () => {
        const hostile = Object.create(null, {
            code: { get: () => { throw new Error('code-secret'); } },
            status: { get: () => { throw new Error('status-secret'); } },
        });

        expect(runtimeErrorText(hostile)).toBe('category=unknown class=NonErrorThrow');
    });

    it('accepts only bounded opaque correlation identifiers', () => {
        expect(safeCorrelationId('request-123:abc')).toBe('request-123:abc');
        expect(safeCorrelationId('token=secret value')).toBeUndefined();
        expect(safeCorrelationId('x'.repeat(129))).toBeUndefined();
    });
});
