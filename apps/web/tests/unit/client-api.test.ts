import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchWithSession,
  idempotentRequestAttempt,
  withIdempotencyKey,
} from '../../lib/client-api';

function headersFromCall(call: unknown[]): Headers {
  const init = call[1] as RequestInit;
  return init.headers as Headers;
}

describe('fetchWithSession', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('adds the CSRF cookie token to unsafe same-origin API requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('document', { cookie: 'csrf_token=csrf-123; other=value' });

    await fetchWithSession('/shifts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'shift-1' }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/shifts');
    expect(headersFromCall(fetchMock.mock.calls[0]).get('x-csrf-token')).toBe('csrf-123');
    expect((fetchMock.mock.calls[0][1] as RequestInit).credentials).toBe('include');
  });

  it('includes CSRF protection when refreshing an expired session', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('document', { cookie: 'csrf_token=refresh-csrf' });

    await fetchWithSession('/auth/me');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/auth/refresh');
    expect(headersFromCall(fetchMock.mock.calls[1]).get('x-csrf-token')).toBe('refresh-csrf');
  });

  it('rejects absolute request targets so credentials cannot be sent off-origin', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWithSession('https://evil.example/collect')).rejects.toThrow('same-origin API paths');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reuses one attempt key for the same canonical payload and rotates it when the payload changes', () => {
    const keys = ['attempt-1', 'attempt-2'];
    const keyFactory = () => keys.shift() ?? 'unexpected';
    const first = idempotentRequestAttempt({ persist: true, shiftIds: ['shift-1'] }, null, keyFactory);
    const retry = idempotentRequestAttempt({ shiftIds: ['shift-1'], persist: true }, first, keyFactory);
    const changed = idempotentRequestAttempt({ shiftIds: ['shift-2'], persist: true }, retry, keyFactory);

    expect(retry).toBe(first);
    expect(changed.key).toBe('attempt-2');
  });

  it('preserves the Idempotency-Key through session refresh and request replay', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('document', { cookie: 'csrf_token=refresh-csrf' });

    await fetchWithSession('/lunch-breaks/generate', withIdempotencyKey({ method: 'POST' }, 'attempt-1'));

    expect(headersFromCall(fetchMock.mock.calls[0]).get('Idempotency-Key')).toBe('attempt-1');
    expect(headersFromCall(fetchMock.mock.calls[2]).get('Idempotency-Key')).toBe('attempt-1');
  });

  it('coalesces concurrent 401 refreshes and rebuilds replay headers from the rotated CSRF cookie', async () => {
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let refreshCalls = 0;
    const attempts = new Map<string, number>();
    const documentState = { cookie: 'csrf_token=csrf-old' };
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/auth/refresh')) {
        refreshCalls += 1;
        await refreshGate;
        documentState.cookie = 'csrf_token=csrf-new';
        return new Response('{}', { status: 200 });
      }

      const attempt = (attempts.get(url) ?? 0) + 1;
      attempts.set(url, attempt);
      return new Response(attempt === 1 ? null : '{}', { status: attempt === 1 ? 401 : 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('document', documentState);

    const body = JSON.stringify({ shiftId: 'shift-1' });
    const first = fetchWithSession('/shifts/shift-1', withIdempotencyKey({ method: 'PATCH', body }, 'attempt-1'));
    const second = fetchWithSession('/shifts/shift-2', withIdempotencyKey({ method: 'DELETE', body }, 'attempt-2'));

    await vi.waitFor(() => expect(refreshCalls).toBe(1));
    releaseRefresh?.();
    await Promise.all([first, second]);

    expect(refreshCalls).toBe(1);
    const replayCalls = fetchMock.mock.calls.filter((call) => {
      const url = String(call[0]);
      return !url.endsWith('/auth/refresh') && headersFromCall(call).get('x-csrf-token') === 'csrf-new';
    });
    expect(replayCalls).toHaveLength(2);
    expect(replayCalls.map((call) => headersFromCall(call).get('Idempotency-Key')).sort()).toEqual(['attempt-1', 'attempt-2']);
    expect(replayCalls.every((call) => (call[1] as RequestInit).body === body)).toBe(true);
  });
});
