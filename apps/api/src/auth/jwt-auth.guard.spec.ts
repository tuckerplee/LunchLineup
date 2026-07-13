import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';

const originalEnv = { ...process.env };

function makeContext(request: any) {
    return {
        getHandler: vi.fn(),
        switchToHttp: () => ({
            getRequest: () => request,
            getResponse: () => ({ cookie: vi.fn() }),
        }),
    } as any;
}

describe('JwtAuthGuard service-token routes', () => {
    afterEach(() => {
        process.env = { ...originalEnv };
        vi.restoreAllMocks();
    });

    it('allows the retention purge route with only the retention service token', async () => {
        process.env.RETENTION_PURGE_SERVICE_TOKEN = 'retention-token';
        const jwtService = { verifyAccessToken: vi.fn() };
        const guard = new JwtAuthGuard(
            jwtService as any,
            { validateAccessSession: vi.fn() } as any,
            { getEffectiveAccess: vi.fn() } as any,
            { get: vi.fn().mockReturnValue(false) } as any,
        );
        const request: any = {
            method: 'POST',
            path: '/api/v1/admin/retention/purge-expired',
            headers: { authorization: 'Bearer retention-token' },
            cookies: {},
        };

        await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);

        expect(jwtService.verifyAccessToken).not.toHaveBeenCalled();
        expect(request.user).toMatchObject({
            sub: 'service:retention-purge',
            tenantId: '__platform__',
            permissions: ['admin_portal:access'],
            service: 'retention-purge',
        });
    });

    it('does not accept the retention service token on other routes', async () => {
        process.env.RETENTION_PURGE_SERVICE_TOKEN = 'retention-token';
        const guard = new JwtAuthGuard(
            { verifyAccessToken: vi.fn(() => { throw new Error('not a jwt'); }) } as any,
            { validateAccessSession: vi.fn() } as any,
            { getEffectiveAccess: vi.fn() } as any,
            { get: vi.fn().mockReturnValue(false) } as any,
        );
        const request = {
            method: 'GET',
            path: '/api/v1/admin/tenants',
            headers: { authorization: 'Bearer retention-token' },
            cookies: {},
        };

        await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('allows an MFA-required session to read enrollment state before verification', async () => {
        const guard = new JwtAuthGuard(
            { verifyAccessToken: vi.fn().mockReturnValue({ sub: 'u1', tenantId: 't1' }) } as any,
            { validateAccessSession: vi.fn().mockResolvedValue({ mfaRequired: true, mfaVerified: false }) } as any,
            { getEffectiveAccess: vi.fn().mockResolvedValue({ permissions: ['settings:write'], roles: [], primaryRole: 'ADMIN' }) } as any,
            { get: vi.fn().mockReturnValue(false) } as any,
        );
        const request = {
            method: 'GET',
            path: '/api/v1/auth/mfa/enrollment',
            headers: { authorization: 'Bearer access-token' },
            cookies: {},
        };

        await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
    });

    it('keeps non-MFA routes blocked until required MFA is verified', async () => {
        const guard = new JwtAuthGuard(
            { verifyAccessToken: vi.fn().mockReturnValue({ sub: 'u1', tenantId: 't1' }) } as any,
            { validateAccessSession: vi.fn().mockResolvedValue({ mfaRequired: true, mfaVerified: false }) } as any,
            { getEffectiveAccess: vi.fn().mockResolvedValue({ permissions: ['settings:write'], roles: [], primaryRole: 'ADMIN' }) } as any,
            { get: vi.fn().mockReturnValue(false) } as any,
        );
        const request = {
            method: 'POST',
            path: '/api/v1/locations',
            headers: { authorization: 'Bearer access-token' },
            cookies: {},
        };

        await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it.each([
        ['normal application route', 'GET', '/api/v1/dashboard'],
        ['MFA enrollment route', 'POST', '/api/v1/auth/mfa/enrollment'],
    ])('blocks a temporary-PIN session from the %s', async (_label, method, path) => {
        const guard = new JwtAuthGuard(
            { verifyAccessToken: vi.fn().mockReturnValue({ sub: 'u1', tenantId: 't1', sessionId: 's1' }) } as any,
            {
                validateAccessSession: vi.fn().mockResolvedValue({
                    mfaRequired: true,
                    mfaVerified: false,
                    pinResetRequired: true,
                    legacyRole: 'ADMIN',
                }),
            } as any,
            { getEffectiveAccess: vi.fn().mockResolvedValue({ permissions: ['users:admin'], roles: [], primaryRole: 'ADMIN' }) } as any,
            { get: vi.fn().mockReturnValue(false) } as any,
        );
        const request = {
            method,
            path,
            headers: { authorization: 'Bearer reset-only-token' },
            cookies: {},
        };

        await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows a temporary-PIN session to rotate its own PIN', async () => {
        const guard = new JwtAuthGuard(
            { verifyAccessToken: vi.fn().mockReturnValue({ sub: 'u1', tenantId: 't1', sessionId: 's1' }) } as any,
            {
                validateAccessSession: vi.fn().mockResolvedValue({
                    mfaRequired: true,
                    mfaVerified: false,
                    pinResetRequired: true,
                    legacyRole: 'ADMIN',
                }),
            } as any,
            { getEffectiveAccess: vi.fn().mockResolvedValue({ permissions: ['users:admin'], roles: [], primaryRole: 'ADMIN' }) } as any,
            { get: vi.fn().mockReturnValue(false) } as any,
        );
        const request = {
            method: 'PUT',
            path: '/api/v1/users/me/pin',
            headers: { authorization: 'Bearer reset-only-token' },
            cookies: {},
        };

        await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
    });

    it('replaces a stale SUPER_ADMIN claim with the current database role', async () => {
        const guard = new JwtAuthGuard(
            {
                verifyAccessToken: vi.fn().mockReturnValue({
                    sub: 'u1',
                    tenantId: 't1',
                    sessionId: 's1',
                    legacyRole: 'SUPER_ADMIN',
                }),
            } as any,
            {
                validateAccessSession: vi.fn().mockResolvedValue({
                    mfaRequired: false,
                    mfaVerified: true,
                    legacyRole: 'STAFF',
                }),
            } as any,
            {
                getEffectiveAccess: vi.fn().mockResolvedValue({
                    permissions: ['dashboard:access'],
                    roles: [{ id: 'role-staff', name: 'Staff' }],
                    primaryRole: 'Staff',
                }),
            } as any,
            { get: vi.fn().mockReturnValue(false) } as any,
        );
        const request: any = {
            method: 'GET',
            path: '/api/v1/dashboard',
            headers: { authorization: 'Bearer access-token' },
            cookies: {},
        };

        await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);

        expect(request.user.legacyRole).toBe('STAFF');
        expect(request.user.legacyRole).not.toBe('SUPER_ADMIN');
    });
});
