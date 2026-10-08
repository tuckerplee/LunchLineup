import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthController } from '../auth/auth.controller';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { setCsrfToken } from '../middleware/csrf';

afterEach(() => vi.unstubAllEnvs());

describe('cookie configuration at retained writers', () => {
    it.each([
        ['production', undefined, true], ['test', undefined, false], ['development', undefined, false],
        ...['true', ' 1 ', ' YeS ', ' ON '].flatMap(value => [
            ['production', value, true], ['test', value, true],
        ]),
        ...['false', ' 0 ', ' No ', ' OFF '].map(value => ['test', value, false]),
    ] as [string, string | undefined, boolean][])('writes matching cookie flags for %s / %j', async (environment, value, secure) => {
        vi.stubEnv('NODE_ENV', environment);
        vi.stubEnv('COOKIE_SECURE', value);
        const response = { cookie: vi.fn() };
        const controller = new AuthController({} as any, {} as any, {} as any);
        (controller as any).setSessionCookies(response, 'access', 'refresh', 'csrf');
        setCsrfToken({} as any, response as any);
        const guard = new JwtAuthGuard({
            verifyAccessToken: vi.fn().mockReturnValue({ sub: 'user', tenantId: 'tenant', sessionId: 'session' }),
            generateAccessToken: vi.fn().mockReturnValue('rotated'),
        } as any, {
            validateAccessSession: vi.fn().mockResolvedValue({ mfaRequired: false, mfaVerified: true,
                access: { permissions: ['dashboard:access'], roles: [], primaryRole: 'STAFF' } }),
        } as any, { get: vi.fn().mockReturnValue(false) } as any);
        const request = { method: 'GET', path: '/v1/dashboard', headers: {}, cookies: { access_token: 'access' } };
        await expect(guard.canActivate({ getHandler: () => undefined, switchToHttp: () => ({
            getRequest: () => request, getResponse: () => response,
        }) } as any)).resolves.toBe(true);
        expect(response.cookie).toHaveBeenCalledTimes(5);
        for (const [, , options] of response.cookie.mock.calls) expect(options.secure).toBe(secure);
    });
});
