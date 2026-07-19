import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PendingFirstLocation } from '../../app/onboarding/first-location-recovery';
import { provisionPendingFirstLocation } from '../../app/onboarding/first-location-transport';

function pendingLocation(requestKey: string): PendingFirstLocation {
  return {
    requestKey,
    workspaceSlug: 'acme-dining',
    tenantName: 'Acme Dining',
    firstLocationName: 'Downtown Bistro',
    timezone: 'America/Los_Angeles',
    createdAt: 1_000,
  };
}

function headersFromCall(call: unknown[]): Headers {
  return (call[1] as RequestInit).headers as Headers;
}

describe('first-location authenticated transport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('refreshes once and replays a 401 location POST with the same stable key and body', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('{"id":"location-1"}', { status: 201, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('document', { cookie: 'csrf_token=refresh-csrf' });

    const response = await provisionPendingFirstLocation(pendingLocation('first-location-key'));

    expect(response.status).toBe(201);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      '/api/v2/locations',
      '/api/v2/auth/refresh',
      '/api/v2/locations',
    ]);
    expect(headersFromCall(fetchMock.mock.calls[0]).get('Idempotency-Key')).toBe('first-location-key');
    expect(headersFromCall(fetchMock.mock.calls[2]).get('Idempotency-Key')).toBe('first-location-key');
    expect((fetchMock.mock.calls[2][1] as RequestInit).body).toBe((fetchMock.mock.calls[0][1] as RequestInit).body);
  });

  it('coalesces concurrent location refreshes and preserves each request key', async () => {
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let refreshCalls = 0;
    const attempts = new Map<string, number>();
    const documentState = { cookie: 'csrf_token=csrf-old' };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/auth/refresh')) {
        refreshCalls += 1;
        await refreshGate;
        documentState.cookie = 'csrf_token=csrf-new';
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }

      const key = new Headers(init?.headers).get('Idempotency-Key') ?? '';
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);
      return new Response(attempt === 1 ? '{}' : '{"id":"location-1"}', {
        status: attempt === 1 ? 401 : 201,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('document', documentState);

    const first = provisionPendingFirstLocation(pendingLocation('location-key-1'));
    const second = provisionPendingFirstLocation(pendingLocation('location-key-2'));

    await vi.waitFor(() => expect(refreshCalls).toBe(1));
    releaseRefresh?.();
    const responses = await Promise.all([first, second]);

    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(refreshCalls).toBe(1);
    expect(attempts).toEqual(new Map([
      ['location-key-1', 2],
      ['location-key-2', 2],
    ]));
    const replayKeys = fetchMock.mock.calls
      .filter((call) => String(call[0]).endsWith('/locations') && headersFromCall(call).get('x-csrf-token') === 'csrf-new')
      .map((call) => headersFromCall(call).get('Idempotency-Key'))
      .sort();
    expect(replayKeys).toEqual(['location-key-1', 'location-key-2']);
  });

  it('fails safely when refresh is rejected without replaying the location or OTP writes', async () => {
    const assign = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('document', { cookie: 'csrf_token=refresh-csrf' });
    vi.stubGlobal('window', {
      location: {
        pathname: '/onboarding',
        search: '?resume=first-location',
        assign,
      },
    });

    const response = await provisionPendingFirstLocation(pendingLocation('first-location-key'));

    expect(response.status).toBe(401);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      '/api/v2/locations',
      '/api/v2/auth/refresh',
    ]);
    expect(assign).toHaveBeenCalledWith('/auth/login?next=%2Fonboarding%3Fresume%3Dfirst-location');
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('verify-otp'))).toBe(false);
  });

  it('rejects a location write without a stable idempotency key before transport', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(provisionPendingFirstLocation(pendingLocation('   '))).rejects.toThrow(
      'Idempotency-Key cannot be blank.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
