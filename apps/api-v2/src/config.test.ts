import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { loadConfig } from './config';

function config(trustProxy: string) {
  return loadConfig({
    APP_ORIGIN: 'https://beta.lunchlineup.com',
    LEGACY_API_BASE_URL: 'http://api:3000/v1',
    JWT_SECRET: 'test-api-v2-jwt-secret',
    TRUST_PROXY: trustProxy,
  });
}

describe('API v2 runtime configuration', () => {
  it('accepts the explicit named proxy networks used by the hardened deployment', () => {
    expect(config('loopback, linklocal, uniquelocal').trustProxy).toEqual([
      'loopback',
      'linklocal',
      'uniquelocal',
    ]);
  });

  it('accepts explicit IP or CIDR networks', () => {
    expect(config('127.0.0.1, 10.0.0.0/8, fd00::/8').trustProxy).toEqual([
      '127.0.0.1',
      '10.0.0.0/8',
      'fd00::/8',
    ]);
  });

  it('rejects permissive or unsupported hop-only proxy settings with actionable guidance', () => {
    for (const value of ['true', '1', '2', '10', '11']) {
      expect(() => config(value)).toThrow(/TRUST_PROXY.*trusted named networks, IP addresses, or CIDRs/);
    }
    for (const value of ['', 'false', '0']) expect(config(value).trustProxy).toBe(false);
  });

  it.each([
    ['false', '127.0.0.1', '127.0.0.1'],
    ['127.0.0.1', '127.0.0.1', '198.51.100.2'],
    ['127.0.0.1', '203.0.113.9', '203.0.113.9'],
  ])('uses forwarded IP only behind an explicitly trusted peer (%s, %s)', async (setting, peer, expectedIp) => {
    const app = Fastify({ trustProxy: config(setting).trustProxy });
    app.get('/proxy-proof', request => ({ ip: request.ip }));
    try {
      const response = await app.inject({ method: 'GET', url: '/proxy-proof', remoteAddress: peer,
        headers: { 'x-forwarded-for': '192.0.2.1, 198.51.100.2' } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ip: expectedIp });
    } finally {
      await app.close();
    }
  });

  it('rejects wildcards and invalid CIDR ranges', () => {
    expect(() => config('*')).toThrow(/TRUST_PROXY/);
    expect(() => config('10.0.0.0/99')).toThrow(/TRUST_PROXY/);
  });

  it('requires the shared access-token secret and validates the MFA session-store URL', () => {
    expect(() => loadConfig({
      APP_ORIGIN: 'https://beta.lunchlineup.com',
      LEGACY_API_BASE_URL: 'http://api:3000/v1',
    })).toThrow('JWT_SECRET is required.');
    expect(() => loadConfig({
      APP_ORIGIN: 'https://beta.lunchlineup.com',
      LEGACY_API_BASE_URL: 'http://api:3000/v1',
      JWT_SECRET: 'test-api-v2-jwt-secret',
      REDIS_URL: 'https://not-redis.example',
    })).toThrow('REDIS_URL');
    expect(() => loadConfig({
      APP_ORIGIN: 'https://beta.lunchlineup.com',
      LEGACY_API_BASE_URL: 'http://api:3000/v1/auth/me',
      JWT_SECRET: 'test-api-v2-jwt-secret',
    })).toThrow('LEGACY_API_BASE_URL');
  });

  it('shares the bounded invitation retry ceiling with the delivery worker', () => {
    expect(loadConfig({
      APP_ORIGIN: 'https://beta.lunchlineup.com',
      LEGACY_API_BASE_URL: 'http://api:3000/v1',
      JWT_SECRET: 'test-api-v2-jwt-secret',
      STAFF_INVITATION_MAX_ATTEMPTS: '3',
    }).staffInvitationMaxAttempts).toBe(3);
    expect(() => loadConfig({
      APP_ORIGIN: 'https://beta.lunchlineup.com',
      LEGACY_API_BASE_URL: 'http://api:3000/v1',
      JWT_SECRET: 'test-api-v2-jwt-secret',
      STAFF_INVITATION_MAX_ATTEMPTS: '9',
    })).toThrow(/integer between 1 and 8/);
  });

  it('permits internal beta entitlements only on the exact beta origin', () => {
    expect(() => loadConfig({
      APP_ORIGIN: 'https://beta.lunchlineup.com',
      LEGACY_API_BASE_URL: 'http://api:3000/v1',
      JWT_SECRET: 'test-api-v2-jwt-secret',
      INTERNAL_BETA_ENTITLEMENTS_ENABLED: 'true',
    })).not.toThrow();
    expect(() => loadConfig({
      APP_ORIGIN: 'https://app.lunchlineup.com',
      LEGACY_API_BASE_URL: 'http://api:3000/v1',
      JWT_SECRET: 'test-api-v2-jwt-secret',
      INTERNAL_BETA_ENTITLEMENTS_ENABLED: 'true',
    })).toThrow(/INTERNAL_BETA_ENTITLEMENTS_ENABLED/);
    expect(() => loadConfig({
      APP_ORIGIN: 'https://beta.lunchlineup.com',
      LEGACY_API_BASE_URL: 'http://api:3000/v1',
      JWT_SECRET: 'test-api-v2-jwt-secret',
      INTERNAL_BETA_ENTITLEMENTS_ENABLED: 'sometimes',
    })).toThrow(/boolean/);
  });

  it('only permits SSO-only workspace policy when every OIDC dependency is configured', () => {
    expect(loadConfig({
      APP_ORIGIN: 'https://beta.lunchlineup.com',
      LEGACY_API_BASE_URL: 'http://api:3000/v1',
      JWT_SECRET: 'test-api-v2-jwt-secret',
    }).oidcSsoAvailable).toBe(false);
    expect(loadConfig({
      APP_ORIGIN: 'https://beta.lunchlineup.com',
      LEGACY_API_BASE_URL: 'http://api:3000/v1',
      JWT_SECRET: 'test-api-v2-jwt-secret',
      OIDC_ENABLED: 'true',
      NEXT_PUBLIC_OIDC_ENABLED: 'true',
      OIDC_ISSUER_URL: 'https://issuer.example.test',
      OIDC_CLIENT_ID: 'client-id',
      OIDC_CLIENT_SECRET: 'client-secret',
      OIDC_REDIRECT_URI: 'https://beta.lunchlineup.com/auth/callback',
    }).oidcSsoAvailable).toBe(true);
  });
});
