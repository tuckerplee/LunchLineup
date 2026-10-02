import Fastify, { type FastifyInstance } from 'fastify';
import type { SessionIdentity } from '@lunchlineup/api-contract';
import { describe, expect, it, vi } from 'vitest';
import type { TenantDatabase } from './database';
import { NativeApiMetrics } from './metrics';
import { NativePlanQuota } from './native-quota';
import { NativeRedisQuotaStorage, type NativeQuotaRedisClient } from './native-quota-storage';
import { installProblemHandler } from './problem';
import { requestLoopback } from '../../test-support/loopback-http.js';

// Source-only candidate: actual quota/storage/metrics/error handler and an
// isolated Fastify boundary; fake Redis/tenant lookup, no real client/provider.
// Real loopback HTTP transport; not buildServer, auth, retained bridge or Redis Lua proof.
const TOKEN = 'availability-control-token-00000000000000000000';
const ROUTE = '/v2/availability-controls/:controlId';
const URL = '/v2/availability-controls/fixed-control';
const actor = { tenantId: 'tenant-control', sub: 'subject-control' } as SessionIdentity;
const ALLOWED = [1, 60, 0, 0];
const PRINCIPAL_BLOCKED = [61, 60, 1, 59];
const TENANT_BLOCKED = [601, 60, 1, 58];
const PRIVATE_FAILURE = 'synthetic-driver-credential-redis://private-control';
type Outcome = 'allowed' | 'principal-blocked' | 'tenant-blocked'
  | 'principal-rejected' | 'tenant-rejected' | 'principal-malformed'
  | 'tenant-malformed' | 'reporter-throws' | 'plan-rejected' | 'plan-missing';
