import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { runSerializableMutationWithRetry } from './serializable-mutation';
import { freezeMutationActor } from './current-mutation';
import { AuthService } from './auth.service';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { secureHttpRequest } from '../common/secure-http-client';
import { PUBLIC_LEGAL_MANIFEST } from '@lunchlineup/config';

const CURRENT_TERMS_VERSION = PUBLIC_LEGAL_MANIFEST.documents.terms.version;
const CURRENT_PRIVACY_VERSION = PUBLIC_LEGAL_MANIFEST.documents.privacy.version;

vi.mock('../common/secure-http-client', () => ({
    secureHttpRequest: vi.fn(),
}));

const secureHttpRequestMock = vi.mocked(secureHttpRequest);

beforeEach(() => {
    vi.stubEnv('PLATFORM_ADMIN_DB_CONTEXT_SECRET', 'test-capability');
});

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
    PLATFORM_ADMIN_DB_CONTEXT_SECRET: process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET,
    BETA_DEMO_MFA_BYPASS_ENABLED: process.env.BETA_DEMO_MFA_BYPASS_ENABLED,
};

vi.mock('ioredis', () => ({
    default: vi.fn().mockImplementation(function RedisMock() {
        return {
            on: vi.fn(),
            disconnect: vi.fn(),
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
    // Existing PIN-domain cases model the final authorized operation only;
    // they are not a current-policy/MFA proof for the shared two-pass wrapper.
    runCurrentMutation: vi.fn(async (options: any, authorize: any, operation: any) => {
        const actor = freezeMutationActor(options.actor);
        return runSerializableMutationWithRetry(() => mockPrisma.$transaction(async (tx: any) =>
            operation(tx, await authorize(tx, actor), () => {}, actor),
        { isolationLevel: 'Serializable' }), {
            conflictMessage: options.conflictMessage ?? 'Authorization or access state changed concurrently; retry the request',
            isConflict: options.isConflict,
        });
    }),
    getEffectiveAccess: vi.fn(),
    getEffectiveAccessInTransaction: vi.fn((_tx: unknown, userId: string, tenantId: string) =>
        mockRbacService.getEffectiveAccess(userId, tenantId)),
    assignLegacySystemRole: vi.fn(),
    provisionLegacySystemRole: vi.fn(),
    authorizeUserAdministrationInTransaction: vi.fn(),
    authorizeSelfSecurityMutationInTransaction: vi.fn(),
};

describe('AuthService lifecycle', () => {
    it('disconnects a lazily created Redis client during module shutdown', () => {
        const service = new AuthService(
            mockConfigService as any,
            mockJwtService as any,
            mockRbacService as any,
        );
        const redis = { disconnect: vi.fn() };
        (service as any).redis = redis;

        service.onModuleDestroy();

        expect(redis.disconnect).toHaveBeenCalledWith(false);
    });
});

const mockPrisma = {
    $executeRaw: vi.fn(),
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
        deleteMany: vi.fn(),
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        findMany: vi.fn(),
        updateMany: vi.fn(),
    },
    refreshTokenReplay: {
        create: vi.fn(),
        findUnique: vi.fn(),
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
    secureHttpRequestMock.mockReset();
    vi.useRealTimers();
});

function resetPrismaMocks() {
    mockPrisma.$executeRaw.mockReset().mockResolvedValue(1);
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
    mockPrisma.session.deleteMany.mockReset().mockResolvedValue({ count: 0 });
    mockPrisma.session.findUnique.mockReset();
    mockPrisma.session.findFirst.mockReset();
    mockPrisma.session.findMany.mockReset().mockResolvedValue([]);
    mockPrisma.session.updateMany.mockReset().mockResolvedValue({ count: 1 });
    mockPrisma.refreshTokenReplay.create.mockReset();
    mockPrisma.refreshTokenReplay.findUnique.mockReset().mockResolvedValue(null);
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

// These three legacy reset tests model a current locked account and a
// successful SQL-clock claim. The separate current-authority suite exercises
// stale reads, advancing expiry, selectors and transaction-private effects.
function installCurrentPasswordResetStatementMocks() {
    mockPrisma.user.findFirst.mockResolvedValue({ id:'u-reset', tenantId:'t-1', email:'reset@example.com',
        deletedAt:null, suspendedAt:null, passwordHash:'existing-password-hash' });
    mockPrisma.$queryRaw.mockImplementation(async (sql: TemplateStringsArray, ...values: unknown[]) =>
        sql.join('').includes('UPDATE "PasswordResetToken"')
            ? [{ id:values[0], consumedAt:new Date() }] : [{ id:'locked-current-row' }]);
}

function installAuditFailureRollbackHarness(
    account: Record<string, any>,
    sessions: Array<{ id: string; userId: string; revokedAt: Date | null }>,
    auditFailure: Error,
) {
    const auditCreate = vi.fn().mockRejectedValue(auditFailure);
    mockPrisma.$transaction.mockImplementation(async (operation: (tx: typeof mockPrisma) => Promise<unknown>) => {
        const draftAccount = { ...account };
        const draftSessions = sessions.map((session) => ({ ...session }));
        const tx = {
            ...mockPrisma,
            $executeRaw: vi.fn().mockResolvedValue(1),
            $queryRaw: vi.fn().mockResolvedValue([{ id: account.id }]),
            user: {
                ...mockPrisma.user,
                findFirst: vi.fn().mockImplementation(async () => ({ ...draftAccount })),
                update: vi.fn().mockImplementation(async ({ data }: any) => {
                    Object.assign(draftAccount, data);
                    return { ...draftAccount };
                }),
                updateMany: vi.fn().mockImplementation(async ({ data }: any) => {
                    Object.assign(draftAccount, data);
                    return { count: 1 };
                }),
            },
            session: {
                ...mockPrisma.session,
                findFirst: vi.fn().mockImplementation(async ({ where }: any) => {
                    const selected = draftSessions.find(session => session.id === where.id && session.userId === where.userId);
                    return selected ? { ...selected } : null;
                }),
                findMany: vi.fn().mockImplementation(async () => draftSessions
                    .filter((session) => session.revokedAt === null)
                    .map(({ id }) => ({ id }))),
                updateMany: vi.fn().mockImplementation(async ({ data }: any) => {
                    let count = 0;
                    for (const session of draftSessions) {
                        if (session.revokedAt !== null) continue;
                        Object.assign(session, data);
                        count += 1;
                    }
                    return { count };
                }),
            },
            auditLog: { create: auditCreate },
        };

        const result = await operation(tx as any);
        Object.assign(account, draftAccount);
        sessions.splice(0, sessions.length, ...draftSessions);
        return result;
    });
    return auditCreate;
}

function installSelectedRefreshSessionHarness(credential: {
    selectorHash: string;
    validatorHash: string;
}) {
    const state = {
        id: 's-refresh-family',
        userId: 'u-refresh',
        selectorHash: credential.selectorHash,
        refreshToken: credential.validatorHash,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        revokedAt: null as Date | null,
        user: {
            id: 'u-refresh',
            tenantId: 't-1',
            role: 'STAFF',
            mfaEnabled: false,
            pinResetRequired: false,
            deletedAt: null,
        },
    };
    const usedValidators = new Set<string>();
    let transactionQueue = Promise.resolve();

    mockPrisma.$transaction.mockImplementation((operation: (tx: typeof mockPrisma) => Promise<unknown>) => {
        const result = transactionQueue.then(() => operation(mockPrisma));
        transactionQueue = result.then(() => undefined, () => undefined);
        return result;
    });
    mockPrisma.session.findFirst.mockImplementation(async ({ where }: any) => {
        if (where.id && where.id !== state.id) return null;
        if (where.selectorHash && where.selectorHash !== state.selectorHash) return null;
        if (typeof where.refreshToken === 'string' && where.refreshToken !== state.refreshToken) return null;
        if (where.refreshToken?.in && !where.refreshToken.in.includes(state.refreshToken)) return null;
        return { ...state, user: { ...state.user } };
    });
    mockPrisma.refreshTokenReplay.findUnique.mockImplementation(async ({ where }: any) => (
        usedValidators.has(where.validatorHash)
            ? { sessionId: state.id }
            : null
    ));
    mockPrisma.refreshTokenReplay.create.mockImplementation(async ({ data }: any) => {
        usedValidators.add(data.validatorHash);
        return { id: `replay-${usedValidators.size}`, ...data };
    });
    mockPrisma.session.updateMany.mockImplementation(async ({ where, data }: any) => {
        if (where.id !== state.id || state.revokedAt) return { count: 0 };
        if (where.selectorHash && where.selectorHash !== state.selectorHash) return { count: 0 };
        if (typeof where.refreshToken === 'string' && where.refreshToken !== state.refreshToken) return { count: 0 };
        if (data.refreshToken) state.refreshToken = data.refreshToken;
        if (data.revokedAt) state.revokedAt = data.revokedAt;
        return { count: 1 };
    });

    return { state, usedValidators };
}
function installLegacyRefreshSessionHarness(storedRefreshToken: string) {
    const state = {
        id: 's-legacy-refresh-family',
        userId: 'u-refresh',
        selectorHash: null as string | null,
        refreshToken: storedRefreshToken,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        revokedAt: null as Date | null,
        user: {
            id: 'u-refresh',
            tenantId: 't-1',
            role: 'STAFF',
            mfaEnabled: false,
            pinResetRequired: false,
            deletedAt: null,
        },
    };
    const usedValidators = new Set<string>();
    let transactionQueue = Promise.resolve();

    mockPrisma.$transaction.mockImplementation((operation: (tx: typeof mockPrisma) => Promise<unknown>) => {
        const result = transactionQueue.then(() => operation(mockPrisma));
        transactionQueue = result.then(() => undefined, () => undefined);
        return result;
    });
    mockPrisma.session.findFirst.mockImplementation(async ({ where, select }: any) => {
        if (where.id && where.id !== state.id) return null;
        if (where.selectorHash && where.selectorHash !== state.selectorHash) return null;
        if (where.refreshToken?.in && !where.refreshToken.in.includes(state.refreshToken)) return null;
        if (select) return { id: state.id };
        return { ...state, user: { ...state.user } };
    });
    mockPrisma.refreshTokenReplay.findUnique.mockImplementation(async ({ where }: any) => (
        usedValidators.has(where.validatorHash)
            ? { sessionId: state.id }
            : null
    ));
    mockPrisma.refreshTokenReplay.create.mockImplementation(async ({ data }: any) => {
        usedValidators.add(data.validatorHash);
        return { id: `legacy-replay-${usedValidators.size}`, ...data };
    });
    mockPrisma.session.updateMany.mockImplementation(async ({ where, data }: any) => {
        if (where.id !== state.id || state.revokedAt) return { count: 0 };
        if (where.selectorHash && where.selectorHash !== state.selectorHash) return { count: 0 };
        if (where.refreshToken?.in && !where.refreshToken.in.includes(state.refreshToken)) return { count: 0 };
        if (data.selectorHash) state.selectorHash = data.selectorHash;
        if (data.refreshToken) state.refreshToken = data.refreshToken;
        if (data.revokedAt) state.revokedAt = data.revokedAt;
        return { count: 1 };
    });

    return { state, usedValidators };
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

        mockPrisma.user.findFirst.mockResolvedValueOnce(null).mockResolvedValue({
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
        expect(mockPrisma.user.findFirst).toHaveBeenCalledWith({
            where: { tenantId: 't-1', email: 'existing@example.com', deletedAt: null, suspendedAt: null },
        });
        expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'user-existing',
                tenantId: 't-1',
                oidcIssuer: null,
                oidcSubject: null,
                deletedAt: null,
                suspendedAt: null,
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

describe('AuthService - OIDC provider HTTP boundaries', () => {
    let service: AuthService;

    beforeEach(() => {
        vi.clearAllMocks();
        secureHttpRequestMock.mockReset();
        service = new AuthService(mockConfigService as any, mockJwtService as any, mockRbacService as any);
    });

    it('passes fixed deadline and response bounds to the OIDC token endpoint', async () => {
        secureHttpRequestMock.mockResolvedValue(new Response(JSON.stringify({
            access_token: 'provider-access-token',
        }), { status: 200 }));

        await expect((service as any).exchangeCode('https://auth.example.com/o/oauth2/token', {
            code: 'authorization-code',
            client_secret: 'client-secret',
        })).resolves.toEqual({ access_token: 'provider-access-token' });

        expect(secureHttpRequestMock).toHaveBeenCalledOnce();
        const [url, options] = secureHttpRequestMock.mock.calls[0];
        expect(url).toBe('https://auth.example.com/o/oauth2/token');
        expect(options).toMatchObject({
            method: 'POST',
            timeoutMs: 8_000,
            maxResponseBytes: 32 * 1024,
            redirect: 'error',
        });
        const params = new URLSearchParams(options?.body);
        expect(params.get('code')).toBe('authorization-code');
        expect(params.get('client_secret')).toBe('client-secret');
    });

    it.each([
        ['aborted', new DOMException('request aborted', 'AbortError')],
        ['oversized', new Error('Outbound response exceeded size limit: token-provider-secret')],
    ])('maps a %s OIDC token endpoint to the fixed unauthorized contract', async (_case, providerError) => {
        secureHttpRequestMock.mockRejectedValue(providerError);

        await expect((service as any).exchangeCode('https://auth.example.com/o/oauth2/token', {
            code: 'authorization-code',
        })).rejects.toMatchObject({
            status: 401,
            message: 'OIDC token exchange failed',
        });
    });

    it('times out a stalled OIDC token endpoint at the auth request deadline', async () => {
        vi.useFakeTimers();
        secureHttpRequestMock.mockImplementation(() => new Promise<Response>(() => undefined));

        const rejection = expect((service as any).exchangeCode(
            'https://auth.example.com/o/oauth2/token',
            { code: 'authorization-code' },
        )).rejects.toMatchObject({
            status: 401,
            message: 'OIDC token exchange failed',
        });
        await vi.advanceTimersByTimeAsync(8_000);
        await rejection;
    });

    it('rejects malformed or invalid-shape OIDC token responses', async () => {
        secureHttpRequestMock
            .mockResolvedValueOnce(new Response('{not-json', { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 42 }), { status: 200 }));

        const request = () => (service as any).exchangeCode('https://auth.example.com/o/oauth2/token', {
            code: 'authorization-code',
        });
        await expect(request()).rejects.toBeInstanceOf(UnauthorizedException);
        await expect(request()).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('passes fixed deadline, response bounds, and bearer authorization to userinfo', async () => {
        secureHttpRequestMock.mockResolvedValue(new Response(JSON.stringify({
            sub: 'subject-1',
            email: 'user@example.com',
            email_verified: true,
        }), { status: 200 }));

        await expect((service as any).fetchUserInfo(
            'https://auth.example.com',
            'provider-access-token',
        )).resolves.toEqual({
            sub: 'subject-1',
            email: 'user@example.com',
            email_verified: true,
        });

        expect(secureHttpRequestMock).toHaveBeenCalledWith(
            'https://auth.example.com/o/oauth2/userinfo',
            expect.objectContaining({
                headers: { Authorization: 'Bearer provider-access-token' },
                timeoutMs: 8_000,
                maxResponseBytes: 64 * 1024,
                redirect: 'error',
            }),
        );
    });

    it.each([
        ['aborted', new DOMException('request aborted', 'AbortError')],
        ['oversized', new Error('Outbound response exceeded size limit: userinfo-provider-secret')],
    ])('maps a %s OIDC userinfo endpoint to the fixed unauthorized contract', async (_case, providerError) => {
        secureHttpRequestMock.mockRejectedValue(providerError);

        await expect((service as any).fetchUserInfo(
            'https://auth.example.com',
            'provider-access-token',
        )).rejects.toMatchObject({
            status: 401,
            message: 'Failed to fetch user info',
        });
    });

    it('times out a stalled OIDC userinfo endpoint at the auth request deadline', async () => {
        vi.useFakeTimers();
        secureHttpRequestMock.mockImplementation(() => new Promise<Response>(() => undefined));

        const rejection = expect((service as any).fetchUserInfo(
            'https://auth.example.com',
            'provider-access-token',
        )).rejects.toMatchObject({
            status: 401,
            message: 'Failed to fetch user info',
        });
        await vi.advanceTimersByTimeAsync(8_000);
        await rejection;
    });

    it('rejects malformed or non-object OIDC userinfo responses', async () => {
        secureHttpRequestMock
            .mockResolvedValueOnce(new Response('{not-json', { status: 200 }))
            .mockResolvedValueOnce(new Response('[]', { status: 200 }));

        const request = () => (service as any).fetchUserInfo(
            'https://auth.example.com',
            'provider-access-token',
        );
        await expect(request()).rejects.toBeInstanceOf(UnauthorizedException);
        await expect(request()).rejects.toBeInstanceOf(UnauthorizedException);
    });
});

describe('AuthService - OIDC state', () => {
    let service: AuthService;
    let redis: any;
    let states: Map<string, string>;

    beforeEach(() => {
        vi.clearAllMocks();
        resetPrismaMocks();
        service = new AuthService(mockConfigService as any, mockJwtService as any, mockRbacService as any);
        (service as any).prisma = mockPrisma;
        states = new Map();
        redis = {
            set: vi.fn(async (key: string, payload: string) => { states.set(key, payload); return 'OK'; }),
            get: vi.fn(async (key: string) => states.get(key) ?? null),
            getdel: vi.fn(async (key: string) => {
                const payload = states.get(key) ?? null;
                states.delete(key);
                return payload;
            }),
            del: vi.fn(async (key: string) => states.delete(key) ? 1 : 0),
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

        await expect(service.consumeOidcState(oidcState.state, oidcState.correlationNonce)).resolves.toEqual({
            nextPath: '/dashboard',
            tenantSlug: 'demo',
            createdAt: expect.any(Number),
        });
        expect(redis.getdel).toHaveBeenCalledWith(`oidc_state:${oidcState.state}`);
        expect(redis.get).not.toHaveBeenCalled();
        expect(redis.del).not.toHaveBeenCalled();

        await expect(service.consumeOidcState(oidcState.state, oidcState.correlationNonce))
            .rejects
            .toBeInstanceOf(UnauthorizedException);
    });

    it('rejects state redemption from a browser without the initiating correlation nonce', async () => {
        const oidcState = await service.createOidcState('/dashboard', 'demo');
        const otherBrowserNonce = oidcState.correlationNonce === 'b'.repeat(64)
            ? 'c'.repeat(64)
            : 'b'.repeat(64);

        await expect(service.consumeOidcState(oidcState.state, otherBrowserNonce))
            .rejects
            .toBeInstanceOf(UnauthorizedException);

        expect(redis.getdel).toHaveBeenCalledWith(`oidc_state:${oidcState.state}`);
        await expect(service.consumeOidcState(oidcState.state, oidcState.correlationNonce))
            .rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('allows exactly one simultaneous OIDC state claim and refuses replay', async () => {
        const first = await service.createOidcState('/dashboard/staff', 'demo');
        const second = await service.createOidcState('/dashboard/schedules', 'other');
        const pending = [
            service.consumeOidcState(first.state, first.correlationNonce),
            service.consumeOidcState(first.state, first.correlationNonce),
        ];
        const results = await Promise.allSettled(pending);
        expect(results.filter(result => result.status === 'fulfilled')).toEqual([{
            status: 'fulfilled', value: { nextPath: '/dashboard/staff', tenantSlug: 'demo', createdAt: expect.any(Number) },
        }]);
        const rejected = results.filter(result => result.status === 'rejected');
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason).toBeInstanceOf(UnauthorizedException);
        expect(states.has(`oidc_state:${first.state}`)).toBe(false);
        expect(states.has(`oidc_state:${second.state}`)).toBe(true);
        await expect(service.consumeOidcState(first.state, first.correlationNonce)).rejects.toBeInstanceOf(UnauthorizedException);
        await expect(service.consumeOidcState(second.state, second.correlationNonce)).resolves.toEqual({
            nextPath: '/dashboard/schedules', tenantSlug: 'other', createdAt: expect.any(Number),
        });
        expect(redis.get).not.toHaveBeenCalled();
        expect(redis.del).not.toHaveBeenCalled();
    });

    it('refuses malformed OIDC state before any Redis claim', async () => {
        const state = await service.createOidcState('/dashboard', 'demo');
        for (const invalid of ['', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64)]) {
            await expect(service.consumeOidcState(invalid, state.correlationNonce)).rejects.toBeInstanceOf(UnauthorizedException);
        }
        expect(redis.getdel).not.toHaveBeenCalled();
        expect(redis.get).not.toHaveBeenCalled();
        expect(redis.del).not.toHaveBeenCalled();
        expect(states.has(`oidc_state:${state.state}`)).toBe(true);
    });

    it.each(['', '{}', 'null', '{', '{"correlationHash":7}'])('burns invalid claimed OIDC payload %s and refuses retry', async payload => {
        const state = await service.createOidcState('/dashboard', 'demo');
        const key = `oidc_state:${state.state}`;
        states.set(key, payload);
        await expect(service.consumeOidcState(state.state, state.correlationNonce)).rejects.toBeInstanceOf(UnauthorizedException);
        expect(states.has(key)).toBe(false);
        await expect(service.consumeOidcState(state.state, state.correlationNonce)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('propagates an atomic OIDC claim failure without split-command fallback', async () => {
        const state = await service.createOidcState('/dashboard', 'demo');
        const failure = new Error('GETDEL unavailable');
        redis.getdel.mockRejectedValueOnce(failure);
        await expect(service.consumeOidcState(state.state, state.correlationNonce)).rejects.toBe(failure);
        expect(redis.get).not.toHaveBeenCalled();
        expect(redis.del).not.toHaveBeenCalled();
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
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'user-new',
            email: 'owner@example.com',
            username: null,
            tenantId: 'tenant-new',
            role: 'ADMIN',
            mfaEnabled: false,
            deletedAt: null,
            suspendedAt: null,
        });
        mockPrisma.session.create.mockResolvedValue({ id: 'session-new', refreshToken: 'refresh-new' });

        const result = await service.loginWithEmail('Owner@Example.com', {
            allowProvision: true,
            provisionTenantName: '  Acme Dining  ',
            termsAccepted: true,
            privacyAccepted: true,
            termsVersion: CURRENT_TERMS_VERSION,
            privacyVersion: CURRENT_PRIVACY_VERSION,
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
                usageCredits: 0,
            },
        });
        const trialEndsAt = mockPrisma.tenant.create.mock.calls[0][0].data.trialEndsAt as Date;
        expect(trialEndsAt.getTime()).toBeGreaterThan(Date.now() + 13 * 24 * 60 * 60 * 1000);
        expect(mockPrisma.creditTransaction.create).not.toHaveBeenCalled();
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
                    termsVersion: CURRENT_TERMS_VERSION,
                    privacyVersion: CURRENT_PRIVACY_VERSION,
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
                suspendedAt: null,
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
            termsVersion: CURRENT_TERMS_VERSION,
            privacyVersion: CURRENT_PRIVACY_VERSION,
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
        secureHttpRequestMock.mockResolvedValue(new Response(JSON.stringify({ success: true }), {
            status: 200,
        }));

        await expect(service.assertEmailOtpAllowed('owner@example.com', {
            allowProvision: true,
            provisionTenantName: 'Acme Dining',
            signupChallengeToken: 'turnstile-token',
            signupChallengeRemoteIp: '203.0.113.10',
        })).resolves.toBe(true);

        expect(secureHttpRequestMock).toHaveBeenCalledTimes(1);
        const [url, init] = secureHttpRequestMock.mock.calls[0];
        expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
        expect(init).toMatchObject({
            method: 'POST',
            timeoutMs: 8_000,
            maxResponseBytes: 16 * 1024,
            redirect: 'error',
        });
        const params = new URLSearchParams(init?.body as string);
        expect(params.get('secret')).toBe('turnstile-secret');
        expect(params.get('response')).toBe('turnstile-token');
        expect(params.get('remoteip')).toBe('203.0.113.10');
    });

    it('rejects failed Turnstile checks before sending non-production open signup OTPs', async () => {
        process.env.NODE_ENV = 'development';
        process.env.PUBLIC_SIGNUP_MODE = 'open';
        process.env.TURNSTILE_SECRET_KEY = 'turnstile-secret';
        secureHttpRequestMock.mockResolvedValue(new Response(JSON.stringify({ success: false }), {
            status: 200,
        }));

        await expect(service.assertEmailOtpAllowed('owner@example.com', {
            allowProvision: true,
            provisionTenantName: 'Acme Dining',
            signupChallengeToken: 'turnstile-token',
        })).rejects.toBeInstanceOf(ForbiddenException);
    });

    it.each([
        ['aborted', new DOMException('request aborted', 'AbortError')],
        ['oversized', new Error('Outbound response exceeded size limit: provider-secret-body')],
    ])('fails closed when Turnstile is %s', async (_case, providerError) => {
        process.env.NODE_ENV = 'development';
        process.env.PUBLIC_SIGNUP_MODE = 'open';
        process.env.TURNSTILE_SECRET_KEY = 'turnstile-secret';
        secureHttpRequestMock.mockRejectedValue(providerError);

        await expect(service.assertEmailOtpAllowed('owner@example.com', {
            allowProvision: true,
            provisionTenantName: 'Acme Dining',
            signupChallengeToken: 'turnstile-token',
        })).rejects.toMatchObject({
            status: 503,
            message: 'Signup verification is unavailable.',
        });
    });

    it('times out a stalled Turnstile provider at the auth request deadline', async () => {
        process.env.NODE_ENV = 'development';
        process.env.PUBLIC_SIGNUP_MODE = 'open';
        process.env.TURNSTILE_SECRET_KEY = 'turnstile-secret';
        vi.useFakeTimers();
        secureHttpRequestMock.mockImplementation(() => new Promise<Response>(() => undefined));

        const rejection = expect(service.assertEmailOtpAllowed('owner@example.com', {
            allowProvision: true,
            provisionTenantName: 'Acme Dining',
            signupChallengeToken: 'turnstile-token',
        })).rejects.toMatchObject({
            status: 503,
            message: 'Signup verification is unavailable.',
        });
        await vi.advanceTimersByTimeAsync(8_000);
        await rejection;
    });

    it('fails closed when Turnstile returns malformed JSON or a non-object payload', async () => {
        process.env.NODE_ENV = 'development';
        process.env.PUBLIC_SIGNUP_MODE = 'open';
        process.env.TURNSTILE_SECRET_KEY = 'turnstile-secret';
        secureHttpRequestMock
            .mockResolvedValueOnce(new Response('{not-json', { status: 200 }))
            .mockResolvedValueOnce(new Response('[]', { status: 200 }));

        const request = () => service.assertEmailOtpAllowed('owner@example.com', {
            allowProvision: true,
            provisionTenantName: 'Acme Dining',
            signupChallengeToken: 'turnstile-token',
        });
        await expect(request()).rejects.toBeInstanceOf(ServiceUnavailableException);
        await expect(request()).rejects.toBeInstanceOf(ServiceUnavailableException);
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
            termsVersion: CURRENT_TERMS_VERSION,
            privacyVersion: CURRENT_PRIVACY_VERSION,
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
            termsVersion: CURRENT_TERMS_VERSION,
            privacyVersion: CURRENT_PRIVACY_VERSION,
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
        expect(mockPrisma.creditTransaction.create).not.toHaveBeenCalled();
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

    it('does not disclose suspended workspaces through login flow resolution', async () => {
        mockPrisma.tenant.findUnique.mockResolvedValue({
            id: 't-1',
            slug: 'demo',
            status: 'SUSPENDED',
            deletedAt: null,
        });

        await expect(service.resolveLoginMethod('admin@example.com', 'demo')).resolves.toEqual({
            flow: 'EMAIL_OTP',
            normalizedIdentifier: 'admin@example.com',
        });

        expect(mockPrisma.tenant.findUnique).not.toHaveBeenCalled();
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

    it('rejects refresh credentials for a suspended user before rotation', async () => {
        mockPrisma.session.findFirst.mockResolvedValue({
            id: 's-user-suspended-refresh',
            userId: 'u-user-suspended',
            refreshToken: 'refresh-token',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            revokedAt: null,
            user: {
                id: 'u-user-suspended',
                tenantId: 't-1',
                role: 'STAFF',
                mfaEnabled: false,
                suspendedAt: new Date(),
                deletedAt: null,
            },
        });

        await expect(service.refreshAccessToken('refresh-token'))
            .rejects
            .toBeInstanceOf(UnauthorizedException);

        expect(mockJwtService.generateAccessToken).not.toHaveBeenCalled();
        expect(mockPrisma.session.updateMany).not.toHaveBeenCalled();
    });

    it('rejects existing access-token sessions for a suspended user', async () => {
        mockPrisma.session.findFirst.mockResolvedValue({
            id: 's-user-suspended-access',
            userId: 'u-user-suspended',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            revokedAt: null,
            user: {
                id: 'u-user-suspended',
                tenantId: 't-1',
                role: 'STAFF',
                mfaEnabled: false,
                suspendedAt: new Date(),
                deletedAt: null,
            },
        });

        await expect(service.validateAccessSession({
            sub: 'u-user-suspended',
            tenantId: 't-1',
            role: 'STAFF',
            sessionId: 's-user-suspended-access',
            mfaVerified: true,
        })).rejects.toBeInstanceOf(UnauthorizedException);

        expect(mockPrisma.tenant.findUnique).not.toHaveBeenCalled();
        expect(mockRbacService.getEffectiveAccess).not.toHaveBeenCalled();
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
            access: expect.objectContaining({ permissions: ['auth:login_email', 'dashboard:access'] }),
        });
    });

    it('rejects when a role promotion revokes the session after live access and MFA are evaluated', async () => {
        const activeSession = {
            id: 's-promotion-race',
            userId: 'u-promotion-race',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            revokedAt: null,
            user: {
                id: 'u-promotion-race',
                tenantId: 't-1',
                role: 'STAFF',
                mfaEnabled: false,
                suspendedAt: null,
                deletedAt: null,
            },
        };
        mockPrisma.session.findFirst
            .mockResolvedValueOnce(activeSession)
            .mockResolvedValueOnce({ ...activeSession, revokedAt: new Date() });
        mockRbacService.getEffectiveAccess.mockResolvedValue({
            primaryRole: 'System Admin',
            roles: [],
            permissions: ['dashboard:access', 'admin_portal:access'],
        });

        await expect(service.validateAccessSession({
            sub: activeSession.userId,
            tenantId: activeSession.user.tenantId,
            role: 'STAFF',
            sessionId: activeSession.id,
            mfaVerified: true,
        })).rejects.toBeInstanceOf(UnauthorizedException);

        expect(mockRbacService.getEffectiveAccess).toHaveBeenCalledOnce();
        expect(mockPrisma.session.findFirst).toHaveBeenCalledTimes(2);
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
        mockRbacService.authorizeUserAdministrationInTransaction.mockReset().mockResolvedValue({
            id: 'u-reset',
            role: 'STAFF',
            username: 'crewlead',
            name: 'Crew Lead',
            email: null,
        });
        mockRbacService.authorizeSelfSecurityMutationInTransaction.mockReset().mockResolvedValue({
            primaryRole: 'STAFF',
            roles: [],
            permissions: ['auth:login_pin', 'dashboard:access'],
        });
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
                suspendedAt: null,
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

    it('resolves email identifiers by syntax without account or tenant lookup', async () => {
        const result = await service.resolveLoginMethod('ADMIN@Example.com', 'demo');

        expect(result).toEqual({
            flow: 'EMAIL_OTP',
            normalizedIdentifier: 'admin@example.com',
        });
        expect(mockPrisma.tenant.findUnique).not.toHaveBeenCalled();
        expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
        expect(mockPrisma.tenantSetting.findUnique).not.toHaveBeenCalled();
        expect(mockRbacService.getEffectiveAccess).not.toHaveBeenCalled();
    });

    it('returns one account-blind username flow for every workspace and account state', async () => {
        mockPrisma.tenant.findUnique.mockResolvedValue({
            id: 't-oidc',
            slug: 'oidc-only',
            status: 'SUSPENDED',
            deletedAt: new Date(),
        });
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'user-password',
            tenantId: 't-oidc',
            passwordHash: 'present',
            pinHash: null,
        });

        const results = await Promise.all([
            service.resolveLoginMethod('Missing.User', 'missing-workspace'),
            service.resolveLoginMethod('Pin.User', 'demo'),
            service.resolveLoginMethod('Password.User', 'oidc-only'),
        ]);

        expect(results).toEqual([
            { flow: 'USERNAME_PASSWORD', normalizedIdentifier: 'missing.user' },
            { flow: 'USERNAME_PASSWORD', normalizedIdentifier: 'pin.user' },
            { flow: 'USERNAME_PASSWORD', normalizedIdentifier: 'password.user' },
        ]);
        expect(mockPrisma.tenant.findUnique).not.toHaveBeenCalled();
        expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
        expect(mockPrisma.tenantSetting.findUnique).not.toHaveBeenCalled();
        expect(mockRbacService.getEffectiveAccess).not.toHaveBeenCalled();
    });

    it('requires a workspace selection without testing whether that workspace exists', async () => {
        await expect(service.resolveLoginMethod('ShiftLead', '   '))
            .rejects
            .toBeInstanceOf(BadRequestException);

        expect(mockPrisma.tenant.findUnique).not.toHaveBeenCalled();
        expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
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

    it('MFA-gates login for a custom role whose only business privilege is payroll export', async () => {
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'u-payroll-exporter',
            tenantId: 't-1',
            role: 'STAFF',
            email: 'payroll@example.com',
            username: null,
            mfaEnabled: false,
            lockedUntil: null,
        });
        mockRbacService.getEffectiveAccess.mockResolvedValue({
            primaryRole: 'Payroll Exporter',
            roles: [{
                id: 'role-payroll-exporter',
                name: 'Payroll Exporter',
                isSystem: false,
                permissions: ['auth:login_email', 'payroll:export'],
            }],
            permissions: ['auth:login_email', 'payroll:export'],
        });
        mockPrisma.session.create.mockResolvedValue({
            id: 's-payroll-exporter',
            refreshToken: 'r-payroll-exporter',
        });

        const result = await service.loginWithEmail('payroll@example.com', { tenantSlug: 'demo' });

        expect(result.requiresMfa).toBe(true);
        expect(mockJwtService.generateAccessToken).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's-payroll-exporter',
            mfaVerified: false,
        }));
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

    it('keeps PIN login functional through the account-blind username credential flow', async () => {
        const pinHash = (service as any).hashPin('123456');
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'u-pin-fallback',
            tenantId: 't-1',
            role: 'STAFF',
            email: null,
            username: 'pin.user',
            mfaEnabled: false,
            pinResetRequired: true,
            passwordHash: null,
            pinHash,
            pinLoginAttempts: 0,
            pinLockedUntil: null,
        });
        mockPrisma.session.create.mockResolvedValue({ id: 's-pin-fallback', refreshToken: 'r-pin-fallback' });
        mockPrisma.user.update.mockResolvedValue({});

        const result = await service.loginWithUsernamePassword('Pin.User', '123456', 'demo');

        expect(result).toHaveProperty('accessToken');
        expect(result.pinResetRequired).toBe(true);
        expect(mockJwtService.generateAccessToken).toHaveBeenCalledWith(expect.objectContaining({
            sub: 'u-pin-fallback',
            sessionId: 's-pin-fallback',
            pinResetRequired: true,
        }));
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

    it('marks only the configured exact beta demo password session as MFA verified', async () => {
        process.env.BETA_DEMO_MFA_BYPASS_ENABLED = 'true';
        const passwordHash = bcrypt.hashSync('demo', 10);
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'demo-admin',
            tenantId: 't-1',
            role: 'ADMIN',
            email: 'demo@demo.com',
            username: 'demo@demo.com',
            mfaEnabled: false,
            passwordHash,
            loginAttempts: 0,
            lockedUntil: null,
            pinResetRequired: false,
        });
        mockRbacService.getEffectiveAccess.mockResolvedValue({
            primaryRole: 'Demo Administrator',
            roles: [{ id: 'demo-role', name: 'Demo Administrator' }],
            permissions: ['auth:login_password', 'users:write'],
        });
        mockPrisma.session.create.mockResolvedValue({ id: 'demo-session', refreshToken: 'demo-refresh' });
        mockPrisma.user.update.mockResolvedValue({});

        const result = await service.loginWithUsernamePassword(
            'demo@demo.com',
            'demo',
            'demo',
            {},
            { betaDemoMfaBypass: true },
        );

        expect(result.requiresMfa).toBe(false);
        expect(mockJwtService.generateAccessToken).toHaveBeenCalledWith(expect.objectContaining({
            sub: 'demo-admin',
            sessionId: 'demo-session',
            mfaVerified: true,
        }));
        expect((service as any).getRedis().set).toHaveBeenCalledWith(
            'session_mfa:demo-session',
            '1',
            'EX',
            expect.any(Number),
        );
        expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                newValue: {
                    loginMethod: 'USERNAME_PASSWORD',
                    mfaExemption: 'BETA_DEMO',
                },
            }),
        });
    });

    it('keeps privileged MFA when the requested beta demo exemption identity does not match', async () => {
        process.env.BETA_DEMO_MFA_BYPASS_ENABLED = 'true';
        const passwordHash = bcrypt.hashSync('demo', 10);
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'other-admin',
            tenantId: 't-1',
            role: 'ADMIN',
            email: 'other@demo.com',
            username: 'other@demo.com',
            mfaEnabled: false,
            passwordHash,
            loginAttempts: 0,
            lockedUntil: null,
            pinResetRequired: false,
        });
        mockRbacService.getEffectiveAccess.mockResolvedValue({
            primaryRole: 'Admin',
            roles: [{ id: 'admin-role', name: 'Admin' }],
            permissions: ['auth:login_password', 'users:write'],
        });
        mockPrisma.session.create.mockResolvedValue({ id: 'other-session', refreshToken: 'other-refresh' });
        mockPrisma.user.update.mockResolvedValue({});

        const result = await service.loginWithUsernamePassword(
            'other@demo.com',
            'demo',
            'demo',
            {},
            { betaDemoMfaBypass: true },
        );

        expect(result.requiresMfa).toBe(true);
        expect(mockJwtService.generateAccessToken).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'other-session',
            mfaVerified: false,
        }));
        expect((service as any).getRedis().set).not.toHaveBeenCalled();
    });

    it.each(['changed', 'removed'] as const)(
        'rejects a verified password when its hash is %s before locked session issuance',
        async (change) => {
            const passwordHash = bcrypt.hashSync('correct-horse', 10);
            const verifiedUser = {
                id: 'u-password-reset-race',
                tenantId: 't-1',
                role: 'STAFF',
                email: null,
                username: 'legacyuser',
                mfaEnabled: false,
                passwordHash,
                loginAttempts: 0,
                lockedUntil: null,
            };
            const changedUser = {
                ...verifiedUser,
                passwordHash: change === 'changed' ? bcrypt.hashSync('replacement-password', 10) : null,
            };
            // Lookup and locked verification see the old credential. The issuer's
            // separate locked reread sees the reset/deletion that committed next.
            mockPrisma.user.findFirst
                .mockResolvedValueOnce(verifiedUser)
                .mockResolvedValueOnce(verifiedUser)
                .mockResolvedValueOnce(changedUser);
            mockRbacService.getEffectiveAccess.mockResolvedValue({
                primaryRole: 'STAFF', roles: [], permissions: ['auth:login_password'],
            });

            await expect(service.loginWithUsernamePassword('LegacyUser', 'correct-horse', 'demo'))
                .rejects.toBeInstanceOf(UnauthorizedException);

            expect(mockPrisma.user.findFirst).toHaveBeenCalledTimes(3);
            expect(mockPrisma.session.create).not.toHaveBeenCalled();
            expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
            expect(mockJwtService.generateAccessToken).not.toHaveBeenCalled();
        },
    );

    it('rejects password session issuance after the password login permission is revoked', async () => {
        const passwordHash = bcrypt.hashSync('correct-horse', 10);
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'u-password-permission-race',
            tenantId: 't-1',
            role: 'STAFF',
            email: null,
            username: 'legacyuser',
            mfaEnabled: false,
            passwordHash,
            loginAttempts: 0,
            lockedUntil: null,
        });
        mockRbacService.getEffectiveAccess
            .mockResolvedValueOnce({
                primaryRole: 'STAFF', roles: [], permissions: ['auth:login_password', 'dashboard:access'],
            })
            .mockResolvedValueOnce({
                primaryRole: 'STAFF', roles: [], permissions: ['dashboard:access'],
            });

        await expect(service.loginWithUsernamePassword('LegacyUser', 'correct-horse', 'demo'))
            .rejects.toBeInstanceOf(UnauthorizedException);

        expect(mockRbacService.getEffectiveAccess).toHaveBeenCalledTimes(2);
        expect(mockPrisma.session.create).not.toHaveBeenCalled();
        expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
        expect(mockJwtService.generateAccessToken).not.toHaveBeenCalled();
    });

    it('rejects direct password session issuance without a verified credential proof', async () => {
        const user = {
            id: 'u-password-missing-proof',
            tenantId: 't-1',
            role: 'STAFF',
            email: null,
            username: 'legacyuser',
            mfaEnabled: false,
            passwordHash: bcrypt.hashSync('correct-horse', 10),
        };
        mockPrisma.user.findFirst.mockResolvedValue(user);

        await expect((service as any).createSessionTokens(user, { loginMethod: 'USERNAME_PASSWORD' }))
            .rejects.toBeInstanceOf(UnauthorizedException);

        expect(mockRbacService.getEffectiveAccess).not.toHaveBeenCalled();
        expect(mockPrisma.session.create).not.toHaveBeenCalled();
        expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
        expect(mockJwtService.generateAccessToken).not.toHaveBeenCalled();
    });

    it.each(['changed', 'removed', 'missing-proof'] as const)(
        'rejects email session issuance after a %s verified identity',
        async (change) => {
            const verified = {
                id: 'u-email-identity-race', tenantId: 't-1', role: 'STAFF',
                email: 'former@example.com', username: null, mfaEnabled: false,
            };
            mockPrisma.user.findFirst.mockResolvedValue({
                ...verified,
                email: change === 'changed' ? 'replacement@example.com' : change === 'removed' ? null : verified.email,
            });
            const proof = change === 'missing-proof' ? undefined : { email: verified.email };
            await expect((service as any).createSessionTokens(
                verified, { loginMethod: 'EMAIL_OTP' }, true, null, undefined, undefined, proof,
            )).rejects.toBeInstanceOf(UnauthorizedException);
            expect(mockRbacService.getEffectiveAccess).not.toHaveBeenCalled();
            expect(mockPrisma.session.create).not.toHaveBeenCalled();
            expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
            expect(mockJwtService.generateAccessToken).not.toHaveBeenCalled();
        },
    );

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
            && attempt.reason instanceof UnauthorizedException)).toHaveLength(6);
        expect(attempts.filter((attempt) => attempt.status === 'rejected'
            && attempt.reason instanceof ForbiddenException)).toHaveLength(0);
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
            passwordHash: 'existing-password-hash',
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
        installCurrentPasswordResetStatementMocks();
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

        await expect(service.resetPasswordWithToken(token, 'new-password-1', {
            ipAddress: '203.0.113.44',
            userAgent: 'Vitest Password Reset',
        })).resolves.toBeUndefined();

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
        const claim = mockPrisma.$queryRaw.mock.calls.find(([sql]) => sql.join('').includes('UPDATE "PasswordResetToken"'));
        expect(claim?.slice(1)).toEqual(['prt-1','t-1','u-reset',tokenHash]);
        expect(claim?.[0].join('')).toContain('clock_timestamp()');
        expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
            data: {
                tenantId: 't-1',
                userId: 'u-reset',
                actorUserId: 'u-reset',
                actorTenantId: 't-1',
                action: 'PASSWORD_RESET_COMPLETED',
                resource: 'User',
                resourceId: 'u-reset',
                newValue: { sessionsRevoked: 2 },
                ipAddress: '203.0.113.44',
                userAgent: 'Vitest Password Reset',
            },
        });
    });

    it('keeps Redis cleanup provider details out of password-reset warning logs', async () => {
        installCurrentPasswordResetStatementMocks();
        const token = 'reset_token_123456789012345678901234';
        const tokenHash = (service as any).hashPasswordResetToken(token);
        const secret = 'redis://default:cleanup-secret@private-cache.internal:6379';
        mockPrisma.passwordResetToken.findFirst.mockResolvedValue({
            id: 'prt-log-safety',
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
        mockPrisma.session.findMany.mockResolvedValue([{ id: 's-secret' }]);
        mockPrisma.session.updateMany.mockResolvedValue({ count: 1 });
        mockPrisma.user.update.mockResolvedValue({});
        (service as any).redis = {
            del: vi.fn().mockRejectedValue(
                Object.assign(new Error('MFA cleanup failed for ' + secret + ' command=DEL'), {
                    code: 'ECONNRESET',
                }),
            ),
        };
        const warn = vi.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

        await expect(service.resetPasswordWithToken(token, 'new-password-1')).resolves.toBeUndefined();

        const logged = JSON.stringify(warn.mock.calls);
        expect(logged).toContain('auth.password_reset_mfa_cleanup_failed');
        expect(logged).toContain('connectivity');
        expect(logged).toContain('ECONNRESET');
        expect(logged).not.toContain(secret);
        expect(logged).not.toContain('MFA cleanup failed');
        expect(logged).not.toContain('command=DEL');
        expect(logged).not.toContain('s-secret');
    });

    it('fails closed inside the password-reset transaction when its audit event cannot be persisted', async () => {
        installCurrentPasswordResetStatementMocks();
        const token = 'reset_token_audit_failure_123456789012345';
        const tokenHash = (service as any).hashPasswordResetToken(token);
        mockPrisma.passwordResetToken.findFirst.mockResolvedValue({
            id: 'prt-audit-failure',
            tenantId: 't-1',
            userId: 'u-reset',
            tokenHash,
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
            consumedAt: null,
            user: {
                id: 'u-reset',
                tenantId: 't-1',
                deletedAt: null,
                suspendedAt: null,
                passwordHash: bcrypt.hashSync('old-password', 10),
            },
        });
        mockPrisma.passwordResetToken.updateMany.mockResolvedValue({ count: 1 });
        mockPrisma.session.findMany.mockResolvedValue([{ id: 's-audit-failure' }]);
        mockPrisma.session.updateMany.mockResolvedValue({ count: 1 });
        mockPrisma.user.update.mockResolvedValue({});
        mockPrisma.auditLog.create.mockRejectedValueOnce(new Error('audit unavailable'));

        await expect(service.resetPasswordWithToken(token, 'new-password-1'))
            .rejects.toThrow('audit unavailable');

        expect(mockPrisma.user.update).toHaveBeenCalledOnce();
        expect(mockPrisma.session.updateMany).toHaveBeenCalledOnce();
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
            && attempt.reason instanceof UnauthorizedException)).toHaveLength(6);
        expect(attempts.filter((attempt) => attempt.status === 'rejected'
            && attempt.reason instanceof ForbiddenException)).toHaveLength(0);
        expect(account.pinLoginAttempts).toBe(5);
        expect(account.pinLockedUntil).toBeInstanceOf(Date);
        expect(mockPrisma.user.update).toHaveBeenCalledTimes(5);
        expect(mockPrisma.$queryRaw.mock.calls.some(([query]) => Array.from(query as TemplateStringsArray)
            .join('?')
            .includes('FOR UPDATE'))).toBe(true);
    });

    it('rotates own PIN when current PIN is valid', async () => {
        const pinHash = (service as any).hashPin('1111');
        const redis = { del: vi.fn(), on: vi.fn() };
        (service as any).redis = redis;
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'u-3',
            tenantId: 't-1',
            pinResetRequired: true,
            username: 'nightlead',
            pinHash,
        });
        mockPrisma.session.findFirst.mockImplementation(async ({ where }: any) =>
            where.id === 'session-current' && where.userId === 'u-3'
                ? { id: 'session-current', userId: 'u-3', revokedAt: null,
                    createdAt: new Date(), expiresAt: new Date(Date.now() + 60 * 60_000) } : null);
        mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
        mockPrisma.session.findMany.mockResolvedValue([{ id: 'session-1' }]);

        await expect(service.rotateOwnPin(
            'u-3',
            '1111',
            '2222',
            't-1',
            'session-current',
            { ipAddress: ' 203.0.113.52\u0000 ', userAgent: ` PIN Rotation\u0007${'x'.repeat(600)} ` },
        )).resolves.toBeUndefined();
        expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
            where: { id: 'u-3', tenantId: 't-1', deletedAt: null, suspendedAt: null },
            data: expect.objectContaining({
                pinHash: expect.any(String),
                pinResetRequired: false,
                pinLoginAttempts: 0,
                pinLockedUntil: null,
            }),
        });
        expect(mockPrisma.session.updateMany).toHaveBeenCalledWith({
            where: { userId: 'u-3', revokedAt: null },
            data: { revokedAt: expect.any(Date) },
        });
        expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
            data: {
                tenantId: 't-1',
                userId: 'u-3',
                actorUserId: 'u-3',
                actorTenantId: 't-1',
                action: 'USER_PIN_ROTATED',
                resource: 'User',
                resourceId: 'u-3',
                newValue: { pinResetRequired: false, sessionsRevoked: 1 },
                ipAddress: '203.0.113.52',
                userAgent: `PIN Rotation${'x'.repeat(600)}`.slice(0, 512),
            },
        });
        expect(JSON.stringify(mockPrisma.auditLog.create.mock.calls[0]?.[0])).not.toMatch(/1111|2222|pinHash/i);
        expect(redis.del).toHaveBeenCalledWith('session_mfa:session-1');
    });

    it('denies self PIN rotation after exact-session revocation with zero credential, session, audit, or Redis writes', async () => {
        const redis = { del: vi.fn(), on: vi.fn() };
        (service as any).redis = redis;
        mockRbacService.authorizeSelfSecurityMutationInTransaction.mockRejectedValueOnce(
            new ForbiddenException('Administrator session is no longer active'),
        );

        await expect(service.rotateOwnPin('u-3', '1111', '2222', 't-1', 'session-revoked'))
            .rejects.toBeInstanceOf(ForbiddenException);

        expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
        expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
        expect(mockPrisma.session.updateMany).not.toHaveBeenCalled();
        expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
        expect(redis.del).not.toHaveBeenCalled();
    });

    it('requires the rotated PIN to differ from the temporary PIN', async () => {
        await expect(service.rotateOwnPin('u-3', '1111', '1111', 't-1', 'session-current'))
            .rejects.toBeInstanceOf(BadRequestException);
        expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('rejects a malformed administered PIN for a username-less target before opening a tenant transaction', async () => {
        mockRbacService.authorizeUserAdministrationInTransaction.mockResolvedValue({
            id: 'u-reset',
            role: 'STAFF',
            username: null,
            name: 'Username Less Target',
            email: null,
        });
        await expect(service.resetUserPinAsAdmin(
            'u-reset',
            '12x4',
            't-1',
            'admin-1',
            'admin-session-1',
        )).rejects.toBeInstanceOf(BadRequestException);

        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
        expect(mockRbacService.authorizeUserAdministrationInTransaction).not.toHaveBeenCalled();
        expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
        expect(mockPrisma.session.updateMany).not.toHaveBeenCalled();
        expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
    });

    it.each([
        { code: 'P2034' },
        { code: 'P2010', meta: { code: '40001', message: 'could not serialize access due to concurrent update' } },
        { code: 'P2010', meta: { code: '40P01', message: 'deadlock detected' } },
    ])('bounds transaction conflict $code as a controlled conflict after one retry', async (error) => {
        mockPrisma.$transaction.mockRejectedValueOnce(error).mockRejectedValueOnce(error);

        await expect(service.resetUserPinAsAdmin(
            'u-reset',
            '246810',
            't-1',
            'admin-1',
            'admin-session-1',
        )).rejects.toBeInstanceOf(ConflictException);

        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
        expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
        expect(mockPrisma.session.updateMany).not.toHaveBeenCalled();
        expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('retries one administered PIN transaction conflict with one committed audit', async () => {
        mockPrisma.$transaction.mockRejectedValueOnce({ code: 'P2034' });
        mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
        mockPrisma.session.findMany.mockResolvedValue([]);

        await expect(service.resetUserPinAsAdmin(
            'u-reset',
            '246810',
            't-1',
            'admin-1',
            'admin-session-1',
        )).resolves.toEqual({ username: 'crewlead' });

        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
        expect(mockPrisma.user.updateMany).toHaveBeenCalledOnce();
        expect(mockPrisma.auditLog.create).toHaveBeenCalledOnce();
    });

    it('denies delegated PIN recovery for a dual-source system admin target with zero effects', async () => {
        mockRbacService.authorizeUserAdministrationInTransaction.mockRejectedValueOnce(
            new ForbiddenException('Only system admins can administer system admins'),
        );

        await expect(service.resetUserPinAsAdmin(
            'u-system-admin',
            '246810',
            't-1',
            'delegated-admin',
            'delegated-session',
        )).rejects.toThrow('Only system admins can administer system admins');

        expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
        expect(mockPrisma.session.updateMany).not.toHaveBeenCalled();
        expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('includes soft-deleted usernames when bootstrapping an administered PIN account', async () => {
        mockRbacService.authorizeUserAdministrationInTransaction.mockResolvedValueOnce({
            id: 'u-reset',
            role: 'STAFF',
            username: null,
            name: 'Crew Lead',
            email: null,
            suspendedAt: null,
        });
        mockPrisma.user.findFirst
            .mockResolvedValueOnce({ id: 'soft-deleted-collision' })
            .mockResolvedValueOnce(null);
        mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
        mockPrisma.session.findMany.mockResolvedValue([]);
        mockPrisma.session.updateMany.mockResolvedValue({ count: 0 });

        const result = await service.resetUserPinAsAdmin(
            'u-reset', '246810', 't-1', 'admin-1', 'admin-session-1',
        );

        expect(result.username).not.toBe('crew.lead');
        expect(mockPrisma.user.findFirst).toHaveBeenNthCalledWith(1, {
            where: { tenantId: 't-1', username: 'crew.lead' },
            select: { id: true },
        });
        expect(mockPrisma.user.findFirst.mock.calls.every(([query]) =>
            !Object.prototype.hasOwnProperty.call(query.where, 'deletedAt'))).toBe(true);
    });

    it('retries an operation-scoped username reservation collision without exposing raw P2002', async () => {
        mockRbacService.authorizeUserAdministrationInTransaction.mockResolvedValue({
            id: 'u-reset',
            role: 'STAFF',
            username: null,
            name: 'Crew Lead',
            email: null,
            suspendedAt: null,
        });
        mockPrisma.user.findFirst.mockResolvedValue(null);
        mockPrisma.user.updateMany
            .mockRejectedValueOnce({ code: 'P2002' })
            .mockResolvedValueOnce({ count: 1 });
        mockPrisma.session.findMany.mockResolvedValue([]);
        mockPrisma.session.updateMany.mockResolvedValue({ count: 0 });

        await expect(service.resetUserPinAsAdmin(
            'u-reset',
            '246810',
            't-1',
            'admin-1',
            'admin-session-1',
        )).resolves.toEqual({ username: 'crew.lead' });

        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
        expect(mockPrisma.auditLog.create).toHaveBeenCalledOnce();
    });

    it('returns a controlled conflict when username reservation retries are exhausted', async () => {
        mockRbacService.authorizeUserAdministrationInTransaction.mockResolvedValue({
            id: 'u-reset',
            role: 'STAFF',
            username: null,
            name: 'Crew Lead',
            email: null,
            suspendedAt: null,
        });
        mockPrisma.user.findFirst.mockResolvedValue(null);
        mockPrisma.user.updateMany.mockRejectedValue({ code: 'P2002' });
        mockPrisma.session.findMany.mockResolvedValue([]);

        await expect(service.resetUserPinAsAdmin(
            'u-reset',
            '246810',
            't-1',
            'admin-1',
            'admin-session-1',
        )).rejects.toBeInstanceOf(ConflictException);

        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
        expect(mockPrisma.session.updateMany).not.toHaveBeenCalled();
        expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('atomically resets an administered PIN, revokes sessions, and writes an attributable redacted audit', async () => {
        const redis = { del: vi.fn(), on: vi.fn() };
        (service as any).redis = redis;
        mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
        mockPrisma.session.findMany.mockResolvedValue([{ id: 'session-admin-reset' }]);

        const result = await service.resetUserPinAsAdmin(
            'u-reset',
            '246810',
            't-1',
            'admin-1',
            'admin-session-1',
            { ipAddress: '203.0.113.53', userAgent: 'PIN Admin Reset' },
        );

        expect(result).toEqual({ username: 'crewlead' });
        expect(mockRbacService.authorizeUserAdministrationInTransaction).toHaveBeenCalledWith(
            mockPrisma,
            't-1',
            {
                actorUserId: 'admin-1',
                actorSessionId: 'admin-session-1',
                targetUserId: 'u-reset',
                requiredPermission: 'users:admin',
                selfMutationMessage: 'Use the self-service PIN rotation route for your own account',
            },
        );
        expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
            where: { id: 'u-reset', tenantId: 't-1', deletedAt: null },
            data: expect.objectContaining({
                username: 'crewlead',
                pinHash: expect.any(String),
                pinResetRequired: true,
                pinLoginAttempts: 0,
                pinLockedUntil: null,
            }),
        });
        expect(mockPrisma.session.updateMany).toHaveBeenCalledWith({
            where: { userId: 'u-reset', revokedAt: null },
            data: { revokedAt: expect.any(Date) },
        });
        expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
            data: {
                tenantId: 't-1',
                userId: 'admin-1',
                actorUserId: 'admin-1',
                actorTenantId: 't-1',
                action: 'USER_PIN_RESET',
                resource: 'User',
                resourceId: 'u-reset',
                newValue: { pinResetRequired: true, sessionsRevoked: 1 },
                ipAddress: '203.0.113.53',
                userAgent: 'PIN Admin Reset',
            },
        });
        expect(JSON.stringify(mockPrisma.auditLog.create.mock.calls[0]?.[0])).not.toMatch(/246810|pinHash/i);
        expect(redis.del).toHaveBeenCalledWith('session_mfa:session-admin-reset');
        expect(mockPrisma.$transaction).toHaveBeenCalledWith(
            expect.any(Function),
            { isolationLevel: 'Serializable' },
        );
    });

    it('rolls back username bootstrap, administered PIN reset, and session revocation when audit insertion fails', async () => {
        const oldPinHash = (service as any).hashPin('1111');
        const account = {
            id: 'u-admin-rollback',
            tenantId: 't-1',
            username: null,
            name: 'Admin Rollback Target',
            email: null,
            role: 'STAFF',
            pinHash: oldPinHash,
            pinResetRequired: false,
            deletedAt: null,
        };
        const sessions = [{ id: 'session-admin-rollback', userId: account.id, revokedAt: null }];
        const redis = { del: vi.fn(), on: vi.fn() };
        (service as any).redis = redis;
        installAuditFailureRollbackHarness(account, sessions, new Error('audit unavailable'));
        mockRbacService.authorizeUserAdministrationInTransaction.mockResolvedValue({ ...account });

        await expect(service.resetUserPinAsAdmin(
            account.id,
            '246810',
            account.tenantId,
            'admin-1',
            'admin-session-1',
        )).rejects.toThrow('audit unavailable');

        expect(account.pinHash).toBe(oldPinHash);
        expect(account.pinResetRequired).toBe(false);
        expect(account.username).toBeNull();
        expect(sessions[0].revokedAt).toBeNull();
        expect(redis.del).not.toHaveBeenCalled();
    });

    it('rolls back self PIN mutation and session revocation when audit insertion fails', async () => {
        const oldPinHash = (service as any).hashPin('1111');
        const account = {
            id: 'u-rollback',
            tenantId: 't-1',
            username: 'rollback.user',
            pinHash: oldPinHash,
            pinResetRequired: true,
            deletedAt: null,
            suspendedAt: null,
        };
        const sessions = [{ id: 'session-rollback', userId: account.id, revokedAt: null,
            createdAt: new Date(), expiresAt: new Date(Date.now() + 60 * 60_000) }];
        const redis = { del: vi.fn(), on: vi.fn() };
        (service as any).redis = redis;
        installAuditFailureRollbackHarness(account, sessions, new Error('audit unavailable'));

        await expect(service.rotateOwnPin(
            account.id,
            '1111',
            '2222',
            account.tenantId,
            sessions[0].id,
        ))
            .rejects
            .toThrow('audit unavailable');

        expect(account.pinHash).toBe(oldPinHash);
        expect(account.pinResetRequired).toBe(true);
        expect(sessions[0].revokedAt).toBeNull();
        expect(redis.del).not.toHaveBeenCalled();
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
        mockRbacService.authorizeSelfSecurityMutationInTransaction.mockReset().mockResolvedValue({
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
            pinHash: (service as any).hashPin('123456'),
            mfaEnabled: false,
        };
        mockPrisma.user.findFirst.mockResolvedValue(user);
        mockRbacService.getEffectiveAccess.mockResolvedValue({
            primaryRole: 'STAFF', roles: [], permissions: ['auth:login_pin'],
        });
        mockPrisma.session.create.mockResolvedValue({ id: 's-session', refreshToken: 'refresh-session' });
        mockPrisma.session.findMany.mockResolvedValue([
            { id: 'old-session-1' },
            { id: 'old-session-2' },
        ]);
        mockPrisma.user.update.mockResolvedValue({});

        const result = await (service as any).createSessionTokens(user, {
            loginMethod: 'USERNAME_PIN',
            ipAddress: '203.0.113.44',
            userAgent: 'Vitest Browser',
        }, true, null, { username: user.username, pinHash: user.pinHash });

        expect(mockPrisma.$transaction).toHaveBeenCalledWith(
            expect.any(Function),
            { maxWait: 5_000, timeout: 10_000 },
        );
        const issuanceLocks = mockPrisma.$queryRaw.mock.calls
            .map((call) => Array.isArray(call[0])
                ? call[0].join('')
                : Array.isArray(call[0]?.strings)
                    ? call[0].strings.join('')
                    : String(call[0]))
            .filter((sql) => sql.includes('FROM "Tenant"') || sql.includes('FROM "User"'));
        expect(issuanceLocks[0]).toContain('FROM "Tenant"');
        expect(issuanceLocks[0]).toContain('FOR UPDATE');
        expect(issuanceLocks[1]).toContain('FROM "User"');
        expect(issuanceLocks[1]).toContain('FOR UPDATE');
        expect(mockPrisma.session.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                userId: 'u-session',
                refreshToken: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
                ipAddress: '203.0.113.44',
                userAgent: 'Vitest Browser',
                expiresAt: expect.any(Date),
            }),
        });
        expect(mockPrisma.session.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ userId: 'u-session', revokedAt: null }),
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            skip: 19,
            select: { id: true },
        }));
        expect(mockPrisma.session.deleteMany).toHaveBeenLastCalledWith({
            where: {
                userId: 'u-session',
                id: { in: ['old-session-1', 'old-session-2'] },
            },
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

    it.each(['OIDC', 'EMAIL_OTP', 'USERNAME_PIN', 'USERNAME_PASSWORD'])(
        'rejects %s session issuance when the locked account reread is inactive',
        async (loginMethod) => {
            mockPrisma.user.findFirst.mockResolvedValue(null);

            await expect((service as any).createSessionTokens({
                id: 'u-suspended-race',
                tenantId: 't-1',
                role: 'STAFF',
                email: 'staff@example.com',
                username: 'staff',
            pinHash: (service as any).hashPin('123456'),
                mfaEnabled: false,
            }, { loginMethod })).rejects.toBeInstanceOf(UnauthorizedException);

            expect(mockRbacService.getEffectiveAccess).not.toHaveBeenCalled();
            expect(mockPrisma.session.create).not.toHaveBeenCalled();
            expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
        },
    );

    it('rejects issuance when tenant suspension commits after credential preflight', async () => {
        mockPrisma.tenant.findUnique
            .mockResolvedValueOnce({ id: 't-1', slug: 'demo', status: 'ACTIVE', deletedAt: null, planTier: 'FREE' })
            .mockResolvedValueOnce({ id: 't-1', slug: 'demo', status: 'SUSPENDED', deletedAt: null, planTier: 'FREE' });

        await expect((service as any).createSessionTokens({
            id: 'u-tenant-suspended-race',
            tenantId: 't-1',
            role: 'STAFF',
            email: 'staff@example.com',
            username: 'staff',
            mfaEnabled: false,
        }, { loginMethod: 'USERNAME_PASSWORD' })).rejects.toBeInstanceOf(UnauthorizedException);

        expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
        expect(mockRbacService.getEffectiveAccess).not.toHaveBeenCalled();
        expect(mockPrisma.session.create).not.toHaveBeenCalled();
        expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('preserves legacy session-token callers without writing login method strings into IP or User-Agent fields', async () => {
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'u-legacy-source',
            tenantId: 't-1',
            role: 'STAFF',
            email: null,
            username: 'staff',
            mfaEnabled: false,
        });
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
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'u-required',
            tenantId: 't-1',
            role: 'STAFF',
            email: null,
            username: 'staff',
            mfaEnabled: false,
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
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'u-admin',
            tenantId: 't-1',
            role: 'SUPER_ADMIN',
            email: 'admin@example.com',
            username: null,
            mfaEnabled: false,
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
        'time_cards:approve',
        'payroll:policy_write',
        'payroll:lock',
        'payroll:export',
        'payroll:reconcile',
    ])('treats %s as a privileged MFA-gated tenant permission', (permission) => {
        expect((service as any).isPrivilegedMfaRequiredForAccess({
            permissions: ['dashboard:access', permission],
        })).toBe(true);
    });

    it('requires MFA for privileged tenant operations even without platform admin access', async () => {
        mockRbacService.getEffectiveAccess.mockResolvedValue({
            primaryRole: 'Admin',
            roles: [{ id: 'role-settings-admin', name: 'Admin', isSystem: true,
                permissions: ['auth:login_email', 'dashboard:access', 'settings:write'] }],
            permissions: ['auth:login_email', 'dashboard:access', 'settings:write'],
        });
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'u-settings-admin',
            tenantId: 't-1',
            role: 'ADMIN',
            email: 'admin@example.com',
            username: null,
            mfaEnabled: false,
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
        }, { loginMethod: 'EMAIL_OTP' }, true, null, undefined, undefined, { email: 'admin@example.com' });

        expect(mockJwtService.generateAccessToken).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's-settings-admin',
            mfaVerified: false,
        }));
        expect(result.requiresMfa).toBe(true);
    });

    it('re-evaluates a custom payroll-only role as MFA-sensitive during session refresh', async () => {
        const credential = (service as any).generateSelectedRefreshCredential();
        installSelectedRefreshSessionHarness(credential);
        mockRbacService.getEffectiveAccess.mockResolvedValue({
            primaryRole: 'Payroll Approver',
            roles: [{
                id: 'role-payroll-approver',
                name: 'Payroll Approver',
                isSystem: false,
                permissions: ['time_cards:approve'],
            }],
            permissions: ['time_cards:approve'],
        });

        const result = await service.refreshAccessToken(credential.token);

        expect(result).toMatchObject({ requiresMfa: true, mfaVerified: false });
        expect(mockJwtService.generateAccessToken).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's-refresh-family',
            mfaVerified: false,
        }));
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

        expect(mockPrisma.session.findFirst).toHaveBeenNthCalledWith(1, {
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
        expect(mockPrisma.session.findFirst).toHaveBeenNthCalledWith(2, {
            where: { id: 's-refresh', userId: 'u-refresh' },
            include: { user: true },
        });
        expect(mockPrisma.refreshTokenReplay.create).toHaveBeenCalledWith({
            data: {
                sessionId: 's-refresh',
                validatorHash: (service as any).hashRefreshToken(rawRefreshToken),
            },
        });
        expect(mockPrisma.$queryRaw.mock.calls.some((call) => String(call[0]?.join?.('')).includes('FOR UPDATE'))).toBe(true);
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

    it('revokes an upgraded refresh family when its legacy predecessor is replayed', async () => {
        const rawRefreshToken = 'legacy-refresh-token';
        const storedRefreshToken = (service as any).hashRefreshToken(rawRefreshToken);
        const { state, usedValidators } = installLegacyRefreshSessionHarness(storedRefreshToken);

        const winner = await service.refreshAccessToken(rawRefreshToken);
        expect(usedValidators).toContain(storedRefreshToken);

        await expect(service.refreshAccessToken(rawRefreshToken))
            .rejects
            .toBeInstanceOf(UnauthorizedException);
        expect(state.revokedAt).toBeInstanceOf(Date);
        await expect(service.refreshAccessToken(winner.refreshToken))
            .rejects
            .toBeInstanceOf(UnauthorizedException);
    });

    it('keeps the old validator retryable after transient RBAC failure, then revokes on real replay', async () => {
        const credential = (service as any).generateSelectedRefreshCredential();
        const { state, usedValidators } = installSelectedRefreshSessionHarness(credential);
        mockRbacService.getEffectiveAccess
            .mockRejectedValueOnce(new Error('transient RBAC dependency failure'))
            .mockResolvedValue({
                primaryRole: 'STAFF',
                roles: [],
                permissions: ['dashboard:access'],
            });

        await expect(service.refreshAccessToken(credential.token))
            .rejects
            .toThrow('transient RBAC dependency failure');
        expect(usedValidators.size).toBe(0);
        expect(state.refreshToken).toBe(credential.validatorHash);
        expect(state.revokedAt).toBeNull();

        const winner = await service.refreshAccessToken(credential.token);
        expect(usedValidators).toContain(credential.validatorHash);
        await expect(service.refreshAccessToken(credential.token))
            .rejects
            .toBeInstanceOf(UnauthorizedException);
        expect(state.revokedAt).toBeInstanceOf(Date);
        await expect(service.refreshAccessToken(winner.refreshToken))
            .rejects
            .toBeInstanceOf(UnauthorizedException);
    });

    it('keeps the old validator retryable after transient Redis MFA lookup failure', async () => {
        const credential = (service as any).generateSelectedRefreshCredential();
        const { state, usedValidators } = installSelectedRefreshSessionHarness(credential);
        state.user.mfaEnabled = true;
        redis.get
            .mockRejectedValueOnce(new Error('transient Redis dependency failure'))
            .mockResolvedValue('1');

        await expect(service.refreshAccessToken(credential.token))
            .rejects
            .toThrow('transient Redis dependency failure');
        expect(usedValidators.size).toBe(0);
        expect(state.refreshToken).toBe(credential.validatorHash);
        expect(state.revokedAt).toBeNull();

        await expect(service.refreshAccessToken(credential.token)).resolves.toMatchObject({
            refreshToken: expect.stringMatching(/^v2\./),
            mfaVerified: true,
            requiresMfa: true,
        });
        expect(usedValidators).toContain(credential.validatorHash);
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
            },
            include: { user: true },
        });
        expect(mockPrisma.refreshTokenReplay.create).toHaveBeenCalledWith({
            data: {
                sessionId: 's-selected',
                validatorHash: credential.validatorHash,
            },
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

    it('terminalizes the refresh family when attacker and victim race one validator', async () => {
        const credential = (service as any).generateSelectedRefreshCredential();
        const { state } = installSelectedRefreshSessionHarness(credential);

        const results = await Promise.allSettled([
            service.refreshAccessToken(credential.token),
            service.refreshAccessToken(credential.token),
        ]);

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'rejected'
            && result.reason instanceof UnauthorizedException)).toHaveLength(1);
        expect(state.revokedAt).toBeInstanceOf(Date);
    });

    it('uses a stale predecessor validator to revoke the winning rotation', async () => {
        const credential = (service as any).generateSelectedRefreshCredential();
        const { state, usedValidators } = installSelectedRefreshSessionHarness(credential);

        const winner = await service.refreshAccessToken(credential.token);
        await expect(service.refreshAccessToken(credential.token))
            .rejects
            .toBeInstanceOf(UnauthorizedException);

        expect(usedValidators).toContain(credential.validatorHash);
        expect(state.revokedAt).toBeInstanceOf(Date);
        await expect(service.refreshAccessToken(winner.refreshToken))
            .rejects
            .toBeInstanceOf(UnauthorizedException);
    });

    it('does not let a random validator revoke a selected refresh family', async () => {
        const credential = (service as any).generateSelectedRefreshCredential();
        const { state } = installSelectedRefreshSessionHarness(credential);
        const winner = await service.refreshAccessToken(credential.token);
        const randomToken = `v2.${credential.selector}.${'A'.repeat(43)}`;

        await expect(service.refreshAccessToken(randomToken))
            .rejects
            .toBeInstanceOf(UnauthorizedException);

        expect(state.revokedAt).toBeNull();
        await expect(service.refreshAccessToken(winner.refreshToken))
            .resolves
            .toHaveProperty('refreshToken');
    });

    it('makes replay-driven family revocation idempotent', async () => {
        const credential = (service as any).generateSelectedRefreshCredential();
        const { state } = installSelectedRefreshSessionHarness(credential);

        await service.refreshAccessToken(credential.token);
        await expect(service.refreshAccessToken(credential.token))
            .rejects
            .toBeInstanceOf(UnauthorizedException);
        await expect(service.refreshAccessToken(credential.token))
            .rejects
            .toBeInstanceOf(UnauthorizedException);

        const replayRevocations = mockPrisma.session.updateMany.mock.calls
            .map(([call]) => call)
            .filter((call) => call.data.revokedAt);
        expect(replayRevocations).toHaveLength(1);
        expect(state.revokedAt).toBeInstanceOf(Date);
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

    it.each(['revoked', 'already_invalid'] as const)('preserves authoritative logout %s when MFA marker cleanup fails', async status => {
        const session = { id: 's-logout-cleanup', userId: 'u-logout-cleanup',
            user: { id: 'u-logout-cleanup', tenantId: 't-1', role: 'STAFF', deletedAt: null, suspendedAt: null, mfaEnabled: false },
            revokedAt: status === 'already_invalid' ? new Date() : null,
            createdAt: new Date(), expiresAt: new Date(Date.now() + 15 * 60_000) };
        mockPrisma.session.findFirst.mockImplementation(async () => ({ ...session }));
        mockPrisma.session.updateMany.mockImplementation(async ({ data }: any) => {
            session.revokedAt = data.revokedAt;
            return { count: 1 };
        });
        const cleanupFailure = Object.assign(new Error('secret-refresh-token and Redis endpoint must not be logged'), { code: 'ECONNRESET' });
        (service as any).redis.del.mockRejectedValueOnce(cleanupFailure);
        const warning = vi.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
        try {
            await expect(service.revokeSessionByRefreshToken('synthetic-logout-bearer')).resolves.toEqual({ status });
            expect(session.revokedAt).toBeInstanceOf(Date);
            expect(mockPrisma.session.updateMany).toHaveBeenCalledTimes(status === 'revoked' ? 1 : 0);
            expect((service as any).redis.del).toHaveBeenCalledWith('session_mfa:s-logout-cleanup');
            expect(warning).toHaveBeenCalledOnce();
            const diagnostic = JSON.parse(String(warning.mock.calls[0]![0]));
            expect(diagnostic).toEqual({ event: 'auth.logout_mfa_cleanup_failed', errorClass: 'Error',
                category: 'connectivity', code: 'ECONNRESET' });
            await expect(service.validateAccessSession({ sub: session.userId, tenantId: 't-1', sessionId: session.id } as any))
                .rejects.toBeInstanceOf(UnauthorizedException);
        } finally { warning.mockRestore(); }
    });

    it('does not classify logout as complete or clear markers when durable revocation fails', async () => {
        mockPrisma.session.findFirst.mockResolvedValue({ id: 's-logout-db-failure', revokedAt: null,
            expiresAt: new Date(Date.now() + 15 * 60_000) });
        const failure = new Error('owned database failure');
        mockPrisma.session.updateMany.mockRejectedValueOnce(failure);
        await expect(service.revokeSessionByRefreshToken('synthetic-logout-bearer')).rejects.toBe(failure);
        expect((service as any).redis.del).not.toHaveBeenCalled();
    });
    function installDurableEnrollmentStatements(session: { id: string; userId: string }, initialSecret?: string) {
        let encrypted = initialSecret ? (service as any).encryptMfaSecret(initialSecret) : null;
        let deadline = new Date(Date.now() + 600_000);
        mockPrisma.$queryRaw.mockImplementation(async (parts: TemplateStringsArray, ...values: unknown[]) => {
            const sql = parts.join('');
            if (sql.includes('AS "now"')) return [{ now: new Date() }];
            if (sql.includes('UPDATE "Session"') && sql.includes('interval')) {
                expect(values.slice(1)).toEqual([600, session.id, session.userId]);
                encrypted = values[0] as string; deadline = new Date(Date.now() + 600_000);
                return [{ id: session.id, mfaEnrollmentExpiresAt: deadline }];
            }
            if (sql.includes('SELECT "id", "mfaEnrollmentSecret"')) {
                expect(values).toEqual([session.id, session.userId]);
                return [{ id: session.id, mfaEnrollmentSecret: encrypted, mfaEnrollmentExpiresAt: deadline }];
            }
            if (sql.includes('UPDATE "Session"') && sql.includes('"mfaEnrollmentSecret" = NULL')) {
                expect(values).toEqual([session.id, session.userId, encrypted, deadline.toISOString()]);
                encrypted = null; return [{ id: session.id }];
            }
            return [];
        });
    }

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

        process.env.MFA_SECRET_ENCRYPTION_KEY = 'mfa-test-key-with-enough-entropy';
        installDurableEnrollmentStatements(session);
        const enrollment = await service.beginMfaEnrollment('u-enroll', { tenantId: 't-1', sessionId: 's-enroll' });
        const secretBuffer = (service as any).secretToBuffer(enrollment.secret);
        const code = (service as any).generateTotpCode(secretBuffer, Math.floor(Date.now() / 30_000));

        const result = await service.confirmMfaEnrollment(
            'u-enroll',
            code,
            { tenantId: 't-1', sessionId: 's-enroll' },
            { ipAddress: '203.0.113.45', userAgent: 'Vitest MFA Enrollment' },
        );
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
        expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
            data: {
                tenantId: 't-1',
                userId: 'u-enroll',
                actorUserId: 'u-enroll',
                actorTenantId: 't-1',
                action: 'MFA_ENABLED',
                resource: 'User',
                resourceId: 'u-enroll',
                newValue: { mfaEnabled: true },
                ipAddress: '203.0.113.45',
                userAgent: 'Vitest MFA Enrollment',
            },
        });
        expect(redis.get).not.toHaveBeenCalled();
        expect(redis.del).not.toHaveBeenCalled();
        expect(redis.set).toHaveBeenCalledWith('session_mfa:s-enroll', '1', 'EX', expect.any(Number));
        expect(result.backupCodes).toHaveLength(10);
        expect(result).toEqual(expect.objectContaining({ success: true, mfaVerified: true, accessToken: 'test-access-token' }));
    });

    it('returns committed backup codes once when post-commit Redis marker publication fails', async () => {
        const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
        const session = {
            id: 's-enroll-redis-failure',
            userId: 'u-enroll-redis-failure',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            revokedAt: null,
        };
        mockPrisma.user.findFirst.mockResolvedValue({
            id: session.userId,
            tenantId: 't-1',
            role: 'ADMIN',
            email: 'admin@example.com',
            username: null,
            pinResetRequired: false,
            mfaEnabled: false,
            mfaSecret: null,
            mfaBackupCodes: [],
        });
        mockPrisma.session.findFirst.mockResolvedValue(session);
        mockPrisma.user.update.mockResolvedValue({});
        process.env.MFA_SECRET_ENCRYPTION_KEY = 'mfa-test-key-with-enough-entropy';
        installDurableEnrollmentStatements(session, secret);
        const providerSecret = 'redis://default:plaintext-backup-code-risk@private-cache.internal:6379';
        redis.del.mockRejectedValue(Object.assign(
            new Error(`DEL failed against ${providerSecret}`),
            { code: 'ECONNRESET' },
        ));
        redis.set.mockRejectedValue(Object.assign(
            new Error(`SET failed against ${providerSecret}`),
            { code: 'ETIMEDOUT' },
        ));
        const warning = vi.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
        process.env.MFA_SECRET_ENCRYPTION_KEY = 'mfa-test-key-with-enough-entropy';
        const code = (service as any).generateTotpCode(
            (service as any).secretToBuffer(secret),
            Math.floor(Date.now() / 30_000),
        );

        const result = await service.confirmMfaEnrollment(
            session.userId,
            code,
            { tenantId: 't-1', sessionId: session.id },
        );

        expect(result).toEqual(expect.objectContaining({
            success: true,
            mfaVerified: true,
            backupCodes: expect.arrayContaining([expect.stringMatching(/^[A-Z0-9-]+$/)]),
            accessToken: 'test-access-token',
        }));
        expect(result.backupCodes).toHaveLength(10);
        expect(mockPrisma.$transaction).toHaveBeenCalledOnce();
        expect(mockRbacService.authorizeSelfSecurityMutationInTransaction).toHaveBeenCalledOnce();
        expect(mockPrisma.user.update).toHaveBeenCalledOnce();
        expect(mockPrisma.auditLog.create).toHaveBeenCalledOnce();
        expect(mockJwtService.generateAccessToken).toHaveBeenCalledOnce();
        expect(redis.get).not.toHaveBeenCalled();
        expect(redis.del).not.toHaveBeenCalled();
        expect(redis.set).toHaveBeenCalledOnce();
        expect(warning).toHaveBeenCalledOnce();
        const diagnostics = JSON.stringify(warning.mock.calls);
        expect(diagnostics).not.toContain('auth.mfa_enrollment_cleanup_failed');
        expect(diagnostics).toContain('auth.mfa_enrollment_session_marker_failed');
        expect(diagnostics).not.toContain('ECONNRESET');
        expect(diagnostics).toContain('ETIMEDOUT');
        expect(diagnostics).not.toContain(providerSecret);
        expect(diagnostics).not.toContain('plaintext-backup-code-risk');
        expect(diagnostics).not.toContain('DEL failed');
        expect(diagnostics).not.toContain('SET failed');
    });

    it('denies MFA confirmation after exact-session revocation with zero MFA, audit, or Redis writes', async () => {
        const secret = 'JBSWY3DPEHPK3PXP';
        const code = (service as any).generateTotpCode(
            (service as any).secretToBuffer(secret),
            Math.floor(Date.now() / 30_000),
        );
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'u-enroll',
            tenantId: 't-1',
            role: 'STAFF',
            email: 'staff@example.com',
            username: null,
            pinResetRequired: false,
            mfaEnabled: false,
            mfaSecret: null,
            mfaBackupCodes: [],
        });
        mockPrisma.session.findFirst.mockResolvedValue({
            id: 's-enroll',
            userId: 'u-enroll',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            revokedAt: null,
        });
        redis.get.mockResolvedValue(secret);
        mockRbacService.authorizeSelfSecurityMutationInTransaction.mockRejectedValueOnce(
            new ForbiddenException('Administrator session is no longer active'),
        );

        await expect(service.confirmMfaEnrollment(
            'u-enroll',
            code,
            { tenantId: 't-1', sessionId: 's-enroll' },
        )).rejects.toBeInstanceOf(ForbiddenException);

        expect(mockRbacService.authorizeSelfSecurityMutationInTransaction).toHaveBeenCalledWith(
            mockPrisma,
            't-1',
            { actorUserId: 'u-enroll', actorSessionId: 's-enroll' },
        );
        expect(mockPrisma.mfaTotpClaim.create).not.toHaveBeenCalled();
        expect(mockPrisma.user.update).not.toHaveBeenCalled();
        expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
        expect(redis.del).not.toHaveBeenCalled();
        expect(redis.set).not.toHaveBeenCalled();
    });

    it('denies MFA disable after a concurrent privileged-role promotion with zero MFA, session, audit, or Redis writes', async () => {
        const backupCode = 'ABCD-EFGH-IJKL';
        mockPrisma.user.findFirst.mockResolvedValue({
            id: 'u-disable',
            tenantId: 't-1',
            role: 'ADMIN',
            email: 'admin@example.com',
            username: null,
            pinResetRequired: false,
            mfaEnabled: true,
            mfaSecret: 'JBSWY3DPEHPK3PXP',
            mfaBackupCodes: [(service as any).hashBackupCode(backupCode)],
        });
        mockPrisma.session.findFirst.mockResolvedValue({
            id: 's-disable',
            userId: 'u-disable',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            revokedAt: null,
        });
        mockRbacService.authorizeSelfSecurityMutationInTransaction.mockResolvedValueOnce({
            primaryRole: 'Admin',
            roles: [],
            permissions: ['users:admin'],
        });

        await expect(service.disableMfa(
            'u-disable',
            backupCode,
            { tenantId: 't-1', sessionId: 's-disable' },
        )).rejects.toThrow('MFA is required for administrative access');

        expect(mockPrisma.mfaTotpClaim.create).not.toHaveBeenCalled();
        expect(mockPrisma.user.update).not.toHaveBeenCalled();
        expect(mockPrisma.session.updateMany).not.toHaveBeenCalled();
        expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
        expect(redis.del).not.toHaveBeenCalled();
        expect(redis.set).not.toHaveBeenCalled();
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
            { ipAddress: '203.0.113.46', userAgent: 'Vitest MFA Disable' },
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
        expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
            data: {
                tenantId: 't-1',
                userId: 'u-disable',
                actorUserId: 'u-disable',
                actorTenantId: 't-1',
                action: 'MFA_DISABLED',
                resource: 'User',
                resourceId: 'u-disable',
                newValue: { mfaEnabled: false, sessionsRevoked: 1 },
                ipAddress: '203.0.113.46',
                userAgent: 'Vitest MFA Disable',
            },
        });
        expect(mockPrisma.session.updateMany).toHaveBeenCalledWith({
            where: { userId: 'u-disable', revokedAt: null },
            data: { revokedAt: expect.any(Date) },
        });
        expect(redis.del).toHaveBeenCalledWith('session_mfa:s-disable');
    });

    it('revokes every active session before best-effort marker cleanup when MFA is disabled', async () => {
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
            where: { userId: 'u-disable', revokedAt: null },
            select: { id: true },
        });
        expect(mockPrisma.session.updateMany).toHaveBeenCalledWith({
            where: { userId: 'u-disable', revokedAt: null },
            data: { revokedAt: expect.any(Date) },
        });
        expect(redis.del).toHaveBeenCalledTimes(1);
        expect(redis.del).toHaveBeenCalledWith(
            'session_mfa:s-current',
            'session_mfa:s-other',
        );
    });

    it('keeps MFA disabled and sessions revoked when Redis marker cleanup fails', async () => {
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
        mockPrisma.session.findMany.mockResolvedValue([{ id: 's-current' }]);
        redis.del.mockRejectedValue(new Error('redis cleanup unavailable'));

        await expect(service.disableMfa(
            'u-disable',
            backupCode,
            { tenantId: 't-1', sessionId: 's-current' },
        )).resolves.toEqual({ success: true, mfaEnabled: false });

        expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
            data: { mfaEnabled: false, mfaSecret: null, mfaBackupCodes: [] },
        }));
        expect(mockPrisma.session.updateMany).toHaveBeenCalledWith({
            where: { userId: 'u-disable', revokedAt: null },
            data: { revokedAt: expect.any(Date) },
        });
    });

    it('rolls back MFA factor removal and session revocation when audit insertion fails', async () => {
        const backupCode = 'ABCD-EFGH-IJKL';
        const backupHash = (service as any).hashBackupCode(backupCode);
        const account = {
            id: 'u-disable-rollback',
            tenantId: 't-1',
            role: 'STAFF',
            email: 'staff@example.com',
            username: null,
            pinResetRequired: false,
            mfaEnabled: true,
            mfaSecret: 'JBSWY3DPEHPK3PXP',
            mfaBackupCodes: [backupHash],
            deletedAt: null,
            suspendedAt: null,
        };
        const sessions = [{ id: 's-disable-rollback', userId: account.id, revokedAt: null,
            createdAt: new Date(), expiresAt: new Date(Date.now() + 15 * 60_000) }];
        mockPrisma.user.findFirst.mockResolvedValue({ ...account });
        mockPrisma.session.findFirst.mockResolvedValue({
            ...sessions[0],
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        });
        installAuditFailureRollbackHarness(account, sessions, new Error('audit unavailable'));

        await expect(service.disableMfa(
            account.id,
            backupCode,
            { tenantId: account.tenantId, sessionId: sessions[0].id },
        )).rejects.toThrow('audit unavailable');

        expect(account.mfaEnabled).toBe(true);
        expect(account.mfaSecret).toBe('JBSWY3DPEHPK3PXP');
        expect(account.mfaBackupCodes).toEqual([backupHash]);
        expect(sessions[0].revokedAt).toBeNull();
        expect(redis.del).not.toHaveBeenCalled();
    });

    it('does not allow admin portal users to disable required MFA', async () => {
        mockRbacService.authorizeSelfSecurityMutationInTransaction.mockResolvedValue({
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


describe('AuthService - policy commit at session issuance', () => {
    let service: AuthService;
    let policy: { requireMfaForAll: boolean; sessionTimeoutMinutes: number; ssoOidcOnly: boolean };
    let account: Record<string, any>;

    beforeEach(() => {
        vi.clearAllMocks();
        resetPrismaMocks();
        service = new AuthService(mockConfigService as any, mockJwtService as any, mockRbacService as any);
        (service as any).prisma = mockPrisma;
        policy = { requireMfaForAll: false, sessionTimeoutMinutes: 480, ssoOidcOnly: false };
        account = { id: 'u-policy', tenantId: 't-1', role: 'STAFF', email: 'policy@example.test',
            username: 'policy.user', passwordHash: 'verified-password-hash', pinHash: 'verified-pin-hash',
            mfaEnabled: false, pinResetRequired: false, pinLockedUntil: null, deletedAt: null, suspendedAt: null };
        mockPrisma.tenantSetting.findUnique.mockImplementation(async () => ({ value: { security: { ...policy } } }));
        mockPrisma.user.findFirst.mockImplementation(async () => ({ ...account }));
        mockPrisma.session.create.mockImplementation(async ({ data }) => ({ id: 's-policy', ...data }));
        mockRbacService.getEffectiveAccess.mockReset().mockResolvedValue({ primaryRole: 'STAFF', roles: [],
            permissions: ['auth:login_pin', 'auth:login_password', 'auth:login_email', 'dashboard:access'] });
    });

    function pauseTenantLock() {
        let enter!: () => void, release!: () => void;
        const entered = new Promise<void>(resolve => { enter = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        mockPrisma.$queryRaw.mockImplementation(async (sql: unknown) => {
            const strings = Array.isArray(sql) ? sql : (sql as { strings?: string[] }).strings ?? [];
            if (strings.join('').includes('FROM "Tenant"')) { enter(); await gate; }
            return [{ id: 't-1' }];
        });
        return { entered, release };
    }

    function issue(method: 'USERNAME_PIN' | 'USERNAME_PASSWORD' | 'EMAIL_OTP' | 'OIDC') {
        return (service as any).createSessionTokens(account, { loginMethod: method }, true, null,
            { username: account.username, pinHash: account.pinHash },
            { passwordHash: account.passwordHash }, { email: account.email });
    }

    it.each([
        ['EMAIL_OTP', 'auth:login_email'],
        ['USERNAME_PASSWORD', 'auth:login_password'],
        ['USERNAME_PIN', 'auth:login_pin'],
    ] as const)('rejects %s when its login grant is revoked while issuance waits', async (method, permission) => {
        const lock = pauseTenantLock();
        const pending = issue(method).then((value: unknown) => ({ value, error: undefined }),
            (error: unknown) => ({ error, value: undefined }));
        try {
            await lock.entered;
            mockRbacService.getEffectiveAccess.mockResolvedValue({ primaryRole: 'STAFF',
                roles: [{ id: 'staff-role', name: 'Staff', isSystem: true, legacyRole: 'STAFF' }],
                permissions: ['auth:login_pin', 'auth:login_password', 'auth:login_email', 'dashboard:access']
                    .filter(value => value !== permission) });
            lock.release();
            const result = await pending;
            expect(result.error).toBeInstanceOf(UnauthorizedException);
            expect(result.value).toBeUndefined();
            expect(mockRbacService.getEffectiveAccess).toHaveBeenCalledWith(account.id, account.tenantId);
            expect(mockPrisma.session.create).not.toHaveBeenCalled();
            expect(mockPrisma.session.deleteMany).not.toHaveBeenCalled();
            expect(mockPrisma.user.update).not.toHaveBeenCalled();
            expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
            expect(mockJwtService.generateAccessToken).not.toHaveBeenCalled();
            expect(mockJwtService.generateCsrfToken).not.toHaveBeenCalled();
        } finally { lock.release(); await pending; }
    });

    it('issues an email session when its current login grant remains present', async () => {
        const lock = pauseTenantLock(), pending = issue('EMAIL_OTP');
        await lock.entered;
        lock.release();
        await expect(pending).resolves.toHaveProperty('accessToken');
        expect(mockPrisma.session.create).toHaveBeenCalledOnce();
    });

    it.each(['USERNAME_PIN', 'USERNAME_PASSWORD', 'EMAIL_OTP'] as const)(
        'rejects %s when SSO-only policy commits while issuance waits for Tenant', async method => {
            const lock = pauseTenantLock();
            const pending = issue(method).then((value: unknown) => ({ value, error: undefined }),
                (error: unknown) => ({ error, value: undefined }));
            await lock.entered;
            policy.ssoOidcOnly = true;
            lock.release();
            const result = await pending;
            expect(result.error).toBeInstanceOf(method === 'USERNAME_PIN' ? UnauthorizedException : ForbiddenException);
            expect(result.value).toBeUndefined();
            expect(mockPrisma.session.create).not.toHaveBeenCalled();
            expect(mockPrisma.session.deleteMany).not.toHaveBeenCalled();
            expect(mockPrisma.user.update).not.toHaveBeenCalled();
            expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
            expect(mockJwtService.generateAccessToken).not.toHaveBeenCalled();
            expect(mockJwtService.generateCsrfToken).not.toHaveBeenCalled();
        },
    );

    it('uses committed MFA and session timeout after waiting for Tenant', async () => {
        let now = Date.now();
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
        const lock = pauseTenantLock(), pending = issue('USERNAME_PIN');
        try {
            await lock.entered;
            policy.requireMfaForAll = true;
            policy.sessionTimeoutMinutes = 5;
            now += 60_000;
            lock.release();
            const result = await pending;
            expect(result.requiresMfa).toBe(true);
            expect(result.sessionMaxAgeMs).toBe(5 * 60_000);
            expect(mockJwtService.generateAccessToken).toHaveBeenCalledWith(expect.objectContaining({ mfaVerified: false }));
            const expiry = mockPrisma.session.create.mock.calls[0][0].data.expiresAt.getTime();
            expect(expiry).toBe(now + 5 * 60_000);
        } finally { lock.release(); await Promise.allSettled([pending]); clock.mockRestore(); }
    });

    it('uses a relaxed committed MFA policy and longer timeout after waiting for Tenant', async () => {
        policy.requireMfaForAll = true;
        policy.sessionTimeoutMinutes = 5;
        const lock = pauseTenantLock(), pending = issue('USERNAME_PIN');
        try {
            await lock.entered;
            policy.requireMfaForAll = false;
            policy.sessionTimeoutMinutes = 480;
            lock.release();
            const result = await pending;
            expect(result.requiresMfa).toBe(false);
            expect(result.sessionMaxAgeMs).toBe(480 * 60_000);
            expect(mockJwtService.generateAccessToken).toHaveBeenCalledWith(expect.objectContaining({ mfaVerified: true }));
        } finally { lock.release(); await Promise.allSettled([pending]); }
    });

    it.each(['Tenant lock', 'locked policy read'] as const)('fails before issuance writes when %s fails', async boundary => {
        const failure = new Error('owned policy boundary failure');
        if (boundary === 'Tenant lock') {
            mockPrisma.$queryRaw.mockImplementation(async (sql: unknown) => {
                const strings = Array.isArray(sql) ? sql : (sql as { strings?: string[] }).strings ?? [];
                if (strings.join('').includes('FROM "Tenant"')) throw failure;
                return [{ id: 't-1' }];
            });
        } else mockPrisma.tenantSetting.findUnique.mockRejectedValue(failure);
        await expect(issue('USERNAME_PIN')).rejects.toBe(failure);
        expect(mockPrisma.session.create).not.toHaveBeenCalled();
        expect(mockPrisma.session.deleteMany).not.toHaveBeenCalled();
        expect(mockPrisma.user.update).not.toHaveBeenCalled();
        expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
        expect(mockJwtService.generateAccessToken).not.toHaveBeenCalled();
        expect(mockJwtService.generateCsrfToken).not.toHaveBeenCalled();
    });

    it('allows OIDC under the newly committed SSO-only policy', async () => {
        const lock = pauseTenantLock(), pending = issue('OIDC');
        await lock.entered;
        policy.ssoOidcOnly = true;
        lock.release();
        await expect(pending).resolves.toHaveProperty('accessToken');
        expect(mockPrisma.session.create).toHaveBeenCalledOnce();
    });
});

describe('AuthService - PIN proof transaction boundaries', () => {
    let service: AuthService;
    let account: {
        id: string; tenantId: string; role: string; email: null; username: string;
        pinHash: string | null; pinLoginAttempts: number; pinLockedUntil: Date | null;
        deletedAt: Date | null; suspendedAt: Date | null;
        mfaEnabled: boolean; pinResetRequired: boolean;
    };
    const access = { primaryRole: 'STAFF', roles: [], permissions: ['auth:login_pin', 'dashboard:access'] };

    beforeEach(() => {
        vi.clearAllMocks();
        resetPrismaMocks();
        mockRbacService.getEffectiveAccess.mockReset().mockResolvedValue(access);
        service = new AuthService(mockConfigService as any, mockJwtService as any, mockRbacService as any);
        (service as any).prisma = mockPrisma;
        account = {
            id: 'u-pin-proof', tenantId: 't-1', role: 'STAFF', email: null, username: 'proof.user',
            pinHash: (service as any).hashPin('123456'), pinLoginAttempts: 0, pinLockedUntil: null,
            deletedAt: null, suspendedAt: null, mfaEnabled: false, pinResetRequired: false,
        };
        mockPrisma.user.findFirst.mockImplementation(async () => account.deletedAt || account.suspendedAt
            ? null : { ...account });
        mockPrisma.user.update.mockImplementation(async ({ data }: { data: Partial<typeof account> }) => {
            Object.assign(account, data);
            return { ...account };
        });
        mockPrisma.session.create.mockResolvedValue({ id: 's-pin-proof' });
    });

    function deferVerification() {
        let release!: (valid: boolean) => void;
        let started!: () => void;
        const entered = new Promise<void>(resolve => { started = resolve; });
        const result = new Promise<boolean>(resolve => { release = resolve; });
        vi.spyOn(service as any, 'verifyLoginPin').mockImplementation(() => { started(); return result; });
        return { entered, release };
    }

    function expectNoIssuanceWrites() {
        expect(mockPrisma.session.create).not.toHaveBeenCalled();
        expect(mockPrisma.session.deleteMany).not.toHaveBeenCalled();
        expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
        expect(mockJwtService.generateAccessToken).not.toHaveBeenCalled();
        expect(mockJwtService.generateCsrfToken).not.toHaveBeenCalled();
    }

    it('verifies asynchronous PIN hashes compatibly and rejects malformed hashes', async () => {
        await expect((service as any).verifyLoginPin('123456', account.pinHash)).resolves.toBe(true);
        await expect((service as any).verifyLoginPin('654321', account.pinHash)).resolves.toBe(false);
        await expect((service as any).verifyLoginPin('123456', 'missing-separator')).resolves.toBe(false);
        await expect((service as any).verifyLoginPin('123456', 'salt:not-hex')).resolves.toBe(false);
    });

    it('rejects PIN session issuance without a verified credential proof before any writes', async () => {
        await expect((service as any).createSessionTokens(account, { loginMethod: 'USERNAME_PIN' }))
            .rejects.toBeInstanceOf(UnauthorizedException);
        expectNoIssuanceWrites();
        expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('holds no tenant transaction or User lock while deferred verification is running', async () => {
        let activeTransactions = 0;
        mockPrisma.$transaction.mockImplementation(async (operation: (tx: typeof mockPrisma) => Promise<unknown>) => {
            activeTransactions++;
            try { return await operation(mockPrisma); }
            finally { activeTransactions--; }
        });
        const pending = deferVerification();
        const login = service.loginWithUsernamePin('proof.user', '123456', 'demo');
        await pending.entered;
        expect(activeTransactions).toBe(0);
        expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
        expect(mockPrisma.user.update).not.toHaveBeenCalled();
        expectNoIssuanceWrites();
        pending.release(true);
        await expect(login).resolves.toHaveProperty('accessToken');
        expect(mockPrisma.$queryRaw).toHaveBeenCalled();
    });

    for (const valid of [false, true]) {
        it.each([
            ['rotated hash', () => { account.pinHash = 'new-salt:' + 'a'.repeat(128); }],
            ['removed hash', () => { account.pinHash = null; }],
            ['renamed username', () => { account.username = 'renamed.user'; }],
            ['deleted user', () => { account.deletedAt = new Date(); }],
            ['suspended user', () => { account.suspendedAt = new Date(); }],
        ] as const)(`rejects a %s during KDF after ${valid ? 'successful' : 'failed'} verification without charging replacement counters`, async (_name, mutate) => {
            account.pinLoginAttempts = 3;
            const pending = deferVerification();
            const login = service.loginWithUsernamePin('proof.user', valid ? '123456' : '0000', 'demo');
            await pending.entered;
            mutate();
            pending.release(valid);
            await expect(login).rejects.toBeInstanceOf(UnauthorizedException);
            expect(account.pinLoginAttempts).toBe(3);
            expect(mockPrisma.user.update).not.toHaveBeenCalled();
            expectNoIssuanceWrites();
        });
    }

    it('rejects a lockout imposed during verification without clearing counters', async () => {
        const pending = deferVerification();
        const login = service.loginWithUsernamePin('proof.user', '123456', 'demo');
        await pending.entered;
        account.pinLoginAttempts = 5;
        account.pinLockedUntil = new Date(Date.now() + 15 * 60_000);
        pending.release(true);
        await expect(login).rejects.toBeInstanceOf(UnauthorizedException);
        expect(account.pinLoginAttempts).toBe(5);
        expect(mockPrisma.user.update).not.toHaveBeenCalled();
        expectNoIssuanceWrites();
    });

    it.each(['invalid format', 'missing user', 'missing hash', 'locked user'] as const)(
        'performs %s verification outside transactions and writes no session', async scenario => {
            if (scenario === 'missing user') account.deletedAt = new Date();
            if (scenario === 'missing hash') account.pinHash = null;
            if (scenario === 'locked user') account.pinLockedUntil = new Date(Date.now() + 60_000);
            let activeTransactions = 0;
            mockPrisma.$transaction.mockImplementation(async (operation: (tx: typeof mockPrisma) => Promise<unknown>) => {
                activeTransactions++;
                try { return await operation(mockPrisma); }
                finally { activeTransactions--; }
            });
            const verify = vi.spyOn(service as any, 'verifyLoginPin').mockImplementation(async () => {
                expect(activeTransactions).toBe(0);
                return true;
            });
            const syncVerify = vi.spyOn(service as any, 'verifyPin');
            await expect(service.loginWithUsernamePin('proof.user', scenario === 'invalid format' ? 'x' : '123456', 'demo'))
                .rejects.toBeInstanceOf(UnauthorizedException);
            expect(verify).toHaveBeenCalledOnce();
            expect(syncVerify).not.toHaveBeenCalled();
            expect(mockPrisma.user.update).not.toHaveBeenCalled();
            expectNoIssuanceWrites();
        },
    );

    it('clears only expired PIN lockout and current counters after same-proof verification', async () => {
        account.pinLoginAttempts = 4;
        account.pinLockedUntil = new Date(Date.now() - 1_000);
        await expect(service.loginWithUsernamePin('proof.user', '123456', 'demo')).resolves.toHaveProperty('accessToken');
        expect(mockPrisma.user.update).toHaveBeenCalledWith({
            where: { id: account.id }, data: { pinLoginAttempts: 0, pinLockedUntil: null },
        });
        expect(account.pinLoginAttempts).toBe(0);
        expect(account.pinLockedUntil).toBeNull();
    });

    it.each([
        ['rotated hash', () => { account.pinHash = 'replacement:' + 'b'.repeat(128); }],
        ['removed hash', () => { account.pinHash = null; }],
        ['renamed username', () => { account.username = 'renamed.user'; }],
        ['new PIN lockout', () => { account.pinLockedUntil = new Date(Date.now() + 60_000); }],
        ['deleted user', () => { account.deletedAt = new Date(); }],
        ['suspended user', () => { account.suspendedAt = new Date(); }],
    ] as const)('rejects a %s after credential commit before any issuance writes', async (_name, mutate) => {
        mockRbacService.getEffectiveAccess.mockImplementationOnce(async () => { mutate(); return access; });
        await expect(service.loginWithUsernamePin('proof.user', '123456', 'demo')).rejects.toBeInstanceOf(UnauthorizedException);
        expect(mockPrisma.user.update).not.toHaveBeenCalled();
        expectNoIssuanceWrites();
    });

    it('rejects freshly revoked PIN permission while the issuance User lock is held', async () => {
        let userLocked = false;
        mockPrisma.$transaction.mockImplementation(async (operation: (tx: typeof mockPrisma) => Promise<unknown>) => {
            userLocked = false;
            try { return await operation(mockPrisma); }
            finally { userLocked = false; }
        });
        mockPrisma.$queryRaw.mockImplementation(async (sql: unknown) => {
            const strings = Array.isArray(sql) ? sql : (sql as { strings?: string[] }).strings ?? [];
            if (strings.join('').includes('FROM "User"')) userLocked = true;
            return [{ id: account.id }];
        });
        mockRbacService.getEffectiveAccess.mockResolvedValueOnce(access)
            .mockImplementationOnce(async () => {
                expect(userLocked).toBe(true);
                return { ...access, permissions: ['dashboard:access'] };
            });
        await expect(service.loginWithUsernamePin('proof.user', '123456', 'demo')).rejects.toBeInstanceOf(UnauthorizedException);
        expect(mockRbacService.getEffectiveAccess).toHaveBeenCalledTimes(2);
        expect(mockPrisma.user.update).not.toHaveBeenCalled();
        expectNoIssuanceWrites();
    });

    it('rejects PIN issuance when current security settings switch to OIDC-only', async () => {
        mockRbacService.getEffectiveAccess.mockImplementationOnce(async () => {
            mockPrisma.tenantSetting.findUnique.mockResolvedValue({ value: { security: { ssoOidcOnly: true } } });
            return access;
        });
        await expect(service.loginWithUsernamePin('proof.user', '123456', 'demo')).rejects.toBeInstanceOf(UnauthorizedException);
        expect(mockPrisma.user.update).not.toHaveBeenCalled();
        expectNoIssuanceWrites();
    });

    it('uses latest PIN-reset and MFA state at issuance without changing the verified credential', async () => {
        mockRbacService.getEffectiveAccess.mockImplementationOnce(async () => {
            account.pinResetRequired = true;
            account.mfaEnabled = true;
            return access;
        });
        const result = await service.loginWithUsernamePin('proof.user', '123456', 'demo');
        expect(result.pinResetRequired).toBe(true);
        expect(result.requiresMfa).toBe(true);
        expect(mockJwtService.generateAccessToken).toHaveBeenCalledWith(expect.objectContaining({
            pinResetRequired: true, mfaVerified: false,
        }));
    });

    it.each([1, 2])('surfaces transaction failure at User lock %i without issuing tokens', async failingLock => {
        let userLocks = 0;
        const failure = new Error('owned transaction failure');
        mockPrisma.$queryRaw.mockImplementation(async (sql: unknown) => {
            const strings = Array.isArray(sql) ? sql : (sql as { strings?: string[] }).strings ?? [];
            if (strings.join('').includes('FROM "User"') && ++userLocks === failingLock) throw failure;
            return [{ id: account.id }];
        });
        await expect(service.loginWithUsernamePin('proof.user', '123456', 'demo')).rejects.toBe(failure);
        expectNoIssuanceWrites();
    });

    it('surfaces asynchronous KDF failure before taking a credential lock or changing counters', async () => {
        const failure = new Error('owned KDF failure');
        vi.spyOn(service as any, 'verifyLoginPin').mockRejectedValue(failure);
        await expect(service.loginWithUsernamePin('proof.user', '123456', 'demo')).rejects.toBe(failure);
        expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
        expect(mockPrisma.user.update).not.toHaveBeenCalled();
        expectNoIssuanceWrites();
    });
});
