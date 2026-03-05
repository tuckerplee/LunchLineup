import { Controller, Get, Post, Body, Req, UseGuards, SetMetadata, HttpCode, HttpStatus } from '@nestjs/common';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { EmailService } from './email.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { Response, Request } from 'express';
import { Res } from '@nestjs/common';

const Public = () => SetMetadata('isPublic', true);

@Controller({ path: 'auth', version: '1' })
export class AuthController {
    constructor(
        private authService: AuthService,
        private otpService: OtpService,
        private emailService: EmailService,
    ) { }

    /**
     * Initiate OIDC login — redirects to provider.
     */
    @Public()
    @Get('login')
    async login(@Res() res: Response) {
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
        const { code, state } = req.query as { code: string; state: string };
        const result = await this.authService.handleOidcCallback(code, state);

        const cookieOptions = {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict' as const,
            path: '/',
        };

        res.cookie('access_token', result.accessToken, { ...cookieOptions, maxAge: 15 * 60 * 1000 });
        res.cookie('refresh_token', result.refreshToken, { ...cookieOptions, maxAge: 7 * 24 * 60 * 60 * 1000 });
        res.cookie('csrf_token', result.csrfToken, {
            httpOnly: false, secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict', path: '/',
        });

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
            return { success: false, error: 'Invalid email address' };
        }
        const code = await this.otpService.generateOtp(body.email.toLowerCase());
        await this.emailService.sendOtp(body.email.toLowerCase(), code);
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
        @Res() res: Response,
    ) {
        await this.otpService.verifyOtp(body.email.toLowerCase(), body.code);
        const result = await this.authService.loginWithEmail(body.email.toLowerCase());

        const cookieOptions = {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict' as const,
            path: '/',
        };

        res.cookie('access_token', result.accessToken, { ...cookieOptions, maxAge: 15 * 60 * 1000 });
        res.cookie('refresh_token', result.refreshToken, { ...cookieOptions, maxAge: 7 * 24 * 60 * 60 * 1000 });
        res.cookie('csrf_token', result.csrfToken, {
            httpOnly: false, secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict', path: '/',
        });

        const redirectTo = result.user.role === 'SUPER_ADMIN' ? '/admin' : '/dashboard';
        res.json({ success: true, redirectTo });
    }

    /**
     * Refresh access token using refresh cookie.
     */
    @Public()
    @Post('refresh')
    @HttpCode(HttpStatus.OK)
    async refresh(@Req() req: Request, @Res() res: Response) {
        const refreshToken = req.cookies?.['refresh_token'];
        const result = await this.authService.refreshAccessToken(refreshToken);

        res.cookie('access_token', result.accessToken, {
            httpOnly: true, secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict' as const, path: '/', maxAge: 15 * 60 * 1000,
        });

        res.json({ success: true });
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
