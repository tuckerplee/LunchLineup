import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { PUBLIC_SIGNUP_TRIAL_CREDITS } from './onboarding-signup.service';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';

const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    PUBLIC_SIGNUP_MODE: process.env.PUBLIC_SIGNUP_MODE,
    PUBLIC_SIGNUP_INVITE_CODES: process.env.PUBLIC_SIGNUP_INVITE_CODES,
    TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY,
    MFA_SECRET_ENCRYPTION_KEY: process.env.MFA_SECRET_ENCRYPTION_KEY,
    MFA_SECRET_ENCRYPTION_KEY_CURRENT: process.env.MFA_SECRET_ENCRYPTION_KEY_CURRENT,
    MFA_SECRET_ENCRYPTION_KEY_PREVIOUS: process.env.MFA_SECRET_ENCRYPTION_KEY_PREVIOUS,
    APP_ORIGIN: process.env.APP_ORIGIN,
    NEXT_PUBLIC_APP_ORIGIN: process.env.NEXT_PUBLIC_APP_ORIGIN,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
};

vi.mock('ioredis', () => ({
    default: vi.fn().mockImplementation(function RedisMock() {
        return {
            on: vi.fn(),
            exists: vi.fn(),
            set: vi.fn(),
            get: vi.fn(),
            del: vi.fn(),
        };
    }),
}));

// Minimal mock factories
const mockConfigService = {
    get: (key: string, fallback?: string) => {
        const config: Record<string, string> = {
            REDIS_URL: 'redis://localhost:6379',
            APP_ORIGIN: 'https://app.example.com',
            PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY: '11'.repeat(32),
        };
        return process.env[key] ?? config[key] ?? fallback;
    },
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
    provisionLegacySystemRole: vi.fn(),
};

const mockPrisma = {
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
    user: {
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
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
    creditTransaction: {
        create: vi.fn(),
    },
    session: {
        create: vi.fn(),
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        findMany: vi.fn(),
        updateMany: vi.fn(),
    },
    passwordResetToken: {
        create: vi.fn(),
        findFirst: vi.fn(),
        updateMany: vi.fn(),
    },
    passwordResetEmailOutbox: {
        create: vi.fn(),
        updateMany: vi.fn(),
    },
    mfaTotpClaim: {
        create: vi.fn(),
    },
    tenantSetting: {
        findUnique: vi.fn(),
    },
    auditLog: {
        create: vi.fn(),
    },
    onboardingSignupAttempt: {
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
    },
};

afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
    vi.unstubAllGlobals();
});

function resetPrismaMocks() {
    mockPrisma.$queryRaw.mockReset().mockResolvedValue([{ set_current_tenant: null }]);
    mockPrisma.$transaction.mockReset().mockImplementation(async (operation: (tx: typeof mockPrisma) => Promise<unknown>) => operation(mockPrisma));
    mockPrisma.user.findFirst.mockReset().mockResolvedValue(null);
    mockPrisma.user.create.mockReset();
    mockPrisma.user.update.mockReset();
    mockPrisma.user.updateMany.mockReset();
    mockPrisma.user.count.mockReset();
    mockPrisma.user.findUnique.mockReset();
    mockPrisma.tenant.create.mockReset();
    mockPrisma.creditTransaction.create.mockReset();
    mockPrisma.tenant.findUnique.mockReset().mockResolvedValue({
        id: 't-1',
        slug: 'demo',
        status: 'ACTIVE',
        deletedAt: null,
        planTier: 'FREE',
    });
    mockPrisma.session.create.mockReset();
    mockPrisma.session.findUnique.mockReset();
    mockPrisma.session.findFirst.mockReset();
    mockPrisma.session.findMany.mockReset();
    mockPrisma.session.updateMany.mockReset().mockResolvedValue({ count: 1 });
    mockPrisma.auditLog.create.mockReset();
    mockPrisma.passwordResetToken.create.mockReset();
    mockPrisma.passwordResetToken.findFirst.mockReset();
    mockPrisma.passwordResetToken.updateMany.mockReset();
    mockPrisma.passwordResetEmailOutbox.create.mockReset();
    mockPrisma.passwordResetEmailOutbox.updateMany.mockReset();
    mockPrisma.mfaTotpClaim.create.mockReset().mockResolvedValue({ id: 'totp-claim' });
    mockPrisma.tenantSetting.findUnique.mockReset().mockResolvedValue(null);
    mockPrisma.onboardingSignupAttempt.findUnique.mockReset();
    mockPrisma.onboardingSignupAttempt.create.mockReset();
    mockPrisma.onboardingSignupAttempt.update.mockReset();
}
function onboardingAttempt(
    challengeToken = 'challenge-token',
    code = '123456',
    email = 'owner@example.com',
    tenantName = 'Acme Dining',
) {
    const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
    const identityHash = hash(email.trim().toLowerCase());
    const organizationHash = hash(tenantName.trim().toLowerCase().replace(/\s+/g, ' '));
    return {
        id: 'attempt-1',
        identityOrganizationHash: hash(`${identityHash}:${organizationHash}`),
        identityHash,
        organizationHash,
        challengeHash: hash(challengeToken),
        otpHash: hash(`${challengeToken}:${code}`),
        otpSentAt: new Date(Date.now() - 1_000),
        otpExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
        otpFailedAttempts: 0,
        verifiedAt: null,
        recoveryExpiresAt: null,
        tenantId: null,
        userId: null,
    };
}


describe('AuthService – handleOidcCallback', () => {
    let service: AuthService;

    beforeEach(() => {
        vi.clearAllMocks();
        resetPrismaMocks();
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
        vi.spyOn(service as any, 'fetchUserInfo').mockResolvedValue({ sub: '123', email_verified: true, name: 'Test User' });

        await expect(service.handleOidcCallback('code', 'state')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects OIDC identities whose provider email is not verified', async () => {
        vi.spyOn(service as any, 'exchangeCode').mockResolvedValue({ access_token: 'tok' });
        vi.spyOn(service as any, 'fetchUserInfo').mockResolvedValue({
            sub: 'subject-1',
            email: 'existing@example.com',
            email_verified: false,
        });

        await expect(service.handleOidcCallback('code', 'state', 'demo')).rejects.toBeInstanceOf(UnauthorizedException);

        expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
        expect(mockPrisma.session.create).not.toHaveBeenCalled();
    });

    it('rejects OIDC login when the workspace has no matching user', async () => {
        vi.spyOn(service as any, 'exchangeCode').mockResolvedValue({ access_token: 'tok' });
        vi.spyOn(service as any, 'fetchUserInfo').mockResolvedValue({ sub: '123', email: 'new@example.com', email_verified: true, name: 'New User' });

        mockPrisma.user.findFirst.mockResolvedValue(null);

        await expect(service.handleOidcCallback('code', 'state', 'demo')).rejects.toBeInstanceOf(UnauthorizedException);

        expect(mockPrisma.tenant.create).not.toHaveBeenCalled();
        expect(mockPrisma.user.create).not.toHaveBeenCalled();
    });

    it('should return tokens for an existing user without recreating tenant', async () => {
        vi.spyOn(service as any, 'exchangeCode').mockResolvedValue({ access_token: 'tok' });
        vi.spyOn(service as any, 'fetchUserInfo').mockResolvedValue({ sub: '123', email: 'existing@example.com', email_verified: true, name: 'Existing User' });

        mockPrisma.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
            id: 'user-existing',
            email: 'existing@example.com',
            username: null,
            tenantId: 't-1',
            role: 'ADMIN',
            mfaEnabled: false,
            oidcIssuer: null,
            oidcSubject: null,
        });
        mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
        mockPrisma.session.create.mockResolvedValue({ id: 'session-2', refreshToken: 'refresh-2' });
        mockPrisma.user.update.mockResolvedValue({});

        const result = await service.handleOidcCallback('code', 'state', 'demo');

        expect(mockPrisma.tenant.create).not.toHaveBeenCalled();
        expect(mockPrisma.user.findFirst).toHaveBeenLastCalledWith({
            where: { tenantId: 't-1', email: 'existing@example.com', deletedAt: null },
        });
        expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'user-existing',
                tenantId: 't-1',
                oidcIssuer: null,
                oidcSubject: null,
            },
            data: {
                oidcIssuer: 'https://auth.example.com',
                oidcSubject: '123',
            },
        });
        expect(result).toHaveProperty('accessToken');
    });

    it('allows the same verified issuer and subject on later logins', async () => {
        vi.spyOn(service as any, 'exchangeCode').mockResolvedValue({ access_token: 'tok' });
        vi.spyOn(service as any, 'fetchUserInfo').mockResolvedValue({
            sub: 'subject-123',
            email: 'existing@example.com',
            email_verified: true,
        });
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'user-existing',
            email: 'existing@example.com',
            username: null,
            tenantId: 't-1',
            role: 'ADMIN',
            mfaEnabled: false,
            oidcIssuer: 'https://auth.example.com',
            oidcSubject: 'subject-123',
        });
        mockPrisma.session.create.mockResolvedValue({ id: 'session-2', refreshToken: 'refresh-2' });

        await expect(service.handleOidcCallback('code', 'state', 'demo')).resolves.toHaveProperty('accessToken');

        expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('allows verified OIDC recovery after password lockout from another IP', async () => {
        vi.spyOn(service as any, 'exchangeCode').mockResolvedValue({ access_token: 'tok' });
        vi.spyOn(service as any, 'fetchUserInfo').mockResolvedValue({
            sub: 'subject-123', email: 'locked@example.com', email_verified: true,
        });
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'user-locked', email: 'locked@example.com', username: 'locked.user', tenantId: 't-1',
            role: 'STAFF', mfaEnabled: false, oidcIssuer: 'https://auth.example.com', oidcSubject: 'subject-123',
            lockedUntil: new Date(Date.now() + 15 * 60_000),
        });
        mockPrisma.session.create.mockResolvedValue({ id: 'session-oidc', refreshToken: 'refresh-oidc' });

        await expect(service.handleOidcCallback('code', 'state', 'demo', { ipAddress: '198.51.100.77' }))
            .resolves.toHaveProperty('accessToken');
        expect(mockPrisma.session.create).toHaveBeenCalled();
    });

    it('rejects a verified email when the account is bound to a different OIDC subject', async () => {
        vi.spyOn(service as any, 'exchangeCode').mockResolvedValue({ access_token: 'tok' });
        vi.spyOn(service as any, 'fetchUserInfo').mockResolvedValue({
            sub: 'attacker-subject',
            email: 'existing@example.com',
            email_verified: true,
        });
        mockPrisma.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
            id: 'user-existing',
            email: 'existing@example.com',
            username: null,
            tenantId: 't-1',
            role: 'ADMIN',
            mfaEnabled: false,
            oidcIssuer: 'https://auth.example.com',
            oidcSubject: 'legitimate-subject',
        });

        await expect(service.handleOidcCallback('code', 'state', 'demo')).rejects.toBeInstanceOf(UnauthorizedException);

        expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
        expect(mockPrisma.session.create).not.toHaveBeenCalled();
    });

    it('rejects an OIDC subject that is already uniquely bound elsewhere', async () => {
        vi.spyOn(service as any, 'exchangeCode').mockResolvedValue({ access_token: 'tok' });
        vi.spyOn(service as any, 'fetchUserInfo').mockResolvedValue({
            sub: 'shared-subject',
            email: 'existing@example.com',
            email_verified: true,
        });
        mockPrisma.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
            id: 'user-existing',
            email: 'existing@example.com',
            username: null,
            tenantId: 't-1',
            role: 'ADMIN',
            mfaEnabled: false,
            oidcIssuer: null,
            oidcSubject: null,
        });
        mockPrisma.user.updateMany.mockRejectedValue({ code: 'P2002' });

        await expect(service.handleOidcCallback('code', 'state', 'demo')).rejects.toBeInstanceOf(UnauthorizedException);

        expect(mockPrisma.session.create).not.toHaveBeenCalled();
    });

    it('requires a workspace for OIDC login', async () => {
        vi.spyOn(service as any, 'exchangeCode').mockResolvedValue({ access_token: 'tok' });
        vi.spyOn(service as any, 'fetchUserInfo').mockResolvedValue({ sub: '123', email: 'limit@example.com', email_verified: true, name: 'Limit User' });

        await expect(service.handleOidcCallback('code', 'state')).rejects.toBeInstanceOf(BadRequestException);
        expect(mockPrisma.user.create).not.toHaveBeenCalled();
    });
});

