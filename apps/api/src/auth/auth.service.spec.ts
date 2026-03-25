import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

// Minimal mock factories
const mockConfigService = {
    getOrThrow: (key: string) => {
        const config: Record<string, string> = {
            OIDC_ISSUER_URL: 'https://auth.example.com',
            OIDC_CLIENT_ID: 'test-client-id',
            OIDC_CLIENT_SECRET: 'test-client-secret',
            OIDC_REDIRECT_URI: 'http://localhost:3000/auth/callback',
        };
        return config[key] ?? (() => { throw new Error(`Missing config: ${key}`); })();
    },
};

const mockJwtService = {
    generateAccessToken: vi.fn().mockReturnValue('test-access-token'),
    generateRefreshToken: vi.fn().mockReturnValue('test-refresh-token'),
    generateCsrfToken: vi.fn().mockReturnValue('test-csrf-token'),
    verifyAccessToken: vi.fn(),
    verifyRefreshToken: vi.fn(),
};

const mockRbacService = {
    getEffectiveAccess: vi.fn(),
    assignLegacySystemRole: vi.fn(),
};

const mockPrisma = {
    user: {
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        count: vi.fn(),
        findUnique: vi.fn(),
    },
    location: {
        count: vi.fn(),
    },
    tenant: {
        create: vi.fn(),
        findUnique: vi.fn().mockResolvedValue({ planTier: 'FREE' }),
    },
    session: {
        create: vi.fn(),
    },
};

