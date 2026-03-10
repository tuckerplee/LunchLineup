import { Controller, Get, Post, Body, Req, UseGuards, SetMetadata, HttpCode, HttpStatus, UnauthorizedException, Logger } from '@nestjs/common';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { EmailService } from './email.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { Response, Request } from 'express';
import { Res } from '@nestjs/common';

const Public = () => SetMetadata('isPublic', true);
const ACCESS_TOKEN_COOKIE_MAX_AGE_MS = 30 * 60 * 1000;
const REFRESH_TOKEN_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

@Controller({ path: 'auth', version: '1' })
export class AuthController {
    private readonly logger = new Logger(AuthController.name);

    constructor(
        private authService: AuthService,
        private otpService: OtpService,
        private emailService: EmailService,
    ) { }

    private isAuthDebugEnabled(): boolean {
        return ['1', 'true', 'yes', 'on'].includes((process.env.AUTH_DEBUG ?? '').toLowerCase());
    }

    private maskEmail(email: string): string {
        const [localPart, domain] = email.split('@');
        if (!domain) return 'invalid_email';
        const safeLocal = localPart.length <= 2 ? `${localPart[0] ?? '*'}*` : `${localPart.slice(0, 2)}***`;
        return `${safeLocal}@${domain}`;
    }

    private authDebug(event: string, details: Record<string, unknown> = {}) {
        if (!this.isAuthDebugEnabled()) return;
        this.logger.log(`[auth-debug] ${JSON.stringify({ scope: 'api.auth', event, ...details })}`);
    }

    private setSessionCookies(res: Response, accessToken: string, refreshToken: string, csrfToken: string) {
        const cookieOptions = {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict' as const,
            path: '/',
        };

        res.cookie('access_token', accessToken, { ...cookieOptions, maxAge: ACCESS_TOKEN_COOKIE_MAX_AGE_MS });
        res.cookie('refresh_token', refreshToken, { ...cookieOptions, maxAge: REFRESH_TOKEN_COOKIE_MAX_AGE_MS });
        res.cookie('csrf_token', csrfToken, {
            httpOnly: false,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            path: '/',
        });
    }

    @Public()
    @Post('login/resolve')
    @HttpCode(HttpStatus.OK)
    async resolveLoginFlow(@Body() body: { identifier: string }) {
        const result = await this.authService.resolveLoginMethod(body.identifier);
        return {
            success: true,
            flow: result.flow,
            identifier: result.normalizedIdentifier,
            pinResetRequired: result.flow === 'USERNAME_PIN' ? result.pinResetRequired : false,
        };
    }

    /**
     * Initiate OIDC login — redirects to provider.
     */
    @Public()
    @Get('login')
    async login(@Req() req: Request, @Res() res: Response) {
        if ((process.env.OIDC_ENABLED || 'true').toLowerCase() === 'false') {
            const nextPath = String((req.query as any)?.next || '');
            const safeNext = nextPath.startsWith('/') ? nextPath : null;
            const params = new URLSearchParams();
            if (safeNext) params.set('next', safeNext);
            const redirectTo = params.toString() ? `/auth/login?${params.toString()}` : '/auth/login';
            return res.redirect(302, redirectTo);
        }
        const issuerUrl = process.env.OIDC_ISSUER_URL;
        const clientId = process.env.OIDC_CLIENT_ID;
        const redirectUri = process.env.OIDC_REDIRECT_URI;
        const state = require('crypto').randomBytes(16).toString('hex');

        const authUrl = `${issuerUrl}/o/oauth2/auth?` +
            `response_type=code&client_id=${clientId}&redirect_uri=${redirectUri}` +
            `&scope=openid email profile&state=${state}`;

        res.redirect(authUrl);
    }

    /**
     * OIDC callback — exchange code and set session cookies.
     */
    @Public()
    @Get('callback')
    async callback(@Req() req: Request, @Res() res: Response) {
        if ((process.env.OIDC_ENABLED || 'true').toLowerCase() === 'false') {
            return res.redirect(302, '/auth/login');
        }
        const { code, state } = req.query as { code: string; state: string };
        const result = await this.authService.handleOidcCallback(code, state);
        this.setSessionCookies(res, result.accessToken, result.refreshToken, result.csrfToken);

        if (result.requiresMfa) {
            res.redirect('/mfa');
        } else {
            res.redirect(result.user?.role === 'SUPER_ADMIN' ? '/admin' : '/dashboard');
        }
    }

    /**
     * Email OTP — Send a 6-digit code to the given email address.
     */
    @Public()
    @Post('email/send-otp')
    @HttpCode(HttpStatus.OK)
    async sendOtp(@Body() body: { email: string }) {
        if (!body.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
            this.authDebug('send_otp_invalid_email');
            return { success: false, error: 'Invalid email address' };
        }
        const normalizedEmail = body.email.toLowerCase();
        this.authDebug('send_otp_start', { email: this.maskEmail(normalizedEmail) });
        const code = await this.otpService.generateOtp(normalizedEmail);
        await this.emailService.sendOtp(normalizedEmail, code);
        this.authDebug('send_otp_success', { email: this.maskEmail(normalizedEmail) });
        return { success: true };
    }

