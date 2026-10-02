import { EventEmitter } from 'node:events';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Counter, Histogram, Registry, register } from 'prom-client';
import { NativeApiMetrics } from './metrics.js';
import { requestLoopback } from '../../test-support/loopback-http.js';

const TOKEN = 'synthetic-private-metrics-token-00000000000000000000';
const PRIVATE = 'fixture-private-query-user-tenant-marker';
const N = 'lunchlineup_api_v2_http_';
type RequestReply = { request: FastifyRequest; reply: FastifyReply; raw: EventEmitter & { writableFinished: boolean };
  response: { status: number; headers: Record<string, string>; body: unknown } };
type Hook = (request: FastifyRequest, reply: FastifyReply) => unknown;
const owners = new Set<NativeApiMetrics>();
afterEach(() => { for (const owner of owners) owner.close(); owners.clear(); vi.restoreAllMocks(); });

function rr(method = 'GET', route: string | undefined = '/v2/items/:id',
    authorization: unknown = 'Bearer ' + TOKEN, rawHeaders?: string[]): RequestReply {
  const raw = Object.assign(new EventEmitter(), { writableFinished: false });
  const response = { status: 200, headers: {} as Record<string, string>, body: undefined as unknown };
  const request = {
    method, routeOptions: { url: route }, url: '/v2/items/' + PRIVATE + '?token=' + PRIVATE,
    params: { id: PRIVATE }, query: { token: PRIVATE }, body: { tenant: PRIVATE },
    headers: { authorization, cookie: PRIVATE },
    raw: { rawHeaders: rawHeaders ?? (typeof authorization === 'string' ? ['Authorization', authorization] : []) },
  } as unknown as FastifyRequest;
  const reply = {
    raw, get statusCode() { return response.status; },
    header(name: string, value: string) { response.headers[name.toLowerCase()] = value; return reply; },
    code(status: number) { response.status = status; return reply; },
    type(value: string) { response.headers['content-type'] = value; return reply; },
    send(body: unknown) { response.body = body; return reply; },
  } as unknown as FastifyReply;
  return { request, reply, raw, response };
}

function harness(token = TOKEN) {
  const diagnostic = vi.fn();
  const owner = new NativeApiMetrics(token, diagnostic);
  owners.add(owner);
  const hooks = new Map<string, Hook[]>();
  let scrape!: Hook;
  const app = {
    addHook(name: string, hook: Hook) {
      hooks.set(name, [...(hooks.get(name) ?? []), hook]); return app;
    },
    get(url: string, options: object, handler: Hook) {
      for (const hook of hooks.get('onRoute') ?? []) hook({ url, method: 'GET', ...options } as unknown as FastifyRequest, undefined as unknown as FastifyReply);
      scrape = handler; return app;
    },
  } as unknown as FastifyInstance;
  owner.install(app);
  const route = (url: string, method: string | string[] = 'GET') => {
    for (const hook of hooks.get('onRoute') ?? []) hook({ url, method } as unknown as FastifyRequest, undefined as unknown as FastifyReply);
  };
  const run = async (name: string, pair: RequestReply) => {
    for (const hook of hooks.get(name) ?? []) await hook(pair.request, pair.reply);
  };
  const start = (pair: RequestReply) => run('onRequest', pair);
  const complete = async (pair: RequestReply, status = 200) => {
    pair.response.status = status; pair.raw.writableFinished = true; await run('onResponse', pair);
  };
  const snapshot = async (pair = rr('GET', '/metrics')) => {
    await scrape(pair.request, pair.reply); return pair.response;
  };
  return { owner, diagnostic, app, route, run, start, complete, snapshot, scrape };
}

