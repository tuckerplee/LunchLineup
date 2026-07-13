import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CorrelationIdMiddleware } from './correlation-id.middleware';

describe('CorrelationIdMiddleware', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('redacts sensitive query values from request logs', () => {
        const loggerLog = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
        const loggerWarn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        let finish: (() => void) | undefined;
        const middleware = new CorrelationIdMiddleware();
        const req = {
            headers: { 'x-correlation-id': 'corr-1' },
            method: 'GET',
            originalUrl: '/v1/auth/callback?code=secret-code&state=visible',
            ip: '127.0.0.1',
        } as any;
        const res = {
            statusCode: 404,
            setHeader: vi.fn(),
            on: vi.fn((event: string, callback: () => void) => {
                if (event === 'finish') finish = callback;
                return res;
            }),
        } as any;
        const next = vi.fn();

        middleware.use(req, res, next);
        finish?.();

        const logBody = JSON.stringify([...loggerLog.mock.calls, ...loggerWarn.mock.calls]);
        expect(req.correlationId).toBe('corr-1');
        expect(res.setHeader).toHaveBeenCalledWith('X-Correlation-ID', 'corr-1');
        expect(next).toHaveBeenCalledOnce();
        expect(logBody).toContain('code=[REDACTED]');
        expect(logBody).not.toContain('secret-code');
    });
});
