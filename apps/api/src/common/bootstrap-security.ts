import crypto from 'node:crypto';
import type { Request, Response } from 'express';

type CorsOriginCallback = (err: Error | null, allow?: boolean) => void;

export interface ApiCorsOptions {
    origin: (origin: string | undefined, callback: CorsOriginCallback) => void;
    credentials: boolean;
    methods: string[];
    allowedHeaders: string[];
    exposedHeaders: string[];
    maxAge: number;
}

const DEFAULT_DEV_ORIGINS = [
    'http://localhost:3000',
    'http://localhost:3001',
    'https://localhost:3000',
    'https://localhost:3001',
];
const DEFAULT_BODY_LIMIT = '1mb';
const MIN_SECRET_LENGTH = 32;
const PLACEHOLDER_RE = /(change_me|generate_with|replace_me|example|secret|password)/i;
const EMAIL_FROM_RE = /^(?:[^<>@\r\n]+<)?[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>?$/;
const INTERNAL_PRODUCTION_HOSTS = new Set(['api', 'web', 'proxy']);
const CREDIT_PACK_PRICE_KEYS = [
    'STRIPE_PRICE_CREDIT_PACK_100',
    'STRIPE_PRICE_CREDIT_PACK_500',
    'STRIPE_PRICE_CREDIT_PACK_2000',
] as const;
const STRIPE_PRICE_ID_RE = /^price_[A-Za-z0-9_]+$/;

export function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.NODE_ENV === 'production';
}

export function readCsv(value: string | undefined): string[] {
    if (!value) return [];

    return Array.from(new Set(
        value
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean),
    ));
}

export function normalizeOrigin(value: string): string {
    try {
        const parsed = new URL(value);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            throw new Error('unsupported protocol');
        }
        return parsed.origin;
    } catch {
        throw new Error('Invalid ALLOWED_ORIGINS entry.');
    }
}

export function resolvePublicAppOrigin(env: NodeJS.ProcessEnv = process.env): string {
    const configured = [env.APP_ORIGIN, env.NEXT_PUBLIC_APP_ORIGIN, env.NEXT_PUBLIC_APP_URL]
        .map((value) => value?.trim())
        .find((value): value is string => Boolean(value));

    if (!configured) {
        throw new Error('APP_ORIGIN or a public app origin fallback must be configured.');
    }

    let parsed: URL;
    try {
        parsed = new URL(configured);
    } catch {
        throw new Error('APP_ORIGIN or its fallback must be a valid absolute URL.');
    }

    if (
        !['http:', 'https:'].includes(parsed.protocol)
        || parsed.username
        || parsed.password
        || parsed.pathname !== '/'
        || parsed.search
        || parsed.hash
    ) {
        throw new Error('APP_ORIGIN or its fallback must contain only an HTTP(S) origin.');
    }

    if (isProduction(env)) {
        const hostname = parsed.hostname.toLowerCase();
        if (parsed.protocol !== 'https:' || !isPublicAppHostname(hostname)) {
            throw new Error('APP_ORIGIN or its fallback must be a public HTTPS origin in production.');
        }
    }

    return parsed.origin;
}

export function resolveAllowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
    const configured = readCsv(env.ALLOWED_ORIGINS).map(normalizeOrigin);

    if (isProduction(env) && configured.length === 0) {
        throw new Error('ALLOWED_ORIGINS must be configured in production.');
    }

    return configured.length > 0 ? configured : DEFAULT_DEV_ORIGINS;
}

export function buildCorsOptions(env: NodeJS.ProcessEnv = process.env): ApiCorsOptions {
    const allowedOrigins = new Set(resolveAllowedOrigins(env));

    return {
        origin(origin, callback) {
            if (!origin) {
                callback(null, true);
                return;
            }

            callback(null, allowedOrigins.has(origin));
        },
        credentials: true,
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: [
            'Authorization',
            'Content-Type',
            'X-Correlation-ID',
            'X-CSRF-Token',
            'X-Metrics-Token',
            'X-Requested-With',
        ],
        exposedHeaders: [
            'Retry-After',
            'X-Correlation-ID',
            'X-RateLimit-Limit',
            'X-RateLimit-Remaining',
            'X-RateLimit-Reset',
        ],
        maxAge: 600,
    };
}

