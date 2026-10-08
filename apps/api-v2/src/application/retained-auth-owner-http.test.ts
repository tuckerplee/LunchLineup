import { APPLICATION_API_OPERATIONS } from '@lunchlineup/api-contract';
import 'reflect-metadata';
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import type { Response as InjectResponse } from 'light-my-request';
import { BadRequestException, Logger, UnauthorizedException, type ArgumentsHost } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthController } from '../../../api/src/auth/auth.controller';
import type { AuthService } from '../../../api/src/auth/auth.service';
import type { EmailService } from '../../../api/src/auth/email.service';
import { OtpService } from '../../../api/src/auth/otp.service';
import { ProductionExceptionFilter } from '../../../api/src/common/production-exception.filter';
import { loadConfig } from '../config';
import { installProblemHandler } from '../platform/problem';
import { RetainedApplicationBridge } from '../platform/retained-application.bridge';
import { registerApplicationRoutes } from './routes';

// Real controller, OTP normalization/HMAC/script construction, production error filter,
// registrar, bridge and Fastify inject. AuthService outcomes below are predetermined
// wire seams: no JWT guard, issuance transaction, provider, socket, Redis or browser proof.
// Express cookie/clearCookie serialization is the installed retained owner's implementation.
// Root's private suite runner uses cwd apps/api-v2; resolve through the actual
// retained package without import.meta (inclusive legacy TypeScript is CommonJS).
const legacyRequire = createRequire(resolve(process.cwd(), '../api/package.json'));
const express = legacyRequire('express') as typeof import('express');
const config = loadConfig({
  APP_ORIGIN: 'https://private.example.invalid',
  LEGACY_API_BASE_URL: 'http://retained.example.invalid/v1',
  JWT_SECRET: 'synthetic-owner-http-secret', NODE_ENV: 'test', LOG_LEVEL: 'silent',
  METRICS_TOKEN: 'synthetic-owner-http-metrics-token-0000000000000000',
});
const origin = 'https://private.example.invalid';
const next = '/dashboard/staff';
const otpHmacKey = 'synthetic-otp-hmac-key-for-local-owner-test';
const credentialNames = ['access_token', 'refresh_token', 'csrf_token'];
const loginPaths = ['/auth/password/verify', '/auth/pin/verify', '/auth/email/verify-otp'] as const;
type LoginPath = typeof loginPaths[number];
const bodies: Record<LoginPath, Record<string, unknown>> = {
  '/auth/password/verify': { identifier: 'shiftlead', password: 'synthetic-password', tenantSlug: 'demo' },
  '/auth/pin/verify': { identifier: 'shiftlead', pin: '123456', tenantSlug: 'demo' },
  '/auth/email/verify-otp': { email: 'staff@example.invalid', code: '123456', tenantSlug: 'demo' },
};
function issued(overrides: { pinResetRequired?: boolean; requiresMfa?: boolean } = {}) {
  return { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', csrfToken: 'synthetic-csrf',
    sessionMaxAgeMs: 15 * 60_000, pinResetRequired: false, requiresMfa: false,
    workspaceSlug: 'demo', user: { id: 'synthetic-user', role: 'STAFF' }, ...overrides };
}

function capturedResponse() {
  const headers = new Map<string, string | string[]>();
  let status = 200, body: string | null = null, finished = false;
  // Only actual Express cookie/clearCookie/append/get/set are inherited. HTTP IO
  // and owner json/redirect/status are explicit capture adapters, not a listener.
  const response = Object.create(express.response) as ExpressResponse;
  response.setHeader = ((name: string, value: string | string[]) => {
    headers.set(name.toLowerCase(), value); return response;
  }) as ExpressResponse['setHeader'];
  response.getHeader = ((name: string) => headers.get(name.toLowerCase())) as ExpressResponse['getHeader'];
  response.status = (value: number) => { status = value; return response; };
  response.json = (value: unknown) => {
    headers.set('content-type', 'application/json; charset=utf-8');
    body = JSON.stringify(value); finished = true; return response;
  };
  response.redirect = ((first: number | string, second?: string) => {
    status = typeof first === 'number' ? first : 302;
    headers.set('location', typeof first === 'string' ? first : second!);
    body = null; finished = true;
  }) as ExpressResponse['redirect'];
  return { response, complete(value: unknown) {
    if (!finished) response.json(value);
    const wire = new Headers();
    for (const [name, value] of headers) {
      if (Array.isArray(value)) for (const entry of value) wire.append(name, entry);
      else wire.set(name, value);
    }
    return new Response(body, { status, headers: wire });
  } };
}

