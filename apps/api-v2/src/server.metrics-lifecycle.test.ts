// SOURCE ONLY. Bind the selected metrics/server/config/quota proposals before
// future execution. No current import, test, DB, Redis, listen or provider probe.
// Fake-owner tests prove wiring only; actual-metrics tests use owned loopback HTTP.
// Full stream/socket drains, deployed logs, native dependencies and release remain open.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { ApiV2Config } from './config';
import { requestLoopback } from '../test-support/loopback-http.js';
const SERVICE_GUARDS = [
  [
    "./locations/locations.service",
    "LocationService"
  ],
  [
    "./people/people.service",
    "PeopleService"
  ],
  [
    "./operations/operations.service",
    "OperationsService"
  ],
  [
    "./operations/lunch-breaks.service",
    "LunchBreakService"
  ],
  [
    "./notifications/notifications.service",
    "NotificationService"
  ],
  [
    "./payroll/payroll.service",
    "PayrollService"
  ],
  [
    "./time/time-cards.service",
    "TimeCardService"
  ],
  [
    "./settings/settings.service",
    "WorkspaceSettingsService"
  ],
  [
    "./platform/retained-application.bridge",
    "RetainedApplicationBridge"
  ],
  [
    "./platform/retained-operator.bridge",
    "RetainedOperatorBridge"
  ],
  [
    "./scheduling/board.service",
    "ScheduleBoardService"
  ],
  [
    "./scheduling/schedule-create.service",
    "ScheduleCreateService"
  ],
  [
    "./scheduling/change-set.service",
    "ScheduleChangeSetService"
  ],
  [
    "./scheduling/demand-window.service",
    "DemandWindowService"
  ],
  [
    "./scheduling/lifecycle.service",
    "ScheduleLifecycleService"
  ],
  [
    "./scheduling/legacy-scheduling.bridge",
    "LegacySchedulingBridge"
  ]
] as const;
const ROUTE_MOCKS = [
  [
    "./scheduling/routes",
    "registerSchedulingRoutes"
  ],
  [
    "./locations/routes",
    "registerLocationRoutes"
  ],
  [
    "./people/routes",
    "registerPeopleRoutes"
  ],
  [
    "./operations/routes",
    "registerOperationsRoutes"
  ],
  [
    "./notifications/routes",
    "registerNotificationRoutes"
  ],
  [
    "./payroll/routes",
    "registerPayrollRoutes"
  ],
  [
    "./time/routes",
    "registerTimeCardRoutes"
  ],
  [
    "./settings/routes",
    "registerWorkspaceSettingsRoutes"
  ],
  [
    "./application/routes",
    "registerApplicationRoutes"
  ]
] as const;
const MOCK_PATHS = ['fastify', '@fastify/swagger', './platform/metrics',
  './platform/database', './platform/native-identity', './platform/native-quota-storage', './platform/native-quota',
  ...SERVICE_GUARDS.map(([path]) => path), ...ROUTE_MOCKS.map(([path]) => path)];
