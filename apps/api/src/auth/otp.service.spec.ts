import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OtpService } from './otp.service';

const { redisConstructor } = vi.hoisted(() => ({
    redisConstructor: vi.fn().mockImplementation(function RedisMock(this: { on: ReturnType<typeof vi.fn> }) {
        this.on = vi.fn();
    }),
}));

vi.mock('ioredis', () => ({
    default: redisConstructor,
}));

const OTP_HMAC_SECRET = 'otp-test-hmac-secret-with-at-least-32-characters';
const configService = {
    get: (key: string, fallback?: string) => key === 'OTP_HMAC_SECRET' ? OTP_HMAC_SECRET : fallback,
};

function serviceWith(redis: {
    eval: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    disconnect?: ReturnType<typeof vi.fn>;
}) {
    const service = new OtpService(configService as any);
    (service as any).redis = redis;
    return service;
}

describe('OtpService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('does not create a Redis client during construction or unused shutdown', () => {
        const service = new OtpService(configService as any);

        expect(redisConstructor).not.toHaveBeenCalled();
        service.onModuleDestroy();
        expect(redisConstructor).not.toHaveBeenCalled();
    });

    it('creates and configures Redis only when the first OTP operation needs it', async () => {
        const redis = { eval: vi.fn().mockResolvedValue(1), on: vi.fn(), disconnect: vi.fn() };
        redisConstructor.mockImplementationOnce(function RedisOperationMock(this: typeof redis) {
            this.eval = redis.eval;
            this.on = redis.on;
            this.disconnect = redis.disconnect;
        });
        const service = new OtpService(configService as any);

        expect(redisConstructor).not.toHaveBeenCalled();
        await service.generateOtp('admin@example.com', { tenantSlug: 'demo' });

        expect(redisConstructor).toHaveBeenCalledOnce();
        expect(redis.on).toHaveBeenCalledWith('error', expect.any(Function));
        service.onModuleDestroy();
        expect(redis.disconnect).toHaveBeenCalledWith(false);
    });

    it('disconnects its Redis client during module shutdown', () => {
        const redis = { eval: vi.fn(), on: vi.fn(), disconnect: vi.fn() };
        const service = serviceWith(redis);

        service.onModuleDestroy();

        expect(redis.disconnect).toHaveBeenCalledWith(false);
    });

    it('generates and stores a 6-digit OTP atomically', async () => {
        const redis = { eval: vi.fn().mockResolvedValue(1), on: vi.fn() };
        const service = serviceWith(redis);

        const code = await service.generateOtp('admin@example.com', { tenantSlug: 'demo' });

        expect(code).toMatch(/^\d{6}$/);
        expect(redis.eval).toHaveBeenCalledWith(
            expect.stringContaining("redis.call('EXISTS', KEYS[4])"),
            4,
            'otp:tenant:demo:admin@example.com',
            'otp_rate:tenant:demo:admin@example.com',
            'otp_attempts:tenant:demo:admin@example.com',
            'otp_lock:tenant:demo:admin@example.com',
            expect.stringMatching(/^[a-f0-9]{64}$/),
            '600',
            '60',
            '5',
        );
        expect(redis.eval.mock.calls[0][6]).not.toBe(code);
        expect(redis.eval.mock.calls[0][6]).toBe((service as any).hashOtp('tenant:demo:admin@example.com', code));
    });

    it('fails closed without a dedicated HMAC secret in production', () => {
        expect(() => new OtpService({
            get: (key: string) => key === 'NODE_ENV' ? 'production' : undefined,
        } as any)).toThrow(/OTP_HMAC_SECRET/);
    });

    it('requires a tenant or onboarding scope for OTP storage', async () => {
        const redis = { eval: vi.fn(), on: vi.fn() };
        const service = serviceWith(redis);

        await expect(service.generateOtp('admin@example.com')).rejects.toBeInstanceOf(BadRequestException);
        expect(redis.eval).not.toHaveBeenCalled();
    });

    it('binds onboarding OTP storage to the organization name', async () => {
        const redis = { eval: vi.fn().mockResolvedValue(1), on: vi.fn() };
        const service = serviceWith(redis);

        await service.generateOtp('Owner@Example.com', { onboarding: true, tenantName: 'Acme Dining' });

        expect(redis.eval.mock.calls[0][2]).toMatch(/^otp:onboarding:[a-f0-9]{16}:owner@example\.com$/);
        expect(redis.eval.mock.calls[0][4]).toMatch(/^otp_attempts:onboarding:[a-f0-9]{16}:owner@example\.com$/);
    });

    it('rejects onboarding OTP storage without an organization name', async () => {
        const redis = { eval: vi.fn(), on: vi.fn() };
        const service = serviceWith(redis);

        await expect(service.generateOtp('owner@example.com', { onboarding: true }))
            .rejects
            .toBeInstanceOf(BadRequestException);
        expect(redis.eval).not.toHaveBeenCalled();
    });

    it('atomically counts failures and keeps the max-attempt counter for the lock TTL', async () => {
        const redis = {
            eval: vi.fn()
                .mockResolvedValueOnce(0)
                .mockResolvedValueOnce(0)
                .mockResolvedValueOnce(0)
                .mockResolvedValueOnce(0)
                .mockResolvedValueOnce(-2),
            on: vi.fn(),
        };
        const service = serviceWith(redis);

        for (let attempt = 1; attempt <= 5; attempt += 1) {
            await expect(service.verifyOtp('owner@example.com', '000000', { tenantSlug: 'demo' }))
                .rejects
                .toBeInstanceOf(UnauthorizedException);
        }

        const script = redis.eval.mock.calls[4][0] as string;
        expect(script).toMatch(/INCR[\s\S]*EXPIRE[\s\S]*maxAttempts[\s\S]*SET/);
        expect(script).toContain("redis.call('DEL', KEYS[1])");
        expect(script).not.toContain("redis.call('DEL', KEYS[1], KEYS[2])");
        expect(redis.eval).toHaveBeenLastCalledWith(
            script,
            3,
            'otp:tenant:demo:owner@example.com',
            'otp_attempts:tenant:demo:owner@example.com',
            'otp_lock:tenant:demo:owner@example.com',
            (service as any).hashOtp('tenant:demo:owner@example.com', '000000'),
            '5',
            '600',
        );
    });

    it('resets the challenge and protection state only after successful verification', async () => {
        const redis = { eval: vi.fn().mockResolvedValue(1), on: vi.fn() };
        const service = serviceWith(redis);

        await expect(service.verifyOtp('owner@example.com', '123456', { tenantSlug: 'demo' }))
            .resolves
            .toBe(true);

        const script = redis.eval.mock.calls[0][0] as string;
        expect(script).toContain("redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])");
        expect(redis.eval).toHaveBeenCalledWith(
            script,
            3,
            'otp:tenant:demo:owner@example.com',
            'otp_attempts:tenant:demo:owner@example.com',
            'otp_lock:tenant:demo:owner@example.com',
            (service as any).hashOtp('tenant:demo:owner@example.com', '123456'),
            '5',
            '600',
        );
    });

    it('preserves active lockout and failed-attempt state when generation is refused', async () => {
        const redis = { eval: vi.fn().mockResolvedValue(0), on: vi.fn() };
        const service = serviceWith(redis);

        await expect(service.generateOtp('owner@example.com', { tenantSlug: 'demo' }))
            .rejects
            .toMatchObject({ message: 'Please wait before requesting another code' });

        const script = redis.eval.mock.calls[0][0] as string;
        expect(script).toContain("redis.call('EXISTS', KEYS[4])");
        expect(script).toContain("redis.call('GET', KEYS[3])");
        expect(script).toContain("redis.call('EXISTS', KEYS[2])");
        expect(script).not.toContain("redis.call('DEL', KEYS[3]");
        expect(script).not.toContain("redis.call('DEL', KEYS[4]");
        expect(script.indexOf("redis.call('EXISTS', KEYS[4])"))
            .toBeLessThan(script.indexOf("redis.call('SET', KEYS[1]"));
    });

    it('issues a fresh code after lock and counter expiry using the same atomic operation', async () => {
        const redis = {
            eval: vi.fn()
                .mockResolvedValueOnce(0)
                .mockResolvedValueOnce(1),
            on: vi.fn(),
        };
        const service = serviceWith(redis);

        await expect(service.generateOtp('owner@example.com', { tenantSlug: 'demo' }))
            .rejects
            .toBeInstanceOf(BadRequestException);
        await expect(service.generateOtp('owner@example.com', { tenantSlug: 'demo' }))
            .resolves
            .toMatch(/^\d{6}$/);

        expect(redis.eval).toHaveBeenCalledTimes(2);
        expect(redis.eval.mock.calls[0].slice(1, 6)).toEqual(redis.eval.mock.calls[1].slice(1, 6));
        expect(redis.eval.mock.calls[1][0]).not.toContain("redis.call('DEL', KEYS[3]");
        expect(redis.eval.mock.calls[1][0]).not.toContain("redis.call('DEL', KEYS[4]");
    });

    it('serializes distributed generation requests through shared Redis state', async () => {
        let issued = false;
        const redis = {
            eval: vi.fn().mockImplementation(async () => {
                if (issued) return 0;
                issued = true;
                return 1;
            }),
            on: vi.fn(),
        };
        const firstService = serviceWith(redis);
        const secondService = serviceWith(redis);

        const results = await Promise.allSettled([
            firstService.generateOtp('owner@example.com', { tenantSlug: 'demo' }),
            secondService.generateOtp('owner@example.com', { tenantSlug: 'demo' }),
        ]);

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
        expect(redis.eval).toHaveBeenCalledTimes(2);
        expect(redis.eval.mock.calls[0].slice(1, 6)).toEqual(redis.eval.mock.calls[1].slice(1, 6));
    });
});