type OwnerHarness = Awaited<ReturnType<typeof harness>>;
const owners: Array<{ app: FastifyInstance; unexpected: string[];
  authenticate: unknown; quota: { consume: unknown } }> = [];
beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('COOKIE_SECURE', 'true');
  vi.stubEnv('APP_ORIGIN', origin);
  vi.stubEnv('OIDC_ENABLED', 'true'); vi.stubEnv('AUTH_DEBUG', 'false');
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(async () => {
  try {
    for (const h of owners) {
      // Outside fetch's catch: unexpected owner/target/adapter work cannot be
      // hidden by the bridge converting a rejected fetch to a generic503.
      expect(h.unexpected).toEqual([]);
      expect(h.authenticate).not.toHaveBeenCalled();
      expect(h.quota.consume).not.toHaveBeenCalled();
    }
  } finally {
    try { for (const h of owners.splice(0)) await h.app.close(); }
    finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); }
  }
});

async function harness(options: { deny?: boolean; result?: ReturnType<typeof issued>;
  corrupt?: (wire: Response) => Response } = {}) {
  const unexpected: string[] = [], completed: string[] = [];
  const result = options.result ?? issued();
  async function outcome(name: string) {
    if (options.deny) throw new UnauthorizedException('private credential detail');
    completed.push(name); return result;
  }
  const auth = {
    loginWithUsernamePassword: vi.fn(async () => outcome('password-outcome')),
    loginWithUsernamePin: vi.fn(async () => outcome('pin-outcome')),
    loginWithEmail: vi.fn(async () => outcome('email-outcome')),
    handleOidcCallback: vi.fn(async () => outcome('oidc-outcome')),
    consumeOidcState: vi.fn(async () => ({ nextPath: next, tenantSlug: 'demo' })),
    resolveLoginMethod: vi.fn(async () => ({ flow: 'USERNAME_PASSWORD', normalizedIdentifier: 'shiftlead' })),
    createPasswordReset: vi.fn(async () => undefined),
    resetPasswordWithToken: vi.fn(async () => undefined),
    assertEmailOtpAllowed: vi.fn(async () => false),
    createOnboardingSignupChallenge: vi.fn(async () => {
      unexpected.push('unexpected onboarding provisioning'); throw new Error('Unexpected onboarding provisioning');
    }),
  };
  const redis = { eval: vi.fn(async (script: string, keyCount: number, ...args: string[]) => {
    if (keyCount !== 3 || !script.includes("redis.call('GET', KEYS[1])")
      || args[0] !== 'otp:tenant:demo:staff@example.invalid'
      || args[1] !== 'otp_attempts:tenant:demo:staff@example.invalid'
      || args[2] !== 'otp_lock:tenant:demo:staff@example.invalid'
      || args.length !== 6 || args[3] !== createHmac('sha256', otpHmacKey)
        .update('tenant:demo:staff@example.invalid').update('\0').update('123456').digest('hex')
      || args[4] !== '5' || args[5] !== '600' || args.includes('123456')) {
      unexpected.push('unexpected OTP Redis script/selectors'); throw new Error('Unexpected OTP adapter call');
    }
    completed.push(options.deny ? 'redis-verify-rejected' : 'redis-verify-accepted');
    return options.deny ? 0 : 1;
  }) };
  const otp = new OtpService(new ConfigService({ NODE_ENV: 'test', OTP_HMAC_SECRET: otpHmacKey }));
  // Inject external adapter before any owner call; the lazy real Redis constructor
  // is never reached. Script execution/concurrency itself is not modeled here.
  Object.defineProperty(otp, 'redis', { value: redis });
  const email = { sendOtp: vi.fn(async () => {
    unexpected.push('unexpected external email'); throw new Error('Unexpected email');
  }) };
  const controller = new AuthController(auth as unknown as AuthService, otp, email as unknown as EmailService);
  const filter = new ProductionExceptionFilter();
  const fetchMock = vi.fn(async (target: string | URL | Request, init?: RequestInit) => {
    const url = typeof target === 'string' ? new URL(target) : null;
    if (!url || url.origin !== 'http://retained.example.invalid' || !url.pathname.startsWith('/v1/auth/')
      || !init || init.redirect !== 'manual' || !(init.signal instanceof AbortSignal)) {
      unexpected.push('unexpected fetch target/options'); throw new Error('Unexpected target');
    }
    // Node fetch supplies the upstream Host header on the real request.
    const wireHeaders: Record<string, string> = { ...Object.fromEntries(new Headers(init.headers).entries()), host: url.host };
    const req = { headers: wireHeaders, query: Object.fromEntries(url.searchParams),
      cookies: Object.fromEntries((wireHeaders.cookie ?? '').split(';').filter(Boolean).map(value => {
        const i = value.indexOf('='); return [value.slice(0, i).trim(), decodeURIComponent(value.slice(i + 1))];
      })), method: init.method, protocol: 'https', ip: '198.51.100.20',
      originalUrl: url.pathname + url.search, url: url.pathname + url.search,
      correlationId: 'synthetic-owner-request', get: (name: string) => wireHeaders[name.toLowerCase()],
    } as unknown as ExpressRequest;
    const capture = capturedResponse();
    capture.response.req = req; // Express cookie reads req.secret even when unsigned.
    let value: unknown;
    try {
      let body: unknown;
      if (typeof init.body === 'string') {
        try { body = JSON.parse(init.body); }
        // Explicit parser seam only: this is not an actual Express body parser.
        catch { throw new BadRequestException('Malformed JSON'); }
      } else if (init.body !== undefined) {
        unexpected.push('unexpected retained body representation'); throw new Error('Unexpected body');
      }
      const key = `${init.method} ${url.pathname}`;
      switch (key) {
        case 'POST /v1/auth/password/verify':
          value = await controller.verifyPassword(body as Parameters<AuthController['verifyPassword']>[0], req, capture.response); break;
        case 'POST /v1/auth/pin/verify':
          value = await controller.verifyPin(body as Parameters<AuthController['verifyPin']>[0], req, capture.response); break;
        case 'POST /v1/auth/email/verify-otp':
          value = await controller.verifyOtp(body as Parameters<AuthController['verifyOtp']>[0], req, capture.response); break;
        case 'POST /v1/auth/login/resolve':
          value = await controller.resolveLoginFlow(body as Parameters<AuthController['resolveLoginFlow']>[0], req); break;
        case 'POST /v1/auth/password/reset/request':
          value = await controller.requestPasswordReset(body as Parameters<AuthController['requestPasswordReset']>[0], req); break;
        case 'POST /v1/auth/password/reset/confirm':
          value = await controller.confirmPasswordReset(body as Parameters<AuthController['confirmPasswordReset']>[0], req); break;
        case 'POST /v1/auth/email/send-otp':
          value = await controller.sendOtp(body as Parameters<AuthController['sendOtp']>[0], req); break;
        case 'GET /v1/auth/callback': value = await controller.callback(req, capture.response); break;
        default: unexpected.push(`unexpected owner route: ${key}`); throw new Error('Unexpected owner route');
      }
    } catch (error) {
      filter.catch(error, { switchToHttp: () => ({ getRequest: () => req,
        getResponse: () => capture.response }) } as unknown as ArgumentsHost);
    }
    const wire = capture.complete(value);
    return options.corrupt ? options.corrupt(wire) : wire;
  });
  vi.stubGlobal('fetch', fetchMock);
  const app: FastifyInstance = Fastify({ logger: false });
  installProblemHandler(app);
  const authenticate = vi.fn(async () => {
    unexpected.push('unexpected native identity'); throw new Error('Unexpected native identity');
  });
  const quota = { consume: vi.fn(async () => {
    unexpected.push('unexpected native quota'); throw new Error('Unexpected native quota');
  }) };
  const bridge = new RetainedApplicationBridge(config);
  const h = { app, auth, redis, otp, email, completed, unexpected, fetchMock, authenticate, quota };
  owners.push(h);
  await registerApplicationRoutes(app, { config, identity: { authenticate } as never, quota,
    retainedApplication: bridge });
  await app.ready();
  return h;
}

