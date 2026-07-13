import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET } from '../../app/auth/logout/route';

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

afterEach(() => {
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
});
