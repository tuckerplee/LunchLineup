import { describe, expect, it } from 'vitest';
import { operationalErrorDiagnostics, operationalErrorLog } from './operational-error';

describe('operational auth error diagnostics', () => {
    it('keeps messages, hosts, commands, and credentials out of diagnostics', () => {
        const secret = 'redis://default:super-secret@private-cache.internal:6379';
        const error = Object.assign(new Error('AUTH failed for ' + secret + ' command=GET session_mfa:sensitive'), {
            code: 'SECRET_' + secret,
        });

        const serialized = operationalErrorLog('auth.redis_cleanup_failed', error, 'request-123');

        expect(serialized).toContain('"event":"auth.redis_cleanup_failed"');
        expect(serialized).toContain('"errorClass":"Error"');
        expect(serialized).toContain('"category":"unknown"');
        expect(serialized).toContain('"correlationId":"request-123"');
        expect(serialized).not.toContain(secret);
        expect(serialized).not.toContain('AUTH failed');
        expect(serialized).not.toContain('session_mfa');
        expect(serialized).not.toContain('SECRET_');
    });

    it('retains a stable operational category for known infrastructure codes', () => {
        const diagnostics = operationalErrorDiagnostics(
            'auth.redis_client_error',
            Object.assign(new Error('sensitive provider text'), { code: 'ECONNREFUSED' }),
            'unsafe correlation with spaces and secret=abc',
        );

        expect(diagnostics).toEqual({
            event: 'auth.redis_client_error',
            errorClass: 'Error',
            category: 'connectivity',
            code: 'ECONNREFUSED',
        });
    });
});