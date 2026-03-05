import { Injectable, Logger, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

const OTP_TTL_SECONDS = 600; // 10 minutes
const OTP_RATE_LIMIT_SECONDS = 60; // 1 OTP per minute per email
const KEY_OTP = (email: string) => `otp:${email.toLowerCase()}`;
const KEY_RATE = (email: string) => `otp_rate:${email.toLowerCase()}`;

@Injectable()
export class OtpService {
    private readonly logger = new Logger(OtpService.name);
    private readonly redis: Redis;

    constructor(private configService: ConfigService) {
        this.redis = new Redis(
            this.configService.get<string>('REDIS_URL', 'redis://localhost:6379'),
        );
        this.redis.on('error', (err) => this.logger.error('Redis error', err));
    }

    /**
     * Generate and store a 6-digit OTP for the given email.
     * Rate-limited to 1 request per minute per email.
     * Returns the plaintext code (caller must send it via email).
     */
    async generateOtp(email: string): Promise<string> {
        const rateKey = KEY_RATE(email);
        const alreadySent = await this.redis.exists(rateKey);
        if (alreadySent) {
            throw new BadRequestException('Please wait before requesting another code');
        }

        // Cryptographically random 6-digit code
        const code = String(Math.floor(100000 + Math.random() * 900000));

        const otpKey = KEY_OTP(email);
        await this.redis.set(otpKey, code, 'EX', OTP_TTL_SECONDS);
        await this.redis.set(rateKey, '1', 'EX', OTP_RATE_LIMIT_SECONDS);

        this.logger.log(`OTP generated for ${email}`);
        return code;
    }

    /**
     * Verify a code for the given email.
     * Deletes the code on success (single-use).
     * Returns true if valid, throws UnauthorizedException if not.
     */
    async verifyOtp(email: string, code: string): Promise<boolean> {
        const otpKey = KEY_OTP(email);
        const stored = await this.redis.get(otpKey);

        if (!stored || stored !== code.trim()) {
            throw new UnauthorizedException('Invalid or expired code');
        }

        // Single-use: delete on success
        await this.redis.del(otpKey);
        this.logger.log(`OTP verified for ${email}`);
        return true;
    }
}
