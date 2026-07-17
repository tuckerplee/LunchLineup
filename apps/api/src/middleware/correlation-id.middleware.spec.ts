import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CorrelationIdMiddleware } from './correlation-id.middleware';

describe('CorrelationIdMiddleware', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('omits query values from request logs', () => {
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
        expect(logBody).toContain('/v1/auth/callback');
        expect(logBody).not.toContain('code=');
        expect(logBody).not.toContain('state=');
        expect(logBody).not.toContain('secret-code');
    });
    it('generates a server ID for unsafe headers and omits network identifiers from logs', () => {
        const loggerLog = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
        const loggerError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        let finish: (() => void) | undefined;
        const middleware = new CorrelationIdMiddleware();
        const injected = 'corr-1]\nERROR forged token=secret-token';
        const clientIp = '203.0.113.42';
        const forwardedIp = '198.51.100.8';
        const req = {
            headers: {
                'x-correlation-id': injected,
                'x-request-id': ['duplicate', 'headers'],
                'x-forwarded-for': forwardedIp,
            },
            method: 'POST',
            originalUrl: '/v1/jobs/unsafe\nFORGED?token=secret-query',
            ip: clientIp,
        } as any;
        const res = {
            statusCode: 500,
            setHeader: vi.fn(),
            on: vi.fn((event: string, callback: () => void) => {
                if (event === 'finish') finish = callback;
                return res;
            }),
        } as any;

        middleware.use(req, res, vi.fn());
        finish?.();

        const correlationId = req.correlationId as string;
        const logs = JSON.stringify([...loggerLog.mock.calls, ...loggerError.mock.calls]);
        expect(correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
        expect(correlationId).not.toBe(injected);
        expect(res.setHeader).toHaveBeenCalledWith('X-Correlation-ID', correlationId);
        for (const sensitive of [injected, 'secret-token', 'secret-query', clientIp, forwardedIp]) {
            expect(logs).not.toContain(sensitive);
        }
        expect(logs).not.toContain('\nERROR');
        expect(logs).not.toContain('token=');
    });

    it('accepts only bounded safe request IDs from either supported header', () => {
        vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
        const middleware = new CorrelationIdMiddleware();
        const safeId = 'edge.request-01:trace_02';
        const req = {
            headers: {
                'x-correlation-id': 'x'.repeat(65),
                'x-request-id': safeId,
            },
            method: 'GET',
            originalUrl: '/v1/health',
        } as any;
        const res = {
            statusCode: 200,
            setHeader: vi.fn(),
            on: vi.fn(() => res),
        } as any;

        middleware.use(req, res, vi.fn());

        expect(req.correlationId).toBe(safeId);
        expect(res.setHeader).toHaveBeenCalledWith('X-Correlation-ID', safeId);
    });
});
