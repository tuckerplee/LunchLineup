import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET, POST } from '../../app/auth/logout/route';

function logoutRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:3100/auth/logout', {
    headers: {
      cookie: 'access_token=expired; refresh_token=refresh-1; csrf_token=csrf-1',
      referer: 'http://localhost:3100/dashboard',
      'sec-fetch-site': 'same-origin',
      ...headers,
    },
  });
}

function accountDeletionLogoutRequest(
  headers: Record<string, string> = {},
  url = 'http://localhost:3100/auth/logout',
): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: {
      cookie: 'access_token=revoked; refresh_token=revoked-refresh; csrf_token=csrf-1',
      origin: 'http://localhost:3100',
      referer: 'http://localhost:3100/dashboard/settings',
      'sec-fetch-site': 'same-origin',
      'x-account-deletion-complete': '1',
      ...headers,
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('logout route', () => {
  it.each(['revoked', 'already_invalid'])('clears cookies after %s confirmation', async (session) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, session }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await GET(logoutRequest());

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3100/auth/login');
    expect(response.headers.get('set-cookie')).toContain('access_token=');
    expect(response.headers.get('set-cookie')).toContain('refresh_token=');
    expect(response.headers.get('set-cookie')).toContain('csrf_token=');
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:3100/api/v1/auth/logout', expect.objectContaining({
      method: 'POST',
      cache: 'no-store',
      headers: expect.objectContaining({
        cookie: 'access_token=expired; refresh_token=refresh-1; csrf_token=csrf-1',
        'x-csrf-token': 'csrf-1',
        Origin: 'http://localhost:3100',
        Referer: 'http://localhost:3100/auth/logout',
      }),
    }));
  });

  it('preserves cookies when revocation is not authoritative', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    ));

    const response = await GET(logoutRequest());

    expect(response.status).toBe(503);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('preserves cookies when the auth API is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unavailable')));

    const response = await GET(logoutRequest());

    expect(response.status).toBe(503);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('rejects cross-origin navigation before calling the auth API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await GET(logoutRequest({
      referer: 'https://evil.example.com/',
      'sec-fetch-site': 'cross-site',
    }));

    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clears browser cookies after account deletion without calling the auth API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(accountDeletionLogoutRequest());

    expect(response.status).toBe(204);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toContain('access_token=');
    expect(response.headers.get('set-cookie')).toContain('refresh_token=');
    expect(response.headers.get('set-cookie')).toContain('csrf_token=');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the forwarded browser host when Next exposes an internal request URL', async () => {
    const response = await POST(accountDeletionLogoutRequest({
      host: '127.0.0.1:4668',
      origin: 'http://127.0.0.1:4668',
      referer: 'http://127.0.0.1:4668/dashboard/settings',
    }, 'http://localhost:3000/auth/logout'));

    expect(response.status).toBe(204);
    expect(response.headers.get('set-cookie')).toContain('access_token=');
  });

  it('rejects cross-origin account deletion cleanup', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(accountDeletionLogoutRequest({
      origin: 'https://evil.example.com',
      referer: 'https://evil.example.com/',
      'sec-fetch-site': 'cross-site',
    }));

    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('forwards only the three authentication cookies to the logout API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      session: 'revoked',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await GET(logoutRequest({
      cookie: 'access_token=access; refresh_token=refresh; csrf_token=csrf; analytics_id=private-value',
    }));

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.cookie).toContain('access_token=access');
    expect(headers.cookie).toContain('refresh_token=refresh');
    expect(headers.cookie).toContain('csrf_token=csrf');
    expect(headers.cookie).not.toContain('analytics_id');
    expect(headers.cookie).not.toContain('private-value');
  });

  it('fails closed when the configured production application origin is invalid', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_APP_ORIGIN', 'http://lunchlineup.com');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await GET(logoutRequest());

    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves credentials when logout exceeds the server deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    })));

    const pending = GET(logoutRequest());
    await vi.advanceTimersByTimeAsync(5_000);
    const response = await pending;

    expect(response.status).toBe(503);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('preserves credentials when logout confirmation exceeds the body limit', async () => {
    const oversized = JSON.stringify({
      success: true,
      session: 'revoked',
      padding: 'x'.repeat(8 * 1024),
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(oversized, {
      status: 200,
      headers: {
        'content-length': String(oversized.length),
        'content-type': 'application/json',
      },
    })));

    const response = await GET(logoutRequest());

    expect(response.status).toBe(503);
    expect(response.headers.get('set-cookie')).toBeNull();
  });


});
