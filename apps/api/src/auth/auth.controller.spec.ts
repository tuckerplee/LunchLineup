import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ALLOW_AUTHENTICATED_METADATA_KEY } from './require-permission.decorator';
import { PUBLIC_LEGAL_MANIFEST } from '@lunchlineup/config';

const CURRENT_TERMS_VERSION = PUBLIC_LEGAL_MANIFEST.documents.terms.version;
const CURRENT_PRIVACY_VERSION = PUBLIC_LEGAL_MANIFEST.documents.privacy.version;

function createResponseMock() {
    return {
        cookie: vi.fn(),
        redirect: vi.fn(),
        json: vi.fn(),
        clearCookie: vi.fn(),
    } as any;
}

function createRequestMock(overrides: Record<string, unknown> = {}) {
    const request = {
        query: {},
        headers: {},
        protocol: 'https',
        ...overrides,
    } as any;
    request.get = (name: string) => request.headers?.[name.toLowerCase()];
    return request;
}

describe('AuthController', () => {
    let controller: AuthController;
    let authService: any;
    let otpService: any;
    let emailService: any;

    beforeEach(() => {
        authService = {
            resolveLoginMethod: vi.fn(),
            loginWithUsernamePin: vi.fn(),
            loginWithUsernamePassword: vi.fn(),
            createPasswordReset: vi.fn(),
            resetPasswordWithToken: vi.fn(),
            loginWithEmail: vi.fn(),
            handleOidcCallback: vi.fn(),
            createOidcState: vi.fn(),
            consumeOidcState: vi.fn(),
            assertEmailOtpAllowed: vi.fn().mockResolvedValue(true),
            createOnboardingSignupChallenge: vi.fn().mockResolvedValue({ code: '123456', challengeToken: 'challenge-token' }),
            refreshAccessToken: vi.fn(),
            getMfaEnrollmentState: vi.fn(),
            beginMfaEnrollment: vi.fn(),
            confirmMfaEnrollment: vi.fn(),
            validateMfa: vi.fn(),
            disableMfa: vi.fn(),
            revokeSession: vi.fn(),
            revokeSessionByRefreshToken: vi.fn(),
        };
        otpService = {
            generateOtp: vi.fn().mockResolvedValue('123456'),
            verifyOtp: vi.fn(),
        };
        emailService = {
            sendOtp: vi.fn(),
            sendPasswordReset: vi.fn(),
        };
        controller = new AuthController(authService, otpService, emailService);
    });

    it('resolves login flow for identifier', async () => {
        authService.resolveLoginMethod.mockResolvedValue({
            flow: 'USERNAME_PASSWORD',
            normalizedIdentifier: 'shiftlead',
        });

        const result = await controller.resolveLoginFlow({ identifier: 'ShiftLead', tenantSlug: 'demo' }, createRequestMock());

        expect(authService.resolveLoginMethod).toHaveBeenCalledWith('ShiftLead', 'demo');
        expect(result).toEqual({
            success: true,
            flow: 'USERNAME_PASSWORD',
            identifier: 'shiftlead',
            pinResetRequired: false,
        });
    });

    it('rejects production login flow resolution without Origin or Referer', async () => {
        const previousNodeEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        const req = createRequestMock({ headers: { host: 'app.example.com' } });

        try {
            await expect(controller.resolveLoginFlow({ identifier: 'ShiftLead', tenantSlug: 'demo' }, req))
                .rejects
                .toBeInstanceOf(ForbiddenException);
        } finally {
            if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = previousNodeEnv;
        }

        expect(authService.resolveLoginMethod).not.toHaveBeenCalled();
    });

    it('uses layered IP and IP-plus-identifier buckets for every pre-auth credential path', () => {
        for (const method of [
            controller.resolveLoginFlow,
            controller.verifyPassword,
            controller.verifyPin,
            controller.sendOtp,
            controller.verifyOtp,
            controller.requestPasswordReset,
            controller.confirmPasswordReset,
        ]) {
            expect(Reflect.getMetadata('THROTTLER:LIMITauthIp', method)).toBe(30);
            expect(Reflect.getMetadata('THROTTLER:TTLauthIp', method)).toBe(15 * 60 * 1000);
            expect(Reflect.getMetadata('THROTTLER:LIMITauthIdentifier', method)).toBe(5);
            expect(Reflect.getMetadata('THROTTLER:TTLauthIdentifier', method)).toBe(15 * 60 * 1000);
            expect(Reflect.getMetadata('THROTTLER:LIMITauth', method)).toBeUndefined();
        }
    });

    it('marks other auth-attempt endpoints with the auth throttler bucket', () => {
        for (const method of [
            controller.beginMfaEnrollment,
            controller.beginMfaEnrollmentAlias,
            controller.confirmMfaEnrollment,
            controller.confirmMfaEnrollmentAlias,
            controller.verifyMfa,
            controller.disableMfa,
            controller.disableMfaAlias,
        ]) {
            expect(Reflect.getMetadata('THROTTLER:LIMITauth', method)).toBe(5);
            expect(Reflect.getMetadata('THROTTLER:TTLauth', method)).toBe(15 * 60 * 1000);
        }
    });

    it('uses independent refresh IP and credential buckets', () => {
        expect(Reflect.getMetadata('THROTTLER:LIMITrefreshIp', controller.refresh)).toBe(100);
        expect(Reflect.getMetadata('THROTTLER:TTLrefreshIp', controller.refresh)).toBe(15 * 60 * 1000);
        expect(Reflect.getMetadata('THROTTLER:LIMITrefreshCredential', controller.refresh)).toBe(5);
        expect(Reflect.getMetadata('THROTTLER:TTLrefreshCredential', controller.refresh)).toBe(15 * 60 * 1000);
        expect(Reflect.getMetadata('THROTTLER:LIMITauth', controller.refresh)).toBeUndefined();
    });

    it('marks session-only auth routes with explicit authenticated-only RBAC metadata', () => {
        for (const method of [
            controller.getMfaEnrollment,
            controller.beginMfaEnrollment,
            controller.beginMfaEnrollmentAlias,
            controller.confirmMfaEnrollment,
            controller.confirmMfaEnrollmentAlias,
            controller.verifyMfa,
            controller.disableMfa,
            controller.disableMfaAlias,
            controller.me,
        ]) {
            expect(Reflect.getMetadata(ALLOW_AUTHENTICATED_METADATA_KEY, method)).toBe(true);
        }
    });


    it('marks refresh-cookie logout public so expired access JWTs cannot block revocation', () => {
        expect(Reflect.getMetadata('isPublic', controller.logout)).toBe(true);
        expect(Reflect.getMetadata(ALLOW_AUTHENTICATED_METADATA_KEY, controller.logout)).toBeUndefined();
    });
    it('starts OIDC login with a persisted state value', async () => {
        const previous = {
            issuer: process.env.OIDC_ISSUER_URL,
            clientId: process.env.OIDC_CLIENT_ID,
            redirectUri: process.env.OIDC_REDIRECT_URI,
            cookieSecure: process.env.COOKIE_SECURE,
        };
        process.env.OIDC_ISSUER_URL = 'https://auth.example.com';
        process.env.OIDC_CLIENT_ID = 'client-1';
        process.env.OIDC_REDIRECT_URI = 'https://app.example.com/auth/callback';
        process.env.COOKIE_SECURE = 'true';
        authService.createOidcState.mockResolvedValue({
            state: 'persisted-state',
            correlationNonce: 'browser-nonce',
            expiresInSeconds: 600,
        });
        const res = createResponseMock();
        const req = { query: { next: '/dashboard/schedules', tenantSlug: 'demo' } } as any;

        await controller.login(req, res);

        expect(authService.createOidcState).toHaveBeenCalledWith('/dashboard/schedules', 'demo');
        expect(res.cookie).toHaveBeenCalledWith('oidc_correlation', 'browser-nonce', {
            httpOnly: true,
            secure: true,
            sameSite: 'lax',
            path: '/',
            maxAge: 600_000,
        });
        expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('state=persisted-state'));

        if (previous.issuer === undefined) delete process.env.OIDC_ISSUER_URL;
        else process.env.OIDC_ISSUER_URL = previous.issuer;
        if (previous.clientId === undefined) delete process.env.OIDC_CLIENT_ID;
        else process.env.OIDC_CLIENT_ID = previous.clientId;
        if (previous.redirectUri === undefined) delete process.env.OIDC_REDIRECT_URI;
        else process.env.OIDC_REDIRECT_URI = previous.redirectUri;
        if (previous.cookieSecure === undefined) delete process.env.COOKIE_SECURE;
        else process.env.COOKIE_SECURE = previous.cookieSecure;
    });

    it('validates OIDC callback state before issuing cookies', async () => {
        authService.consumeOidcState.mockResolvedValue({ nextPath: '/dashboard/staff', tenantSlug: 'demo', createdAt: 123 });
        authService.handleOidcCallback.mockResolvedValue({
            accessToken: 'a',
            refreshToken: 'r',
            csrfToken: 'c',
            requiresMfa: false,
            sessionMaxAgeMs: 15 * 60 * 1000,
        });
        const res = createResponseMock();
        const req = { query: { code: 'code-1', state: 'state-1' }, cookies: { oidc_correlation: 'browser-nonce' } } as any;

        await controller.callback(req, res);

        expect(authService.consumeOidcState).toHaveBeenCalledWith('state-1', 'browser-nonce');
        expect(authService.handleOidcCallback).toHaveBeenCalledWith('code-1', 'state-1', 'demo', {
            ipAddress: null,
            userAgent: null,
        });
        expect(res.cookie).toHaveBeenCalledTimes(3);
        expect(res.clearCookie).toHaveBeenCalledWith('oidc_correlation', expect.objectContaining({
            httpOnly: true,
            sameSite: 'lax',
            path: '/',
        }));
        expect(res.redirect).toHaveBeenCalledWith('/dashboard/staff');
    });

    it('clears the OIDC correlation cookie when callback validation fails', async () => {
        authService.consumeOidcState.mockRejectedValue(new UnauthorizedException('Invalid OIDC state'));
        const res = createResponseMock();
        const req = { query: { code: 'code-1', state: 'state-1' }, cookies: {} } as any;

        await expect(controller.callback(req, res)).rejects.toBeInstanceOf(UnauthorizedException);

        expect(authService.consumeOidcState).toHaveBeenCalledWith('state-1', undefined);
        expect(res.clearCookie).toHaveBeenCalledWith('oidc_correlation', expect.objectContaining({
            httpOnly: true,
            sameSite: 'lax',
            path: '/',
        }));
        expect(authService.handleOidcCallback).not.toHaveBeenCalled();
        expect(res.cookie).not.toHaveBeenCalled();
    });

    it('verifies PIN and returns JSON payload when redirect mode is off', async () => {
        const res = createResponseMock();
        const req = createRequestMock({
            ip: '198.51.100.10',
            headers: {
                'x-forwarded-for': '203.0.113.20, 198.51.100.10',
                'user-agent': 'Vitest Browser',
            },
        });
        authService.loginWithUsernamePin.mockResolvedValue({
            accessToken: 'a',
            refreshToken: 'r',
            csrfToken: 'c',
            requiresMfa: false,
            user: { id: 'u1', role: 'STAFF' },
        });

        await controller.verifyPin({ identifier: 'ShiftLead', pin: '1234', tenantSlug: 'demo' }, req, res);

        expect(authService.loginWithUsernamePin).toHaveBeenCalledWith('shiftlead', '1234', 'demo', {
            ipAddress: '198.51.100.10',
            userAgent: 'Vitest Browser',
        });
        expect(res.cookie).toHaveBeenCalledTimes(3);
        expect(res.json).toHaveBeenCalledWith({
            success: true,
            redirectTo: '/dashboard',
            pinResetRequired: false,
            requiresMfa: false,
        });
    });

    it('verifies PIN and redirects when redirect mode is on', async () => {
        const res = createResponseMock();
        const req = createRequestMock({ query: { redirect: '1', next: '/dashboard/staff' } });
        authService.loginWithUsernamePin.mockResolvedValue({
            accessToken: 'a',
            refreshToken: 'r',
            csrfToken: 'c',
            requiresMfa: false,
            user: { id: 'u1', role: 'STAFF' },
        });

        await controller.verifyPin({ identifier: 'shiftlead', pin: '1234', tenantSlug: 'demo' }, req, res);

        expect(res.redirect).toHaveBeenCalledWith(302, '/dashboard/staff');
    });

    it('redirects a temporary PIN login to forced rotation instead of the application or MFA enrollment', async () => {
        const res = createResponseMock();
        const req = createRequestMock({ query: { redirect: '1', next: '/dashboard/staff' } });
        authService.loginWithUsernamePin.mockResolvedValue({
            accessToken: 'reset-only-access',
            refreshToken: 'reset-only-refresh',
            csrfToken: 'reset-only-csrf',
            requiresMfa: true,
            pinResetRequired: true,
            user: { id: 'u-admin', role: 'ADMIN' },
        });

        await controller.verifyPin({ identifier: 'temporary.admin', pin: '1234', tenantSlug: 'demo' }, req, res);

        expect(res.redirect).toHaveBeenCalledWith(302, '/auth/reset-pin?next=%2Fdashboard%2Fstaff');
        expect(res.redirect).not.toHaveBeenCalledWith(302, expect.stringContaining('/mfa'));
    });

    it('redirects to login with error on invalid PIN in redirect mode', async () => {
        const res = createResponseMock();
        const req = createRequestMock({ query: { redirect: '1', next: '/dashboard/staff' } });
        authService.loginWithUsernamePin.mockRejectedValue(new UnauthorizedException('Invalid username or PIN'));

        await controller.verifyPin({ identifier: 'ShiftLead', pin: '0000', tenantSlug: 'demo' }, req, res);

        const expected = '/auth/login?error=invalid&tenantSlug=demo&next=%2Fdashboard%2Fstaff';
        expect(res.redirect).toHaveBeenCalledWith(302, expected);
    });

    it('rejects explicit cross-origin public auth posts before issuing cookies', async () => {
        const previousAllowedOrigins = process.env.ALLOWED_ORIGINS;
        delete process.env.ALLOWED_ORIGINS;
        const res = createResponseMock();
        const req = createRequestMock({
            headers: {
                host: 'app.example.com',
                origin: 'https://evil.example.com',
            },
            protocol: 'https',
        });

        try {
            await expect(controller.verifyPin({ identifier: 'ShiftLead', pin: '1234', tenantSlug: 'demo' }, req, res))
                .rejects
                .toBeInstanceOf(ForbiddenException);
        } finally {
            if (previousAllowedOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
            else process.env.ALLOWED_ORIGINS = previousAllowedOrigins;
        }

        expect(authService.loginWithUsernamePin).not.toHaveBeenCalled();
        expect(res.cookie).not.toHaveBeenCalled();
    });

    it('rejects production public auth posts without Origin or Referer before issuing cookies', async () => {
        const previousNodeEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        const res = createResponseMock();
        const req = createRequestMock({ headers: { host: 'app.example.com' } });

        try {
            await expect(controller.verifyPin({ identifier: 'ShiftLead', pin: '1234', tenantSlug: 'demo' }, req, res))
                .rejects
                .toBeInstanceOf(ForbiddenException);
        } finally {
            if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = previousNodeEnv;
        }

        expect(authService.loginWithUsernamePin).not.toHaveBeenCalled();
        expect(res.cookie).not.toHaveBeenCalled();
    });

    it('verifies password and returns JSON payload when redirect mode is off', async () => {
        const res = createResponseMock();
        const req = createRequestMock();
        authService.loginWithUsernamePassword.mockResolvedValue({
            accessToken: 'a',
            refreshToken: 'r',
            csrfToken: 'c',
            requiresMfa: false,
            user: { id: 'u1', role: 'STAFF' },
        });

        await controller.verifyPassword({ identifier: 'ShiftLead', password: 'secret', tenantSlug: 'demo' }, req, res);

        expect(authService.loginWithUsernamePassword).toHaveBeenCalledWith('shiftlead', 'secret', 'demo', {
            ipAddress: null,
            userAgent: null,
        });
        expect(res.cookie).toHaveBeenCalledTimes(3);
        expect(res.json).toHaveBeenCalledWith({
            success: true,
            redirectTo: '/dashboard',
            pinResetRequired: false,
            requiresMfa: false,
        });
    });

    it('allows email-password login only for the beta request host', async () => {
        authService.loginWithUsernamePassword.mockResolvedValue({
            accessToken: 'a',
            refreshToken: 'r',
            csrfToken: 'c',
            requiresMfa: false,
            user: { id: 'u1', role: 'STAFF' },
        });

        await expect(controller.verifyPassword(
            { identifier: 'demo@demo.com', password: 'demo', tenantSlug: 'demo' },
            createRequestMock({ headers: { host: 'lunchlineup.com' } }),
            createResponseMock(),
        )).rejects.toBeInstanceOf(ForbiddenException);
        expect(authService.loginWithUsernamePassword).not.toHaveBeenCalled();

        await controller.verifyPassword(
            { identifier: 'demo@demo.com', password: 'demo', tenantSlug: 'demo' },
            createRequestMock({ headers: { host: 'beta.lunchlineup.com' } }),
            createResponseMock(),
        );
        expect(authService.loginWithUsernamePassword).toHaveBeenCalledWith(
            'demo@demo.com',
            'demo',
            'demo',
            { ipAddress: null, userAgent: null },
        );
    });

    it('requests the MFA exemption only for the configured exact beta demo identity', async () => {
        const previous = process.env.BETA_DEMO_MFA_BYPASS_ENABLED;
        process.env.BETA_DEMO_MFA_BYPASS_ENABLED = 'true';
        authService.loginWithUsernamePassword.mockResolvedValue({
            accessToken: 'a',
            refreshToken: 'r',
            csrfToken: 'c',
            requiresMfa: false,
            user: { id: 'u1', role: 'ADMIN' },
        });

        try {
            await controller.verifyPassword(
                { identifier: 'demo@demo.com', password: 'demo', tenantSlug: 'demo' },
                createRequestMock({ headers: { host: 'beta.lunchlineup.com' } }),
                createResponseMock(),
            );
            expect(authService.loginWithUsernamePassword).toHaveBeenLastCalledWith(
                'demo@demo.com',
                'demo',
                'demo',
                { ipAddress: null, userAgent: null },
                { betaDemoMfaBypass: true },
            );

            await controller.verifyPassword(
                { identifier: 'other@demo.com', password: 'demo', tenantSlug: 'demo' },
                createRequestMock({ headers: { host: 'beta.lunchlineup.com' } }),
                createResponseMock(),
            );
            expect(authService.loginWithUsernamePassword).toHaveBeenLastCalledWith(
                'other@demo.com',
                'demo',
                'demo',
                { ipAddress: null, userAgent: null },
            );
        } finally {
            if (previous === undefined) delete process.env.BETA_DEMO_MFA_BYPASS_ENABLED;
            else process.env.BETA_DEMO_MFA_BYPASS_ENABLED = previous;
        }
    });

    it('preserves a temporary PIN reset boundary through the generic username credential path', async () => {
        const res = createResponseMock();
        const req = createRequestMock({ query: { redirect: '1', next: '/dashboard/staff' } });
        authService.loginWithUsernamePassword.mockResolvedValue({
            accessToken: 'a',
            refreshToken: 'r',
            csrfToken: 'c',
            requiresMfa: false,
            pinResetRequired: true,
            user: { id: 'u1', role: 'STAFF' },
        });

        await controller.verifyPassword({
            identifier: 'ShiftLead',
            password: '123456',
            tenantSlug: 'demo',
        }, req, res);

        expect(res.redirect).toHaveBeenCalledWith(302, '/auth/reset-pin?next=%2Fdashboard%2Fstaff');
    });

    it('redirects to login with error on invalid password in redirect mode', async () => {
        const res = createResponseMock();
        const req = createRequestMock({ query: { redirect: '1', next: '/dashboard/staff' } });
        authService.loginWithUsernamePassword.mockRejectedValue(new UnauthorizedException('Invalid username or password'));

        await controller.verifyPassword({ identifier: 'ShiftLead', password: 'bad', tenantSlug: 'demo' }, req, res);

        const expected = '/auth/login?error=invalid&tenantSlug=demo&next=%2Fdashboard%2Fstaff';
        expect(res.redirect).toHaveBeenCalledWith(302, expected);
    });

    it('preserves the next path when redirecting an MFA-required login', async () => {
        const res = createResponseMock();
        const req = createRequestMock({ query: { redirect: '1', next: '/dashboard/staff' } });
        authService.loginWithUsernamePassword.mockResolvedValue({
            accessToken: 'a',
            refreshToken: 'r',
            csrfToken: 'c',
            requiresMfa: true,
            user: { id: 'u1', role: 'STAFF' },
        });

        await controller.verifyPassword({ identifier: 'ShiftLead', password: 'secret', tenantSlug: 'demo' }, req, res);

        expect(res.redirect).toHaveBeenCalledWith(302, '/mfa?next=%2Fdashboard%2Fstaff');
    });

    it('returns a generic password reset request response when no eligible account exists', async () => {
        authService.createPasswordReset.mockResolvedValue(null);

        await expect(controller.requestPasswordReset({
            identifier: 'LegacyUser',
            tenantSlug: 'demo',
        }, createRequestMock())).resolves.toEqual({
            success: true,
            message: 'If a matching account exists, a password reset email will be sent shortly.',
        });

        expect(emailService.sendPasswordReset).not.toHaveBeenCalled();
    });

    it('keeps reset delivery behind the durable service boundary', async () => {
        authService.createPasswordReset.mockResolvedValue(null);

        await expect(controller.requestPasswordReset({
            identifier: 'LegacyUser',
            tenantSlug: 'demo',
        }, createRequestMock())).resolves.toEqual({
            success: true,
            message: 'If a matching account exists, a password reset email will be sent shortly.',
        });

        expect(authService.createPasswordReset).toHaveBeenCalledWith('LegacyUser', 'demo');
        expect(emailService.sendPasswordReset).not.toHaveBeenCalled();
    });

    it('confirms password reset tokens through the auth service', async () => {
        const request = createRequestMock({
            ip: '198.51.100.25',
            headers: { 'user-agent': 'Vitest Password Reset' },
        });
        await expect(controller.confirmPasswordReset({
            token: 'reset_token_123456789012345678901234',
            password: 'new-password-1',
        }, request)).resolves.toEqual({ success: true });

        expect(authService.resetPasswordWithToken).toHaveBeenCalledWith(
            'reset_token_123456789012345678901234',
            'new-password-1',
            { ipAddress: '198.51.100.25', userAgent: 'Vitest Password Reset' },
        );
    });

    it('does not hide email OTP policy failures as delivery outages', async () => {
        authService.assertEmailOtpAllowed.mockRejectedValue(new ForbiddenException('Email OTP is disabled'));

        await expect(controller.sendOtp({ email: 'admin@example.com' }, createRequestMock()))
            .rejects
            .toBeInstanceOf(ForbiddenException);

        expect(otpService.generateOtp).not.toHaveBeenCalled();
        expect(emailService.sendOtp).not.toHaveBeenCalled();
    });

    it('returns generic success without generating or sending an OTP for an unknown recipient', async () => {
        authService.assertEmailOtpAllowed.mockResolvedValue(false);

        await expect(controller.sendOtp({
            email: 'missing@example.com',
            tenantSlug: 'demo',
        }, createRequestMock())).resolves.toEqual({ success: true });

        expect(authService.assertEmailOtpAllowed).toHaveBeenCalledWith('missing@example.com', {
            tenantSlug: 'demo',
        });
        expect(otpService.generateOtp).not.toHaveBeenCalled();
        expect(emailService.sendOtp).not.toHaveBeenCalled();
    });

    it('generates and sends an OTP for an eligible tenant user', async () => {
        await expect(controller.sendOtp({
            email: 'owner@example.com',
            tenantSlug: 'demo',
        }, createRequestMock())).resolves.toEqual({ success: true });

        expect(otpService.generateOtp).toHaveBeenCalledWith('owner@example.com', {
            tenantSlug: 'demo',
        });
        expect(emailService.sendOtp).toHaveBeenCalledWith('owner@example.com', '123456');
    });

    it('returns the same generic response when OTP generation is suppressed', async () => {
        otpService.generateOtp.mockRejectedValue(
            new BadRequestException('Please wait before requesting another code'),
        );

        await expect(controller.sendOtp({
            email: 'owner@example.com',
            tenantSlug: 'demo',
        }, createRequestMock())).rejects.toMatchObject({
            status: 429,
            message: 'Please wait before requesting another code',
        });

        expect(emailService.sendOtp).not.toHaveBeenCalled();
    });

    it('rejects HTML-significant email addresses before generating an OTP', async () => {
        for (const email of [
            'owner<script>@example.com',
            'owner&ops@example.com',
            'owner"ops@example.com',
            "owner'ops@example.com",
        ]) {
            await expect(controller.sendOtp({ email }, createRequestMock()))
                .resolves
                .toEqual({ success: false, error: 'Invalid email address' });
        }

        expect(authService.assertEmailOtpAllowed).not.toHaveBeenCalled();
        expect(otpService.generateOtp).not.toHaveBeenCalled();
        expect(emailService.sendOtp).not.toHaveBeenCalled();
    });

    it('binds onboarding OTP sends to the submitted organization name', async () => {

        await expect(controller.sendOtp({
            email: 'Owner@Example.com',
            onboarding: true,
            tenantName: '  Acme Dining  ',
            signupCode: 'invite-123',
            termsAccepted: true,
            privacyAccepted: true,
            termsVersion: CURRENT_TERMS_VERSION,
            privacyVersion: CURRENT_PRIVACY_VERSION,
        }, createRequestMock())).resolves.toEqual({ success: true, onboardingChallengeToken: 'challenge-token' });

        expect(authService.createOnboardingSignupChallenge).toHaveBeenCalledWith('owner@example.com', {
            allowProvision: true,
            provisionTenantName: 'Acme Dining',
            termsAccepted: true,
            privacyAccepted: true,
            termsVersion: CURRENT_TERMS_VERSION,
            privacyVersion: CURRENT_PRIVACY_VERSION,
            signupCode: 'invite-123',
        });
        expect(otpService.generateOtp).not.toHaveBeenCalled();
        expect(emailService.sendOtp).toHaveBeenCalledWith('owner@example.com', '123456');
    });

    it('passes public signup challenge tokens to the OTP policy gate', async () => {

        await expect(controller.sendOtp({
            email: 'Owner@Example.com',
            onboarding: true,
            tenantName: 'Acme Dining',
            turnstileToken: 'turnstile-token',
            termsAccepted: true,
            privacyAccepted: true,
            termsVersion: CURRENT_TERMS_VERSION,
            privacyVersion: CURRENT_PRIVACY_VERSION,
        }, createRequestMock({ ip: '203.0.113.10' }))).resolves.toEqual({ success: true, onboardingChallengeToken: 'challenge-token' });

        expect(authService.createOnboardingSignupChallenge).toHaveBeenCalledWith('owner@example.com', {
            allowProvision: true,
            provisionTenantName: 'Acme Dining',
            termsAccepted: true,
            privacyAccepted: true,
            termsVersion: CURRENT_TERMS_VERSION,
            privacyVersion: CURRENT_PRIVACY_VERSION,
            signupChallengeToken: 'turnstile-token',
            signupChallengeRemoteIp: '203.0.113.10',
        });
    });

    it('rejects onboarding OTP sends without an organization name', async () => {
        await expect(controller.sendOtp({
            email: 'owner@example.com',
            onboarding: true,
        }, createRequestMock())).rejects.toBeInstanceOf(BadRequestException);

        expect(authService.assertEmailOtpAllowed).not.toHaveBeenCalled();
        expect(otpService.generateOtp).not.toHaveBeenCalled();
    });

    it('keeps provider details and the submitted OTP out of authDebug failure logs', async () => {
        const previousNodeEnv = process.env.NODE_ENV;
        const previousAuthDebug = process.env.AUTH_DEBUG;
        const secret = 'postgres://owner:db-secret@private-db.internal/auth';
        const submittedOtp = '654321';
        process.env.NODE_ENV = 'test';
        process.env.AUTH_DEBUG = 'true';
        otpService.verifyOtp.mockRejectedValue(
            Object.assign(new Error('verification query failed for ' + secret + ' otp=' + submittedOtp), {
                code: 'ECONNREFUSED',
            }),
        );
        const log = vi.spyOn((controller as any).logger, 'log').mockImplementation(() => undefined);

        try {
            await expect(controller.verifyOtp({
                email: 'owner@example.com',
                code: submittedOtp,
                tenantSlug: 'demo',
            }, createRequestMock(), createResponseMock())).rejects.toThrow('verification query failed');

            const logged = JSON.stringify(log.mock.calls);
            expect(logged).toContain('verify_otp_failed');
            expect(logged).toContain('connectivity');
            expect(logged).toContain('ECONNREFUSED');
            expect(logged).toContain('ow***@example.com');
            expect(logged).not.toContain(secret);
            expect(logged).not.toContain(submittedOtp);
            expect(logged).not.toContain('verification query failed');
        } finally {
            if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = previousNodeEnv;
            if (previousAuthDebug === undefined) delete process.env.AUTH_DEBUG;
            else process.env.AUTH_DEBUG = previousAuthDebug;
        }
    });

    it('binds onboarding OTP verification and provisioning to the submitted organization name', async () => {
        const res = createResponseMock();
        authService.loginWithEmail.mockResolvedValue({
            accessToken: 'a',
            refreshToken: 'r',
            csrfToken: 'c',
            requiresMfa: false,
            workspaceSlug: 'acme-dining-abc123',
            user: { id: 'u1', role: 'ADMIN' },
        });

        await controller.verifyOtp({
            email: 'Owner@Example.com',
            code: '123456',
            onboarding: true,
            tenantName: 'Acme Dining',
            signupCode: 'invite-123',
            onboardingChallengeToken: 'challenge-token',
            termsAccepted: true,
            privacyAccepted: true,
            termsVersion: CURRENT_TERMS_VERSION,
            privacyVersion: CURRENT_PRIVACY_VERSION,
        }, createRequestMock(), res);

        expect(otpService.verifyOtp).not.toHaveBeenCalled();
        expect(authService.loginWithEmail).toHaveBeenCalledWith(
            'owner@example.com',
            {
                tenantSlug: undefined,
                allowProvision: true,
                provisionTenantName: 'Acme Dining',
                termsAccepted: true,
                privacyAccepted: true,
                termsVersion: CURRENT_TERMS_VERSION,
                privacyVersion: CURRENT_PRIVACY_VERSION,
                signupCode: 'invite-123',
                onboardingChallengeToken: 'challenge-token',
                onboardingOtpCode: '123456',
            },
            {
                ipAddress: null,
                userAgent: null,
            },
        );
        expect(res.cookie).toHaveBeenCalledTimes(3);
        expect(res.json).toHaveBeenCalledWith({
            success: true,
            redirectTo: '/dashboard',
            requiresMfa: false,
            workspaceSlug: 'acme-dining-abc123',
        });
    });

    it('rejects onboarding verification without both legal assents before consuming the OTP', async () => {
        const res = createResponseMock();

        await expect(controller.verifyOtp({
            email: 'owner@example.com',
            code: '123456',
            onboarding: true,
            tenantName: 'Acme Dining',
            termsAccepted: true,
            privacyAccepted: false,
        }, createRequestMock(), res)).rejects.toBeInstanceOf(BadRequestException);

        expect(otpService.verifyOtp).not.toHaveBeenCalled();
        expect(authService.loginWithEmail).not.toHaveBeenCalled();
    });

    it('preserves the first-location resume path when onboarding requires MFA', async () => {
        const res = createResponseMock();
        authService.loginWithEmail.mockResolvedValue({
            accessToken: 'a',
            refreshToken: 'r',
            csrfToken: 'c',
            requiresMfa: true,
            workspaceSlug: 'acme-dining-abc123',
            user: { id: 'u1', role: 'ADMIN' },
        });

        await controller.verifyOtp({
            email: 'owner@example.com',
            code: '123456',
            onboarding: true,
            tenantName: 'Acme Dining',
            termsAccepted: true,
            privacyAccepted: true,
            termsVersion: CURRENT_TERMS_VERSION,
            privacyVersion: CURRENT_PRIVACY_VERSION,
        }, createRequestMock({ query: { next: '/onboarding?resume=first-location' } }), res);

        expect(res.json).toHaveBeenCalledWith({
            success: true,
            redirectTo: '/mfa?next=%2Fonboarding%3Fresume%3Dfirst-location',
            requiresMfa: true,
            workspaceSlug: 'acme-dining-abc123',
        });
    });

    it('rotates all session cookies without returning bearer tokens in JSON', async () => {
        const res = createResponseMock();
        const req = createRequestMock({
            cookies: { refresh_token: 'refresh-1', csrf_token: 'csrf-1' },
            headers: { 'x-csrf-token': 'csrf-1' },
        });
        authService.refreshAccessToken.mockResolvedValue({
            accessToken: 'new-access-token',
            refreshToken: 'new-refresh-token',
            csrfToken: 'new-csrf-token',
            requiresMfa: true,
            mfaVerified: false,
            accessTokenMaxAgeMs: 30_000,
            sessionMaxAgeMs: 120_000,
        });

        await controller.refresh(req, res);

        expect(authService.refreshAccessToken).toHaveBeenCalledWith('refresh-1');
        expect(res.cookie).toHaveBeenCalledWith('access_token', 'new-access-token', expect.objectContaining({
            httpOnly: true,
            sameSite: 'strict',
            path: '/',
            maxAge: 120_000,
        }));
        expect(res.cookie).toHaveBeenCalledWith('refresh_token', 'new-refresh-token', expect.objectContaining({
            httpOnly: true,
            sameSite: 'strict',
            path: '/',
            maxAge: 120_000,
        }));
        expect(res.cookie).toHaveBeenCalledWith('csrf_token', 'new-csrf-token', expect.objectContaining({
            httpOnly: false,
            sameSite: 'strict',
            path: '/',
        }));
        expect(res.json).toHaveBeenCalledWith({
            success: true,
            requiresMfa: true,
            mfaVerified: false,
        });
        expect(res.json).not.toHaveBeenCalledWith(expect.objectContaining({ accessToken: expect.any(String) }));
        expect(res.json).not.toHaveBeenCalledWith(expect.objectContaining({ refreshToken: expect.any(String) }));
    });

    it('rejects browser refresh requests when the CSRF header does not match the CSRF cookie', async () => {
        const res = createResponseMock();
        const req = createRequestMock({
            cookies: { refresh_token: 'refresh-1', csrf_token: 'csrf-1' },
            headers: {},
        });

        await expect(controller.refresh(req, res)).rejects.toBeInstanceOf(ForbiddenException);

        expect(authService.refreshAccessToken).not.toHaveBeenCalled();
        expect(res.cookie).not.toHaveBeenCalled();
    });

    it('rejects browser refresh requests when the CSRF cookie is missing', async () => {
        const res = createResponseMock();
        const req = createRequestMock({
            cookies: { refresh_token: 'refresh-1' },
            headers: { 'x-csrf-token': 'csrf-1' },
        });

        await expect(controller.refresh(req, res)).rejects.toBeInstanceOf(ForbiddenException);

        expect(authService.refreshAccessToken).not.toHaveBeenCalled();
        expect(res.cookie).not.toHaveBeenCalled();
    });


    it('revokes logout by refresh cookie without requiring access-token claims', async () => {
        const res = createResponseMock();
        const req = createRequestMock({
            cookies: { refresh_token: 'refresh-1', csrf_token: 'csrf-1' },
            headers: {
                host: 'app.example.com',
                origin: 'https://app.example.com',
                'x-csrf-token': 'csrf-1',
            },
        });
        authService.revokeSessionByRefreshToken.mockResolvedValue({ status: 'revoked' });

        await controller.logout(req, res);

        expect(authService.revokeSessionByRefreshToken).toHaveBeenCalledWith('refresh-1');
        expect(res.clearCookie).toHaveBeenCalledTimes(3);
        expect(res.json).toHaveBeenCalledWith({ success: true, session: 'revoked' });
    });

    it('does not revoke or clear logout cookies when origin validation fails', async () => {
        const res = createResponseMock();
        const req = createRequestMock({
            cookies: { refresh_token: 'refresh-1', csrf_token: 'csrf-1' },
            headers: {
                host: 'app.example.com',
                origin: 'https://evil.example.com',
                'x-csrf-token': 'csrf-1',
            },
        });

        await expect(controller.logout(req, res)).rejects.toBeInstanceOf(ForbiddenException);
        expect(authService.revokeSessionByRefreshToken).not.toHaveBeenCalled();
        expect(res.clearCookie).not.toHaveBeenCalled();
    });
    it('starts MFA enrollment for the authenticated session', async () => {
        authService.beginMfaEnrollment.mockResolvedValue({
            secret: 'BASE32SECRET',
            otpauthUrl: 'otpauth://totp/LunchLineup:user',
            expiresInSeconds: 600,
        });
        const req = createRequestMock({ user: { sub: 'u-1', tenantId: 't-1', sessionId: 's-1' } });

        const result = await controller.beginMfaEnrollment(req);

        expect(authService.beginMfaEnrollment).toHaveBeenCalledWith('u-1', req.user);
        expect(result).toEqual(expect.objectContaining({ secret: 'BASE32SECRET', expiresInSeconds: 600 }));
    });

    it('reports MFA enrollment state through the settings contract route', async () => {
        authService.getMfaEnrollmentState.mockResolvedValue({
            enabled: true,
            recoveryCodesRemaining: 9,
        });
        const req = createRequestMock({ user: { sub: 'u-1', tenantId: 't-1', sessionId: 's-1' } });

        const result = await controller.getMfaEnrollment(req);

        expect(authService.getMfaEnrollmentState).toHaveBeenCalledWith('u-1', req.user);
        expect(result).toEqual({ enabled: true, recoveryCodesRemaining: 9 });
    });

    it('sets a verified access cookie when confirming MFA enrollment', async () => {
        const res = createResponseMock();
        const req = createRequestMock({ user: { sub: 'u-1', tenantId: 't-1', sessionId: 's-1' } });
        authService.confirmMfaEnrollment.mockResolvedValue({
            accessToken: 'verified-token',
            accessTokenMaxAgeMs: 25_000,
            mfaVerified: true,
            backupCodes: ['ABCD-EFGH-IJKL'],
        });

        await controller.confirmMfaEnrollment(req, { code: '123456' }, res);

        expect(authService.confirmMfaEnrollment).toHaveBeenCalledWith(
            'u-1', '123456', req.user, { ipAddress: null, userAgent: null },
        );
        expect(res.cookie).toHaveBeenCalledWith('access_token', 'verified-token', expect.objectContaining({
            httpOnly: true,
            maxAge: 25_000,
        }));
        expect(res.json).toHaveBeenCalledWith({
            success: true,
            mfaVerified: true,
            backupCodes: ['ABCD-EFGH-IJKL'],
        });
    });

    it('keeps REST-style MFA enrollment aliases wired to the same service flow', async () => {
        const res = createResponseMock();
        const req = createRequestMock({ user: { sub: 'u-1', tenantId: 't-1', sessionId: 's-1' } });
        authService.beginMfaEnrollment.mockResolvedValue({ secret: 'BASE32SECRET', otpauthUrl: 'otpauth://totp/LunchLineup:user' });
        authService.confirmMfaEnrollment.mockResolvedValue({ accessToken: 'verified-token', mfaVerified: true, backupCodes: [] });
        authService.disableMfa.mockResolvedValue({ success: true, mfaEnabled: false });

        await expect(controller.beginMfaEnrollmentAlias(req)).resolves.toEqual(expect.objectContaining({ secret: 'BASE32SECRET' }));
        await controller.confirmMfaEnrollmentAlias(req, { code: '123456' }, res);
        await expect(controller.disableMfaAlias(req, { code: '123456' })).resolves.toEqual({ success: true, mfaEnabled: false });

        expect(authService.beginMfaEnrollment).toHaveBeenCalledWith('u-1', req.user);
        expect(authService.confirmMfaEnrollment).toHaveBeenCalledWith(
            'u-1', '123456', req.user, { ipAddress: null, userAgent: null },
        );
        expect(authService.disableMfa).toHaveBeenCalledWith(
            'u-1', '123456', req.user, { ipAddress: null, userAgent: null },
        );
    });

    it('disables voluntary MFA through the authenticated session', async () => {
        const req = createRequestMock({ user: { sub: 'u-1', tenantId: 't-1', sessionId: 's-1' } });
        authService.disableMfa.mockResolvedValue({ success: true, mfaEnabled: false });

        await expect(controller.disableMfa(req, { code: '123456' })).resolves.toEqual({
            success: true,
            mfaEnabled: false,
        });
        expect(authService.disableMfa).toHaveBeenCalledWith(
            'u-1', '123456', req.user, { ipAddress: null, userAgent: null },
        );
    });
});

