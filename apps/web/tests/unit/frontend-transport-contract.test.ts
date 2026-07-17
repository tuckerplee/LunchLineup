import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readWebFile = (path: string) => readFileSync(resolve(__dirname, '../../', path), 'utf8');

describe('public-launch frontend transport contracts', () => {
  it.each([
    'app/auth/login/page.tsx',
    'app/auth/reset-password/page.tsx',
    'app/auth/reset-pin/page.tsx',
    'app/mfa/page.tsx',
    'app/onboarding/page.tsx',
  ])('routes public API calls through the bounded same-origin helper in %s', (path) => {
    const source = readWebFile(path);
    expect(source).toContain('fetchPublicApi');
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });

  it.each([
    'app/status/health.ts',
    'app/auth/logout/route.ts',
    'app/dashboard/settings/AccountLifecyclePanel.tsx',
    'proxy.ts',
  ])('wraps the unavoidable direct fetch in a deadline in %s', (path) => {
    const source = readWebFile(path);
    expect(source).toContain('withRequestTimeout');
  });

  it('keeps MFA continuation same-origin and prevents a self-redirect loop', () => {
    const source = readWebFile('app/mfa/page.tsx');
    expect(source).toContain("safeInternalNavigationPath(searchParams.get('next'))");
    expect(source).toContain("requestedNextPath === '/mfa' || requestedNextPath.startsWith('/mfa?')");
  });
  it('provides recoverable root render and loading states without exposing raw errors', () => {
    const segmentError = readWebFile('app/error.tsx');
    const globalError = readWebFile('app/global-error.tsx');
    const loading = readWebFile('app/loading.tsx');

    expect(segmentError).toContain('onClick={reset}');
    expect(segmentError).not.toContain('error.message');
    expect(globalError).toContain('onClick={reset}');
    expect(globalError).not.toContain('error.message');
    expect(loading).toContain('role="status"');
  });

  it('tests sensitive proxy diagnostics by omission, not by requiring a redaction marker', () => {
    const proxyTest = readWebFile('tests/unit/proxy.test.ts');
    expect(proxyTest).toContain("expect(logged).not.toContain('secret-token')");
    expect(proxyTest).not.toMatch(/expect\([^\n]+\)\.toContain\(['"]\[REDACTED\]/);
  });
});
