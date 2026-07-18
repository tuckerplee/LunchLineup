import { Controller, Delete, Get, Post, Put, Body, Req, UseGuards, SetMetadata, HttpCode, HttpStatus, UnauthorizedException, Logger, ServiceUnavailableException, BadRequestException, HttpException, ForbiddenException } from '@nestjs/common';
import { AuthService, type SessionRequestAudit } from './auth.service';
import { OtpService } from './otp.service';
import { EmailService } from './email.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { Throttle } from '@nestjs/throttler';
import { Response, Request } from 'express';
import { Res } from '@nestjs/common';
import { AllowAuthenticated } from './require-permission.decorator';
import { operationalErrorDiagnostics, type OperationalErrorCategory } from './operational-error';

const Public = () => SetMetadata('isPublic', true);
const ACCESS_TOKEN_COOKIE_MAX_AGE_MS = 30 * 60 * 1000;
const REFRESH_TOKEN_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const OIDC_CORRELATION_COOKIE = 'oidc_correlation';
const AuthThrottle = () => Throttle({ auth: { ttl: 15 * 60 * 1000, limit: 5 } });
const RefreshThrottle = () => Throttle({
    refreshIp: { ttl: 15 * 60 * 1000, limit: 100 },
    refreshCredential: { ttl: 15 * 60 * 1000, limit: 5 },
});
const PreAuthThrottle = () => Throttle({
    authIp: { ttl: 15 * 60 * 1000, limit: 30 },
    authIdentifier: { ttl: 15 * 60 * 1000, limit: 5 },
});
const MAX_ONBOARDING_TENANT_NAME_LENGTH = 80;
const HTML_SIGNIFICANT_EMAIL_CHARS = /[<>&"']/;
const OTP_EMAIL_PATTERN = /^[a-z0-9.!#$%*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

type AuthDebugEvent =
    | 'refresh_start'
    | 'refresh_success'
    | 'send_otp_invalid_email'
    | 'send_otp_start'
    | 'send_otp_success'
    | 'send_otp_suppressed'
    | 'verify_otp_failed'
    | 'verify_otp_start'
    | 'verify_otp_success';

type AuthDebugDetails = {
    maskedEmail?: string;
    redirectMode?: boolean;
    hasNext?: boolean;
    hasRedirect?: boolean;
    hasRefreshToken?: boolean;
    hasAccessToken?: boolean;
    role?: string;
    errorClass?: string;
    errorCategory?: OperationalErrorCategory;
    errorCode?: string;
};

const AUTH_DEBUG_ROLES = new Set(['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF']);
const AUTH_DEBUG_ERROR_CLASSES = new Set([
    'AbortError',
    'Error',
    'MaxRetriesPerRequestError',
    'NonErrorThrow',
    'RangeError',
    'ReferenceError',
    'ReplyError',
    'SyntaxError',
    'TimeoutError',
    'TypeError',
]);
const AUTH_DEBUG_ERROR_CATEGORIES = new Set<OperationalErrorCategory>([
    'authentication',
    'connectivity',
    'rate_limit',
    'timeout',
    'unavailable',
    'unknown',
]);

type EmailOtpBody = {
    email: string;
    code?: string;
    tenantSlug?: string;
    onboarding?: boolean;
    tenantName?: string;
    organizationName?: string;
    signupCode?: string;
    turnstileToken?: string;
    signupChallengeToken?: string;
    captchaToken?: string;
    onboardingChallengeToken?: string;
    termsAccepted?: boolean;
    privacyAccepted?: boolean;
    termsVersion?: string;
    privacyVersion?: string;
};

type PasswordResetRequestBody = {
    identifier?: string;
    tenantSlug?: string;
};

type PasswordResetConfirmBody = {
    token?: string;
    password?: string;
};

const PASSWORD_RESET_REQUEST_RESPONSE = {
    success: true,
    message: 'If a matching account exists, a password reset email will be sent shortly.',
};
const BETA_PASSWORD_LOGIN_HOST = 'beta.lunchlineup.com';

@Controller({ path: 'auth', version: '1' })
export class AuthController {
    private readonly logger = new Logger(AuthController.name);

    constructor(
        private authService: AuthService,
        private otpService: OtpService,
        private emailService: EmailService,
    ) { }

    private isAuthDebugEnabled(): boolean {
        return process.env.NODE_ENV !== 'production'
            && ['1', 'true', 'yes', 'on'].includes((process.env.AUTH_DEBUG ?? '').toLowerCase());
    }

    private maskEmail(email: string): string {
        const [localPart, domain] = email.split('@');
        if (!domain) return 'invalid_email';
        const safeLocal = localPart.length <= 2 ? `${localPart[0] ?? '*'}*` : `${localPart.slice(0, 2)}***`;
        return `${safeLocal}@${domain}`;
    }

    private normalizeOtpEmail(value: unknown): string | null {
        if (typeof value !== 'string') return null;
        const email = value.trim().toLowerCase();
        if (!email || email.length > 254) return null;
        if (HTML_SIGNIFICANT_EMAIL_CHARS.test(email)) return null;
        return OTP_EMAIL_PATTERN.test(email) ? email : null;
    }

    private authDebug(event: AuthDebugEvent, details: AuthDebugDetails = {}) {
        if (!this.isAuthDebugEnabled()) return;
        const safeDetails = {
            ...(details.maskedEmail === 'invalid_email'
                || (typeof details.maskedEmail === 'string' && details.maskedEmail.includes('*') && details.maskedEmail.length <= 254)
                ? { maskedEmail: details.maskedEmail }
                : {}),
            ...(typeof details.redirectMode === 'boolean' ? { redirectMode: details.redirectMode } : {}),
            ...(typeof details.hasNext === 'boolean' ? { hasNext: details.hasNext } : {}),
            ...(typeof details.hasRedirect === 'boolean' ? { hasRedirect: details.hasRedirect } : {}),
            ...(typeof details.hasRefreshToken === 'boolean' ? { hasRefreshToken: details.hasRefreshToken } : {}),
            ...(typeof details.hasAccessToken === 'boolean' ? { hasAccessToken: details.hasAccessToken } : {}),
            ...(typeof details.role === 'string' && AUTH_DEBUG_ROLES.has(details.role) ? { role: details.role } : {}),
            ...(typeof details.errorClass === 'string' && AUTH_DEBUG_ERROR_CLASSES.has(details.errorClass)
                ? { errorClass: details.errorClass }
                : {}),
            ...(details.errorCategory && AUTH_DEBUG_ERROR_CATEGORIES.has(details.errorCategory)
                ? { errorCategory: details.errorCategory }
                : {}),
            ...(typeof details.errorCode === 'string' && /^[A-Z0-9_]{1,40}$/.test(details.errorCode)
                ? { errorCode: details.errorCode }
                : {}),
        };
        this.logger.log('[auth-debug] ' + JSON.stringify({ scope: 'api.auth', event, ...safeDetails }));
    }

    private useSecureCookies(): boolean {
        const configured = process.env.COOKIE_SECURE;
        if (configured !== undefined) {
            return ['1', 'true', 'yes', 'on'].includes(configured.toLowerCase());
        }
        return process.env.NODE_ENV === 'production';
    }

    private safeInternalPath(value: string): string | null {
        if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
        return value;
    }

    private assertSameOriginRequest(req: Request): void {
        const requestOrigin = this.headerOrigin(req, 'origin') ?? this.refererOrigin(req);
        if (!requestOrigin) {
            if (process.env.NODE_ENV === 'production') {
                throw new ForbiddenException('Origin or Referer is required for auth requests');
            }
            return;
        }

        const allowedOrigins = this.allowedAuthOrigins(req);
        if (!allowedOrigins.has(requestOrigin)) {
            throw new ForbiddenException('Cross-origin auth requests are not allowed');
        }
    }

    private assertCsrfHeaderMatchesCookie(req: Request): void {
        const csrfCookie = req.cookies?.['csrf_token'];
        const csrfHeader = this.headerValue(req, 'x-csrf-token');
        if (!csrfHeader || csrfHeader !== csrfCookie) {
            throw new ForbiddenException('CSRF validation failed');
        }
    }

    private allowedAuthOrigins(req: Request): Set<string> {
        const origins = new Set<string>();
        const requestHost = this.headerValue(req, 'host');
        if (requestHost) {
            const forwardedProto = this.headerValue(req, 'x-forwarded-proto')?.split(',')[0]?.trim();
            const protocol = forwardedProto || req.protocol || 'http';
            this.addOrigin(origins, `${protocol}://${requestHost}`);
        }

        for (const value of [
            process.env.APP_ORIGIN,
            process.env.NEXT_PUBLIC_APP_ORIGIN,
            process.env.NEXT_PUBLIC_APP_URL,
            process.env.OIDC_REDIRECT_URI,
            ...(process.env.ALLOWED_ORIGINS ?? '').split(','),
        ]) {
            this.addOrigin(origins, value);
        }

        return origins;
    }

    private refererOrigin(req: Request): string | null {
        const referer = this.headerValue(req, 'referer');
        return referer ? this.normalizeOrigin(referer) : null;
    }

    private headerOrigin(req: Request, name: string): string | null {
        const value = this.headerValue(req, name);
        return value ? this.normalizeOrigin(value) : null;
    }

    private headerValue(req: Request, name: string): string | null {
        const direct = req.get?.(name);
        if (direct) return direct;
        const raw = req.headers?.[name.toLowerCase()];
        if (Array.isArray(raw)) return raw[0] ?? null;
        return typeof raw === 'string' ? raw : null;
    }

    private isBetaPasswordLoginRequest(req: Request): boolean {
        const requestHost = this.headerValue(req, 'host')?.trim().toLowerCase() ?? '';
        try {
            return new URL(`https://${requestHost}`).hostname === BETA_PASSWORD_LOGIN_HOST;
        } catch {
            return false;
        }
    }

    private addOrigin(origins: Set<string>, value: string | undefined): void {
        const normalized = value ? this.normalizeOrigin(value.trim()) : null;
        if (normalized) origins.add(normalized);
    }

    private normalizeOrigin(value: string): string | null {
        try {
            const parsed = new URL(value);
            return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
        } catch {
            return null;
        }
    }

    private onboardingTenantName(body: { onboarding?: boolean; tenantName?: string; organizationName?: string }): string | undefined {
        if (body.onboarding !== true) return undefined;
        const tenantName = (body.tenantName ?? body.organizationName ?? '').trim().replace(/\s+/g, ' ');
        if (!tenantName) {
            throw new BadRequestException('Organization name is required');
        }
        if (tenantName.length > MAX_ONBOARDING_TENANT_NAME_LENGTH) {
            throw new BadRequestException(`Organization name must be ${MAX_ONBOARDING_TENANT_NAME_LENGTH} characters or less`);
        }
        return tenantName;
    }

    private onboardingLegalAssent(body: EmailOtpBody): {
        termsAccepted: true;
        privacyAccepted: true;
        termsVersion: string | undefined;
        privacyVersion: string | undefined;
    } | undefined {
        if (body.onboarding !== true) return undefined;
        if (body.termsAccepted !== true || body.privacyAccepted !== true) {
            throw new BadRequestException('Terms and Privacy assent is required to create a workspace');
        }
        return {
            termsAccepted: true,
            privacyAccepted: true,
            termsVersion: body.termsVersion,
            privacyVersion: body.privacyVersion,
        };
    }

    private signupChallengeToken(body: EmailOtpBody): string | undefined {
        for (const value of [body.turnstileToken, body.signupChallengeToken, body.captchaToken]) {
            if (typeof value === 'string' && value.trim()) {
                return value;
            }
        }
        return undefined;
    }

    private signupChallengeRemoteIp(req: Request): string | undefined {
        return typeof req.ip === 'string' && req.ip.trim() ? req.ip.trim() : undefined;
    }

    private sessionRequestAudit(req: Request): SessionRequestAudit {
        const remoteAddress = typeof req.socket?.remoteAddress === 'string' ? req.socket.remoteAddress.trim() : '';
        return {
            ipAddress: (typeof req.ip === 'string' ? req.ip.trim() : '') || remoteAddress || null,
            userAgent: this.headerValue(req, 'user-agent') ?? null,
        };
    }

    private mfaRedirect(nextPath: string | null): string {
        const safeNext = nextPath ? this.safeInternalPath(nextPath) : null;
        if (!safeNext || safeNext === '/mfa' || safeNext.startsWith('/mfa?')) return '/mfa';

        const params = new URLSearchParams({ next: safeNext });
        return `/mfa?${params.toString()}`;
    }

    private pinResetRedirect(nextPath: string | null): string {
        const safeNext = nextPath ? this.safeInternalPath(nextPath) : null;
        if (!safeNext || safeNext === '/auth/reset-pin' || safeNext.startsWith('/auth/reset-pin?')) {
            return '/auth/reset-pin';
        }

        const params = new URLSearchParams({ next: safeNext });
        return `/auth/reset-pin?${params.toString()}`;
    }

    private setSessionCookies(
        res: Response,
        accessToken: string,
        refreshToken: string,
        csrfToken: string,
        sessionMaxAgeMs = REFRESH_TOKEN_COOKIE_MAX_AGE_MS,
    ) {
        const secure = this.useSecureCookies();
        const cookieOptions = {
            httpOnly: true,
            secure,
            sameSite: 'strict' as const,
            path: '/',
        };
        const accessTokenMaxAgeMs = Math.min(ACCESS_TOKEN_COOKIE_MAX_AGE_MS, sessionMaxAgeMs);

        res.cookie('access_token', accessToken, { ...cookieOptions, maxAge: accessTokenMaxAgeMs });
        res.cookie('refresh_token', refreshToken, { ...cookieOptions, maxAge: sessionMaxAgeMs });
        res.cookie('csrf_token', csrfToken, {
            httpOnly: false,
            secure,
            sameSite: 'strict',
            path: '/',
        });
    }

    private oidcCorrelationCookieOptions() {
        return {
            httpOnly: true,
            secure: this.useSecureCookies(),
            sameSite: 'lax' as const,
            path: '/',
        };
    }

    private clearOidcCorrelationCookie(res: Response): void {
        res.clearCookie(OIDC_CORRELATION_COOKIE, this.oidcCorrelationCookieOptions());
    }

    @Public()
    @PreAuthThrottle()
    @Post('login/resolve')
    @HttpCode(HttpStatus.OK)
    async resolveLoginFlow(@Body() body: { identifier: string; tenantSlug?: string }, @Req() req: Request) {
        this.assertSameOriginRequest(req);
        const result = await this.authService.resolveLoginMethod(body.identifier, body.tenantSlug);
        return {
            success: true,
            flow: result.flow,
            identifier: result.normalizedIdentifier,
            pinResetRequired: false,
        };
    }

    /**
     * Username/password — Verify migrated legacy password hash and issue session cookies.
     */
    @Public()
    @PreAuthThrottle()
    @Post('password/verify')
    @HttpCode(HttpStatus.OK)
    async verifyPassword(
        @Body() body: { identifier: string; password: string; tenantSlug?: string },
        @Req() req: Request,
        @Res() res: Response,
    ) {
        this.assertSameOriginRequest(req);
        const identifier = typeof body?.identifier === 'string' ? body.identifier.toLowerCase().trim() : '';
        if (identifier.includes('@') && !this.isBetaPasswordLoginRequest(req)) {
            throw new ForbiddenException('Email password sign-in is available only on the beta site');
        }
        const redirectMode = String((req.query as any)?.redirect || '') === '1';
        const nextPath = String((req.query as any)?.next || '');
        const safeNext = this.safeInternalPath(nextPath);

        try {
            const result = await this.authService.loginWithUsernamePassword(identifier, body.password, body.tenantSlug, this.sessionRequestAudit(req));
            this.setSessionCookies(res, result.accessToken, result.refreshToken, result.csrfToken, result.sessionMaxAgeMs);

            const pinResetRequired = result.pinResetRequired === true;
            const redirectTo = pinResetRequired
                ? this.pinResetRedirect(safeNext)
                : result.requiresMfa
                    ? this.mfaRedirect(safeNext)
                    : safeNext ?? '/dashboard';
            if (redirectMode) {
                return res.redirect(302, redirectTo);
            }
            return res.json({ success: true, redirectTo, pinResetRequired, requiresMfa: result.requiresMfa });
        } catch (err) {
            if (redirectMode && err instanceof UnauthorizedException) {
                const params = new URLSearchParams({ error: 'invalid' });
                if (body.tenantSlug) params.set('tenantSlug', body.tenantSlug);
                if (safeNext) params.set('next', safeNext);
                return res.redirect(302, `/auth/login?${params.toString()}`);
            }
            throw err;
        }
    }

    /**
     * Initiate OIDC login — redirects to provider.
     */
    /**
     * Username/password reset - always returns a generic request response.
     */
    @Public()
    @PreAuthThrottle()
    @Post('password/reset/request')
    @HttpCode(HttpStatus.OK)
    async requestPasswordReset(@Body() body: PasswordResetRequestBody, @Req() req: Request) {
        this.assertSameOriginRequest(req);
        await this.authService.createPasswordReset(body.identifier ?? '', body.tenantSlug);
        return PASSWORD_RESET_REQUEST_RESPONSE;
    }

    /**
     * Username/password reset - consume one reset token and revoke existing sessions.
     */
    @Public()
    @PreAuthThrottle()
    @Post('password/reset/confirm')
    @HttpCode(HttpStatus.OK)
    async confirmPasswordReset(@Body() body: PasswordResetConfirmBody, @Req() req: Request) {
        this.assertSameOriginRequest(req);
        await this.authService.resetPasswordWithToken(body.token, body.password, this.sessionRequestAudit(req));
        return { success: true };
    }

    @Public()
    @Get('login')
    async login(@Req() req: Request, @Res() res: Response) {
        if ((process.env.OIDC_ENABLED || 'true').toLowerCase() === 'false') {
            const nextPath = String((req.query as any)?.next || '');
            const safeNext = this.safeInternalPath(nextPath);
            const params = new URLSearchParams();
            if (safeNext) params.set('next', safeNext);
            const redirectTo = params.toString() ? `/auth/login?${params.toString()}` : '/auth/login';
            return res.redirect(302, redirectTo);
        }
        const tenantSlug = String((req.query as any)?.tenantSlug || '').trim().toLowerCase();
        if (!tenantSlug) {
            throw new BadRequestException('Workspace is required for SSO login');
        }
        const issuerUrl = process.env.OIDC_ISSUER_URL;
        const clientId = process.env.OIDC_CLIENT_ID;
        const redirectUri = process.env.OIDC_REDIRECT_URI;
        if (!issuerUrl || !clientId || !redirectUri) {
            throw new ServiceUnavailableException('OIDC login is not configured');
        }
        const nextPath = String((req.query as any)?.next || '');
        const safeNext = this.safeInternalPath(nextPath);
        const oidcState = await this.authService.createOidcState(safeNext, tenantSlug);
        res.cookie(OIDC_CORRELATION_COOKIE, oidcState.correlationNonce, {
            ...this.oidcCorrelationCookieOptions(),
            maxAge: oidcState.expiresInSeconds * 1000,
        });

        const authUrl = new URL('o/oauth2/auth', issuerUrl.endsWith('/') ? issuerUrl : `${issuerUrl}/`);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('client_id', String(clientId));
        authUrl.searchParams.set('redirect_uri', String(redirectUri));
        authUrl.searchParams.set('scope', 'openid email profile');
        authUrl.searchParams.set('state', oidcState.state);

        res.redirect(authUrl.toString());
    }

    /**
     * OIDC callback — exchange code and set session cookies.
     */
    @Public()
    @Get('callback')
    async callback(@Req() req: Request, @Res() res: Response) {
        const correlationNonce = req.cookies?.[OIDC_CORRELATION_COOKIE];
        this.clearOidcCorrelationCookie(res);
        if ((process.env.OIDC_ENABLED || 'true').toLowerCase() === 'false') {
            return res.redirect(302, '/auth/login');
        }
        const code = typeof req.query.code === 'string' ? req.query.code : '';
        const state = typeof req.query.state === 'string' ? req.query.state : '';
        if (!code || !state) {
            throw new BadRequestException('OIDC code and state are required');
        }
        const oidcState = await this.authService.consumeOidcState(state, correlationNonce);
        const result = await this.authService.handleOidcCallback(code, state, oidcState.tenantSlug, this.sessionRequestAudit(req));
        this.setSessionCookies(res, result.accessToken, result.refreshToken, result.csrfToken, result.sessionMaxAgeMs);

        if (result.requiresMfa) {
            res.redirect(this.mfaRedirect(oidcState.nextPath));
        } else {
            res.redirect(oidcState.nextPath ?? '/dashboard');
        }
    }

    /**
     * Email OTP — Send a 6-digit code to the given email address.
     */
    @Public()
    @PreAuthThrottle()
    @Post('email/send-otp')
    @HttpCode(HttpStatus.OK)
    async sendOtp(@Body() body: EmailOtpBody, @Req() req: Request) {
        this.assertSameOriginRequest(req);
        const normalizedEmail = this.normalizeOtpEmail(body.email);
        if (!normalizedEmail) {
            this.authDebug('send_otp_invalid_email');
            return { success: false, error: 'Invalid email address' };
        }
        const onboarding = body.onboarding === true;
        const provisionTenantName = this.onboardingTenantName(body);
        const legalAssent = this.onboardingLegalAssent(body);
        const signupCode = typeof body.signupCode === 'string' && body.signupCode.trim()
            ? body.signupCode
            : undefined;
        const signupChallengeToken = this.signupChallengeToken(body);
        const signupChallengeRemoteIp = this.signupChallengeRemoteIp(req);
        this.authDebug('send_otp_start', { maskedEmail: this.maskEmail(normalizedEmail) });
        let onboardingChallengeToken: string | undefined;
        try {
            let code: string;
            if (onboarding) {
                const challenge = await this.authService.createOnboardingSignupChallenge(normalizedEmail, {
                    allowProvision: true,
                    provisionTenantName,
                    ...legalAssent,
                    ...(signupCode ? { signupCode } : {}),
                    ...(signupChallengeToken ? { signupChallengeToken } : {}),
                    ...(signupChallengeRemoteIp ? { signupChallengeRemoteIp } : {}),
                });
                code = challenge.code;
                onboardingChallengeToken = challenge.challengeToken;
            } else {
                const recipientEligible = await this.authService.assertEmailOtpAllowed(normalizedEmail, {
                    tenantSlug: body.tenantSlug,
                });
                if (!recipientEligible) {
                    this.authDebug('send_otp_suppressed', { maskedEmail: this.maskEmail(normalizedEmail) });
                    return { success: true };
                }
                code = await this.otpService.generateOtp(normalizedEmail, {
                    tenantSlug: body.tenantSlug,
                });
            }
            await this.emailService.sendOtp(normalizedEmail, code);
        } catch (err) {
            if (err instanceof ForbiddenException) {
                throw err;
            }
            if (err instanceof ServiceUnavailableException) {
                throw err;
            }
            if (err instanceof BadRequestException) {
                if (!String(err.message).includes('Please wait')) {
                    throw err;
                }
                throw new HttpException('Please wait before requesting another code', HttpStatus.TOO_MANY_REQUESTS);
            }
            this.logger.error(
                `Failed OTP delivery for ${this.maskEmail(normalizedEmail)}: provider_error`,
            );
            throw new ServiceUnavailableException('Unable to send login code right now. Please try again shortly.');
        }
        this.authDebug('send_otp_success', { maskedEmail: this.maskEmail(normalizedEmail) });
        return onboardingChallengeToken
            ? { success: true, onboardingChallengeToken }
            : { success: true };
    }

    /**
     * Email OTP — Verify the code and issue session cookies.
     */
    @Public()
    @PreAuthThrottle()
    @Post('email/verify-otp')
    @HttpCode(HttpStatus.OK)
    async verifyOtp(
        @Body() body: EmailOtpBody & { code: string },
        @Req() req: Request,
        @Res() res: Response,
    ) {
        this.assertSameOriginRequest(req);
        const email = this.normalizeOtpEmail(body.email);
        if (!email) {
            throw new BadRequestException('Invalid email address');
        }
        const onboarding = body.onboarding === true;
        const provisionTenantName = this.onboardingTenantName(body);
        const legalAssent = this.onboardingLegalAssent(body);
        const signupCode = typeof body.signupCode === 'string' && body.signupCode.trim()
            ? body.signupCode
            : undefined;
        const redirectMode = String((req.query as any)?.redirect || '') === '1';
        const nextPath = String((req.query as any)?.next || '');
        const safeNext = this.safeInternalPath(nextPath);
        this.authDebug('verify_otp_start', {
            maskedEmail: this.maskEmail(email),
            redirectMode,
            hasNext: Boolean(safeNext),
        });

        try {
            if (!onboarding) {
                await this.otpService.verifyOtp(email, body.code, {
                    tenantSlug: body.tenantSlug,
                });
            }
            const result = await this.authService.loginWithEmail(email, {
                tenantSlug: body.tenantSlug,
                allowProvision: onboarding,
                provisionTenantName,
                ...legalAssent,
                ...(signupCode ? { signupCode } : {}),
                ...(onboarding ? { onboardingChallengeToken: body.onboardingChallengeToken } : {}),
                ...(onboarding ? { onboardingOtpCode: body.code } : {}),
            }, this.sessionRequestAudit(req));
            this.setSessionCookies(res, result.accessToken, result.refreshToken, result.csrfToken, result.sessionMaxAgeMs);

            const roleRedirect = '/dashboard';
            const redirectTo = result.requiresMfa ? this.mfaRedirect(safeNext) : safeNext ?? roleRedirect;
            this.authDebug('verify_otp_success', {
                maskedEmail: this.maskEmail(email),
                role: result.user.role,
                hasRedirect: Boolean(redirectTo),
                redirectMode,
            });

            if (redirectMode) {
                return res.redirect(302, redirectTo);
            }
            return res.json({
                success: true,
                redirectTo,
                requiresMfa: result.requiresMfa,
                workspaceSlug: result.workspaceSlug,
            });
        } catch (err) {
            const diagnostic = operationalErrorDiagnostics('auth.verify_otp_failed', err);
            this.authDebug('verify_otp_failed', {
                maskedEmail: this.maskEmail(email),
                redirectMode,
                errorClass: diagnostic.errorClass,
                errorCategory: diagnostic.category,
                errorCode: diagnostic.code,
            });
            if (redirectMode && err instanceof UnauthorizedException) {
                const params = new URLSearchParams({ error: 'invalid' });
                if (body.tenantSlug) params.set('tenantSlug', body.tenantSlug);
                if (safeNext) params.set('next', safeNext);
                return res.redirect(302, `/auth/login?${params.toString()}`);
            }
            throw err;
        }
    }

    /**
     * Username/PIN — Verify PIN and issue session cookies.
     */
    @Public()
    @PreAuthThrottle()
    @Post('pin/verify')
    @HttpCode(HttpStatus.OK)
    async verifyPin(
        @Body() body: { identifier: string; pin: string; tenantSlug?: string },
        @Req() req: Request,
        @Res() res: Response,
    ) {
        this.assertSameOriginRequest(req);
        const identifier = typeof body?.identifier === 'string' ? body.identifier.toLowerCase().trim() : '';
        const redirectMode = String((req.query as any)?.redirect || '') === '1';
        const nextPath = String((req.query as any)?.next || '');
        const safeNext = this.safeInternalPath(nextPath);

        try {
            const result = await this.authService.loginWithUsernamePin(identifier, body.pin, body.tenantSlug, this.sessionRequestAudit(req));
            this.setSessionCookies(res, result.accessToken, result.refreshToken, result.csrfToken, result.sessionMaxAgeMs);

            const pinResetRequired = result.pinResetRequired === true;
            const redirectTo = pinResetRequired
                ? this.pinResetRedirect(safeNext)
                : result.requiresMfa
                    ? this.mfaRedirect(safeNext)
                    : safeNext ?? '/dashboard';
            if (redirectMode) {
                return res.redirect(302, redirectTo);
            }
            return res.json({
                success: true,
                redirectTo,
                pinResetRequired,
                requiresMfa: result.requiresMfa,
            });
        } catch (err) {
            if (redirectMode && err instanceof UnauthorizedException) {
                const params = new URLSearchParams({ error: 'invalid' });
                if (body.tenantSlug) params.set('tenantSlug', body.tenantSlug);
                if (safeNext) params.set('next', safeNext);
                return res.redirect(302, `/auth/login?${params.toString()}`);
            }
            throw err;
        }
    }

    /**
     * Refresh access token using refresh cookie.
     */
    @Public()
    @RefreshThrottle()
    @Post('refresh')
    @HttpCode(HttpStatus.OK)
    async refresh(@Req() req: Request, @Res() res: Response) {
        this.assertSameOriginRequest(req);
        this.assertCsrfHeaderMatchesCookie(req);
        const refreshToken = req.cookies?.['refresh_token'];
        this.authDebug('refresh_start', { hasRefreshToken: Boolean(refreshToken) });
        const result = await this.authService.refreshAccessToken(refreshToken);
        this.authDebug('refresh_success', { hasAccessToken: Boolean(result?.accessToken) });

        this.setSessionCookies(
            res,
            result.accessToken,
            result.refreshToken,
            result.csrfToken,
            result.sessionMaxAgeMs,
        );

        res.json({
            success: true,
            requiresMfa: result.requiresMfa,
            mfaVerified: result.mfaVerified,
        });
    }

    /**
     * Start MFA enrollment for the current session.
     */
    @UseGuards(JwtAuthGuard)
    @AllowAuthenticated()
    @AuthThrottle()
    @Post('mfa/enroll')
    @HttpCode(HttpStatus.OK)
    async beginMfaEnrollment(@Req() req: any) {
        return this.authService.beginMfaEnrollment(req.user.sub, req.user);
    }

    @UseGuards(JwtAuthGuard)
    @AllowAuthenticated()
    @Get('mfa/enrollment')
    async getMfaEnrollment(@Req() req: any) {
        return this.authService.getMfaEnrollmentState(req.user.sub, req.user);
    }

    @UseGuards(JwtAuthGuard)
    @AllowAuthenticated()
    @AuthThrottle()
    @Post('mfa/enrollment')
    @HttpCode(HttpStatus.OK)
    async beginMfaEnrollmentAlias(@Req() req: any) {
        return this.beginMfaEnrollment(req);
    }

    /**
     * Confirm MFA enrollment and return one-time backup codes.
     */
    @UseGuards(JwtAuthGuard)
    @AllowAuthenticated()
    @AuthThrottle()
    @Post('mfa/enroll/confirm')
    @HttpCode(HttpStatus.OK)
    async confirmMfaEnrollment(@Req() req: any, @Body() body: { code: string }, @Res() res: Response) {
        const result = await this.authService.confirmMfaEnrollment(
            req.user.sub,
            body.code,
            req.user,
            this.sessionRequestAudit(req),
        );
        if (result.accessToken) {
            res.cookie('access_token', result.accessToken, {
                httpOnly: true,
                secure: this.useSecureCookies(),
                sameSite: 'strict' as const,
                path: '/',
                maxAge: result.accessTokenMaxAgeMs ?? ACCESS_TOKEN_COOKIE_MAX_AGE_MS,
            });
        }
        res.json({ success: true, mfaVerified: result.mfaVerified, backupCodes: result.backupCodes });
    }

    @UseGuards(JwtAuthGuard)
    @AllowAuthenticated()
    @AuthThrottle()
    @Put('mfa/enrollment')
    @HttpCode(HttpStatus.OK)
    async confirmMfaEnrollmentAlias(@Req() req: any, @Body() body: { code: string }, @Res() res: Response) {
        return this.confirmMfaEnrollment(req, body, res);
    }

    /**
     * Verify MFA code.
     */
    @UseGuards(JwtAuthGuard)
    @AllowAuthenticated()
    @AuthThrottle()
    @Post('mfa/verify')
    @HttpCode(HttpStatus.OK)
    async verifyMfa(@Req() req: any, @Body() body: { code: string }, @Res() res: Response) {
        const result = await this.authService.validateMfa(req.user.sub, body.code, req.user);
        if (result.accessToken) {
            res.cookie('access_token', result.accessToken, {
                httpOnly: true,
                secure: this.useSecureCookies(),
                sameSite: 'strict' as const,
                path: '/',
                maxAge: result.accessTokenMaxAgeMs ?? ACCESS_TOKEN_COOKIE_MAX_AGE_MS,
            });
        }
        res.json({ success: true, mfaVerified: result.mfaVerified });
    }

    /**
     * Logout — revoke session and clear cookies.
     */
    /**
     * Disable voluntary MFA when tenant policy allows it.
     */
    @UseGuards(JwtAuthGuard)
    @AllowAuthenticated()
    @AuthThrottle()
    @Post('mfa/disable')
    @HttpCode(HttpStatus.OK)
    async disableMfa(@Req() req: any, @Body() body: { code: string }) {
        return this.authService.disableMfa(req.user.sub, body.code, req.user, this.sessionRequestAudit(req));
    }

    @UseGuards(JwtAuthGuard)
    @AllowAuthenticated()
    @AuthThrottle()
    @Delete('mfa/enrollment')
    @HttpCode(HttpStatus.OK)
    async disableMfaAlias(@Req() req: any, @Body() body: { code: string }) {
        return this.disableMfa(req, body);
    }

    /**
     * Logout and revoke session cookies.
     */
    @Public()
    @RefreshThrottle()
    @Post('logout')
    @HttpCode(HttpStatus.OK)
    async logout(@Req() req: Request, @Res() res: Response) {
        this.assertSameOriginRequest(req);
        this.assertCsrfHeaderMatchesCookie(req);
        const result = await this.authService.revokeSessionByRefreshToken(req.cookies?.['refresh_token']);
        const secure = this.useSecureCookies();

        res.clearCookie('access_token', { httpOnly: true, secure, sameSite: 'strict', path: '/' });
        res.clearCookie('refresh_token', { httpOnly: true, secure, sameSite: 'strict', path: '/' });
        res.clearCookie('csrf_token', { httpOnly: false, secure, sameSite: 'strict', path: '/' });
        res.json({ success: true, session: result.status });
    }

    /**
     * Get current authenticated user.
     */
    @UseGuards(JwtAuthGuard)
    @AllowAuthenticated()
    @Get('me')
    async me(@Req() req: any) {
        const user = await this.authService.getSessionUserContext(req.user.sub, req.user.tenantId, req.user);
        return { user };
    }
}
