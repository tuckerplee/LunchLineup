import { ArgumentsHost, ConflictException, ForbiddenException, Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProductionExceptionFilter } from './production-exception.filter';

describe('ProductionExceptionFilter', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('does not leak unhandled exception messages', () => {
        const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        const response = mockResponse();
        const host = mockHost(response);
        const filter = new ProductionExceptionFilter();

        filter.catch(new Error('DATABASE_URL=postgresql://user:super-secret@postgres:5432/app?api_key=abc123'), host);

        expect(response.status).toHaveBeenCalledWith(500);
        expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
            statusCode: 500,
            message: 'Internal server error',
            correlationId: 'corr-1',
        }));
        const responseBody = JSON.stringify(response.json.mock.calls[0][0]);
        const logBody = JSON.stringify(logger.mock.calls);
        expect(responseBody).not.toContain('super-secret');
        expect(logBody).not.toContain('super-secret');
        expect(logBody).not.toContain('abc123');
        expect(logBody).toContain('category=unknown class=Error');
    });

    it('sanitizes HttpException messages in production responses', () => {
        const response = mockResponse();
        const host = mockHost(response);
        const filter = new ProductionExceptionFilter();

        filter.catch(new ForbiddenException('tenant secret detail'), host);

        expect(response.status).toHaveBeenCalledWith(403);
        expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
            statusCode: 403,
            error: 'Forbidden',
            message: 'Forbidden',
        }));
        expect(JSON.stringify(response.json.mock.calls[0][0])).not.toContain('tenant secret detail');
    });

    it.each([
        [
            new ForbiddenException({ code: 'SETUP_SHIFTS_ENTITLEMENT_REQUIRED', message: 'private billing detail' }),
            403,
            'SETUP_SHIFTS_ENTITLEMENT_REQUIRED',
            /paid subscription/i,
        ],
        [
            new ConflictException({ code: 'SETUP_SHIFTS_CONFLICT', message: 'private constraint detail' }),
            409,
            'SETUP_SHIFTS_CONFLICT',
            /refresh the selected date/i,
        ],
        [
            new ForbiddenException({ code: 'SHIFT_BREAKS_ENTITLEMENT_REQUIRED', message: 'private wallet detail' }),
            403,
            'SHIFT_BREAKS_ENTITLEMENT_REQUIRED',
            /paid subscription/i,
        ],
        [
            new ConflictException({ code: 'SHIFT_BREAKS_CONFLICT', message: 'private shift detail' }),
            409,
            'SHIFT_BREAKS_CONFLICT',
            /review the shift and breaks/i,
        ],
    ])('emits an allowlisted public code and remediation without exception details', (exception, status, code, remediation) => {
        const response = mockResponse();
        const filter = new ProductionExceptionFilter();

        filter.catch(exception, mockHost(response, '/v1/lunch-breaks/setup-shifts'));

        expect(response.status).toHaveBeenCalledWith(status);
        expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
            statusCode: status,
            code,
            remediation: expect.stringMatching(remediation),
        }));
        expect(JSON.stringify(response.json.mock.calls[0][0])).not.toContain('private');
    });

    it('does not reflect unknown public error codes', () => {
        const response = mockResponse();
        const filter = new ProductionExceptionFilter();

        filter.catch(new ConflictException({ code: 'DATABASE_CONSTRAINT_NAME', message: 'private detail' }), mockHost(response));

        expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
            statusCode: 409,
            message: 'Conflict',
        }));
        expect(response.json.mock.calls[0][0]).not.toHaveProperty('code');
        expect(response.json.mock.calls[0][0]).not.toHaveProperty('remediation');
    });

    it('redacts OAuth callback query secrets from logs and response path', () => {
        const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        const response = mockResponse();
        const host = mockHost(response, '/api/v1/auth/callback?code=super-secret-code&state=super-secret-state&next=/dashboard');
        const filter = new ProductionExceptionFilter();

        filter.catch(new Error('callback failed'), host);

        const responseBody = JSON.stringify(response.json.mock.calls[0][0]);
        const logBody = JSON.stringify(logger.mock.calls);
        expect(responseBody).not.toContain('super-secret-code');
        expect(responseBody).not.toContain('super-secret-state');
        expect(logBody).not.toContain('super-secret-code');
        expect(logBody).not.toContain('super-secret-state');
        expect(logBody).not.toContain('/api/v1/auth/callback');
        expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
            path: '/api/v1/auth/callback',
        }));
        expect(responseBody).not.toContain('next=/dashboard');
    });
});

function mockResponse() {
    return {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
    };
}

function mockHost(response: ReturnType<typeof mockResponse>, originalUrl = '/v1/private'): ArgumentsHost {
    return {
        switchToHttp: () => ({
            getRequest: () => ({
                method: 'POST',
                originalUrl,
                correlationId: 'corr-1',
            }),
            getResponse: () => response,
            getNext: () => undefined,
        }),
    } as unknown as ArgumentsHost;
}