export function resolveRequestBodyLimit(env: NodeJS.ProcessEnv = process.env): string {
    return (env.API_BODY_LIMIT || env.REQUEST_BODY_LIMIT || DEFAULT_BODY_LIMIT).trim() || DEFAULT_BODY_LIMIT;
}

export function captureRawBody(req: Request, _res: Response, buffer: Buffer): void {
    if (buffer.length > 0) {
        (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
    }
}

export function resolveTrustProxy(env: NodeJS.ProcessEnv = process.env): string | boolean {
    const configured = env.TRUST_PROXY?.trim();
    if (configured) {
        if (['false', '0', 'off', 'no'].includes(configured.toLowerCase())) return false;
        if (['true', '1', 'on', 'yes'].includes(configured.toLowerCase())) return true;
        return configured;
    }

    return isProduction(env) ? 'loopback, linklocal, uniquelocal' : 'loopback';
}

export function normalizeAllowedHost(value: string): string {
    const host = value.trim().toLowerCase().replace(/\.$/, '');
    if (
        !host ||
        host.includes('://') ||
        host.includes('/') ||
        host.includes('\\') ||
        host.includes('@') ||
        host.includes('*')
    ) {
        throw new Error('Invalid host entry.');
    }

    try {
        new URL(`http://${host}`);
        return host;
    } catch {
        throw new Error('Invalid host entry.');
    }
}

export function validateProductionEnvironment(env: NodeJS.ProcessEnv = process.env): void {
    if (!isProduction(env)) return;

    const errors: string[] = [];

    try {
        resolvePublicAppOrigin(env);
    } catch {
        errors.push('APP_ORIGIN is invalid.');
    }

    try {
        const origins = resolveAllowedOrigins(env);
        const insecureOrigins = origins.filter((origin) => origin.startsWith('http://') && !isLoopbackOrigin(origin));
        if (insecureOrigins.length > 0) {
            errors.push(`ALLOWED_ORIGINS must use https in production: ${insecureOrigins.join(', ')}`);
        }
    } catch {
        errors.push('ALLOWED_ORIGINS is invalid.');
    }

    if (!env.DOMAIN || env.DOMAIN.trim().toLowerCase() === 'localhost') {
        errors.push('DOMAIN must be set to the public hostname in production.');
    } else {
        try {
            const domain = normalizeAllowedHost(env.DOMAIN);
            const hostname = hostnameFromAllowedHost(domain);
            if (isUnsafePublicHostname(hostname) || INTERNAL_PRODUCTION_HOSTS.has(hostname)) {
                errors.push('DOMAIN must be set to the public hostname in production.');
            }
        } catch {
            errors.push('DOMAIN is invalid.');
        }
    }

    try {
        readCsv(env.ALLOWED_HOSTS).forEach(normalizeAllowedHost);
    } catch {
        errors.push('ALLOWED_HOSTS is invalid.');
    }

    const trustProxy = env.TRUST_PROXY?.trim().toLowerCase();
    if (trustProxy && ['true', '1', 'on', 'yes'].includes(trustProxy)) {
        errors.push('TRUST_PROXY cannot be a blanket true value in production; use an explicit proxy range.');
    }

    if (isFalse(env.COOKIE_SECURE)) {
        errors.push('COOKIE_SECURE cannot be false in production.');
    }

    if (['1', 'true', 'yes', 'on'].includes((env.AUTH_DEBUG ?? '').trim().toLowerCase())) {
        errors.push('AUTH_DEBUG cannot be enabled in production.');
    }

    for (const key of ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'SESSION_SECRET', 'OTP_HMAC_SECRET']) {
        const value = env[key];
        if (!value || value.length < MIN_SECRET_LENGTH || PLACEHOLDER_RE.test(value)) {
            errors.push(`${key} must be a non-placeholder secret with at least ${MIN_SECRET_LENGTH} characters.`);
        }
    }

    validateMfaEncryptionKeys(env, errors);
    validateAvailabilityImportEncryptionKey(env, errors);
    if ((env.STAFF_INVITATION_OUTBOX_ENABLED ?? '').trim().toLowerCase() !== 'true') {
        errors.push('STAFF_INVITATION_OUTBOX_ENABLED must be exactly true in production.');
    }
    validateStaffInvitationOutboxEncryptionKey(env, errors);

    for (const key of ['DATABASE_URL', 'REDIS_URL', 'RABBITMQ_URL']) {
        const value = env[key]?.trim();
        if (!value || PLACEHOLDER_RE.test(value)) {
            errors.push(`${key} must be configured in production.`);
        }
    }

    if ((env.OIDC_ENABLED ?? 'true').toLowerCase() !== 'false') {
        validateOidcConfiguration(env, errors);
    }

    const resendApiKey = env.RESEND_API_KEY?.trim();
    if (!resendApiKey || resendApiKey.length < MIN_SECRET_LENGTH || PLACEHOLDER_RE.test(resendApiKey)) {
        errors.push('RESEND_API_KEY must be a non-placeholder provider key with at least 32 characters.');
    }

    const resendWebhookSecret = env.RESEND_WEBHOOK_SECRET?.trim();
    if (!resendWebhookSecret || resendWebhookSecret.length < MIN_SECRET_LENGTH || PLACEHOLDER_RE.test(resendWebhookSecret)) {
        errors.push('RESEND_WEBHOOK_SECRET must be a non-placeholder signing secret with at least 32 characters.');
    }

    const emailFrom = env.EMAIL_FROM?.trim();
    if (!emailFrom || !EMAIL_FROM_RE.test(emailFrom)) {
        errors.push('EMAIL_FROM must be configured with a valid sender address in production.');
    }

    for (const key of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) {
        const value = env[key];
        if (!value || value.length < MIN_SECRET_LENGTH || PLACEHOLDER_RE.test(value)) {
            errors.push(`${key} must be a non-placeholder Stripe value with at least ${MIN_SECRET_LENGTH} characters.`);
        }
    }
    validateCreditPackPriceConfiguration(env, errors);

    const metricsToken = env.METRICS_TOKEN?.trim();
    const metricsTokenFile = env.METRICS_TOKEN_FILE?.trim();
    if (!metricsToken && !metricsTokenFile) {
        errors.push('METRICS_TOKEN or METRICS_TOKEN_FILE must be configured in production.');
    }
    if (metricsToken && (metricsToken.length < MIN_SECRET_LENGTH || PLACEHOLDER_RE.test(metricsToken))) {
        errors.push(`METRICS_TOKEN must be a non-placeholder token with at least ${MIN_SECRET_LENGTH} characters.`);
    }

    if (errors.length > 0) {
        throw new Error(`Refusing to start with unsafe production configuration: ${errors.join(' ')}`);
    }
}