function rows(body: unknown, family: string): string[] {
  expect(typeof body).toBe('string');
  return (body as string).split('\n').filter(line => line.startsWith(N + family + '{'));
}
function ready(body: unknown, value: 0 | 1) {
  expect(body).toContain(N + 'instrumentation_ready{app="lunchlineup-api-v2"} ' + value);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('native metrics core: deterministic hook fixtures, no server/resource integration proof', () => {
  it.each(['', 'short', 'a'.repeat(4097), 'a'.repeat(32) + '\n', 'a'.repeat(32) + ' ', 'é'.repeat(32)])(
    'rejects invalid explicit token without echo %s', value => {
      expect(() => new NativeApiMetrics(value, vi.fn())).toThrow('Invalid native metrics configuration');
    });
  it.each([32, 4096])('accepts explicit visibleASCII token boundary%s only by exact comparison', async length => {
    const token = 'a'.repeat(length); const h = harness(token);
    expect((await h.snapshot(rr('GET', '/metrics', 'Bearer ' + token))).status).toBe(200);
    expect((await h.snapshot(rr('GET', '/metrics', 'Bearer ' + 'b'.repeat(length)))).status).toBe(401);
  });
  it('initializes idle marker, fixed exposition type and cache policy', async () => {
    const h = harness(); const response = await h.snapshot();
    expect(response.status).toBe(200); ready(response.body, 1);
    expect(response.headers).toEqual({ 'cache-control': 'no-store', 'content-type': Registry.PROMETHEUS_CONTENT_TYPE });
    expect(rows(response.body, 'requests_total')).toHaveLength(0);
    expect(response.body).not.toContain(TOKEN); expect(response.body).not.toContain(PRIVATE);
  });
  const rejects: [string, unknown, string[]?][] = [
    ['absent', undefined], ['wrong', 'Bearer ' + 'w'.repeat(TOKEN.length)],
    ['ordinary JWT', 'Bearer ' + 'synthetic-jwt-token-that-is-not-the-metrics-token'],
    ['scheme', 'bearer ' + TOKEN], ['Basic', 'Basic ' + TOKEN], ['double space', 'Bearer  ' + TOKEN],
    ['empty', 'Bearer '], ['oversized', 'Bearer ' + 'a'.repeat(4097)],
    ['newline', 'Bearer ' + TOKEN + '\n'], ['nonascii', 'Bearer ' + 'é'.repeat(TOKEN.length)],
    ['array', ['Bearer ' + TOKEN]], ['duplicate raw', 'Bearer ' + TOKEN,
      ['Authorization', 'Bearer ' + TOKEN, 'authorization', 'Bearer ' + TOKEN]],
    ['raw mismatch', 'Bearer ' + TOKEN, ['Authorization', 'Bearer wrong']],
    ['missing raw', 'Bearer ' + TOKEN, []], ['odd raw', 'Bearer ' + TOKEN, ['Authorization']],
    ['too many raw', 'Bearer ' + TOKEN, [...Array.from({ length: 128 }, () => ['X-Test', 'fixed']).flat(), 'Authorization', 'Bearer ' + TOKEN]],
  ];
  it.each(rejects)('rejects %s before exposition and returns fixed no-store401', async (_name, value, raw) => {
    const h = harness(); const spy = vi.spyOn(Registry.prototype, 'metrics');
    const pair = rr('GET', '/metrics', value, raw);
    // rr's default parameter represents authorized requests; explicit missing case overrides it here.
    if (_name === 'absent') pair.request.headers.authorization = undefined;
    await h.start(pair); await h.scrape(pair.request, pair.reply); await h.complete(pair, 401);
    expect(pair.response).toEqual({ status: 401, headers: { 'cache-control': 'no-store' }, body: { error: 'Unauthorized' } });
    expect(spy).not.toHaveBeenCalled(); expect(h.diagnostic).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(rows((await h.snapshot()).body, 'requests_total')).toHaveLength(0);
  });
  it('completed request uses final status and exact template once; raw identity never appears', async () => {
    const h = harness(); h.route('/v2/items/:id');
    const pair = rr(); const clock = vi.spyOn(process.hrtime, 'bigint');
    clock.mockReturnValueOnce(1_000_000_000n).mockReturnValueOnce(3_500_000_000n);
    await h.start(pair); await h.complete(pair, 503); await h.run('onResponse', pair);
    await h.run('onTimeout', pair); pair.raw.emit('close');
    const body = (await h.snapshot()).body;
    expect(rows(body, 'requests_total')).toEqual([expect.stringContaining('status_class="5xx"')]);
    expect(rows(body, 'requests_total')[0]).toContain('route="/v2/items/:id"');
    expect(rows(body, 'requests_total')[0]).toMatch(/ 1$/);
    expect(rows(body, 'request_duration_seconds_sum')[0]).toMatch(/ 2.5$/);
    expect(rows(body, 'request_duration_seconds_count')[0]).toMatch(/ 1$/);
    expect(rows(body, 'requests_aborted_total')).toHaveLength(0);
    expect(pair.raw.listenerCount('close')).toBe(0); expect(body).not.toContain(PRIVATE);
  });
  it.each([[101, '1xx'], [200, '2xx'], [302, '3xx'], [401, '4xx'], [403, '4xx'], [422, '4xx'], [500, '5xx']])(
    'classifies completed status%s', async (status, expected) => {
      const h = harness(); h.route('/v2/items/:id'); const pair = rr();
      await h.start(pair); await h.complete(pair, status as number);
      const body = (await h.snapshot()).body;
      expect(rows(body, 'requests_total')[0]).toContain('status_class="' + expected + '"'); ready(body, 1);
    });
  it.each([99, 600, 200.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'bounds unknown status%s and marks fault without throwing', async status => {
      const h = harness(); h.route('/v2/items/:id'); const pair = rr();
      await h.start(pair); await h.complete(pair, status);
      const body = (await h.snapshot()).body;
      expect(rows(body, 'requests_total')[0]).toContain('status_class="unknown"'); ready(body, 0);
      expect(h.diagnostic).toHaveBeenCalledExactlyOnceWith('Native API instrumentation unavailable');
    });
  it.each([
    ['/v2/items/:id', 'application'], ['/v2/live', 'probe'], ['/v2/ready', 'probe'],
    ['/v2/version', 'metadata'], ['/v2/openapi.json', 'metadata'],
    ['/v2/admin/retention/purge-expired', 'operator'],
  ])('uses deterministic scope%s', async (route, scope) => {
    const h = harness(); h.route(route); const pair = rr('GET', route);
    await h.start(pair); await h.complete(pair);
    expect(rows((await h.snapshot()).body, 'requests_total')[0]).toContain('scope="' + scope + '"');
  });
  it('many unknown private paths and methods collapse to bounded unmatched pairs', async () => {
    const h = harness(); h.route('/v2/items/:id');
    for (let i = 0; i < 40; i++) {
      const pair = rr(i % 2 ? 'CUSTOM' + i : 'GET', '/never-registered/' + PRIVATE + i);
      await h.start(pair); await h.complete(pair, 404);
    }
    const body = (await h.snapshot()).body;
    expect(rows(body, 'requests_total')).toHaveLength(2);
    expect(rows(body, 'requests_total').every(line => line.includes('route="/unmatched"') && line.includes('scope="unmatched"'))).toBe(true);
    expect(body).not.toContain(PRIVATE); expect(body).not.toContain('CUSTOM');
  });
  it('registered template with wrong method and missing template are unmatched', async () => {
    const h = harness(); h.route('/v2/items/:id');
    const a = rr('DELETE'); const b = rr();
    // Readonly Fastify declarations: replace this plain fixture object instead of mutating routeOptions.
    Object.assign(b.request, { routeOptions: { url: undefined } });
    for (const pair of [a, b]) { await h.start(pair); await h.complete(pair, 404); }
    expect(rows((await h.snapshot()).body, 'requests_total').every(line => line.includes('route="/unmatched"'))).toBe(true);
  });
  it('method arrays, dedup and explicit HEAD pairs do not multiply registered slots', async () => {
    const h = harness(); h.route('/v2/items/:id', ['GET', 'HEAD']);
    for (let i = 0; i < 600; i++) h.route('/v2/items/:id', ['GET', 'HEAD']);
    for (const method of ['GET', 'HEAD']) {
      const pair = rr(method); await h.start(pair); await h.complete(pair);
    }
    expect(rows((await h.snapshot()).body, 'requests_total')).toHaveLength(2);
  });
  it('bounds inventory at512 including scrape and rejects513th pair', () => {
    const h = harness();
    for (let i = 0; i < 511; i++) h.route('/v2/r' + i);
    expect(() => h.route('/v2/r510')).not.toThrow();
    expect(() => h.route('/v2/r511')).toThrow('Native metrics route inventory exceeded');
  });
  it('enforces UTF8 template256bytes not codeunit length', () => {
    const h = harness(); h.route('/' + 'é'.repeat(127) + 'a');
    expect(() => h.route('/' + 'é'.repeat(128))).toThrow('Invalid native metrics route inventory');
    expect(() => h.route('/v2/line\nprivate')).toThrow('Invalid native metrics route inventory');
  });
  it.each(['', 'GET\n', 'get', 'A'.repeat(33)])('rejects invalid registered method%s', method => {
    const h = harness(); expect(() => h.route('/v2/invalid', method)).toThrow('Invalid native metrics route inventory');
  });
  it('seals route inventory onReady and refuses reinstall/closed install', async () => {
    const h = harness(); await h.run('onReady', rr());
    expect(() => h.route('/v2/late')).toThrow('Invalid native metrics lifecycle');
    expect(() => h.owner.install(h.app)).toThrow('Invalid native metrics lifecycle');
    h.owner.close(); expect(() => h.owner.install(h.app)).toThrow('Invalid native metrics lifecycle');
  });
  const terminalOrders: [string, string[], string][] = [
    ['timeout first', ['onTimeout', 'close', 'onRequestAbort', 'onResponse'], 'timeout'],
    ['requestabort first', ['onRequestAbort', 'onTimeout', 'close', 'onResponse'], 'client_disconnect'],
    ['close first', ['close', 'onTimeout', 'onRequestAbort', 'onResponse'], 'client_disconnect'],
    ['response error first', ['onResponse', 'close', 'onTimeout', 'onRequestAbort'], 'client_disconnect'],
  ];
  it.each(terminalOrders)('records one aborted terminal:%s without completed latency/status', async (_name, order, reason) => {
    const h = harness(); h.route('/v2/items/:id'); const pair = rr(); await h.start(pair);
    for (const event of order) { if (event === 'close') pair.raw.emit('close'); else await h.run(event, pair); }
    pair.raw.writableFinished = true; await h.run('onResponse', pair);
    const body = (await h.snapshot()).body;
    expect(rows(body, 'requests_total')).toHaveLength(0);
    expect(rows(body, 'request_duration_seconds_count')).toHaveLength(0);
    expect(rows(body, 'requests_aborted_total')).toEqual([expect.stringContaining('reason="' + reason + '"')]);
    expect(rows(body, 'requests_aborted_total')[0]).toMatch(/ 1$/); expect(pair.raw.listenerCount('close')).toBe(0);
  });
  it('finished raw close does not preempt subsequent completed response hook', async () => {
    const h = harness(); h.route('/v2/items/:id'); const pair = rr(); await h.start(pair);
    pair.raw.writableFinished = true; pair.raw.emit('close'); await h.complete(pair);
    const body = (await h.snapshot()).body;
    expect(rows(body, 'requests_total')).toHaveLength(1); expect(rows(body, 'requests_aborted_total')).toHaveLength(0);
    expect(pair.raw.listenerCount('close')).toBe(0);
  });
  it('registered scrape has no abort/completion/latency feedback', async () => {
    const h = harness(); const pair = rr('GET', '/metrics');
    await h.start(pair); await h.run('onTimeout', pair); await h.complete(pair);
    const body = (await h.snapshot()).body;
    expect(rows(body, 'requests_total')).toHaveLength(0); expect(rows(body, 'requests_aborted_total')).toHaveLength(0);
    expect(rows(body, 'request_duration_seconds_count')).toHaveLength(0); expect(pair.raw.listenerCount('close')).toBe(0);
  });
  it('registered counters are instance-private and close cannot erase another or global collectors', async () => {
    const before = register.getMetricsAsArray().map(x => x.name);
    const a = harness(); const b = harness();
    for (const h of [a, b]) {
      h.route('/v2/items/:id'); const pair = rr(); await h.start(pair); await h.complete(pair);
    }
    const clear = vi.spyOn(Registry.prototype, 'clear');
    a.owner.close(); a.owner.close(); expect(clear).toHaveBeenCalledTimes(1);
    expect(rows((await b.snapshot()).body, 'requests_total')[0]).toMatch(/ 1$/);
    expect(register.getMetricsAsArray().map(x => x.name)).toEqual(before);
  });
  it('closed owner rejects new work; late terminal callback only detaches and never writes', async () => {
    const registration = vi.spyOn(Registry.prototype, 'registerMetric');
    const h = harness(); h.route('/v2/items/:id'); const pair = rr(); await h.start(pair);
    const registry = registration.mock.contexts.find(value => value instanceof Registry);
    if (!(registry instanceof Registry)) throw new Error('Expected the actual private metric registry');
    const metric = registry.getSingleMetric<string>(N + 'requests_total');
    expect(metric).toBeDefined();
    if (!(metric instanceof Counter)) throw new Error('Expected the actual request counter');
    const writes = vi.spyOn(metric, 'inc'); h.owner.close();
    await h.complete(pair); await h.run('onTimeout', pair); expect(writes).not.toHaveBeenCalled();
    expect(pair.raw.listenerCount('close')).toBe(0); expect(h.diagnostic).not.toHaveBeenCalled();
    // Zeroized token makes this formerly authorized request fail closed.
    expect((await h.snapshot()).status).toBe(401);
  });
  it.each(['counter', 'histogram', 'clock', 'negative clock'])(
    'instrumentation fault%s preserves hook success and emits only fixed diagnostic once', async kind => {
      const registration = vi.spyOn(Registry.prototype, 'registerMetric');
      const h = harness(); h.route('/v2/items/:id'); const pair = rr(); await h.start(pair);
      const registry = registration.mock.contexts.find(value => value instanceof Registry);
      if (!(registry instanceof Registry)) throw new Error('Expected the actual private metric registry');
      // prom-client assigns inc/observe as instance properties in the constructor.
      if (kind === 'counter') {
        const metric = registry.getSingleMetric<string>(N + 'requests_total');
        expect(metric).toBeDefined();
        if (!(metric instanceof Counter)) throw new Error('Expected the actual request counter');
        vi.spyOn(metric, 'inc').mockImplementation(() => { throw new Error(PRIVATE); });
      }
      if (kind === 'histogram') {
        const metric = registry.getSingleMetric<string>(N + 'request_duration_seconds');
        expect(metric).toBeDefined();
        if (!(metric instanceof Histogram)) throw new Error('Expected the actual duration histogram');
        vi.spyOn(metric, 'observe').mockImplementation(() => { throw new Error(PRIVATE); });
      }
      if (kind === 'clock') vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => { throw new Error(PRIVATE); });
      if (kind === 'negative clock') vi.spyOn(process.hrtime, 'bigint').mockReturnValue(0n);
      await expect(h.complete(pair)).resolves.toBeUndefined(); await h.run('onResponse', pair);
      const body = (await h.snapshot()).body; ready(body, 0);
      expect(h.diagnostic).toHaveBeenCalledExactlyOnceWith('Native API instrumentation unavailable');
      expect(body).not.toContain(PRIVATE); expect(pair.raw.listenerCount('close')).toBe(0);
    });
  it('throwing diagnostic cannot propagate into application hooks', async () => {
    const h = harness(); h.route('/v2/items/:id'); const pair = rr(); await h.start(pair);
    h.diagnostic.mockImplementation(() => { throw new Error(PRIVATE); });
    await expect(h.complete(pair, 999)).resolves.toBeUndefined();
    ready((await h.snapshot()).body, 0);
  });
  it.each(['resolve', 'reject', 'close'])(
    'one in-flight snapshot%s owns its gate, rejects overlap, releasesbusy finally', async outcome => {
      const h = harness(); const gate = deferred<string>();
      const spy = vi.spyOn(Registry.prototype, 'metrics').mockImplementationOnce(() => gate.promise);
      const first = rr('GET', '/metrics');
      // Observe public completion immediately and always release the gate in finally.
      const pending = Promise.resolve(h.scrape(first.request, first.reply));
      const observed = pending.then(value => ({ value }), error => ({ error }));
      try {
        const overlap = await h.snapshot(); expect(overlap.status).toBe(503); expect(spy).toHaveBeenCalledTimes(1);
        if (outcome === 'close') h.owner.close();
        if (outcome === 'reject') gate.reject(new Error(PRIVATE)); else gate.resolve('fixed exposition\n');
        const result = await observed; expect(result).not.toHaveProperty('error');
        expect(first.response.status).toBe(outcome === 'resolve' ? 200 : 503);
        if (outcome !== 'close') {
          const retry = await h.snapshot(); expect(retry.status).toBe(200);
          ready(retry.body, outcome === 'reject' ? 0 : 1);
          expect(h.diagnostic).toHaveBeenCalledTimes(outcome === 'reject' ? 1 : 0);
          expect(retry.body).not.toContain(PRIVATE);
        }
      } finally { gate.resolve('fixed cleanup\n'); await observed; }
    });
  it.each([8 * 1024 * 1024, 8 * 1024 * 1024 + 1])(
    'enforces exposition wire boundary%s', async size => {
      const h = harness(); vi.spyOn(Registry.prototype, 'metrics').mockResolvedValueOnce('x'.repeat(size));
      const response = await h.snapshot();
      expect(response.status).toBe(size === 8 * 1024 * 1024 ? 200 : 503);
      if (response.status === 503) expect(response.body).toEqual({ error: 'Metrics unavailable' });
      const recovery = await h.snapshot(); ready(recovery.body, response.status === 503 ? 0 : 1);
    });
});

describe('native metrics real loopback HTTP fixtures; no DB/Redis/provider resources', () => {
  it.each([false, true])('hides dedicated metrics from public OpenAPI with swaggerfirst%s', async swaggerFirst => {
    const app = Fastify({ logger: false }); const owner = new NativeApiMetrics(TOKEN, vi.fn()); owners.add(owner);
    const options = { openapi: { info: { title: 'Synthetic fixture', version: '1.0.0' } } };
    try {
      if (swaggerFirst) await app.register(swagger, options);
      owner.install(app); app.addHook('onClose', async () => { owner.close(); });
      if (!swaggerFirst) await app.register(swagger, options);
      app.get('/v2/example', async () => ({ ok: true }));
      await app.ready();
      expect(app.swagger().paths).toHaveProperty('/v2/example');
      expect(app.swagger().paths).not.toHaveProperty('/metrics');
      expect((await requestLoopback(app, { url: '/metrics', headers: { authorization: 'Bearer ' + TOKEN } })).statusCode).toBe(200);
    } finally { await app.close(); }
  });
  it.each([false, true])('captures automatically registered HEAD and compiled route with delegationflag%s', async delegated => {
    const app = Fastify({ logger: false }); const owner = new NativeApiMetrics(TOKEN, vi.fn()); owners.add(owner);
    const domain = vi.fn(async () => ({ delegated }));
    try {
      owner.install(app); app.addHook('onClose', async () => { owner.close(); });
      app.get('/v2/items/:id', domain);
      await app.ready();
      const result = await requestLoopback(app, { method: 'GET', url: '/v2/items/' + PRIVATE + '?token=' + PRIVATE });
      expect(result.statusCode).toBe(200);
      const head = await requestLoopback(app, { method: 'HEAD', url: '/v2/items/' + PRIVATE });
      expect(head.statusCode).toBe(200); expect(domain).toHaveBeenCalledTimes(2);
      const scrape = await requestLoopback(app, { method: 'GET', url: '/metrics', headers: { authorization: 'Bearer ' + TOKEN } });
      expect(scrape.statusCode).toBe(200); expect(rows(scrape.body, 'requests_total')).toHaveLength(2);
      expect(rows(scrape.body, 'requests_total').every(line => line.includes('route="/v2/items/:id"') && line.endsWith(' 1'))).toBe(true);
      expect(rows(scrape.body, 'requests_total').some(line => line.includes('method="HEAD"'))).toBe(true);
      expect(scrape.body).not.toContain(PRIVATE); expect(scrape.body).not.toContain(TOKEN);
    } finally { await app.close(); }
  });
  it('uses post-error mapped status once and metadata/probe scope; rejected scrapes remain excluded', async () => {
    const app = Fastify({ logger: false }); const diagnostic = vi.fn();
    const owner = new NativeApiMetrics(TOKEN, diagnostic); owners.add(owner);
    try {
      owner.install(app); app.addHook('onClose', async () => { owner.close(); });
      app.setErrorHandler((_error, _request, reply) => reply.code(503).send({ error: 'fixed' }));
      app.get('/v2/fault', async () => { throw new Error(PRIVATE); });
      app.get('/v2/ready', async () => ({ ready: true }));
      app.get('/v2/version', async () => ({ version: 'fixture' }));
      expect((await requestLoopback(app, '/v2/fault')).statusCode).toBe(503);
      await requestLoopback(app, '/v2/ready'); await requestLoopback(app, '/v2/version');
      expect((await requestLoopback(app, '/metrics')).statusCode).toBe(401);
      const scrape = await requestLoopback(app, { url: '/metrics', headers: { authorization: 'Bearer ' + TOKEN } });
      const requests = rows(scrape.body, 'requests_total');
      expect(requests).toHaveLength(3);
      expect(requests.find(line => line.includes('route="/v2/fault"'))).toContain('status_class="5xx"');
      expect(requests.find(line => line.includes('route="/v2/ready"'))).toContain('scope="probe"');
      expect(requests.find(line => line.includes('route="/v2/version"'))).toContain('scope="metadata"');
      expect(scrape.body).not.toContain(PRIVATE); expect(diagnostic).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('observes final onSend status without counting the serialization hook separately', async () => {
    const app = Fastify({ logger: false }); const owner = new NativeApiMetrics(TOKEN, vi.fn()); owners.add(owner);
    try {
      owner.install(app); app.addHook('onClose', async () => { owner.close(); });
      app.get('/v2/transformed', { onSend: async (_req, reply, payload) => { reply.code(422); return payload; } },
        async () => ({ ok: true }));
      expect((await requestLoopback(app, '/v2/transformed')).statusCode).toBe(422);
      const scrape = await requestLoopback(app, { url: '/metrics', headers: { authorization: 'Bearer ' + TOKEN } });
      expect(rows(scrape.body, 'requests_total')).toEqual([expect.stringContaining('status_class="4xx"')]);
      expect(rows(scrape.body, 'request_duration_seconds_count')[0]).toMatch(/ 1$/);
    } finally { await app.close(); }
  });
});
