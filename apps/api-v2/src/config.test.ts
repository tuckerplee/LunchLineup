import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

function config(trustProxy: string) {
  return loadConfig({
    APP_ORIGIN: 'https://beta.lunchlineup.com',
    LEGACY_IDENTITY_URL: 'http://api:3000/v1/auth/me',
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
});