function isFalse(value: string | undefined): boolean {
    return value !== undefined && ['false', '0', 'off', 'no'].includes(value.toLowerCase());
}

function isLoopbackOrigin(origin: string): boolean {
    const host = new URL(origin).hostname.toLowerCase();
    return isLoopbackHostname(host);
}

function hostnameFromAllowedHost(host: string): string {
    return new URL(`http://${host}`).hostname.toLowerCase();
}

function isLoopbackHostname(host: string): boolean {
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1';
}

function isUnsafePublicHostname(host: string): boolean {
    if (isLoopbackHostname(host)) return true;

    const parts = host.split('.').map((part) => Number.parseInt(part, 10));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
        return false;
    }

    const [a, b] = parts;
    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168)
    );
}

function isPublicAppHostname(host: string): boolean {
    const normalized = host.replace(/\.$/, '');
    if (
        !normalized.includes('.')
        || isUnsafePublicHostname(normalized)
        || normalized === 'example.com'
        || normalized === 'example.net'
        || normalized === 'example.org'
        || normalized.endsWith('.example.com')
        || normalized.endsWith('.example.net')
        || normalized.endsWith('.example.org')
        || normalized.endsWith('.example')
        || normalized.endsWith('.test')
        || normalized.endsWith('.invalid')
        || normalized.endsWith('.localhost')
    ) {
        return false;
    }
    return true;
}

