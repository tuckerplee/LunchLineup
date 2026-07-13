import { HttpException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostValidationMiddleware } from './host-validation.middleware';

const originalEnv = { ...process.env };

describe('HostValidationMiddleware', () => {
    afterEach(() => {
        process.env = { ...originalEnv };
        vi.restoreAllMocks();
    });

    it('allows the configured localhost API host port', () => {
        process.env.DOMAIN = 'app.lunchlineup.test';
        process.env.API_HOST_PORT = '54000';
        const middleware = new HostValidationMiddleware();
        const next = vi.fn();

        middleware.use({ headers: { host: '127.0.0.1:54000' } } as any, {} as any, next);

        expect(next).toHaveBeenCalledOnce();
    });

    it('rejects unknown hosts', () => {
        process.env.DOMAIN = 'app.lunchlineup.test';
        const middleware = new HostValidationMiddleware();

        expect(() => middleware.use({ headers: { host: 'evil.example.net' } } as any, {} as any, vi.fn()))
            .toThrow(HttpException);
    });

    it('does not allow Docker service hostnames by default in production', () => {
        process.env.NODE_ENV = 'production';
        process.env.DOMAIN = 'app.lunchlineup.test';
        delete process.env.ALLOWED_HOSTS;
        delete process.env.API_INTERNAL_HOSTS;
        const middleware = new HostValidationMiddleware();
        const next = vi.fn();

        middleware.use({ headers: { host: 'app.lunchlineup.test' } } as any, {} as any, next);
        expect(next).toHaveBeenCalledOnce();
        expect(() => middleware.use({ headers: { host: 'api:3000' } } as any, {} as any, vi.fn()))
            .toThrow(HttpException);
    });

    it('allows explicitly configured Docker service hostnames in production', () => {
        process.env.NODE_ENV = 'production';
        process.env.DOMAIN = 'app.lunchlineup.test';
        process.env.API_INTERNAL_HOSTS = 'api,api:3000';
        const middleware = new HostValidationMiddleware();
        const next = vi.fn();

        middleware.use({ headers: { host: 'api:3000' } } as any, {} as any, next);

        expect(next).toHaveBeenCalledOnce();
    });

    it('keeps loopback health probes available in production', () => {
        process.env.NODE_ENV = 'production';
        process.env.DOMAIN = 'app.lunchlineup.test';
        process.env.PORT = '3000';
        const middleware = new HostValidationMiddleware();
        const next = vi.fn();

        middleware.use({ headers: { host: '127.0.0.1:3000' } } as any, {} as any, next);

        expect(next).toHaveBeenCalledOnce();
    });
});
