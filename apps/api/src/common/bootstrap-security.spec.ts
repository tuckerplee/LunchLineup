import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    buildCorsOptions,
    captureRawBody,
    normalizeAllowedHost,
    resolveAllowedOrigins,
    resolvePublicAppOrigin,
    resolveRequestBodyLimit,
    resolveTrustProxy,
    validateProductionEnvironment,
} from './bootstrap-security';

describe('bootstrap security policy', () => {
    it('normalizes configured CORS origins and denies unknown browser origins', () => {
        const options = buildCorsOptions({
            NODE_ENV: 'production',
            ALLOWED_ORIGINS: ' https://app.example.com/path,https://admin.example.com ',
        });

        expect(corsDecision(options, 'https://app.example.com')).toBe(true);
        expect(corsDecision(options, 'https://admin.example.com')).toBe(true);
        expect(corsDecision(options, 'https://evil.example.com')).toBe(false);
        expect(corsDecision(options, undefined)).toBe(true);
    });

    it('fails closed when production CORS origins are missing or invalid', () => {
        expect(() => resolveAllowedOrigins({ NODE_ENV: 'production' })).toThrow('ALLOWED_ORIGINS');
        expect(() => resolveAllowedOrigins({
            NODE_ENV: 'production',
            ALLOWED_ORIGINS: 'javascript:alert(1)',
        })).toThrow('Invalid ALLOWED_ORIGINS');
    });

    it('fails production startup when every app origin is omitted or blank', () => {
        expect(() => resolvePublicAppOrigin({ NODE_ENV: 'production' }))
            .toThrow(/APP_ORIGIN/);
        expect(() => resolvePublicAppOrigin({
            NODE_ENV: 'production',
            APP_ORIGIN: '   ',
            NEXT_PUBLIC_APP_ORIGIN: '',
            NEXT_PUBLIC_APP_URL: '  ',
        })).toThrow(/APP_ORIGIN/);
    });

    it('uses only a validated non-empty public HTTPS origin fallback', () => {
        expect(resolvePublicAppOrigin({
            NODE_ENV: 'production',
            APP_ORIGIN: '   ',
            NEXT_PUBLIC_APP_ORIGIN: ' https://lunchlineup.com ',
        })).toBe('https://lunchlineup.com');
        expect(() => resolvePublicAppOrigin({
            NODE_ENV: 'production',
            APP_ORIGIN: '',
            NEXT_PUBLIC_APP_ORIGIN: 'http://localhost:3000',
        })).toThrow(/public HTTPS origin/);
    });

    it('rejects unsafe production defaults before the API starts', () => {
        expect(() => validateProductionEnvironment({
            NODE_ENV: 'production',
            DOMAIN: 'localhost',
            ALLOWED_ORIGINS: 'http://lunchlineup.example.com',
            COOKIE_SECURE: 'false',
            JWT_SECRET: 'generate_with_openssl_rand_hex_64',
            JWT_REFRESH_SECRET: 'short',
            SESSION_SECRET: 'change_me',
            MFA_SECRET_ENCRYPTION_KEY: 'replace_me',
            RESEND_API_KEY: 'replace_me',
            EMAIL_FROM: 'invalid',
            STRIPE_SECRET_KEY: '',
            STRIPE_WEBHOOK_SECRET: 'replace_me',
            TRUST_PROXY: 'true',
        })).toThrow(/Refusing to start/);
    });

    it('accepts current-only MFA encryption in production', () => {
        expect(() => validateProductionEnvironment(productionEnv({
            MFA_SECRET_ENCRYPTION_KEY_CURRENT: Buffer.alloc(32, 0x11).toString('base64'),
        }))).not.toThrow();
    });

    it('accepts distinct managed and legacy MFA key overlap', () => {
        expect(() => validateProductionEnvironment(productionEnv({
            MFA_SECRET_ENCRYPTION_KEY_CURRENT: Buffer.alloc(32, 0x11).toString('base64'),
            MFA_SECRET_ENCRYPTION_KEY_PREVIOUS: Buffer.alloc(32, 0x22).toString('hex'),
            MFA_SECRET_ENCRYPTION_KEY: 'legacy-overlap-value-1234567890abcdef',
        }))).not.toThrow();
    });

    it('rejects missing, malformed, and duplicate MFA overlap keys', () => {
        expect(() => validateProductionEnvironment(productionEnv()))
            .toThrow(/MFA_SECRET_ENCRYPTION_KEY_CURRENT is required/);
        expect(() => validateProductionEnvironment(productionEnv({
            MFA_SECRET_ENCRYPTION_KEY_CURRENT: 'not-valid-base64!',
        }))).toThrow(/valid hex or base64/);
        expect(() => validateProductionEnvironment(productionEnv({
            MFA_SECRET_ENCRYPTION_KEY_CURRENT: Buffer.alloc(32, 0x11).toString('base64'),
            MFA_SECRET_ENCRYPTION_KEY_PREVIOUS: Buffer.alloc(16, 0x22).toString('base64'),
        }))).toThrow(/MFA_SECRET_ENCRYPTION_KEY_PREVIOUS must decode to exactly 32 bytes/);
        expect(() => validateProductionEnvironment(productionEnv({
            MFA_SECRET_ENCRYPTION_KEY_CURRENT: Buffer.alloc(32, 0x11).toString('base64'),
            MFA_SECRET_ENCRYPTION_KEY: 'short',
        }))).toThrow(/legacy overlap secret/);

        const duplicate = Buffer.alloc(32, 0x33);
        expect(() => validateProductionEnvironment(productionEnv({
            MFA_SECRET_ENCRYPTION_KEY_CURRENT: duplicate.toString('base64'),
            MFA_SECRET_ENCRYPTION_KEY_PREVIOUS: duplicate.toString('hex'),
        }))).toThrow(/must resolve to different encryption keys/);

        const legacy = 'legacy-overlap-value-abcdefghij123456';
        expect(() => validateProductionEnvironment(productionEnv({
            MFA_SECRET_ENCRYPTION_KEY_CURRENT: crypto.createHash('sha256').update(legacy).digest('base64'),
            MFA_SECRET_ENCRYPTION_KEY: legacy,
        }))).toThrow(/must resolve to different encryption keys/);
    });

    it('accepts explicit public production settings', () => {
        expect(() => validateProductionEnvironment({
            NODE_ENV: 'production',
            DOMAIN: 'lunchlineup.com',
            APP_ORIGIN: 'https://lunchlineup.com',
            OIDC_ENABLED: 'false',
            ALLOWED_ORIGINS: 'https://lunchlineup.example.com',
            COOKIE_SECURE: 'true',
            DATABASE_URL: 'postgresql://lunchlineup:strong-pass@postgres:5432/lunchlineup',
            REDIS_URL: 'redis://redis:6379',
            RABBITMQ_URL: 'amqp://lunchlineup:strong-pass@rabbitmq:5672',
            JWT_SECRET: 'a'.repeat(48),
            JWT_REFRESH_SECRET: 'b'.repeat(48),
            SESSION_SECRET: 'c'.repeat(48),
            MFA_SECRET_ENCRYPTION_KEY_CURRENT: Buffer.alloc(32, 0x44).toString('base64'),
            RESEND_API_KEY: `re_${'e'.repeat(48)}`,
            EMAIL_FROM: 'LunchLineup <no-reply@lunchlineup.example.com>',
            STRIPE_SECRET_KEY: `sk_live_${'f'.repeat(48)}`,
            STRIPE_WEBHOOK_SECRET: `whsec_${'g'.repeat(48)}`,
            METRICS_TOKEN: 'd'.repeat(48),
        })).not.toThrow();
    });

    it('rejects invalid production host and OIDC settings', () => {
        expect(() => normalizeAllowedHost('https://app.example.com')).toThrow('Invalid host entry');
        expect(() => validateProductionEnvironment({
            NODE_ENV: 'production',
            DOMAIN: 'https://lunchlineup.example.com',
            ALLOWED_HOSTS: '*',
            ALLOWED_ORIGINS: 'https://lunchlineup.example.com',
            COOKIE_SECURE: 'true',
            DATABASE_URL: 'postgresql://lunchlineup:strong-pass@postgres:5432/lunchlineup',
            REDIS_URL: 'redis://redis:6379',
            RABBITMQ_URL: 'amqp://lunchlineup:strong-pass@rabbitmq:5672',
            JWT_SECRET: 'a'.repeat(48),
            JWT_REFRESH_SECRET: 'b'.repeat(48),
            SESSION_SECRET: 'c'.repeat(48),
            MFA_SECRET_ENCRYPTION_KEY_CURRENT: Buffer.alloc(32, 0x44).toString('base64'),
            RESEND_API_KEY: `re_${'e'.repeat(48)}`,
            EMAIL_FROM: 'LunchLineup <no-reply@lunchlineup.example.com>',
            STRIPE_SECRET_KEY: `sk_live_${'f'.repeat(48)}`,
            STRIPE_WEBHOOK_SECRET: `whsec_${'g'.repeat(48)}`,
            METRICS_TOKEN: 'd'.repeat(48),
            OIDC_ENABLED: 'true',
            OIDC_ISSUER_URL: 'http://localhost:9999',
            OIDC_CLIENT_ID: '',
            OIDC_CLIENT_SECRET: 'replace_me',
            OIDC_REDIRECT_URI: 'http://localhost:3000/api/v1/auth/callback',
        })).toThrow(/Refusing to start/);
    });

    it('uses explicit body limits, raw body capture, and proxy defaults', () => {
        expect(resolveRequestBodyLimit({})).toBe('1mb');
        expect(resolveRequestBodyLimit({ API_BODY_LIMIT: '2mb' })).toBe('2mb');
        expect(resolveTrustProxy({ NODE_ENV: 'production' })).toBe('loopback, linklocal, uniquelocal');
        expect(resolveTrustProxy({ TRUST_PROXY: 'false' })).toBe(false);

        const req = {} as any;
        captureRawBody(req, {} as any, Buffer.from('{"ok":true}'));
        expect(req.rawBody).toEqual(Buffer.from('{"ok":true}'));
    });
});

