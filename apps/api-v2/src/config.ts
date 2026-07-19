import { isIP } from 'node:net';

export type ApiV2Config = {
  port: number;
  host: string;
  appOrigin: string;
  allowedOrigins: ReadonlySet<string>;
  legacyApiBaseUrl: string;
  authStateTimeoutMs: number;
  legacyRequestTimeoutMs: number;
  jwtSecret: string;
  redisUrl: string;
  cookieSecure: boolean;
  releaseSha: string;
  trustProxy: boolean | number | string[];
  logLevel: string;
};

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function requiredHttpUrl(value: string | undefined, name: string): URL {
  if (!value?.trim()) throw new Error(`${name} is required.`);
  const parsed = new URL(value.trim());
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`${name} must be an HTTP(S) URL without embedded credentials.`);
  }
  return parsed;
}

function requiredSecret(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function redisUrl(value: string | undefined): string {
  const candidate = value?.trim() || 'redis://redis:6379';
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('REDIS_URL must be a valid redis:// or rediss:// URL.');
  }
  if (!['redis:', 'rediss:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('REDIS_URL must be a valid redis:// or rediss:// URL.');
  }
  return parsed.toString();
}

function cookieSecure(value: string | undefined, nodeEnvironment: string | undefined): boolean {
  if (value === undefined) return nodeEnvironment === 'production';
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error('COOKIE_SECURE must be a boolean value.');
}

function normalizedOrigin(value: string): string {
  const parsed = requiredHttpUrl(value, 'origin');
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Origins cannot contain a path, query, or fragment.');
  }
  return parsed.origin;
}

function releaseSha(value: string | undefined): string {
  const normalized = value?.trim() || 'local';
  if (normalized !== 'local' && !/^[a-f0-9]{40}$/.test(normalized)) {
    throw new Error('DEPLOY_RELEASE_SHA must be a full lowercase Git SHA or local.');
  }
  return normalized;
}

const TRUST_PROXY_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal']);

function trustedNetwork(value: string): boolean {
  if (TRUST_PROXY_RANGES.has(value)) return true;
  const segments = value.split('/');
  if (segments.length > 2) return false;
  const family = isIP(segments[0] ?? '');
  if (family === 0) return false;
  if (segments.length === 1) return true;
  const prefix = segments[1] ?? '';
  if (!/^\d+$/.test(prefix)) return false;
  const bits = Number(prefix);
  return bits >= 0 && bits <= (family === 4 ? 32 : 128);
}

function trustProxy(value: string | undefined): boolean | number | string[] {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'false' || normalized === '0') return false;
  if (normalized === 'true') return 1;
  if (/^\d+$/.test(normalized)) return boundedInteger(normalized, 1, 1, 10);

  const networks = normalized.split(',').map((entry) => entry.trim());
  if (networks.some((entry) => !trustedNetwork(entry))) {
    throw new Error(
      'TRUST_PROXY must be false, a hop count from 1 to 10, or a comma-separated list of trusted named networks, IP addresses, or CIDRs.',
    );
  }
  return networks;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiV2Config {
  const appOrigin = normalizedOrigin(env.APP_ORIGIN ?? 'http://localhost:3000');
  const origins = new Set<string>([appOrigin]);
  for (const entry of (env.ALLOWED_ORIGINS ?? '').split(',')) {
    if (entry.trim()) origins.add(normalizedOrigin(entry.trim()));
  }
  const legacyApiBaseUrl = requiredHttpUrl(
    env.LEGACY_API_BASE_URL ?? 'http://api:3000/v1',
    'LEGACY_API_BASE_URL',
  );
  if (
    !['/v1', '/v1/'].includes(legacyApiBaseUrl.pathname)
    || legacyApiBaseUrl.search
    || legacyApiBaseUrl.hash
  ) {
    throw new Error('LEGACY_API_BASE_URL must target the exact /v1 compatibility base.');
  }

  return {
    port: boundedInteger(env.PORT, 3002, 1, 65535),
    host: env.HOST?.trim() || '0.0.0.0',
    appOrigin,
    allowedOrigins: origins,
    legacyApiBaseUrl: legacyApiBaseUrl.toString().replace(/\/+$/, ''),
    authStateTimeoutMs: boundedInteger(env.AUTH_STATE_TIMEOUT_MS, 5000, 250, 15_000),
    legacyRequestTimeoutMs: boundedInteger(env.LEGACY_REQUEST_TIMEOUT_MS, 15_000, 1000, 30_000),
    jwtSecret: requiredSecret(env.JWT_SECRET, 'JWT_SECRET'),
    redisUrl: redisUrl(env.REDIS_URL),
    cookieSecure: cookieSecure(env.COOKIE_SECURE, env.NODE_ENV),
    releaseSha: releaseSha(env.DEPLOY_RELEASE_SHA ?? env.IMAGE_TAG),
    trustProxy: trustProxy(env.TRUST_PROXY),
    logLevel: env.LOG_LEVEL?.trim() || 'info',
  };
}
