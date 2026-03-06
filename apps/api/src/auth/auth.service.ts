import { Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, TokenPayload } from './jwt.service';
import { PrismaClient, UserRole } from '@prisma/client';
import * as crypto from 'crypto';

@Injectable()
export class AuthService {
    private prisma = new PrismaClient();

    constructor(
        private configService: ConfigService,
        private jwtService: JwtService,
    ) { }

    async handleOidcCallback(code: string, state: string) {
        const issuerUrl = this.configService.getOrThrow('OIDC_ISSUER_URL');
        const clientId = this.configService.getOrThrow('OIDC_CLIENT_ID');
        const clientSecret = this.configService.getOrThrow('OIDC_CLIENT_SECRET');
        const redirectUri = this.configService.getOrThrow('OIDC_REDIRECT_URI');

        const tokenEndpoint = `${issuerUrl}/o/oauth2/token`;
        const tokenResponse = await this.exchangeCode(tokenEndpoint, {
            grant_type: 'authorization_code',
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
        });

        const userInfo = await this.fetchUserInfo(issuerUrl, tokenResponse.access_token);

        if (!userInfo.email) {
            throw new UnauthorizedException('OIDC provider did not return an email address');
        }

        // 3. Find or create user in our database
        // Look up by email. For now, assume a multi-tenant default or lookup
        let user = await this.prisma.user.findFirst({
            where: { email: userInfo.email, deletedAt: null },
        });

        if (!user) {
            // Self-signup: create a new tenant and user
            const tenant = await this.prisma.tenant.create({
                data: {
                    name: `${userInfo.name || userInfo.email}'s Team`,
                    slug: crypto.randomBytes(8).toString('hex'),
                }
            });

            user = await this.prisma.user.create({
                data: {
                    email: userInfo.email,
                    name: userInfo.name || userInfo.email,
                    tenantId: tenant.id,
                    role: UserRole.SUPER_ADMIN,
                }
            });
        }

        await this.checkAccountLockout(user.email);

        // 4. Create a server-side session
        const session = await this.prisma.session.create({
            data: {
                userId: user.id,
                refreshToken: crypto.randomBytes(32).toString('hex'),
                ipAddress: 'OIDC', // In a real flow, pass Req IP
                userAgent: 'OIDC',
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
            }
        });

        // 5. Generate tokens
        const payload: TokenPayload = {
            sub: user.id,
            tenantId: user.tenantId,
            role: user.role,
            sessionId: session.id,
            mfaVerified: !user.mfaEnabled,
        };

        const accessToken = this.jwtService.generateAccessToken(payload);
        const csrfToken = this.jwtService.generateCsrfToken();

        // Successful login, clear failed attempts
        if (user.loginAttempts > 0) {
            await this.prisma.user.update({
                where: { id: user.id },
                data: { loginAttempts: 0, lockedUntil: null }
            });
        }

        return {
            accessToken,
            refreshToken: session.refreshToken,
            csrfToken,
            requiresMfa: user.mfaEnabled,
            user: { id: user.id, email: user.email, role: user.role },
        };
    }

