import { ArgumentsHost, ForbiddenException, Logger } from '@nestjs/common';
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
        expect(logBody).toContain('[REDACTED]');
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
        expect(responseBody).toContain('[REDACTED]');
        expect(responseBody).toContain('next=/dashboard');
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
