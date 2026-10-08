import { APPLICATION_API_OPERATIONS } from '@lunchlineup/api-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../config';
import { buildServer, type ApiV2ServerDependencies } from '../server';
import { ProblemError } from '../platform/problem';
import { RetainedApplicationBridge } from '../platform/retained-application.bridge';

// These are transport fixtures, not valid credentials or business acceptance.
// The explicit list must match every retained Authentication catalog entry.
const authFixtures = [
  { operationId: 'readAccountDeletionReceipt', method: 'POST', path: '/account-deletion/receipt' },
  { operationId: 'resolveLoginMethod', method: 'POST', path: '/auth/login/resolve' },
  { operationId: 'verifyPasswordLogin', method: 'POST', path: '/auth/password/verify' },
  { operationId: 'requestPasswordReset', method: 'POST', path: '/auth/password/reset/request' },
  { operationId: 'confirmPasswordReset', method: 'POST', path: '/auth/password/reset/confirm' },
  { operationId: 'startOidcLogin', method: 'GET', path: '/auth/login', redirect: true },
  { operationId: 'completeOidcLogin', method: 'GET', path: '/auth/callback', redirect: true },
  { operationId: 'sendEmailLoginCode', method: 'POST', path: '/auth/email/send-otp' },
  { operationId: 'verifyEmailLoginCode', method: 'POST', path: '/auth/email/verify-otp' },
  { operationId: 'verifyPinLogin', method: 'POST', path: '/auth/pin/verify' },
  { operationId: 'refreshSession', method: 'POST', path: '/auth/refresh' },
  { operationId: 'getMfaEnrollment', method: 'GET', path: '/auth/mfa/enrollment' },
  { operationId: 'startMfaEnrollment', method: 'POST', path: '/auth/mfa/enrollment' },
  { operationId: 'confirmMfaEnrollment', method: 'PUT', path: '/auth/mfa/enrollment' },
  { operationId: 'deleteMfaEnrollment', method: 'DELETE', path: '/auth/mfa/enrollment' },
  { operationId: 'verifyMfaChallenge', method: 'POST', path: '/auth/mfa/verify' },
  { operationId: 'deleteSession', method: 'POST', path: '/auth/logout' },
] as const;

const config = loadConfig({
  APP_ORIGIN: 'https://private.example.invalid',
  LEGACY_API_BASE_URL: 'http://retained.example.invalid/v1',
  JWT_SECRET: 'synthetic-local-auth-transport-secret',
  NODE_ENV: 'test', LOG_LEVEL: 'silent',
  METRICS_TOKEN: 'synthetic-auth-metrics-token-0000000000000000000',
  DEPLOY_RELEASE_SHA: 'a'.repeat(40),
});
const sessionCookies = [
  'access_token=synthetic-access; HttpOnly; Secure; SameSite=Lax; Path=/; Expires=Tue, 01 Jan 2030 00:00:00 GMT',
  'refresh_token=synthetic-refresh; HttpOnly; Secure; SameSite=Lax; Path=/',
  'csrf_token=synthetic-csrf; Secure; SameSite=Lax; Path=/',
];
const clearCorrelation = 'oidc_correlation=; Max-Age=0; HttpOnly; Secure; SameSite=Lax; Path=/';
const apps: FastifyInstance[] = [];

function upstream(body: string | null, status = 200, cookies: readonly string[] = [], location?: string) {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  if (location !== undefined) headers.set('location', location);
  return new Response(body, { status, headers });
}

// Fastify exposes one Set-Cookie as a string and several as an array.
// Never split on commas: a legitimate Expires attribute contains one.
function responseCookies(value: unknown) {
  return typeof value === 'string' ? [value] : value;
}

