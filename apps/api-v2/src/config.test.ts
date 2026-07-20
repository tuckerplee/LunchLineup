import { describe, expect, it } from 'vitest';
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

  it('accepts bounded hop counts and explicit IP or CIDR networks', () => {
    expect(config('2').trustProxy).toBe(2);
    expect(config('127.0.0.1, 10.0.0.0/8, fd00::/8').trustProxy).toEqual([
      '127.0.0.1',
      '10.0.0.0/8',
      'fd00::/8',
    ]);
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
