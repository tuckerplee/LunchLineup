import { describe, expect, it } from 'vitest';

import { parseApprovedAppOrigin, safeInternalNavigationPath, safeSameOriginReturnPath } from '../../lib/safe-navigation';

describe('safe navigation policy', () => {
  it('preserves ordinary same-origin state while dropping secret-bearing query values', () => {
    const result = safeSameOriginReturnPath(
      '/dashboard/scheduling',
      '?date=2026-07-14&token=secret-token&callback=https%3A%2F%2Fevil.example%2Fcollect&host=redis.internal',
    );

    expect(result).toBe('/dashboard/scheduling?date=2026-07-14');
    expect(result).not.toContain('secret-token');
    expect(result).not.toContain('evil.example');
    expect(result).not.toContain('redis.internal');
  });

  it.each(['//evil.example/collect', '/\\evil.example/collect', 'https://evil.example/collect'])(
    'rejects an escape-shaped return path: %s',
    (path) => {
      expect(safeSameOriginReturnPath(path)).toBe('/dashboard');
    },
  );

  it('parses complete internal navigation targets and removes sensitive query state', () => {
    expect(safeInternalNavigationPath('/dashboard?focus=open&token=secret')).toBe('/dashboard?focus=open');
    expect(safeInternalNavigationPath('https://evil.example/collect')).toBe('/dashboard');
    expect(safeInternalNavigationPath('/\\evil.example/collect')).toBe('/dashboard');
  });
  it('accepts only credential-free root origins and requires HTTPS for production', () => {
    expect(parseApprovedAppOrigin('https://lunchlineup.com', true)).toBe('https://lunchlineup.com');
    expect(parseApprovedAppOrigin('http://localhost:3000', false)).toBe('http://localhost:3000');
    expect(parseApprovedAppOrigin('http://lunchlineup.com', true)).toBeNull();
    expect(parseApprovedAppOrigin('https://user:pass@lunchlineup.com', true)).toBeNull();
    expect(parseApprovedAppOrigin('https://lunchlineup.com/path?token=secret', true)).toBeNull();
  });
});