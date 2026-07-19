import { Injectable, UnauthorizedException, ForbiddenException, BadRequestException, Logger, OnModuleDestroy, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, TokenPayload } from './jwt.service';
import { Prisma, PrismaClient, TenantStatus } from '@prisma/client';
import * as crypto from 'crypto';
import { PRIVILEGED_MFA_PERMISSION_KEYS, RbacService } from './rbac.service';
import * as bcrypt from 'bcryptjs';
import Redis from 'ioredis';
import { TenantPrismaService, TenantPrismaTransaction } from '../database/tenant-prisma.service';
import { PasswordResetOutboxService } from './password-reset-outbox.service';
import { OnboardingSignupService } from './onboarding-signup.service';
import { operationalErrorLog } from './operational-error';
import { secureHttpRequest, type SecureRequestOptions } from '../common/secure-http-client';
import { PUBLIC_LEGAL_MANIFEST, hasCurrentSelfServiceLegalApproval } from '@lunchlineup/config';
import {
    isPrismaUniqueConstraintConflict,
    isSerializableTransactionConflict,
} from '../database/transaction-error';
import { runSerializableMutationWithRetry } from './serializable-mutation';

const WORKSPACE_SETTINGS_KEY = 'workspace_settings';
const DEFAULT_SESSION_TIMEOUT_MINUTES = 480;
const MIN_SESSION_TIMEOUT_MINUTES = 5;
const MAX_SESSION_TIMEOUT_MINUTES = 1440;
const MAX_ACTIVE_SESSIONS_PER_USER = 20;
const SESSION_CREATION_TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 10_000 } as const;
const ACCESS_TOKEN_MAX_AGE_MS = 30 * 60 * 1000;
const OIDC_STATE_TTL_SECONDS = 10 * 60;
const KEY_OIDC_STATE = (state: string) => `oidc_state:${state}`;
const KEY_SESSION_MFA = (sessionId: string) => `session_mfa:${sessionId}`;
const MFA_ENROLLMENT_TTL_SECONDS = 10 * 60;
const KEY_PENDING_MFA_ENROLLMENT = (sessionId: string, userId: string) => `mfa_enrollment:${sessionId}:${userId}`;
const DEFAULT_MFA_ISSUER = 'LunchLineup';
const MFA_BACKUP_CODE_COUNT = 10;
const MAX_PROVISIONED_TENANT_NAME_LENGTH = 80;
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAX_TURNSTILE_TOKEN_LENGTH = 2048;
const AUTH_PROVIDER_REQUEST_TIMEOUT_MS = 8_000;
const MAX_TURNSTILE_RESPONSE_BYTES = 16 * 1024;
const MAX_OIDC_TOKEN_RESPONSE_BYTES = 32 * 1024;
const MAX_OIDC_USERINFO_RESPONSE_BYTES = 64 * 1024;
const MAX_OIDC_ACCESS_TOKEN_LENGTH = 16 * 1024;
const HASHED_REFRESH_TOKEN_PREFIX = 'sha256:';
const HASHED_SESSION_SELECTOR_PREFIX = 'selector-sha256:';
const SELECTED_REFRESH_TOKEN_VERSION = 'v2';
const PASSWORD_RESET_TOKEN_TTL_MINUTES = 60;
const MIN_RESET_PASSWORD_LENGTH = 8;
const MAX_BCRYPT_PASSWORD_BYTES = 72;
const MAX_LOGIN_IDENTIFIER_LENGTH = 254;
const MAX_SESSION_IP_LENGTH = 64;
const MAX_SESSION_USER_AGENT_LENGTH = 512;
const SYSTEM_GENERATED_USER_EMAIL_DOMAIN = 'staff.lunchlineup.local';
const DUMMY_PASSWORD_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
const DUMMY_PIN_HASH = 'dummy-salt:' + '0'.repeat(128);
const ENCRYPTED_MFA_SECRET_PREFIX = 'enc:v1:';
const CURRENT_ENCRYPTED_MFA_SECRET_PREFIX = 'enc:v2:';
const MFA_ENCRYPTION_CURRENT_KEY_ENV = 'MFA_SECRET_ENCRYPTION_KEY_CURRENT';
const MFA_ENCRYPTION_PREVIOUS_KEY_ENV = 'MFA_SECRET_ENCRYPTION_KEY_PREVIOUS';
const MFA_ENCRYPTION_LEGACY_KEY_ENV = 'MFA_SECRET_ENCRYPTION_KEY';
const AUTH_BLOCKED_TENANT_STATUSES = new Set<string>([
    TenantStatus.SUSPENDED,
    TenantStatus.PURGED,
]);
const PUBLIC_SIGNUP_MODES = new Set(['closed_beta', 'invite_only', 'open']);
const BETA_DEMO_TENANT_SLUG = 'demo';
const BETA_DEMO_IDENTIFIER = 'demo@demo.com';

class UsernameReservationConflict extends Error {}

type TenantSecuritySettings = {
    requireMfaForAll: boolean;
    sessionTimeoutMinutes: number;
    ssoOidcOnly: boolean;
};

type AuthenticatedUser = {
    id: string;
    tenantId: string;
    role: string;
    email: string | null;
    username: string | null;
    mfaEnabled?: boolean | null;
    pinResetRequired?: boolean | null;
};

type SessionRecord = {
    id: string;
    userId: string;
    expiresAt: Date;
    createdAt: Date;
    revokedAt: Date | null;
};

type MfaPolicyAccess = {
    primaryRole?: string | null;
    permissions?: string[];
};

type LoginMethod = 'OIDC' | 'EMAIL_OTP' | 'USERNAME_PIN' | 'USERNAME_PASSWORD';

type MfaManagedKey = {
    ref: string;
    value: Buffer;
    legacy: boolean;
};

export type SessionRequestAudit = {
    ipAddress?: string | null;
    userAgent?: string | null;
};

export type PasswordLoginOptions = {
    betaDemoMfaBypass?: boolean;
};

type SessionTokenAudit = SessionRequestAudit & {
    loginMethod: LoginMethod | string;
};

type SessionMfaExemption = 'BETA_DEMO' | null;

type SelectedRefreshCredential = {
    kind: 'selected';
    selector: string;
    selectorHash: string;
    validatorHash: string;
};

type LegacyRefreshCredential = {
    kind: 'legacy';
    candidates: string[];
};

type RefreshCredential = SelectedRefreshCredential | LegacyRefreshCredential;

type RefreshSession = Prisma.SessionGetPayload<{ include: { user: true } }>;

type RefreshRotationResult =
    | {
        status: 'rotated';
        session: RefreshSession;
    }
    | {
        status: 'replayed';
        sessionId: string;
    }
    | { status: 'invalid' };

type RefreshAuthorizationContext = {
    session: RefreshSession;
    access: MfaPolicyAccess & { primaryRole: string };
    effectiveExpiresAt: Date;
    mfaRequired: boolean;
    mfaVerified: boolean;
};

type NormalizedSessionTokenAudit = {
    loginMethod: LoginMethod | string;
    ipAddress: string;
    userAgent: string;
};

type MfaSessionUser = {
    id: string;
    tenantId: string;
    role: string;
    email: string | null;
    username: string | null;
    pinResetRequired: boolean;
    mfaEnabled: boolean | null;
    mfaSecret: string | null;
    mfaBackupCodes: string[];
};

type MfaSessionContext = {
    user: MfaSessionUser;
    session: SessionRecord;
    settings: TenantSecuritySettings;
    effectiveExpiresAt: Date;
};

type OidcStatePayload = {
    nextPath: string | null;
    tenantSlug?: string | null;
    createdAt: number;
    correlationHash: string;
};

type OidcUserInfo = {
    sub?: unknown;
    email?: unknown;
    email_verified?: unknown;
};

type LoginTenantContext = {
    tenantId: string;
    tenantSlug: string;
};

type EmailLoginOptions = {
    tenantSlug?: string;
    allowProvision?: boolean;
    termsVersion?: string;
    privacyVersion?: string;
    provisionTenantName?: string;
    signupCode?: string;
    onboardingChallengeToken?: string;
    onboardingOtpCode?: string;
    signupChallengeToken?: string;
    signupChallengeRemoteIp?: string;
    termsAccepted?: boolean;
    privacyAccepted?: boolean;
};

type TenantAuthState = {
    id: string;
    slug?: string | null;
    status: TenantStatus | string;
    deletedAt: Date | null;
};

export type LoginResolveResult =
    | { flow: 'EMAIL_OTP'; normalizedIdentifier: string }
    | { flow: 'USERNAME_PASSWORD'; normalizedIdentifier: string };

@Injectable()
export class AuthService implements OnModuleDestroy {
    private readonly logger = new Logger(AuthService.name);
    private prisma = new PrismaClient();
    private redis?: Redis;

    constructor(
        private configService: ConfigService,
        private jwtService: JwtService,
        private rbacService: RbacService,
        @Optional() private tenantDb?: TenantPrismaService,
        @Optional() private onboardingSignup?: OnboardingSignupService,
    ) {
        if (tenantDb) {
            this.prisma = tenantDb.client;
        }
    }

    onModuleDestroy(): void {
        this.redis?.disconnect(false);
    }

    private getRedis(): Redis {
        if (!this.redis) {
            this.redis = new Redis(
                this.configService.get<string>('REDIS_URL', 'redis://localhost:6379'),
            );
            this.redis.on('error', (err) => this.logger.error(operationalErrorLog('auth.redis_client_error', err)));
        }
        return this.redis;
    }

    private getTenantDb(): TenantPrismaService {
        if (!this.tenantDb) {
            this.tenantDb = new TenantPrismaService(this.prisma);
        }
        return this.tenantDb;
    }
    private getOnboardingSignup(): OnboardingSignupService {
        if (!this.onboardingSignup) {
            this.onboardingSignup = new OnboardingSignupService(this.getTenantDb(), this.rbacService);
        }
        return this.onboardingSignup;
    }


    private normalizeSessionTimeoutMinutes(value: unknown): number {
        return typeof value === 'number'
            && Number.isInteger(value)
            && value >= MIN_SESSION_TIMEOUT_MINUTES
            && value <= MAX_SESSION_TIMEOUT_MINUTES
            ? value
            : DEFAULT_SESSION_TIMEOUT_MINUTES;
    }

    private normalizeTenantSlug(value?: unknown): string {
        return typeof value === 'string' ? value.trim().toLowerCase() : '';
    }

    private normalizeProvisionedTenantName(value?: unknown): string {
        const tenantName = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
        if (!tenantName) {
            throw new BadRequestException('Organization name is required');
        }
        if (tenantName.length > MAX_PROVISIONED_TENANT_NAME_LENGTH) {
            throw new BadRequestException(`Organization name must be ${MAX_PROVISIONED_TENANT_NAME_LENGTH} characters or less`);
        }
        return tenantName;
    }

    private assertTenantCanAuthenticate(tenant: TenantAuthState | null): asserts tenant is TenantAuthState {
        if (!tenant || tenant.deletedAt || AUTH_BLOCKED_TENANT_STATUSES.has(String(tenant.status))) {
            throw new UnauthorizedException('Invalid workspace or login');
        }
        // PAST_DUE and CANCELLED tenants can authenticate; billing entitlement gates remove paid access.
    }

    private async assertTenantIdCanAuthenticate(tenantId: string): Promise<void> {
        const tenant = await this.getTenantDb().withPlatformAdmin((tx) => tx.tenant.findUnique({
            where: { id: tenantId },
            select: { id: true, status: true, deletedAt: true },
        }));
        this.assertTenantCanAuthenticate(tenant);
    }

    private async lockTenantForSessionIssuance(
        tx: TenantPrismaTransaction,
        tenantId: string,
    ): Promise<void> {
        await tx.$queryRaw`
            SELECT "id"
            FROM "Tenant"
            WHERE "id" = ${tenantId}
            FOR UPDATE
        `;
        const tenant = await tx.tenant.findUnique({
            where: { id: tenantId },
            select: { id: true, status: true, deletedAt: true },
        });
        this.assertTenantCanAuthenticate(tenant);
    }

    private getPublicSignupMode(): 'closed_beta' | 'invite_only' | 'open' {
        if (process.env.NODE_ENV === 'production' && !hasCurrentSelfServiceLegalApproval()) {
            return 'closed_beta';
        }
        const configured = this.configService.get<string>('PUBLIC_SIGNUP_MODE')?.trim().toLowerCase();
        if (!configured) {
            return 'open';
        }
        if (PUBLIC_SIGNUP_MODES.has(configured)) {
            return configured as 'closed_beta' | 'invite_only' | 'open';
        }
        this.logger.error('Invalid PUBLIC_SIGNUP_MODE; public signup is disabled.');
        return 'closed_beta';
    }

    private isValidPublicSignupInviteCode(signupCode?: string | null): boolean {
        const normalized = (signupCode ?? '').trim();
        if (!normalized) return false;
        const configuredCodes = (this.configService.get<string>('PUBLIC_SIGNUP_INVITE_CODES') ?? '')
            .split(',')
            .map((code) => code.trim())
            .filter(Boolean);
        return configuredCodes.some((code) => this.safeEqual(code, normalized));
    }