function validateOidcConfiguration(env: NodeJS.ProcessEnv, errors: string[]): void {
    const issuerUrl = env.OIDC_ISSUER_URL?.trim();
    const redirectUri = env.OIDC_REDIRECT_URI?.trim();

    for (const key of ['OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET']) {
        const value = env[key]?.trim();
        if (!value || PLACEHOLDER_RE.test(value)) {
            errors.push(`${key} must be configured when OIDC is enabled.`);
        }
    }

    try {
        const issuer = issuerUrl ? new URL(issuerUrl) : null;
        if (!issuer || issuer.protocol !== 'https:' || isUnsafePublicHostname(issuer.hostname.toLowerCase())) {
            errors.push('OIDC_ISSUER_URL must be a public HTTPS URL when OIDC is enabled.');
        }
    } catch {
        errors.push('OIDC_ISSUER_URL must be a valid HTTPS URL when OIDC is enabled.');
    }

    try {
        const redirect = redirectUri ? new URL(redirectUri) : null;
        if (!redirect || redirect.protocol !== 'https:' || isUnsafePublicHostname(redirect.hostname.toLowerCase())) {
            errors.push('OIDC_REDIRECT_URI must be a public HTTPS URL when OIDC is enabled.');
        }
    } catch {
        errors.push('OIDC_REDIRECT_URI must be a valid HTTPS URL when OIDC is enabled.');
    }
}


function validateCreditPackPriceConfiguration(env: NodeJS.ProcessEnv, errors: string[]): void {
    const configured = CREDIT_PACK_PRICE_KEYS
        .map((key) => ({ key, value: env[key]?.trim() }))
        .filter((entry): entry is { key: typeof CREDIT_PACK_PRICE_KEYS[number]; value: string } => Boolean(entry.value));
    for (const { key, value } of configured) {
        if (!STRIPE_PRICE_ID_RE.test(value)) {
            errors.push(`${key} must be a Stripe Price ID when configured.`);
        }
    }
    if (new Set(configured.map(({ value }) => value)).size !== configured.length) {
        errors.push('Stripe credit pack Price IDs must be unique.');
    }
}

function validateMfaEncryptionKeys(env: NodeJS.ProcessEnv, errors: string[]): void {
    const current = decodeMfaManagedKey(env.MFA_SECRET_ENCRYPTION_KEY_CURRENT, 'MFA_SECRET_ENCRYPTION_KEY_CURRENT', errors, true);
    const previous = decodeMfaManagedKey(env.MFA_SECRET_ENCRYPTION_KEY_PREVIOUS, 'MFA_SECRET_ENCRYPTION_KEY_PREVIOUS', errors);
    const legacyValue = env.MFA_SECRET_ENCRYPTION_KEY?.trim();
    let legacy: Buffer | null = null;

    if (legacyValue) {
        if (legacyValue.length < MIN_SECRET_LENGTH || PLACEHOLDER_RE.test(legacyValue)) {
            errors.push(`MFA_SECRET_ENCRYPTION_KEY must be a non-placeholder legacy overlap secret with at least ${MIN_SECRET_LENGTH} characters when configured.`);
        } else {
            legacy = crypto.createHash('sha256').update(legacyValue).digest();
        }
    }

    const configuredValues = [
        ['MFA_SECRET_ENCRYPTION_KEY_CURRENT', env.MFA_SECRET_ENCRYPTION_KEY_CURRENT?.trim()],
        ['MFA_SECRET_ENCRYPTION_KEY_PREVIOUS', env.MFA_SECRET_ENCRYPTION_KEY_PREVIOUS?.trim()],
        ['MFA_SECRET_ENCRYPTION_KEY', legacyValue],
    ] as const;
    for (let index = 0; index < configuredValues.length; index += 1) {
        const [name, value] = configuredValues[index];
        if (!value) continue;
        const duplicate = configuredValues.slice(index + 1).find(([, candidate]) => candidate === value);
        if (duplicate) {
            errors.push(`${name} and ${duplicate[0]} must differ.`);
        }
    }

    const effectiveKeys = [
        ['MFA_SECRET_ENCRYPTION_KEY_CURRENT', current],
        ['MFA_SECRET_ENCRYPTION_KEY_PREVIOUS', previous],
        ['MFA_SECRET_ENCRYPTION_KEY', legacy],
    ] as const;
    for (let index = 0; index < effectiveKeys.length; index += 1) {
        const [name, value] = effectiveKeys[index];
        if (!value) continue;
        const duplicate = effectiveKeys.slice(index + 1).find(([, candidate]) => candidate?.equals(value));
        if (duplicate) {
            errors.push(`${name} and ${duplicate[0]} must resolve to different encryption keys.`);
        }
    }
}