type Case = { mode: Outcome; status: 200 | 429 | 503; code?: string; evals: number; business: number };
const CASES: readonly Case[] = [
  { mode: 'allowed', status: 200, evals: 2, business: 1 },
  { mode: 'principal-blocked', status: 429, code: 'rate_limited', evals: 1, business: 0 },
  { mode: 'tenant-blocked', status: 429, code: 'rate_limited', evals: 2, business: 0 },
  { mode: 'principal-rejected', status: 503, code: 'rate_limit_storage_unavailable', evals: 1, business: 0 },
  { mode: 'tenant-rejected', status: 503, code: 'rate_limit_storage_unavailable', evals: 2, business: 0 },
  { mode: 'principal-malformed', status: 503, code: 'rate_limit_storage_unavailable', evals: 1, business: 0 },
  { mode: 'tenant-malformed', status: 503, code: 'rate_limit_storage_unavailable', evals: 2, business: 0 },
  { mode: 'reporter-throws', status: 503, code: 'rate_limit_storage_unavailable', evals: 1, business: 0 },
  { mode: 'plan-rejected', status: 503, code: 'rate_limit_plan_unavailable', evals: 0, business: 0 },
  { mode: 'plan-missing', status: 503, code: 'rate_limit_plan_unavailable', evals: 0, business: 0 },
];
function completed(body: string, statusClass: '2xx' | '4xx' | '5xx'): number {
  const name = 'lunchlineup_api_v2_http_requests_total';
  const rows = body.split('\n').filter(line => line.startsWith(name + '{')
    && line.includes('route="' + ROUTE + '"') && line.includes('method="GET"')
    && line.includes('scope="application"') && line.includes('status_class="' + statusClass + '"'));
  return rows.reduce((sum, line) => sum + Number(line.slice(line.lastIndexOf(' ') + 1)), 0);
}
type Harness = {
  app: FastifyInstance;
  business: ReturnType<typeof vi.fn>;
  evalCommand: ReturnType<typeof vi.fn>;
  report: ReturnType<typeof vi.fn>;
  withTenant: ReturnType<typeof vi.fn>;
  findUnique: ReturnType<typeof vi.fn>;
  client: NativeQuotaRedisClient;
  setMode(mode: Outcome): void;
  scrape(): Promise<string>;
};
async function withHarness(initialMode: Outcome, run: (h: Harness) => Promise<void>): Promise<void> {
  const app = Fastify({ logger: false });
  let storage: NativeRedisQuotaStorage | undefined;
  let metrics: NativeApiMetrics | undefined;
  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    try { metrics?.close(); } finally { storage?.close(); }
  };
  try {
    // Retain each successfully constructed resource before the next operation.
    app.addHook('onClose', async () => cleanup());
    let mode = initialMode;
    let bucket = 0;
    const evalCommand = vi.fn(async (_script: string, _numberOfKeys: number, ..._args: string[]) => {
      const current = bucket++;
      if (mode === 'principal-rejected' || mode === 'reporter-throws'
        || (mode === 'tenant-rejected' && current % 2 === 1)) {
        throw new Error(PRIVATE_FAILURE);
      }
      if (mode === 'principal-malformed' || (mode === 'tenant-malformed' && current % 2 === 1)) return ['invalid'];
      if (mode === 'principal-blocked') return [...PRINCIPAL_BLOCKED];
      if (mode === 'tenant-blocked' && current % 2 === 1) return [...TENANT_BLOCKED];
      return [...ALLOWED];
    });
    const client: NativeQuotaRedisClient = {
      status: 'ready', connect: vi.fn(async () => undefined), ping: vi.fn(async () => 'PONG'),
      eval: evalCommand, disconnect: vi.fn(), on: vi.fn(), off: vi.fn(),
    };
    const report = vi.fn(() => { if (mode === 'reporter-throws') throw new Error(PRIVATE_FAILURE); });
    storage = new NativeRedisQuotaStorage('redis://synthetic-never-connected', report, client);
    metrics = new NativeApiMetrics(TOKEN, () => { throw new Error('synthetic-diagnostic-fault'); });
    metrics.install(app);
    const findUnique = vi.fn(async () => mode === 'plan-missing' ? null : {
      planTier: 'FREE', status: 'ACTIVE', stripeSubscriptionId: null, stripeSubscriptionCurrentPeriodEnd: null,
    });
    const withTenant = vi.fn(async (_tenant: string, operation: (tx: unknown) => Promise<unknown>) => {
      if (mode === 'plan-rejected') throw new Error(PRIVATE_FAILURE);
      return operation({ tenant: { findUnique } });
    });
    const quota = new NativePlanQuota({ withTenant } as unknown as TenantDatabase, storage);
    const business = vi.fn(async () => ({ ok: true }));
    installProblemHandler(app);
    app.get(ROUTE, async (_request, reply) => {
      await quota.consume('listLocations', actor, reply);
      return business();
    });
    await app.ready();
    await run({
      app, business, evalCommand, report, withTenant, findUnique, client,
      setMode(next) { mode = next; bucket = 0; },
      async scrape() {
        const response = await requestLoopback(app, { method: 'GET', url: '/metrics', headers: { authorization: 'Bearer ' + TOKEN } });
        expect(response.statusCode).toBe(200);
        expect(response.body).not.toContain(PRIVATE_FAILURE);
        expect(response.body).not.toContain(actor.tenantId);
        expect(response.body).not.toContain(actor.sub);
        expect(response.body).toContain('lunchlineup_api_v2_http_instrumentation_ready{app="lunchlineup-api-v2"} 1');
        return response.body;
      },
    });
    expect(client.connect).not.toHaveBeenCalled();
    expect(client.ping).not.toHaveBeenCalled();
    // Metrics scraping is deliberately not a readiness or dependency probe.
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(client.on).toHaveBeenCalledTimes(1);
    const listener = (client.on as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await app.close();
    expect(client.off).toHaveBeenCalledWith('error', listener);
    expect(client.off).toHaveBeenCalledTimes(1);
    expect(client.disconnect).not.toHaveBeenCalled();
  } finally {
    try { await app.close(); } finally { cleanup(); }
  }
}
describe('quota storage availability classification at a native HTTP control boundary', () => {
  it.each(CASES)('$mode gives $status without hidden retry or business work', async (row) => {
    await withHarness(row.mode, async h => {
      const response = await requestLoopback(h.app, { method: 'GET', url: URL });
      expect(response.statusCode).toBe(row.status);
      expect(h.withTenant).toHaveBeenCalledTimes(1);
      expect(h.withTenant).toHaveBeenCalledWith(actor.tenantId, expect.any(Function), { maxWait: 500, timeout: 1500 });
      expect(h.evalCommand).toHaveBeenCalledTimes(row.evals);
      expect(h.business).toHaveBeenCalledTimes(row.business);
      if (row.evals > 0) {
        expect(h.evalCommand.mock.calls[0].slice(1)).toEqual([
          2, expect.stringMatching(/^lunchlineup:rate-limit:v1:\{[a-f0-9]{64}\}:hits$/),
          expect.stringMatching(/^lunchlineup:rate-limit:v1:\{[a-f0-9]{64}\}:state$/), '60000', '60', '60000',
        ]);
      }
      if (row.evals > 1) {
        const first = h.evalCommand.mock.calls[0];
        const second = h.evalCommand.mock.calls[1];
        expect(second[2]).not.toBe(first[2]);
        expect(second.slice(-3)).toEqual(['60000', '600', '60000']);
        // A second-bucket failure preserves the first debit; no compensating
        // EVAL, retry, refund, or business operation is issued.
        expect(response.headers['x-ratelimit-limit']).toBe('60');
        expect(response.headers['x-ratelimit-remaining']).toBe('59');
      }
      if (row.status === 200) expect(response.json()).toEqual({ ok: true });
      else {
        expect(response.headers['content-type']).toContain('application/problem+json');
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.json()).toMatchObject({ status: row.status, code: row.code });
        expect(response.json()).not.toHaveProperty('cause');
        expect(response.body).not.toContain(PRIVATE_FAILURE);
        if (row.status === 503) {
          expect(response.json().detail).toBe('Request limits are temporarily unavailable.');
          expect(response.headers['retry-after']).toBeUndefined();
          expect(response.headers['x-ratelimit-limit-tenantCeiling'.toLowerCase()]).toBeUndefined();
        } else {
          expect(response.headers['retry-after']).toBe(row.mode === 'tenant-blocked' ? '58' : '59');
          expect(response.json().retryAfterSeconds).toBe(row.mode === 'tenant-blocked' ? 58 : 59);
        }
      }
      expect(h.report).toHaveBeenCalledTimes(
        row.code === 'rate_limit_storage_unavailable' ? 1 : 0,
      );
      const text = await h.scrape();
      expect(completed(text, '2xx')).toBe(row.status === 200 ? 1 : 0);
      expect(completed(text, '4xx')).toBe(row.status === 429 ? 1 : 0);
      expect(completed(text, '5xx')).toBe(row.status === 503 ? 1 : 0);
      expect(h.evalCommand).toHaveBeenCalledTimes(row.evals);
      expect(h.business).toHaveBeenCalledTimes(row.business);
    });
  });
  it.each(['principal-rejected', 'tenant-rejected'] as const)('%s recovers on a fresh request without replacing the per-server metrics owner', async mode => {
    await withHarness(mode, async h => {
      const first = await requestLoopback(h.app, { method: 'GET', url: URL });
      expect(first.statusCode).toBe(503);
      const firstCalls = mode === 'principal-rejected' ? 1 : 2;
      expect(h.evalCommand).toHaveBeenCalledTimes(firstCalls);
      expect(h.business).not.toHaveBeenCalled();
      h.setMode('allowed');
      const second = await requestLoopback(h.app, { method: 'GET', url: URL });
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual({ ok: true });
      expect(h.withTenant).toHaveBeenCalledTimes(2);
      expect(h.evalCommand).toHaveBeenCalledTimes(firstCalls + 2);
      expect(h.business).toHaveBeenCalledTimes(1);
      expect(h.report).toHaveBeenCalledTimes(1);
      const text = await h.scrape();
      expect(completed(text, '5xx')).toBe(1);
      expect(completed(text, '2xx')).toBe(1);
      expect(completed(text, '4xx')).toBe(0);
    });
  });
});