describe('JwtAuthGuard MFA boundary', () => {
    function createContext(request: any, response: any = { cookie: vi.fn() }) {
        return {
            getHandler: vi.fn(),
            switchToHttp: () => ({
                getRequest: () => request,
                getResponse: () => response,
            }),
        } as any;
    }

    let jwtService: any;
    let authService: any;
    let reflector: any;
    let guard: JwtAuthGuard;

    beforeEach(() => {
        jwtService = {
            verifyAccessToken: vi.fn().mockReturnValue({
                sub: 'u-1',
                tenantId: 't-1',
                role: 'STAFF',
                sessionId: 's-1',
                mfaVerified: false,
            }),
            generateAccessToken: vi.fn().mockReturnValue('rotated-token'),
        };
        authService = {
            validateAccessSession: vi.fn().mockResolvedValue({
                mfaRequired: true,
                mfaVerified: false,
                accessTokenMaxAgeMs: 30_000,
                access: {
                    primaryRole: 'STAFF',
                    roles: [],
                    permissions: ['dashboard:access'],
                },
            }),
        };
        reflector = {
            get: vi.fn().mockReturnValue(false),
        };
        guard = new JwtAuthGuard(jwtService, authService, reflector);
    });

    it('blocks protected routes for unverified MFA sessions', async () => {
        const request = {
            headers: { authorization: 'Bearer token' },
            method: 'GET',
            path: '/v1/schedules',
        };

        await expect(guard.canActivate(createContext(request))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows unverified MFA sessions to reach MFA verification', async () => {
        const request = {
            headers: { authorization: 'Bearer token' },
            method: 'POST',
            path: '/v1/auth/mfa/verify',
        };

        await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    });

    it('allows unverified MFA sessions to enroll before verification', async () => {
        const request = {
            headers: { authorization: 'Bearer token' },
            method: 'POST',
            path: '/v1/auth/mfa/enroll',
        };

        await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    });

    it('allows unverified MFA sessions to use the settings enrollment confirm alias', async () => {
        const request = {
            headers: { authorization: 'Bearer token' },
            method: 'PUT',
            path: '/v1/auth/mfa/enrollment',
        };

        await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    });
});