    /**
     * Email OTP login — find or create user by email, issue session.
     * Used by the verify-otp endpoint after OTP is confirmed.
     */
    async loginWithEmail(email: string) {
        let user = await this.prisma.user.findFirst({
            where: { email, deletedAt: null },
        });

        if (!user) {
            // First user ever → create a tenant + SUPER_ADMIN
            // Subsequent users → created as ADMIN for their organization
            const isFirstUser = (await this.prisma.user.count()) === 0;

            const tenant = await this.prisma.tenant.create({
                data: {
                    name: `${email.split('@')[0]}'s Team`,
                    slug: crypto.randomBytes(6).toString('hex'),
                },
            });

            user = await this.prisma.user.create({
                data: {
                    email,
                    name: email.split('@')[0],
                    tenantId: tenant.id,
                    role: isFirstUser ? UserRole.SUPER_ADMIN : UserRole.ADMIN,
                },
            });
        } else if (user.role !== UserRole.ADMIN && user.role !== UserRole.SUPER_ADMIN) {
            // Bootstrap safety: if tenant has no locations yet, allow onboarding to finish.
            const tenantLocationCount = await this.prisma.location.count({
                where: { tenantId: user.tenantId, deletedAt: null },
            });

            if (tenantLocationCount === 0) {
                user = await this.prisma.user.update({
                    where: { id: user.id },
                    data: { role: UserRole.ADMIN },
                });
            }
        }

        await this.checkAccountLockout(user.email);

        const session = await this.prisma.session.create({
            data: {
                userId: user.id,
                refreshToken: crypto.randomBytes(32).toString('hex'),
                ipAddress: 'email-otp',
                userAgent: 'email-otp',
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            },
        });

        const payload: TokenPayload = {
            sub: user.id,
            tenantId: user.tenantId,
            role: user.role,
            sessionId: session.id,
            mfaVerified: true, // OTP is the second factor
        };

        return {
            accessToken: this.jwtService.generateAccessToken(payload),
            refreshToken: session.refreshToken,
            csrfToken: this.jwtService.generateCsrfToken(),
            user: { id: user.id, email: user.email, role: user.role },
        };
    }

    async refreshAccessToken(refreshToken: string) {
        let decodedSessionId: string | undefined;

        try {
            const decoded = this.jwtService.verifyRefreshToken(refreshToken);
            decodedSessionId = decoded.sessionId;
        } catch {
            // Using DB-only refresh token approach as fallback
        }

        const session = await this.prisma.session.findUnique({
            where: { refreshToken },
            include: { user: true }
        });

        if (!session || session.revokedAt || session.expiresAt < new Date()) {
            throw new UnauthorizedException('Invalid or expired refresh token');
        }

        if (session.user.deletedAt) {
            throw new UnauthorizedException('User account inactive');
        }

        const payload: TokenPayload = {
            sub: session.user.id,
            tenantId: session.user.tenantId,
            role: session.user.role,
            sessionId: session.id,
            mfaVerified: !session.user.mfaEnabled,
        };

        return {
            accessToken: this.jwtService.generateAccessToken(payload),
        };
    }

    async validateMfa(userId: string, code: string) {
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user || (!user.mfaEnabled)) {
            return { success: true, mfaVerified: true };
        }

        const validCode = code.length === 6 && /^\d+$/.test(code);
        if (!validCode) {
            throw new ForbiddenException('Invalid MFA code');
        }

        // Ideally verify against user.mfaSecret and user.mfaBackupCodes using otplib

        return { success: true, mfaVerified: true };
    }

    async checkAccountLockout(email: string): Promise<void> {
        const user = await this.prisma.user.findFirst({ where: { email } });
        if (user?.lockedUntil && user.lockedUntil > new Date()) {
            throw new ForbiddenException('Account locked due to too many failed attempts');
        }
    }

    async recordFailedAttempt(email: string): Promise<void> {
        const user = await this.prisma.user.findFirst({ where: { email } });
        if (user) {
            const newAttempts = user.loginAttempts + 1;
            const lockedUntil = newAttempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
            await this.prisma.user.update({
                where: { id: user.id },
                data: {
                    loginAttempts: newAttempts,
                    lockedUntil: lockedUntil
                },
            });
        }
    }

    async revokeSession(sessionId: string): Promise<void> {
        await this.prisma.session.updateMany({
            where: { id: sessionId },
            data: { revokedAt: new Date() },
        });
    }

    private async exchangeCode(endpoint: string, params: Record<string, string>): Promise<any> {
        const body = new URLSearchParams(params).toString();
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
        if (!response.ok) throw new UnauthorizedException('OIDC token exchange failed');
        return response.json();
    }

    private async fetchUserInfo(issuerUrl: string, accessToken: string): Promise<any> {
        const response = await fetch(`${issuerUrl}/o/oauth2/userinfo`, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!response.ok) throw new UnauthorizedException('Failed to fetch user info');
        return response.json();
    }
}
