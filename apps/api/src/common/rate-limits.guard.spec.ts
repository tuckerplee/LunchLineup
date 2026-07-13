import { describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { createHash } from 'crypto';
import { RateLimitsGuard } from './guards/rate-limits.guard';

class TestRateLimitsGuard extends RateLimitsGuard {
    runHandleRequest(props: any) {
        return this.handleRequest(props);
    }
}

function createContext(handler: Function, request: Record<string, any> = {}) {
    const response = { header: vi.fn() };
    return {
        context: {
            getHandler: () => handler,
            getClass: () => class TestController {},
            switchToHttp: () => ({
                getRequest: () => request,
                getResponse: () => response,
            }),
        },
        response,
    };
}

function createGuard() {
    const storageService = {
        increment: vi.fn().mockResolvedValue({
            totalHits: 1,
            timeToExpire: 60_000,
            isBlocked: false,
            timeToBlockExpire: 0,
        }),
    };
    const guard = new TestRateLimitsGuard([] as any, storageService as any, new Reflector());
    return { guard, storageService };
}

describe('RateLimitsGuard', () => {
    it('skips named throttlers unless a route opts into that bucket', async () => {
        const { guard, storageService } = createGuard();
        const { context } = createContext(function publicRoute() {});

        await expect(guard.runHandleRequest({
            context,
            throttler: { name: 'auth' },
            limit: 5,
            ttl: 900_000,
            blockDuration: 900_000,
            getTracker: vi.fn().mockResolvedValue('ip-1'),
            generateKey: vi.fn(),
        })).resolves.toBe(true);

        expect(storageService.increment).not.toHaveBeenCalled();
    });

    it('uses the configured auth-attempt quota for auth throttles', async () => {
        const { guard, storageService } = createGuard();
        const handler = function authRoute() {};
        Reflect.defineMetadata('THROTTLER:LIMITauth', 5, handler);
        const { context, response } = createContext(handler, { user: undefined });
        const generateKey = vi.fn().mockReturnValue('auth-key');

        await guard.runHandleRequest({
            context,
            throttler: { name: 'auth' },
            limit: 100,
            ttl: 900_000,
            blockDuration: 900_000,
            getTracker: vi.fn().mockResolvedValue('ip-1'),
            generateKey,
        });

        expect(storageService.increment).toHaveBeenCalledWith('auth-key', 900_000, 5, 900_000, 'auth');
        expect(response.header).toHaveBeenCalledWith('X-RateLimit-Limit-auth', 5);
    });

    it('keys authenticated auth-attempt throttles by session instead of the whole tenant', async () => {
        const { guard, storageService } = createGuard();
        const handler = function mfaRoute() {};
        Reflect.defineMetadata('THROTTLER:LIMITauth', 5, handler);
        const { context } = createContext(handler, {
            user: { tenantId: 'tenant-1', sub: 'user-1', sessionId: 'session-1' },
        });
        const getTracker = vi.fn().mockResolvedValue('ip-1');
        const generateKey = vi.fn().mockReturnValue('mfa-key');

        await guard.runHandleRequest({
            context,
            throttler: { name: 'auth' },
            limit: 100,
            ttl: 900_000,
            blockDuration: 900_000,
            getTracker,
            generateKey,
        });

        expect(generateKey).toHaveBeenCalledWith(context, 'tenant-1:user-1:session-1', 'auth');
        expect(getTracker).not.toHaveBeenCalled();
        expect(storageService.increment).toHaveBeenCalledWith('mfa-key', 900_000, 5, 900_000, 'auth');
    });

    it('separates cross-user NAT budgets while retaining a shared source-IP ceiling', async () => {
        const { guard } = createGuard();
        const handler = function sendOtp() {};
        Reflect.defineMetadata('THROTTLER:LIMITauthIdentifier', 5, handler);
        Reflect.defineMetadata('THROTTLER:LIMITauthIp', 30, handler);
        const first = createContext(handler, {
            ip: '203.0.113.10',
            body: { email: 'First@Example.com', tenantSlug: 'Demo' },
        });
        const second = createContext(handler, {
            ip: '203.0.113.10',
            body: { email: 'second@example.com', tenantSlug: 'demo' },
        });
        const firstIdentityKey = vi.fn().mockReturnValue('first-identity-key');
        const secondIdentityKey = vi.fn().mockReturnValue('second-identity-key');
        const sharedIpKey = vi.fn().mockReturnValue('shared-ip-key');
        const getTracker = vi.fn(async (req: Record<string, string>) => req.ip);

        await guard.runHandleRequest({
            context: first.context,
            throttler: { name: 'authIdentifier' },
            limit: 5,
            ttl: 900_000,
            blockDuration: 900_000,
            getTracker,
            generateKey: firstIdentityKey,
        });
        await guard.runHandleRequest({
            context: second.context,
            throttler: { name: 'authIdentifier' },
            limit: 5,
            ttl: 900_000,
            blockDuration: 900_000,
            getTracker,
            generateKey: secondIdentityKey,
        });
        await guard.runHandleRequest({
            context: second.context,
            throttler: { name: 'authIp' },
            limit: 30,
            ttl: 900_000,
            blockDuration: 900_000,
            getTracker,
            generateKey: sharedIpKey,
        });

        const firstSubject = `sha256:${createHash('sha256').update('account:demo:first@example.com').digest('hex')}`;
        const secondSubject = `sha256:${createHash('sha256').update('account:demo:second@example.com').digest('hex')}`;
        expect(firstIdentityKey).toHaveBeenCalledWith(
            first.context,
            `203.0.113.10:${firstSubject}`,
            'authIdentifier',
        );
        expect(secondIdentityKey).toHaveBeenCalledWith(
            second.context,
            `203.0.113.10:${secondSubject}`,
            'authIdentifier',
        );
        expect(sharedIpKey).toHaveBeenCalledWith(second.context, '203.0.113.10', 'authIp');
    });

    it('separates a targeted identifier budget across source IPs', async () => {
        const { guard } = createGuard();
        const handler = function verifyPassword() {};
        Reflect.defineMetadata('THROTTLER:LIMITauthIdentifier', 5, handler);
        const first = createContext(handler, {
            ip: '198.51.100.20',
            body: { identifier: ' Victim.User ', tenantSlug: ' Demo ' },
        });
        const second = createContext(handler, {
            ip: '198.51.100.21',
            body: { identifier: 'victim.user', tenantSlug: 'demo' },
        });
        const getTracker = vi.fn(async (req: Record<string, string>) => req.ip);
        const firstKey = vi.fn().mockReturnValue('first-target-key');
        const secondKey = vi.fn().mockReturnValue('second-target-key');

        for (const [context, generateKey] of [
            [first.context, firstKey],
            [second.context, secondKey],
        ] as const) {
            await guard.runHandleRequest({
                context,
                throttler: { name: 'authIdentifier' },
                limit: 5,
                ttl: 900_000,
                blockDuration: 900_000,
                getTracker,
                generateKey,
            });
        }

        const subject = `sha256:${createHash('sha256').update('account:demo:victim.user').digest('hex')}`;
        expect(firstKey).toHaveBeenCalledWith(first.context, `198.51.100.20:${subject}`, 'authIdentifier');
        expect(secondKey).toHaveBeenCalledWith(second.context, `198.51.100.21:${subject}`, 'authIdentifier');
        expect(firstKey.mock.calls[0][1]).not.toContain('victim.user');
        expect(firstKey.mock.calls[0][1]).not.toBe(secondKey.mock.calls[0][1]);
    });

    it('canonicalizes IPv4-mapped and IPv6 source addresses without reading forwarding headers', async () => {
        const { guard } = createGuard();
        const handler = function sendOtp() {};
        Reflect.defineMetadata('THROTTLER:LIMITauthIp', 30, handler);
        const requests = [
            { ip: '::ffff:203.0.113.10', headers: { 'x-forwarded-for': '192.0.2.99' } },
            { ip: '::ffff:cb00:710a', headers: { 'x-forwarded-for': '192.0.2.99' } },
            { ip: '2001:0db8:0:0:0:0:0:1', headers: { 'x-forwarded-for': '192.0.2.99' } },
            { ip: '2001:db8::1', headers: { 'x-forwarded-for': '192.0.2.99' } },
        ];
        const trackers: string[] = [];

        for (const request of requests) {
            const { context } = createContext(handler, request);
            const generateKey = vi.fn((_context, tracker: string) => {
                trackers.push(tracker);
                return `key-${trackers.length}`;
            });
            await guard.runHandleRequest({
                context,
                throttler: { name: 'authIp' },
                limit: 30,
                ttl: 900_000,
                blockDuration: 900_000,
                getTracker: vi.fn(async (req: Record<string, string>) => req.ip),
                generateKey,
            });
        }

        expect(trackers).toEqual([
            '203.0.113.10',
            '203.0.113.10',
            '2001:db8::1',
            '2001:db8::1',
        ]);
        expect(trackers).not.toContain('192.0.2.99');
    });

    it('hashes reset credentials inside the source-scoped low-limit bucket', async () => {
        const { guard } = createGuard();
        const handler = function confirmPasswordReset() {};
        Reflect.defineMetadata('THROTTLER:LIMITauthIdentifier', 5, handler);
        const { context } = createContext(handler, {
            ip: '203.0.113.30',
            body: { token: 'reset-secret-token' },
        });
        const generateKey = vi.fn().mockReturnValue('reset-key');

        await guard.runHandleRequest({
            context,
            throttler: { name: 'authIdentifier' },
            limit: 5,
            ttl: 900_000,
            blockDuration: 900_000,
            getTracker: vi.fn().mockResolvedValue('203.0.113.30'),
            generateKey,
        });

        const tracker = generateKey.mock.calls[0][1] as string;
        expect(tracker).toMatch(/^203\.0\.113\.30:sha256:[a-f0-9]{64}$/);
        expect(tracker).not.toContain('reset-secret-token');
    });

    it('separates refresh credentials behind one IP while retaining a higher shared IP ceiling', async () => {
        const { guard, storageService } = createGuard();
        const handler = function refresh() {};
        Reflect.defineMetadata('THROTTLER:LIMITrefreshCredential', 5, handler);
        Reflect.defineMetadata('THROTTLER:LIMITrefreshIp', 100, handler);
        const first = createContext(handler, {
            ip: '203.0.113.10',
            cookies: { refresh_token: 'refresh-token-one' },
        });
        const second = createContext(handler, {
            ip: '203.0.113.10',
            cookies: { refresh_token: 'refresh-token-two' },
        });
        const getTracker = vi.fn(async (req: Record<string, string>) => req.ip);
        const firstKey = vi.fn().mockReturnValue('first-refresh-key');
        const secondKey = vi.fn().mockReturnValue('second-refresh-key');
        const ipKey = vi.fn().mockReturnValue('refresh-ip-key');

        for (const [context, generateKey] of [
            [first.context, firstKey],
            [second.context, secondKey],
        ] as const) {
            await guard.runHandleRequest({
                context,
                throttler: { name: 'refreshCredential' },
                limit: 5,
                ttl: 900_000,
                blockDuration: 900_000,
                getTracker,
                generateKey,
            });
        }
        await guard.runHandleRequest({
            context: second.context,
            throttler: { name: 'refreshIp' },
            limit: 100,
            ttl: 900_000,
            blockDuration: 900_000,
            getTracker,
            generateKey: ipKey,
        });

        const firstHash = `sha256:${createHash('sha256').update('refresh-token-one').digest('hex')}`;
        const secondHash = `sha256:${createHash('sha256').update('refresh-token-two').digest('hex')}`;
        expect(firstKey).toHaveBeenCalledWith(first.context, firstHash, 'refreshCredential');
        expect(secondKey).toHaveBeenCalledWith(second.context, secondHash, 'refreshCredential');
        expect(firstHash).not.toContain('refresh-token-one');
        expect(secondHash).not.toBe(firstHash);
        expect(ipKey).toHaveBeenCalledWith(second.context, '203.0.113.10', 'refreshIp');
        expect(storageService.increment).toHaveBeenCalledWith(
            'refresh-ip-key', 900_000, 100, 900_000, 'refreshIp',
        );
    });

    it('uses plan API quota for the default bucket', async () => {
        const { guard, storageService } = createGuard();
        const { context, response } = createContext(function apiRoute() {});

        await guard.runHandleRequest({
            context,
            throttler: { name: 'default' },
            limit: 100,
            ttl: 60_000,
            blockDuration: 60_000,
            getTracker: vi.fn().mockResolvedValue('ip-1'),
            generateKey: vi.fn().mockReturnValue('api-key'),
        });

        expect(storageService.increment).toHaveBeenCalledWith('api-key', 60_000, 60, 60_000, 'default');
        expect(response.header).toHaveBeenCalledWith('X-RateLimit-Limit', 60);
    });

    it('does not apply paid quotas when the tenant subscription is past due', async () => {
        const { guard, storageService } = createGuard();
        const { context, response } = createContext(function apiRoute() {}, {
            user: { tenantId: 'tenant-1' },
        });
        (guard as any).tenantDb = {
            withTenant: vi.fn(async (_tenantId: string, fn: any) => fn({
                tenant: {
                    findUnique: vi.fn().mockResolvedValue({
                        planTier: 'GROWTH',
                        status: 'PAST_DUE',
                        stripeSubscriptionId: 'sub_123',
                    }),
                },
            })),
        };

        await guard.runHandleRequest({
            context,
            throttler: { name: 'default' },
            limit: 100,
            ttl: 60_000,
            blockDuration: 60_000,
            getTracker: vi.fn().mockResolvedValue('ip-1'),
            generateKey: vi.fn().mockReturnValue('api-key'),
        });

        expect(storageService.increment).toHaveBeenCalledWith('api-key', 60_000, 60, 60_000, 'default');
        expect(response.header).toHaveBeenCalledWith('X-RateLimit-Limit', 60);
    });

    it('applies paid quotas only for active Stripe-backed tenants', async () => {
        const { guard, storageService } = createGuard();
        const { context, response } = createContext(function apiRoute() {}, {
            user: { tenantId: 'tenant-1' },
        });
        (guard as any).tenantDb = {
            withTenant: vi.fn(async (_tenantId: string, fn: any) => fn({
                tenant: {
                    findUnique: vi.fn().mockResolvedValue({
                        planTier: 'GROWTH',
                        status: 'ACTIVE',
                        stripeSubscriptionId: 'sub_123',
                    }),
                },
            })),
        };

        await guard.runHandleRequest({
            context,
            throttler: { name: 'default' },
            limit: 100,
            ttl: 60_000,
            blockDuration: 60_000,
            getTracker: vi.fn().mockResolvedValue('ip-1'),
            generateKey: vi.fn().mockReturnValue('api-key'),
        });

        expect(storageService.increment).toHaveBeenCalledWith('api-key', 60_000, 1000, 60_000, 'default');
        expect(response.header).toHaveBeenCalledWith('X-RateLimit-Limit', 1000);
    });
});