describe('AuthService – handleOidcCallback', () => {
    let service: AuthService;

    beforeEach(() => {
        vi.clearAllMocks();
        mockRbacService.getEffectiveAccess.mockResolvedValue({
            primaryRole: 'ADMIN',
            roles: [],
            permissions: ['auth:login_email', 'auth:login_pin', 'dashboard:access', 'admin_portal:access'],
        });
        mockRbacService.assignLegacySystemRole.mockResolvedValue(undefined);
        service = new AuthService(mockConfigService as any, mockJwtService as any, mockRbacService as any);
        // Inject the mock prisma
        (service as any).prisma = mockPrisma;
    });

    it('should throw UnauthorizedException when no email is returned by the OIDC provider', async () => {
        // Mock the private exchange + userInfo methods
        vi.spyOn(service as any, 'exchangeCode').mockResolvedValue({ access_token: 'tok' });
        vi.spyOn(service as any, 'fetchUserInfo').mockResolvedValue({ sub: '123', name: 'Test User' }); // no email

        await expect(service.handleOidcCallback('code', 'state')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('should provision a new tenant+user when none exists', async () => {
        vi.spyOn(service as any, 'exchangeCode').mockResolvedValue({ access_token: 'tok' });
        vi.spyOn(service as any, 'fetchUserInfo').mockResolvedValue({ sub: '123', email: 'new@example.com', name: 'New User' });

        mockPrisma.user.findFirst.mockResolvedValue(null);
        mockPrisma.tenant.create.mockResolvedValue({ id: 'tenant-new' });
        mockPrisma.user.create.mockResolvedValue({ id: 'user-new', email: 'new@example.com', username: null, tenantId: 'tenant-new', role: 'ADMIN', mfaEnabled: false });
        mockPrisma.user.count.mockResolvedValue(0);
        mockPrisma.session.create.mockResolvedValue({ id: 'session-1', refreshToken: 'refresh-1' });
        mockPrisma.user.update.mockResolvedValue({});

        const result = await service.handleOidcCallback('code', 'state');

        expect(mockPrisma.tenant.create).toHaveBeenCalledOnce();
        expect(mockPrisma.user.create).toHaveBeenCalledOnce();
        expect(result).toHaveProperty('accessToken');
    });

    it('should return tokens for an existing user without recreating tenant', async () => {
        vi.spyOn(service as any, 'exchangeCode').mockResolvedValue({ access_token: 'tok' });
        vi.spyOn(service as any, 'fetchUserInfo').mockResolvedValue({ sub: '123', email: 'existing@example.com', name: 'Existing User' });

        mockPrisma.user.findFirst.mockResolvedValue({ id: 'user-existing', email: 'existing@example.com', username: null, tenantId: 'tenant-existing', role: 'ADMIN', mfaEnabled: false });
        mockPrisma.session.create.mockResolvedValue({ id: 'session-2', refreshToken: 'refresh-2' });
        mockPrisma.user.update.mockResolvedValue({});

        const result = await service.handleOidcCallback('code', 'state');

        expect(mockPrisma.tenant.create).not.toHaveBeenCalled();
        expect(result).toHaveProperty('accessToken');
    });

    it('should reject auto-provisioning when the tenant is already at the active user limit', async () => {
        vi.spyOn(service as any, 'exchangeCode').mockResolvedValue({ access_token: 'tok' });
        vi.spyOn(service as any, 'fetchUserInfo').mockResolvedValue({ sub: '123', email: 'limit@example.com', name: 'Limit User' });

        mockPrisma.user.findFirst.mockResolvedValue(null);
        mockPrisma.tenant.create.mockResolvedValue({ id: 'tenant-limit' });
        mockPrisma.user.count.mockResolvedValue(10);

        await expect(service.handleOidcCallback('code', 'state')).rejects.toThrow(/User limit reached/i);
        expect(mockPrisma.user.create).not.toHaveBeenCalled();
    });
});

describe('AuthService – mixed auth flow', () => {
    let service: AuthService;

    beforeEach(() => {
        vi.clearAllMocks();
        mockRbacService.getEffectiveAccess.mockResolvedValue({
            primaryRole: 'STAFF',
            roles: [],
            permissions: ['auth:login_pin', 'dashboard:access'],
        });
        mockRbacService.assignLegacySystemRole.mockResolvedValue(undefined);
        service = new AuthService(mockConfigService as any, mockJwtService as any, mockRbacService as any);
        (service as any).prisma = mockPrisma;
    });

    it('resolves email identifiers to EMAIL_OTP', async () => {
        const result = await service.resolveLoginMethod('ADMIN@Example.com');
        expect(result).toEqual({
            flow: 'EMAIL_OTP',
            normalizedIdentifier: 'admin@example.com',
        });
    });

    it('blocks username login when the account lacks PIN permission', async () => {
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'user-admin',
            tenantId: 'tenant-1',
            role: 'ADMIN',
            pinResetRequired: false,
        });
        mockRbacService.getEffectiveAccess.mockResolvedValue({
            primaryRole: 'ADMIN',
            roles: [],
            permissions: ['auth:login_email'],
        });

        await expect(service.resolveLoginMethod('boss.admin')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('resolves username identifiers to USERNAME_PIN', async () => {
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'user-manager',
            tenantId: 'tenant-1',
            role: 'MANAGER',
            pinResetRequired: true,
        });
        mockRbacService.getEffectiveAccess.mockResolvedValue({
            primaryRole: 'MANAGER',
            roles: [],
            permissions: ['auth:login_pin'],
        });

        const result = await service.resolveLoginMethod('ShiftLead');
        expect(result).toEqual({
            flow: 'USERNAME_PIN',
            normalizedIdentifier: 'shiftlead',
            pinResetRequired: true,
        });
    });

    it('logs in a username+PIN user with valid PIN', async () => {
        const pinHash = (service as any).hashPin('123456');
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'u-1',
            tenantId: 't-1',
            role: 'STAFF',
            email: null,
            username: 'shiftlead',
            mfaEnabled: false,
            pinHash,
            pinLoginAttempts: 0,
            pinLockedUntil: null,
        });
        mockPrisma.session.create.mockResolvedValue({ id: 's-1', refreshToken: 'r-1' });
        mockPrisma.user.update.mockResolvedValue({});

        const result = await service.loginWithUsernamePin('shiftlead', '123456');
        expect(result).toHaveProperty('accessToken');
        expect(result.user.username).toBe('shiftlead');
        expect(mockPrisma.session.create).toHaveBeenCalledOnce();
    });

    it('records failed PIN attempt on invalid PIN', async () => {
        const pinHash = (service as any).hashPin('123456');
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'u-2',
            tenantId: 't-1',
            role: 'STAFF',
            email: null,
            username: 'teammember',
            mfaEnabled: false,
            pinHash,
            pinLoginAttempts: 2,
            pinLockedUntil: null,
        });
        mockPrisma.user.update.mockResolvedValue({});

        await expect(service.loginWithUsernamePin('teammember', '0000')).rejects.toBeInstanceOf(UnauthorizedException);
        expect(mockPrisma.user.update).toHaveBeenCalledWith({
            where: { id: 'u-2' },
            data: {
                pinLoginAttempts: 3,
                pinLockedUntil: null,
            },
        });
    });

    it('rotates own PIN when current PIN is valid', async () => {
        const pinHash = (service as any).hashPin('1111');
        mockPrisma.user.findUnique.mockResolvedValue({
            id: 'u-3',
            username: 'nightlead',
            pinHash,
        });
        mockPrisma.user.update.mockResolvedValue({});

        await expect(service.rotateOwnPin('u-3', '1111', '2222')).resolves.toBeUndefined();
        expect(mockPrisma.user.update).toHaveBeenCalled();
    });
});