function cookies(value: string | string[] | undefined): string[] {
  return value === undefined ? [] : typeof value === 'string' ? [value] : value;
}
function expectCredentials(value: string | string[] | undefined) {
  const all = cookies(value);
  expect(all).toHaveLength(3);
  expect(all.map(cookie => cookie.slice(0, cookie.indexOf('='))).sort()).toEqual([...credentialNames].sort());
  for (const cookie of all) {
    expect(cookie).toContain('Path=/'); expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    if (!cookie.startsWith('csrf_token=')) expect(cookie).toContain('HttpOnly');
    else expect(cookie).not.toContain('HttpOnly');
  }
}
function expectedCompletion(path: LoginPath) {
  return path === '/auth/password/verify' ? ['password-outcome']
    : path === '/auth/pin/verify' ? ['pin-outcome'] : ['redis-verify-accepted', 'email-outcome'];
}
async function login(h: OwnerHarness, path: LoginPath, redirect: boolean, payload: unknown = bodies[path]) {
  return h.app.inject({ method: 'POST', url: `/v2${path}?next=${encodeURIComponent(next)}${redirect ? '&redirect=1' : ''}`,
    headers: { origin, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
}
function assertRejected(h: OwnerHarness, response: InjectResponse, status: number) {
  expect(response.statusCode).toBe(status);
  expect(response.json()).toMatchObject({ status, message: status === 422 ? 'Bad request' : 'Authentication required' });
  expect(response.headers['content-type']).toContain('application/problem+json');
  expect(response.headers['cache-control']).toBe('no-store');
  expect(cookies(response.headers['set-cookie'])).toEqual([]);
  expect(h.completed).toEqual([]); expect(h.redis.eval).not.toHaveBeenCalled();
  expect(h.auth.loginWithUsernamePassword).not.toHaveBeenCalled();
  expect(h.auth.loginWithUsernamePin).not.toHaveBeenCalled(); expect(h.auth.loginWithEmail).not.toHaveBeenCalled();
}

describe('controlled retained authentication owner HTTP contracts', () => {
  for (const path of loginPaths) {
    it(`preserves actual ${path} JSON success fields and serialized credentials`, async () => {
      const h = await harness(), response = await login(h, path, false);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ success: true, redirectTo: next, requiresMfa: false });
      expect(response.body).not.toContain('synthetic-access'); expect(response.body).not.toContain('synthetic-refresh');
      expect(response.headers['cache-control']).toBe('private, no-store'); expectCredentials(response.headers['set-cookie']);
      expect(h.completed).toEqual(expectedCompletion(path)); expect(h.fetchMock).toHaveBeenCalledTimes(1);
    });
    it(`preserves actual ${path} redirect-mode success after the selected owner completes`, async () => {
      const h = await harness(), response = await login(h, path, true);
      expect(response.statusCode).toBe(302); expect(response.headers.location).toBe(next);
      expect(response.headers['cache-control']).toBe('no-store'); expectCredentials(response.headers['set-cookie']);
      expect(h.completed).toEqual(expectedCompletion(path)); expect(h.fetchMock).toHaveBeenCalledTimes(1);
    });
    it(`preserves actual ${path} Unauthorized form redirect without credentials`, async () => {
      const h = await harness({ deny: true }), response = await login(h, path, true);
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/auth/login?error=invalid&tenantSlug=demo&next=%2Fdashboard%2Fstaff');
      expect(cookies(response.headers['set-cookie'])).toEqual([]);
      expect(h.completed).toEqual(path === '/auth/email/verify-otp' ? ['redis-verify-rejected'] : []);
      if (path === '/auth/email/verify-otp') expect(h.auth.loginWithEmail).not.toHaveBeenCalled();
    });
    it(`uses the production error payload for actual ${path} JSON Unauthorized`, async () => {
      const h = await harness({ deny: true }), response = await login(h, path, false);
      expect(response.statusCode).toBe(401); expect(response.json()).toMatchObject({ status: 401, message: 'Authentication required' });
      expect(response.body).not.toContain('private credential detail'); expect(cookies(response.headers['set-cookie'])).toEqual([]);
    });
  }

  it('rejects a3xx from a JSON-only operation despite a redirect query', async () => {
    const h = await harness({ corrupt: () => new Response(null, { status: 302,
      headers: { location: next, 'set-cookie': 'access_token=synthetic-corruption; Path=/; Secure; HttpOnly' } }) });
    const response = await h.app.inject({ method: 'POST', url: '/v2/auth/login/resolve?redirect=1',
      headers: { origin }, payload: { identifier: 'shiftlead', tenantSlug: 'demo' } });
    expect(h.auth.resolveLoginMethod).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(502); expect(cookies(response.headers['set-cookie'])).toEqual([]);
    expect(response.json().code).toBe('invalid_compatibility_response');
  });
  it('rejects a3xx for a login operation without its single-string redirect opt-in', async () => {
    const h = await harness({ corrupt: wire => {
      const headers = new Headers(wire.headers); headers.set('location', next);
      return new Response(null, { status: 302, headers });
    } });
    const response = await login(h, '/auth/password/verify', false);
    expect(h.completed).toEqual(['password-outcome']);
    expect(response.statusCode).toBe(502); expect(cookies(response.headers['set-cookie'])).toEqual([]);
  });
  it('declares form redirects only for the three retained POST credential endpoints', () => {
    const selected = APPLICATION_API_OPERATIONS.filter(operation => 'supportsLoginRedirect' in operation
      && operation.supportsLoginRedirect === true);
    expect(selected.map(operation => [operation.method, operation.path]).sort()).toEqual([
      ['POST', '/auth/password/verify'], ['POST', '/auth/pin/verify'], ['POST', '/auth/email/verify-otp'],
    ].sort());
  });
  for (const query of ['redirect=0', 'redirect=true', 'redirect=1&redirect=1']) {
    it(`refuses an owner redirect for non-opt-in login query ${query} without publishing credentials`, async () => {
      const h = await harness({ corrupt: wire => {
        const headers = new Headers(wire.headers); headers.set('location', next);
        return new Response(null, { status: 302, headers });
      } });
      const response = await h.app.inject({ method: 'POST',
        url: `/v2/auth/password/verify?next=${encodeURIComponent(next)}&${query}`,
        headers: { origin }, payload: bodies['/auth/password/verify'] });
      expect(h.completed).toEqual(['password-outcome']);
      expect(response.statusCode).toBe(502); expect(cookies(response.headers['set-cookie'])).toEqual([]);
      expect(response.json().code).toBe('invalid_compatibility_response');
    });
  }
  for (const location of ['//external.example.invalid/path', 'javascript:alert(1)', '/path\\escape']) {
    it(`rejects invalid redirect Location ${JSON.stringify(location)} before publishing real owner cookies`, async () => {
      const h = await harness({ corrupt: wire => {
        const headers = new Headers(wire.headers); headers.set('location', location);
        return new Response(null, { status: 302, headers });
      } });
      const response = await login(h, '/auth/password/verify', true);
      expect(h.completed).toEqual(['password-outcome']); // Predetermined owner result already completed, no rollback claim.
      expect(response.statusCode).toBe(502); expect(cookies(response.headers['set-cookie'])).toEqual([]);
    });
  }

  it('rejects numeric OTP at the actual controller before OTP Redis or credential issuance', async () => {
    const h = await harness();
    assertRejected(h, await login(h, '/auth/email/verify-otp', false,
      { ...bodies['/auth/email/verify-otp'], code: 123456 }), 422);
  });
  const shapePaths = [
    '/auth/login/resolve', '/auth/password/verify', '/auth/pin/verify', '/auth/email/verify-otp',
    '/auth/email/send-otp', '/auth/password/reset/request', '/auth/password/reset/confirm',
  ] as const;
  for (const path of shapePaths) for (const [name, body] of [['null', null], ['array', []], ['boolean', true], ['number', 17]] as const) {
    it(`rejects ${name} body at actual ${path} owner without side effects`, async () => {
      const h = await harness();
      const response = await h.app.inject({ method: 'POST', url: `/v2${path}`,
        headers: { origin, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
      assertRejected(h, response, 422);
      expect(h.auth.resolveLoginMethod).not.toHaveBeenCalled(); expect(h.auth.createPasswordReset).not.toHaveBeenCalled();
      expect(h.auth.resetPasswordWithToken).not.toHaveBeenCalled(); expect(h.auth.assertEmailOtpAllowed).not.toHaveBeenCalled();
    });
  }
  const typeCases = [
    ['/auth/password/verify', { ...bodies['/auth/password/verify'], password: {} }],
    ['/auth/password/verify', { ...bodies['/auth/password/verify'], identifier: 17 }],
    ['/auth/pin/verify', { ...bodies['/auth/pin/verify'], pin: 123456 }],
    ['/auth/pin/verify', { ...bodies['/auth/pin/verify'], tenantSlug: [] }],
    ['/auth/email/verify-otp', { ...bodies['/auth/email/verify-otp'], code: [] }],
    ['/auth/email/verify-otp', { ...bodies['/auth/email/verify-otp'], tenantSlug: {} }],
    ['/auth/email/send-otp', { email: 'staff@example.invalid', tenantSlug: {} }],
    ['/auth/login/resolve', { identifier: {}, tenantSlug: 'demo' }],
    ['/auth/password/reset/request', { identifier: 'shiftlead', tenantSlug: {} }],
    ['/auth/password/reset/confirm', { token: {}, password: 'synthetic-new-password' }],
    ['/auth/password/reset/confirm', { token: 'synthetic-reset-token', password: [] }],
  ] as const;
  for (const [ordinal, [path, payload]] of typeCases.entries()) {
    it(`rejects malformed typed fields case ${ordinal + 1} at actual ${path} owner`, async () => {
      const h = await harness();
      const response = await h.app.inject({ method: 'POST', url: `/v2${path}`, headers: { origin }, payload });
      assertRejected(h, response, 422);
      expect(h.auth.resolveLoginMethod).not.toHaveBeenCalled(); expect(h.auth.createPasswordReset).not.toHaveBeenCalled();
      expect(h.auth.resetPasswordWithToken).not.toHaveBeenCalled(); expect(h.auth.assertEmailOtpAllowed).not.toHaveBeenCalled();
    });
  }

  for (const redirect of [false, true]) {
    it(`prioritizes forced PIN rotation over MFA for actual OTP ${redirect ? 'redirect' : 'JSON'} success`, async () => {
      const h = await harness({ result: issued({ pinResetRequired: true, requiresMfa: true }) });
      const response = await login(h, '/auth/email/verify-otp', redirect);
      const destination = '/auth/reset-pin?next=%2Fdashboard%2Fstaff';
      expect(response.statusCode).toBe(redirect ? 302 : 200);
      if (redirect) expect(response.headers.location).toBe(destination);
      else expect(response.json()).toMatchObject({ success: true, redirectTo: destination, pinResetRequired: true, requiresMfa: true });
      expectCredentials(response.headers['set-cookie']); expect(h.completed).toEqual(['redis-verify-accepted', 'email-outcome']);
    });
  }
  for (const [name, state, destination] of [
    ['forced PIN before MFA', { pinResetRequired: true, requiresMfa: true }, '/auth/reset-pin?next=%2Fdashboard%2Fstaff'],
    ['MFA only', { pinResetRequired: false, requiresMfa: true }, '/mfa?next=%2Fdashboard%2Fstaff'],
    ['normal', { pinResetRequired: false, requiresMfa: false }, next],
  ] as const) {
    it(`preserves actual OIDC callback ${name} destination and correlation cleanup`, async () => {
      const h = await harness({ result: issued(state) });
      const response = await h.app.inject({ method: 'GET', url: '/v2/auth/callback?code=synthetic-code&state=synthetic-state',
        headers: { cookie: 'oidc_correlation=synthetic-nonce' } });
      expect(response.statusCode).toBe(302); expect(response.headers.location).toBe(destination);
      expect(h.auth.consumeOidcState).toHaveBeenCalledWith('synthetic-state', 'synthetic-nonce');
      expect(h.auth.handleOidcCallback).toHaveBeenCalledTimes(1); expect(h.completed).toEqual(['oidc-outcome']);
      const all = cookies(response.headers['set-cookie']);
      expect(all).toHaveLength(4); expect(all[0]).toMatch(/^oidc_correlation=;/); expect(all[0]).toContain('Expires=Thu, 01 Jan 1970');
      expectCredentials(all.slice(1));
    });
  }
  it('preserves invalid email application-level200 refusal instead of inventing a Problem schema', async () => {
    const h = await harness();
    const response = await h.app.inject({ method: 'POST', url: '/v2/auth/email/send-otp', headers: { origin }, payload: { email: 'not-email' } });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ success: false, error: 'Invalid email address' });
    expect(h.redis.eval).not.toHaveBeenCalled(); expect(h.auth.assertEmailOtpAllowed).not.toHaveBeenCalled();
    expect(h.email.sendOtp).not.toHaveBeenCalled(); expect(cookies(response.headers['set-cookie'])).toEqual([]);
  });
  it('denies a production pre-session origin violation before any real owner credential effect', async () => {
    const h = await harness();
    const response = await h.app.inject({ method: 'POST', url: '/v2/auth/password/verify',
      headers: { origin: 'https://external.example.invalid' }, payload: bodies['/auth/password/verify'] });
    expect(response.statusCode).toBe(403); expect(response.json()).toMatchObject({ status: 403, message: 'Forbidden' });
    expect(h.completed).toEqual([]); expect(h.auth.loginWithUsernamePassword).not.toHaveBeenCalled();
    expect(cookies(response.headers['set-cookie'])).toEqual([]);
  });
});