const CONFIG: ApiV2Config = {
  host: '127.0.0.1', port: 3002, appOrigin: 'https://fixture.invalid',
  allowedOrigins: new Set(['https://fixture.invalid']), legacyApiBaseUrl: 'https://retained.fixture.invalid/v1',
  authStateTimeoutMs: 1000, legacyRequestTimeoutMs: 1000, jwtSecret: 'synthetic-not-a-credential',
  redisUrl: 'redis://fixture.invalid:6379', staffInvitationOutboxEnabled: false,
  staffInvitationOutboxEncryptionKey: '', staffInvitationMaxAttempts: 1,
  oidcSsoAvailable: false, cookieSecure: true, releaseSha: 'local',
  trustProxy: false, logLevel: 'silent',
  metricsToken: 'synthetic-config-metrics-token-00000000000000000000',
};
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
function observe<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
}
function fixture(metricsMode: 'owner-double' | 'actual' = 'owner-double') {
  const ledger: string[] = [];
  const database = {
    ready: vi.fn(async () => { ledger.push('db.ready'); }),
    disconnect: vi.fn(async () => { ledger.push('db.close'); }),
  };
  const identity = {
    ready: vi.fn(async () => { ledger.push('identity.ready'); }),
    close: vi.fn(async () => { ledger.push('identity.close'); }),
    authenticate: vi.fn(async () => { throw new Error('Unexpected authentication'); }),
  };
  const storage = {
    ready: vi.fn(async () => { ledger.push('storage.ready'); }),
    close: vi.fn(() => { ledger.push('storage.close'); }),
    increment: vi.fn(async () => { throw new Error('Unexpected increment'); }),
  };
  const quota = {
    ready: vi.fn(async () => { ledger.push('quota.ready'); await storage.ready(); }),
    consume: vi.fn(async () => { throw new Error('Unexpected consume'); }),
  };
  return {
    metricsMode, ledger, database, identity, storage, quota,
    fault: '', framework: 'real' as 'real' | 'branch-close-before-hook',
    primary: new Error('synthetic-primary-startup'), expectedCleanupError: undefined as unknown,
    metricsError: undefined as unknown,
    metricsConstruct: vi.fn(), metricsInstall: vi.fn(), metricsClose: vi.fn(),
    databaseConstruct: vi.fn(), identityConstruct: vi.fn(), storageConstruct: vi.fn(),
    app: undefined as FastifyInstance | undefined, cleanup: undefined as (() => Promise<void>) | undefined,
    closeSpy: undefined as ReturnType<typeof vi.fn> | undefined,
  };
}
type Fixture = ReturnType<typeof fixture>;
const fixtures: Fixture[] = [];
const outcomes: Array<Promise<unknown>> = [];
async function setup(f: Fixture): Promise<Outcome<FastifyInstance>> {
  fixtures.push(f);
  for (const path of MOCK_PATHS) vi.doUnmock(path);
  vi.resetModules();
  vi.doMock('./platform/database', () => ({ TenantDatabase: class {
    constructor() { f.databaseConstruct(); if (f.fault === 'db-constructor') throw f.primary; return f.database; }
  } }));
  vi.doMock('./platform/native-identity', () => ({ NativeIdentityAdapter: class {
    constructor() { f.identityConstruct(); if (f.fault === 'identity-constructor') throw f.primary; return f.identity; }
  } }));
  vi.doMock('./platform/native-quota-storage', () => ({ NativeRedisQuotaStorage: class {
    constructor() { f.storageConstruct(); return f.storage; }
  } }));
  vi.doMock('./platform/native-quota', () => ({ NativePlanQuota: class {
    constructor() { return f.quota; }
  } }));
  vi.doMock('./platform/metrics', async importOriginal => {
    const actual = f.metricsMode === 'actual'
      ? await importOriginal<typeof import('./platform/metrics')>() : undefined;
    return { NativeApiMetrics: class {
      constructor(token: string, report: (message: 'Native API instrumentation unavailable') => void) {
        f.metricsConstruct(token, report);
        if (f.fault === 'metrics-constructor') throw f.primary;
        const owned = actual ? new actual.NativeApiMetrics(token, report) : undefined;
        return {
          install(app: FastifyInstance) {
            f.metricsInstall(app); f.ledger.push('metrics.install');
            if (f.fault === 'metrics-install') {
              app.get('/metrics', async () => 'synthetic-partial-install');
              throw f.primary;
            }
            owned?.install(app);
          },
          close() {
            f.metricsClose(); f.ledger.push('metrics.close');
            try { owned?.close(); } finally { if (f.metricsError) throw f.metricsError; }
          },
        };
      }
    } };
  });
  for (const [path, name] of SERVICE_GUARDS) {
    if (path === './platform/retained-operator.bridge') vi.doMock(path, async importOriginal => ({
      ...await importOriginal<Record<string, unknown>>(),
      [name]: class { constructor() { throw new Error('Unexpected operator constructor'); } },
    }));
    else vi.doMock(path, () => ({ [name]: class { constructor() { throw new Error('Unexpected service constructor: ' + name); } } }));
  }
  for (const [path, name] of ROUTE_MOCKS) vi.doMock(path, () => ({
    [name]: vi.fn(async () => { if (name === 'registerSchedulingRoutes' && f.fault === 'route') throw f.primary; }),
  }));
  if (f.fault === 'swagger') vi.doMock('@fastify/swagger', () => ({
    default: async function failingSwagger() { throw f.primary; },
  }));
  vi.doMock('fastify', async importOriginal => {
    const actual = await importOriginal<typeof import('fastify')>();
    function make(options?: FastifyServerOptions) {
      if (f.framework === 'real') {
        const app = actual.default(options);
        const original = app.addHook.bind(app);
        vi.spyOn(app, 'addHook').mockImplementation(((name: string, hook: unknown) => {
          if (name === 'onClose') f.cleanup = hook as () => Promise<void>;
          return (original as (...args: unknown[]) => FastifyInstance)(name, hook);
        }) as typeof app.addHook);
        f.app = app; f.closeSpy = vi.spyOn(app, 'close') as unknown as ReturnType<typeof vi.fn>;
        return app;
      }
      const app = {
        log: { error: vi.fn() }, withTypeProvider() { return this; },
        addHook(name: string, hook: unknown) { if (name === 'onClose') f.cleanup = hook as () => Promise<void>; return this; },
        async register() { return this; }, addContentTypeParser() { return this; },
        setErrorHandler() { return this; }, setNotFoundHandler() { return this; }, get() { return this; },
        close: vi.fn(async () => { throw new Error('synthetic-app-close-before-hook'); }),
      };
      f.app = app as unknown as FastifyInstance; f.closeSpy = app.close;
      return app as unknown as ReturnType<typeof actual.default>;
    }
    return { ...actual, default: make };
  });
  const { buildServer } = await import('./server');
  const overrides = {
    database: f.database, identity: f.identity,
    locations: {}, people: {}, operations: {}, lunchBreaks: {}, notifications: {},
    payroll: {}, timeCards: {}, settings: {}, retainedApplication: { execute: vi.fn() },
    retainedOperators: { executeRetentionPurge: vi.fn(async () => ({ dryRun: true })) }, routes: {},
  };
  if (f.fault === 'db-constructor') delete (overrides as Partial<typeof overrides>).database;
  if (f.fault === 'identity-constructor') delete (overrides as Partial<typeof overrides>).identity;
  const result = observe(buildServer(CONFIG, overrides as never)); outcomes.push(result);
  return result;
}
async function built(f: Fixture): Promise<FastifyInstance> {
  const result = await setup(f); expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  return result.value;
}
function failed(result: Outcome<unknown>, expected: unknown): void {
  expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toBe(expected);
}
function cleanupTrace(f: Fixture): string[] { return f.ledger.filter(x => x.endsWith('.close')); }
function noBusiness(f: Fixture): void {
  expect(f.identity.authenticate).not.toHaveBeenCalled(); expect(f.storage.increment).not.toHaveBeenCalled(); expect(f.quota.consume).not.toHaveBeenCalled();
}
async function scrape(app: FastifyInstance): Promise<string> {
  const response = await requestLoopback(app, { method: 'GET', url: '/metrics', headers: { authorization: 'Bearer ' + CONFIG.metricsToken } });
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).toContain('lunchlineup_api_v2_http_instrumentation_ready{app="lunchlineup-api-v2"} 1');
  return response.body;
}
function controlCount(body: string): number {
  return body.split('\n').filter(line => line.startsWith('lunchlineup_api_v2_http_requests_total{')
    && line.includes('route="/v2/metrics-control"') && line.includes('scope="application"')
    && line.includes('method="GET"') && line.includes('status_class="2xx"'))
    .reduce((total, line) => total + Number(line.slice(line.lastIndexOf(' ') + 1)), 0);
}
afterEach(async () => {
  const failures: unknown[] = [];
  try {
    await Promise.all(outcomes);
    for (const f of fixtures) {
      if (f.app && f.framework === 'real' && f.closeSpy?.mock.calls.length === 0) {
        const result = await observe(f.app.close());
        if (!result.ok && result.error !== f.expectedCleanupError) failures.push(result.error);
      }
      if (f.cleanup) {
        const result = await observe(f.cleanup());
        if (!result.ok && result.error !== f.expectedCleanupError) failures.push(result.error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Metrics-owner fixture cleanup failed');
  } finally {
    fixtures.length = 0; outcomes.length = 0; vi.restoreAllMocks();
    for (const path of MOCK_PATHS) vi.doUnmock(path);
    vi.resetModules();
  }
}, 10_000);

describe('new metrics owner through buildServer with fake service owners', () => {
  it.each(['identity-ready', 'quota-ready', 'swagger', 'route'])('%s keeps the original failure and closes metrics before all completed later owners', async fault => {
    const f = fixture(); f.fault = fault;
    if (fault === 'identity-ready') f.identity.ready.mockRejectedValueOnce(f.primary);
    if (fault === 'quota-ready') f.storage.ready.mockRejectedValueOnce(f.primary);
    failed(await setup(f), f.primary);
    expect(f.metricsConstruct).toHaveBeenCalledExactlyOnceWith(CONFIG.metricsToken, expect.any(Function));
    expect(f.metricsInstall).toHaveBeenCalledOnce();
    expect(f.metricsClose).toHaveBeenCalledOnce();
    expect(cleanupTrace(f)).toEqual(['metrics.close', 'identity.close', 'storage.close', 'db.close']);
    expect(f.metricsInstall.mock.invocationCallOrder[0]).toBeLessThan(f.identity.ready.mock.invocationCallOrder[0]);
    const first = f.cleanup!(); expect(f.cleanup!()).toBe(first); expect((await observe(first)).ok).toBe(true);
    expect(f.metricsClose).toHaveBeenCalledOnce(); noBusiness(f);
  }, 15_000);
  it.each(['metrics-constructor', 'db-constructor', 'identity-constructor'])('%s does not invent ownership for an unreturned constructor', async fault => {
    const f = fixture(); f.fault = fault; failed(await setup(f), f.primary);
    expect(f.metricsConstruct).toHaveBeenCalledOnce();
    const expected = fault === 'metrics-constructor' ? [] : fault === 'db-constructor'
      ? ['metrics.close'] : ['metrics.close', 'db.close'];
    expect(cleanupTrace(f)).toEqual(expected);
    expect(f.metricsClose).toHaveBeenCalledTimes(fault === 'metrics-constructor' ? 0 : 1);
    expect(f.storageConstruct).not.toHaveBeenCalled(); noBusiness(f);
  }, 15_000);
  it('retains the returned metrics owner before a partial install fails', async () => {
    const f = fixture(); f.fault = 'metrics-install'; failed(await setup(f), f.primary);
    expect(f.metricsInstall).toHaveBeenCalledOnce(); expect(f.metricsClose).toHaveBeenCalledOnce();
    expect(cleanupTrace(f)).toEqual(['metrics.close']);
    expect(f.identity.ready).not.toHaveBeenCalled(); expect(f.storageConstruct).not.toHaveBeenCalled();
    expect(f.closeSpy).toHaveBeenCalledOnce(); noBusiness(f);
  }, 15_000);
  it('memoizes normal cleanup even when synchronous metrics close fails', async () => {
    const f = fixture(); const app = await built(f);
    f.metricsError = new Error('synthetic-metrics-close'); f.expectedCleanupError = f.metricsError;
    failed(await observe(app.close()), f.metricsError);
    const first = f.cleanup!(); expect(f.cleanup!()).toBe(first);
    failed(await observe(first), f.metricsError);
    expect(f.metricsClose).toHaveBeenCalledOnce();
    expect(cleanupTrace(f)).toEqual(['metrics.close', 'identity.close', 'storage.close', 'db.close']); noBusiness(f);
  }, 15_000);
  it('preserves startup primary failure when metrics and every later cleanup owner fail', async () => {
    const f = fixture(); f.fault = 'swagger'; f.metricsError = new Error('synthetic-metrics-close');
    f.identity.close.mockImplementation(async () => { f.ledger.push('identity.close'); throw new Error('synthetic-identity-close'); });
    f.storage.close.mockImplementation(() => { f.ledger.push('storage.close'); throw new Error('synthetic-storage-close'); });
    const dbError = new Error('synthetic-db-close');
    f.database.disconnect.mockImplementation(async () => { f.ledger.push('db.close'); throw dbError; });
    f.expectedCleanupError = dbError;
    failed(await setup(f), f.primary);
    expect(cleanupTrace(f)).toEqual(['metrics.close', 'identity.close', 'storage.close', 'db.close']);
    failed(await observe(f.cleanup!()), dbError); expect(f.metricsClose).toHaveBeenCalledOnce(); noBusiness(f);
  }, 15_000);
  it('uses the memoized fallback if the framework close fails before its hook', async () => {
    const f = fixture(); f.framework = 'branch-close-before-hook'; f.fault = 'metrics-install';
    failed(await setup(f), f.primary);
    expect(f.metricsClose).toHaveBeenCalledOnce(); expect(cleanupTrace(f)).toEqual(['metrics.close']);
    const first = f.cleanup!(); expect(f.cleanup!()).toBe(first); expect((await observe(first)).ok).toBe(true);
    expect(f.metricsClose).toHaveBeenCalledOnce(); noBusiness(f);
  }, 15_000);
});
describe('actual metrics in buildServer with actual loopback HTTP and fake dependencies', () => {
  it.each(['database', 'quota'] as const)('scrapes without touching failing %s readiness while ready still returns503', async failedOwner => {
    const f = fixture('actual'); const app = await built(f); await app.ready();
    f.database.ready.mockImplementation(async () => { if (failedOwner === 'database') throw new Error('synthetic-database-down'); });
    f.quota.ready.mockImplementation(async () => { throw new Error('synthetic-quota-down'); });
    f.identity.ready.mockImplementation(async () => { throw new Error('synthetic-identity-down'); });
    for (const mock of [f.database.ready, f.quota.ready, f.storage.ready, f.identity.ready]) mock.mockClear();
    await scrape(app);
    for (const mock of [f.database.ready, f.quota.ready, f.storage.ready, f.identity.ready]) expect(mock).not.toHaveBeenCalled();
    const ready = await requestLoopback(app, { method: 'GET', url: '/v2/ready' });
    expect(ready.statusCode).toBe(503); expect(ready.json().code).toBe('readiness_unavailable');
    expect(f.database.ready).toHaveBeenCalledOnce(); expect(f.quota.ready).toHaveBeenCalledTimes(failedOwner === 'quota' ? 1 : 0);
    await scrape(app); expect(f.database.ready).toHaveBeenCalledOnce();
    expect(f.quota.ready).toHaveBeenCalledTimes(failedOwner === 'quota' ? 1 : 0);
    expect(f.storage.ready).not.toHaveBeenCalled(); expect(f.identity.ready).not.toHaveBeenCalled(); noBusiness(f);
  }, 15_000);
  it('isolates two live server registries and keeps the second alive after closing the first', async () => {
    const first = fixture('actual'); const app1 = await built(first);
    app1.get('/v2/metrics-control', async () => ({ ok: true })); await app1.ready();
    const second = fixture('actual'); const app2 = await built(second);
    app2.get('/v2/metrics-control', async () => ({ ok: true })); await app2.ready();
    expect((await requestLoopback(app1, { method: 'GET', url: '/v2/metrics-control' })).statusCode).toBe(200);
    for (let i = 0; i < 2; i++) expect((await requestLoopback(app2, { method: 'GET', url: '/v2/metrics-control' })).statusCode).toBe(200);
    expect(controlCount(await scrape(app1))).toBe(1); expect(controlCount(await scrape(app2))).toBe(2);
    expect((await observe(app1.close())).ok).toBe(true); expect(first.metricsClose).toHaveBeenCalledOnce();
    expect(second.metricsClose).not.toHaveBeenCalled();
    expect((await requestLoopback(app2, { method: 'GET', url: '/v2/metrics-control' })).statusCode).toBe(200);
    expect(controlCount(await scrape(app2))).toBe(3);
    expect((await observe(app2.close())).ok).toBe(true); expect(second.metricsClose).toHaveBeenCalledOnce();
    expect(cleanupTrace(first)).toEqual(['metrics.close', 'identity.close', 'storage.close', 'db.close']);
    expect(cleanupTrace(second)).toEqual(['metrics.close', 'identity.close', 'storage.close', 'db.close']);
    noBusiness(first); noBusiness(second);
  }, 20_000);
  it('releases the actual returned metrics owner after identity startup failure', async () => {
    const f = fixture('actual'); f.identity.ready.mockRejectedValueOnce(f.primary);
    failed(await setup(f), f.primary);
    expect(f.metricsInstall).toHaveBeenCalledOnce(); expect(f.metricsClose).toHaveBeenCalledOnce();
    expect(cleanupTrace(f)).toEqual(['metrics.close', 'identity.close', 'storage.close', 'db.close']); noBusiness(f);
  }, 15_000);
});
