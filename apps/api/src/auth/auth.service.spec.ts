import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
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

const mockPrisma = {
    user: {
        findFirst: vi.fn(),
        create: vi.fn(),
    },
    tenant: {
        create: vi.fn(),
    },
    session: {
        create: vi.fn(),
    },
};

describe('AuthService – handleOidcCallback', () => {
    let service: AuthService;

    beforeEach(() => {
        vi.clearAllMocks();
        service = new AuthService(mockConfigService as any, mockJwtService as any);
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
        mockPrisma.user.create.mockResolvedValue({ id: 'user-new', email: 'new@example.com', tenantId: 'tenant-new', role: 'ADMIN' });
        mockPrisma.session.create.mockResolvedValue({});

        const result = await service.handleOidcCallback('code', 'state');

        expect(mockPrisma.tenant.create).toHaveBeenCalledOnce();
        expect(mockPrisma.user.create).toHaveBeenCalledOnce();
        expect(result).toHaveProperty('accessToken');
    });

    it('should return tokens for an existing user without recreating tenant', async () => {
        vi.spyOn(service as any, 'exchangeCode').mockResolvedValue({ access_token: 'tok' });
        vi.spyOn(service as any, 'fetchUserInfo').mockResolvedValue({ sub: '123', email: 'existing@example.com', name: 'Existing User' });

        mockPrisma.user.findFirst.mockResolvedValue({ id: 'user-existing', tenantId: 'tenant-existing', role: 'ADMIN' });
        mockPrisma.session.create.mockResolvedValue({});

        const result = await service.handleOidcCallback('code', 'state');

        expect(mockPrisma.tenant.create).not.toHaveBeenCalled();
        expect(result).toHaveProperty('accessToken');
    });
});
