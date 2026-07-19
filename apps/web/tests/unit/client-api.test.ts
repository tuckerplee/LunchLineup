import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchApiV2WithSession,
  fetchApiHealth,
  fetchJsonWithSession,
  fetchPublicApi,
  fetchWithSession,
  idempotentRequestAttempt,
  withIdempotencyKey,
} from '../../lib/client-api';

function headersFromCall(call: unknown[]): Headers {
  const init = call[1] as RequestInit;
  return init.headers as Headers;
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  let captured: unknown;
  try {
    await promise;
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(Error);
  return captured as Error;
}

describe('fetchWithSession', () => {
  afterEach(() => {
    vi.useRealTimers();
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
    expect((fetchMock.mock.calls[0][1] as RequestInit).redirect).toBe('error');
  });

  it('routes dependency health through the unversioned same-origin proxy endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ status: 'ok' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchApiHealth()).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledWith('/api/health', expect.objectContaining({
      credentials: 'include',
      redirect: 'error',
    }));
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

  it('restricts the v2 transport to exact same-origin /api/v2 paths', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchApiV2WithSession('/api/v2/schedule-board?date=2026-07-18&view=day');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v2/schedule-board?date=2026-07-18&view=day');

    await expect(fetchApiV2WithSession('/api/v1/shifts')).rejects.toThrow('/api/v2 same-origin');
    await expect(fetchApiV2WithSession('https://evil.example/api/v2/shifts')).rejects.toThrow('/api/v2 same-origin');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves safe RFC Problem Details for v2 concurrency failures', async () => {
    const problem = {
      type: 'https://lunchlineup.com/problems/stale-schedule-revision',
      title: 'Precondition failed',
      status: 412,
      detail: 'The schedule changed after this board loaded. Reload before saving.',
      code: 'stale_schedule_revision',
      currentEtag: '"schedule:88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e:6"',
      violations: [{
        pointer: '/operations/0',
        code: 'stale_shift',
        message: 'Reload this schedule before retrying.',
      }],
      internal: 'postgres.internal token=hidden',
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(problem), {
      status: 412,
      headers: { 'content-type': 'application/problem+json' },
    })));

    const response = await fetchApiV2WithSession(
      '/api/v2/schedules/88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e/change-sets',
    );
    const payload = await response.json();
    expect(payload).toMatchObject({
      code: 'stale_schedule_revision',
      currentEtag: problem.currentEtag,
      violations: problem.violations,
    });
    expect(JSON.stringify(payload)).not.toContain('postgres.internal');
    expect(JSON.stringify(payload)).not.toContain('hidden');
  });

  it('replays a v2 mutation after refresh only with its original idempotency key', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', {
        status: 401,
        headers: { 'content-type': 'application/problem+json' },
      }))
      .mockResolvedValueOnce(new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('document', { cookie: 'csrf_token=csrf-v2' });

    await fetchApiV2WithSession(
      '/api/v2/schedules/88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e/change-sets',
      withIdempotencyKey({ method: 'POST', body: '{"operations":[]}' }, 'v2-attempt-1'),
    );

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      '/api/v2/schedules/88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e/change-sets',
      '/api/v1/auth/refresh',
      '/api/v2/schedules/88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e/change-sets',
    ]);
    expect(headersFromCall(fetchMock.mock.calls[0]).get('idempotency-key')).toBe('v2-attempt-1');
    expect(headersFromCall(fetchMock.mock.calls[2]).get('idempotency-key')).toBe('v2-attempt-1');
    expect(headersFromCall(fetchMock.mock.calls[2]).get('x-csrf-token')).toBe('csrf-v2');
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
  it('does not replay an unsafe mutation without an idempotency key after refresh', async () => {
    const jsonHeaders = { 'content-type': 'application/json' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401, headers: jsonHeaders }))
      .mockResolvedValueOnce(new Response('{}', { status: 200, headers: jsonHeaders }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('document', { cookie: 'csrf_token=refresh-csrf' });

    const response = await fetchWithSession('/shifts', {
      method: 'POST',
      body: JSON.stringify({ startsAt: '2026-07-14T09:00:00Z' }),
    });

    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      '/api/v1/shifts',
      '/api/v1/auth/refresh',
    ]);
  });

  it('replaces raw 5xx and non-JSON transport details before callers can read them', async () => {
    const secretBody = '<html>postgres.internal token=server-secret Error: stack trace</html>';
    const fetchMock = vi.fn().mockResolvedValue(new Response(secretBody, {
      status: 503,
      headers: {
        'content-type': 'text/html',
        'x-internal-host': 'postgres.internal',
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchWithSession('/health');
    const serialized = JSON.stringify({
      body: await response.json(),
      headers: Object.fromEntries(response.headers.entries()),
    });

    expect(response.status).toBe(503);
    expect(serialized).toContain('temporarily unavailable');
    expect(serialized).not.toContain(secretBody);
    expect(serialized).not.toContain('postgres.internal');
    expect(serialized).not.toContain('server-secret');
  });

  it('normalizes network and successful non-JSON parsing failures without leaking their causes', async () => {
    const rawFailure = 'https://api.internal/auth?token=secret-token Authorization: Bearer hidden';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error(rawFailure)));

    const networkError = await captureError(fetchWithSession('/auth/me'));
    expect(networkError.message).toBe('Unable to reach the service. Please try again.');
    expect(String(networkError)).not.toContain(rawFailure);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(
      '<html>redis.internal?password=hidden</html>',
      { status: 200, headers: { 'content-type': 'text/html' } },
    )));
    const parsingError = await captureError(fetchJsonWithSession('/auth/me'));
    expect(parsingError.message).toBe('The service returned an invalid response.');
    expect(String(parsingError)).not.toContain('redis.internal');
    expect(String(parsingError)).not.toContain('hidden');
  });

  it('keeps safe 4xx guidance but rejects secret-bearing API messages', async () => {
    const headers = { 'content-type': 'application/json' };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Select at least one shift.' }), {
        status: 400,
        headers,
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        message: 'Failure at https://api.internal?token=server-secret Authorization: Bearer hidden',
      }), {
        status: 400,
        headers,
      })));

    await expect(fetchJsonWithSession('/shifts')).rejects.toThrow('Select at least one shift.');
    const unsafeError = await captureError(fetchJsonWithSession('/shifts'));
    expect(unsafeError.message).toBe('Request failed (400).');
    expect(String(unsafeError)).not.toContain('server-secret');
    expect(String(unsafeError)).not.toContain('api.internal');
  });

  it('removes secret-bearing query state from session-expiry login redirects', async () => {
    const assign = vi.fn();
    const jsonHeaders = { 'content-type': 'application/json' };
    vi.stubGlobal('window', {
      location: {
        pathname: '/dashboard/scheduling',
        search: '?date=2026-07-14&token=secret-token&return=https%3A%2F%2Fevil.example',
        assign,
      },
    });
    vi.stubGlobal('document', { cookie: 'csrf_token=refresh-csrf' });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401, headers: jsonHeaders }))
      .mockResolvedValueOnce(new Response('{}', { status: 401, headers: jsonHeaders })));

    await fetchWithSession('/auth/me');

    const target = String(assign.mock.calls[0]?.[0] ?? '');
    expect(target).toContain(encodeURIComponent('/dashboard/scheduling?date=2026-07-14'));
    expect(target).not.toContain('secret-token');
    expect(target).not.toContain('evil.example');
  });
  it('aborts public browser requests at the shared deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    })));

    const request = fetchPublicApi('/auth/login/resolve');
    const assertion = expect(request).rejects.toThrow('The request timed out. Please try again.');
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });

  it('rejects successful JSON responses above the shared byte ceiling', async () => {
    const oversized = JSON.stringify({ data: 'x'.repeat(1024 * 1024) });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(oversized, {
      status: 200,
      headers: {
        'content-length': String(oversized.length),
        'content-type': 'application/json',
      },
    })));

    await expect(fetchJsonWithSession('/admin/stats')).rejects.toThrow('The service returned an invalid response.');
  });

  it('sanitizes unsafe 4xx bodies even for callers that inspect Response directly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      message: 'Failure at https://api.internal?token=server-secret Authorization: Bearer hidden',
    }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })));

    const response = await fetchPublicApi('/auth/login/resolve');
    const serialized = JSON.stringify(await response.json());
    expect(serialized).toContain('Request failed (400).');
    expect(serialized).not.toContain('server-secret');
    expect(serialized).not.toContain('api.internal');
  });
});
