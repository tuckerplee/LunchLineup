import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import type {} from '@fastify/swagger';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { isNativeMetricsToken, NATIVE_METRICS_TOKEN_MAX_BYTES as MAX_TOKEN_BYTES } from './metrics-token.js';

const MAX_PAIRS = 512;
const MAX_TEMPLATE_BYTES = 256;
const MAX_HEADER_ENTRIES = 256;
const MAX_EXPOSITION_BYTES = 8 * 1024 * 1024;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
type Scope = 'application' | 'operator' | 'probe' | 'metadata' | 'unmatched';
type Labels = { method: string; route: string; scope: Scope };
type AbortReason = 'timeout' | 'client_disconnect';
type RequestState = { labels: Labels; start: bigint; terminal: boolean; detach: () => void };
export type MetricsDiagnostic = (message: 'Native API instrumentation unavailable') => void;

function scopeFor(route: string): Scope {
  if (route === '/v2/admin/retention/purge-expired') return 'operator';
  if (route === '/v2/live' || route === '/v2/ready') return 'probe';
  if (route === '/v2/version' || route === '/v2/openapi.json') return 'metadata';
  return 'application';
}
function methodLabel(method: string): string {
  return METHODS.has(method) ? method : 'OTHER';
}
function statusClass(status: number): string {
  return Number.isSafeInteger(status) && status >= 100 && status <= 599
    ? String(Math.floor(status / 100)) + 'xx' : 'unknown';
}

/**
 * Private per-server native front-door telemetry. Retain this owner before
 * install(); close through the existing memoized server cleanup owner.
 * No timers, default collectors, readiness calls or external-I/O collectors.
 * Integration/configuration/deployment and real HTTP timing are separate gates.
 */
export class NativeApiMetrics {
  readonly #registry = new Registry();
  readonly #requests: Counter<'method' | 'route' | 'status_class' | 'scope'>;
  readonly #duration: Histogram<'method' | 'route' | 'scope'>;
  readonly #aborted: Counter<'method' | 'route' | 'scope' | 'reason'>;
  readonly #ready: Gauge;
  readonly #token: Buffer;
  readonly #pairs = new Map<string, Labels | null>();
  readonly #states = new WeakMap<FastifyRequest, RequestState>();
  readonly #report: MetricsDiagnostic;
  #installed = false;
  #sealed = false;
  #closed = false;
  #busy = false;
  #failed = false;