function corsDecision(options: ReturnType<typeof buildCorsOptions>, origin: string | undefined): boolean | undefined {
    let result: boolean | undefined;
    options.origin(origin, (_error, allow) => {
        result = allow;
    });
    return result;
}


function productionEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
        NODE_ENV: 'production',
        DOMAIN: 'lunchlineup.com',
        APP_ORIGIN: 'https://lunchlineup.com',
        OIDC_ENABLED: 'false',
        ALLOWED_ORIGINS: 'https://lunchlineup.example.com',
        COOKIE_SECURE: 'true',
        DATABASE_URL: 'postgresql://lunchlineup:strong-pass@postgres:5432/lunchlineup',
        REDIS_URL: 'redis://redis:6379',
        RABBITMQ_URL: 'amqp://lunchlineup:strong-pass@rabbitmq:5672',
        JWT_SECRET: 'a'.repeat(48),
        JWT_REFRESH_SECRET: 'b'.repeat(48),
        SESSION_SECRET: 'c'.repeat(48),
        RESEND_API_KEY: `re_${'e'.repeat(48)}`,
        EMAIL_FROM: 'LunchLineup <no-reply@lunchlineup.example.com>',
        STRIPE_SECRET_KEY: `sk_live_${'f'.repeat(48)}`,
        STRIPE_WEBHOOK_SECRET: `whsec_${'g'.repeat(48)}`,
        METRICS_TOKEN: 'd'.repeat(48),
        ...overrides,
    };
}
