import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readWebFile = (path: string) => readFileSync(resolve(__dirname, '../../', path), 'utf8');

describe('validated public-web P1 contracts', () => {
  it('uses retryable JSON login verification and navigates only after explicit success', () => {
    const source = readWebFile('app/auth/login/page.tsx');

    expect(source).toContain("'/auth/email/verify-otp'");
    expect(source).toContain("'/auth/pin/verify'");
    expect(source).toContain("'/auth/password/verify'");
    expect(source).toContain("headers: { 'Content-Type': 'application/json' }");
    expect(source).toContain('body: JSON.stringify(payload)');
    expect(source).toContain('if (!response.ok || data.success !== true)');
    expect(source).toContain('router.push(redirectTo)');
    expect(source).toContain('verifyInFlightRef.current = false');
    expect(source).not.toContain("document.createElement('form')");
    expect(source).not.toContain('redirect=1');
  });

  it('scrubs reset tokens and keeps transient failures distinct from invalid links', () => {
    const page = readWebFile('app/auth/reset-password/page.tsx');
    const proxy = readWebFile('proxy.ts');

    expect(page).toContain('window.history.replaceState');
    expect(page).toContain('readResetTokenCookie()');
    expect(page).toContain('clearResetTokenCookie()');
    expect(page).toContain('body: JSON.stringify({ token, password })');
    expect(page).toContain("status === 429");
    expect(page).toContain("status >= 500");
    expect(page).toContain("'Reset link is invalid or expired.'");
    expect(proxy).toContain("NextResponse.redirect(new URL(cleanPath, resetOrigin), 303)");
    expect(proxy).toContain("response.headers.set('Referrer-Policy', 'no-referrer')");
  });

  it('keeps branded status fallbacks in the login and MFA suspense boundaries', () => {
    for (const path of ['app/auth/login/page.tsx', 'app/mfa/page.tsx']) {
      const source = readWebFile(path);
      expect(source).toContain('role="status"');
      expect(source).toContain('<LunchLineupMark');
      expect(source).not.toContain('fallback={<div style={{ minHeight');
    }
  });

  it('renders failed dashboard data as unavailable with retry instead of zero-valued snapshots', () => {
    const source = readWebFile('app/dashboard/DashboardWorkspace.tsx');

    expect(source).toContain('type FetchResult<T>');
    expect(source).toContain("{ ok: false }");
    expect(source).toContain("'Unavailable'");
    expect(source).toContain('Retry to refresh affected widgets.');
    expect(source).toContain('if (loadGeneration !== loadGenerationRef.current) return;');
    expect(source).not.toContain('fetchJsonOrNull');
    expect(source).not.toContain('const data = overview ?? {');
    expect(source).not.toContain('overview?.openShiftCount ?? 0');
    expect(source).not.toContain('overview?.coveragePercent ?? 0');
    expect(source).not.toContain('overview?.lunchPlanCount ?? 0');
  });

  it('keeps payroll navigation while removing unbacked numeric nav badges', () => {
    const navigation = readWebFile('app/dashboard/dashboard-navigation.ts');
    const layout = readWebFile('app/dashboard/layout.tsx');

    expect(navigation).toContain("href: '/dashboard/payroll'");
    expect(navigation).toContain('capabilities.canReadPayroll');
    expect(navigation).not.toContain('badge?:');
    expect(navigation).not.toMatch(/badge:\s*\d/);
    expect(layout).not.toContain('item.badge');
  });
});
