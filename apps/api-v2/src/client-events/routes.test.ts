import type { SessionIdentity } from '@lunchlineup/api-contract';
import cookie from '@fastify/cookie';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config';
import { installProblemHandler, ProblemError } from '../platform/problem';
import { normalizeClientRoute, registerClientEventRoutes, uiMessageLogRecord } from './routes';

const config = loadConfig({
  APP_ORIGIN: 'https://beta.lunchlineup.com',
  ALLOWED_ORIGINS: 'https://beta.lunchlineup.com',
  LEGACY_API_BASE_URL: 'http://api:3000/v1',
  JWT_SECRET: 'test-api-v2-jwt-secret',
  NODE_ENV: 'test',
  METRICS_TOKEN: 'synthetic-config-metrics-token-00000000000000000000',
  DEPLOY_RELEASE_SHA: 'a'.repeat(40),
  LOG_LEVEL: 'silent',
});

const identity: SessionIdentity = {
  sub: 'user-1',
  publicUserId: 'f6776d21-bb21-4c35-a6ed-5da8df5ed238',
  tenantId: 'tenant-1',
  sessionId: 'session-1',
  role: 'STAFF',
  legacyRole: 'STAFF',
  roles: [],
  permissions: [],
  mfaVerified: true,
  mfaRequired: false,
};

const headers = {
  cookie: 'access_token=test; csrf_token=abcdefghijklmnop',
  origin: 'https://beta.lunchlineup.com',
  'x-csrf-token': 'abcdefghijklmnop',
  'content-type': 'application/json',
};

const apps: Array<ReturnType<typeof Fastify>> = [];

async function harness(options: { authenticated?: boolean; consume?: () => Promise<void> } = {}) {
  const lines: Array<Record<string, unknown>> = [];
  const stream = { write: (chunk: string) => { lines.push(JSON.parse(chunk)); } };
  const app = Fastify({ logger: { level: 'info', stream }, ajv: { customOptions: { removeAdditional: false } } }).withTypeProvider<TypeBoxTypeProvider>();
  apps.push(app as never);
  await app.register(cookie);
  installProblemHandler(app);
  const authenticate = vi.fn(async () => {
    if (options.authenticated === false) {
      throw new ProblemError(401, 'invalid_session', 'A valid application session is required.', 'Unauthorized');
    }
    return identity;
  });
  const consume = vi.fn(options.consume ?? (async () => undefined));
  await registerClientEventRoutes(app as never, { config, identity: { authenticate }, quota: { consume } });
  await app.ready();
  const post = (payload: unknown, extra: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/v2/client-events', headers: { ...headers, ...extra }, payload: payload as never });
  const events = () => lines.filter((line) => line.event === 'ui_message');
  return { app, post, authenticate, consume, events };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('POST /v2/client-events', () => {
  it('logs one structured ui_message line per event with identity from the session', async () => {
    const { post, events, consume } = await harness();
    const response = await post({
      events: [
        { code: 'lunch_breaks.generate.failed', level: 'error', kind: 'message', route: '/dashboard/lunch-breaks', detail: 'payment_required' },
        { code: 'staff.remove.confirm', level: 'warning', kind: 'confirm', route: '/dashboard/staff', outcome: 'cancelled' },
      ],
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: 2 });
    expect(consume).toHaveBeenCalledWith('recordClientEvents', identity, expect.anything());
    expect(events()).toHaveLength(2);
    expect(events()[0]).toMatchObject({
      event: 'ui_message',
      code: 'lunch_breaks.generate.failed',
      uiLevel: 'error',
      kind: 'message',
      route: '/dashboard/lunch-breaks',
      detail: 'payment_required',
      tenantId: 'tenant-1',
      userId: 'user-1',
    });
    expect(events()[1]).toMatchObject({ kind: 'confirm', outcome: 'cancelled' });
  });

  it('rejects client-supplied identity, free text, and unknown fields', async () => {
    const { post, events } = await harness();
    const base = { code: 'a.b', level: 'info', kind: 'message', route: '/dashboard' };
    for (const extra of [
      { tenantId: 'tenant-evil' },
      { userId: 'user-evil' },
      { text: 'Jane Doe was removed' },
      { detail: 'Jane Doe was removed' },
    ]) {
      const response = await post({ events: [{ ...base, ...extra }] });
      expect(response.statusCode).toBe(422);
    }
    expect((await post({ events: [{ ...base, code: 'Has Spaces And Caps' }] })).statusCode).toBe(422);
    expect((await post({ events: [{ ...base, route: 'https://evil.example/' }] })).statusCode).toBe(422);
    expect((await post({ events: [{ ...base, level: 'fatal' }] })).statusCode).toBe(422);
    expect((await post({ events: [{ ...base, outcome: 'maybe' }] })).statusCode).toBe(422);
    expect(events()).toHaveLength(0);
  });

  it('bounds the batch to 20 events and the body size', async () => {
    const { post, events } = await harness();
    const event = { code: 'a.b', level: 'info', kind: 'message', route: '/dashboard' };
    expect((await post({ events: [] })).statusCode).toBe(422);
    expect((await post({ events: Array.from({ length: 21 }, () => event) })).statusCode).toBe(422);
    expect((await post({ events: Array.from({ length: 20 }, () => event) })).statusCode).toBe(202);
    expect(events()).toHaveLength(20);
    const large = await post({ events: [event], padding: 'x'.repeat(9000) });
    expect([400, 413]).toContain(large.statusCode);
  });

  it('requires an authenticated session and the CSRF double submit', async () => {
    const event = { code: 'a.b', level: 'info', kind: 'message', route: '/dashboard' };
    const anonymous = await harness({ authenticated: false });
    expect((await anonymous.post({ events: [event] })).statusCode).toBe(401);
    expect(anonymous.events()).toHaveLength(0);

    const csrf = await harness();
    expect((await csrf.post({ events: [event] }, { 'x-csrf-token': 'wrongwrongwrongwrong' })).statusCode).toBe(403);
    expect((await csrf.post({ events: [event] }, { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect(csrf.events()).toHaveLength(0);
  });

  it('applies the per-session quota before logging', async () => {
    const { post, events } = await harness({
      consume: async () => {
        throw new ProblemError(429, 'rate_limited', 'Too many requests. Try again later.', 'Too many requests');
      },
    });
    const response = await post({ events: [{ code: 'a.b', level: 'info', kind: 'message', route: '/dashboard' }] });
    expect(response.statusCode).toBe(429);
    expect(events()).toHaveLength(0);
  });
});

describe('ui_message log shape', () => {
  it('replaces identifiers in routes and omits absent optional fields', () => {
    expect(normalizeClientRoute('/dashboard/staff/668196db-7db2-4eb7-9808-5cd1a21717b7/edit')).toBe('/dashboard/staff/:id/edit');
    expect(normalizeClientRoute('/admin/tenants/12345')).toBe('/admin/tenants/:id');
    expect(uiMessageLogRecord(
      { code: 'a.b', level: 'success', kind: 'message', route: '/dashboard' },
      { tenantId: 't', sub: 'u' },
    )).toEqual({ event: 'ui_message', code: 'a.b', uiLevel: 'success', kind: 'message', route: '/dashboard', tenantId: 't', userId: 'u' });
  });
});