    /**
     * Email OTP — Verify the code and issue session cookies.
     */
    @Public()
    @Post('email/verify-otp')
    @HttpCode(HttpStatus.OK)
    async verifyOtp(
        @Body() body: { email: string; code: string },
        @Req() req: Request,
        @Res() res: Response,
    ) {
        const email = body.email.toLowerCase();
        const redirectMode = String((req.query as any)?.redirect || '') === '1';
        const nextPath = String((req.query as any)?.next || '');
        const safeNext = nextPath.startsWith('/') ? nextPath : null;
        this.authDebug('verify_otp_start', {
            email: this.maskEmail(email),
            redirectMode,
            hasNext: Boolean(safeNext),
        });

        try {
            await this.otpService.verifyOtp(email, body.code);
            const result = await this.authService.loginWithEmail(email);
            this.setSessionCookies(res, result.accessToken, result.refreshToken, result.csrfToken);

            const roleRedirect = result.user.role === 'SUPER_ADMIN' ? '/admin' : '/dashboard';
            const redirectTo = safeNext ?? roleRedirect;
            this.authDebug('verify_otp_success', {
                email: this.maskEmail(email),
                role: result.user.role,
                redirectTo,
                redirectMode,
            });

            if (redirectMode) {
                return res.redirect(302, redirectTo);
            }
            return res.json({ success: true, redirectTo });
        } catch (err) {
            this.authDebug('verify_otp_failed', {
                email: this.maskEmail(email),
                redirectMode,
                error: err instanceof Error ? err.message : 'unknown_error',
            });
            if (redirectMode && err instanceof UnauthorizedException) {
                const params = new URLSearchParams({
                    step: 'otp',
                    email,
                    error: 'invalid',
                });
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
    @Post('pin/verify')
    @HttpCode(HttpStatus.OK)
    async verifyPin(
        @Body() body: { identifier: string; pin: string },
        @Req() req: Request,
        @Res() res: Response,
    ) {
        const identifier = body.identifier.toLowerCase().trim();
        const redirectMode = String((req.query as any)?.redirect || '') === '1';
        const nextPath = String((req.query as any)?.next || '');
        const safeNext = nextPath.startsWith('/') ? nextPath : null;

        try {
            const result = await this.authService.loginWithUsernamePin(identifier, body.pin);
            this.setSessionCookies(res, result.accessToken, result.refreshToken, result.csrfToken);

            const redirectTo = safeNext ?? '/dashboard';
            if (redirectMode) {
                return res.redirect(302, redirectTo);
            }
            return res.json({ success: true, redirectTo, pinResetRequired: false });
        } catch (err) {
            if (redirectMode && err instanceof UnauthorizedException) {
                const params = new URLSearchParams({
                    step: 'pin',
                    identifier,
                    error: 'invalid',
                });
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
    @Post('refresh')
    @HttpCode(HttpStatus.OK)
    async refresh(@Req() req: Request, @Res() res: Response) {
        const refreshToken = req.cookies?.['refresh_token'];
        this.authDebug('refresh_start', { hasRefreshToken: Boolean(refreshToken) });
        const result = await this.authService.refreshAccessToken(refreshToken);
        this.authDebug('refresh_success', { hasAccessToken: Boolean(result?.accessToken) });

        res.cookie('access_token', result.accessToken, {
            httpOnly: true, secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict' as const, path: '/', maxAge: ACCESS_TOKEN_COOKIE_MAX_AGE_MS,
        });

        res.json({ success: true, accessToken: result.accessToken });
    }

    /**
     * Verify MFA code.
     */
    @UseGuards(JwtAuthGuard)
    @Post('mfa/verify')
    @HttpCode(HttpStatus.OK)
    async verifyMfa(@Req() req: any, @Body() body: { code: string }) {
        return this.authService.validateMfa(req.user.sub, body.code);
    }

    /**
     * Logout — revoke session and clear cookies.
     */
    @UseGuards(JwtAuthGuard)
    @Post('logout')
    @HttpCode(HttpStatus.OK)
    async logout(@Req() req: any, @Res() res: Response) {
        await this.authService.revokeSession(req.user.sessionId);
        res.clearCookie('access_token');
        res.clearCookie('refresh_token');
        res.clearCookie('csrf_token');
        res.json({ success: true });
    }

    /**
     * Get current authenticated user.
     */
    @UseGuards(JwtAuthGuard)
    @Get('me')
    async me(@Req() req: any) {
        return { user: req.user };
    }
}