describe('AuthService - OIDC state', () => {
    let service: AuthService;
    let redis: any;

    beforeEach(() => {
        vi.clearAllMocks();
        resetPrismaMocks();
        service = new AuthService(mockConfigService as any, mockJwtService as any, mockRbacService as any);
        (service as any).prisma = mockPrisma;
        redis = {
            set: vi.fn(),
            get: vi.fn(),
            del: vi.fn(),
            on: vi.fn(),
        };
        (service as any).redis = redis;
    });

    it('persists OIDC state in Redis with the safe return path', async () => {
        const oidcState = await service.createOidcState('/dashboard/schedules');
        const storedPayload = JSON.parse(redis.set.mock.calls[0][1]);

        expect(oidcState.state).toMatch(/^[a-f0-9]{64}$/);
        expect(oidcState.correlationNonce).toMatch(/^[a-f0-9]{64}$/);
        expect(storedPayload.correlationHash).toMatch(/^[a-f0-9]{64}$/);
        expect(storedPayload.correlationHash).not.toBe(oidcState.correlationNonce);
        expect(redis.set).toHaveBeenCalledWith(
            `oidc_state:${oidcState.state}`,
            expect.stringContaining('/dashboard/schedules'),
            'EX',
            600,
        );
    });

    it('consumes OIDC state once and rejects missing state', async () => {
        const oidcState = await service.createOidcState('/dashboard', 'demo');
        const storedPayload = redis.set.mock.calls[0][1];
        redis.get.mockResolvedValue(storedPayload);

        await expect(service.consumeOidcState(oidcState.state, oidcState.correlationNonce)).resolves.toEqual({
            nextPath: '/dashboard',
            tenantSlug: 'demo',
            createdAt: expect.any(Number),
        });
        expect(redis.del).toHaveBeenCalledWith(`oidc_state:${oidcState.state}`);

        redis.get.mockResolvedValue(null);
        await expect(service.consumeOidcState(oidcState.state, oidcState.correlationNonce))
            .rejects
            .toBeInstanceOf(UnauthorizedException);
    });

    it('rejects state redemption from a browser without the initiating correlation nonce', async () => {
        const oidcState = await service.createOidcState('/dashboard', 'demo');
        const storedPayload = redis.set.mock.calls[0][1];
        const otherBrowserNonce = oidcState.correlationNonce === 'b'.repeat(64)
            ? 'c'.repeat(64)
            : 'b'.repeat(64);
        redis.get.mockResolvedValue(storedPayload);

        await expect(service.consumeOidcState(oidcState.state, otherBrowserNonce))
            .rejects
            .toBeInstanceOf(UnauthorizedException);

        expect(redis.del).toHaveBeenCalledWith(`oidc_state:${oidcState.state}`);
    });
});