async function harness(respond: (target: string, init: RequestInit) => Response | Promise<Response>) {
  const unexpectedDomainCalls: string[] = [];
  const unexpectedFetch: Array<{ target: string; targetType: string; hasInit: boolean }> = [];
  const domain = new Proxy({}, { get: (_target, name) => (..._args: unknown[]) => {
    unexpectedDomainCalls.push(String(name));
    throw new Error('Unexpected native domain invocation');
  } });
  const authenticate = vi.fn(async () => { throw new ProblemError(401, 'authentication_required', 'Sign in to continue.'); });
  const readyIdentity = vi.fn(async () => undefined), closeIdentity = vi.fn(async () => undefined);
  const quota = { ready: vi.fn(async () => undefined), consume: vi.fn(async () => { throw new Error('Unexpected native quota invocation'); }) };
  const database = { ready: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined) };
  const translators = { translateRequest: vi.fn(async () => { throw new Error('Unexpected identifier translation'); }),
    translateResponse: vi.fn(async () => { throw new Error('Unexpected identifier translation'); }) };
  const fetchMock = vi.fn(async (target: string | URL | Request, init?: RequestInit) => {
    // No test may contact a network or accidentally succeed on an unexpected hop.
    if (typeof target !== 'string' || !target.startsWith('http://retained.example.invalid/v1/') || !init) {
      unexpectedFetch.push({ target: String(target), targetType: typeof target, hasInit: Boolean(init) });
      throw new Error('Unexpected retained fetch target or options');
    }
    return respond(String(target), init!);
  });
  vi.stubGlobal('fetch', fetchMock);
  const app = await buildServer(config, {
    database: database as never,
    identity: { authenticate, ready: readyIdentity, close: closeIdentity } as never,
    quota,
    retainedApplication: new RetainedApplicationBridge(config, translators),
    retainedOperators: domain as never,
    locations: domain as never, people: domain as never, operations: domain as never,
    lunchBreaks: domain as never, notifications: domain as never, payroll: domain as never,
    timeCards: domain as never, settings: domain as never,
    routes: { board: domain, scheduleCreate: domain, changeSets: domain, demandWindows: domain,
      lifecycle: domain, retainedScheduling: domain } as ApiV2ServerDependencies['routes'],
  });
  apps.push(app);
  return { app, fetchMock, authenticate, quota, translators, unexpectedDomainCalls, unexpectedFetch, database,
    readyIdentity, closeIdentity };
}

function noNativeDispatch(h: Awaited<ReturnType<typeof harness>>) {
  expect(h.authenticate).not.toHaveBeenCalled();
  expect(h.quota.consume).not.toHaveBeenCalled();
  expect(h.translators.translateRequest).not.toHaveBeenCalled();
  expect(h.translators.translateResponse).not.toHaveBeenCalled();
  expect(h.unexpectedDomainCalls).toEqual([]);
  expect(h.unexpectedFetch).toEqual([]);
}

afterEach(async () => {
  try { for (const app of apps.splice(0)) await app.close(); }
  finally { vi.unstubAllGlobals(); }
});

