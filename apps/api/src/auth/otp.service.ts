import { Injectable, Logger, OnModuleDestroy, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { operationalErrorLog } from './operational-error';

const OTP_TTL_SECONDS = 600; // 10 minutes
const OTP_RATE_LIMIT_SECONDS = 60; // 1 OTP per minute per email
const OTP_MAX_FAILED_ATTEMPTS = 5;
const OTP_LOCK_SECONDS = 600;
const OTP_HMAC_SECRET_ENV = 'OTP_HMAC_SECRET';
const KEY_OTP = (scope: string) => `otp:${scope}`;
const KEY_RATE = (scope: string) => `otp_rate:${scope}`;
const KEY_ATTEMPTS = (scope: string) => `otp_attempts:${scope}`;
const KEY_LOCK = (scope: string) => `otp_lock:${scope}`;

const GENERATE_OTP_SCRIPT = `
if redis.call('EXISTS', KEYS[4]) == 1 then
    return 0
end
local attempts = tonumber(redis.call('GET', KEYS[3]) or '0')
if attempts >= tonumber(ARGV[4]) then
    return 0
end
if redis.call('EXISTS', KEYS[2]) == 1 then
    return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('SET', KEYS[2], '1', 'EX', ARGV[3])
return 1
`;

const VERIFY_OTP_SCRIPT = `
if redis.call('EXISTS', KEYS[3]) == 1 then
    return -2
end
local stored = redis.call('GET', KEYS[1])
if not stored then
    return -1
end
if stored == ARGV[1] then
    redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
    return 1
end
local maxAttempts = tonumber(ARGV[2])
local attempts = redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], ARGV[3])
if attempts >= maxAttempts then
    redis.call('DEL', KEYS[1])
    redis.call('SET', KEYS[3], '1', 'EX', ARGV[3])
    return -2
end
return 0
`;

export type OtpScopeOptions = {
    tenantSlug?: string;
    onboarding?: boolean;
    tenantName?: string;
};

@Injectable()
export class OtpService implements OnModuleDestroy {
    private readonly logger = new Logger(OtpService.name);
    private redis?: Redis;
    private readonly hmacSecret: string;

    constructor(private configService: ConfigService) {
        const configuredSecret = this.configService.get<string>(OTP_HMAC_SECRET_ENV)?.trim();
        const production = (this.configService.get<string>('NODE_ENV') ?? process.env.NODE_ENV) === 'production';
        if (production && (!configuredSecret || configuredSecret.length < 32)) {
            throw new Error(OTP_HMAC_SECRET_ENV + ' must contain at least 32 characters in production.');
        }
        this.hmacSecret = configuredSecret || 'local-development-otp-hmac-secret-v1';
    }

    onModuleDestroy(): void {
        this.redis?.disconnect(false);
    }

    private getRedis(): Redis {
        if (!this.redis) {
            this.redis = new Redis(
                this.configService.get<string>('REDIS_URL', 'redis://localhost:6379'),
            );
            this.redis.on('error', (err) => this.logger.error(operationalErrorLog('auth.otp_redis_client_error', err)));
        }
        return this.redis;
    }

    /**
     * Generate and store a 6-digit OTP for the given email.
     * Rate-limited to 1 request per minute per email.
     * Returns the plaintext code (caller must send it via email).
     */
    async generateOtp(email: string, options: OtpScopeOptions = {}): Promise<string> {
        const scope = this.scopeFor(email, options);
        const otpKey = KEY_OTP(scope);
        const rateKey = KEY_RATE(scope);
        const attemptsKey = KEY_ATTEMPTS(scope);
        const lockKey = KEY_LOCK(scope);
        const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
        const generated = Number(await this.getRedis().eval(
            GENERATE_OTP_SCRIPT,
            4,
            otpKey,
            rateKey,
            attemptsKey,
            lockKey,
            this.hashOtp(scope, code),
            String(OTP_TTL_SECONDS),
            String(OTP_RATE_LIMIT_SECONDS),
            String(OTP_MAX_FAILED_ATTEMPTS),
        ));
        if (generated !== 1) {
            throw new BadRequestException('Please wait before requesting another code');
        }

        this.logger.log(`OTP generated for ${this.maskEmail(email)} (${this.scopeLabel(options)})`);
        return code;
    }

    /**
     * Verify a code for the given email.
     * Deletes the code on success (single-use).
     * Returns true if valid, throws UnauthorizedException if not.
     */
    async verifyOtp(email: string, code: string, options: OtpScopeOptions = {}): Promise<boolean> {
        const scope = this.scopeFor(email, options);
        const otpKey = KEY_OTP(scope);
        const attemptsKey = KEY_ATTEMPTS(scope);
        const lockKey = KEY_LOCK(scope);
        const normalizedCode = code.trim();
        const result = Number(await this.getRedis().eval(
            VERIFY_OTP_SCRIPT,
            3,
            otpKey,
            attemptsKey,
            lockKey,
            this.hashOtp(scope, normalizedCode),
            String(OTP_MAX_FAILED_ATTEMPTS),
            String(OTP_LOCK_SECONDS),
        ));
        if (result !== 1) {
            throw new UnauthorizedException('Invalid or expired code');
        }

        this.logger.log(`OTP verified for ${this.maskEmail(email)} (${this.scopeLabel(options)})`);
        return true;
    }

    private scopeFor(email: string, options: OtpScopeOptions): string {
        const normalizedEmail = email.trim().toLowerCase();
        const tenantSlug = (options.tenantSlug ?? '').trim().toLowerCase();
        if (tenantSlug) return `tenant:${tenantSlug}:${normalizedEmail}`;
        if (options.onboarding === true) return `onboarding:${this.onboardingTenantHash(options.tenantName)}:${normalizedEmail}`;
        throw new BadRequestException('Workspace is required');
    }

    private hashOtp(scope: string, code: string): string {
        return crypto.createHmac('sha256', this.hmacSecret)
            .update(scope)
            .update('\0')
            .update(code)
            .digest('hex');
    }

    private onboardingTenantHash(value?: string): string {
        const tenantName = (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
        if (!tenantName) {
            throw new BadRequestException('Organization name is required');
        }
        return crypto.createHash('sha256').update(tenantName).digest('hex').slice(0, 16);
    }

    private scopeLabel(options: OtpScopeOptions): string {
        const tenantSlug = (options.tenantSlug ?? '').trim().toLowerCase();
        return tenantSlug ? `tenant:${tenantSlug}` : 'onboarding';
    }

    private maskEmail(email: string): string {
        const [localPart, domain] = email.split('@');
        if (!domain) return 'invalid_email';
        const safeLocal = localPart.length <= 2 ? `${localPart[0] ?? '*'}*` : `${localPart.slice(0, 2)}***`;
        return `${safeLocal}@${domain}`;
    }

}