    private assertPublicSignupAllowed(signupCode?: string | null): void {
        const mode = this.getPublicSignupMode();
        if (mode === 'open') return;
        if (mode === 'invite_only' && this.isValidPublicSignupInviteCode(signupCode)) return;
        throw new ForbiddenException('Public workspace signup is not available.');
    }

    private assertPublicSignupLegalAssent(options: EmailLoginOptions): void {
        if (
            options.termsAccepted !== true
            || options.privacyAccepted !== true
            || options.termsVersion !== PUBLIC_LEGAL_MANIFEST.documents.terms.version
            || options.privacyVersion !== PUBLIC_LEGAL_MANIFEST.documents.privacy.version
        ) {
            throw new BadRequestException('Terms and Privacy assent is required to create a workspace');
        }
    }

    private async assertPublicSignupOtpRequestAllowed(options: EmailLoginOptions): Promise<void> {
        const mode = this.getPublicSignupMode();
        this.assertPublicSignupAllowed(options.signupCode);
        if (mode !== 'open') return;

        await this.verifyPublicSignupChallenge(options.signupChallengeToken, options.signupChallengeRemoteIp);
    }

    private async verifyPublicSignupChallenge(tokenRaw?: string | null, remoteIp?: string | null): Promise<void> {
        const secret = this.configService.get<string>('TURNSTILE_SECRET_KEY')?.trim();
        if (!secret) {
            if (process.env.NODE_ENV === 'production') {
                this.logger.error('Open public signup is enabled without TURNSTILE_SECRET_KEY.');
                throw new ServiceUnavailableException('Signup verification is not configured.');
            }
            return;
        }

        const token = (tokenRaw ?? '').trim();
        if (!token || token.length > MAX_TURNSTILE_TOKEN_LENGTH) {
            throw new ForbiddenException('Signup verification is required.');
        }

        const body = new URLSearchParams({
            secret,
            response: token,
        });
        const normalizedRemoteIp = (remoteIp ?? '').trim();
        if (normalizedRemoteIp) {
            body.set('remoteip', normalizedRemoteIp);
        }

        try {
            const response = await this.requestAuthProvider(TURNSTILE_VERIFY_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body.toString(),
                timeoutMs: AUTH_PROVIDER_REQUEST_TIMEOUT_MS,
                maxResponseBytes: MAX_TURNSTILE_RESPONSE_BYTES,
                redirect: 'error',
            });
            if (!response.ok) {
                throw new ServiceUnavailableException('Signup verification is unavailable.');
            }
            const result = await this.readProviderJsonObject(response);
            if (result.success !== true) {
                throw new ForbiddenException('Signup verification failed.');
            }
        } catch (err) {
            if (err instanceof ForbiddenException || err instanceof ServiceUnavailableException) {
                throw err;
            }
            this.logger.error('Public signup challenge verification failed: verification_unavailable');
            throw new ServiceUnavailableException('Signup verification is unavailable.');
        }
    }

    private async resolveLoginTenantContext(tenantSlugRaw?: string | null): Promise<LoginTenantContext> {
        const tenantSlug = this.normalizeTenantSlug(tenantSlugRaw);
        if (!tenantSlug) {
            throw new BadRequestException('Workspace is required');
        }

        const tenant = await this.getTenantDb().withPlatformAdmin((tx) => tx.tenant.findUnique({
            where: { slug: tenantSlug },
            select: { id: true, slug: true, deletedAt: true, status: true },
        }));

        this.assertTenantCanAuthenticate(tenant);

        return { tenantId: tenant.id, tenantSlug: tenant.slug ?? tenantSlug };
    }

    private async getTenantSecuritySettings(tenantId: string): Promise<TenantSecuritySettings> {
        return this.getTenantDb().withTenant(
            tenantId,
            (tx) => this.tenantSecuritySettingsInTransaction(tx, tenantId),
        );
    }

    private async tenantSecuritySettingsInTransaction(
        tx: TenantPrismaTransaction,
        tenantId: string,
    ): Promise<TenantSecuritySettings> {
        const setting = await tx.tenantSetting.findUnique({
            where: {
                tenantId_key: {
                    tenantId,
                    key: WORKSPACE_SETTINGS_KEY,
                },
            },
            select: {
                value: true,
            },
        });
        const raw = setting?.value && typeof setting.value === 'object' && !Array.isArray(setting.value)
            ? setting.value as { security?: Record<string, unknown> }
            : {};
        const security = raw.security ?? {};

        return {
            requireMfaForAll: security.requireMfaForAll === true,
            ssoOidcOnly: security.ssoOidcOnly === true,
            sessionTimeoutMinutes: this.normalizeSessionTimeoutMinutes(security.sessionTimeoutMinutes),
        };
    }

    private isPrivilegedMfaRequiredForAccess(access?: MfaPolicyAccess): boolean {
        return Array.isArray(access?.permissions)
            && access.permissions.some((permission) => PRIVILEGED_MFA_PERMISSION_KEYS.has(permission));
    }

    private isMfaRequired(
        user: { mfaEnabled?: boolean | null },
        settings: TenantSecuritySettings,
        access?: MfaPolicyAccess,
    ): boolean {
        return user.mfaEnabled === true || settings.requireMfaForAll || this.isPrivilegedMfaRequiredForAccess(access);
    }

    private mfaIssuer(): string {
        const configured = this.configService.get<string>('MFA_ISSUER', DEFAULT_MFA_ISSUER);
        const issuer = typeof configured === 'string' ? configured.trim() : '';
        return issuer || DEFAULT_MFA_ISSUER;
    }

    private mfaAccountLabel(user: { email?: string | null; username?: string | null; id: string }): string {
        return (user.email ?? user.username ?? user.id).trim() || user.id;
    }

    private generateBase32Secret(byteLength = 20): string {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        let bits = 0;
        let value = 0;
        let output = '';

        for (const byte of crypto.randomBytes(byteLength)) {
            value = (value << 8) | byte;
            bits += 8;
            while (bits >= 5) {
                output += alphabet[(value >>> (bits - 5)) & 31];
                bits -= 5;
            }
        }

        if (bits > 0) {
            output += alphabet[(value << (5 - bits)) & 31];
        }

        return output;
    }

    private buildOtpAuthUrl(secret: string, user: { email?: string | null; username?: string | null; id: string }): string {
        const issuer = this.mfaIssuer();
        const label = `${issuer}:${this.mfaAccountLabel(user)}`;
        const params = new URLSearchParams({
            secret,
            issuer,
            algorithm: 'SHA1',
            digits: '6',
            period: '30',
        });
        return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
    }

    private generateBackupCodes(): string[] {
        return Array.from({ length: MFA_BACKUP_CODE_COUNT }, () => {
            const token = crypto.randomBytes(9).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, '').padEnd(12, '0').slice(0, 12);
            return `${token.slice(0, 4)}-${token.slice(4, 8)}-${token.slice(8, 12)}`;
        });
    }

    private hashBackupCode(code: string): string {
        return this.hashPin(code);
    }

    private getEffectiveSessionExpiresAt(session: SessionRecord, settings: TenantSecuritySettings): Date {
        const policyExpiresAt = new Date(session.createdAt.getTime() + settings.sessionTimeoutMinutes * 60 * 1000);
        return policyExpiresAt < session.expiresAt ? policyExpiresAt : session.expiresAt;
    }

    private assertSessionActive(session: SessionRecord, settings: TenantSecuritySettings): Date {
        const effectiveExpiresAt = this.getEffectiveSessionExpiresAt(session, settings);
        if (session.revokedAt || effectiveExpiresAt <= new Date()) {
            throw new UnauthorizedException('Invalid or expired session');
        }
        return effectiveExpiresAt;
    }

    private getAccessTokenMaxAgeMs(expiresAt: Date): number {
        const remainingMs = expiresAt.getTime() - Date.now();
        return Math.max(0, Math.min(ACCESS_TOKEN_MAX_AGE_MS, remainingMs));
    }

    private async assertTenantAllowsLoginMethod(
        tenantId: string,
        method: 'OIDC' | 'EMAIL_OTP' | 'USERNAME_PIN' | 'USERNAME_PASSWORD',
    ): Promise<TenantSecuritySettings> {
        const settings = await this.getTenantSecuritySettings(tenantId);
        if (settings.ssoOidcOnly && method !== 'OIDC') {
            throw new ForbiddenException('This tenant requires SSO login.');
        }
        return settings;
    }

    private isEmailIdentifier(identifier: string): boolean {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);
    }

    private normalizeIdentifier(identifier: unknown): string {
        if (typeof identifier !== 'string') return '';
        const normalized = identifier.trim().toLowerCase();
        return normalized.length <= MAX_LOGIN_IDENTIFIER_LENGTH ? normalized : '';
    }

    async createOidcState(nextPath: string | null = null, tenantSlugRaw?: string | null) {
        const state = crypto.randomBytes(32).toString('hex');
        const correlationNonce = crypto.randomBytes(32).toString('hex');
        const payload: OidcStatePayload = {
            nextPath,
            tenantSlug: this.normalizeTenantSlug(tenantSlugRaw) || null,
            createdAt: Date.now(),
            correlationHash: crypto.createHash('sha256').update(correlationNonce).digest('hex'),
        };
        await this.getRedis().set(KEY_OIDC_STATE(state), JSON.stringify(payload), 'EX', OIDC_STATE_TTL_SECONDS);
        return { state, correlationNonce, expiresInSeconds: OIDC_STATE_TTL_SECONDS };
    }

    async consumeOidcState(
        stateRaw: string,
        correlationNonceRaw: unknown,
    ): Promise<Omit<OidcStatePayload, 'correlationHash'>> {
        const state = typeof stateRaw === 'string' ? stateRaw.trim() : '';
        if (!/^[a-f0-9]{64}$/i.test(state)) {
            throw new UnauthorizedException('Invalid OIDC state');
        }

        const key = KEY_OIDC_STATE(state);
        const rawPayload = await this.getRedis().get(key);
        await this.getRedis().del(key);
        if (!rawPayload) {
            throw new UnauthorizedException('Invalid OIDC state');
        }

        try {
            const parsed = JSON.parse(rawPayload) as OidcStatePayload;
            const correlationNonce = typeof correlationNonceRaw === 'string' ? correlationNonceRaw.trim() : '';
            const correlationHash = typeof parsed.correlationHash === 'string' ? parsed.correlationHash : '';
            const suppliedCorrelationHash = /^[a-f0-9]{64}$/i.test(correlationNonce)
                ? crypto.createHash('sha256').update(correlationNonce).digest('hex')
                : '';
            if (!correlationHash || !this.safeEqual(correlationHash, suppliedCorrelationHash)) {
                throw new UnauthorizedException('Invalid OIDC state');
            }
            return {
                nextPath: typeof parsed.nextPath === 'string' ? parsed.nextPath : null,
                tenantSlug: typeof parsed.tenantSlug === 'string' ? this.normalizeTenantSlug(parsed.tenantSlug) : null,
                createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
            };
        } catch (error) {
            if (error instanceof UnauthorizedException) throw error;
            throw new UnauthorizedException('Invalid OIDC state');
        }
    }

    private normalizeOidcIssuer(value: string): string {
        try {
            const issuer = new URL(value);
            if (issuer.protocol !== 'https:' && issuer.protocol !== 'http:') throw new Error('invalid protocol');
            return issuer.toString().replace(/\/$/, '');
        } catch {
            throw new ServiceUnavailableException('OIDC login is not configured correctly');
        }
    }

    private normalizeOidcSubject(value: unknown): string {
        const subject = typeof value === 'string' ? value.trim() : '';
        if (!subject || subject.length > 512) {
            throw new UnauthorizedException('OIDC provider identity is invalid');
        }
        return subject;
    }

    private async resolveAndBindOidcUser(tenantId: string, email: string, issuer: string, subject: string) {
        try {
            return await this.getTenantDb().withTenant(tenantId, async (tx) => {
                const identityUser = await tx.user.findFirst({
                    where: {
                        tenantId,
                        oidcIssuer: issuer,
                        oidcSubject: subject,
                        deletedAt: null, suspendedAt: null,
                    },
                });
                if (identityUser) {
                    if (this.normalizeIdentifier(identityUser.email ?? '') !== email) {
                        throw new UnauthorizedException('OIDC identity does not match this account');
                    }
                    return identityUser;
                }

                const emailUser = await tx.user.findFirst({
                    where: { tenantId, email, deletedAt: null, suspendedAt: null },
                });
                if (!emailUser) {
                    throw new UnauthorizedException('Invalid workspace or login');
                }

                if (emailUser.oidcIssuer !== null || emailUser.oidcSubject !== null) {
                    throw new UnauthorizedException('OIDC identity does not match this account');
                }

                const bound = await tx.user.updateMany({
                    where: {
                        id: emailUser.id,
                        tenantId,
                        oidcIssuer: null,
                        oidcSubject: null,
                        deletedAt: null,
                        suspendedAt: null,
                    },
                    data: { oidcIssuer: issuer, oidcSubject: subject },
                });
                if (bound.count !== 1) {
                    throw new UnauthorizedException('OIDC identity does not match this account');
                }

                return { ...emailUser, oidcIssuer: issuer, oidcSubject: subject };
            });
        } catch (err) {
            if (err instanceof UnauthorizedException) throw err;
            if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002') {
                throw new UnauthorizedException('OIDC identity does not match this account');
            }
            throw err;
        }
    }

    private isPin(pin: unknown): pin is string {
        return typeof pin === 'string' && /^\d{4,8}$/.test(pin);
    }

    private hashPin(pin: string): string {
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.scryptSync(pin, salt, 64).toString('hex');
        return `${salt}:${hash}`;
    }

    buildPinCredentialData(pin: string, pinResetRequired = false, now = new Date()) {
        if (!this.isPin(pin)) {
            throw new BadRequestException('PIN must be 4-8 numeric digits');
        }

        return {
            pinHash: this.hashPin(pin),
            pinSetAt: now,
            pinResetRequired,
            pinLoginAttempts: 0,
            pinLockedUntil: null,
        };
    }

    private usernameFromName(name: string): string {
        const base = name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '.')
            .replace(/^\.+|\.+$/g, '')
            .slice(0, 28);
        if (!base) return 'staff.user';
        return base.length < 3 ? `${base}.usr` : base;
    }

    private async generateUniqueUsername(
        tx: TenantPrismaTransaction,
        tenantId: string,
        name: string,
    ): Promise<string> {
        const seed = this.usernameFromName(name);
        let candidate = seed;
        for (let attempt = 0; attempt < 20; attempt += 1) {
            const taken = await tx.user.findFirst({
                where: { tenantId, username: candidate },
                select: { id: true },
            });
            if (!taken) return candidate;
            candidate = `${seed.slice(0, 24)}.${crypto.randomInt(1000, 10_000)}`;
        }
        return `${seed.slice(0, 20)}.${Date.now().toString().slice(-6)}`;
    }

    private canBootstrapPinUsername(email: string | null): boolean {
        return !email || email.endsWith(`@${SYSTEM_GENERATED_USER_EMAIL_DOMAIN}`);
    }

    private verifyPin(pin: string, storedHash: string): boolean {
        const [salt, hash] = storedHash.split(':');
        if (!salt || !hash) return false;
        const computed = crypto.scryptSync(pin, salt, 64).toString('hex');
        return this.safeEqual(hash, computed);
    }

    private verifyLegacyPassword(password: string, storedHash: string): boolean {
        try {
            const normalizedHash = storedHash.replace(/^\$2y\$/, '$2a$');
            return bcrypt.compareSync(password, normalizedHash);
        } catch {
            return false;
        }
    }


    private hashRefreshToken(refreshToken: string): string {
        return `${HASHED_REFRESH_TOKEN_PREFIX}${crypto.createHash('sha256').update(refreshToken).digest('hex')}`;
    }

    private refreshTokenLookupCandidates(refreshToken: string): string[] {
        const hashed = this.hashRefreshToken(refreshToken);
        return hashed === refreshToken ? [hashed] : [hashed, refreshToken];
    }

    private canonicalRefreshTokenHash(storedToken: string): string {
        return /^sha256:[a-f0-9]{64}$/i.test(storedToken)
            ? storedToken.toLowerCase()
            : this.hashRefreshToken(storedToken);
    }

    private hashSessionSelector(selector: string): string {
        return `${HASHED_SESSION_SELECTOR_PREFIX}${crypto.createHash('sha256').update(selector).digest('hex')}`;
    }

    private generateSelectedRefreshCredential(): SelectedRefreshCredential & { validator: string; token: string } {
        const selector = crypto.randomBytes(32).toString('base64url');
        const validator = crypto.randomBytes(32).toString('base64url');
        return {
            kind: 'selected',
            selector,
            selectorHash: this.hashSessionSelector(selector),
            validatorHash: this.hashRefreshToken(validator),
            validator,
            token: `${SELECTED_REFRESH_TOKEN_VERSION}.${selector}.${validator}`,
        };
    }

    private parseRefreshCredential(refreshTokenRaw: unknown): RefreshCredential | null {
        const refreshToken = typeof refreshTokenRaw === 'string' ? refreshTokenRaw.trim() : '';
        if (!refreshToken) return null;

        const selectedMatch = /^v2\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(refreshToken);
        if (selectedMatch) {
            const [, selector, validator] = selectedMatch;
            return {
                kind: 'selected',
                selector,
                selectorHash: this.hashSessionSelector(selector),
                validatorHash: this.hashRefreshToken(validator),
            };
        }
        if (refreshToken.startsWith(`${SELECTED_REFRESH_TOKEN_VERSION}.`)) return null;

        return { kind: 'legacy', candidates: this.refreshTokenLookupCandidates(refreshToken) };
    }

    private generatePasswordResetToken(): string {
        return crypto.randomBytes(32).toString('base64url');
    }

    private hashPasswordResetToken(token: string): string {
        return `${HASHED_REFRESH_TOKEN_PREFIX}${crypto.createHash('sha256').update(token).digest('hex')}`;
    }

    private normalizePasswordResetToken(tokenRaw: unknown): string | null {
        if (typeof tokenRaw !== 'string') return null;
        const token = tokenRaw.trim();
        return /^[A-Za-z0-9_-]{32,128}$/.test(token) ? token : null;
    }

    private validateNewPassword(passwordRaw: unknown): string {
        if (typeof passwordRaw !== 'string') {
            throw new BadRequestException('Password is required');
        }
        const password = passwordRaw;
        if (password.length < MIN_RESET_PASSWORD_LENGTH || Buffer.byteLength(password, 'utf8') > MAX_BCRYPT_PASSWORD_BYTES) {
            throw new BadRequestException(`Password must be ${MIN_RESET_PASSWORD_LENGTH}-${MAX_BCRYPT_PASSWORD_BYTES} bytes.`);
        }
        return password;
    }

    private hashNewPassword(password: string): Promise<string> {
        return bcrypt.hash(password, 12);
    }

    private normalizeSessionAuditValue(value: string | null | undefined, maxLength: number): string {
        return typeof value === 'string'
            ? value.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, maxLength)
            : '';
    }

    private securityRequestAudit(source: SessionRequestAudit = {}): { ipAddress: string | null; userAgent: string | null } {
        return {
            ipAddress: this.normalizeSessionAuditValue(source.ipAddress, MAX_SESSION_IP_LENGTH) || null,
            userAgent: this.normalizeSessionAuditValue(source.userAgent, MAX_SESSION_USER_AGENT_LENGTH) || null,
        };
    }

    private async clearSessionMfaMarkersBestEffort(sessionIds: string[], event: string): Promise<void> {
        if (sessionIds.length === 0) return;
        await this.runRedisMutationBestEffort(
            event,
            () => this.getRedis().del(...sessionIds.map((sessionId) => KEY_SESSION_MFA(sessionId))),
        );
    }

    private async runRedisMutationBestEffort(
        event: string,
        operation: () => Promise<unknown>,
    ): Promise<void> {
        try {
            await operation();
        } catch (err) {
            this.logger.warn(operationalErrorLog(event, err));
        }
    }

    private sessionTokenAudit(source: SessionTokenAudit | string): NormalizedSessionTokenAudit {
        if (typeof source === 'string') {
            return {
                loginMethod: source,
                ipAddress: '',
                userAgent: '',
            };
        }
        return {
            loginMethod: source.loginMethod,
            ipAddress: this.normalizeSessionAuditValue(source.ipAddress, MAX_SESSION_IP_LENGTH),
            userAgent: this.normalizeSessionAuditValue(source.userAgent, MAX_SESSION_USER_AGENT_LENGTH),
        };
    }

    private async createSessionTokens(
        user: AuthenticatedUser,
        source: SessionTokenAudit | string,
        resetLoginAttempts = true,
        mfaExemption: SessionMfaExemption = null,
    ) {
        const audit = this.sessionTokenAudit(source);
        await this.assertTenantIdCanAuthenticate(user.tenantId);
        const settings = await this.getTenantSecuritySettings(user.tenantId);
        const expiresAt = new Date(Date.now() + settings.sessionTimeoutMinutes * 60 * 1000);
        const refreshCredential = this.generateSelectedRefreshCredential();
        const issuance = await this.getTenantDb().withTenant(user.tenantId, async (tx) => {
            await this.lockTenantForSessionIssuance(tx, user.tenantId);
            await tx.$queryRaw(Prisma.sql`
                SELECT "id"
                FROM "User"
                WHERE "id" = ${user.id} AND "tenantId" = ${user.tenantId}
                FOR UPDATE
            `);
            const lockedUser = await tx.user.findFirst({
                where: {
                    id: user.id,
                    tenantId: user.tenantId,
                    deletedAt: null,
                    suspendedAt: null,
                },
            });
            if (!lockedUser) {
                throw new UnauthorizedException('User account inactive');
            }

            // Role assignment mutations lock this same user row before replacing
            // access and revoking sessions. Resolve access only after the lock so
            // the session, permission, and MFA policy share one linearization point.
            const access = await this.rbacService.getEffectiveAccess(lockedUser.id, lockedUser.tenantId);
            const mfaRequired = this.isMfaRequired(lockedUser, settings, access);
            const now = new Date();
            await tx.session.deleteMany({
                where: {
                    userId: lockedUser.id,
                    OR: [
                        { revokedAt: { not: null } },
                        { expiresAt: { lte: now } },
                    ],
                },
            });
            const excessSessions = await tx.session.findMany({
                where: {
                    userId: lockedUser.id,
                    revokedAt: null,
                    expiresAt: { gt: now },
                },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                skip: MAX_ACTIVE_SESSIONS_PER_USER - 1,
                select: { id: true },
            });
            if (excessSessions.length > 0) {
                await tx.session.deleteMany({
                    where: {
                        userId: lockedUser.id,
                        id: { in: excessSessions.map((candidate) => candidate.id) },
                    },
                });
            }
            const session = await tx.session.create({
                data: {
                    userId: lockedUser.id,
                    refreshToken: refreshCredential.validatorHash,
                    selectorHash: refreshCredential.selectorHash,
                    ipAddress: audit.ipAddress,
                    userAgent: audit.userAgent,
                    expiresAt,
                },
            });

            await tx.auditLog.create({
                data: {
                    tenantId: lockedUser.tenantId,
                    userId: lockedUser.id,
                    action: 'SESSION_CREATED',
                    resource: 'Session',
                    resourceId: session.id,
                    newValue: {
                        loginMethod: audit.loginMethod,
                        ...(mfaExemption ? { mfaExemption } : {}),
                    },
                    ipAddress: audit.ipAddress || null,
                    userAgent: audit.userAgent || null,
                },
            });

            await tx.user.update({
                where: { id: lockedUser.id },
                data: resetLoginAttempts
                    ? {
                        lastLoginAt: new Date(),
                        loginAttempts: 0,
                        lockedUntil: null,
                    }
                    : { lastLoginAt: new Date() },
            });

            return { session, user: lockedUser, access, mfaRequired };
        }, SESSION_CREATION_TRANSACTION_OPTIONS);
        const { session, user: currentUser, access, mfaRequired } = issuance;
        const mfaVerified = !mfaRequired || mfaExemption === 'BETA_DEMO';
        if (mfaRequired && mfaExemption === 'BETA_DEMO') {
            try {
                await this.markSessionMfaVerified(session.id, expiresAt);
            } catch (error) {
                this.logger.warn(operationalErrorLog('auth.beta_demo_mfa_marker_failed', error));
                await this.getTenantDb().withTenant(currentUser.tenantId, (tx) => tx.session.updateMany({
                    where: {
                        id: session.id,
                        userId: currentUser.id,
                        revokedAt: null,
                    },
                    data: { revokedAt: new Date() },
                })).catch((cleanupError) => {
                    this.logger.warn(operationalErrorLog('auth.beta_demo_session_cleanup_failed', cleanupError));
                });
                throw new ServiceUnavailableException('Authentication service temporarily unavailable');
            }
        }

        const payload: TokenPayload = {
            sub: currentUser.id,
            tenantId: currentUser.tenantId,
            role: access.primaryRole,
            legacyRole: currentUser.role,
            sessionId: session.id,
            mfaVerified,
            pinResetRequired: currentUser.pinResetRequired === true,
        };

        return {
            accessToken: this.jwtService.generateAccessToken(payload),
            refreshToken: refreshCredential.token,
            csrfToken: this.jwtService.generateCsrfToken(),
            requiresMfa: mfaRequired && !mfaVerified,
            pinResetRequired: currentUser.pinResetRequired === true,
            sessionMaxAgeMs: settings.sessionTimeoutMinutes * 60 * 1000,
            user: {
                id: currentUser.id,
                email: currentUser.email,
                username: currentUser.username,
                role: access.primaryRole,
                roles: access.roles,
                permissions: access.permissions,
            },
        };
    }

    async resolveLoginMethod(identifierRaw: string, tenantSlugRaw?: string): Promise<LoginResolveResult> {
        const identifier = this.normalizeIdentifier(identifierRaw);
        if (!identifier) {
            throw new BadRequestException('Email or username is required');
        }
        if (!this.normalizeTenantSlug(tenantSlugRaw)) {
            throw new BadRequestException('Workspace is required');
        }

        if (this.isEmailIdentifier(identifier)) {
            return { flow: 'EMAIL_OTP', normalizedIdentifier: identifier };
        }

        return {
            flow: 'USERNAME_PASSWORD',
            normalizedIdentifier: identifier,
        };
    }

    async assertEmailOtpAllowed(emailRaw: string, options: EmailLoginOptions = {}): Promise<boolean> {
        const email = this.normalizeIdentifier(emailRaw);
        if (!this.isEmailIdentifier(email)) {
            throw new BadRequestException('Email is required');
        }
        if (!options.tenantSlug) {
            if (options.allowProvision) {
                this.normalizeProvisionedTenantName(options.provisionTenantName);
                await this.assertPublicSignupOtpRequestAllowed(options);
                return true;
            }
            throw new BadRequestException('Workspace is required');
        }
        let tenant: LoginTenantContext;
        try {
            tenant = await this.resolveLoginTenantContext(options.tenantSlug);
        } catch (err) {
            if (err instanceof UnauthorizedException) return false;
            throw err;
        }
        const user = await this.getTenantDb().withTenant(tenant.tenantId, (tx) => tx.user.findFirst({
            where: {
                tenantId: tenant.tenantId,
                email,
                deletedAt: null, suspendedAt: null,
            },
            select: {
                id: true,
                tenantId: true,
            },
        }));
        if (!user) return false;

        try {
            await this.assertTenantAllowsLoginMethod(user.tenantId, 'EMAIL_OTP');
        } catch (err) {
            if (err instanceof ForbiddenException) return false;
            throw err;
        }

        const access = await this.rbacService.getEffectiveAccess(user.id, user.tenantId);
        return access.permissions.includes('auth:login_email');
    }

    async createOnboardingSignupChallenge(
        emailRaw: string,
        options: EmailLoginOptions,
    ): Promise<{ challengeToken: string; code: string }> {
        const email = this.normalizeIdentifier(emailRaw);
        if (!this.isEmailIdentifier(email)) {
            throw new BadRequestException('Email is required');
        }
        const tenantName = this.normalizeProvisionedTenantName(options.provisionTenantName);
        this.assertPublicSignupLegalAssent(options);
        await this.assertPublicSignupOtpRequestAllowed(options);
        return this.getOnboardingSignup().createChallenge(email, tenantName);
    }

    async loginWithUsernamePassword(
        identifierRaw: unknown,
        passwordRaw: unknown,
        tenantSlugRaw?: string,
        audit: SessionRequestAudit = {},
        options: PasswordLoginOptions = {},
    ) {
        const username = this.normalizeIdentifier(identifierRaw);
        const password = typeof passwordRaw === 'string' ? passwordRaw : '';
        if (!username || !password || Buffer.byteLength(password, 'utf8') > MAX_BCRYPT_PASSWORD_BYTES) {
            this.verifyLegacyPassword('invalid-password', DUMMY_PASSWORD_HASH);
            throw new UnauthorizedException('Invalid username or password');
        }

        const tenant = await this.resolveLoginTenantContext(tenantSlugRaw);
        await this.assertTenantAllowsLoginMethod(tenant.tenantId, 'USERNAME_PASSWORD');
        const user = await this.getTenantDb().withTenant(tenant.tenantId, (tx) => tx.user.findFirst({
            where: { tenantId: tenant.tenantId, username, deletedAt: null, suspendedAt: null },
        }));
        const numericCredential = this.isPin(password);

        if (user && !user.passwordHash && user.pinHash && numericCredential) {
            this.verifyLegacyPassword(password, DUMMY_PASSWORD_HASH);
            return this.loginWithUsernamePin(username, password, tenant.tenantSlug, audit);
        }

        if (!user || !user.passwordHash) {
            this.verifyLegacyPassword(password, DUMMY_PASSWORD_HASH);
            if (numericCredential) this.verifyPin(password, DUMMY_PIN_HASH);
            throw new UnauthorizedException('Invalid username or password');
        }

        const passwordAttempt = await this.getTenantDb().withTenant(user.tenantId, async (tx) => {
            await tx.$queryRaw`
                SELECT "id"
                FROM "User"
                WHERE "id" = ${user.id} AND "tenantId" = ${user.tenantId}
                FOR UPDATE
            `;
            const lockedUser = await tx.user.findFirst({
                where: { id: user.id, tenantId: user.tenantId, deletedAt: null, suspendedAt: null },
            });

            if (!lockedUser?.passwordHash) {
                this.verifyLegacyPassword(password, DUMMY_PASSWORD_HASH);
                return { status: 'invalid' as const };
            }
            if (lockedUser.lockedUntil && lockedUser.lockedUntil > new Date()) {
                this.verifyLegacyPassword(password, DUMMY_PASSWORD_HASH);
                return { status: 'locked' as const };
            }
            if (!this.verifyLegacyPassword(password, lockedUser.passwordHash)) {
                const attempts = lockedUser.loginAttempts + 1;
                await tx.user.update({
                    where: { id: lockedUser.id },
                    data: {
                        loginAttempts: attempts,
                        lockedUntil: attempts >= 5
                            ? new Date(Date.now() + 15 * 60 * 1000)
                            : null,
                    },
                });
                return { status: 'invalid' as const };
            }

            if (lockedUser.loginAttempts > 0 || lockedUser.lockedUntil) {
                await tx.user.update({
                    where: { id: lockedUser.id },
                    data: {
                        loginAttempts: 0,
                        lockedUntil: null,
                    },
                });
            }
            return { status: 'authenticated' as const, user: lockedUser };
        });

        if (numericCredential) this.verifyPin(password, DUMMY_PIN_HASH);
        if (passwordAttempt.status !== 'authenticated') {
            throw new UnauthorizedException('Invalid username or password');
        }

        const authenticatedUser = passwordAttempt.user;
        const access = await this.rbacService.getEffectiveAccess(authenticatedUser.id, authenticatedUser.tenantId);
        if (!access.permissions.includes('auth:login_password')) {
            throw new UnauthorizedException('Invalid username or password');
        }
        const betaDemoMfaBypass = options.betaDemoMfaBypass === true
            && this.configService.get<string>('BETA_DEMO_MFA_BYPASS_ENABLED')?.trim().toLowerCase() === 'true'
            && tenant.tenantSlug === BETA_DEMO_TENANT_SLUG
            && username === BETA_DEMO_IDENTIFIER
            && authenticatedUser.email?.trim().toLowerCase() === BETA_DEMO_IDENTIFIER;

        return this.createSessionTokens({
            id: authenticatedUser.id,
            email: authenticatedUser.email,
            username: authenticatedUser.username,
            tenantId: authenticatedUser.tenantId,
            role: authenticatedUser.role,
            mfaEnabled: authenticatedUser.mfaEnabled,
        }, { loginMethod: 'USERNAME_PASSWORD', ...audit }, false, betaDemoMfaBypass ? 'BETA_DEMO' : null);
    }
    async createPasswordReset(identifierRaw: string, tenantSlugRaw?: string): Promise<null> {
        const resetOutbox = new PasswordResetOutboxService(this.configService);
        resetOutbox.validateConfiguration();

        const identifier = this.normalizeIdentifier(typeof identifierRaw === 'string' ? identifierRaw : '');
        if (!identifier) return null;

        let tenant: LoginTenantContext;
        try {
            tenant = await this.resolveLoginTenantContext(tenantSlugRaw);
        } catch (err) {
            if (err instanceof BadRequestException || err instanceof UnauthorizedException || err instanceof ForbiddenException) {
                return null;
            }
            throw err;
        }

        const user = await this.getTenantDb().withTenant(tenant.tenantId, (tx) => tx.user.findFirst({
            where: {
                tenantId: tenant.tenantId,
                deletedAt: null, suspendedAt: null,
                passwordHash: { not: null },
                OR: [
                    { username: identifier },
                    { email: identifier },
                ],
            },
            select: {
                id: true,
                tenantId: true,
                email: true,
            },
        }));

        if (!user?.email) return null;

        try {
            await this.assertTenantAllowsLoginMethod(user.tenantId, 'USERNAME_PASSWORD');
            const access = await this.rbacService.getEffectiveAccess(user.id, user.tenantId);
            if (!access.permissions.includes('auth:login_password')) {
                return null;
            }
        } catch (err) {
            if (err instanceof ForbiddenException) return null;
            throw err;
        }

        const resetToken = this.generatePasswordResetToken();
        const tokenHash = this.hashPasswordResetToken(resetToken);
        const expiresAt = new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MINUTES * 60 * 1000);
        const delivery = resetOutbox.createEncryptedEnvelope(user.email, resetToken, expiresAt);

        await this.getTenantDb().withTenant(user.tenantId, async (tx) => {
            await tx.passwordResetToken.updateMany({
                where: {
                    tenantId: user.tenantId,
                    userId: user.id,
                    consumedAt: null,
                },
                data: { consumedAt: new Date() },
            });
            await tx.passwordResetEmailOutbox.updateMany({
                where: {
                    tenantId: user.tenantId,
                    userId: user.id,
                    status: { in: ['PENDING', 'SENDING', 'FAILED'] },
                },
                data: {
                    status: 'DEAD_LETTERED',
                    deadLetteredAt: new Date(),
                    leaseUntil: null,
                    lastError: 'Superseded by a newer password reset request',
                },
            });
            await tx.passwordResetToken.create({
                data: {
                    tenantId: user.tenantId,
                    userId: user.id,
                    tokenHash,
                    expiresAt,
                },
            });
            await tx.passwordResetEmailOutbox.create({
                data: {
                    tenantId: user.tenantId,
                    userId: user.id,
                    tokenHash,
                    encryptedPayload: delivery.encryptedPayload,
                    encryptionKeyRef: delivery.encryptionKeyRef,
                    expiresAt,
                },
            });
        });

        return null;
    }

    async resetPasswordWithToken(
        tokenRaw: unknown,
        passwordRaw: unknown,
        requestAudit: SessionRequestAudit = {},
    ): Promise<void> {
        const token = this.normalizePasswordResetToken(tokenRaw);
        if (!token) {
            throw new UnauthorizedException('Invalid or expired reset token');
        }

        const tokenHash = this.hashPasswordResetToken(token);
        const password = this.validateNewPassword(passwordRaw);
        const now = new Date();
        const audit = this.securityRequestAudit(requestAudit);
        let revokedSessionIds: string[] = [];

        await this.getTenantDb().withPlatformAdmin(async (tx) => {
            const reset = await tx.passwordResetToken.findFirst({
                where: { tokenHash },
                include: { user: true },
            });

            if (!reset || reset.consumedAt || reset.expiresAt <= now || reset.user.deletedAt || reset.user.suspendedAt || !reset.user.passwordHash) {
                throw new UnauthorizedException('Invalid or expired reset token');
            }

            const tenant = await tx.tenant.findUnique({
                where: { id: reset.tenantId },
                select: { id: true, status: true, deletedAt: true },
            });
            this.assertTenantCanAuthenticate(tenant);

            const passwordHash = await this.hashNewPassword(password);

            const consumed = await tx.passwordResetToken.updateMany({
                where: {
                    id: reset.id,
                    consumedAt: null,
                    expiresAt: { gt: now },
                },
                data: { consumedAt: now },
            });
            if (consumed.count !== 1) {
                throw new UnauthorizedException('Invalid or expired reset token');
            }

            const activeSessions = await tx.session.findMany({
                where: {
                    userId: reset.userId,
                    revokedAt: null,
                },
                select: { id: true },
            });
            revokedSessionIds = activeSessions.map((session) => session.id);

            await tx.user.update({
                where: { id: reset.userId },
                data: {
                    passwordHash,
                    loginAttempts: 0,
                    lockedUntil: null,
                },
            });
            await tx.session.updateMany({
                where: {
                    userId: reset.userId,
                    revokedAt: null,
                },
                data: { revokedAt: now },
            });
            await tx.passwordResetToken.updateMany({
                where: {
                    userId: reset.userId,
                    consumedAt: null,
                },
                data: { consumedAt: now },
            });
            await tx.auditLog.create({
                data: {
                    tenantId: reset.tenantId,
                    userId: reset.userId,
                    actorUserId: reset.userId,
                    actorTenantId: reset.tenantId,
                    action: 'PASSWORD_RESET_COMPLETED',
                    resource: 'User',
                    resourceId: reset.userId,
                    newValue: { sessionsRevoked: activeSessions.length },
                    ipAddress: audit.ipAddress,
                    userAgent: audit.userAgent,
                },
            });
        });

        try {
            await Promise.all(revokedSessionIds.map((sessionId) => this.getRedis().del(KEY_SESSION_MFA(sessionId))));
        } catch (err) {
            this.logger.warn(operationalErrorLog('auth.password_reset_mfa_cleanup_failed', err));
        }
    }

    async handleOidcCallback(
        code: string,
        state: string,
        tenantSlugRaw?: string | null,
        audit: SessionRequestAudit = {},
    ) {
        const issuerUrl = this.normalizeOidcIssuer(this.configService.getOrThrow('OIDC_ISSUER_URL'));
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

        const userInfo = await this.fetchUserInfo(issuerUrl, tokenResponse.access_token) as OidcUserInfo;

        if (userInfo.email_verified !== true) {
            throw new UnauthorizedException('OIDC provider email is not verified');
        }
        const email = this.normalizeIdentifier(typeof userInfo.email === 'string' ? userInfo.email : '');
        if (!email || !this.isEmailIdentifier(email)) {
            throw new UnauthorizedException('OIDC provider did not return a valid email address');
        }
        const subject = this.normalizeOidcSubject(userInfo.sub);

        const tenant = await this.resolveLoginTenantContext(tenantSlugRaw);
        const user = await this.resolveAndBindOidcUser(tenant.tenantId, email, issuerUrl, subject);

        await this.assertTenantAllowsLoginMethod(user.tenantId, 'OIDC');

        const result = await this.createSessionTokens({
            id: user.id,
            email: user.email,
            username: user.username,
            tenantId: user.tenantId,
            role: user.role,
            mfaEnabled: user.mfaEnabled,
        }, { loginMethod: 'OIDC', ...audit });

        return {
            ...result,
        };
    }

    /**
     * Email OTP login — find or create user by email, issue session.
     * Used by the verify-otp endpoint after OTP is confirmed.
     */
    async loginWithEmail(emailRaw: string, options: EmailLoginOptions = {}, audit: SessionRequestAudit = {}) {
        const email = this.normalizeIdentifier(emailRaw);
        if (!this.isEmailIdentifier(email)) {
            throw new BadRequestException('Email is required');
        }
        const tenant = options.tenantSlug
            ? await this.resolveLoginTenantContext(options.tenantSlug)
            : null;
        if (!tenant && !options.allowProvision) {
            throw new BadRequestException('Workspace is required');
        }
        let workspaceSlug = tenant?.tenantSlug;
        let user: AuthenticatedUser | null = tenant
            ? await this.getTenantDb().withTenant(tenant.tenantId, (tx) => tx.user.findFirst({
                where: { tenantId: tenant.tenantId, email, deletedAt: null, suspendedAt: null },
            }))
            : null;

        if (!tenant) {
            const tenantName = this.normalizeProvisionedTenantName(options.provisionTenantName);
            this.assertPublicSignupAllowed(options.signupCode);
            this.assertPublicSignupLegalAssent(options);
            const challengeToken = options.onboardingChallengeToken?.trim();
            const otpCode = options.onboardingOtpCode?.trim();
            if (!challengeToken || !otpCode) {
                throw new BadRequestException('Onboarding challenge is required');
            }
            const claimed = await this.getOnboardingSignup().claimVerifiedOwner(
                email,
                tenantName,
                challengeToken,
                otpCode,
                audit,
                {
                    termsVersion: PUBLIC_LEGAL_MANIFEST.documents.terms.version,
                    privacyVersion: PUBLIC_LEGAL_MANIFEST.documents.privacy.version,
                },
            );
            this.assertTenantCanAuthenticate({
                id: claimed.user.tenantId,
                status: claimed.tenantStatus,
                deletedAt: claimed.tenantDeletedAt,
            });
            user = claimed.user;
            workspaceSlug = claimed.workspaceSlug;
        } else if (!user) {
            throw new UnauthorizedException('Invalid workspace or login');
        }
        if (user) {
            const access = await this.rbacService.getEffectiveAccess(user.id, user.tenantId);
            if (!access.permissions.includes('auth:login_email')) {
                throw new ForbiddenException('This account does not allow email login.');
            }
        }
        await this.assertTenantAllowsLoginMethod(user.tenantId, 'EMAIL_OTP');

        const session = await this.createSessionTokens({
            id: user.id,
            email: user.email,
            username: user.username,
            tenantId: user.tenantId,
            role: user.role,
            mfaEnabled: user.mfaEnabled,
        }, { loginMethod: 'EMAIL_OTP', ...audit });
        return { ...session, workspaceSlug };
    }

    async loginWithUsernamePin(
        identifierRaw: unknown,
        pinRaw: unknown,
        tenantSlugRaw?: string,
        audit: SessionRequestAudit = {},
    ) {
        const username = this.normalizeIdentifier(identifierRaw);
        const pin = typeof pinRaw === 'string' ? pinRaw : '';
        if (!username || !this.isPin(pin)) {
            this.verifyPin('invalid-pin', DUMMY_PIN_HASH);
            throw new UnauthorizedException('Invalid username or PIN');
        }

        const tenant = await this.resolveLoginTenantContext(tenantSlugRaw);
        await this.assertTenantAllowsLoginMethod(tenant.tenantId, 'USERNAME_PIN');
        const user = await this.getTenantDb().withTenant(tenant.tenantId, (tx) => tx.user.findFirst({
            where: { tenantId: tenant.tenantId, username, deletedAt: null, suspendedAt: null },
        }));

        if (!user || !user.pinHash) {
            this.verifyPin(pin, DUMMY_PIN_HASH);
            throw new UnauthorizedException('Invalid username or PIN');
        }

        const pinAttempt = await this.getTenantDb().withTenant(user.tenantId, async (tx) => {
            await tx.$queryRaw`
                SELECT "id"
                FROM "User"
                WHERE "id" = ${user.id} AND "tenantId" = ${user.tenantId}
                FOR UPDATE
            `;
            const lockedUser = await tx.user.findFirst({
                where: { id: user.id, tenantId: user.tenantId, deletedAt: null, suspendedAt: null },
            });

            if (!lockedUser?.pinHash) {
                this.verifyPin(pin, DUMMY_PIN_HASH);
                return { status: 'invalid' as const };
            }
            if (lockedUser.pinLockedUntil && lockedUser.pinLockedUntil > new Date()) {
                this.verifyPin(pin, DUMMY_PIN_HASH);
                return { status: 'locked' as const };
            }
            if (!this.verifyPin(pin, lockedUser.pinHash)) {
                const attempts = lockedUser.pinLoginAttempts + 1;
                await tx.user.update({
                    where: { id: lockedUser.id },
                    data: {
                        pinLoginAttempts: attempts,
                        pinLockedUntil: attempts >= 5
                            ? new Date(Date.now() + 15 * 60 * 1000)
                            : null,
                    },
                });
                return { status: 'invalid' as const };
            }

            if (lockedUser.pinLoginAttempts > 0 || lockedUser.pinLockedUntil) {
                await tx.user.update({
                    where: { id: lockedUser.id },
                    data: {
                        pinLoginAttempts: 0,
                        pinLockedUntil: null,
                    },
                });
            }
            return { status: 'authenticated' as const, user: lockedUser };
        });

        if (pinAttempt.status !== 'authenticated') {
            throw new UnauthorizedException('Invalid username or PIN');
        }

        const authenticatedUser = pinAttempt.user;
        const access = await this.rbacService.getEffectiveAccess(authenticatedUser.id, authenticatedUser.tenantId);
        if (!access.permissions.includes('auth:login_pin')) {
            throw new UnauthorizedException('Invalid username or PIN');
        }

        return this.createSessionTokens({
            id: authenticatedUser.id,
            email: authenticatedUser.email,
            username: authenticatedUser.username,
            tenantId: authenticatedUser.tenantId,
            role: authenticatedUser.role,
            mfaEnabled: authenticatedUser.mfaEnabled,
            pinResetRequired: authenticatedUser.pinResetRequired,
        }, { loginMethod: 'USERNAME_PIN', ...audit });
    }
    async resetUserPinAsAdmin(
        userId: string,
        pin: unknown,
        tenantId: string,
        actorUserId: string,
        actorSessionId: string,
        requestAudit: SessionRequestAudit = {},
    ): Promise<{ username: string }> {
        const normalizedPin = typeof pin === 'string' ? pin.trim() : pin;
        if (!this.isPin(normalizedPin)) {
            throw new BadRequestException('PIN must be 4-8 numeric digits');
        }
        const now = new Date();
        const data = this.buildPinCredentialData(normalizedPin, true, now);
        const audit = this.securityRequestAudit(requestAudit);
        const reset = await runSerializableMutationWithRetry(
            () => this.getTenantDb().withTenant(tenantId, async (tx) => {
                    let usernameBootstrapAttempted = false;
                    const user = await this.rbacService.authorizeUserAdministrationInTransaction(
                        tx,
                        tenantId,
                        {
                            actorUserId,
                            actorSessionId,
                            targetUserId: userId,
                            requiredPermission: 'users:admin',
                            selfMutationMessage: 'Use the self-service PIN rotation route for your own account',
                        },
                    );

                    let username = user.username;
                    if (!username) {
                        if (!this.canBootstrapPinUsername(user.email)) {
                            throw new BadRequestException('PIN reset is only available for username accounts');
                        }
                        usernameBootstrapAttempted = true;
                        username = await this.generateUniqueUsername(tx, tenantId, user.name);
                    }

                    const activeSessions = await tx.session.findMany({
                        where: { userId, revokedAt: null },
                        select: { id: true },
                    });
                    let updated: { count: number };
                    try {
                        updated = await tx.user.updateMany({
                            where: { id: userId, tenantId, deletedAt: null },
                            data: {
                                ...data,
                                username,
                            },
                        });
                    } catch (error) {
                        if (usernameBootstrapAttempted && isPrismaUniqueConstraintConflict(error)) {
                            throw new UsernameReservationConflict();
                        }
                        throw error;
                    }
                    if (updated.count !== 1) {
                        throw new UnauthorizedException('User account inactive');
                    }
                    const sessions = await tx.session.updateMany({
                        where: { userId, revokedAt: null },
                        data: { revokedAt: now },
                    });
                    await tx.auditLog.create({
                        data: {
                            tenantId,
                            userId: actorUserId,
                            actorUserId,
                            actorTenantId: tenantId,
                            action: 'USER_PIN_RESET',
                            resource: 'User',
                            resourceId: userId,
                            newValue: {
                                pinResetRequired: true,
                                sessionsRevoked: sessions.count,
                            },
                            ipAddress: audit.ipAddress,
                            userAgent: audit.userAgent,
                        },
                    });

                    return {
                        username,
                        revokedSessionIds: activeSessions.map((session) => session.id),
                    };
                }, { isolationLevel: 'Serializable' }),
            {
                isConflict: (error) => error instanceof UsernameReservationConflict
                    || isSerializableTransactionConflict(error),
                conflictMessage: (error) => error instanceof UsernameReservationConflict
                    ? 'Unable to reserve a unique username; retry the PIN reset'
                    : 'Authorization or PIN state changed concurrently; retry the request',
            },
        );

        await this.clearSessionMfaMarkersBestEffort(
            reset.revokedSessionIds,
            'auth.admin_pin_reset_mfa_cleanup_failed',
        );
        return { username: reset.username };
    }

    async rotateOwnPin(
        userId: string,
        currentPin: string,
        newPin: string,
        tenantId: string,
        actorSessionId: string,
        requestAudit: SessionRequestAudit = {},
    ): Promise<void> {
        if (!this.isPin(currentPin) || !this.isPin(newPin)) {
            throw new BadRequestException('PIN must be 4-8 numeric digits');
        }
        if (currentPin === newPin) {
            throw new BadRequestException('New PIN must differ from the temporary PIN');
        }

        const now = new Date();
        const data = this.buildPinCredentialData(newPin, false, now);
        const audit = this.securityRequestAudit(requestAudit);
        const revokedSessionIds = await runSerializableMutationWithRetry(
            () => this.getTenantDb().withTenant(tenantId, async (tx) => {
            await this.rbacService.authorizeSelfSecurityMutationInTransaction(tx, tenantId, {
                actorUserId: userId,
                actorSessionId,
                requiredPermission: 'auth:login_pin',
            });
            const user = await tx.user.findFirst({
                where: { id: userId, tenantId, deletedAt: null, suspendedAt: null },
                select: { id: true, username: true, pinHash: true },
            });
            if (!user || !user.username || !user.pinHash) {
                throw new ForbiddenException('PIN change is only available for username accounts');
            }
            if (!this.verifyPin(currentPin, user.pinHash)) {
                throw new UnauthorizedException('Current PIN is invalid');
            }

            const activeSessions = await tx.session.findMany({
                where: { userId, revokedAt: null },
                select: { id: true },
            });
            const updated = await tx.user.updateMany({
                where: { id: userId, tenantId, deletedAt: null, suspendedAt: null },
                data,
            });
            if (updated.count !== 1) {
                throw new UnauthorizedException('User account inactive');
            }
            const sessions = await tx.session.updateMany({
                where: { userId, revokedAt: null },
                data: { revokedAt: now },
            });
            await tx.auditLog.create({
                data: {
                    tenantId,
                    userId,
                    actorUserId: userId,
                    actorTenantId: tenantId,
                    action: 'USER_PIN_ROTATED',
                    resource: 'User',
                    resourceId: userId,
                    newValue: {
                        pinResetRequired: false,
                        sessionsRevoked: sessions.count,
                    },
                    ipAddress: audit.ipAddress,
                    userAgent: audit.userAgent,
                },
            });

            return activeSessions.map((session) => session.id);
            }, { isolationLevel: 'Serializable' }),
            { conflictMessage: 'Authorization or PIN state changed concurrently; retry the request' },
        );

        await this.clearSessionMfaMarkersBestEffort(
            revokedSessionIds,
            'auth.pin_rotation_mfa_cleanup_failed',
        );
    }

    private async prepareRefreshAuthorization(
        credential: RefreshCredential,
    ): Promise<RefreshAuthorizationContext | null> {
        const session = await this.getTenantDb().withPlatformAdmin((tx) => tx.session.findFirst({
            where: credential.kind === 'selected'
                ? { selectorHash: credential.selectorHash }
                : { refreshToken: { in: credential.candidates } },
            include: { user: true },
        }));
        if (!session) return null;

        const currentCredentialMatches = credential.kind === 'selected'
            ? session.refreshToken === credential.validatorHash
            : credential.candidates.includes(session.refreshToken);
        if (!currentCredentialMatches) return null;
        if (
            session.revokedAt
            || session.expiresAt <= new Date()
            || session.user.deletedAt
            || session.user.suspendedAt
        ) {
            throw new UnauthorizedException('Invalid or expired refresh token');
        }

        await this.assertTenantIdCanAuthenticate(session.user.tenantId);
        const settings = await this.getTenantSecuritySettings(session.user.tenantId);
        const effectiveExpiresAt = this.assertSessionActive(session, settings);
        const access = await this.rbacService.getEffectiveAccess(session.user.id, session.user.tenantId);
        const mfaRequired = this.isMfaRequired(session.user, settings, access);
        const mfaVerified = !mfaRequired || await this.isSessionMfaVerified(session.id);

        return {
            session,
            access,
            effectiveExpiresAt,
            mfaRequired,
            mfaVerified,
        };
    }

    private async rotateRefreshCredential(
        credential: RefreshCredential,
        rotatedCredential: SelectedRefreshCredential,
        allowRotation: boolean,
    ): Promise<RefreshRotationResult> {
        return this.getTenantDb().withPlatformAdmin(async (tx) => {
            let session: RefreshSession | null;
            let legacyReplayHash: string | null = null;

            if (credential.kind === 'selected') {
                await tx.$queryRaw`
                    SELECT "id"
                    FROM "Session"
                    WHERE "selectorHash" = ${credential.selectorHash}
                    FOR UPDATE
                `;
                session = await tx.session.findFirst({
                    where: { selectorHash: credential.selectorHash },
                    include: { user: true },
                });
            } else {
                legacyReplayHash = credential.candidates[0];
                const candidate = await tx.session.findFirst({
                    where: { refreshToken: { in: credential.candidates } },
                    select: { id: true },
                });
                const replay = candidate
                    ? null
                    : await tx.refreshTokenReplay.findUnique({
                        where: { validatorHash: legacyReplayHash },
                        select: { sessionId: true },
                    });
                const sessionId = candidate?.id ?? replay?.sessionId;
                if (!sessionId) return { status: 'invalid' };

                await tx.$queryRaw`
                    SELECT "id"
                    FROM "Session"
                    WHERE "id" = ${sessionId}
                    FOR UPDATE
                `;
                session = await tx.session.findFirst({
                    where: { id: sessionId },
                    include: { user: true },
                });
            }

            const now = new Date();
            if (!session || session.revokedAt || session.expiresAt <= now || session.user.deletedAt || session.user.suspendedAt) {
                return { status: 'invalid' };
            }

            const suppliedValidatorHash = credential.kind === 'selected'
                ? credential.validatorHash
                : legacyReplayHash;
            const currentCredentialMatches = credential.kind === 'selected'
                ? session.refreshToken === credential.validatorHash
                : credential.candidates.includes(session.refreshToken);

            if (!currentCredentialMatches) {
                const replay = suppliedValidatorHash
                    ? await tx.refreshTokenReplay.findUnique({
                        where: { validatorHash: suppliedValidatorHash },
                        select: { sessionId: true },
                    })
                    : null;
                if (replay?.sessionId !== session.id) {
                    return { status: 'invalid' };
                }

                await tx.session.updateMany({
                    where: { id: session.id, revokedAt: null },
                    data: { revokedAt: now },
                });
                return { status: 'replayed', sessionId: session.id };
            }

            if (!allowRotation) {
                return { status: 'invalid' };
            }

            await tx.refreshTokenReplay.create({
                data: {
                    sessionId: session.id,
                    validatorHash: credential.kind === 'selected'
                        ? credential.validatorHash
                        : this.canonicalRefreshTokenHash(session.refreshToken),
                },
            });

            const rotated = await tx.session.updateMany({
                where: {
                    id: session.id,
                    ...(credential.kind === 'selected'
                        ? {
                            selectorHash: credential.selectorHash,
                            refreshToken: credential.validatorHash,
                        }
                        : { refreshToken: { in: credential.candidates } }),
                    revokedAt: null,
                    expiresAt: { gt: now },
                },
                data: credential.kind === 'selected'
                    ? { refreshToken: rotatedCredential.validatorHash }
                    : {
                        selectorHash: rotatedCredential.selectorHash,
                        refreshToken: rotatedCredential.validatorHash,
                    },
            });
            if (rotated.count !== 1) {
                throw new UnauthorizedException('Invalid or expired refresh token');
            }

            return { status: 'rotated', session };
        });
    }
    async refreshAccessToken(refreshTokenRaw: unknown) {
        const credential = this.parseRefreshCredential(refreshTokenRaw);
        if (!credential) {
            throw new UnauthorizedException('Invalid or expired refresh token');
        }

        const authorization = await this.prepareRefreshAuthorization(credential);
        const rotatedCredential = this.generateSelectedRefreshCredential();
        const rotation = await this.rotateRefreshCredential(credential, rotatedCredential, Boolean(authorization));
        if (rotation.status === 'replayed') {
            await this.getRedis().del(KEY_SESSION_MFA(rotation.sessionId));
            throw new UnauthorizedException('Invalid or expired refresh token');
        }
        if (rotation.status === 'invalid') {
            throw new UnauthorizedException('Invalid or expired refresh token');
        }
        if (!authorization) {
            throw new UnauthorizedException('Invalid or expired refresh token');
        }

        const { session } = rotation;
        const { access, effectiveExpiresAt, mfaRequired, mfaVerified } = authorization;
        const payload: TokenPayload = {
            sub: session.user.id,
            tenantId: session.user.tenantId,
            role: access.primaryRole,
            legacyRole: session.user.role,
            sessionId: session.id,
            mfaVerified,
            pinResetRequired: session.user.pinResetRequired === true,
        };

        const refreshToken = credential.kind === 'selected'
            ? `${SELECTED_REFRESH_TOKEN_VERSION}.${credential.selector}.${rotatedCredential.validator}`
            : rotatedCredential.token;

        return {
            accessToken: this.jwtService.generateAccessToken(payload),
            refreshToken,
            csrfToken: this.jwtService.generateCsrfToken(),
            mfaVerified,
            requiresMfa: mfaRequired,
            pinResetRequired: session.user.pinResetRequired === true,
            accessTokenMaxAgeMs: this.getAccessTokenMaxAgeMs(effectiveExpiresAt),
            sessionMaxAgeMs: Math.max(0, effectiveExpiresAt.getTime() - Date.now()),
        };
    }
    async validateAccessSession(claims: TokenPayload) {
        const session = await this.getTenantDb().withTenant(claims.tenantId, (tx) => tx.session.findFirst({
            where: {
                id: claims.sessionId,
                userId: claims.sub,
            },
            include: {
                user: true,
            },
        }));

        if (!session || session.user.deletedAt || session.user.suspendedAt || session.user.tenantId !== claims.tenantId) {
            throw new UnauthorizedException('Invalid or expired session');
        }

        await this.assertTenantIdCanAuthenticate(claims.tenantId);
        const settings = await this.getTenantSecuritySettings(session.user.tenantId);
        this.assertSessionActive(session, settings);
        const access = await this.rbacService.getEffectiveAccess(session.user.id, session.user.tenantId);
        const mfaRequired = this.isMfaRequired(session.user, settings, access);
        const mfaVerified = !mfaRequired || await this.isSessionMfaVerified(session.id);
        const finalSession = await this.getTenantDb().withTenant(claims.tenantId, (tx) => tx.session.findFirst({
            where: {
                id: claims.sessionId,
                userId: claims.sub,
            },
            include: {
                user: true,
            },
        }));
        if (
            !finalSession
            || finalSession.user.deletedAt
            || finalSession.user.suspendedAt
            || finalSession.user.tenantId !== claims.tenantId
        ) {
            throw new UnauthorizedException('Invalid or expired session');
        }
        const finalEffectiveExpiresAt = this.assertSessionActive(finalSession, settings);

        return {
            access,
            mfaRequired,
            mfaVerified,
            pinResetRequired: finalSession.user.pinResetRequired === true,
            accessTokenMaxAgeMs: this.getAccessTokenMaxAgeMs(finalEffectiveExpiresAt),
            legacyRole: finalSession.user.role,
        };
    }

    private async isSessionMfaVerified(sessionId: string): Promise<boolean> {
        const value = await this.getRedis().get(KEY_SESSION_MFA(sessionId));
        return value === '1';
    }

    private async markSessionMfaVerified(sessionId: string, expiresAt: Date): Promise<void> {
        const ttlSeconds = Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
        await this.getRedis().set(KEY_SESSION_MFA(sessionId), '1', 'EX', ttlSeconds);
    }

    private decodeBase32Secret(secret: string): Buffer | null {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        const normalized = secret.toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
        if (!normalized || !/^[A-Z2-7]+$/.test(normalized)) return null;

        let bits = 0;
        let value = 0;
        const output: number[] = [];
        for (const char of normalized) {
            const index = alphabet.indexOf(char);
            if (index === -1) return null;
            value = (value << 5) | index;
            bits += 5;
            if (bits >= 8) {
                output.push((value >>> (bits - 8)) & 0xff);
                bits -= 8;
            }
        }
        return Buffer.from(output);
    }

    private secretToBuffer(secret: string): Buffer | null {
        const trimmed = this.decryptMfaSecret(secret)?.trim() ?? '';
        if (!trimmed) return null;

        const base32 = this.decodeBase32Secret(trimmed);
        if (base32?.length) return base32;

        if (/^[a-f0-9]+$/i.test(trimmed) && trimmed.length % 2 === 0) {
            return Buffer.from(trimmed, 'hex');
        }

        try {
            const base64 = Buffer.from(trimmed, 'base64');
            if (base64.length > 0 && base64.toString('base64').replace(/=+$/g, '') === trimmed.replace(/=+$/g, '')) {
                return base64;
            }
        } catch {
            // Fall through to UTF-8.
        }

        return Buffer.from(trimmed, 'utf8');
    }

    private mfaEncryptionKeyRef(key: Buffer): string {
        return crypto.createHash('sha256').update(key.toString('base64')).digest('hex').slice(0, 16);
    }

    private decodeMfaManagedKey(configured: string, envName: string): MfaManagedKey {
        const normalized = configured.replace(/-/g, '+').replace(/_/g, '/');
        const value = /^[a-f0-9]{64}$/i.test(configured)
            ? Buffer.from(configured, 'hex')
            : Buffer.from(normalized, 'base64');
        if (value.length !== 32) {
            throw new ServiceUnavailableException(`${envName} must decode to 32 bytes`);
        }
        return { value, ref: this.mfaEncryptionKeyRef(value), legacy: false };
    }

    private getMfaEncryptionKeys(): { current: MfaManagedKey | null; keys: MfaManagedKey[] } {
        const currentValue = this.configService.get<string>(MFA_ENCRYPTION_CURRENT_KEY_ENV)?.trim();
        const previousValue = this.configService.get<string>(MFA_ENCRYPTION_PREVIOUS_KEY_ENV)?.trim();
        const legacyValue = this.configService.get<string>(MFA_ENCRYPTION_LEGACY_KEY_ENV)?.trim();
        const current = currentValue
            ? this.decodeMfaManagedKey(currentValue, MFA_ENCRYPTION_CURRENT_KEY_ENV)
            : legacyValue
                ? (() => {
                    const value = crypto.createHash('sha256').update(legacyValue).digest();
                    return { value, ref: this.mfaEncryptionKeyRef(value), legacy: true };
                })()
                : null;
        const keys = current ? [current] : [];
        if (previousValue) {
            const previous = this.decodeMfaManagedKey(previousValue, MFA_ENCRYPTION_PREVIOUS_KEY_ENV);
            if (previous.ref === current?.ref) {
                throw new ServiceUnavailableException('MFA current and previous encryption keys must differ');
            }
            keys.push(previous);
        }
        if (legacyValue && !current?.legacy) {
            const value = crypto.createHash('sha256').update(legacyValue).digest();
            const legacy = { value, ref: this.mfaEncryptionKeyRef(value), legacy: true };
            if (!keys.some((key) => key.ref === legacy.ref)) keys.push(legacy);
        }
        return { current, keys };
    }

    private encryptMfaSecret(secret: string): string {
        const { current } = this.getMfaEncryptionKeys();
        if (!current) {
            if (process.env.NODE_ENV === 'production') {
                this.logger.error('MFA_SECRET_ENCRYPTION_KEY_CURRENT is required before storing MFA secrets in production.');
                throw new ServiceUnavailableException('MFA enrollment is not configured.');
            }
            return secret;
        }

        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', current.value, iv);
        const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
        if (!current.legacy) {
            return [
                CURRENT_ENCRYPTED_MFA_SECRET_PREFIX.replace(/:$/, ''),
                current.ref,
                iv.toString('base64url'),
                cipher.getAuthTag().toString('base64url'),
                ciphertext.toString('base64url'),
            ].join(':');
        }
        const tag = cipher.getAuthTag();
        return [
            ENCRYPTED_MFA_SECRET_PREFIX.replace(/:$/, ''),
            iv.toString('base64url'),
            tag.toString('base64url'),
            ciphertext.toString('base64url'),
        ].join(':');
    }

    private decryptMfaSecret(storedSecret: string): string | null {
        const trimmed = storedSecret.trim();
        if (!trimmed.startsWith('enc:')) {
            return trimmed;
        }

        const parts = trimmed.split(':');
        const isCurrent = trimmed.startsWith(CURRENT_ENCRYPTED_MFA_SECRET_PREFIX);
        const isLegacy = trimmed.startsWith(ENCRYPTED_MFA_SECRET_PREFIX);
        if ((!isCurrent && !isLegacy) || (isCurrent && parts.length !== 6) || (isLegacy && parts.length !== 5)) return null;
        const keyRef = isCurrent ? parts[2] : null;
        const [ivRaw, tagRaw, ciphertextRaw] = isCurrent ? parts.slice(3) : parts.slice(2);
        if (!ivRaw || !tagRaw || !ciphertextRaw) return null;

        const { keys } = this.getMfaEncryptionKeys();
        const candidates = isCurrent ? keys.filter((key) => key.ref === keyRef) : keys;
        for (const key of candidates) {
            try {
                const decipher = crypto.createDecipheriv('aes-256-gcm', key.value, Buffer.from(ivRaw, 'base64url'));
                decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
                return Buffer.concat([
                    decipher.update(Buffer.from(ciphertextRaw, 'base64url')),
                    decipher.final(),
                ]).toString('utf8');
            } catch {
                // Legacy v1 envelopes have no key reference, so overlap reads try every configured key.
            }
        }
        return null;
    }

    private generateTotpCode(secret: Buffer, timeStep: number): string {
        const counter = Buffer.alloc(8);
        counter.writeUInt32BE(Math.floor(timeStep / 0x100000000), 0);
        counter.writeUInt32BE(timeStep >>> 0, 4);

        const digest = crypto.createHmac('sha1', secret).update(counter).digest();
        const offset = digest[digest.length - 1] & 0x0f;
        const binary = ((digest[offset] & 0x7f) << 24)
            | ((digest[offset + 1] & 0xff) << 16)
            | ((digest[offset + 2] & 0xff) << 8)
            | (digest[offset + 3] & 0xff);

        return (binary % 1_000_000).toString().padStart(6, '0');
    }

    private findMatchingTotpTimeStep(secret: string, code: string): number | null {
        if (!/^\d{6}$/.test(code)) return null;
        const secretBuffer = this.secretToBuffer(secret);
        if (!secretBuffer?.length) return null;

        const currentStep = Math.floor(Date.now() / 30_000);
        for (const skew of [-1, 0, 1]) {
            const timeStep = currentStep + skew;
            if (this.safeEqual(this.generateTotpCode(secretBuffer, timeStep), code)) {
                return timeStep;
            }
        }
        return null;
    }

    private verifyTotpCode(secret: string, code: string): boolean {
        return this.findMatchingTotpTimeStep(secret, code) !== null;
    }

    private async claimTotpTimeStep(
        tx: TenantPrismaTransaction,
        tenantId: string,
        userId: string,
        timeStep: number,
    ): Promise<void> {
        try {
            await tx.mfaTotpClaim.create({
                data: {
                    tenantId,
                    userId,
                    timeStep: BigInt(timeStep),
                },
            });
        } catch (error) {
            if ((error as { code?: string })?.code === 'P2002') {
                throw new ForbiddenException('Invalid MFA code');
            }
            throw error;
        }
    }

    private safeEqual(expected: string, actual: string): boolean {
        const expectedBuffer = Buffer.from(expected);
        const actualBuffer = Buffer.from(actual);
        return expectedBuffer.length === actualBuffer.length
            && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
    }

    private verifyScryptHash(value: string, storedHash: string): boolean {
        const [salt, hash] = storedHash.split(':');
        if (!salt || !hash) return false;
        const computed = crypto.scryptSync(value, salt, 64).toString('hex');
        return this.safeEqual(hash, computed);
    }

    private findMatchingBackupCodeHash(code: string, backupCodeHashes: string[]): string | null {
        for (const hash of backupCodeHashes) {
            if (hash.startsWith('$2') && bcrypt.compareSync(code, hash)) {
                return hash;
            }
            if (/^[a-f0-9]+:[a-f0-9]+$/i.test(hash) && this.verifyScryptHash(code, hash)) {
                return hash;
            }
        }
        return null;
    }

    async getSessionUserContext(userId: string, tenantId: string, sessionClaims: {
        role: string;
        sessionId: string;
        mfaVerified?: boolean;
        mfaRequired?: boolean;
        pinResetRequired?: boolean;
    }) {
        const user = await this.getTenantDb().withTenant(tenantId, (tx) => tx.user.findFirst({
            where: {
                id: userId,
                tenantId,
                deletedAt: null, suspendedAt: null,
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
                        status: true,
                        deletedAt: true,
                    },
                },
            },
        }));

        if (!user) {
            throw new UnauthorizedException('User not found');
        }
        this.assertTenantCanAuthenticate({
            id: user.tenantId,
            status: user.tenant.status,
            deletedAt: user.tenant.deletedAt,
        });

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
            mfaVerified: sessionClaims.mfaVerified === true,
            mfaRequired: sessionClaims.mfaRequired === true,
            pinResetRequired: sessionClaims.pinResetRequired === true,
        };
    }

    async getMfaEnrollmentState(
        userId: string,
        sessionClaims: { tenantId: string; sessionId: string },
    ) {
        const { user } = await this.loadMfaSessionContext(userId, sessionClaims);
        return {
            enabled: user.mfaEnabled === true,
            recoveryCodesRemaining: user.mfaBackupCodes.length,
        };
    }

    private async loadMfaSessionContext(
        userId: string,
        sessionClaims: { tenantId: string; sessionId: string },
    ): Promise<MfaSessionContext> {
        const { user, session } = await this.getTenantDb().withTenant(sessionClaims.tenantId, async (tx) => {
            const user = await tx.user.findFirst({
                where: {
                    id: userId,
                    tenantId: sessionClaims.tenantId,
                    deletedAt: null, suspendedAt: null,
                },
                select: {
                    id: true,
                    tenantId: true,
                    role: true,
                    email: true,
                    username: true,
                    pinResetRequired: true,
                    mfaEnabled: true,
                    mfaSecret: true,
                    mfaBackupCodes: true,
                },
            });
            const session = user
                ? await tx.session.findFirst({
                    where: {
                        id: sessionClaims.sessionId,
                        userId,
                    },
                })
                : null;
            return { user, session };
        });
        if (!user) {
            throw new UnauthorizedException('User not found');
        }
        if (!session) {
            throw new UnauthorizedException('Invalid or expired session');
        }
        if (user.pinResetRequired) {
            throw new ForbiddenException('PIN rotation required before MFA access');
        }
        await this.assertTenantIdCanAuthenticate(user.tenantId);

        const settings = await this.getTenantSecuritySettings(user.tenantId);
        const effectiveExpiresAt = this.assertSessionActive(session, settings);

        return {
            user: {
                ...user,
                mfaBackupCodes: user.mfaBackupCodes ?? [],
            },
            session,
            settings,
            effectiveExpiresAt,
        };
    }

    async beginMfaEnrollment(
        userId: string,
        sessionClaims: { tenantId: string; sessionId: string },
    ) {
        const { user } = await this.loadMfaSessionContext(userId, sessionClaims);
        if (user.mfaEnabled && user.mfaSecret) {
            throw new BadRequestException('MFA is already enabled');
        }

        const secret = this.generateBase32Secret();
        await this.getRedis().set(
            KEY_PENDING_MFA_ENROLLMENT(sessionClaims.sessionId, user.id),
            secret,
            'EX',
            MFA_ENROLLMENT_TTL_SECONDS,
        );

        return {
            secret,
            otpauthUrl: this.buildOtpAuthUrl(secret, user),
            expiresInSeconds: MFA_ENROLLMENT_TTL_SECONDS,
        };
    }

    async confirmMfaEnrollment(
        userId: string,
        code: string,
        sessionClaims: { tenantId: string; sessionId: string },
        requestAudit: SessionRequestAudit = {},
    ) {
        const { user, session } = await this.loadMfaSessionContext(userId, sessionClaims);
        const key = KEY_PENDING_MFA_ENROLLMENT(session.id, user.id);
        const secret = await this.getRedis().get(key);
        if (!secret) {
            throw new BadRequestException('MFA enrollment has expired');
        }

        const normalizedCode = typeof code === 'string' ? code.trim().replace(/\s+/g, '') : '';
        const matchedTotpTimeStep = this.findMatchingTotpTimeStep(secret, normalizedCode);
        if (matchedTotpTimeStep === null) {
            throw new ForbiddenException('Invalid MFA code');
        }

        const backupCodes = this.generateBackupCodes();
        const audit = this.securityRequestAudit(requestAudit);
        const committed = await runSerializableMutationWithRetry(
            () => this.getTenantDb().withTenant(user.tenantId, async (tx) => {
            const access = await this.rbacService.authorizeSelfSecurityMutationInTransaction(
                tx,
                user.tenantId,
                { actorUserId: user.id, actorSessionId: session.id },
            );
            const currentUser = await tx.user.findFirst({
                where: { id: user.id, tenantId: user.tenantId, deletedAt: null, suspendedAt: null },
                select: {
                    id: true,
                    tenantId: true,
                    role: true,
                    email: true,
                    username: true,
                    pinResetRequired: true,
                    mfaEnabled: true,
                },
            });
            if (!currentUser) throw new UnauthorizedException('User not found');
            if (currentUser.pinResetRequired) {
                throw new ForbiddenException('PIN rotation required before MFA access');
            }
            if (currentUser.mfaEnabled) throw new BadRequestException('MFA is already enabled');
            const currentSession = await tx.session.findFirst({
                where: { id: session.id, userId: currentUser.id },
            });
            if (!currentSession) throw new UnauthorizedException('Invalid or expired session');
            const settings = await this.tenantSecuritySettingsInTransaction(tx, currentUser.tenantId);
            const effectiveExpiresAt = this.assertSessionActive(currentSession, settings);

            await this.claimTotpTimeStep(tx, user.tenantId, user.id, matchedTotpTimeStep);
            await tx.user.update({
                where: { id: user.id },
                data: {
                    mfaEnabled: true,
                    mfaSecret: this.encryptMfaSecret(secret),
                    mfaBackupCodes: backupCodes.map((backupCode) => this.hashBackupCode(backupCode)),
                },
            });
            await tx.auditLog.create({
                data: {
                    tenantId: user.tenantId,
                    userId: user.id,
                    actorUserId: user.id,
                    actorTenantId: user.tenantId,
                    action: 'MFA_ENABLED',
                    resource: 'User',
                    resourceId: user.id,
                    newValue: { mfaEnabled: true },
                    ipAddress: audit.ipAddress,
                    userAgent: audit.userAgent,
                },
            });
            const payload: TokenPayload = {
                sub: user.id,
                tenantId: user.tenantId,
                role: access.primaryRole,
                legacyRole: currentUser.role,
                sessionId: session.id,
                mfaVerified: true,
                pinResetRequired: false,
            };
            return {
                effectiveExpiresAt,
                accessToken: this.jwtService.generateAccessToken(payload),
                accessTokenMaxAgeMs: this.getAccessTokenMaxAgeMs(effectiveExpiresAt),
            };
            }, { isolationLevel: 'Serializable' }),
            { conflictMessage: 'Authorization or MFA state changed concurrently; retry the request' },
        );
        await Promise.all([
            this.runRedisMutationBestEffort(
                'auth.mfa_enrollment_cleanup_failed',
                () => this.getRedis().del(key),
            ),
            this.runRedisMutationBestEffort(
                'auth.mfa_enrollment_session_marker_failed',
                () => this.markSessionMfaVerified(session.id, committed.effectiveExpiresAt),
            ),
        ]);

        return {
            success: true,
            mfaVerified: true,
            backupCodes,
            accessToken: committed.accessToken,
            accessTokenMaxAgeMs: committed.accessTokenMaxAgeMs,
        };
    }

    async disableMfa(
        userId: string,
        code: string,
        sessionClaims: { tenantId: string; sessionId: string },
        requestAudit: SessionRequestAudit = {},
    ) {
        const { user, session } = await this.loadMfaSessionContext(userId, sessionClaims);

        const normalizedCode = typeof code === 'string' ? code.trim().replace(/\s+/g, '') : '';
        const audit = this.securityRequestAudit(requestAudit);
        const revokedSessionIds = await runSerializableMutationWithRetry(
            () => this.getTenantDb().withTenant(user.tenantId, async (tx) => {
            const access = await this.rbacService.authorizeSelfSecurityMutationInTransaction(
                tx,
                user.tenantId,
                { actorUserId: user.id, actorSessionId: session.id },
            );
            const currentUser = await tx.user.findFirst({
                where: { id: user.id, tenantId: user.tenantId, deletedAt: null, suspendedAt: null },
                select: {
                    id: true,
                    mfaEnabled: true,
                    mfaSecret: true,
                    mfaBackupCodes: true,
                },
            });
            if (!currentUser) throw new UnauthorizedException('User not found');
            const currentSession = await tx.session.findFirst({
                where: { id: session.id, userId: currentUser.id },
            });
            if (!currentSession) throw new UnauthorizedException('Invalid or expired session');
            const settings = await this.tenantSecuritySettingsInTransaction(tx, user.tenantId);
            this.assertSessionActive(currentSession, settings);
            if (this.isPrivilegedMfaRequiredForAccess(access)) {
                throw new ForbiddenException('MFA is required for administrative access');
            }
            if (settings.requireMfaForAll) {
                throw new ForbiddenException('MFA is required by workspace policy');
            }
            if (currentUser.mfaEnabled) {
                const matchedTotpTimeStep = currentUser.mfaSecret
                    ? this.findMatchingTotpTimeStep(currentUser.mfaSecret, normalizedCode)
                    : null;
                const matchingBackupCodeHash = this.findMatchingBackupCodeHash(
                    normalizedCode,
                    currentUser.mfaBackupCodes ?? [],
                );
                if (matchedTotpTimeStep === null && !matchingBackupCodeHash) {
                    throw new ForbiddenException('Invalid MFA code');
                }
                if (matchedTotpTimeStep !== null) {
                    await this.claimTotpTimeStep(tx, user.tenantId, user.id, matchedTotpTimeStep);
                }

                const activeSessions = await tx.session.findMany({
                    where: { userId: user.id, revokedAt: null },
                    select: { id: true },
                });

                await tx.user.update({
                    where: { id: user.id },
                    data: {
                        mfaEnabled: false,
                        mfaSecret: null,
                        mfaBackupCodes: [],
                    },
                });
                const sessions = await tx.session.updateMany({
                    where: { userId: user.id, revokedAt: null },
                    data: { revokedAt: new Date() },
                });
                await tx.auditLog.create({
                    data: {
                        tenantId: user.tenantId,
                        userId: user.id,
                        actorUserId: user.id,
                        actorTenantId: user.tenantId,
                        action: 'MFA_DISABLED',
                        resource: 'User',
                        resourceId: user.id,
                        newValue: {
                            mfaEnabled: false,
                            sessionsRevoked: sessions.count,
                        },
                        ipAddress: audit.ipAddress,
                        userAgent: audit.userAgent,
                    },
                });

                return activeSessions.map((session) => session.id);
            }

            return [];
            }, { isolationLevel: 'Serializable' }),
            { conflictMessage: 'Authorization or MFA state changed concurrently; retry the request' },
        );
        await this.clearSessionMfaMarkersBestEffort(
            revokedSessionIds,
            'auth.mfa_disable_marker_cleanup_failed',
        );

        return { success: true, mfaEnabled: false };
    }

    async validateMfa(
        userId: string,
        code: string,
        sessionClaims: { tenantId: string; sessionId: string },
    ) {
        await this.assertTenantIdCanAuthenticate(sessionClaims.tenantId);
        const settings = await this.getTenantSecuritySettings(sessionClaims.tenantId);
        const access = await this.rbacService.getEffectiveAccess(userId, sessionClaims.tenantId);
        const normalizedCode = typeof code === 'string' ? code.trim().replace(/\s+/g, '') : '';

        const verification = await this.getTenantDb().withTenant(sessionClaims.tenantId, async (tx) => {
            await tx.$queryRaw`
                SELECT "id"
                FROM "User"
                WHERE "id" = ${userId} AND "tenantId" = ${sessionClaims.tenantId}
                FOR UPDATE
            `;
            const user = await tx.user.findFirst({
                where: {
                    id: userId,
                    tenantId: sessionClaims.tenantId,
                    deletedAt: null, suspendedAt: null,
                },
                select: {
                    id: true,
                    tenantId: true,
                    role: true,
                    mfaEnabled: true,
                    mfaSecret: true,
                    mfaBackupCodes: true,
                },
            });
            const session = user
                ? await tx.session.findFirst({
                    where: {
                        id: sessionClaims.sessionId,
                        userId,
                    },
                })
                : null;
            if (!user) throw new UnauthorizedException('User not found');
            if (!session) throw new UnauthorizedException('Invalid or expired session');

            const effectiveExpiresAt = this.assertSessionActive(session, settings);
            if (!this.isMfaRequired(user, settings, access)) {
                return { user, session, effectiveExpiresAt, verificationRequired: false };
            }

            const matchedTotpTimeStep = user.mfaSecret
                ? this.findMatchingTotpTimeStep(user.mfaSecret, normalizedCode)
                : null;
            const matchingBackupCodeHash = this.findMatchingBackupCodeHash(
                normalizedCode,
                user.mfaBackupCodes ?? [],
            );
            if (matchedTotpTimeStep === null && !matchingBackupCodeHash) {
                throw new ForbiddenException('Invalid MFA code');
            }
            if (matchedTotpTimeStep !== null) {
                await this.claimTotpTimeStep(
                    tx,
                    sessionClaims.tenantId,
                    user.id,
                    matchedTotpTimeStep,
                );
            }
            if (matchingBackupCodeHash) {
                await tx.user.update({
                    where: { id: user.id },
                    data: {
                        mfaBackupCodes: (user.mfaBackupCodes ?? []).filter((hash) => hash !== matchingBackupCodeHash),
                    },
                });
            }
            return { user, session, effectiveExpiresAt, verificationRequired: true };
        });

        if (!verification.verificationRequired) return { success: true, mfaVerified: true };

        await this.markSessionMfaVerified(verification.session.id, verification.effectiveExpiresAt);
        const payload: TokenPayload = {
            sub: verification.user.id,
            tenantId: verification.user.tenantId,
            role: access.primaryRole,
            legacyRole: verification.user.role,
            sessionId: verification.session.id,
            mfaVerified: true,
            pinResetRequired: false,
        };

        return {
            success: true,
            mfaVerified: true,
            accessToken: this.jwtService.generateAccessToken(payload),
            accessTokenMaxAgeMs: this.getAccessTokenMaxAgeMs(verification.effectiveExpiresAt),
        };
    }

    async checkAccountLockout(user?: { lockedUntil?: Date | null } | null): Promise<void> {
        if (user?.lockedUntil && user.lockedUntil > new Date()) {
            throw new ForbiddenException('Account locked due to too many failed attempts');
        }
    }

    async recordFailedAttempt(userId: string): Promise<void> {
        const user = await this.getTenantDb().withPlatformAdmin((tx) => tx.user.findUnique({ where: { id: userId } }));
        if (user) {
            await this.getTenantDb().withTenant(user.tenantId, async (tx) => {
                await tx.$queryRaw`
                    SELECT "id"
                    FROM "User"
                    WHERE "id" = ${user.id} AND "tenantId" = ${user.tenantId}
                    FOR UPDATE
                `;
                const lockedUser = await tx.user.findFirst({
                    where: { id: user.id, tenantId: user.tenantId, deletedAt: null, suspendedAt: null },
                    select: { id: true, loginAttempts: true, lockedUntil: true },
                });
                if (!lockedUser || (lockedUser.lockedUntil && lockedUser.lockedUntil > new Date())) return;

                const newAttempts = lockedUser.loginAttempts + 1;
                await tx.user.update({
                    where: { id: lockedUser.id },
                    data: {
                        loginAttempts: newAttempts,
                        lockedUntil: newAttempts >= 5
                            ? new Date(Date.now() + 15 * 60 * 1000)
                            : null,
                    },
                });
            });
        }
    }

    async revokeSession(sessionId: string): Promise<void> {
        await this.getTenantDb().withPlatformAdmin((tx) => tx.session.updateMany({
            where: { id: sessionId },
            data: { revokedAt: new Date() },
        }));
        await this.getRedis().del(KEY_SESSION_MFA(sessionId));
    }

    async revokeSessionByRefreshToken(
        refreshTokenRaw: unknown,
    ): Promise<{ status: 'revoked' | 'already_invalid' }> {
        const credential = this.parseRefreshCredential(refreshTokenRaw);
        if (!credential) return { status: 'already_invalid' };

        const session = await this.getTenantDb().withPlatformAdmin((tx) => tx.session.findFirst({
            where: credential.kind === 'selected'
                ? { selectorHash: credential.selectorHash }
                : { refreshToken: { in: credential.candidates } },
            select: { id: true, revokedAt: true, expiresAt: true },
        }));
        if (!session) return { status: 'already_invalid' };

        if (session.revokedAt || session.expiresAt <= new Date()) {
            await this.getRedis().del(KEY_SESSION_MFA(session.id));
            return { status: 'already_invalid' };
        }

        const revoked = await this.getTenantDb().withPlatformAdmin((tx) => tx.session.updateMany({
            where: {
                id: session.id,
                ...(credential.kind === 'selected'
                    ? { selectorHash: credential.selectorHash }
                    : {}),
                revokedAt: null,
                expiresAt: { gt: new Date() },
            },
            data: { revokedAt: new Date() },
        }));
        await this.getRedis().del(KEY_SESSION_MFA(session.id));

        return { status: revoked.count === 1 ? 'revoked' : 'already_invalid' };
    }
    private async requestAuthProvider(url: string, options: SecureRequestOptions): Promise<Response> {
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_resolve, reject) => {
            deadlineTimer = setTimeout(
                () => reject(new Error('Auth provider request deadline exceeded')),
                AUTH_PROVIDER_REQUEST_TIMEOUT_MS,
            );
        });

        try {
            return await Promise.race([
                secureHttpRequest(url, {
                    ...options,
                    timeoutMs: AUTH_PROVIDER_REQUEST_TIMEOUT_MS,
                }),
                deadline,
            ]);
        } finally {
            if (deadlineTimer) clearTimeout(deadlineTimer);
        }
    }

    private async readProviderJsonObject(response: Response): Promise<Record<string, unknown>> {
        const payload: unknown = await response.json();
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            throw new Error('Provider returned an invalid JSON object');
        }
        return payload as Record<string, unknown>;
    }

    private async exchangeCode(endpoint: string, params: Record<string, string>): Promise<{ access_token: string }> {
        const body = new URLSearchParams(params).toString();
        try {
            const response = await this.requestAuthProvider(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body,
                timeoutMs: AUTH_PROVIDER_REQUEST_TIMEOUT_MS,
                maxResponseBytes: MAX_OIDC_TOKEN_RESPONSE_BYTES,
                redirect: 'error',
            });
            if (!response.ok) throw new UnauthorizedException('OIDC token exchange failed');
            const payload = await this.readProviderJsonObject(response);
            const accessToken = payload.access_token;
            if (typeof accessToken !== 'string' || !accessToken || accessToken.length > MAX_OIDC_ACCESS_TOKEN_LENGTH) {
                throw new UnauthorizedException('OIDC token exchange failed');
            }
            return { access_token: accessToken };
        } catch (error) {
            if (error instanceof UnauthorizedException) throw error;
            throw new UnauthorizedException('OIDC token exchange failed');
        }
    }

    private async fetchUserInfo(issuerUrl: string, accessToken: string): Promise<OidcUserInfo> {
        try {
            const response = await this.requestAuthProvider(`${issuerUrl}/o/oauth2/userinfo`, {
                headers: { Authorization: `Bearer ${accessToken}` },
                timeoutMs: AUTH_PROVIDER_REQUEST_TIMEOUT_MS,
                maxResponseBytes: MAX_OIDC_USERINFO_RESPONSE_BYTES,
                redirect: 'error',
            });
            if (!response.ok) throw new UnauthorizedException('Failed to fetch user info');
            return await this.readProviderJsonObject(response) as OidcUserInfo;
        } catch (error) {
            if (error instanceof UnauthorizedException) throw error;
            throw new UnauthorizedException('Failed to fetch user info');
        }
    }
}