describe('retained authentication HTTP transport', () => {
  it('preserves success transport for every reviewed retained authentication route', async () => {
    const selected = APPLICATION_API_OPERATIONS.filter(row => row.tag === 'Authentication' && !('native' in row && row.native));
    expect(selected.map(row => [row.operationId, row.method, row.path]).sort()).toEqual(
      authFixtures.map(row => [row.operationId, row.method, row.path]).sort());
    expect(selected).toHaveLength(17);
    const h = await harness(target => target.includes('/auth/login?') || target.includes('/auth/callback?')
      ? upstream(null, 302, [clearCorrelation], '/dashboard')
      : upstream(JSON.stringify({ transportResult: true }), 200, sessionCookies));
    for (const fixture of authFixtures) {
      const query = '?transport=synthetic&next=%2Fdashboard%3Fa%3D1';
      const body = fixture.method === 'GET' ? undefined : { marker: fixture.operationId, nested: { preserved: true } };
      const before = h.fetchMock.mock.calls.length;
      const response = await h.app.inject({ method: fixture.method, url: `/v2${fixture.path}${query}`,
        remoteAddress: '203.0.113.7', payload: body,
        headers: { cookie: 'access_token=old; refresh_token=old-refresh; oidc_correlation=browser',
          authorization: 'Bearer synthetic-owner-credential', origin: 'https://private.example.invalid',
          'x-csrf-token': 'synthetic-csrf', 'x-tenant-id': 'spoofed-tenant', host: 'attacker.invalid',
          'content-type': 'application/json', accept: 'application/json',
          referer: 'https://private.example.invalid/auth/login', 'idempotency-key': 'synthetic-transport-request',
          'if-match': '"synthetic-current"', 'if-none-match': '"synthetic-known"',
          'x-forwarded-for': '198.51.100.19', 'x-forwarded-host': 'attacker.invalid', 'x-forwarded-proto': 'http',
          'x-request-id': 'untrusted-client-id', 'user-agent': 'Synthetic transport client' } });
      expect(h.fetchMock).toHaveBeenCalledTimes(before + 1);
      const [target, init] = h.fetchMock.mock.calls[before]!;
      expect(target).toBe(`http://retained.example.invalid/v1${fixture.path}${query}`);
      expect(init!.method).toBe(fixture.method);
      expect(init!.body).toBe(body === undefined ? undefined : JSON.stringify(body));
      expect(init!.redirect).toBe('manual');
      expect(init!.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init!.headers);
      expect(headers.get('cookie')).toBe('access_token=old; refresh_token=old-refresh; oidc_correlation=browser');
      expect(headers.get('authorization')).toBe('Bearer synthetic-owner-credential');
      expect(headers.get('x-csrf-token')).toBe('synthetic-csrf');
      expect(headers.get('origin')).toBe('https://private.example.invalid');
      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.get('accept')).toBe('application/json');
      expect(headers.get('user-agent')).toBe('Synthetic transport client');
      expect(headers.get('referer')).toBe('https://private.example.invalid/auth/login');
      expect(headers.get('idempotency-key')).toBe('synthetic-transport-request');
      expect(headers.get('if-match')).toBe('"synthetic-current"');
      expect(headers.get('if-none-match')).toBe('"synthetic-known"');
      expect(headers.get('host')).toBeNull();
      expect(headers.get('x-tenant-id')).toBeNull();
      expect(headers.get('x-forwarded-host')).toBe('private.example.invalid');
      expect(headers.get('x-forwarded-proto')).toBe('https');
      expect(headers.get('x-forwarded-for')).toBe('203.0.113.7');
      expect(headers.get('x-request-id')).toBe(response.headers['x-correlation-id']);
      expect(headers.get('x-request-id')).not.toBe('untrusted-client-id');
      expect(response.headers['x-lunchlineup-api-version']).toBe('2');
      expect(response.headers['x-lunchlineup-service-release']).toBe('a'.repeat(40));
      if ('redirect' in fixture) {
        expect(response.statusCode).toBe(302); expect(response.headers.location).toBe('/dashboard');
        expect(response.body).toBe(''); expect(response.headers['cache-control']).toBe('no-store');
        expect(responseCookies(response.headers['set-cookie'])).toEqual([clearCorrelation]);
      } else {
        expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ transportResult: true });
        expect(response.headers['cache-control']).toBe('private, no-store');
        expect(response.headers['set-cookie']).toEqual(sessionCookies);
      }
      noNativeDispatch(h);
    }
    expect(h.readyIdentity).toHaveBeenCalledOnce(); expect(h.quota.ready).toHaveBeenCalledOnce();
    expect(h.database.ready).not.toHaveBeenCalled();
  });

  it('preserves refusal transport for every reviewed retained authentication route', async () => {
    const h = await harness(() => upstream(JSON.stringify({ message: 'Invalid sign-in attempt' }), 401, [clearCorrelation]));
    for (const fixture of authFixtures) {
      const response = await h.app.inject({ method: fixture.method, url: `/v2${fixture.path}`,
        ...(fixture.method === 'GET' ? {} : { payload: { synthetic: true } }) });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ status: 401, code: 'authentication_required', detail: 'Invalid sign-in attempt' });
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(responseCookies(response.headers['set-cookie'])).toEqual([clearCorrelation]);
      expect(response.headers.location).toBeUndefined();
    }
    expect(h.fetchMock).toHaveBeenCalledTimes(17); noNativeDispatch(h);
  });

  it('keeps current session authentication with the native owner', async () => {
    const h = await harness(() => { throw new Error('Unexpected retained session hop'); });
    const response = await h.app.inject({ method: 'GET', url: '/v2/auth/me' });
    expect(response.statusCode).toBe(401); expect(h.authenticate).toHaveBeenCalledOnce();
    expect(h.fetchMock).not.toHaveBeenCalled(); expect(h.quota.consume).not.toHaveBeenCalled();
  });

  it('preserves valid logout no-content responses and cookie cleanup', async () => {
    const h = await harness(() => upstream(null, 204, [clearCorrelation]));
    const response = await h.app.inject({ method: 'POST', url: '/v2/auth/logout', payload: {} });
    expect(response.statusCode).toBe(204); expect(response.body).toBe('');
    expect(responseCookies(response.headers['set-cookie'])).toEqual([clearCorrelation]);
    expect(h.fetchMock).toHaveBeenCalledOnce(); noNativeDispatch(h);
  });

  it('forwards only expiring cookie cleanup on a retained refusal', async () => {
    const expired = 'access_token=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Path=/';
    const h = await harness(() => upstream('{}', 401, [clearCorrelation, expired, ...sessionCookies,
      'refresh_token=new; Max-Age=600; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/',
      'access_token=new; Max-Age=0; Max-Age=600; Path=/',
      'access_token=spaced; Max-Age =3600; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/',
      'access_token=duplicate; Max-Age=0; Max-Age =600; Path=/',
      'access_token=duplicate-expiry; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Expires =Tue, 01 Jan 2030 00:00:00 GMT; Path=/',
      'access_token=iso; Expires=1970-01-01T00:00:00Z; Path=/',
      'access_token=ancient; Expires=Wed, 01 Jan 1000 00:00:00 GMT; Path=/',
    ]));
    const response = await h.app.inject('/v2/auth/callback?code=synthetic&state=synthetic');
    expect(response.statusCode).toBe(401);
    expect(responseCookies(response.headers['set-cookie'])).toEqual([clearCorrelation, expired]);
    expect(response.headers.location).toBeUndefined();
    expect(h.fetchMock).toHaveBeenCalledOnce(); noNativeDispatch(h);
  });

  it.each([301, 302, 303, 307, 308])('preserves valid OIDC redirect status %s with separate cookies', async status => {
    const cookies = [...sessionCookies, clearCorrelation];
    const h = await harness(() => upstream(null, status, cookies, 'https://oidc.example.invalid/authorize?state=synthetic'));
    const response = await h.app.inject('/v2/auth/login?tenantSlug=demo');
    expect(response.statusCode).toBe(status);
    expect(response.headers.location).toBe('https://oidc.example.invalid/authorize?state=synthetic');
    expect(response.headers['set-cookie']).toEqual(cookies);
    expect(response.body).toBe(''); expect(response.headers['cache-control']).toBe('no-store');
    expect(h.fetchMock).toHaveBeenCalledOnce(); noNativeDispatch(h);
  });

  it.each([
    { status: 304, location: '/dashboard' },
    { status: 302, location: 'javascript:alert(1)' },
    { status: 302, location: '//attacker.invalid/session' },
    { status: 302, location: '/\\attacker.invalid/session' },
    { status: 302, location: '' },
  ])('refuses malformed OIDC redirect $status $location without setting credentials', async ({ status, location }) => {
    const h = await harness(() => upstream(null, status, sessionCookies, location));
    const response = await h.app.inject('/v2/auth/callback?code=synthetic&state=synthetic');
    expect(response.statusCode).toBe(502); expect(response.json().code).toBe('invalid_compatibility_response');
    expect(response.headers['set-cookie']).toBeUndefined(); expect(response.headers.location).toBeUndefined();
    expect(h.fetchMock).toHaveBeenCalledOnce(); noNativeDispatch(h);
  });

  it.each([
    { body: '{', type: 'application/json' }, { body: '', type: 'application/json' },
    { body: 'not json', type: 'text/plain' },
  ])('refuses invalid successful JSON transport $type $body without setting credentials', async ({ body, type }) => {
    const h = await harness(() => new Response(body, { status: 200,
      headers: { 'content-type': type, 'set-cookie': sessionCookies[0] } }));
    const response = await h.app.inject({ method: 'POST', url: '/v2/auth/password/verify', payload: { synthetic: true } });
    expect(response.statusCode).toBe(502); expect(response.json().code).toBe('invalid_compatibility_response');
    expect(response.headers['set-cookie']).toBeUndefined(); expect(response.headers.location).toBeUndefined();
    expect(h.fetchMock).toHaveBeenCalledOnce(); noNativeDispatch(h);
  });

  it('refuses a JSON success where OIDC requires a redirect', async () => {
    const h = await harness(() => upstream('{}', 200, sessionCookies));
    const response = await h.app.inject('/v2/auth/callback?code=synthetic&state=synthetic');
    expect(response.statusCode).toBe(502); expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers.location).toBeUndefined(); expect(h.fetchMock).toHaveBeenCalledOnce(); noNativeDispatch(h);
  });

  it.each(['declared', 'streamed'] as const)('bounds %s upstream response bytes before forwarding credentials', async mode => {
    const limit = 2 * 1024 * 1024;
    const h = await harness(() => {
      const headers = new Headers({ 'content-type': 'application/json', 'set-cookie': sessionCookies[0] });
      if (mode === 'declared') { headers.set('content-length', String(limit + 1)); return new Response('{}', { headers }); }
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new Uint8Array(limit)); controller.enqueue(new Uint8Array(1)); controller.close();
      } });
      return new Response(body, { headers });
    });
    const response = await h.app.inject({ method: 'POST', url: '/v2/auth/password/verify', payload: { synthetic: true } });
    expect(response.statusCode).toBe(502); expect(response.json().code).toBe('invalid_compatibility_response');
    expect(response.headers['set-cookie']).toBeUndefined(); expect(h.fetchMock).toHaveBeenCalledOnce(); noNativeDispatch(h);
  });

  it.each([
    { type: 'application/json', payload: '{', status: 400, code: 'FST_ERR_CTP_INVALID_JSON_BODY', contentLength: undefined },
    { type: 'application/json', payload: '', status: 400, code: 'FST_ERR_CTP_EMPTY_JSON_BODY', contentLength: undefined },
    { type: 'application/json', payload: '{}', status: 400, code: 'FST_ERR_CTP_INVALID_CONTENT_LENGTH', contentLength: '4' },
    { type: 'application/json', payload: JSON.stringify({ token: 'x'.repeat(2048) }), status: 413, code: 'FST_ERR_CTP_BODY_TOO_LARGE', contentLength: undefined },
    { type: 'application/x-unrecognized', payload: 'synthetic', status: 415, code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE', contentLength: undefined },
  ])('refuses client parser input $code as $status before a retained call', async ({ type, payload, status, code, contentLength }) => {
    const h = await harness(() => { throw new Error('Unexpected request after parser rejection'); });
    const seen: Array<{ code: unknown; status: unknown }> = [];
    h.app.addHook('onError', (_request, _reply, error, done) => { seen.push({ code: error.code, status: error.statusCode }); done(); });
    const response = await h.app.inject({ method: 'POST', url: '/v2/account-deletion/receipt', payload,
      headers: { 'content-type': type, ...(contentLength ? { 'content-length': contentLength } : {}) } });
    expect(seen).toEqual([{ code, status }]);
    expect(response.statusCode).toBe(status); expect(response.json().status).toBe(status);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.headers['set-cookie']).toBeUndefined(); expect(h.fetchMock).not.toHaveBeenCalled(); noNativeDispatch(h);
  });

  it.each(['DOMAIN_FAILURE', 'FST_ERR_CTP_BODY_TOO_LARGE'])('does not trust arbitrary domain error %s as a client parser error', async code => {
    const h = await harness(() => { throw new Error('unused'); });
    h.app.get('/v2/synthetic-domain-error', async () => { throw Object.assign(new Error('private credential failure'), { statusCode: 413, code }); });
    const response = await h.app.inject('/v2/synthetic-domain-error');
    expect(response.statusCode).toBe(500); expect(response.json().code).toBe('internal_error');
    expect(response.body).not.toContain('private credential failure'); expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('sanitizes retained refusal extensions while preserving correlation cleanup', async () => {
    const h = await harness(() => upstream(JSON.stringify({ message: 'Authorization: Bearer secret-value http://10.0.0.1/sql',
      code: 'BAD\nCODE', remediation: 'cookie=private-value', stack: 'private-stack', token: 'private-token' }), 400, [clearCorrelation]));
    const response = await h.app.inject('/v2/auth/callback?code=synthetic&state=synthetic');
    expect(response.statusCode).toBe(422); expect(response.json()).toMatchObject({ status: 422, code: 'request_validation_failed' });
    for (const secret of ['secret-value', '10.0.0.1', 'private-value', 'private-stack', 'private-token', 'BAD']) expect(response.body).not.toContain(secret);
    expect(responseCookies(response.headers['set-cookie'])).toEqual([clearCorrelation]); expect(response.headers.location).toBeUndefined();
    expect(h.fetchMock).toHaveBeenCalledOnce(); noNativeDispatch(h);
  });

  it('maps malformed retained error JSON to a refusal rather than a success', async () => {
    const h = await harness(() => upstream('{', 401));
    const response = await h.app.inject('/v2/auth/callback?code=synthetic&state=synthetic');
    expect(response.statusCode).toBe(503); expect(response.json().code).toBe('invalid_compatibility_response');
    expect(response.headers.location).toBeUndefined(); expect(h.fetchMock).toHaveBeenCalledOnce(); noNativeDispatch(h);
  });

  it('maps transport failure to bounded service unavailability', async () => {
    const h = await harness(() => { throw new Error('private upstream credential'); });
    const response = await h.app.inject({ method: 'POST', url: '/v2/auth/refresh', payload: {} });
    expect(response.statusCode).toBe(503); expect(response.json().code).toBe('retained_application_unavailable');
    expect(response.body).not.toContain('private upstream credential'); expect(response.headers['set-cookie']).toBeUndefined();
    expect(h.fetchMock).toHaveBeenCalledOnce(); noNativeDispatch(h);
  });

  it('maps a broken upstream body stream to unavailability before forwarding credentials', async () => {
    const h = await harness(() => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.error(new Error('private stream credential'));
    } }), { headers: { 'content-type': 'application/json', 'set-cookie': sessionCookies[0] } }));
    const response = await h.app.inject({ method: 'POST', url: '/v2/auth/refresh', payload: {} });
    expect(response.statusCode).toBe(503); expect(response.json().code).toBe('retained_application_unavailable');
    expect(response.body).not.toContain('private stream credential'); expect(response.headers['set-cookie']).toBeUndefined();
    expect(h.fetchMock).toHaveBeenCalledOnce(); noNativeDispatch(h);
  });
});
