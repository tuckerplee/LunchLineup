import { Injectable, UnauthorizedException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, TokenPayload } from './jwt.service';
import { PrismaClient, UserRole } from '@prisma/client';
import * as crypto from 'crypto';
import { assertTenantCanAddActiveUser } from '../billing/user-capacity';
import { RbacService } from './rbac.service';

type UserRoleValue = 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF';
const USER_ROLE: Record<UserRoleValue, UserRoleValue> = {
    SUPER_ADMIN: 'SUPER_ADMIN',
    ADMIN: 'ADMIN',
    MANAGER: 'MANAGER',
    STAFF: 'STAFF',
};

export type LoginResolveResult =
    | { flow: 'EMAIL_OTP'; normalizedIdentifier: string }
    | { flow: 'USERNAME_PIN'; normalizedIdentifier: string; pinResetRequired: boolean };

@Injectable()
export class AuthService {
    private prisma = new PrismaClient();

    constructor(
        private configService: ConfigService,
        private jwtService: JwtService,
        private rbacService: RbacService,
    ) { }

    private isEmailIdentifier(identifier: string): boolean {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);
    }

    private normalizeIdentifier(identifier: string): string {
        return identifier.trim().toLowerCase();
    }

    private isPin(pin: string): boolean {
        return /^\d{4,8}$/.test(pin);
    }

    private hashPin(pin: string): string {
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.scryptSync(pin, salt, 64).toString('hex');
        return `${salt}:${hash}`;
    }

    private verifyPin(pin: string, storedHash: string): boolean {
        const [salt, hash] = storedHash.split(':');
        if (!salt || !hash) return false;
        const computed = crypto.scryptSync(pin, salt, 64).toString('hex');
        return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(computed, 'hex'));
    }

    private async createSessionTokens(user: { id: string; tenantId: string; role: string; email: string | null; username: string | null }, source: string) {
        const access = await this.rbacService.getEffectiveAccess(user.id, user.tenantId);
        const session = await this.prisma.session.create({
            data: {
                userId: user.id,
                refreshToken: crypto.randomBytes(32).toString('hex'),
                ipAddress: source,
                userAgent: source,
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            },
        });

        const payload: TokenPayload = {
            sub: user.id,
            tenantId: user.tenantId,
            role: access.primaryRole,
            legacyRole: user.role,
            sessionId: session.id,
            mfaVerified: true,
        };

        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                lastLoginAt: new Date(),
                loginAttempts: 0,
                lockedUntil: null,
            },
        });

        return {
            accessToken: this.jwtService.generateAccessToken(payload),
            refreshToken: session.refreshToken,
            csrfToken: this.jwtService.generateCsrfToken(),
            user: {
                id: user.id,
                email: user.email,
                username: user.username,
                role: access.primaryRole,
                roles: access.roles,
                permissions: access.permissions,
            },
        };
    }

    async resolveLoginMethod(identifierRaw: string): Promise<LoginResolveResult> {
        const identifier = this.normalizeIdentifier(identifierRaw);
        if (!identifier) {
            throw new BadRequestException('Email or username is required');
        }

        if (this.isEmailIdentifier(identifier)) {
            return { flow: 'EMAIL_OTP', normalizedIdentifier: identifier };
        }

        const user = await this.prisma.user.findFirst({
            where: {
                username: identifier,
                deletedAt: null,
            },
            select: {
                id: true,
                tenantId: true,
                role: true,
                pinResetRequired: true,
            },
        });

        if (user) {
            const access = await this.rbacService.getEffectiveAccess(user.id, user.tenantId);
            if (!access.permissions.includes('auth:login_pin')) {
                throw new ForbiddenException('This account does not allow username and PIN login.');
            }
        }

        return {
            flow: 'USERNAME_PIN',
            normalizedIdentifier: identifier,
            pinResetRequired: user?.pinResetRequired ?? false,
        };
    }

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

        let user = await this.prisma.user.findFirst({
            where: { email: userInfo.email, deletedAt: null },
        });

        if (!user) {
            const tenant = await this.prisma.tenant.create({
                data: {
                    name: `${userInfo.name || userInfo.email}'s Team`,
                    slug: crypto.randomBytes(8).toString('hex'),
                }
            });

            await assertTenantCanAddActiveUser(this.prisma, tenant.id);

            user = await this.prisma.user.create({
                data: {
                    email: userInfo.email,
                    name: userInfo.name || userInfo.email,
                    tenantId: tenant.id,
                    role: USER_ROLE.SUPER_ADMIN,
                }
            });
            await this.rbacService.assignLegacySystemRole(user.id, user.tenantId, user.role as UserRole);
        }

        await this.checkAccountLockout(user.email ?? undefined);

        const result = await this.createSessionTokens({
            id: user.id,
            email: user.email,
            username: user.username,
            tenantId: user.tenantId,
            role: user.role,
        }, 'OIDC');

        return {
            ...result,
            requiresMfa: user.mfaEnabled,
        };
    }

    /**
     * Email OTP login — find or create user by email, issue session.
     * Used by the verify-otp endpoint after OTP is confirmed.
     */
    async loginWithEmail(emailRaw: string) {
        const email = this.normalizeIdentifier(emailRaw);
        let user = await this.prisma.user.findFirst({
            where: { email, deletedAt: null },
        });

        if (!user) {
            const isFirstUser = (await this.prisma.user.count()) === 0;

            const tenant = await this.prisma.tenant.create({
                data: {
                    name: `${email.split('@')[0]}'s Team`,
                    slug: crypto.randomBytes(6).toString('hex'),
                },
            });

            await assertTenantCanAddActiveUser(this.prisma, tenant.id);

            user = await this.prisma.user.create({
                data: {
                    email,
                    name: email.split('@')[0],
                    tenantId: tenant.id,
                    role: isFirstUser ? USER_ROLE.SUPER_ADMIN : USER_ROLE.ADMIN,
                },
            });
            await this.rbacService.assignLegacySystemRole(user.id, user.tenantId, user.role as UserRole);
        }
        if (user) {
            const access = await this.rbacService.getEffectiveAccess(user.id, user.tenantId);
            if (!access.permissions.includes('auth:login_email')) {
                throw new ForbiddenException('This account does not allow email login.');
            }
        }

        await this.checkAccountLockout(user.email ?? undefined);
        return this.createSessionTokens({
            id: user.id,
            email: user.email,
            username: user.username,
            tenantId: user.tenantId,
            role: user.role,
        }, 'email-otp');
    }

    async loginWithUsernamePin(identifierRaw: string, pin: string) {
        const username = this.normalizeIdentifier(identifierRaw);
        if (!username || !this.isPin(pin)) {
            throw new UnauthorizedException('Invalid username or PIN');
        }

        const user = await this.prisma.user.findFirst({
            where: { username, deletedAt: null },
        });

        if (!user || !user.pinHash) {
            throw new UnauthorizedException('Invalid username or PIN');
        }

        const access = await this.rbacService.getEffectiveAccess(user.id, user.tenantId);
        if (!access.permissions.includes('auth:login_pin')) {
            throw new UnauthorizedException('Invalid username or PIN');
        }

        if (user.pinLockedUntil && user.pinLockedUntil > new Date()) {
            throw new ForbiddenException('PIN login temporarily locked due to too many attempts');
        }

        const valid = this.verifyPin(pin, user.pinHash);
        if (!valid) {
            const attempts = user.pinLoginAttempts + 1;
            const lock = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
            await this.prisma.user.update({
                where: { id: user.id },
                data: {
                    pinLoginAttempts: attempts,
                    pinLockedUntil: lock,
                },
            });
            throw new UnauthorizedException('Invalid username or PIN');
        }

        if (user.pinLoginAttempts > 0 || user.pinLockedUntil) {
            await this.prisma.user.update({
                where: { id: user.id },
                data: {
                    pinLoginAttempts: 0,
                    pinLockedUntil: null,
                },
            });
        }

        return this.createSessionTokens({
            id: user.id,
            email: user.email,
            username: user.username,
            tenantId: user.tenantId,
            role: user.role,
        }, 'username-pin');
    }

    async setUserPin(userId: string, pin: string, pinResetRequired = false): Promise<void> {
        if (!this.isPin(pin)) {
            throw new BadRequestException('PIN must be 4-8 numeric digits');
        }

        await this.prisma.user.update({
            where: { id: userId },
            data: {
                pinHash: this.hashPin(pin),
                pinSetAt: new Date(),
                pinResetRequired,
                pinLoginAttempts: 0,
                pinLockedUntil: null,
            },
        });
    }

    async rotateOwnPin(userId: string, currentPin: string, newPin: string): Promise<void> {
        if (!this.isPin(currentPin) || !this.isPin(newPin)) {
            throw new BadRequestException('PIN must be 4-8 numeric digits');
        }

        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, username: true, pinHash: true },
        });

        if (!user || !user.username || !user.pinHash) {
            throw new ForbiddenException('PIN change is only available for username accounts');
        }

        const validCurrentPin = this.verifyPin(currentPin, user.pinHash);
        if (!validCurrentPin) {
            throw new UnauthorizedException('Current PIN is invalid');
        }

        await this.setUserPin(user.id, newPin, false);
    }

    async refreshAccessToken(refreshToken: string) {
        try {
            this.jwtService.verifyRefreshToken(refreshToken);
        } catch {
            // Using DB-only refresh token approach as fallback.
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
            role: (
                await this.rbacService.getEffectiveAccess(session.user.id, session.user.tenantId)
            ).primaryRole,
            legacyRole: session.user.role,
            sessionId: session.id,
            mfaVerified: !session.user.mfaEnabled,
        };

        return {
            accessToken: this.jwtService.generateAccessToken(payload),
        };
    }

    async getSessionUserContext(userId: string, tenantId: string, sessionClaims: { role: string; sessionId: string }) {
        const user = await this.prisma.user.findFirst({
            where: {
                id: userId,
                tenantId,
                deletedAt: null,
            },
            select: {
                id: true,
                tenantId: true,
                role: true,
                email: true,
                username: true,
                name: true,
                tenant: {
                    select: {
                        name: true,
                    },
                },
            },
        });

        if (!user) {
            throw new UnauthorizedException('User not found');
        }

        const access = await this.rbacService.getEffectiveAccess(user.id, user.tenantId);

        return {
            sub: user.id,
            tenantId: user.tenantId,
            sessionId: sessionClaims.sessionId,
            role: access.primaryRole,
            legacyRole: user.role ?? null,
            roles: access.roles,
            permissions: access.permissions,
            email: user.email,
            username: user.username,
            name: user.name,
            tenantName: user.tenant?.name ?? '',
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

        return { success: true, mfaVerified: true };
    }

    async checkAccountLockout(email?: string): Promise<void> {
        if (!email) return;
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