function validateAvailabilityImportEncryptionKey(env: NodeJS.ProcessEnv, errors: string[]): void {
    const source = decodeMfaManagedKey(
        env.AVAILABILITY_IMPORT_ENCRYPTION_KEY,
        'AVAILABILITY_IMPORT_ENCRYPTION_KEY',
        errors,
        true,
    );
    if (!source) return;

    for (const [name, configured] of [
        ['MFA_SECRET_ENCRYPTION_KEY_CURRENT', env.MFA_SECRET_ENCRYPTION_KEY_CURRENT],
        ['MFA_SECRET_ENCRYPTION_KEY_PREVIOUS', env.MFA_SECRET_ENCRYPTION_KEY_PREVIOUS],
        ['WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT', env.WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT],
        ['WEBHOOK_DELIVERY_ENCRYPTION_KEY_PREVIOUS', env.WEBHOOK_DELIVERY_ENCRYPTION_KEY_PREVIOUS],
        ['PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY', env.PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY],
    ] as const) {
        if (!configured?.trim()) continue;
        const candidate = decodeMfaManagedKey(configured, name, errors);
        if (candidate?.equals(source)) {
            errors.push(`AVAILABILITY_IMPORT_ENCRYPTION_KEY must not reuse ${name}.`);
        }
    }
}
function validateStaffInvitationOutboxEncryptionKey(env: NodeJS.ProcessEnv, errors: string[]): void {
    const invitation = decodeMfaManagedKey(
        env.STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY,
        'STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY',
        errors,
        true,
    );
    if (!invitation) return;

    for (const [name, configured] of [
        ['MFA_SECRET_ENCRYPTION_KEY_CURRENT', env.MFA_SECRET_ENCRYPTION_KEY_CURRENT],
        ['MFA_SECRET_ENCRYPTION_KEY_PREVIOUS', env.MFA_SECRET_ENCRYPTION_KEY_PREVIOUS],
        ['WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT', env.WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT],
        ['WEBHOOK_DELIVERY_ENCRYPTION_KEY_PREVIOUS', env.WEBHOOK_DELIVERY_ENCRYPTION_KEY_PREVIOUS],
        ['PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY', env.PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY],
        ['AVAILABILITY_IMPORT_ENCRYPTION_KEY', env.AVAILABILITY_IMPORT_ENCRYPTION_KEY],
    ] as const) {
        if (!configured?.trim()) continue;
        const candidate = decodeMfaManagedKey(configured, name, errors);
        if (candidate?.equals(invitation)) {
            errors.push(`STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY must not reuse ${name}.`);
        }
    }
}


function decodeMfaManagedKey(
    configured: string | undefined,
    envName: string,
    errors: string[],
    required = false,
): Buffer | null {
    const value = configured?.trim();
    if (!value) {
        if (required) errors.push(`${envName} is required in production and must decode to exactly 32 bytes.`);
        return null;
    }

    let decoded: Buffer;
    if (/^[a-f0-9]{64}$/i.test(value)) {
        decoded = Buffer.from(value, 'hex');
    } else {
        const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
            errors.push(`${envName} must be valid hex or base64 that decodes to exactly 32 bytes.`);
            return null;
        }
        decoded = Buffer.from(normalized, 'base64');
        const canonical = decoded.toString('base64').replace(/=+$/, '');
        if (canonical !== normalized.replace(/=+$/, '')) {
            errors.push(`${envName} must be valid hex or base64 that decodes to exactly 32 bytes.`);
            return null;
        }
    }

    if (decoded.length !== 32) {
        errors.push(`${envName} must decode to exactly 32 bytes.`);
        return null;
    }
    return decoded;
}
