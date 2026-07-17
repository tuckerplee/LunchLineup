import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { config, proxy } from '../../proxy';

function makeRequest(path: string, cookie?: string): NextRequest {
  return new NextRequest(new URL(path, 'http://localhost:3100'), {
    headers: cookie ? { cookie } : undefined,
  });
}

function authUser(overrides: Partial<{
  role: string;
  legacyRole: string;
  permissions: string[];
  roles: Array<{ id: string; name: string }>;
}> = {}) {
  return {
    sub: 'user-1',
    role: overrides.role ?? 'Admin',
    legacyRole: overrides.legacyRole ?? 'ADMIN',
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    permissions: overrides.permissions ?? ['dashboard:access', 'shifts:read'],
    roles: overrides.roles ?? [{ id: 'role-1', name: 'Admin' }],
  };
}

describe('web auth proxy', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('preserves the protected route query string in login redirects', async () => {
    const response = await proxy(makeRequest('/dashboard/scheduling?date=2026-07-09&focus=open'));
    const location = response.headers.get('location');

    expect(location).toBeTruthy();
    const redirect = new URL(location ?? '');
    expect(redirect.pathname).toBe('/auth/login');
    expect(redirect.searchParams.get('next')).toBe('/dashboard/scheduling?date=2026-07-09&focus=open');
  });

    it.each(['/privacy', '/security', '/subprocessors'])('allows public legal route %s without authentication', async (path) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await proxy(makeRequest(path));

    expect(response.headers.get('location')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['/robots.txt', '/sitemap.xml', '/opengraph-image'])(
    'allows exact public metadata route %s without authentication',
    async (path) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const response = await proxy(makeRequest(path));

      expect(response.status).toBe(200);
      expect(response.headers.get('location')).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    '/robots.txt/private',
    '/sitemap.xml/private',
    '/opengraph-image/private',
    '/dashboard-preview',
    '/administrator',
    '/definitely-not-a-route',
  ])(
    'leaves unknown route %s to the Next.js 404 without authentication',
    async (path) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const response = await proxy(makeRequest(path));

      expect(response.status).toBe(200);
      expect(response.headers.get('location')).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('scrubs reset tokens into a short-lived path-scoped cookie before rendering', async () => {
    const response = await proxy(makeRequest('/auth/reset-password?token=reset-secret&tenantSlug=e2e-operations'));
    const redirect = new URL(response.headers.get('location') ?? '');
    const setCookie = response.headers.get('set-cookie') ?? '';

    expect(response.status).toBe(303);
    expect(redirect.pathname).toBe('/auth/reset-password');
    expect(redirect.searchParams.get('tenantSlug')).toBe('e2e-operations');
    expect(redirect.searchParams.has('token')).toBe(false);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(setCookie).toContain('ll_password_reset_token=reset-secret');
    expect(setCookie).toContain('Path=/auth/reset-password');
    expect(setCookie.toLowerCase()).toContain('samesite=strict');
  });

  it('matches only protected roots and the reset-token exchange route', () => {
    expect(config.matcher).toEqual([
      '/admin/:path*',
      '/dashboard/:path*',
      '/auth/reset-password',
    ]);
  });

  it('refreshes expired access tokens with the CSRF cookie/header contract', async () => {
    const refreshHeaders = new Headers({ 'content-type': 'application/json' });
    refreshHeaders.append('set-cookie', 'access_token=new-access-token; Path=/; HttpOnly; SameSite=Strict');
    refreshHeaders.append('set-cookie', 'refresh_token=new-refresh-token; Path=/; HttpOnly; SameSite=Strict');
    refreshHeaders.append('set-cookie', 'csrf_token=new-csrf-token; Path=/; SameSite=Strict');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: refreshHeaders,
      }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await proxy(makeRequest('/dashboard', 'access_token=old-access-token; refresh_token=refresh-token; csrf_token=csrf-token'));

    expect(response.headers.get('location')).toBe('http://localhost:3100/dashboard');
    expect(response.headers.get('set-cookie')).toContain('access_token=new-access-token');
    expect(response.headers.get('set-cookie')).toContain('refresh_token=new-refresh-token');
    expect(response.headers.get('set-cookie')).toContain('csrf_token=new-csrf-token');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1][1] as RequestInit).headers).toMatchObject({
      Cookie: 'refresh_token=refresh-token; csrf_token=csrf-token',
      Origin: 'http://localhost:3100',
      Referer: 'http://localhost:3100/dashboard',
      'x-csrf-token': 'csrf-token',
    });
  });

  it('refreshes a hard navigation when the access cookie has expired', async () => {
    const refreshHeaders = new Headers();
    refreshHeaders.append('set-cookie', 'access_token=new-access-token; Path=/; HttpOnly; SameSite=Strict');
    refreshHeaders.append('set-cookie', 'refresh_token=new-refresh-token; Path=/; HttpOnly; SameSite=Strict');
    refreshHeaders.append('set-cookie', 'csrf_token=new-csrf-token; Path=/; SameSite=Strict');
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: refreshHeaders,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await proxy(makeRequest(
      '/dashboard/scheduling?date=2026-07-10',
      'refresh_token=refresh-token; csrf_token=csrf-token',
    ));

    expect(response.headers.get('location')).toBe('http://localhost:3100/dashboard/scheduling?date=2026-07-10');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/auth/refresh');
    expect(response.headers.get('set-cookie')).toContain('refresh_token=new-refresh-token');
  });

  it('fails closed when refresh returns an incomplete cookie rotation', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: {
        'set-cookie': 'access_token=new-access-token; Path=/; HttpOnly; SameSite=Strict',
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await proxy(makeRequest(
      '/dashboard',
      'refresh_token=refresh-token; csrf_token=csrf-token',
    ));

    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/auth/login');
    expect(response.headers.get('set-cookie')).toContain('refresh_token=;');
  });

  it.each([
    ['a network error', () => Promise.reject(new Error('api unavailable'))],
    ['a rate limit', () => Promise.resolve(new Response(null, { status: 429 }))],
    ['an upstream failure', () => Promise.resolve(new Response(null, { status: 502 }))],
    ['an unexpected response', () => Promise.resolve(new Response(null, { status: 418 }))],
  ])('preserves session cookies and fails closed with 503 for %s from auth validation', async (_label, result) => {
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(result));

    const response = await proxy(makeRequest(
      '/dashboard',
      'access_token=access-token; refresh_token=refresh-token; csrf_token=csrf-token',
    ));

    expect(response.status).toBe(503);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('retry-after')).toBe('5');
  });

  it('preserves session cookies when refresh is temporarily unavailable', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await proxy(makeRequest(
      '/dashboard',
      'access_token=old-access-token; refresh_token=refresh-token; csrf_token=csrf-token',
    ));

    expect(response.status).toBe(503);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('clears session cookies after a definitive unauthorized response and rejected refresh', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await proxy(makeRequest(
      '/dashboard',
      'access_token=old-access-token; refresh_token=refresh-token; csrf_token=csrf-token',
    ));

    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/auth/login');
    expect(response.headers.get('set-cookie')).toContain('access_token=;');
    expect(response.headers.get('set-cookie')).toContain('refresh_token=;');
  });

  it('does not call refresh when the CSRF cookie is missing', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await proxy(makeRequest('/dashboard', 'access_token=old-access-token; refresh_token=refresh-token'));

    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/auth/login');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('omits sensitive query values and request metadata from auth debug logs', async () => {
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await proxy(makeRequest('/dashboard?token=secret-token&__auth_debug=1'));

    const logged = JSON.stringify(consoleInfo.mock.calls);
    expect(logged).not.toContain('secret-token');
    expect(logged).not.toContain('__auth_debug');
    expect(logged).not.toContain('localhost:3100');
    expect(logged).toContain('redirect_login_missing_access_token');
  });

  it.each([
    ['schedules:read', ['shifts:read', 'locations:read']],
    ['shifts:read', ['schedules:read', 'locations:read']],
    ['locations:read', ['schedules:read', 'shifts:read']],
    ['all scheduling reads', ['admin_portal:access']],
  ])('redirects authenticated users away from scheduling routes without %s', async (_missing, permissions) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      user: authUser({ permissions: ['dashboard:access', ...permissions] }),
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await proxy(makeRequest('/dashboard/scheduling', 'access_token=valid-access-token'));

    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/dashboard');
  });

  it('allows scheduling routes only with the complete scheduling read contract', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      user: authUser({
        permissions: ['dashboard:access', 'schedules:read', 'shifts:read', 'locations:read'],
      }),
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await proxy(makeRequest('/dashboard/scheduling', 'access_token=valid-access-token'));

    expect(response.headers.get('location')).toBeNull();
    expect((fetchMock.mock.calls[0][1] as RequestInit).redirect).toBe('error');
  });

  it.each([
    ['lunch-break read access', ['locations:read']],
    ['location read access', ['lunch_breaks:read']],
    ['both tenant permissions despite admin portal access', ['admin_portal:access', 'lunch_breaks:read']],
  ])('redirects authenticated users away from lunch-break routes without %s', async (_missing, permissions) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      user: authUser({ permissions: ['dashboard:access', ...permissions] }),
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await proxy(makeRequest('/dashboard/lunch-breaks', 'access_token=valid-access-token'));

    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/dashboard');
  });

  it('allows lunch-break routes with lunch-break and location read access', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      user: authUser({ permissions: ['dashboard:access', 'lunch_breaks:read', 'locations:read'] }),
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await proxy(makeRequest('/dashboard/lunch-breaks', 'access_token=valid-access-token'));

    expect(response.headers.get('location')).toBeNull();
  });
  it('removes secret-bearing query state from browser-visible login redirects', async () => {
    const response = await proxy(makeRequest(
      '/dashboard/scheduling?date=2026-07-14&token=secret-token&callback=https%3A%2F%2Fevil.example%2Fcollect',
    ));
    const redirect = new URL(response.headers.get('location') ?? '');
    const target = redirect.searchParams.get('next') ?? '';

    expect(target).toBe('/dashboard/scheduling?date=2026-07-14');
    expect(target).not.toContain('secret-token');
    expect(target).not.toContain('evil.example');
  });

  it('pins redirects to the configured production origin instead of the request host', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_APP_ORIGIN', 'https://lunchlineup.com');

    const response = await proxy(makeRequest('https://attacker.example/dashboard?focus=open'));
    const redirect = new URL(response.headers.get('location') ?? '');

    expect(redirect.origin).toBe('https://lunchlineup.com');
    expect(redirect.pathname).toBe('/auth/login');
    expect(redirect.searchParams.get('next')).toBe('/dashboard?focus=open');
    expect(response.headers.get('location')).not.toContain('attacker.example');
  });

  it('uses the approved origin and sanitized path for refresh Origin, Referer, and redirect', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_APP_ORIGIN', 'https://lunchlineup.com');
    const refreshHeaders = new Headers();
    refreshHeaders.append('set-cookie', 'access_token=new-access-token; Path=/; HttpOnly; SameSite=Strict');
    refreshHeaders.append('set-cookie', 'refresh_token=new-refresh-token; Path=/; HttpOnly; SameSite=Strict');
    refreshHeaders.append('set-cookie', 'csrf_token=new-csrf-token; Path=/; SameSite=Strict');
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('{}', {
      status: 200,
      headers: refreshHeaders,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await proxy(makeRequest(
      'https://attacker.example/dashboard?date=2026-07-14&token=secret-token',
      'refresh_token=refresh-token; csrf_token=csrf-token',
    ));
    const requestHeaders = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    const serialized = JSON.stringify(requestHeaders);

    expect(requestHeaders.Origin).toBe('https://lunchlineup.com');
    expect(requestHeaders.Referer).toBe('https://lunchlineup.com/dashboard?date=2026-07-14');
    expect((fetchMock.mock.calls[0][1] as RequestInit).redirect).toBe('error');
    expect(response.headers.get('location')).toBe('https://lunchlineup.com/dashboard?date=2026-07-14');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('attacker.example');
  });

  it('classifies proxy exceptions without logging raw URLs, tokens, headers, or stack text', async () => {
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error(
      'Fetch https://api.internal/auth?token=secret-token Authorization: Bearer hidden\n    at internal stack',
    )));

    const response = await proxy(makeRequest(
      '/dashboard?__auth_debug=1',
      'access_token=access-token; refresh_token=refresh-token; csrf_token=csrf-token',
    ));
    const logged = JSON.stringify(consoleInfo.mock.calls);

    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Authentication service temporarily unavailable. Please retry.');
    expect(logged).toContain('failureCategory');
    expect(logged).toContain('network');
    expect(logged).not.toContain('secret-token');
    expect(logged).not.toContain('api.internal');
    expect(logged).not.toContain('Bearer hidden');
    expect(logged).not.toContain('internal stack');
  });

  it('fails closed on malformed successful auth payloads instead of forwarding identity headers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      user: {
        ...authUser(),
        sub: 'user-1\r\nx-user-role: SUPER_ADMIN',
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    const response = await proxy(makeRequest('/dashboard', 'access_token=access-token'));

    expect(response.status).toBe(503);
    expect(response.headers.get('x-user-id')).toBeNull();
    expect(response.headers.get('x-user-role')).toBeNull();
    expect(await response.text()).toBe('Authentication service temporarily unavailable. Please retry.');
  });

  it.each([
    ['Admin', 'ADMIN'],
    ['Manager', 'MANAGER'],
    ['Staff', 'STAFF'],
    ['System Admin', 'SUPER_ADMIN'],
    ['Payroll Coordinator', 'STAFF'],
  ])('forwards canonical role %s/%s without promoting the RBAC display name', async (role, legacyRole) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      user: authUser({ role, legacyRole, permissions: ['dashboard:access', 'payroll:read'] }),
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    const response = await proxy(makeRequest('/dashboard/payroll', 'access_token=access-token'));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-request-x-user-role')).toBe(legacyRole);
    expect(response.headers.get('x-middleware-request-x-user-permissions')).toContain('payroll:read');
  });

  it('accepts delimiter-bearing API role names and forwards only bounded role IDs', async () => {
    const roleName = 'Payroll, Closing | Lead / West';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      user: authUser({
        role: roleName,
        legacyRole: 'STAFF',
        permissions: ['dashboard:access', 'payroll:read'],
        roles: [
          { id: 'role-payroll-closing', name: roleName },
          { id: 'role-audit', name: 'Audit; Export' },
        ],
      }),
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    const response = await proxy(makeRequest('/dashboard/payroll', 'access_token=access-token'));
    const forwardedRoles = response.headers.get('x-middleware-request-x-user-roles');

    expect(response.status).toBe(200);
    expect(forwardedRoles).toBe('role-payroll-closing,role-audit');
    expect(forwardedRoles).not.toContain(roleName);
    expect(response.headers.get('x-middleware-request-x-user-role')).toBe('STAFF');
  });

  it.each([
    ['primary role name', { role: 'Payroll\r\nx-user-role: SUPER_ADMIN' }],
    ['assigned role name', { roles: [{ id: 'role-1', name: 'Payroll\nLead' }] }],
  ])('tolerates legacy control-bearing %s while forwarding only canonical role ids', async (_label, overrides) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      user: authUser(overrides),
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    const response = await proxy(makeRequest('/dashboard', 'access_token=access-token'));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-request-x-user-roles')).toBe('role-1');
    expect(response.headers.get('x-middleware-request-x-user-role')).toBe('ADMIN');
    expect(JSON.stringify([...response.headers])).not.toContain('Payroll\nLead');
    expect(JSON.stringify([...response.headers])).not.toContain('SUPER_ADMIN');
  });

  it('rejects a delimiter-bearing assigned role id before forwarding identity headers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      user: authUser({ roles: [{ id: 'role-1,role-admin', name: 'Payroll Lead' }] }),
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    const response = await proxy(makeRequest('/dashboard', 'access_token=access-token'));

    expect(response.status).toBe(503);
    expect(response.headers.get('x-middleware-request-x-user-roles')).toBeNull();
    expect(response.headers.get('x-middleware-request-x-user-role')).toBeNull();
  });

  it('accepts exactly 100 assigned role ids without locking out the protected route', async () => {
    const roles = Array.from({ length: 100 }, (_, index) => ({
      id: `role-${index + 1}`,
      name: `Role ${index + 1}`,
    }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      user: authUser({ roles }),
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    const response = await proxy(makeRequest('/dashboard', 'access_token=access-token'));
    const forwardedRoleIds = response.headers.get('x-middleware-request-x-user-roles')?.split(',') ?? [];

    expect(response.status).toBe(200);
    expect(forwardedRoleIds).toEqual(roles.map((role) => role.id));
  });

  it('rejects 101 assigned roles before constructing an unbounded identity header', async () => {
    const roles = Array.from({ length: 101 }, (_, index) => ({
      id: `role-${index + 1}`,
      name: `Role ${index + 1}`,
    }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      user: authUser({ roles }),
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    const response = await proxy(makeRequest('/dashboard', 'access_token=access-token'));

    expect(response.status).toBe(503);
    expect(response.headers.get('x-middleware-request-x-user-roles')).toBeNull();
  });

  it.each(['Admin', 'admin', 'STAFF\u0130', 'SUPER_ADMIN\r\nx-user-role: SUPER_ADMIN']) (
    'rejects non-canonical or unsafe legacy role %s',
    async (legacyRole) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
        user: authUser({ role: 'Custom Payroll Role', legacyRole }),
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })));

      const response = await proxy(makeRequest('/dashboard', 'access_token=access-token'));

      expect(response.status).toBe(503);
      expect(response.headers.get('x-middleware-request-x-user-role')).toBeNull();
    },
  );

  it('fails closed with a generic response when the configured production origin is unsafe', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_APP_ORIGIN', 'https://user:secret@lunchlineup.com');

    const response = await proxy(makeRequest('https://attacker.example/dashboard'));
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get('location')).toBeNull();
    expect(body).toBe('Authentication service temporarily unavailable. Please retry.');
    expect(body).not.toContain('user:secret');
    expect(body).not.toContain('attacker.example');
  });
  it('fails closed when auth validation exceeds the proxy deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    })));

    const pending = proxy(makeRequest('/dashboard', 'access_token=access-token'));
    await vi.advanceTimersByTimeAsync(5_000);
    const response = await pending;

    expect(response.status).toBe(503);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('fails closed before parsing an oversized auth payload', async () => {
    const oversized = JSON.stringify({ user: authUser(), padding: 'x'.repeat(64 * 1024) });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(oversized, {
      status: 200,
      headers: {
        'content-length': String(oversized.length),
        'content-type': 'application/json',
      },
    })));

    const response = await proxy(makeRequest('/dashboard', 'access_token=access-token'));

    expect(response.status).toBe(503);
    expect(response.headers.get('x-user-id')).toBeNull();
  });


});
