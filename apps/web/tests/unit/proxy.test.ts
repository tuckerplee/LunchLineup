import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { proxy } from '../../proxy';

function makeRequest(path: string, cookie?: string): NextRequest {
  return new NextRequest(new URL(path, 'http://localhost:3100'), {
    headers: cookie ? { cookie } : undefined,
  });
}

function authUser(overrides: Partial<{ permissions: string[] }> = {}) {
  return {
    sub: 'user-1',
    role: 'ADMIN',
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    permissions: overrides.permissions ?? ['dashboard:access', 'shifts:read'],
    roles: [{ id: 'role-1', name: 'Admin' }],
  };
}

describe('web auth proxy', () => {
  afterEach(() => {
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

  it('redacts sensitive query values from auth debug logs', async () => {
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await proxy(makeRequest('/dashboard?token=secret-token&__auth_debug=1'));

    const logged = JSON.stringify(consoleInfo.mock.calls);
    expect(logged).not.toContain('secret-token');
    expect(logged).toContain('REDACTED');
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
});
