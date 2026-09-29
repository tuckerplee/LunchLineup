import { afterEach, describe, expect, it, vi } from 'vitest';
import { approvedServerAppOrigin } from '../../lib/server-app-origin';

const origin = 'http://127.0.0.1:8080';
function disposableQa() {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('LUNCHLINEUP_DEVELOPMENT_QA', '1');
  vi.stubEnv('DATA_TARGET_ENV', 'disposable');
  vi.stubEnv('APP_ENV', 'test');
  vi.stubEnv('DEPLOY_ENV', 'test');
}
afterEach(() => vi.unstubAllEnvs());

describe('server application origin policy', () => {
  it('admits only the exact disposable loopback origin in an optimized production build', () => {
    disposableQa();
    expect(approvedServerAppOrigin(origin, 'http://untrusted.example')).toBe(origin);
  });

  it.each([
    undefined, '', 'http://lunchlineup.com', 'http://localhost:8080',
    'http://api-v2:8080', 'http://127.0.0.1', 'http://127.0.0.1:8081',
    'http://127.1:8080', 'http://2130706433:8080', 'http://127.0.0.1:08080',
    'http://user:pass@127.0.0.1:8080', 'http://127.0.0.1:8080/',
    'http://127.0.0.1:8080/path', 'http://127.0.0.1:8080?x=1',
    'http://127.0.0.1:8080#fragment', ' http://127.0.0.1:8080 ',
    'https://lunchlineup.com',
  ])('rejects QA origin %s without falling back to the request origin', (candidate) => {
    disposableQa();
    expect(approvedServerAppOrigin(candidate, origin)).toBeNull();
  });

  it.each([
    ['LUNCHLINEUP_DEVELOPMENT_QA', 'true'], ['LUNCHLINEUP_DEVELOPMENT_QA', ''],
    ['LUNCHLINEUP_DEVELOPMENT_QA', '2'], ['DATA_TARGET_ENV', undefined],
    ['DATA_TARGET_ENV', 'production'], ['DATA_TARGET_ENV', 'test'],
    ['APP_ENV', undefined], ['APP_ENV', 'production'],
    ['DEPLOY_ENV', undefined], ['DEPLOY_ENV', 'production'],
  ])('rejects a missing or invalid server marker %s=%s', (key, value) => {
    disposableQa();
    vi.stubEnv(key, value);
    expect(approvedServerAppOrigin(origin, origin)).toBeNull();
  });

  it.each([undefined, '0'])('keeps production HTTPS mandatory with QA flag %s', (flag) => {
    disposableQa();
    vi.stubEnv('LUNCHLINEUP_DEVELOPMENT_QA', flag);
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'test');
    expect(approvedServerAppOrigin(origin, origin)).toBeNull();
    expect(approvedServerAppOrigin('http://lunchlineup.com', origin)).toBeNull();
    expect(approvedServerAppOrigin(undefined, origin)).toBeNull();
    expect(approvedServerAppOrigin('https://lunchlineup.com', origin)).toBe('https://lunchlineup.com');
  });

  it('preserves ordinary nonproduction configuration and request-origin fallback', () => {
    vi.stubEnv('LUNCHLINEUP_DEVELOPMENT_QA', undefined);
    vi.stubEnv('NODE_ENV', 'development');
    expect(approvedServerAppOrigin(' http://localhost:3100 ', origin)).toBe('http://localhost:3100');
    expect(approvedServerAppOrigin(undefined, 'http://localhost:3100')).toBe('http://localhost:3100');
  });
});