describe('AuthService - public onboarding provisioning', () => {
    let service: AuthService;

    beforeEach(() => {
        vi.clearAllMocks();
        resetPrismaMocks();
        mockRbacService.getEffectiveAccess.mockResolvedValue({
            primaryRole: 'ADMIN',
            roles: [],
            permissions: ['auth:login_email', 'dashboard:access', 'locations:write'],
        });
        mockRbacService.assignLegacySystemRole.mockResolvedValue(undefined);
        mockRbacService.provisionLegacySystemRole.mockResolvedValue(undefined);
        mockPrisma.onboardingSignupAttempt.findUnique.mockResolvedValue(onboardingAttempt());
        service = new AuthService(mockConfigService as any, mockJwtService as any, mockRbacService as any);
        (service as any).prisma = mockPrisma;
    });

    it('requires an organization name before allowing public email provisioning', async () => {
        await expect(service.assertEmailOtpAllowed('owner@example.com', { allowProvision: true }))
            .rejects
            .toBeInstanceOf(BadRequestException);

        await expect(service.loginWithEmail('owner@example.com', { allowProvision: true }))
            .rejects
            .toBeInstanceOf(BadRequestException);

        expect(mockPrisma.tenant.create).not.toHaveBeenCalled();
        expect(mockPrisma.user.create).not.toHaveBeenCalled();
    });

    it('creates public signup accounts as tenant admins, never platform super admins', async () => {
        mockPrisma.tenant.create.mockResolvedValue({ id: 'tenant-new', slug: 'acme-dining-abc123' });
        mockPrisma.user.create.mockResolvedValue({
            id: 'user-new',
            email: 'owner@example.com',
            username: null,
            tenantId: 'tenant-new',
            role: 'ADMIN',
            mfaEnabled: false,
        });
        mockPrisma.session.create.mockResolvedValue({ id: 'session-new', refreshToken: 'refresh-new' });

        const result = await service.loginWithEmail('Owner@Example.com', {
            allowProvision: true,
            provisionTenantName: '  Acme Dining  ',
            termsAccepted: true,
            privacyAccepted: true,
            onboardingChallengeToken: 'challenge-token',
            onboardingOtpCode: '123456',
        }, {
            ipAddress: '203.0.113.25',
            userAgent: 'Vitest Browser',
        });

        expect(mockPrisma.tenant.create).toHaveBeenCalledWith({
            data: {
                name: 'Acme Dining',
                slug: expect.stringMatching(/^acme-dining-[a-f0-9]{6}$/),
                planTier: 'STARTER',
                status: 'TRIAL',
                trialEndsAt: expect.any(Date),
                usageCredits: PUBLIC_SIGNUP_TRIAL_CREDITS,
            },
        });
        const trialEndsAt = mockPrisma.tenant.create.mock.calls[0][0].data.trialEndsAt as Date;
        expect(trialEndsAt.getTime()).toBeGreaterThan(Date.now() + 13 * 24 * 60 * 60 * 1000);
        expect(mockPrisma.creditTransaction.create).toHaveBeenCalledWith({
            data: {
                id: 'public-trial-credit-tenant-new',
                tenantId: 'tenant-new',
                amount: PUBLIC_SIGNUP_TRIAL_CREDITS,
                reason: 'Public signup Starter trial credits',
            },
        });
        expect(mockPrisma.user.create).toHaveBeenCalledWith({
            data: {
                email: 'owner@example.com',
                name: 'owner',
                tenantId: 'tenant-new',
                role: 'ADMIN',
            },
        });
        expect(mockPrisma.user.create.mock.calls[0][0].data.role).not.toBe('SUPER_ADMIN');
        expect(mockPrisma.auditLog.create).toHaveBeenNthCalledWith(1, {
            data: {
                tenantId: 'tenant-new',
                userId: 'user-new',
                action: 'PUBLIC_SIGNUP_LEGAL_ASSENT',
                resource: 'Tenant',
                resourceId: 'tenant-new',
                newValue: {
                    termsVersion: '2026-07-09',
                    privacyVersion: '2026-07-09',
                    assentedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
                    assentedByEmail: 'owner@example.com',
                },
                ipAddress: '203.0.113.25',
                userAgent: 'Vitest Browser',
            },
        });
        expect(mockPrisma.user.count).toHaveBeenCalledWith({
            where: {
                tenantId: 'tenant-new',
                deletedAt: null,
            },
        });
        expect(mockPrisma.user.count).not.toHaveBeenCalledWith();
        expect(mockRbacService.provisionLegacySystemRole).toHaveBeenCalledWith(
            mockPrisma,
            'user-new',
            'tenant-new',
            'ADMIN',
        );
        expect(mockRbacService.assignLegacySystemRole).not.toHaveBeenCalled();
        expect(result).toHaveProperty('accessToken');
        expect(result.workspaceSlug).toBe('acme-dining-abc123');
    });

    it('keeps owner RBAC provisioning inside the tenant creation transaction', async () => {
        let transactionActive = false;
        mockPrisma.$transaction.mockImplementation(async (operation: (tx: typeof mockPrisma) => Promise<unknown>) => {
            transactionActive = true;
            try {
                return await operation(mockPrisma);
            } finally {
                transactionActive = false;
            }
        });
        mockPrisma.tenant.create.mockResolvedValue({ id: 'tenant-new', slug: 'acme-dining-abc123' });
        mockPrisma.user.create.mockResolvedValue({
            id: 'user-new',
            email: 'owner@example.com',
            username: null,
            tenantId: 'tenant-new',
            role: 'ADMIN',
            mfaEnabled: false,
        });
        mockRbacService.provisionLegacySystemRole.mockImplementation(async (tx: unknown) => {
            expect(tx).toBe(mockPrisma);
            expect(transactionActive).toBe(true);
            throw new Error('RBAC provisioning failed');
        });

        await expect(service.loginWithEmail('owner@example.com', {
            allowProvision: true,
            provisionTenantName: 'Acme Dining',
            termsAccepted: true,
            privacyAccepted: true,
            onboardingChallengeToken: 'challenge-token',
            onboardingOtpCode: '123456',
        })).rejects.toThrow('RBAC provisioning failed');

        expect(mockPrisma.tenant.create).toHaveBeenCalledOnce();
        expect(mockPrisma.user.create).toHaveBeenCalledOnce();
        expect(mockPrisma.session.create).not.toHaveBeenCalled();
    });

    it('rejects public provisioning without explicit Terms and Privacy assent', async () => {
        await expect(service.loginWithEmail('owner@example.com', {
            allowProvision: true,
            provisionTenantName: 'Acme Dining',
            termsAccepted: true,
            privacyAccepted: false,
        })).rejects.toBeInstanceOf(BadRequestException);

        expect(mockPrisma.tenant.create).not.toHaveBeenCalled();
        expect(mockPrisma.user.create).not.toHaveBeenCalled();
        expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('fails closed for public provisioning in production when signup mode is not explicitly open', async () => {
        process.env.NODE_ENV = 'production';

        await expect(service.assertEmailOtpAllowed('owner@example.com', {
            allowProvision: true,
            provisionTenantName: 'Acme Dining',
        })).rejects.toBeInstanceOf(ForbiddenException);

        await expect(service.loginWithEmail('owner@example.com', {
            allowProvision: true,
            provisionTenantName: 'Acme Dining',
        })).rejects.toBeInstanceOf(ForbiddenException);

        expect(mockPrisma.tenant.create).not.toHaveBeenCalled();
        expect(mockPrisma.user.create).not.toHaveBeenCalled();
    });

    it('rejects production open signup before challenge verification', async () => {
        process.env.NODE_ENV = 'production';
        process.env.PUBLIC_SIGNUP_MODE = 'open';

        await expect(service.assertEmailOtpAllowed('owner@example.com', {
            allowProvision: true,
            provisionTenantName: 'Acme Dining',
            signupChallengeToken: 'turnstile-token',
        })).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('requires a Turnstile token before sending non-production open signup OTPs', async () => {
        process.env.NODE_ENV = 'development';
        process.env.PUBLIC_SIGNUP_MODE = 'open';
        process.env.TURNSTILE_SECRET_KEY = 'turnstile-secret';

        await expect(service.assertEmailOtpAllowed('owner@example.com', {
            allowProvision: true,
            provisionTenantName: 'Acme Dining',
        })).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('verifies Turnstile before sending non-production open signup OTPs', async () => {
        process.env.NODE_ENV = 'development';
        process.env.PUBLIC_SIGNUP_MODE = 'open';
        process.env.TURNSTILE_SECRET_KEY = 'turnstile-secret';
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: vi.fn().mockResolvedValue({ success: true }),
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(service.assertEmailOtpAllowed('owner@example.com', {
            allowProvision: true,
            provisionTenantName: 'Acme Dining',
            signupChallengeToken: 'turnstile-token',
            signupChallengeRemoteIp: '203.0.113.10',
        })).resolves.toBe(true);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
        expect(init.method).toBe('POST');
        const params = new URLSearchParams(init.body as string);
        expect(params.get('secret')).toBe('turnstile-secret');
        expect(params.get('response')).toBe('turnstile-token');
        expect(params.get('remoteip')).toBe('203.0.113.10');
    });

    it('rejects failed Turnstile checks before sending non-production open signup OTPs', async () => {
        process.env.NODE_ENV = 'development';
        process.env.PUBLIC_SIGNUP_MODE = 'open';
        process.env.TURNSTILE_SECRET_KEY = 'turnstile-secret';
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: vi.fn().mockResolvedValue({ success: false }),
        }));

        await expect(service.assertEmailOtpAllowed('owner@example.com', {
            allowProvision: true,
            provisionTenantName: 'Acme Dining',
            signupChallengeToken: 'turnstile-token',
        })).rejects.toBeInstanceOf(ForbiddenException);
    });
    it('reuses the claimed tenant and owner when session issuance fails and a new OTP is verified', async () => {
        const attempt: any = onboardingAttempt();
        const tenant = {
            id: 'tenant-new',
            name: 'Acme Dining',
            slug: 'acme-dining-abc123',
            status: 'TRIAL',
            deletedAt: null,
        };
        const owner = {
            id: 'user-new',
            email: 'owner@example.com',
            username: null,
            tenantId: tenant.id,
            role: 'ADMIN',
            mfaEnabled: false,
            deletedAt: null,
        };
        mockPrisma.onboardingSignupAttempt.findUnique.mockImplementation(async () => attempt);
        mockPrisma.onboardingSignupAttempt.update.mockImplementation(async ({ data }: any) => {
            if (data.otpFailedAttempts?.increment) {
                attempt.otpFailedAttempts += data.otpFailedAttempts.increment;
            } else {
                Object.assign(attempt, data);
            }
            return attempt;
        });
        mockPrisma.tenant.create.mockResolvedValue(tenant);
        mockPrisma.tenant.findUnique.mockResolvedValue(tenant);
        mockPrisma.user.create.mockResolvedValue(owner);
        mockPrisma.user.findFirst.mockResolvedValue(owner);
        mockPrisma.session.create
            .mockRejectedValueOnce(new Error('session store unavailable'))
            .mockResolvedValueOnce({ id: 'session-retry' });

        const initialOptions = {
            allowProvision: true,
            provisionTenantName: 'Acme Dining',
            termsAccepted: true,
            privacyAccepted: true,
            onboardingChallengeToken: 'challenge-token',
            onboardingOtpCode: '123456',
        };
        await expect(service.loginWithEmail('owner@example.com', initialOptions))
            .rejects
            .toThrow('session store unavailable');

        attempt.otpSentAt = new Date(Date.now() - 61_000);
        const replacement = await service.createOnboardingSignupChallenge('owner@example.com', {
            allowProvision: true,
            provisionTenantName: 'Acme Dining',
            termsAccepted: true,
            privacyAccepted: true,
        });
        await expect(service.loginWithEmail('owner@example.com', {
            ...initialOptions,
            onboardingChallengeToken: replacement.challengeToken,
            onboardingOtpCode: replacement.code,
        })).resolves.toMatchObject({
            workspaceSlug: tenant.slug,
            accessToken: 'test-access-token',
        });

        expect(mockPrisma.tenant.create).toHaveBeenCalledOnce();
        expect(mockPrisma.creditTransaction.create).toHaveBeenCalledOnce();
        expect(mockPrisma.user.create).toHaveBeenCalledOnce();
        expect(mockRbacService.provisionLegacySystemRole).toHaveBeenCalledOnce();
        expect(mockPrisma.session.create).toHaveBeenCalledTimes(2);
        expect(attempt).toMatchObject({
            tenantId: tenant.id,
            userId: owner.id,
            verifiedAt: expect.any(Date),
            recoveryExpiresAt: expect.any(Date),
        });
    });


});

describe('AuthService - tenant lifecycle auth gates', () => {
    let service: AuthService;

    beforeEach(() => {
        vi.clearAllMocks();
        resetPrismaMocks();
        mockRbacService.getEffectiveAccess.mockResolvedValue({
            primaryRole: 'STAFF',
            roles: [],
            permissions: ['auth:login_email', 'dashboard:access'],
        });
        service = new AuthService(mockConfigService as any, mockJwtService as any, mockRbacService as any);
        (service as any).prisma = mockPrisma;
    });

    it('blocks suspended workspaces before resolving login methods', async () => {
        mockPrisma.tenant.findUnique.mockResolvedValue({
            id: 't-1',
            slug: 'demo',
            status: 'SUSPENDED',
            deletedAt: null,
        });

        await expect(service.resolveLoginMethod('admin@example.com', 'demo'))
            .rejects
            .toBeInstanceOf(UnauthorizedException);

        expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
    });

    it('rejects refresh tokens after the tenant is suspended', async () => {
        mockPrisma.session.findFirst.mockResolvedValue({
            id: 's-refresh',
            userId: 'u-refresh',
            refreshToken: 'refresh-token',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            revokedAt: null,
            user: {
                id: 'u-refresh',
                tenantId: 't-1',
                role: 'STAFF',
                mfaEnabled: false,
                deletedAt: null,
            },
        });
        mockPrisma.tenant.findUnique.mockResolvedValue({
            id: 't-1',
            status: 'SUSPENDED',
            deletedAt: null,
        });

        await expect(service.refreshAccessToken('refresh-token'))
            .rejects
            .toBeInstanceOf(UnauthorizedException);

        expect(mockJwtService.generateAccessToken).not.toHaveBeenCalled();
    });

    it('rejects existing access-token sessions after the tenant is suspended', async () => {
        mockPrisma.session.findFirst.mockResolvedValue({
            id: 's-access',
            userId: 'u-access',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            revokedAt: null,
            user: {
                id: 'u-access',
                tenantId: 't-1',
                role: 'STAFF',
                mfaEnabled: false,
                deletedAt: null,
            },
        });
        mockPrisma.tenant.findUnique.mockResolvedValue({
            id: 't-1',
            status: 'SUSPENDED',
            deletedAt: null,
        });

        await expect(service.validateAccessSession({
            sub: 'u-access',
            tenantId: 't-1',
            role: 'STAFF',
            sessionId: 's-access',
            mfaVerified: true,
        })).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('allows a cancelled workspace session to reach billing resubscription settings', async () => {
        mockPrisma.session.findFirst.mockResolvedValue({
            id: 's-cancelled',
            userId: 'u-cancelled',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            revokedAt: null,
            user: {
                id: 'u-cancelled',
                tenantId: 't-1',
                role: 'ADMIN',
                mfaEnabled: false,
                deletedAt: null,
            },
        });
        mockPrisma.tenant.findUnique.mockResolvedValue({
            id: 't-1',
            status: 'CANCELLED',
            deletedAt: null,
        });

        await expect(service.validateAccessSession({
            sub: 'u-cancelled',
            tenantId: 't-1',
            role: 'ADMIN',
            sessionId: 's-cancelled',
            mfaVerified: true,
        })).resolves.toMatchObject({ legacyRole: 'ADMIN' });
    });

    it('returns the current database role instead of a stale access-token role', async () => {
        mockPrisma.session.findFirst.mockResolvedValue({
            id: 's-access',
            userId: 'u-access',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            revokedAt: null,
            user: {
                id: 'u-access',
                tenantId: 't-1',
                role: 'STAFF',
                mfaEnabled: false,
                deletedAt: null,
            },
        });

        await expect(service.validateAccessSession({
            sub: 'u-access',
            tenantId: 't-1',
            role: 'System Admin',
            legacyRole: 'SUPER_ADMIN',
            sessionId: 's-access',
            mfaVerified: true,
        })).resolves.toMatchObject({
            legacyRole: 'STAFF',
        });
    });

    it('rejects session context for suspended tenants', async () => {
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'u-context',
            tenantId: 't-1',
            role: 'STAFF',
            email: 'staff@example.com',
            username: 'staff',
            name: 'Staff User',
            tenant: {
                name: 'Demo',
                status: 'SUSPENDED',
                deletedAt: null,
            },
        });

        await expect(service.getSessionUserContext('u-context', 't-1', {
            role: 'STAFF',
            sessionId: 's-context',
        })).rejects.toBeInstanceOf(UnauthorizedException);
    });
});

describe('AuthService – mixed auth flow', () => {
    let service: AuthService;

    beforeEach(() => {
        vi.clearAllMocks();
        resetPrismaMocks();
        mockRbacService.getEffectiveAccess.mockResolvedValue({
            primaryRole: 'STAFF',
            roles: [],
            permissions: ['auth:login_pin', 'dashboard:access'],
        });
        mockRbacService.assignLegacySystemRole.mockResolvedValue(undefined);
        service = new AuthService(mockConfigService as any, mockJwtService as any, mockRbacService as any);
        (service as any).prisma = mockPrisma;
    });

    it('suppresses tenant email OTP delivery for unknown or deleted users', async () => {
        await expect(service.assertEmailOtpAllowed('missing@example.com', { tenantSlug: 'demo' }))
            .resolves
            .toBe(false);

        expect(mockPrisma.user.findFirst).toHaveBeenCalledWith({
            where: {
                tenantId: 't-1',
                email: 'missing@example.com',
                deletedAt: null,
            },
            select: {
                id: true,
                tenantId: true,
            },
        });
        expect(mockRbacService.getEffectiveAccess).not.toHaveBeenCalled();
    });

    it('suppresses tenant email OTP delivery when the user lacks email-login permission', async () => {
        mockPrisma.user.findFirst.mockResolvedValue({ id: 'user-pin', tenantId: 't-1' });

        await expect(service.assertEmailOtpAllowed('pin-only@example.com', { tenantSlug: 'demo' }))
            .resolves
            .toBe(false);

        expect(mockRbacService.getEffectiveAccess).toHaveBeenCalledWith('user-pin', 't-1');
    });

    it('allows tenant email OTP delivery for an active user with email-login permission', async () => {
        mockPrisma.user.findFirst.mockResolvedValue({ id: 'user-email', tenantId: 't-1' });
        mockRbacService.getEffectiveAccess.mockResolvedValue({
            primaryRole: 'STAFF',
            roles: [],
            permissions: ['auth:login_email'],
        });

        await expect(service.assertEmailOtpAllowed('email-user@example.com', { tenantSlug: 'demo' }))
            .resolves
            .toBe(true);
    });

    it('resolves email identifiers to EMAIL_OTP', async () => {
        const result = await service.resolveLoginMethod('ADMIN@Example.com', 'demo');
        expect(result).toEqual({
            flow: 'EMAIL_OTP',
            normalizedIdentifier: 'admin@example.com',
        });
    });

    it('does not disclose username existence through missing PIN permission', async () => {
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'user-admin',
            tenantId: 'tenant-1',
            role: 'ADMIN',
            pinResetRequired: false,
            passwordHash: null,
        });
        mockRbacService.getEffectiveAccess.mockResolvedValue({
            primaryRole: 'ADMIN',
            roles: [],
            permissions: ['auth:login_email'],
        });

        await expect(service.resolveLoginMethod('boss.admin', 'demo')).resolves.toEqual({
            flow: 'USERNAME_PIN',
            normalizedIdentifier: 'boss.admin',
            pinResetRequired: false,
        });
    });

    it('resolves username identifiers to USERNAME_PIN', async () => {
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'user-manager',
            tenantId: 'tenant-1',
            role: 'MANAGER',
            pinResetRequired: true,
            passwordHash: null,
        });
        mockRbacService.getEffectiveAccess.mockResolvedValue({
            primaryRole: 'MANAGER',
            roles: [],
            permissions: ['auth:login_pin'],
        });

        const result = await service.resolveLoginMethod('ShiftLead', 'demo');
        expect(result).toEqual({
            flow: 'USERNAME_PIN',
            normalizedIdentifier: 'shiftlead',
            pinResetRequired: false,
        });
    });

    it('returns the same anonymous resolution for unknown and PIN usernames', async () => {
        mockPrisma.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
            id: 'user-pin', tenantId: 't-1', role: 'STAFF', pinResetRequired: true, passwordHash: null,
        });

        const unknown = await service.resolveLoginMethod('Missing.User', 'demo');
        const pin = await service.resolveLoginMethod('Pin.User', 'demo');

        expect({ ...pin, normalizedIdentifier: unknown.normalizedIdentifier }).toEqual(unknown);
        expect(mockRbacService.getEffectiveAccess).not.toHaveBeenCalled();
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
            pinResetRequired: false,
            pinHash,
            pinLoginAttempts: 0,
            pinLockedUntil: null,
        });
        mockPrisma.session.create.mockResolvedValue({ id: 's-1', refreshToken: 'r-1' });
        mockPrisma.user.update.mockResolvedValue({});

        const result = await service.loginWithUsernamePin('shiftlead', '123456', 'demo');
        expect(result).toHaveProperty('accessToken');
        expect(result.user.username).toBe('shiftlead');
        expect(mockPrisma.session.create).toHaveBeenCalledOnce();
    });

    it('allows verified email OTP recovery after password lockout from another IP', async () => {
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'u-email-recovery', tenantId: 't-1', role: 'STAFF', email: 'locked@example.com',
            username: 'locked.user', mfaEnabled: false, lockedUntil: new Date(Date.now() + 15 * 60_000),
        });
        mockRbacService.getEffectiveAccess.mockResolvedValue({
            primaryRole: 'STAFF', roles: [], permissions: ['auth:login_email'],
        });
        mockPrisma.session.create.mockResolvedValue({ id: 's-email-recovery', refreshToken: 'r-email-recovery' });

        await expect(service.loginWithEmail('locked@example.com', { tenantSlug: 'demo' }, { ipAddress: '203.0.113.88' }))
            .resolves.toHaveProperty('accessToken');
        expect(mockPrisma.session.create).toHaveBeenCalled();
    });

    it('marks a temporary PIN login as reset-only instead of issuing a normal application session', async () => {
        const pinHash = (service as any).hashPin('123456');
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'u-temp',
            tenantId: 't-1',
            role: 'STAFF',
            email: null,
            username: 'temporary.user',
            mfaEnabled: false,
            pinResetRequired: true,
            pinHash,
            pinLoginAttempts: 0,
            pinLockedUntil: null,
        });
        mockPrisma.session.create.mockResolvedValue({ id: 's-temp', refreshToken: 'r-temp' });
        mockPrisma.user.update.mockResolvedValue({});

        const result = await service.loginWithUsernamePin('temporary.user', '123456', 'demo');

        expect(result.pinResetRequired).toBe(true);
        expect(mockJwtService.generateAccessToken).toHaveBeenCalledWith(expect.objectContaining({
            sub: 'u-temp',
            sessionId: 's-temp',
            pinResetRequired: true,
        }));
    });

    it('resolves migrated username identifiers to USERNAME_PASSWORD', async () => {
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'user-legacy',
            tenantId: 'tenant-1',
            role: 'STAFF',
            pinResetRequired: false,
            passwordHash: '$2y$10$legacyhashplaceholder',
        });
        mockRbacService.getEffectiveAccess.mockResolvedValue({
            primaryRole: 'STAFF',
            roles: [],
            permissions: ['auth:login_password'],
        });

        const result = await service.resolveLoginMethod('LegacyUser', 'demo');
        expect(result).toEqual({
            flow: 'USERNAME_PASSWORD',
            normalizedIdentifier: 'legacyuser',
        });
    });

    it('logs in a username+password user with a migrated bcrypt hash', async () => {
        const passwordHash = bcrypt.hashSync('correct-horse', 10).replace(/^\$2a\$/, '$2y$');
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'u-legacy',
            tenantId: 't-1',
            role: 'STAFF',
            email: null,
            username: 'legacyuser',
            mfaEnabled: false,
            passwordHash,
            loginAttempts: 0,
            lockedUntil: null,
        });
        mockRbacService.getEffectiveAccess.mockResolvedValue({
            primaryRole: 'STAFF',
            roles: [],
            permissions: ['auth:login_password'],
        });
        mockPrisma.session.create.mockResolvedValue({ id: 's-password', refreshToken: 'r-password' });
        mockPrisma.user.update.mockResolvedValue({});

        const result = await service.loginWithUsernamePassword('LegacyUser', 'correct-horse', 'demo');
        expect(result).toHaveProperty('accessToken');
        expect(result.user.username).toBe('legacyuser');
    });

    it('records failed password attempt on invalid migrated password', async () => {
        const passwordHash = bcrypt.hashSync('right-password', 10);
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'u-bad-password',
            tenantId: 't-1',
            role: 'STAFF',
            email: null,
            username: 'legacyuser',
            mfaEnabled: false,
            passwordHash,
            loginAttempts: 4,
            lockedUntil: null,
        });
        mockRbacService.getEffectiveAccess.mockResolvedValue({
            primaryRole: 'STAFF',
            roles: [],
            permissions: ['auth:login_password'],
        });
        mockPrisma.user.update.mockResolvedValue({});

        await expect(service.loginWithUsernamePassword('legacyuser', 'wrong-password', 'demo')).rejects.toBeInstanceOf(UnauthorizedException);
        expect(mockPrisma.user.update).toHaveBeenCalledWith({
            where: { id: 'u-bad-password' },
            data: {
                loginAttempts: 5,
                lockedUntil: expect.any(Date),
            },
        });
    });

    it('serializes concurrent failed password attempts and preserves the threshold lock', async () => {
        const account = {
            id: 'u-concurrent-password',
            tenantId: 't-1',
            role: 'STAFF',
            email: null,
            username: 'parallel.passwords',
            mfaEnabled: false,
            passwordHash: bcrypt.hashSync('right-password', 10),
            loginAttempts: 0,
            lockedUntil: null as Date | null,
            deletedAt: null,
        };
        let transactionTail = Promise.resolve();

        mockPrisma.$transaction.mockImplementation(async (operation: (tx: typeof mockPrisma) => Promise<unknown>) => {
            let releaseTransaction!: () => void;
            const previousTransaction = transactionTail;
            transactionTail = new Promise<void>((resolve) => {
                releaseTransaction = resolve;
            });
            await previousTransaction;
            try {
                return await operation(mockPrisma);
            } finally {
                releaseTransaction();
            }
        });
        mockPrisma.user.findFirst.mockImplementation(async () => ({ ...account }));
        mockPrisma.user.update.mockImplementation(async ({ data }: { data: Partial<typeof account> }) => {
            Object.assign(account, data);
            return { ...account };
        });
        mockRbacService.getEffectiveAccess.mockResolvedValue({
            primaryRole: 'STAFF',
            roles: [],
            permissions: ['auth:login_password'],
        });

        const attempts = await Promise.allSettled(
            Array.from({ length: 6 }, () => service.loginWithUsernamePassword(
                'parallel.passwords',
                'wrong-password',
                'demo',
            )),
        );

        expect(attempts.filter((attempt) => attempt.status === 'rejected'
            && attempt.reason instanceof UnauthorizedException)).toHaveLength(5);
        expect(attempts.filter((attempt) => attempt.status === 'rejected'
            && attempt.reason instanceof ForbiddenException)).toHaveLength(1);
        expect(account.loginAttempts).toBe(5);
        expect(account.lockedUntil).toBeInstanceOf(Date);
        expect(mockPrisma.user.update).toHaveBeenCalledTimes(5);
        expect(mockPrisma.$queryRaw.mock.calls.some(([query]) => Array.from(query as TemplateStringsArray)
            .join('?')
            .includes('FOR UPDATE'))).toBe(true);
    });

    it('creates a hashed single-use password reset token for migrated password users', async () => {
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'u-reset',
            tenantId: 't-1',
            email: 'legacy@example.com',
        });
        mockRbacService.getEffectiveAccess.mockResolvedValue({
            primaryRole: 'STAFF',
            roles: [],
            permissions: ['auth:login_password'],
        });
        mockPrisma.passwordResetToken.updateMany.mockResolvedValue({ count: 1 });
        mockPrisma.passwordResetToken.create.mockResolvedValue({});

        const result = await service.createPasswordReset('LegacyUser', 'demo');

        expect(result).toBeNull();
        expect(mockPrisma.passwordResetToken.updateMany).toHaveBeenCalledWith({
            where: {
                tenantId: 't-1',
                userId: 'u-reset',
                consumedAt: null,
            },
            data: { consumedAt: expect.any(Date) },
        });
        expect(mockPrisma.passwordResetEmailOutbox.updateMany).toHaveBeenCalledWith({
            where: {
                tenantId: 't-1', userId: 'u-reset', status: { in: ['PENDING', 'SENDING', 'FAILED'] },
            },
            data: {
                status: 'DEAD_LETTERED', deadLetteredAt: expect.any(Date), leaseUntil: null,
                lastError: 'Superseded by a newer password reset request',
            },
        });
        const createData = mockPrisma.passwordResetToken.create.mock.calls[0][0].data;
        expect(createData).toEqual(expect.objectContaining({
            tenantId: 't-1',
            userId: 'u-reset',
            tokenHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
            expiresAt: expect.any(Date),
        }));
        const outboxData = mockPrisma.passwordResetEmailOutbox.create.mock.calls[0][0].data;
        expect(outboxData).toEqual(expect.objectContaining({
            tenantId: 't-1',
            userId: 'u-reset',
            tokenHash: createData.tokenHash,
            encryptedPayload: expect.stringContaining('"alg":"aes-256-gcm"'),
            encryptionKeyRef: expect.stringMatching(/^[a-f0-9]{16}$/),
            expiresAt: createData.expiresAt,
        }));
        expect(outboxData.encryptedPayload).not.toContain('legacy@example.com');
        expect(outboxData.encryptedPayload).not.toContain('/auth/reset-password');
    });

    it('fails reset requests uniformly before account lookup when delivery config is unusable', async () => {
        process.env.APP_ORIGIN = '   ';
        process.env.NEXT_PUBLIC_APP_ORIGIN = '';
        process.env.NEXT_PUBLIC_APP_URL = '  ';

        await expect(service.createPasswordReset('LegacyUser', 'demo'))
            .rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
        expect(mockPrisma.passwordResetToken.create).not.toHaveBeenCalled();
        expect(mockPrisma.passwordResetEmailOutbox.create).not.toHaveBeenCalled();
    });

    it('does not create reset tokens for ineligible migrated password users', async () => {
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'u-no-email',
            tenantId: 't-1',
            email: null,
        });

        await expect(service.createPasswordReset('LegacyUser', 'demo')).resolves.toBeNull();
        expect(mockPrisma.passwordResetToken.create).not.toHaveBeenCalled();
    });

    it('consumes a password reset token, updates the hash, and revokes sessions', async () => {
        const token = 'reset_token_123456789012345678901234';
        const tokenHash = (service as any).hashPasswordResetToken(token);
        mockPrisma.passwordResetToken.findFirst.mockResolvedValue({
            id: 'prt-1',
            tenantId: 't-1',
            userId: 'u-reset',
            tokenHash,
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
            consumedAt: null,
            user: {
                id: 'u-reset',
                tenantId: 't-1',
                deletedAt: null,
                passwordHash: bcrypt.hashSync('old-password', 10),
            },
        });
        mockPrisma.passwordResetToken.updateMany.mockResolvedValue({ count: 1 });
        mockPrisma.session.findMany.mockResolvedValue([{ id: 's-1' }, { id: 's-2' }]);
        mockPrisma.session.updateMany.mockResolvedValue({ count: 2 });
        mockPrisma.user.update.mockResolvedValue({});

        await expect(service.resetPasswordWithToken(token, 'new-password-1')).resolves.toBeUndefined();

        const userUpdate = mockPrisma.user.update.mock.calls[0][0];
        expect(userUpdate.where).toEqual({ id: 'u-reset' });
        expect(bcrypt.compareSync('new-password-1', userUpdate.data.passwordHash)).toBe(true);
        expect(userUpdate.data).toEqual(expect.objectContaining({
            loginAttempts: 0,
            lockedUntil: null,
        }));
        expect(mockPrisma.session.updateMany).toHaveBeenCalledWith({
            where: {
                userId: 'u-reset',
                revokedAt: null,
            },
            data: { revokedAt: expect.any(Date) },
        });
        expect(mockPrisma.passwordResetToken.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'prt-1',
                consumedAt: null,
                expiresAt: { gt: expect.any(Date) },
            },
            data: { consumedAt: expect.any(Date) },
        });
    });

    it('rejects expired password reset tokens before updating credentials', async () => {
        const token = 'reset_token_123456789012345678901234';
        mockPrisma.passwordResetToken.findFirst.mockResolvedValue({
            id: 'prt-expired',
            tenantId: 't-1',
            userId: 'u-reset',
            expiresAt: new Date(Date.now() - 60 * 1000),
            consumedAt: null,
            user: {
                id: 'u-reset',
                tenantId: 't-1',
                deletedAt: null,
                passwordHash: bcrypt.hashSync('old-password', 10),
            },
        });

        await expect(service.resetPasswordWithToken(token, 'new-password-1')).rejects.toBeInstanceOf(UnauthorizedException);
        expect(mockPrisma.user.update).not.toHaveBeenCalled();
        expect(mockPrisma.session.updateMany).not.toHaveBeenCalled();
    });

    it('rejects invalid password reset tokens before running bcrypt', async () => {
        const hashSpy = vi.spyOn(service as any, 'hashNewPassword');
        mockPrisma.passwordResetToken.findFirst.mockResolvedValue(null);

        await expect(service.resetPasswordWithToken(
            'reset_token_123456789012345678901234',
            'new-password-1',
        )).rejects.toBeInstanceOf(UnauthorizedException);

        expect(hashSpy).not.toHaveBeenCalled();
        expect(mockPrisma.passwordResetToken.updateMany).not.toHaveBeenCalled();
    });

    it('blocks non-OIDC login when tenant security requires SSO', async () => {
        const passwordHash = bcrypt.hashSync('correct-horse', 10);
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'u-sso',
            tenantId: 't-1',
            role: 'STAFF',
            email: null,
            username: 'legacyuser',
            mfaEnabled: false,
            passwordHash,
            loginAttempts: 0,
            lockedUntil: null,
        });
        mockRbacService.getEffectiveAccess.mockResolvedValue({
            primaryRole: 'STAFF',
            roles: [],
            permissions: ['auth:login_password'],
        });
        mockPrisma.tenantSetting.findUnique.mockResolvedValue({
            value: {
                security: {
                    ssoOidcOnly: true,
                },
            },
        });

        await expect(service.loginWithUsernamePassword('LegacyUser', 'correct-horse', 'demo')).rejects.toBeInstanceOf(ForbiddenException);
        expect(mockPrisma.session.create).not.toHaveBeenCalled();
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

        await expect(service.loginWithUsernamePin('teammember', '0000', 'demo')).rejects.toBeInstanceOf(UnauthorizedException);
        expect(mockPrisma.user.update).toHaveBeenCalledWith({
            where: { id: 'u-2' },
            data: {
                pinLoginAttempts: 3,
                pinLockedUntil: null,
            },
        });
    });

    it('serializes concurrent failed PIN attempts and locks the account after five guesses', async () => {
        const account = {
            id: 'u-concurrent-pin',
            tenantId: 't-1',
            role: 'STAFF',
            email: null,
            username: 'parallel.guesses',
            mfaEnabled: false,
            pinResetRequired: false,
            pinHash: (service as any).hashPin('123456'),
            pinLoginAttempts: 0,
            pinLockedUntil: null as Date | null,
            deletedAt: null,
        };
        let transactionTail = Promise.resolve();

        mockPrisma.$transaction.mockImplementation(async (operation: (tx: typeof mockPrisma) => Promise<unknown>) => {
            let releaseTransaction!: () => void;
            const previousTransaction = transactionTail;
            transactionTail = new Promise<void>((resolve) => {
                releaseTransaction = resolve;
            });
            await previousTransaction;
            try {
                return await operation(mockPrisma);
            } finally {
                releaseTransaction();
            }
        });
        mockPrisma.user.findFirst.mockImplementation(async () => ({ ...account }));
        mockPrisma.user.update.mockImplementation(async ({ data }: { data: Partial<typeof account> }) => {
            Object.assign(account, data);
            return { ...account };
        });

        const attempts = await Promise.allSettled(
            Array.from({ length: 6 }, () => service.loginWithUsernamePin('parallel.guesses', '0000', 'demo')),
        );

        expect(attempts.filter((attempt) => attempt.status === 'rejected'
            && attempt.reason instanceof UnauthorizedException)).toHaveLength(5);
        expect(attempts.filter((attempt) => attempt.status === 'rejected'
            && attempt.reason instanceof ForbiddenException)).toHaveLength(1);
        expect(account.pinLoginAttempts).toBe(5);
        expect(account.pinLockedUntil).toBeInstanceOf(Date);
        expect(mockPrisma.user.update).toHaveBeenCalledTimes(5);
        expect(mockPrisma.$queryRaw.mock.calls.some(([query]) => Array.from(query as TemplateStringsArray)
            .join('?')
            .includes('FOR UPDATE'))).toBe(true);
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
        expect(mockPrisma.session.updateMany).toHaveBeenCalledWith({
            where: { userId: 'u-3', revokedAt: null },
            data: { revokedAt: expect.any(Date) },
        });
    });

    it('requires the rotated PIN to differ from the temporary PIN', async () => {
        await expect(service.rotateOwnPin('u-3', '1111', '1111')).rejects.toBeInstanceOf(BadRequestException);
        expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('revokes existing sessions when an administrator requires PIN rotation', async () => {
        mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });

        await service.setUserPin('u-reset', '246810', true, 't-1');

        expect(mockPrisma.session.updateMany).toHaveBeenCalledWith({
            where: { userId: 'u-reset', revokedAt: null },
            data: { revokedAt: expect.any(Date) },
        });
    });
});