  constructor(token: string, report: MetricsDiagnostic) {
    if (!isNativeMetricsToken(token)) throw new Error('Invalid native metrics configuration');
    this.#token = Buffer.from(token, 'ascii');
    this.#report = report;
    this.#registry.setDefaultLabels({ app: 'lunchlineup-api-v2' });
    this.#requests = new Counter({
      name: 'lunchlineup_api_v2_http_requests_total',
      help: 'Completed responses at the native API front door.',
      labelNames: ['method', 'route', 'status_class', 'scope'], registers: [this.#registry],
    });
    this.#duration = new Histogram({
      name: 'lunchlineup_api_v2_http_request_duration_seconds',
      help: 'Completed native front-door request duration in seconds.',
      labelNames: ['method', 'route', 'scope'], buckets: BUCKETS, registers: [this.#registry],
    });
    this.#aborted = new Counter({
      name: 'lunchlineup_api_v2_http_requests_aborted_total',
      help: 'Uncompleted native requests with a terminal disconnect or socket timeout.',
      labelNames: ['method', 'route', 'scope', 'reason'], registers: [this.#registry],
    });
    this.#ready = new Gauge({
      name: 'lunchlineup_api_v2_http_instrumentation_ready',
      help: 'One while installed native instrumentation has detected no fault.',
      registers: [this.#registry],
    });
    this.#ready.set(1);
  }

  install(app: FastifyInstance): void {
    if (this.#installed || this.#closed) throw new Error('Invalid native metrics lifecycle');
    this.#installed = true;
    app.addHook('onRoute', options => this.#register(options));
    app.addHook('onReady', async () => { this.#sealed = true; });
    app.addHook('onRequest', async (request, reply) => {
      try { this.#start(request, reply); } catch { this.#fail(); }
    });
    app.addHook('onResponse', async (request, reply) => {
      // Fastify calls onResponse on raw response error as well as finish.
      if (!reply.raw.writableFinished) this.#abort(request, 'client_disconnect');
      else this.#complete(request, reply);
    });
    app.addHook('onTimeout', async request => this.#abort(request, 'timeout'));
    app.addHook('onRequestAbort', async request => this.#abort(request, 'client_disconnect'));
    app.get('/metrics', { exposeHeadRoute: false, logLevel: 'silent', schema: { hide: true } },
      async (request, reply) => this.#scrape(request, reply));
  }

  #register(options: RouteOptions): void {
    if (this.#closed || this.#sealed) throw new Error('Invalid native metrics lifecycle');
    const route = options.url;
    if (typeof route !== 'string' || Buffer.byteLength(route, 'utf8') > MAX_TEMPLATE_BYTES
        || /[\x00-\x1f\x7f]/.test(route)) {
      throw new Error('Invalid native metrics route inventory');
    }
    const methods = Array.isArray(options.method) ? options.method : [options.method];
    for (const method of methods) {
      if (typeof method !== 'string' || method.length === 0 || /[^A-Z]/.test(method) || method.length > 32) {
        throw new Error('Invalid native metrics route inventory');
      }
      const key = method + ' ' + route;
      if (this.#pairs.has(key)) continue;
      if (this.#pairs.size >= MAX_PAIRS) throw new Error('Native metrics route inventory exceeded');
      this.#pairs.set(key, route === '/metrics' ? null
        : { method: methodLabel(method), route, scope: scopeFor(route) });
    }
  }

  #labels(request: FastifyRequest): Labels | null {
    const route = request.routeOptions?.url;
    // Exact server-owned pair; no raw path, params, query, body or actor fallback.
    const key = request.method + ' ' + route;
    if (this.#pairs.has(key)) return this.#pairs.get(key)!;
    return { method: methodLabel(request.method), route: '/unmatched', scope: 'unmatched' };
  }

  #start(request: FastifyRequest, reply: FastifyReply): void {
    if (this.#closed || this.#states.has(request)) return;
    const labels = this.#labels(request);
    if (labels === null) return;
    const state: RequestState = {
      labels, start: process.hrtime.bigint(), terminal: false, detach: () => {},
    };
    this.#states.set(request, state);
    const onClose = () => {
      if (!reply.raw.writableFinished) this.#abort(request, 'client_disconnect');
    };
    state.detach = () => reply.raw.removeListener('close', onClose);
    reply.raw.once('close', onClose);
  }

  #take(request: FastifyRequest): RequestState | undefined {
    const state = this.#states.get(request);
    if (!state || state.terminal) return undefined;
    state.terminal = true; // no retry/double counting after a metric fault
    try { state.detach(); } catch { this.#fail(); }
    return state;
  }

  #complete(request: FastifyRequest, reply: FastifyReply): void {
    const state = this.#take(request);
    if (!state || this.#closed) return;
    try {
      const duration = Number(process.hrtime.bigint() - state.start) / 1e9;
      if (!Number.isFinite(duration) || duration < 0) throw new Error('Invalid duration');
      const status = statusClass(reply.statusCode);
      if (status === 'unknown') this.#fail();
      this.#requests.inc({ ...state.labels, status_class: status });
      this.#duration.observe({ ...state.labels }, duration);
    } catch { this.#fail(); }
  }

  #abort(request: FastifyRequest, reason: AbortReason): void {
    const state = this.#take(request);
    if (!state || this.#closed) return;
    try { this.#aborted.inc({ ...state.labels, reason }); } catch { this.#fail(); }
  }

  #authorized(request: FastifyRequest): boolean {
    const value = request.headers.authorization;
    const raw = request.raw.rawHeaders;
    if (typeof value !== 'string' || value.length > MAX_TOKEN_BYTES + 7
        || !Array.isArray(raw) || raw.length > MAX_HEADER_ENTRIES || raw.length % 2 !== 0) return false;
    let seen = 0;
    for (let i = 0; i < raw.length; i += 2) {
      if (typeof raw[i] !== 'string' || typeof raw[i + 1] !== 'string') return false;
      if (raw[i].toLowerCase() === 'authorization') {
        seen += 1;
        if (seen !== 1 || raw[i + 1] !== value) return false;
      }
    }
    if (seen !== 1 || !value.startsWith('Bearer ')) return false;
    const token = value.slice(7);
    if (!isNativeMetricsToken(token) || token.length !== this.#token.length) return false;
    return timingSafeEqual(Buffer.from(token, 'ascii'), this.#token);
  }

  async #scrape(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    reply.header('Cache-Control', 'no-store');
    if (!this.#authorized(request)) return reply.code(401).send({ error: 'Unauthorized' });
    if (this.#closed || this.#busy) return reply.code(503).send({ error: 'Metrics unavailable' });
    this.#busy = true;
    try {
      const body = await this.#registry.metrics();
      if (this.#closed) return reply.code(503).send({ error: 'Metrics unavailable' });
      // Four fixed collectors only: <=10401 series; escaped route <=512 bytes.
      // Fixed overhead/numeric fields keep rows <768 bytes; enforce 8MiB also.
      if (Buffer.byteLength(body, 'utf8') > MAX_EXPOSITION_BYTES) {
        this.#fail();
        return reply.code(503).send({ error: 'Metrics unavailable' });
      }
      return reply.type(this.#registry.contentType).send(body);
    } catch {
      this.#fail();
      return reply.code(503).send({ error: 'Metrics unavailable' });
    } finally { this.#busy = false; }
  }

  #fail(): void {
    if (this.#closed) return;
    const first = !this.#failed;
    this.#failed = true;
    try { this.#ready.set(0); } catch { /* instrumentation cannot change application success */ }
    if (first) {
      try { this.#report('Native API instrumentation unavailable'); } catch { /* fixed diagnostic only */ }
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#token.fill(0);
    this.#pairs.clear();
    this.#registry.clear();
    // Caller closes after Fastify drains response streams. Late terminal callbacks
    // detach their own listener but cannot repopulate this closed registry.
  }
}
