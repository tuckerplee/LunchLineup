// Private source-only draft. Future destination apps/api-v2/src/server.lifecycle.test.ts.
// Bind composed server d1183aac... plus selected quota/storage siblings before execution.
// No static server import; no real DB, Redis, fetch, listen, signal or provider probe.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { ApiV2Config } from './config';

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
const MOCK_PATHS = ['fastify', '@fastify/swagger', './platform/database',
  './platform/native-identity', './platform/native-quota-storage', './platform/native-quota',
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
type Result<T> = { ok: true; value: T } | { ok: false; error: unknown };
const publicOutcomes: Array<Promise<unknown>> = [];
const releases: Array<() => void> = [];
function observe<T>(promise: Promise<T>): Promise<Result<T>> {
  const result = promise.then(
    value => ({ ok: true as const, value }),
    error => ({ ok: false as const, error }),
  );
  publicOutcomes.push(result);
  return result;
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  releases.push(resolve);
  return { promise, resolve };
}
function fixture(mode: 'real' | 'branch' = 'real') {
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
    close: vi.fn((): void => { ledger.push('storage.close'); }),
    increment: vi.fn(async () => { throw new Error('Unexpected increment'); }),
  };
  const quota = {
    ready: vi.fn(async () => { ledger.push('quota.ready'); await storage.ready(); }),
    consume: vi.fn(async () => { throw new Error('Unexpected consume'); }),
    close: vi.fn(),
  };
  const operator = vi.fn(async () => ({ dryRun: true, stage: 'application_data', processedTenantCount: 0 }));
  return {
    mode, ledger, database, identity, storage, quota, operator,
    storageConstructor: vi.fn(), quotaConstructor: vi.fn(), databaseConstructor: vi.fn(), identityConstructor: vi.fn(),
    primary: new Error('primary-startup-sentinel'),
    fault: '' as string, injected: false, omitIdentityHooks: false,
    closeFallback: '' as '' | 'before-hook' | 'after-hook',
    expectedCleanupError: undefined as unknown,
    app: undefined as FastifyInstance | undefined,
    closeSpy: undefined as ReturnType<typeof vi.fn> | undefined,
    registerSpy: undefined as ReturnType<typeof vi.fn> | undefined,
    cleanup: undefined as (() => Promise<void>) | undefined,
    routeCalls: [] as string[],
  };
}
type Fixture = ReturnType<typeof fixture>;
const fixtures: Fixture[] = [];
function error(result: Result<unknown>, expected: unknown) {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBe(expected);
}
function cleanupTrace(f: Fixture) { return f.ledger.filter(value => value.endsWith('.close')); }
function noBusiness(f: Fixture) {
  expect(f.identity.authenticate).not.toHaveBeenCalled();
  expect(f.quota.consume).not.toHaveBeenCalled();
  expect(f.storage.increment).not.toHaveBeenCalled();
}
async function setup(f: Fixture) {
  fixtures.push(f);
  for (const path of MOCK_PATHS) vi.doUnmock(path);
  vi.resetModules();
  vi.doMock('./platform/database', () => ({ TenantDatabase: class {
    constructor() { f.databaseConstructor(); if (f.fault === 'db-constructor') throw f.primary; return f.database; }
  } }));
  vi.doMock('./platform/native-identity', () => ({ NativeIdentityAdapter: class {
    constructor() { f.identityConstructor(); if (f.fault === 'identity-constructor') throw f.primary; return f.identity; }
  } }));
  vi.doMock('./platform/native-quota-storage', () => ({ NativeRedisQuotaStorage: class {
    constructor(url: string, diagnostic: () => void) {
      f.storageConstructor(url, diagnostic);
      if (f.fault === 'storage-constructor') throw f.primary;
      return f.storage;
    }
  } }));
  vi.doMock('./platform/native-quota', () => ({ NativePlanQuota: class {
    constructor(database: unknown, storage: unknown) {
      f.quotaConstructor(database, storage); return f.quota;
    }
  } }));
  for (const [path, name] of SERVICE_GUARDS) {
    if (path === './platform/retained-operator.bridge') {
      vi.doMock(path, async importOriginal => {
        const actual = await importOriginal<Record<string, unknown>>();
        return { ...actual, [name]: class { constructor() { throw new Error('Unexpected operator constructor'); } } };
      });
    } else vi.doMock(path, () => ({ [name]: class {
      constructor() {
        if (path === './locations/locations.service' && f.fault === 'location-constructor') throw f.primary;
        throw new Error('Unexpected service constructor: ' + name);
      }
    } }));
  }
  for (const [path, name] of ROUTE_MOCKS) vi.doMock(path, () => ({
    [name]: vi.fn(async () => {
      f.routeCalls.push(name);
      if (name === 'registerSchedulingRoutes' && f.fault === 'route') throw f.primary;
    }),
  }));
  if (f.fault === 'swagger') vi.doMock('@fastify/swagger', () => ({
    default: async function failingSwagger() { f.ledger.push('swagger.failed'); throw f.primary; },
  }));
  vi.doMock('fastify', async importOriginal => {
    const actual = await importOriginal<typeof import('fastify')>();
    function make(options?: FastifyServerOptions) {
      if (f.mode === 'real') {
        const app = actual.default(options);
        const original = app.addHook.bind(app);
        vi.spyOn(app, 'addHook').mockImplementation(((name: string, hook: unknown) => {
          if (name === 'onClose') f.cleanup = hook as () => Promise<void>;
          return (original as (...args: unknown[]) => FastifyInstance)(name, hook);
        }) as typeof app.addHook);
        f.app = app; f.closeSpy = vi.spyOn(app, 'close') as unknown as ReturnType<typeof vi.fn>;
        f.registerSpy = vi.spyOn(app, 'register') as unknown as ReturnType<typeof vi.fn>;
        return app;
      }
      let registrations = 0;
      const app = {
        log: { error: vi.fn() }, withTypeProvider() { return this; },
        addHook(name: string, hook: unknown) { if (name === 'onClose') f.cleanup = hook as () => Promise<void>; return this; },
        async register() {
          registrations++; if (registrations === 2 && f.fault === 'swagger') throw f.primary; return this;
        },
        addContentTypeParser() { return this; }, setErrorHandler() { return this; }, setNotFoundHandler() { return this; },
        get() { return this; }, post() { return this; },
        close: vi.fn(async () => {
          if (f.closeFallback === 'before-hook') throw new Error('app-close-before-hook');
          await f.cleanup?.();
          if (f.closeFallback === 'after-hook') throw new Error('app-close-after-hook');
        }),
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
    retainedOperators: { executeRetentionPurge: f.operator }, routes: {},
    ...(f.injected ? { quota: f.quota } : {}),
  };
  if (f.omitIdentityHooks) overrides.identity = { authenticate: f.identity.authenticate } as typeof f.identity;
  if (f.fault === 'db-constructor') delete (overrides as Partial<typeof overrides>).database;
  if (f.fault === 'identity-constructor') delete (overrides as Partial<typeof overrides>).identity;
  if (f.fault === 'location-constructor') delete (overrides as Partial<typeof overrides>).locations;
  return observe(buildServer(CONFIG, overrides as never));
}
async function built(f: Fixture) {
  const result = await setup(f);
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  return result.value;
}
function resetCalls(f: Fixture) {
  f.ledger.length = 0;
  for (const mock of [f.database.ready, f.database.disconnect, f.identity.ready, f.identity.close,
    f.identity.authenticate, f.storage.ready, f.storage.close, f.storage.increment,
    f.quota.ready, f.quota.consume, f.operator]) mock.mockClear();
}
afterEach(async () => {
  const failures: unknown[] = [];
  try {
    for (const release of releases) release();
    await Promise.all(publicOutcomes);
    for (const f of fixtures) {
      if (f.app && f.closeSpy?.mock.calls.length === 0) {
        const result = await observe(f.app.close());
        if (!result.ok && result.error !== f.expectedCleanupError) failures.push(result.error);
      }
      if (f.cleanup) {
        const result = await observe(f.cleanup());
        if (!result.ok && result.error !== f.expectedCleanupError) failures.push(result.error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Lifecycle fixture cleanup failed');
  } finally {
    fixtures.length = 0; releases.length = 0; publicOutcomes.length = 0;
    vi.restoreAllMocks();
    for (const path of MOCK_PATHS) vi.doUnmock(path);
    vi.resetModules();
  }
}, 10_000);

describe('composed server lifecycle with actual Fastify and fake owners', () => {
  it.each(['identity-ready', 'quota-ready', 'swagger', 'route'])('preserves startup failure %s and closes completed owners', async fault => {
    const f = fixture(); f.fault = fault;
    if (fault === 'identity-ready') f.identity.ready.mockRejectedValueOnce(f.primary);
    if (fault === 'quota-ready') f.storage.ready.mockRejectedValueOnce(f.primary);
    error(await setup(f), f.primary);
    expect(f.identity.ready).toHaveBeenCalledOnce();
    expect(f.storage.ready).toHaveBeenCalledTimes(fault === 'identity-ready' ? 0 : 1);
    expect(f.quota.ready).toHaveBeenCalledTimes(fault === 'identity-ready' ? 0 : 1);
    expect(f.registerSpy).toHaveBeenCalledTimes(fault === 'identity-ready' || fault === 'quota-ready' ? 1 : 2);
    expect(f.registerSpy!.mock.invocationCallOrder[0]).toBeLessThan(f.identity.ready.mock.invocationCallOrder[0]);
    if (fault !== 'identity-ready') {
      expect(f.identity.ready.mock.invocationCallOrder[0]).toBeLessThan(f.quota.ready.mock.invocationCallOrder[0]);
      expect(f.quota.ready.mock.invocationCallOrder[0]).toBeLessThan(f.storage.ready.mock.invocationCallOrder[0]);
    }
    if (fault === 'swagger' || fault === 'route') {
      expect(f.storage.ready.mock.invocationCallOrder[0]).toBeLessThan(f.registerSpy!.mock.invocationCallOrder[1]);
    }
    expect(cleanupTrace(f)).toEqual(['identity.close', 'storage.close', 'db.close']);
    expect(f.closeSpy).toHaveBeenCalledOnce();
    expect(f.routeCalls).toEqual(fault === 'route' ? ['registerSchedulingRoutes'] : []);
    const first = f.cleanup!(), second = f.cleanup!(); expect(first).toBe(second);
    expect((await observe(first)).ok).toBe(true);
    expect(cleanupTrace(f)).toEqual(['identity.close', 'storage.close', 'db.close']); noBusiness(f);
  }, 15_000);
  it('preserves a real swagger startup error despite all cleanup owners failing', async () => {
    const f = fixture(); f.fault = 'swagger';
    const identityError = new Error('identity-close-secondary');
    const storageError = new Error('storage-close-secondary');
    const dbError = new Error('db-close-secondary');
    f.identity.close.mockImplementation(async () => { f.ledger.push('identity.close'); throw identityError; });
    f.storage.close.mockImplementation(() => { f.ledger.push('storage.close'); throw storageError; });
    f.database.disconnect.mockImplementation(async () => { f.ledger.push('db.close'); throw dbError; });
    f.expectedCleanupError = dbError;
    error(await setup(f), f.primary);
    expect(f.registerSpy).toHaveBeenCalledTimes(2);
    expect(f.identity.ready.mock.invocationCallOrder[0]).toBeLessThan(f.quota.ready.mock.invocationCallOrder[0]);
    expect(f.storage.ready.mock.invocationCallOrder[0]).toBeLessThan(f.registerSpy!.mock.invocationCallOrder[1]);
    expect(f.ledger).toContain('swagger.failed');
    expect(f.routeCalls).toEqual([]);
    expect(cleanupTrace(f)).toEqual(['identity.close', 'storage.close', 'db.close']);
    error(await observe(f.cleanup!()), dbError); noBusiness(f);
  }, 15_000);
  it('closes owned resources once with exact construction dependencies', async () => {
    const f = fixture(); const app = await built(f);
    expect(f.storageConstructor).toHaveBeenCalledExactlyOnceWith(CONFIG.redisUrl, expect.any(Function));
    expect(f.quotaConstructor).toHaveBeenCalledExactlyOnceWith(f.database, f.storage);
    expect(f.storage.ready).toHaveBeenCalledOnce();
    expect((await observe(app.close())).ok).toBe(true);
    const first = f.cleanup!(); expect(f.cleanup!()).toBe(first); await observe(first);
    expect(cleanupTrace(f)).toEqual(['identity.close', 'storage.close', 'db.close']); noBusiness(f);
  }, 15_000);
  it.each(['success', 'identity-ready', 'quota-ready', 'swagger'])('preserves injected quota ownership on %s', async fault => {
    const f = fixture(); f.injected = true; f.fault = fault;
    if (fault === 'identity-ready') f.identity.ready.mockRejectedValueOnce(f.primary);
    if (fault === 'quota-ready') f.quota.ready.mockRejectedValueOnce(f.primary);
    const result = await setup(f);
    if (fault === 'success') { expect(result.ok).toBe(true); expect((await observe(f.app!.close())).ok).toBe(true); }
    else error(result, f.primary);
    expect(f.storageConstructor).not.toHaveBeenCalled(); expect(f.quotaConstructor).not.toHaveBeenCalled();
    expect(f.quota.ready).toHaveBeenCalledTimes(fault === 'identity-ready' ? 0 : 1);
    expect(f.registerSpy).toHaveBeenCalledTimes(fault === 'identity-ready' || fault === 'quota-ready' ? 1 : 2);
    expect(f.registerSpy!.mock.invocationCallOrder[0]).toBeLessThan(f.identity.ready.mock.invocationCallOrder[0]);
    if (fault !== 'identity-ready') expect(f.identity.ready.mock.invocationCallOrder[0]).toBeLessThan(f.quota.ready.mock.invocationCallOrder[0]);
    if (fault === 'success' || fault === 'swagger') expect(f.quota.ready.mock.invocationCallOrder[0]).toBeLessThan(f.registerSpy!.mock.invocationCallOrder[1]);
    expect(f.quota.close).not.toHaveBeenCalled();
    expect(cleanupTrace(f)).toEqual(['identity.close', 'db.close']); noBusiness(f);
  }, 15_000);
  it('allows optional identity lifecycle hooks to be absent', async () => {
    const f = fixture(); f.omitIdentityHooks = true;
    const app = await built(f); expect((await observe(app.close())).ok).toBe(true);
    expect(f.identity.ready).not.toHaveBeenCalled(); expect(f.identity.close).not.toHaveBeenCalled();
    expect(cleanupTrace(f)).toEqual(['storage.close', 'db.close']); noBusiness(f);
  }, 15_000);
  it.each(['db-constructor', 'identity-constructor', 'location-constructor', 'storage-constructor'])(
    'tracks only returned resources when %s throws', async fault => {
      const f = fixture(); f.fault = fault; error(await setup(f), f.primary);
      const expected = fault === 'db-constructor' ? [] : fault === 'identity-constructor' ? ['db.close'] : ['identity.close', 'db.close'];
      expect(cleanupTrace(f)).toEqual(expected);
      expect(f.identity.ready).not.toHaveBeenCalled(); expect(f.quota.ready).not.toHaveBeenCalled();
      expect(f.closeSpy).toHaveBeenCalledOnce(); noBusiness(f);
      // Adapted L15: constructors now run inside guarded startup. Hidden
      // allocations in an unreturned constructor remain constructor-owned.
    }, 15_000);
  it('memoizes a pending cleanup promise before advancing later owners', async () => {
    const f = fixture(); await built(f); const held = gate();
    f.identity.close.mockImplementationOnce(async () => { f.ledger.push('identity.close'); await held.promise; });
    const first = f.cleanup!(); const observed = observe(first); const second = f.cleanup!();
    expect(first).toBe(second); expect(cleanupTrace(f)).toEqual(['identity.close']);
    expect(f.storage.close).not.toHaveBeenCalled(); expect(f.database.disconnect).not.toHaveBeenCalled();
    held.resolve(); expect((await observed).ok).toBe(true);
    expect(f.cleanup!()).toBe(first); expect(cleanupTrace(f)).toEqual(['identity.close', 'storage.close', 'db.close']);
  }, 15_000);
  it.each([false, true])('rechecks DB then quota for every readiness request; injected=%s', async injected => {
    const f = fixture(); f.injected = injected; const app = await built(f); resetCalls(f);
    expect(f.storageConstructor).toHaveBeenCalledTimes(injected ? 0 : 1);
    expect(f.quotaConstructor).toHaveBeenCalledTimes(injected ? 0 : 1);
    for (let index = 0; index < 2; index++) {
      const response = await app.inject({ method: 'GET', url: '/v2/ready' });
      expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ status: 'ok', service: 'api-v2' });
    }
    expect(f.ledger).toEqual(['db.ready', 'quota.ready', 'storage.ready', 'db.ready', 'quota.ready', 'storage.ready']);
    expect(f.identity.ready).not.toHaveBeenCalled(); noBusiness(f); expect(cleanupTrace(f)).toEqual([]);
  }, 15_000);
  it.each(['db', 'quota'])('redacts %s readiness failure and recovers on next probe', async owner => {
    const f = fixture(); const app = await built(f); resetCalls(f); const privateError = new Error('private-readiness-sentinel');
    if (owner === 'db') f.database.ready.mockRejectedValueOnce(privateError);
    else f.quota.ready.mockRejectedValueOnce(privateError);
    const failed = await app.inject({ method: 'GET', url: '/v2/ready' });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toMatchObject({ code: 'readiness_unavailable', detail: 'The service is not ready.', title: 'Service unavailable' });
    expect(failed.headers['content-type']).toContain('application/problem+json');
    expect(failed.headers['cache-control']).toBe('no-store'); expect(failed.body).not.toContain('private-readiness-sentinel');
    expect(f.quota.ready).toHaveBeenCalledTimes(owner === 'db' ? 0 : 1);
    expect(cleanupTrace(f)).toEqual([]); noBusiness(f);
    const recovered = await app.inject({ method: 'GET', url: '/v2/ready' }); expect(recovered.statusCode).toBe(200);
    expect(f.database.ready).toHaveBeenCalledTimes(2); expect(f.quota.ready).toHaveBeenCalledTimes(owner === 'db' ? 1 : 2);
    expect(f.identity.ready).not.toHaveBeenCalled(); noBusiness(f);
  }, 15_000);
  it('keeps live/version/openapi probes independent of readiness owners', async () => {
    const f = fixture(); const app = await built(f); resetCalls(f);
    f.database.ready.mockRejectedValue(new Error('must-not-call-db'));
    f.quota.ready.mockRejectedValue(new Error('must-not-call-quota'));
    const live = await app.inject({ method: 'GET', url: '/v2/live' }); expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: 'ok', service: 'api-v2' });
    const version = await app.inject({ method: 'GET', url: '/v2/version' }); expect(version.statusCode).toBe(200);
    expect(version.json()).toEqual({ service: 'api-v2', version: 'v2', releaseSha: 'local' });
    const openapi = await app.inject({ method: 'GET', url: '/v2/openapi.json' }); expect(openapi.statusCode).toBe(200);
    expect(openapi.json().openapi).toBe('3.1.0');
    expect(f.database.ready).not.toHaveBeenCalled(); expect(f.quota.ready).not.toHaveBeenCalled(); noBusiness(f);
    expect(cleanupTrace(f)).toEqual([]);
  }, 15_000);
  it('keeps retention ingress separate from identity/readiness/customer quota', async () => {
    const f = fixture(); const app = await built(f); resetCalls(f);
    const payload = { dryRun: true, stage: 'application_data' };
    for (const headers of [{ cookie: 'access_token=synthetic' }, { authorization: 'Bearer has space' }]) {
      const denied = await app.inject({ method: 'POST', url: '/v2/admin/retention/purge-expired', headers, payload });
      expect(denied.statusCode).toBe(401); expect(f.operator).not.toHaveBeenCalled();
    }
    const accepted = await app.inject({ method: 'POST', url: '/v2/admin/retention/purge-expired',
      headers: { authorization: 'Bearer synthetic-token' }, payload });
    expect(accepted.statusCode).toBe(200); expect(accepted.json()).toEqual({ ...payload, processedTenantCount: 0 });
    expect(f.operator).toHaveBeenCalledOnce();
    const forwarded = f.operator.mock.calls[0] as unknown as [import('fastify').FastifyRequest, unknown];
    expect(forwarded[0].method).toBe('POST'); expect(forwarded[0].url).toBe('/v2/admin/retention/purge-expired');
    expect(forwarded[0].body).toEqual(payload);
    expect(f.database.ready).not.toHaveBeenCalled(); expect(f.quota.ready).not.toHaveBeenCalled(); noBusiness(f);
    expect(cleanupTrace(f)).toEqual([]);
    // Syntax acceptance only; downstream real service-token authority is unproved.
  }, 15_000);
});

describe('deterministic server branch contracts, not actual Fastify close behavior', () => {
  const failureMasks = ['identity', 'storage', 'db', 'identity+storage', 'identity+db', 'storage+db', 'identity+storage+db'];
  for (const startup of ['normal', 'identity-ready', 'quota-ready', 'swagger', 'route']) it.each(failureMasks)(
    'attempts all cleanup owners, startup=' + startup + ', failures=%s', async mask => {
      const f = fixture('branch');
      const identityError = new Error('identity-close'), storageError = new Error('storage-close'), dbError = new Error('db-close');
      if (mask.includes('identity')) f.identity.close.mockImplementation(async () => { f.ledger.push('identity.close'); throw identityError; });
      if (mask.includes('storage')) f.storage.close.mockImplementation(() => { f.ledger.push('storage.close'); throw storageError; });
      if (mask.includes('db')) f.database.disconnect.mockImplementation(async () => { f.ledger.push('db.close'); throw dbError; });
      const expected = mask.includes('db') ? dbError : mask.includes('storage') ? storageError : identityError;
      f.expectedCleanupError = expected;
      if (startup !== 'normal') {
        f.fault = startup;
        if (startup === 'identity-ready') f.identity.ready.mockRejectedValueOnce(f.primary);
        if (startup === 'quota-ready') f.storage.ready.mockRejectedValueOnce(f.primary);
        error(await setup(f), f.primary);
      } else { await built(f); error(await observe(f.cleanup!()), expected); }
      const first = f.cleanup!(); expect(f.cleanup!()).toBe(first); error(await observe(first), expected);
      expect(cleanupTrace(f)).toEqual(['identity.close', 'storage.close', 'db.close']); noBusiness(f);
    }, 15_000);
  it.each(['before-hook', 'after-hook'] as const)('startup app-close fallback %s preserves primary', async phase => {
    const f = fixture('branch'); f.closeFallback = phase; f.identity.ready.mockRejectedValueOnce(f.primary);
    error(await setup(f), f.primary);
    expect(f.closeSpy).toHaveBeenCalledOnce();
    expect(cleanupTrace(f)).toEqual(['identity.close', 'storage.close', 'db.close']); noBusiness(f);
  }, 15_000);
});