describe('AuthService - MFA and refresh state', () => {
    let service: AuthService;
    let redis: any;

    beforeEach(() => {
        vi.clearAllMocks();
        resetPrismaMocks();
        mockRbacService.getEffectiveAccess.mockResolvedValue({
            primaryRole: 'STAFF',
            roles: [],
            permissions: ['dashboard:access'],
        });
        service = new AuthService(mockConfigService as any, mockJwtService as any, mockRbacService as any);
        (service as any).prisma = mockPrisma;
        redis = {
            set: vi.fn(),
            get: vi.fn().mockResolvedValue(null),
            del: vi.fn(),
            on: vi.fn(),
        };
        (service as any).redis = redis;
    });

    it('rejects arbitrary 6-digit MFA codes', async () => {
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'u-mfa',
            tenantId: 't-1',
            role: 'STAFF',
            mfaEnabled: true,
            mfaSecret: 'JBSWY3DPEHPK3PXP',
            mfaBackupCodes: [],
        });
        mockPrisma.session.findFirst.mockResolvedValue({
            id: 's-mfa',
            userId: 'u-mfa',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            revokedAt: null,
        });

        await expect(
            service.validateMfa('u-mfa', '123456', { tenantId: 't-1', sessionId: 's-mfa' }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(redis.set).not.toHaveBeenCalled();
    });

    it('blocks MFA enrollment while the session is limited to temporary PIN rotation', async () => {
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'u-temp',
            tenantId: 't-1',
            role: 'ADMIN',
            email: null,
            username: 'temporary.admin',
            pinResetRequired: true,
            mfaEnabled: false,
            mfaSecret: null,
            mfaBackupCodes: [],
        });
        mockPrisma.session.findFirst.mockResolvedValue({
            id: 's-temp',
            userId: 'u-temp',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            revokedAt: null,
        });

        await expect(service.beginMfaEnrollment(
            'u-temp',
            { tenantId: 't-1', sessionId: 's-temp' },
        )).rejects.toBeInstanceOf(ForbiddenException);

        expect(redis.set).not.toHaveBeenCalled();
    });

    it('marks the session and returns a verified access token after valid TOTP', async () => {
        const secret = 'JBSWY3DPEHPK3PXP';
        const secretBuffer = (service as any).secretToBuffer(secret);
        const code = (service as any).generateTotpCode(secretBuffer, Math.floor(Date.now() / 30_000));
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'u-mfa',
            tenantId: 't-1',
            role: 'STAFF',
            mfaEnabled: true,
            mfaSecret: secret,
            mfaBackupCodes: [],
        });
        mockPrisma.session.findFirst.mockResolvedValue({
            id: 's-mfa',
            userId: 'u-mfa',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            revokedAt: null,
        });

        const result = await service.validateMfa('u-mfa', code, { tenantId: 't-1', sessionId: 's-mfa' });

        expect(redis.set).toHaveBeenCalledWith('session_mfa:s-mfa', '1', 'EX', expect.any(Number));
        expect(mockJwtService.generateAccessToken).toHaveBeenCalledWith(expect.objectContaining({
            sub: 'u-mfa',
            sessionId: 's-mfa',
            mfaVerified: true,
        }));
        expect(result).toEqual(expect.objectContaining({ success: true, mfaVerified: true, accessToken: 'test-access-token' }));
    });

    it('atomically accepts one TOTP time-step across concurrent sessions', async () => {
        const secret = 'JBSWY3DPEHPK3PXP';
        const timeStep = Math.floor(Date.now() / 30_000);
        const code = (service as any).generateTotpCode(
            (service as any).secretToBuffer(secret),
            timeStep,
        );
        const claimedSteps = new Set<string>();
        let transactionQueue = Promise.resolve();
        mockPrisma.$transaction.mockImplementation((operation: (tx: typeof mockPrisma) => Promise<unknown>) => {
            const result = transactionQueue.then(() => operation(mockPrisma));
            transactionQueue = result.then(() => undefined, () => undefined);
            return result;
        });
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'u-mfa',
            tenantId: 't-1',
            role: 'STAFF',
            mfaEnabled: true,
            mfaSecret: secret,
            mfaBackupCodes: [],
        });
        mockPrisma.session.findFirst.mockImplementation(async ({ where }: any) => ({
            id: where.id,
            userId: 'u-mfa',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            revokedAt: null,
        }));
        mockPrisma.mfaTotpClaim.create.mockImplementation(async ({ data }: any) => {
            const identity = `${data.userId}:${data.timeStep.toString()}`;
            if (claimedSteps.has(identity)) throw { code: 'P2002' };
            claimedSteps.add(identity);
            return { id: 'totp-claim' };
        });

        const results = await Promise.allSettled([
            service.validateMfa('u-mfa', code, { tenantId: 't-1', sessionId: 's-one' }),
            service.validateMfa('u-mfa', code, { tenantId: 't-1', sessionId: 's-two' }),
        ]);

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const rejection = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
        expect(rejection.reason).toBeInstanceOf(ForbiddenException);
        expect(claimedSteps).toEqual(new Set([`u-mfa:${timeStep}`]));
        expect(redis.set).toHaveBeenCalledOnce();
    });
    it('locks and consumes one backup code for only one concurrent session', async () => {
        const backupCode = 'ABCD-EFGH';
        let storedBackupCodes = [(service as any).hashBackupCode(backupCode)];
        let transactionQueue = Promise.resolve();
        mockPrisma.$transaction.mockImplementation((operation: (tx: typeof mockPrisma) => Promise<unknown>) => {
            const result = transactionQueue.then(() => operation(mockPrisma));
            transactionQueue = result.then(() => undefined, () => undefined);
            return result;
        });
        mockPrisma.user.findFirst.mockImplementation(async () => ({
            id: 'u-mfa',
            tenantId: 't-1',
            role: 'STAFF',
            mfaEnabled: true,
            mfaSecret: 'JBSWY3DPEHPK3PXP',
            mfaBackupCodes: [...storedBackupCodes],
        }));
        mockPrisma.session.findFirst.mockImplementation(async ({ where }: any) => ({
            id: where.id,
            userId: 'u-mfa',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            revokedAt: null,
        }));
        mockPrisma.user.update.mockImplementation(async ({ data }: any) => {
            storedBackupCodes = [...data.mfaBackupCodes];
            return {};
        });

        const results = await Promise.allSettled([
            service.validateMfa('u-mfa', backupCode, { tenantId: 't-1', sessionId: 's-one' }),
            service.validateMfa('u-mfa', backupCode, { tenantId: 't-1', sessionId: 's-two' }),
        ]);

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const rejection = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
        expect(rejection.reason).toBeInstanceOf(ForbiddenException);
        expect(storedBackupCodes).toEqual([]);
        expect(mockPrisma.user.update).toHaveBeenCalledOnce();
        expect(mockPrisma.$queryRaw.mock.calls.some((call) => String(call[0]?.join?.('')).includes('FOR UPDATE'))).toBe(true);
        expect(redis.set).toHaveBeenCalledOnce();
        const verifiedSessionKey = redis.set.mock.calls[0][0];
        expect(['session_mfa:s-one', 'session_mfa:s-two']).toContain(verifiedSessionKey);
    });

    it('requires existing MFA after PIN rotation clears the reset-only state', async () => {
        mockPrisma.session.findFirst.mockResolvedValue({
            id: 's-refresh',
            userId: 'u-refresh',
            refreshToken: 'refresh-token',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            revokedAt: null,
            user: {
                id: 'u-refresh',
                tenantId: 't-1',
                role: 'STAFF',
                mfaEnabled: true,
                pinResetRequired: false,
                deletedAt: null,
            },
        });

        const result = await service.refreshAccessToken('refresh-token');

        expect(mockJwtService.generateAccessToken).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's-refresh',
            mfaVerified: false,
            pinResetRequired: false,
        }));
        expect(result).toEqual(expect.objectContaining({
            requiresMfa: true,
            mfaVerified: false,
            pinResetRequired: false,
        }));

        mockJwtService.generateAccessToken.mockClear();
        redis.get.mockResolvedValue('1');
        await service.refreshAccessToken('refresh-token');

        expect(mockJwtService.generateAccessToken).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's-refresh',
            mfaVerified: true,
        }));
    });

    it('applies tenant session timeout when creating sessions', async () => {
        mockPrisma.tenantSetting.findUnique.mockResolvedValue({
            value: {
                security: {
                    sessionTimeoutMinutes: 15,
                },
            },
        });
        const user = {
            id: 'u-session',
            tenantId: 't-1',
            role: 'STAFF',
            email: null,
            username: 'staff',
            mfaEnabled: false,
        };
        mockPrisma.session.create.mockResolvedValue({ id: 's-session', refreshToken: 'refresh-session' });
        mockPrisma.user.update.mockResolvedValue({});

        const result = await (service as any).createSessionTokens(user, {
            loginMethod: 'USERNAME_PIN',
            ipAddress: '203.0.113.44',
            userAgent: 'Vitest Browser',
        });

        expect(mockPrisma.session.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                userId: 'u-session',
                refreshToken: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
                ipAddress: '203.0.113.44',
                userAgent: 'Vitest Browser',
                expiresAt: expect.any(Date),
            }),
        });
        expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
            data: {
                tenantId: 't-1',
                userId: 'u-session',
                action: 'SESSION_CREATED',
                resource: 'Session',
                resourceId: 's-session',
                newValue: { loginMethod: 'USERNAME_PIN' },
                ipAddress: '203.0.113.44',
                userAgent: 'Vitest Browser',
            },
        });
        expect(result.refreshToken).toMatch(/^v2\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
        const [, selector, validator] = result.refreshToken.split('.');
        const storedSession = mockPrisma.session.create.mock.calls[0][0].data;
        expect(storedSession.selectorHash).toBe((service as any).hashSessionSelector(selector));
        expect(storedSession.refreshToken).toBe((service as any).hashRefreshToken(validator));
        expect(JSON.stringify(storedSession)).not.toContain(selector);
        expect(JSON.stringify(storedSession)).not.toContain(validator);
        expect(result.sessionMaxAgeMs).toBe(15 * 60 * 1000);
    });

    it('preserves legacy session-token callers without writing login method strings into IP or User-Agent fields', async () => {
        mockPrisma.session.create.mockResolvedValue({ id: 's-legacy-source', refreshToken: 'refresh-legacy-source' });
        mockPrisma.user.update.mockResolvedValue({});

        await (service as any).createSessionTokens({
            id: 'u-legacy-source',
            tenantId: 't-1',
            role: 'STAFF',
            email: null,
            username: 'staff',
            mfaEnabled: false,
        }, 'username-pin');

        expect(mockPrisma.session.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                userId: 'u-legacy-source',
                ipAddress: '',
                userAgent: '',
            }),
        });
        expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                action: 'SESSION_CREATED',
                resourceId: 's-legacy-source',
                newValue: { loginMethod: 'username-pin' },
                ipAddress: null,
                userAgent: null,
            }),
        });
    });

    it('marks initial access tokens unverified when tenant requires MFA for all users', async () => {
        mockPrisma.tenantSetting.findUnique.mockResolvedValue({
            value: {
                security: {
                    requireMfaForAll: true,
                },
            },
        });
        mockPrisma.session.create.mockResolvedValue({ id: 's-mfa-required', refreshToken: 'refresh-mfa-required' });
        mockPrisma.user.update.mockResolvedValue({});

        const result = await (service as any).createSessionTokens({
            id: 'u-required',
            tenantId: 't-1',
            role: 'STAFF',
            email: null,
            username: 'staff',
            mfaEnabled: false,
        }, 'test');

        expect(mockJwtService.generateAccessToken).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's-mfa-required',
            mfaVerified: false,
        }));
        expect(result.requiresMfa).toBe(true);
    });

    it('requires MFA for sessions with admin portal access even before enrollment', async () => {
        mockRbacService.getEffectiveAccess.mockResolvedValue({
            primaryRole: 'System Admin',
            roles: [],
            permissions: ['dashboard:access', 'admin_portal:access'],
        });
        mockPrisma.session.create.mockResolvedValue({ id: 's-admin', refreshToken: 'refresh-admin' });
        mockPrisma.user.update.mockResolvedValue({});

        const result = await (service as any).createSessionTokens({
            id: 'u-admin',
            tenantId: 't-1',
            role: 'SUPER_ADMIN',
            email: 'admin@example.com',
            username: null,
            mfaEnabled: false,
        }, 'test');

        expect(mockJwtService.generateAccessToken).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's-admin',
            mfaVerified: false,
        }));
        expect(result.requiresMfa).toBe(true);
    });

    it.each([
        'users:write',
        'users:admin',
        'roles:write',
        'roles:assign',
        'billing:write',
        'settings:write',
        'tenant_account:lifecycle',
        'account:data_export',
    ])('treats %s as a privileged MFA-gated tenant permission', (permission) => {
        expect((service as any).isPrivilegedMfaRequiredForAccess({
            permissions: ['dashboard:access', permission],
        })).toBe(true);
    });

    it('requires MFA for privileged tenant operations even without platform admin access', async () => {
        mockRbacService.getEffectiveAccess.mockResolvedValue({
            primaryRole: 'Admin',
            roles: [],
            permissions: ['dashboard:access', 'settings:write'],
        });
        mockPrisma.session.create.mockResolvedValue({ id: 's-settings-admin', refreshToken: 'refresh-settings-admin' });
        mockPrisma.user.update.mockResolvedValue({});

        const result = await (service as any).createSessionTokens({
            id: 'u-settings-admin',
            tenantId: 't-1',
            role: 'ADMIN',
            email: 'admin@example.com',
            username: null,
            mfaEnabled: false,
        }, { loginMethod: 'EMAIL_OTP' });

        expect(mockJwtService.generateAccessToken).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's-settings-admin',
            mfaVerified: false,
        }));
        expect(result.requiresMfa).toBe(true);
    });

    it('looks up refresh sessions by the hashed bearer token', async () => {
        const rawRefreshToken = 'refresh-token';
        mockPrisma.session.findFirst.mockResolvedValue({
            id: 's-refresh',
            userId: 'u-refresh',
            refreshToken: (service as any).hashRefreshToken(rawRefreshToken),
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            revokedAt: null,
            user: {
                id: 'u-refresh',
                tenantId: 't-1',
                role: 'STAFF',
                mfaEnabled: false,
                deletedAt: null,
            },
        });

        const result = await service.refreshAccessToken(rawRefreshToken);

        expect(mockPrisma.session.findFirst).toHaveBeenCalledWith({
            where: {
                refreshToken: {
                    in: [
                        (service as any).hashRefreshToken(rawRefreshToken),
                        rawRefreshToken,
                    ],
                },
            },
            include: { user: true },
        });
        expect(mockJwtService.generateAccessToken).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's-refresh',
        }));
        expect(mockPrisma.session.updateMany).toHaveBeenCalledWith({
            where: {
                id: 's-refresh',
                refreshToken: {
                    in: [
                        (service as any).hashRefreshToken(rawRefreshToken),
                        rawRefreshToken,
                    ],
                },
                revokedAt: null,
                expiresAt: { gt: expect.any(Date) },
            },
            data: {
                selectorHash: expect.stringMatching(/^selector-sha256:[a-f0-9]{64}$/),
                refreshToken: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
            },
        });
        expect(result.refreshToken).toMatch(/^v2\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
        const [, selector, validator] = result.refreshToken.split('.');
        expect((service as any).hashSessionSelector(selector)).toBe(
            mockPrisma.session.updateMany.mock.calls[0][0].data.selectorHash,
        );
        expect((service as any).hashRefreshToken(validator)).toBe(
            mockPrisma.session.updateMany.mock.calls[0][0].data.refreshToken,
        );
        expect(result.csrfToken).toBe('test-csrf-token');
    });

    it('keeps the opaque selector stable while rotating only the refresh validator', async () => {
        const credential = (service as any).generateSelectedRefreshCredential();
        mockPrisma.session.findFirst.mockResolvedValue({
            id: 's-selected',
            userId: 'u-refresh',
            selectorHash: credential.selectorHash,
            refreshToken: credential.validatorHash,
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            revokedAt: null,
            user: {
                id: 'u-refresh',
                tenantId: 't-1',
                role: 'STAFF',
                mfaEnabled: false,
                deletedAt: null,
            },
        });

        const result = await service.refreshAccessToken(credential.token);
        const [, rotatedSelector, rotatedValidator] = result.refreshToken.split('.');

        expect(rotatedSelector).toBe(credential.selector);
        expect(rotatedValidator).not.toBe(credential.validator);
        expect(mockPrisma.session.findFirst).toHaveBeenCalledWith({
            where: {
                selectorHash: credential.selectorHash,
                refreshToken: credential.validatorHash,
            },
            include: { user: true },
        });
        expect(mockPrisma.session.updateMany).toHaveBeenCalledWith({
            where: {
                id: 's-selected',
                selectorHash: credential.selectorHash,
                refreshToken: credential.validatorHash,
                revokedAt: null,
                expiresAt: { gt: expect.any(Date) },
            },
            data: { refreshToken: (service as any).hashRefreshToken(rotatedValidator) },
        });
    });

    it('revokes by stable selector when logout races refresh rotation', async () => {
        const credential = (service as any).generateSelectedRefreshCredential();
        let revokedAt: Date | null = null;
        mockPrisma.session.findFirst.mockImplementation(async ({ where, include }: any) => {
            if (where.selectorHash !== credential.selectorHash) return null;
            if (include && where.refreshToken !== credential.validatorHash) return null;
            return {
                id: 's-race',
                userId: 'u-refresh',
                selectorHash: credential.selectorHash,
                refreshToken: credential.validatorHash,
                createdAt: new Date(),
                expiresAt: new Date(Date.now() + 15 * 60 * 1000),
                revokedAt,
                ...(include ? {
                    user: {
                        id: 'u-refresh',
                        tenantId: 't-1',
                        role: 'STAFF',
                        mfaEnabled: false,
                        deletedAt: null,
                    },
                } : {}),
            };
        });
        mockPrisma.session.updateMany.mockImplementation(async ({ where, data }: any) => {
            if (data.refreshToken) {
                await Promise.resolve();
                if (revokedAt || where.refreshToken !== credential.validatorHash) return { count: 0 };
                return { count: 1 };
            }
            if (where.selectorHash !== credential.selectorHash || revokedAt) return { count: 0 };
            revokedAt = data.revokedAt;
            return { count: 1 };
        });

        const [refreshResult, logoutResult] = await Promise.allSettled([
            service.refreshAccessToken(credential.token),
            service.revokeSessionByRefreshToken(credential.token),
        ]);

        expect(logoutResult).toEqual({
            status: 'fulfilled',
            value: { status: 'revoked' },
        });
        expect(revokedAt).toBeInstanceOf(Date);
        expect(['fulfilled', 'rejected']).toContain(refreshResult.status);
        const logoutUpdate = mockPrisma.session.updateMany.mock.calls
            .map(([call]) => call)
            .find((call) => call.data.revokedAt);
        expect(logoutUpdate.where).toEqual({
            id: 's-race',
            selectorHash: credential.selectorHash,
            revokedAt: null,
            expiresAt: { gt: expect.any(Date) },
        });
        expect(JSON.stringify(logoutUpdate.where)).not.toContain(credential.selector);
    });
    it('rejects refresh-token replay when atomic rotation loses the race', async () => {
        const rawRefreshToken = 'refresh-token';
        mockPrisma.session.findFirst.mockResolvedValue({
            id: 's-refresh',
            userId: 'u-refresh',
            refreshToken: (service as any).hashRefreshToken(rawRefreshToken),
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            revokedAt: null,
            user: {
                id: 'u-refresh',
                tenantId: 't-1',
                role: 'STAFF',
                mfaEnabled: false,
                deletedAt: null,
            },
        });
        mockPrisma.session.updateMany.mockResolvedValue({ count: 0 });

        await expect(service.refreshAccessToken(rawRefreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
        expect(mockJwtService.generateAccessToken).not.toHaveBeenCalled();
    });


    it('revokes the active session identified by a hashed refresh bearer token', async () => {
        const rawRefreshToken = 'logout-refresh-token';
        mockPrisma.session.findFirst.mockResolvedValue({
            id: 's-logout',
            refreshToken: (service as any).hashRefreshToken(rawRefreshToken),
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            revokedAt: null,
        });

        await expect(service.revokeSessionByRefreshToken(rawRefreshToken))
            .resolves.toEqual({ status: 'revoked' });

        expect(mockPrisma.session.updateMany).toHaveBeenCalledWith({
            where: {
                id: 's-logout',
                revokedAt: null,
                expiresAt: { gt: expect.any(Date) },
            },
            data: { revokedAt: expect.any(Date) },
        });
        expect((service as any).redis.del).toHaveBeenCalledWith('session_mfa:s-logout');
    });

    it('returns an authoritative already-invalid result without exposing token details', async () => {
        mockPrisma.session.findFirst.mockResolvedValue(null);

        await expect(service.revokeSessionByRefreshToken('unknown-refresh-token'))
            .resolves.toEqual({ status: 'already_invalid' });
        await expect(service.revokeSessionByRefreshToken(undefined))
            .resolves.toEqual({ status: 'already_invalid' });

        expect(mockPrisma.session.updateMany).not.toHaveBeenCalled();
    });
    it('enrolls MFA for an authenticated session and returns one-time backup codes', async () => {
        const session = {
            id: 's-enroll',
            userId: 'u-enroll',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            revokedAt: null,
        };
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'u-enroll',
            tenantId: 't-1',
            role: 'ADMIN',
            email: 'admin@example.com',
            username: null,
            mfaEnabled: false,
            mfaSecret: null,
            mfaBackupCodes: [],
        });
        mockPrisma.session.findFirst.mockResolvedValue(session);
        mockPrisma.user.update.mockResolvedValue({});

        const enrollment = await service.beginMfaEnrollment('u-enroll', { tenantId: 't-1', sessionId: 's-enroll' });
        const secretBuffer = (service as any).secretToBuffer(enrollment.secret);
        const code = (service as any).generateTotpCode(secretBuffer, Math.floor(Date.now() / 30_000));
        redis.get.mockResolvedValue(enrollment.secret);
        process.env.MFA_SECRET_ENCRYPTION_KEY = 'mfa-test-key-with-enough-entropy';

        const result = await service.confirmMfaEnrollment('u-enroll', code, { tenantId: 't-1', sessionId: 's-enroll' });
        const storedMfaSecret = mockPrisma.user.update.mock.calls[0][0].data.mfaSecret;

        expect(enrollment.secret).toMatch(/^[A-Z2-7]{32}$/);
        expect(enrollment.otpauthUrl).toContain('otpauth://totp/');
        expect(mockPrisma.user.update).toHaveBeenCalledWith({
            where: { id: 'u-enroll' },
            data: expect.objectContaining({
                mfaEnabled: true,
                mfaSecret: expect.stringMatching(/^enc:v1:/),
                mfaBackupCodes: expect.arrayContaining([expect.stringMatching(/^[a-f0-9]+:[a-f0-9]+$/i)]),
            }),
        });
        expect(storedMfaSecret).not.toBe(enrollment.secret);
        expect((service as any).verifyTotpCode(storedMfaSecret, code)).toBe(true);
        expect(mockPrisma.mfaTotpClaim.create).toHaveBeenCalledWith({
            data: {
                tenantId: 't-1',
                userId: 'u-enroll',
                timeStep: expect.any(BigInt),
            },
        });
        expect(redis.del).toHaveBeenCalledWith('mfa_enrollment:s-enroll:u-enroll');
        expect(redis.set).toHaveBeenCalledWith('session_mfa:s-enroll', '1', 'EX', expect.any(Number));
        expect(result.backupCodes).toHaveLength(10);
        expect(result).toEqual(expect.objectContaining({ success: true, mfaVerified: true, accessToken: 'test-access-token' }));
    });

    it('disables MFA with a backup code without creating a TOTP claim', async () => {
        const backupCode = 'ABCD-EFGH-IJKL';
        const backupHash = (service as any).hashBackupCode(backupCode);
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'u-disable',
            tenantId: 't-1',
            role: 'STAFF',
            email: 'staff@example.com',
            username: null,
            pinResetRequired: false,
            mfaEnabled: true,
            mfaSecret: 'JBSWY3DPEHPK3PXP',
            mfaBackupCodes: [backupHash],
        });
        mockPrisma.session.findFirst.mockResolvedValue({
            id: 's-disable',
            userId: 'u-disable',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            revokedAt: null,
        });
        mockPrisma.session.findMany.mockResolvedValue([{ id: 's-disable' }]);
        mockPrisma.user.update.mockResolvedValue({});

        await expect(service.disableMfa(
            'u-disable',
            backupCode,
            { tenantId: 't-1', sessionId: 's-disable' },
        )).resolves.toEqual({ success: true, mfaEnabled: false });

        expect(mockPrisma.mfaTotpClaim.create).not.toHaveBeenCalled();
        expect(mockPrisma.user.update).toHaveBeenCalledWith({
            where: { id: 'u-disable' },
            data: {
                mfaEnabled: false,
                mfaSecret: null,
                mfaBackupCodes: [],
            },
        });
        expect(redis.del).toHaveBeenCalledWith('session_mfa:s-disable');
    });

    it('clears MFA verification markers for every session when MFA is disabled', async () => {
        const backupCode = 'ABCD-EFGH-IJKL';
        const backupHash = (service as any).hashBackupCode(backupCode);
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'u-disable',
            tenantId: 't-1',
            role: 'STAFF',
            email: 'staff@example.com',
            username: null,
            pinResetRequired: false,
            mfaEnabled: true,
            mfaSecret: 'JBSWY3DPEHPK3PXP',
            mfaBackupCodes: [backupHash],
        });
        mockPrisma.session.findFirst.mockResolvedValue({
            id: 's-current',
            userId: 'u-disable',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            revokedAt: null,
        });
        mockPrisma.session.findMany.mockResolvedValue([
            { id: 's-current' },
            { id: 's-other' },
        ]);

        await service.disableMfa(
            'u-disable',
            backupCode,
            { tenantId: 't-1', sessionId: 's-current' },
        );

        expect(mockPrisma.session.findMany).toHaveBeenCalledWith({
            where: { userId: 'u-disable' },
            select: { id: true },
        });
        expect(redis.del).toHaveBeenCalledTimes(1);
        expect(redis.del).toHaveBeenCalledWith(
            'session_mfa:s-current',
            'session_mfa:s-other',
        );
    });

    it('does not allow admin portal users to disable required MFA', async () => {
        mockRbacService.getEffectiveAccess.mockResolvedValue({
            primaryRole: 'System Admin',
            roles: [],
            permissions: ['dashboard:access', 'admin_portal:access'],
        });
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'u-admin',
            tenantId: 't-1',
            role: 'SUPER_ADMIN',
            email: 'admin@example.com',
            username: null,
            mfaEnabled: true,
            mfaSecret: 'JBSWY3DPEHPK3PXP',
            mfaBackupCodes: [],
        });
        mockPrisma.session.findFirst.mockResolvedValue({
            id: 's-admin',
            userId: 'u-admin',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            revokedAt: null,
        });

        await expect(service.disableMfa('u-admin', '123456', { tenantId: 't-1', sessionId: 's-admin' }))
            .rejects
            .toBeInstanceOf(ForbiddenException);
        expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });
});

