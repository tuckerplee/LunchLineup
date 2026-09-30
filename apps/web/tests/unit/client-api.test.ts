import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let client: typeof import('../../lib/client-api');

function headersFromCall(call: unknown[]): Headers {
  const init = call[1] as RequestInit;
  return init.headers as Headers;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(release => { resolve = release; });
  return { promise, resolve };
}

function sessionFetch(kind: 'contract' | 'v2', init: RequestInit = {}) {
  return kind === 'contract'
    ? client.fetchWithSession('/auth/me', init)
    : client.fetchApiV2WithSession('/api/v2/auth/me', init);
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
  beforeEach(async () => {
    // Logout closes a document permanently. Reload modules as a fresh document,
    // rather than adding a production reset that could revive stale requests.
    vi.resetModules();
    client = await import('../../lib/client-api');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('adds the CSRF cookie token to unsafe same-origin API requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('document', { cookie: 'csrf_token=csrf-123; other=value' });

    await client.fetchWithSession('/locations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Downtown', timezone: 'America/Los_Angeles' }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v2/locations');
    expect(headersFromCall(fetchMock.mock.calls[0]).get('x-csrf-token')).toBe('csrf-123');
    expect((fetchMock.mock.calls[0][1] as RequestInit).credentials).toBe('include');
    expect((fetchMock.mock.calls[0][1] as RequestInit).redirect).toBe('error');
  });

  it('sends bodyless MFA enrollment without an empty JSON document and preserves CSRF', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response('{}', {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('document', { cookie: 'csrf_token=enrollment-csrf' });

    await client.fetchPublicApi('/auth/mfa/enrollment', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v2/auth/mfa/enrollment');
    expect(headersFromCall(fetchMock.mock.calls[0]).has('content-type')).toBe(false);
    expect(headersFromCall(fetchMock.mock.calls[0]).get('x-csrf-token')).toBe('enrollment-csrf');

    await client.fetchPublicApi('/auth/mfa/enrollment', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '123456' }),
    });
    expect(headersFromCall(fetchMock.mock.calls[1]).get('content-type')).toBe('application/json');
    expect((fetchMock.mock.calls[1][1] as RequestInit).body).toBe('{"code":"123456"}');
  });

  it('routes dependency health through the unversioned same-origin proxy endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ status: 'ok' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(client.fetchApiHealth()).resolves.toMatchObject({ status: 200 });
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

    await client.fetchWithSession('/auth/me');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v2/auth/refresh');
    expect(headersFromCall(fetchMock.mock.calls[1]).get('x-csrf-token')).toBe('refresh-csrf');
  });

  it('rejects absolute request targets so credentials cannot be sent off-origin', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(client.fetchWithSession('https://evil.example/collect')).rejects.toThrow('same-origin API paths');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('restricts the v2 transport to exact same-origin /api/v2 paths', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await client.fetchApiV2WithSession('/api/v2/schedule-board?date=2026-07-18&view=day');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v2/schedule-board?date=2026-07-18&view=day');

    await expect(client.fetchApiV2WithSession('/api/v1/shifts')).rejects.toThrow('/api/v2 same-origin');
    await expect(client.fetchApiV2WithSession('https://evil.example/api/v2/shifts')).rejects.toThrow('/api/v2 same-origin');
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

    const response = await client.fetchApiV2WithSession(
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

    await client.fetchApiV2WithSession(
      '/api/v2/schedules/88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e/change-sets',
      client.withIdempotencyKey({ method: 'POST', body: '{"operations":[]}' }, 'v2-attempt-1'),
    );

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      '/api/v2/schedules/88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e/change-sets',
      '/api/v2/auth/refresh',
      '/api/v2/schedules/88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e/change-sets',
    ]);
    expect(headersFromCall(fetchMock.mock.calls[0]).get('idempotency-key')).toBe('v2-attempt-1');
    expect(headersFromCall(fetchMock.mock.calls[2]).get('idempotency-key')).toBe('v2-attempt-1');
    expect(headersFromCall(fetchMock.mock.calls[2]).get('x-csrf-token')).toBe('csrf-v2');
  });

  it('reuses one attempt key for the same canonical payload and rotates it when the payload changes', () => {
    const keys = ['attempt-1', 'attempt-2'];
    const keyFactory = () => keys.shift() ?? 'unexpected';
    const first = client.idempotentRequestAttempt({ persist: true, shiftIds: ['shift-1'] }, null, keyFactory);
    const retry = client.idempotentRequestAttempt({ shiftIds: ['shift-1'], persist: true }, first, keyFactory);
    const changed = client.idempotentRequestAttempt({ shiftIds: ['shift-2'], persist: true }, retry, keyFactory);

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

    await client.fetchWithSession('/lunch-breaks/generate', client.withIdempotencyKey({ method: 'POST' }, 'attempt-1'));

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

    const body = JSON.stringify({ enabled: true });
    const first = client.fetchWithSession('/settings/general', client.withIdempotencyKey({ method: 'PUT', body }, 'attempt-1'));
    const second = client.fetchWithSession('/settings/team', client.withIdempotencyKey({ method: 'PUT', body }, 'attempt-2'));

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

    const response = await client.fetchWithSession('/locations', {
      method: 'POST',
      body: JSON.stringify({ name: 'Downtown', timezone: 'America/Los_Angeles' }),
    });

    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      '/api/v2/locations',
      '/api/v2/auth/refresh',
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

    const response = await client.fetchWithSession('/auth/me');
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

    const networkError = await captureError(client.fetchWithSession('/auth/me'));
    expect(networkError.message).toBe('Unable to reach the service. Please try again.');
    expect(String(networkError)).not.toContain(rawFailure);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(
      '<html>redis.internal?password=hidden</html>',
      { status: 200, headers: { 'content-type': 'text/html' } },
    )));
    const parsingError = await captureError(client.fetchJsonWithSession('/auth/me'));
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

    await expect(client.fetchJsonWithSession('/shifts')).rejects.toThrow('Select at least one shift.');
    const unsafeError = await captureError(client.fetchJsonWithSession('/shifts'));
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

    await client.fetchWithSession('/auth/me');

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

    const request = client.fetchPublicApi('/auth/login/resolve', { method: 'POST' });
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

    await expect(client.fetchJsonWithSession('/admin/stats')).rejects.toThrow('The service returned an invalid response.');
  });

  it('sanitizes unsafe 4xx bodies even for callers that inspect Response directly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      message: 'Failure at https://api.internal?token=server-secret Authorization: Bearer hidden',
    }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })));

    const response = await client.fetchPublicApi('/auth/login/resolve', { method: 'POST' });
    const serialized = JSON.stringify(await response.json());
    expect(serialized).toContain('Request failed (400).');
    expect(serialized).not.toContain('server-secret');
    expect(serialized).not.toContain('api.internal');
  });

  it('rejects removed and method-undeclared operations before transport', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(client.fetchWithSession('/shifts/demo-shift-05-casey-v1', {
      method: 'PUT',
      body: '{}',
    })).rejects.toThrow('not part of the API v2 application contract');
    await expect(client.fetchWithSession('/locations', {
      method: 'DELETE',
    })).rejects.toThrow('not part of the API v2 application contract');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['contract', 'v2'] as const)('does not refresh %s without an actual nonblank, decodable CSRF cookie', async kind => {
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { pathname: '/dashboard', search: '', assign } });
    const documentState = { cookie: '' }; vi.stubGlobal('document', documentState);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 401 })); vi.stubGlobal('fetch', fetchMock);
    for (const cookie of ['', 'other=value', 'csrf_token=', 'csrf_token=%20', 'csrf_token=%E0%A4%A']) {
      documentState.cookie = cookie;
      const before = fetchMock.mock.calls.length;
      expect((await sessionFetch(kind, { headers: { 'x-csrf-token': 'caller-cannot-substitute-a-cookie' } })).status).toBe(401);
      expect(fetchMock.mock.calls.length - before).toBe(1);
    }
    expect(fetchMock.mock.calls.every(call => !String(call[0]).endsWith('/auth/refresh'))).toBe(true);
    expect(assign).toHaveBeenCalledTimes(5);
  });

  it.each(['contract', 'v2'] as const)('rechecks the CSRF cookie when a pending %s request becomes unauthorized', async kind => {
    const late = deferred<Response>(); const started = deferred<AbortSignal>();
    const documentState = { cookie: 'csrf_token=before-expiry' }; vi.stubGlobal('document', documentState);
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => { started.resolve(init!.signal!); return late.promise; });
    vi.stubGlobal('fetch', fetchMock);
    const request = sessionFetch(kind); await started.promise;
    documentState.cookie = '';
    late.resolve(new Response(null, { status: 401 }));
    expect((await request).status).toBe(401); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['contract', 'v2'] as const)('rejects a pre-canceled %s request before transport', async kind => {
    const caller = new AbortController(); caller.abort();
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(sessionFetch(kind, { signal: caller.signal })).rejects.toThrow('Request canceled.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['contract', 401], ['v2', 401], ['contract', 200], ['v2', 200],
  ] as const)('aborts %s and rejects a late initial %i response after logout without refresh or redirect', async (kind, code) => {
    const late = deferred<Response>(); const started = deferred<AbortSignal>(); const assign = vi.fn();
    vi.stubGlobal('window', { location: { pathname: '/dashboard', search: '', assign } });
    vi.stubGlobal('document', { cookie: 'csrf_token=valid-before-logout' });
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => { started.resolve(init!.signal!); return late.promise; });
    vi.stubGlobal('fetch', fetchMock);
    const failure = captureError(sessionFetch(kind)); const signal = await started.promise;
    client.prepareForLogout(); expect(signal.aborted).toBe(true);
    late.resolve(new Response('{}', { status: code, headers: { 'content-type': 'application/json' } }));
    expect((await failure).message).toBe('Request canceled.');
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(assign).not.toHaveBeenCalled();
    await expect(sessionFetch(kind)).rejects.toThrow('Request canceled.'); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects late streamed JSON normalization after logout instead of acting on its unauthorized status', async () => {
    const bodyGate = deferred<void>(); const reading = deferred<void>(); const started = deferred<AbortSignal>(); const assign = vi.fn();
    const body = new ReadableStream<Uint8Array>({ async pull(controller) {
      reading.resolve(); await bodyGate.promise; controller.enqueue(new TextEncoder().encode('{}')); controller.close();
    } });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      started.resolve(init!.signal!); return new Response(body, { status: 401, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock); vi.stubGlobal('document', { cookie: 'csrf_token=valid' });
    vi.stubGlobal('window', { location: { pathname: '/dashboard', search: '', assign } });
    const failure = captureError(client.fetchJsonWithSession('/auth/me'));
    const signal = await started.promise; await reading.promise;
    client.prepareForLogout(); expect(signal.aborted).toBe(true); bodyGate.resolve();
    expect((await failure).message).toBe('Request canceled.'); expect(fetchMock).toHaveBeenCalledTimes(1); expect(assign).not.toHaveBeenCalled();
  });

  it('rejects a JSON helper completion when logout begins after transport normalization', async () => {
    const lateJson = deferred<unknown>(); const reading = deferred<void>();
    vi.spyOn(Response.prototype, 'json').mockImplementation(() => { reading.resolve(); return lateJson.promise; });
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const failure = captureError(client.fetchJsonWithSession('/auth/me')); await reading.promise;
    client.prepareForLogout(); lateJson.resolve({ stale: true });
    expect((await failure).message).toBe('Request canceled.'); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([200, 401])('aborts a coalesced refresh and rejects its late %i completion without replay or redirect', async refreshStatus => {
    const lateRefresh = deferred<Response>(); const refreshStarted = deferred<AbortSignal>(); const assign = vi.fn();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/auth/refresh')) { refreshStarted.resolve(init!.signal!); return lateRefresh.promise; }
      return Promise.resolve(new Response(null, { status: 401 }));
    });
    vi.stubGlobal('fetch', fetchMock); vi.stubGlobal('document', { cookie: 'csrf_token=valid' });
    vi.stubGlobal('window', { location: { pathname: '/dashboard', search: '', assign } });
    const first = captureError(client.fetchWithSession('/auth/me'));
    const second = captureError(client.fetchApiV2WithSession('/api/v2/billing/features'));
    const signal = await refreshStarted.promise; await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    client.prepareForLogout(); expect(signal.aborted).toBe(true);
    lateRefresh.resolve(new Response('{}', { status: refreshStatus, headers: { 'content-type': 'application/json' } }));
    expect((await first).message).toBe('Request canceled.'); expect((await second).message).toBe('Request canceled.');
    expect(fetchMock).toHaveBeenCalledTimes(3); expect(assign).not.toHaveBeenCalled();
  });

  it('cancels one shared-refresh waiter without aborting refresh or replaying the canceled request', async () => {
    const lateRefresh = deferred<Response>(); const refreshStarted = deferred<AbortSignal>(); const caller = new AbortController();
    const attempts = new Map<string, number>();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/auth/refresh')) { refreshStarted.resolve(init!.signal!); return lateRefresh.promise; }
      const attempt = (attempts.get(url) ?? 0) + 1; attempts.set(url, attempt);
      return Promise.resolve(new Response(null, { status: attempt === 1 ? 401 : 200 }));
    });
    vi.stubGlobal('fetch', fetchMock); vi.stubGlobal('document', { cookie: 'csrf_token=valid' });
    const first = captureError(client.fetchWithSession('/auth/me', { signal: caller.signal }));
    const second = client.fetchApiV2WithSession('/api/v2/billing/features');
    const signal = await refreshStarted.promise; caller.abort();
    expect((await first).message).toBe('Request canceled.'); expect(signal.aborted).toBe(false);
    lateRefresh.resolve(new Response(null, { status: 200 })); expect((await second).status).toBe(200);
    expect(attempts.get('/api/v2/auth/me')).toBe(1); expect(attempts.get('/api/v2/billing/features')).toBe(2);
    expect(fetchMock.mock.calls.filter(call => String(call[0]).endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('preserves an external caller timeout while waiting for refresh without leaking its reason', async () => {
    const lateRefresh = deferred<Response>(); const refreshStarted = deferred<AbortSignal>(); const caller = new AbortController();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/auth/refresh')) { refreshStarted.resolve(init!.signal!); return lateRefresh.promise; }
      return Promise.resolve(new Response(null, { status: 401 }));
    });
    vi.stubGlobal('fetch', fetchMock); vi.stubGlobal('document', { cookie: 'csrf_token=valid' });
    const failure = captureError(client.fetchWithSession('/auth/me', { signal: caller.signal })); await refreshStarted.promise;
    caller.abort(new DOMException('private caller details', 'TimeoutError'));
    expect((await failure).message).toBe('The request timed out. Please try again.');
    lateRefresh.resolve(new Response(null, { status: 200 })); expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['contract', 'v2'] as const)('aborts an active %s replay and rejects a late unauthorized response after logout', async kind => {
    const lateReplay = deferred<Response>(); const replayStarted = deferred<AbortSignal>(); const assign = vi.fn(); let originalCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/auth/refresh')) return Promise.resolve(new Response(null, { status: 200 }));
      if (++originalCalls === 1) return Promise.resolve(new Response(null, { status: 401 }));
      replayStarted.resolve(init!.signal!); return lateReplay.promise;
    });
    vi.stubGlobal('fetch', fetchMock); vi.stubGlobal('document', { cookie: 'csrf_token=valid' });
    vi.stubGlobal('window', { location: { pathname: '/dashboard', search: '', assign } });
    const failure = captureError(sessionFetch(kind)); const signal = await replayStarted.promise;
    client.prepareForLogout(); expect(signal.aborted).toBe(true); lateReplay.resolve(new Response(null, { status: 401 }));
    expect((await failure).message).toBe('Request canceled.'); expect(fetchMock).toHaveBeenCalledTimes(3); expect(assign).not.toHaveBeenCalled();
  });

  it('forwards caller cancellation to the active transport', async () => {
    const caller = new AbortController(); const started = deferred<AbortSignal>();
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      started.resolve(init!.signal!); init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    })));
    const failure = captureError(client.fetchWithSession('/auth/me', { signal: caller.signal }));
    const signal = await started.promise; caller.abort(); expect(signal.aborted).toBe(true); expect((await failure).message).toBe('Request canceled.');
  });

  it.each(['contract', 'v2'] as const)('retains the shared request deadline and actual %s transport abort', async kind => {
    vi.useFakeTimers(); const started = deferred<AbortSignal>();
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      started.resolve(init!.signal!); init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    })));
    const failure = captureError(sessionFetch(kind)); const signal = await started.promise;
    await vi.advanceTimersByTimeAsync(15_000); expect(signal.aborted).toBe(true); expect((await failure).message).toBe('The request timed out. Please try again.');
  });

  it('bounds one shared refresh for both transports without replaying after its timeout', async () => {
    vi.useFakeTimers(); const refreshStarted = deferred<AbortSignal>();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).endsWith('/auth/refresh')) return Promise.resolve(new Response(null, { status: 401 }));
      return new Promise<Response>((_resolve, reject) => {
        refreshStarted.resolve(init!.signal!); init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock); vi.stubGlobal('document', { cookie: 'csrf_token=valid' });
    const first = captureError(client.fetchWithSession('/auth/me')); const second = captureError(client.fetchApiV2WithSession('/api/v2/billing/features'));
    const signal = await refreshStarted.promise;
    await vi.advanceTimersByTimeAsync(15_000); expect(signal.aborted).toBe(true);
    expect((await first).message).toBe('The request timed out. Please try again.'); expect((await second).message).toBe('The request timed out. Please try again.');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps the old document closed after cookie restoration and allows public login and a fresh module only', async () => {
    const oldClient = client; const documentState = { cookie: 'csrf_token=before-logout' };
    vi.stubGlobal('document', documentState);
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    oldClient.prepareForLogout(); oldClient.prepareForLogout(); documentState.cookie = 'csrf_token=restored-or-new-session';
    await expect(oldClient.fetchWithSession('/auth/me')).rejects.toThrow('Request canceled.');
    await expect(oldClient.fetchApiV2WithSession('/api/v2/auth/me')).rejects.toThrow('Request canceled.'); expect(fetchMock).not.toHaveBeenCalled();
    expect((await oldClient.fetchPublicApi('/auth/login/resolve', { method: 'POST' })).status).toBe(200);
    vi.resetModules(); const freshClient = await import('../../lib/client-api');
    expect((await freshClient.fetchWithSession('/auth/me')).status).toBe(200);
    await expect(oldClient.fetchWithSession('/auth/me')).rejects.toThrow('Request canceled.'); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
