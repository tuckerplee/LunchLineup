// Private source-only regression draft; future destination native-quota-storage.test.ts.
// Binds selected storage V7; no native Redis, cancellation, or total-wall-budget proof.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeQuotaStorageUnavailableError, NativeRedisQuotaStorage } from './native-quota-storage';

const owned = vi.hoisted(() => ({
  client: undefined as unknown,
  calls: [] as Array<{ url: string; options: unknown }>,
}));
vi.mock('ioredis', () => ({
  default: function Redis(url: string, options: unknown) {
    owned.calls.push({ url, options });
    if (!owned.client) throw new Error('No owned fixture client installed');
    return owned.client;
  },
}));
const ALLOWED = { totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 };
const DENIED = { totalHits: 61, timeToExpire: 60, isBlocked: true, timeToBlockExpire: 60 };
const UNAVAILABLE = 'Shared rate-limit Redis is unavailable.';
type Action = 'increment' | 'ready';
type Result = { ok: true; value: unknown } | { ok: false; error: unknown };
const fixtures: Array<{ storage: NativeRedisQuotaStorage }> = [];
const pendingCleanup: Array<() => void> = [];
const publicResults: Array<Promise<Result>> = [];

function deferred<T>(cleanupValue: T) {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // No extra rejection handler is attached to the underlying operation.
  pendingCleanup.push(() => resolve(cleanupValue));
  return { promise, resolve, reject };
}
function observe(operation: Promise<unknown>) {
  const state = { settled: false };
  const outcome: Promise<Result> = operation.then(
    (value) => { state.settled = true; return { ok: true as const, value }; },
    (error) => { state.settled = true; return { ok: false as const, error }; },
  );
  publicResults.push(outcome);
  return { state, outcome };
}
function harness(ownership: 'injected' | 'owned' = 'injected') {
  const listeners = new Set<(error: unknown) => void>();
  const report = vi.fn();
  const client = {
    status: 'ready',
    connect: vi.fn(async (): Promise<unknown> => undefined),
    ping: vi.fn(async (): Promise<string> => 'PONG'),
    eval: vi.fn(async (_script: string, _keys: number, ..._args: string[]): Promise<unknown> => [1, 60, 0, 0]),
    disconnect: vi.fn((_reconnect?: boolean): void => undefined),
    on: vi.fn((_event: 'error', listener: (error: unknown) => void) => { listeners.add(listener); }),
    off: vi.fn((_event: 'error', listener: (error: unknown) => void) => { listeners.delete(listener); }),
  };
  if (ownership === 'owned') owned.client = client;
  const storage = ownership === 'owned'
    ? new NativeRedisQuotaStorage('redis://fixture.invalid:6379', report)
    : new NativeRedisQuotaStorage('redis://fixture.invalid:6379', report, client);
  fixtures.push({ storage });
  return { client, listeners, report, storage };
}
type Harness = ReturnType<typeof harness>;
function start(h: Harness, action: Action) {
  return observe(action === 'ready' ? h.storage.ready()
    : h.storage.increment('key', 60_000, 60, 60_000, 'default'));
}
function success(result: Result, action: Action) {
  expect(result).toEqual({ ok: true, value: action === 'ready' ? undefined : ALLOWED });
}
function denied(result: Result, action: Action) {
  if (action === 'increment') {
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(NativeQuotaStorageUnavailableError);
      expect((result.error as Error).message).toBe('Shared rate-limit storage is unavailable.');
      expect(Object.prototype.hasOwnProperty.call(result.error, 'cause')).toBe(false);
    }
  }
  else {
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe(UNAVAILABLE);
    }
  }
}
function diagnostic(h: Harness, times: number) {
  expect(h.report).toHaveBeenCalledTimes(times);
  expect(h.report.mock.calls).toEqual(Array.from({ length: times }, () => []));
}
async function tick(ms = 0) { await vi.advanceTimersByTimeAsync(ms); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  owned.client = undefined;
  owned.calls.length = 0;
});
afterEach(async () => {
  // Close first, so failed assertions cannot allow deferred cleanup to issue
  // new PING/EVAL commands. Settle each owned deferred, then public outcomes.
  try {
    const cleanupErrors: unknown[] = [];
    for (const f of fixtures) {
      try { f.storage.close(); } catch (error) { cleanupErrors.push(error); }
    }
    for (const settle of pendingCleanup) {
      try { settle(); } catch (error) { cleanupErrors.push(error); }
    }
    try {
      await Promise.all(publicResults);
      await tick();
      expect(vi.getTimerCount()).toBe(0);
    } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Quota fixture cleanup failed');
  } finally {
    fixtures.length = 0; pendingCleanup.length = 0; publicResults.length = 0;
    owned.client = undefined;
    vi.useRealTimers();
  }
});