describe('AuthService - managed MFA encryption keys', () => {
    let service: AuthService;

    beforeEach(() => {
        vi.clearAllMocks();
        resetPrismaMocks();
        delete process.env.MFA_SECRET_ENCRYPTION_KEY;
        delete process.env.MFA_SECRET_ENCRYPTION_KEY_CURRENT;
        delete process.env.MFA_SECRET_ENCRYPTION_KEY_PREVIOUS;
        service = new AuthService(mockConfigService as any, mockJwtService as any, mockRbacService as any);
        (service as any).prisma = mockPrisma;
    });

    it('writes versioned envelopes with the current managed key reference', () => {
        process.env.MFA_SECRET_ENCRYPTION_KEY_CURRENT = Buffer.alloc(32, 0x11).toString('base64');
        const stored = (service as any).encryptMfaSecret('JBSWY3DPEHPK3PXP');

        expect(stored).toMatch(/^enc:v2:[a-f0-9]{16}:/);
        expect((service as any).decryptMfaSecret(stored)).toBe('JBSWY3DPEHPK3PXP');
    });

    it('decrypts previous-key envelopes only during configured overlap', () => {
        const previous = Buffer.alloc(32, 0x22).toString('base64');
        const current = Buffer.alloc(32, 0x33).toString('base64');
        process.env.MFA_SECRET_ENCRYPTION_KEY_CURRENT = previous;
        const stored = (service as any).encryptMfaSecret('JBSWY3DPEHPK3PXP');

        process.env.MFA_SECRET_ENCRYPTION_KEY_CURRENT = current;
        process.env.MFA_SECRET_ENCRYPTION_KEY_PREVIOUS = previous;
        expect((service as any).decryptMfaSecret(stored)).toBe('JBSWY3DPEHPK3PXP');

        delete process.env.MFA_SECRET_ENCRYPTION_KEY_PREVIOUS;
        expect((service as any).decryptMfaSecret(stored)).toBeNull();
    });

    it('keeps legacy v1 overlap readable while managed keys are introduced', () => {
        process.env.MFA_SECRET_ENCRYPTION_KEY = 'legacy-mfa-key';
        const stored = (service as any).encryptMfaSecret('JBSWY3DPEHPK3PXP');
        expect(stored).toMatch(/^enc:v1:/);

        process.env.MFA_SECRET_ENCRYPTION_KEY_CURRENT = Buffer.alloc(32, 0x44).toString('base64');
        expect((service as any).decryptMfaSecret(stored)).toBe('JBSWY3DPEHPK3PXP');
    });

    it('rejects malformed and duplicate managed keys', () => {
        process.env.MFA_SECRET_ENCRYPTION_KEY_CURRENT = 'short';
        expect(() => (service as any).encryptMfaSecret('JBSWY3DPEHPK3PXP'))
            .toThrow(/must decode to 32 bytes/);

        const duplicate = Buffer.alloc(32, 0x55).toString('base64');
        process.env.MFA_SECRET_ENCRYPTION_KEY_CURRENT = duplicate;
        process.env.MFA_SECRET_ENCRYPTION_KEY_PREVIOUS = duplicate;
        expect(() => (service as any).encryptMfaSecret('JBSWY3DPEHPK3PXP'))
            .toThrow(/must differ/);
    });
});