describe('shared quota V6 finite transport contracts', () => {
  const connectCases: Array<{ status: string; action: Action; outcome: string }> = [];
  for (const status of ['wait', 'end']) for (const action of ['increment', 'ready'] as const)
    for (const outcome of ['success', 'reject', 'timeout-resolve', 'timeout-reject'])
      connectCases.push({ status, action, outcome });
  it.each(connectCases)('connect $status $action $outcome', async ({ status, action, outcome }) => {
    const h = harness(); h.client.status = status;
    const gate = deferred<unknown>(undefined);
    h.client.connect.mockImplementationOnce(() => {
      h.client.status = 'connecting'; return gate.promise;
    });
    const observed = start(h, action);
    await tick();
    expect(h.client.connect).toHaveBeenCalledOnce();
    expect(h.client.ping).not.toHaveBeenCalled(); expect(h.client.eval).not.toHaveBeenCalled();
    expect(observed.state.settled).toBe(false);
    if (outcome.startsWith('timeout')) {
      await tick(1499); expect(observed.state.settled).toBe(false);
      await tick(1); denied(await observed.outcome, action);
      diagnostic(h, 1); expect(vi.getTimerCount()).toBe(0);
      await tick(1);
      if (outcome === 'timeout-reject') gate.reject(new Error('private-late-connect'));
      else { h.client.status = 'ready'; gate.resolve(undefined); }
      await tick();
      expect(h.client.ping).not.toHaveBeenCalled(); expect(h.client.eval).not.toHaveBeenCalled();
      diagnostic(h, 1); expect(vi.getTimerCount()).toBe(0);
    } else {
      await tick(1);
      if (outcome === 'reject') gate.reject(new Error('private-connect'));
      else { h.client.status = 'ready'; gate.resolve(undefined); }
      await tick();
      if (outcome === 'success') {
        success(await observed.outcome, action);
        expect(h.client.eval).toHaveBeenCalledOnce();
        expect(h.client.ping).toHaveBeenCalledTimes(action === 'ready' ? 1 : 0);
        diagnostic(h, 0);
      } else {
        denied(await observed.outcome, action);
        expect(h.client.ping).not.toHaveBeenCalled(); expect(h.client.eval).not.toHaveBeenCalled();
        diagnostic(h, 1);
      }
    }
  }, 10_000);

  it('uses exact customer and separate readiness digests and operation order', async () => {
    const h = harness();
    success(await start(h, 'increment').outcome, 'increment');
    expect(h.client.connect).not.toHaveBeenCalled();
    expect(h.client.ping).not.toHaveBeenCalled();
    expect(h.client.eval).toHaveBeenCalledOnce();
    diagnostic(h, 0); expect(vi.getTimerCount()).toBe(0);
    const digest = createHash('sha256').update('default:key').digest('hex');
    expect(h.client.eval).toHaveBeenNthCalledWith(1, expect.stringContaining("redis.call('TIME')"), 2,
      'lunchlineup:rate-limit:v1:{' + digest + '}:hits',
      'lunchlineup:rate-limit:v1:{' + digest + '}:state', '60000', '60', '60000');
    h.client.eval.mockResolvedValueOnce([1, 1, 0, 0]);
    success(await start(h, 'ready').outcome, 'ready');
    const readyDigest = createHash('sha256').update('readiness:readiness').digest('hex');
    expect(h.client.eval).toHaveBeenNthCalledWith(2, expect.any(String), 2,
      'lunchlineup:rate-limit:v1:{' + readyDigest + '}:hits',
      'lunchlineup:rate-limit:v1:{' + readyDigest + '}:state', '1000', '1000000', '1000');
    expect(h.client.connect).not.toHaveBeenCalled();
    expect(h.client.ping).toHaveBeenCalledOnce();
    expect(h.client.eval).toHaveBeenCalledTimes(2);
    expect(h.client.ping.mock.invocationCallOrder[0]).toBeLessThan(h.client.eval.mock.invocationCallOrder[1]);
    diagnostic(h, 0); expect(vi.getTimerCount()).toBe(0);
  }, 10_000);

  const nonready: Array<{ status: string; action: Action }> = [];
  for (const status of ['connecting', 'connect', 'reconnecting'])
    for (const action of ['increment', 'ready'] as const) nonready.push({ status, action });
  it.each(nonready)('does not add connection waits for $status $action', async ({ status, action }) => {
    const h = harness(); h.client.status = status;
    h.client.eval.mockRejectedValueOnce(new Error('private-not-writable'));
    h.client.ping.mockRejectedValueOnce(new Error('private-not-writable'));
    denied(await start(h, action).outcome, action);
    expect(h.client.connect).not.toHaveBeenCalled();
    expect(h.client.ping).toHaveBeenCalledTimes(action === 'ready' ? 1 : 0);
    expect(h.client.eval).toHaveBeenCalledTimes(action === 'increment' ? 1 : 0);
    diagnostic(h, 1);
  }, 10_000);

  it.each(['reject', 'non-PONG', 'timeout-resolve', 'timeout-reject'])('PING %s', async (outcome) => {
    const h = harness(); const gate = deferred('PONG');
    if (outcome === 'reject') h.client.ping.mockRejectedValueOnce(new Error('private-ping'));
    else if (outcome === 'non-PONG') h.client.ping.mockResolvedValueOnce('private-not-PONG');
    else h.client.ping.mockImplementationOnce(() => gate.promise);
    const observed = start(h, 'ready'); await tick();
    if (outcome.startsWith('timeout')) {
      await tick(1499); expect(observed.state.settled).toBe(false);
      await tick(1); denied(await observed.outcome, 'ready');
      await tick(1);
      if (outcome === 'timeout-reject') gate.reject(new Error('private-late-ping')); else gate.resolve('PONG');
      await tick();
    } else denied(await observed.outcome, 'ready');
    expect(h.client.connect).not.toHaveBeenCalled(); expect(h.client.ping).toHaveBeenCalledOnce();
    expect(h.client.eval).not.toHaveBeenCalled(); diagnostic(h, 1);
  }, 10_000);

  const evalCases: Array<{ action: Action; outcome: string }> = [];
  for (const action of ['increment', 'ready'] as const)
    for (const outcome of ['reject', 'timeout-resolve', 'timeout-reject']) evalCases.push({ action, outcome });
  it.each(evalCases)('EVAL $action $outcome without retry', async ({ action, outcome }) => {
    const h = harness(); const gate = deferred<unknown>([1, 60, 0, 0]);
    if (outcome === 'reject') h.client.eval.mockRejectedValueOnce(new Error('private-eval'));
    else h.client.eval.mockImplementationOnce(() => gate.promise);
    const observed = start(h, action); await tick();
    if (outcome.startsWith('timeout')) {
      await tick(1499); expect(observed.state.settled).toBe(false);
      await tick(1); denied(await observed.outcome, action);
      expect(vi.getTimerCount()).toBe(0); diagnostic(h, 1);
      await tick(1);
      if (outcome === 'timeout-reject') gate.reject(new Error('private-late-eval')); else gate.resolve([1, 60, 0, 0]);
      await tick();
    } else denied(await observed.outcome, action);
    expect(h.client.eval).toHaveBeenCalledOnce();
    expect(h.client.ping).toHaveBeenCalledTimes(action === 'ready' ? 1 : 0);
    diagnostic(h, 1);
  }, 10_000);

  it.each([{ id: 'blocked', reply: [1000001, 1, 1, 1] }, { id: 'malformed', reply: [1, 60, 2, 0] }])(
    'readiness rejects $id records', async ({ reply }) => {
      const h = harness(); h.client.eval.mockResolvedValueOnce(reply);
      denied(await start(h, 'ready').outcome, 'ready');
      expect(h.client.ping).toHaveBeenCalledOnce(); expect(h.client.eval).toHaveBeenCalledOnce(); diagnostic(h, 1);
    }, 10_000);

  it('owned constructor and close use exact transport ownership options', () => {
    const h = harness('owned');
    expect(owned.calls).toEqual([{ url: 'redis://fixture.invalid:6379', options: {
      lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: 1500,
      enableOfflineQueue: false, enableReadyCheck: false, autoResendUnfulfilledCommands: false,
    } }]);
    const listener = h.client.on.mock.calls[0][1];
    expect(h.client.on).toHaveBeenCalledExactlyOnceWith('error', listener);
    h.storage.close(); h.storage.close();
    expect(h.client.disconnect).toHaveBeenCalledExactlyOnceWith(false);
    expect(h.client.off).toHaveBeenCalledExactlyOnceWith('error', listener);
  });

  it('injected close preserves other listeners and silences saved owned listener', () => {
    const h = harness(); const shared = vi.fn(); h.listeners.add(shared);
    const listener = h.client.on.mock.calls[0][1];
    h.storage.close(); h.storage.close(); listener(new Error('private-after-close'));
    expect(h.client.disconnect).not.toHaveBeenCalled();
    expect(h.client.off).toHaveBeenCalledExactlyOnceWith('error', listener);
    expect([...h.listeners]).toEqual([shared]); diagnostic(h, 0);
  });

  it.each(['disconnect', 'off'] as const)('close remains idempotent when %s throws', (operation) => {
    const h = harness(operation === 'disconnect' ? 'owned' : 'injected');
    const error = new Error('private-close'); const listener = h.client.on.mock.calls[0][1];
    h.client[operation].mockImplementationOnce(() => { throw error; });
    let closeError: unknown;
    try { h.storage.close(); } catch (caught) { closeError = caught; }
    expect(closeError).toBe(error);
    expect(() => h.storage.close()).not.toThrow();
    expect(h.client.off).toHaveBeenCalledExactlyOnceWith('error', listener);
    expect(h.client.disconnect).toHaveBeenCalledTimes(operation === 'disconnect' ? 1 : 0);
    diagnostic(h, 0);
  });

  it.each(['increment', 'ready'] as const)('closed new %s stays failclosed and silent', async (action) => {
    const h = harness(); h.storage.close();
    denied(await start(h, action).outcome, action);
    expect(h.client.connect).not.toHaveBeenCalled(); expect(h.client.ping).not.toHaveBeenCalled();
    expect(h.client.eval).not.toHaveBeenCalled(); diagnostic(h, 0);
  }, 10_000);

  const closeCases: Array<{ action: Action; stage: string; outcome: string }> = [
    { action: 'increment', stage: 'connect', outcome: 'resolve' },
    { action: 'ready', stage: 'connect', outcome: 'resolve' },
    { action: 'ready', stage: 'ping', outcome: 'resolve' },
    { action: 'increment', stage: 'eval', outcome: 'resolve' },
    { action: 'increment', stage: 'eval', outcome: 'reject' },
    { action: 'ready', stage: 'eval', outcome: 'resolve' },
    { action: 'ready', stage: 'eval', outcome: 'reject' },
  ];
  it.each(closeCases)('close during $action $stage $outcome fences publication', async ({ action, stage, outcome }) => {
    const h = harness();
    const connection = deferred<unknown>(undefined), ping = deferred('PONG'), evaluation = deferred<unknown>([1, 60, 0, 0]);
    if (stage === 'connect') { h.client.status = 'wait'; h.client.connect.mockImplementationOnce(() => connection.promise); }
    else if (stage === 'ping') h.client.ping.mockImplementationOnce(() => ping.promise);
    else h.client.eval.mockImplementationOnce(() => evaluation.promise);
    const observed = start(h, action); await tick(); expect(observed.state.settled).toBe(false);
    await tick(500); h.storage.close(); await tick(1);
    if (stage === 'connect') { h.client.status = 'ready'; connection.resolve(undefined); }
    else if (stage === 'ping') ping.resolve('PONG');
    else if (outcome === 'reject') evaluation.reject(new Error('private-after-close'));
    else evaluation.resolve([1, 60, 0, 0]);
    await tick(); denied(await observed.outcome, action); diagnostic(h, 0);
    expect(h.client.eval).toHaveBeenCalledTimes(stage === 'eval' ? 1 : 0);
    expect(h.client.ping).toHaveBeenCalledTimes(action === 'ready' && stage !== 'connect' ? 1 : 0);
    expect(h.client.disconnect).not.toHaveBeenCalled(); expect(h.client.off).toHaveBeenCalledOnce();
  }, 10_000);

  it('throttles diagnostics at zero, 59999 and 60000 without forwarding payloads', async () => {
    const h = harness(); const shared = vi.fn(); h.listeners.add(shared);
    const listener = h.client.on.mock.calls[0][1];
    listener(new Error('private-first')); listener(new Error('private-second')); diagnostic(h, 1);
    await tick(59999); listener(new Error('private-third')); diagnostic(h, 1);
    await tick(1); listener(new Error('private-fourth')); diagnostic(h, 2);
    h.storage.close(); listener(new Error('private-after-close')); diagnostic(h, 2);
    expect([...h.listeners]).toEqual([shared]);
  }, 10_000);

  it.each([
    { id: "parse-valid-numeric-zero", reply: [0,0,0,0], expected: { totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 }, diagnostic: false },
    { id: "parse-valid-decimal-zero", reply: ["0","0","0","0"], expected: { totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 }, diagnostic: false },
    { id: "parse-valid-numeric-blocked", reply: [61,60,1,59], expected: { totalHits: 61, timeToExpire: 60, isBlocked: true, timeToBlockExpire: 59 }, diagnostic: false },
    { id: "parse-valid-decimal-leading-zero", reply: ["0001","060","01","000"], expected: { totalHits: 1, timeToExpire: 60, isBlocked: true, timeToBlockExpire: 0 }, diagnostic: false },
    { id: "parse-valid-max-safe-decimal", reply: ["9007199254740991","9007199254740991","0","9007199254740991"], expected: { totalHits: 9007199254740991, timeToExpire: 9007199254740991, isBlocked: false, timeToBlockExpire: 9007199254740991 }, diagnostic: false },
    { id: "parse-invalid-unsafe-decimal", reply: ["9007199254740992",60,0,0], expected: DENIED, diagnostic: true },
    { id: "parse-invalid-huge-decimal", reply: ["9999999999999999999999999999999999999999",60,0,0], expected: DENIED, diagnostic: true },
    { id: "parse-invalid-negative-decimal", reply: ["-1",60,0,0], expected: DENIED, diagnostic: true },
    { id: "parse-invalid-plus-decimal", reply: ["+1",60,0,0], expected: DENIED, diagnostic: true },
    { id: "parse-invalid-fractional-string", reply: ["1.0",60,0,0], expected: DENIED, diagnostic: true },
    { id: "parse-invalid-exponential-string", reply: ["1e2",60,0,0], expected: DENIED, diagnostic: true },
    { id: "parse-invalid-hex-string", reply: ["0x10",60,0,0], expected: DENIED, diagnostic: true },
    { id: "parse-invalid-whitespace-string", reply: [" 1",60,0,0], expected: DENIED, diagnostic: true },
    { id: "parse-invalid-empty-string", reply: ["",60,0,0], expected: DENIED, diagnostic: true },
    { id: "parse-invalid-numeric-fraction", reply: [1.5,60,0,0], expected: DENIED, diagnostic: true },
    { id: "parse-invalid-numeric-negative", reply: [1,-1,0,0], expected: DENIED, diagnostic: true },
    { id: "parse-invalid-NaN", reply: [Number.NaN, 60, 0, 0], expected: DENIED, diagnostic: true },
    { id: "parse-invalid-infinity", reply: [Number.POSITIVE_INFINITY, 60, 0, 0], expected: DENIED, diagnostic: true },
    { id: "parse-invalid-unsafe-numeric", reply: [9007199254740992,60,0,0], expected: DENIED, diagnostic: true },
    { id: "parse-invalid-boolean-blocked", reply: [1,60,true,0], expected: DENIED, diagnostic: true },
    { id: "parse-invalid-blocked-two", reply: [1,60,2,0], expected: DENIED, diagnostic: true },
    { id: "parse-invalid-short-array", reply: [1,60,0], expected: DENIED, diagnostic: true },
    { id: "parse-invalid-extra-array", reply: [1,60,0,0,0], expected: DENIED, diagnostic: true },
    { id: "parse-invalid-nonarray-null", reply: null, expected: DENIED, diagnostic: true },
    { id: "parse-invalid-nonarray-object", reply: {"0":1,"1":60,"2":0,"3":0,"length":4}, expected: DENIED, diagnostic: true },
    { id: "parse-invalid-nonarray-string", reply: "1,60,0,0", expected: DENIED, diagnostic: true },
    { id: "parse-invalid-null-element", reply: [1,null,0,0], expected: DENIED, diagnostic: true },
    { id: "parse-invalid-undefined-element", reply: [1, undefined, 0, 0], expected: DENIED, diagnostic: true },
    { id: "parse-decimal-terminal-newline-v6-denied", reply: ["1\n",60,0,0], expected: DENIED, diagnostic: true }
  ])('$id', async ({ reply, expected, diagnostic: shouldReport }) => {
    const h = harness(); h.client.eval.mockResolvedValueOnce(reply);
    const result = await start(h, 'increment').outcome;
    if (shouldReport) denied(result, 'increment');
    else expect(result).toEqual({ ok: true, value: expected });
    expect(h.client.eval).toHaveBeenCalledOnce(); diagnostic(h, shouldReport ? 1 : 0);
  }, 10_000);

  it.each(['increment', 'ready'] as const)('sequential %s wrappers are not a total 1500ms budget', async (action) => {
    const h = harness(); h.client.status = 'wait';
    const connection = deferred<unknown>(undefined), ping = deferred('PONG'), evaluation = deferred<unknown>([1, 60, 0, 0]);
    h.client.connect.mockImplementationOnce(() => connection.promise);
    h.client.eval.mockImplementationOnce(() => evaluation.promise);
    if (action === 'ready') h.client.ping.mockImplementationOnce(() => ping.promise);
    const observed = start(h, action); await tick();
    await tick(1499); h.client.status = 'ready'; connection.resolve(undefined); await tick();
    await tick(1); expect(observed.state.settled).toBe(false);
    await tick(1498);
    if (action === 'ready') {
      ping.resolve('PONG'); await tick();
      await tick(2); expect(observed.state.settled).toBe(false);
      await tick(1497);
    }
    evaluation.resolve(action === 'ready' ? [1, 1, 0, 0] : [1, 60, 0, 0]); await tick();
    success(await observed.outcome, action);
    expect(h.client.connect).toHaveBeenCalledOnce(); expect(h.client.eval).toHaveBeenCalledOnce();
    expect(h.client.ping).toHaveBeenCalledTimes(action === 'ready' ? 1 : 0); diagnostic(h, 0);
  }, 10_000);
  it.each(['increment', 'ready'] as const)('reporter failure cannot replace safe %s unavailability', async action => {
    const h = harness();
    h.report.mockImplementation(() => { throw new Error('synthetic-private-report-error'); });
    h.client.eval.mockRejectedValueOnce(new Error('synthetic-private-redis-error'));
    denied(await start(h, action).outcome, action);
    diagnostic(h, 1);
    expect(h.client.eval).toHaveBeenCalledTimes(1);
  });

});
