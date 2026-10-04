import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { NotificationOutboxProcessor } from './notification-outbox.processor';

type Row = Record<string, any>;
const tenantId = 'notification-tenant';
const userId = 'notification-user';
const outboxId = 'notification-intent';
const dedupeKey = 'schedule-published:schedule-a:revision-3:notification-user';
const start = new Date('2026-10-04T20:00:00.000Z');
async function arrived(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise<never>((_yes, no) => { timer = setTimeout(() => no(new Error('Controlled gate not reached')), 1_000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

/** Closed ReadCommitted-style staged adapter, not a PostgreSQL lock/FK/RLS model. */
function fixture() {
  const state = {
    tenant: { id: tenantId, status: 'ACTIVE', deletedAt: null } as Row,
    user: { id: userId, tenantId, role: 'STAFF', email: 'controlled@example.test', deletedAt: null, suspendedAt: null } as Row,
    outbox: new Map<string, Row>([[outboxId, {
      id: outboxId, tenantId, userId, dedupeKey, notificationType: 'SCHEDULE_PUBLISHED',
      title: 'Schedule published', body: 'Controlled location: Oct 4 to Oct 10',
      status: 'PENDING', attempts: 0, failureCount: 0, nextAttemptAt: start, leaseUntil: null,
      deliveredAt: null, lastError: null, createdAt: start, updatedAt: start,
    }]]),
    notifications: new Map<string, Row>(),
  };
  const foreign = { id: 'foreign-notification', tenantId: 'foreign-tenant', userId: 'foreign-user', title: 'Foreign feed', readAt: start };
  state.notifications.set(foreign.id, structuredClone(foreign));
  const unexpected: string[] = [];
  const effects: Array<{ kind: string; id: string; data?: Row }> = [];
  const handoffs: Array<{ attempt: number; id: string; recipient: string | null; title: string; body: string }> = [];
  const fanouts: Row[] = [];
  const held = new Map<string, symbol>();
  const waitingWriters: Array<() => void> = [];
  const locks: string[] = [];
  let beforeHandoff: (() => Promise<void>) | undefined;
  let beforePrepare: (() => Promise<void>) | undefined;
  let preparationRejects = false;
  let preparationRejection: unknown;
  let forceContention: string | undefined;
  const boundaries = new Map<string, () => void>();
  const reached: string[] = [];
  let clockCount = 0;
  const reachedBoundary = (name: string) => { reached.push(name); const effect = boundaries.get(name); boundaries.delete(name); effect?.(); };
  let selectedMono = 1_000;
  vi.spyOn(performance, 'now').mockImplementation(() => selectedMono);
  let candidateFails = false;
  let nextUpsertFails = false;
  let nextExternalFails = false;
  let afterEligibility: (() => Promise<void>) | undefined;
  let afterFeedCommit: (() => Promise<void>) | undefined;
  let claims = 0;
  let rollbacks = 0;
  const check = (condition: unknown, message: string) => {
    if (!condition) { unexpected.push(message); throw new Error(`Closed adapter refusal: ${message}`); }
  };
  const same = (actual: unknown, expected: unknown, message: string) => check(JSON.stringify(actual) === JSON.stringify(expected), message);
  const terminalScrub = (row: Row) => ['DELIVERED', 'DEAD_LETTERED'].includes(row.status)
    ? { ...row, title: '', body: '', lastError: null } : row;

  async function transaction<T>(scope: string, operation: (tx: any) => Promise<T>): Promise<T> {
    const owner = Symbol('transaction');
    const changedOutbox = new Map<string, Row>();
    const changedNotifications = new Map<string, Row>();
    const pendingEffects: typeof effects = [];
    const readOutbox = (id: string) => changedOutbox.get(id) ?? state.outbox.get(id);
    const tx = {
      $executeRaw: async (query: any, ...bindings: unknown[]) => {
        const sql = (query.strings ?? query).join('?'); const values = Array.isArray(query) ? bindings : query.values;
        if (sql.includes("set_config('statement_timeout', '3000', true)")) { same(values, [], 'SQL timeout bindings'); reachedBoundary('sql-budget'); return 1; }
        if (sql.includes('UPDATE "NotificationOutbox" SET "failureCount"')) {
          check(scope === tenantId && held.get('outbox') === owner && sql.includes("::timestamptz AT TIME ZONE 'UTC'"), 'failure budget scoped held UTC CAS');
          const [nextCount, selectedId, selectedTenant, attempt, previousCount, lease] = values;
          same([selectedId, selectedTenant], [outboxId, tenantId], 'failure budget exact scope');
          const row = readOutbox(outboxId);
          if (!row || row.status !== 'PROCESSING' || row.attempts !== attempt || row.failureCount !== previousCount || row.leaseUntil.toISOString() !== lease) return 0;
          check(nextCount === previousCount + 1 && nextCount <= attempt, 'failure count increments once within generation');
          changedOutbox.set(outboxId, { ...structuredClone(row), failureCount: nextCount });
          pendingEffects.push({ kind: 'failure-budget', id: outboxId }); reachedBoundary('failure-budget'); return 1;
        }
        check(sql.includes('UPDATE "NotificationOutbox" SET "leaseUntil"') && sql.includes("::timestamptz AT TIME ZONE 'UTC'"), 'renewal SQL identity/UTC');
        check(scope === tenantId && held.get('outbox') === owner, 'renewal holds scoped row');
        const [newLease, selectedId, selectedTenant, attempt, oldLease] = values;
        same([selectedId, selectedTenant], [outboxId, tenantId], 'renewal exact scope');
        const row = readOutbox(outboxId);
        if (!row || row.status !== 'PROCESSING' || row.attempts !== attempt || row.leaseUntil.toISOString() !== oldLease) return 0;
        const next = { ...structuredClone(row), leaseUntil: new Date(newLease) };
        changedOutbox.set(outboxId, next); pendingEffects.push({ kind: 'renew', id: outboxId }); reachedBoundary('renew'); return 1;
      },
      $queryRaw: async (query: any, ...bindings: unknown[]) => {
        const sql = (query.strings ?? query).join('?');
        const values: unknown[] = Array.isArray(query) ? bindings : query.values;
        const acquire = (key: string) => {
          check(scope === tenantId && sql.includes('NOWAIT'), 'held row exact scope/NOWAIT');
          if (forceContention === key || (held.has(key) && held.get(key) !== owner)) { forceContention = undefined; throw Object.assign(new Error('Controlled NOWAIT contention'), { code: '55P03' }); }
          held.set(key, owner); locks.push(key);
        };
        if (sql.includes('statement_timestamp()')) { same(values, [], 'fresh clock no external time bind'); check(sql.includes("AT TIME ZONE 'UTC'"), 'UTC clock'); const now = new Date(); reachedBoundary(`clock:${++clockCount}`); return [{ now }]; }
        if (sql.includes('FROM "Tenant"')) { same(values, [tenantId], 'Tenant row lock selector'); check(sql.includes('FOR SHARE NOWAIT'), 'Tenant share mode'); acquire('tenant'); const row = structuredClone(state.tenant); reachedBoundary('tenant-lock'); return [row]; }
        if (sql.includes('FROM "User"')) { same(values, [userId, tenantId], 'User row lock selector'); check(sql.includes('FOR SHARE NOWAIT') && held.get('tenant') === owner, 'User share after Tenant'); acquire('user'); const row = structuredClone(state.user); reachedBoundary('user-lock'); return [row]; }
        if (sql.includes('FROM "NotificationOutbox"') && !sql.includes('WITH candidates AS')) {
          same(values, [outboxId, tenantId], 'outbox exact lock selector'); check(sql.includes('FOR UPDATE NOWAIT'), 'Outbox update mode');
          if (sql.includes('"notificationType"')) check(held.get('tenant') === owner && held.get('user') === owner, 'Outbox after Tenant/User');
          acquire('outbox'); const row = readOutbox(outboxId); const selected = row ? [structuredClone(row)] : []; reachedBoundary('outbox-lock'); return selected;
        }
        check(typeof sql === 'string' && sql.includes('WITH candidates AS') && sql.includes('UPDATE "NotificationOutbox" AS outbox')
          && sql.includes('FOR UPDATE SKIP LOCKED') && sql.includes('"attempts" = outbox."attempts" + 1')
          && sql.includes('RETURNING') && sql.includes('outbox."leaseUntil" <='), 'claim SQL identity');

        const dates = values.filter((value): value is Date => value instanceof Date);
        check(dates.length === 4 && dates[0].getTime() === dates[1].getTime() && dates[0].getTime() === dates[3].getTime(), 'claim clock bindings');
        const now = dates[0]; const leaseUntil = dates[2];
        check(leaseUntil.getTime() > now.getTime(), 'finite positive claim lease');
        const limits = values.filter(value => typeof value === 'number') as number[];
        check(limits.length === 1 && Number.isInteger(limits[0]) && limits[0] > 0 && limits[0] <= 250, 'claim bounded limit');
        const strings = values.filter(value => typeof value === 'string');
        same(strings, scope === 'platform' ? [] : [tenantId, dedupeKey], 'claim exact scope/dedupe bindings');
        const row = readOutbox(outboxId);
        if (!row || held.has('outbox') || (scope !== 'platform' && row.tenantId !== scope)) return [];
        const ready = (['PENDING', 'FAILED'].includes(row.status) && row.nextAttemptAt instanceof Date && row.nextAttemptAt <= now)
          || (row.status === 'PROCESSING' && row.leaseUntil instanceof Date && row.leaseUntil <= now);
        if (!ready) return [];
        const claimed = { ...structuredClone(row), status: 'PROCESSING', attempts: row.attempts + 1, leaseUntil, lastError: null, updatedAt: now };
        changedOutbox.set(outboxId, claimed); claims += 1;
        pendingEffects.push({ kind: 'claim', id: outboxId, data: structuredClone(claimed) });
        return [structuredClone(claimed)];
      },
      tenant: { findFirst: async ({ where, select }: Row) => {
        same(where, { id: tenantId, deletedAt: null }, 'tenant eligibility selector');
        same(select, { status: true }, 'tenant eligibility projection');
        check(scope === tenantId, 'tenant eligibility transaction scope');
        return state.tenant.deletedAt === null ? { status: state.tenant.status } : null;
      } },
      user: { findFirst: async ({ where, select }: Row) => {
        same(where, { id: userId, tenantId, role: { in: ['MANAGER', 'STAFF'] }, deletedAt: null, suspendedAt: null }, 'recipient eligibility selector');
        same(select, { id: true, email: true }, 'recipient eligibility projection');
        check(scope === tenantId, 'recipient eligibility transaction scope');
        if (candidateFails) { candidateFails = false; throw new Error('Controlled candidate preparation query failure'); }
        const user = state.user;
        const selected = user.deletedAt === null && user.suspendedAt === null && ['MANAGER', 'STAFF'].includes(user.role)
          ? { id: user.id, email: user.email } : null;
        const gate = afterEligibility; afterEligibility = undefined;
        if (gate) await gate();
        reachedBoundary('candidate'); return selected;
      } },
      notification: { upsert: async ({ where, create, update }: Row) => {
        same(where, { id: outboxId }, 'durable feed identity'); same(update, {}, 'existing read state preservation');
        check(scope === tenantId && create.id === outboxId && create.tenantId === tenantId && create.userId === userId, 'durable feed ownership');
        check(create.type === 'SCHEDULE_PUBLISHED' && typeof create.title === 'string' && typeof create.body === 'string', 'durable feed content');
        if (nextUpsertFails) { nextUpsertFails = false; throw new Error('Controlled precommit feed failure'); }
        const existing = changedNotifications.get(outboxId) ?? state.notifications.get(outboxId);
        if (existing) return structuredClone(existing);
        const row = { ...structuredClone(create), publicId: '44444444-4444-4444-8444-444444444444', readAt: null, createdAt: new Date() };
        changedNotifications.set(outboxId, row); pendingEffects.push({ kind: 'feed-create', id: outboxId, data: structuredClone(row) });
        reachedBoundary('feed'); return structuredClone(row);
      } },
      notificationOutbox: {
        updateMany: async ({ where, data }: Row) => {
          same(where, { id: outboxId, tenantId, status: 'PROCESSING', attempts: where.attempts, leaseUntil: where.leaseUntil }, 'attempt/lease CAS selector');
          check(where.leaseUntil instanceof Date && held.get('outbox') === owner, 'effect exact lease/held row');
          check(scope === tenantId && Number.isInteger(where.attempts) && where.attempts > 0, 'attempt CAS scope');
          check(['DELIVERED', 'FAILED', 'DEAD_LETTERED'].includes(data.status) && data.leaseUntil === null, 'attempt transition domain');
          const row = readOutbox(outboxId);
          if (!row || row.tenantId !== tenantId || row.status !== where.status || row.attempts !== where.attempts || row.leaseUntil.getTime() !== where.leaseUntil.getTime()) return { count: 0 };
          const next = terminalScrub({ ...structuredClone(row), ...structuredClone(data) });
          changedOutbox.set(outboxId, next); pendingEffects.push({ kind: 'transition', id: outboxId, data: structuredClone(next) });
          reachedBoundary('transition'); return { count: 1 };
        },
        findMany: async ({ where, select }: Row) => {
          same(where, { tenantId, dedupeKey: { in: [dedupeKey] } }, 'summary scope');
          same(select, { dedupeKey: true, status: true }, 'summary projection');
          check(scope === tenantId, 'summary transaction scope');
          const row = readOutbox(outboxId); return row ? [{ dedupeKey: row.dedupeKey, status: row.status }] : [];
        },
        count: async ({ where }: Row) => {
          same(where, { status: 'DEAD_LETTERED' }, 'terminal metric filter'); check(scope === 'platform', 'terminal metric capability');
          return [...state.outbox.values()].filter(row => row.status === where.status).length;
        },
      },
    };
    let result: T;
    try { result = await operation(tx); }
    catch (error) { rollbacks += 1; for (const [key, value] of held) if (value === owner) held.delete(key); if (!held.has('user')) waitingWriters.splice(0).forEach(write => write()); throw error; }
    for (const [id, row] of changedOutbox) state.outbox.set(id, row);
    for (const [id, row] of changedNotifications) state.notifications.set(id, row);
    effects.push(...pendingEffects);
    for (const [key, value] of held) if (value === owner) held.delete(key);
    if (!held.has('user')) waitingWriters.splice(0).forEach(write => write());
    if (changedNotifications.size > 0 && afterFeedCommit) {
      const gate = afterFeedCommit; afterFeedCommit = undefined;
      await gate(); // Deliberately after committed effects, before returning to actual deliver().
    }
    return result;
  }
  const tenantDb = {
    withTenant: async (selectedTenantId: string, operation: (tx: any) => Promise<any>, options?: Row) => {
      if (options) { check(options.isolationLevel === 'ReadCommitted' && options.maxWait === 2_000 && [5_000, 40_000].includes(options.timeout), 'explicit finite ReadCommitted budgets'); }
      check(selectedTenantId === tenantId, 'withTenant identity'); return transaction(selectedTenantId, operation);
    },
    withPlatformAdmin: async (operation: (tx: any) => Promise<any>) => transaction('platform', operation),
  };
  const make = (maxAttempts = 2, externalTimeoutMs = 30_000) => new NotificationOutboxProcessor(tenantDb as any, {
    leaseMs: 5_000, maxAttempts, externalTimeoutMs,
    prepareExternal: async (intent, recipient, originalWindow) => {
      check(held.size === 0, 'suppression preparation outside all delivery locks');
      if (preparationRejects) { preparationRejects = false; throw preparationRejection; }
      const preparationGate = beforePrepare; beforePrepare = undefined; if (preparationGate) await preparationGate();
      reachedBoundary('prepare'); originalWindow.assertNewHandoff();
      return Object.freeze({ recipientEmail: recipient, send: async (currentRecipient: string | null, selectedWindow: typeof originalWindow) => {
      const gate = beforeHandoff; beforeHandoff = undefined; if (gate) await gate();
      check(currentRecipient === recipient && selectedWindow.signal === originalWindow.signal, 'prepared exact recipient/window');
      selectedWindow.assertNewHandoff();
      check(held.has('tenant') && held.has('user') && held.has('outbox'), 'NEW handoff within held locks');
      reachedBoundary('handoff');
      handoffs.push({ id: intent.id, attempt: intent.attempts, recipient, title: intent.title, body: intent.body });
      if (nextExternalFails) { nextExternalFails = false; throw new Error('Controlled external adapter failure'); }
      reachedBoundary('provider-complete'); return 'accepted'; // Controlled adapter result only, never provider acceptance evidence.
      } });
    },
    fanOut: async notification => { fanouts.push(structuredClone(notification)); },
    setDeadLetteredCount: () => {},
  });
  async function deleteRecipient() {
    if (held.has('user')) await new Promise<void>(resolve => waitingWriters.push(resolve));
    // Modeled actual anonymizer + User.deletedAt trigger effects, not executing those SQL owners.
    state.user = { ...state.user, deletedAt: new Date(), email: null };
    state.outbox.delete(outboxId); state.notifications.delete(outboxId);
    effects.push({ kind: 'recipient-delete', id: userId });
  }
  return { state, effects, handoffs, fanouts, unexpected, locks, reached, make, deleteRecipient,
    at(boundary: string, effect: () => void) { boundaries.set(boundary, effect); },
    setMono(value: number) { selectedMono = value; },
    pauseHandoff(gate: () => Promise<void>) { beforeHandoff = gate; },
    pausePrepare(gate: () => Promise<void>) { beforePrepare = gate; },
    contend(key: string) { forceContention = key; },
    rejectPreparation(reason: unknown) { preparationRejects = true; preparationRejection = reason; },
    failCandidate() { candidateFails = true; },
    failNextUpsert() { nextUpsertFails = true; }, failNextExternal() { nextExternalFails = true; },
    pauseEligibility(gate: () => Promise<void>) { afterEligibility = gate; },
    pauseFeedCommit(gate: () => Promise<void>) { afterFeedCommit = gate; },
    get claims() { return claims; }, get rollbacks() { return rollbacks; },
    assertClosed() { expect(unexpected).toEqual([]); expect(state.notifications.get(foreign.id)).toEqual(foreign); },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(start);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('actual notification outbox ownership and lifecycle ordering', () => {
  it('commits an active owner feed and terminal scrub before best-effort fanout', async () => {
    const f = fixture(); const result = await f.make().deliverPendingNow(tenantId, [dedupeKey]);
    expect(result).toEqual({ status: 'DELIVERED', delivered: 1, pending: 0, failed: 0 });
    expect(f.state.notifications.get(outboxId)).toMatchObject({ tenantId, userId, readAt: null });
    expect(f.effects.map(effect => effect.kind)).toEqual(['claim', 'renew', 'feed-create', 'transition']);
    expect(f.state.outbox.get(outboxId)).toMatchObject({ status: 'DELIVERED', attempts: 1, title: '', body: '', lastError: null });
    expect(f.handoffs).toHaveLength(1); expect(f.fanouts).toHaveLength(1); f.assertClosed();
  });
  it('recovers a transient external failure with the same feed identity and original read marker', async () => {
    const f = fixture(); const processor = f.make(); f.failNextExternal();
    expect(await processor.deliverPendingNow(tenantId, [dedupeKey])).toEqual({ status: 'PENDING', delivered: 0, pending: 1, failed: 0 });
    expect(f.state.outbox.get(outboxId)?.status).toBe('FAILED'); expect(f.fanouts).toHaveLength(0);
    f.state.notifications.get(outboxId)!.readAt = new Date(start.getTime() + 500);
    vi.setSystemTime(start.getTime() + 2_000);
    await (processor as any).sweep();
    expect(f.state.outbox.get(outboxId)?.status).toBe('DELIVERED');
    expect(f.effects.filter(effect => effect.kind === 'feed-create')).toHaveLength(1);
    expect(f.state.notifications.get(outboxId)?.readAt).toEqual(new Date(start.getTime() + 500));
    expect(f.handoffs.map(call => call.id)).toEqual([outboxId, outboxId]); expect(f.fanouts).toHaveLength(1); f.assertClosed();
  });
  it('rolls back a failed feed transaction and terminalizes only the bounded second failure', async () => {
    const f = fixture(); const processor = f.make(); f.failNextUpsert();
    await processor.deliverPendingNow(tenantId, [dedupeKey]);
    expect(f.rollbacks).toBe(1); expect(f.state.notifications.has(outboxId)).toBe(false);
    expect(f.state.outbox.get(outboxId)?.status).toBe('FAILED');
    vi.setSystemTime(start.getTime() + 2_000); f.failNextUpsert(); await (processor as any).sweep();
    expect(f.state.outbox.get(outboxId)).toMatchObject({ status: 'DEAD_LETTERED', attempts: 2, title: '', body: '', lastError: null });
    expect(f.rollbacks).toBe(2); expect(f.handoffs).toHaveLength(0); f.assertClosed();
  });
  it('refuses an initially ineligible recipient and preserves terminal privacy erasure', async () => {
    const f = fixture(); f.state.user.suspendedAt = start;
    expect(await f.make().deliverPendingNow(tenantId, [dedupeKey])).toEqual({ status: 'FAILED', delivered: 0, pending: 0, failed: 1 });
    expect(f.state.outbox.get(outboxId)).toMatchObject({ status: 'DEAD_LETTERED', title: '', body: '', lastError: null });
    expect(f.state.notifications.has(outboxId)).toBe(false); expect(f.handoffs).toHaveLength(0); f.assertClosed();
  });
  it('refuses obsolete attempt1 effects after attempt2 terminalizes the same committed intent', async () => {
    const f = fixture(); const entered = deferred(); const release = deferred();
    f.pauseEligibility(async () => { entered.resolve(); await release.promise; });
    const old = f.make().deliverPendingNow(tenantId, [dedupeKey]); await arrived(entered.promise);
    try {
      vi.setSystemTime(start.getTime() + 6_000); f.failNextUpsert(); await (f.make(1) as any).sweep();
      expect(f.state.outbox.get(outboxId)).toMatchObject({ status: 'DEAD_LETTERED', attempts: 2, title: '', body: '', lastError: null });
      expect(f.state.notifications.has(outboxId)).toBe(false);
    } finally { release.resolve(); await old; }
    f.assertClosed();
    expect(f.handoffs).toHaveLength(0);
    expect(f.state.notifications.has(outboxId)).toBe(false);
    expect(f.state.outbox.get(outboxId)).toMatchObject({ status: 'DEAD_LETTERED', attempts: 2, title: '', body: '', lastError: null });
  });
  it('refuses a new handoff when recipient deletion commits during outside-lock preparation', async () => {
    const f = fixture(); const entered = deferred(); const release = deferred();
    f.pausePrepare(async () => { entered.resolve(); await release.promise; });
    const pending = f.make().deliverPendingNow(tenantId, [dedupeKey]); await arrived(entered.promise);
    try { await f.deleteRecipient(); } finally { release.resolve(); await pending; }
    f.assertClosed(); expect(f.handoffs).toHaveLength(0);
    expect(f.state.outbox.has(outboxId)).toBe(false); expect(f.state.notifications.has(outboxId)).toBe(false);
  });
  it('holds modeled recipient deletion through a new handoff and durable feed commit', async () => {
    const f = fixture(); const entered = deferred(); const release = deferred();
    f.pauseHandoff(async () => { entered.resolve(); await release.promise; });
    const pending = f.make().deliverPendingNow(tenantId, [dedupeKey]); await arrived(entered.promise);
    let deleted = false; const deletion = f.deleteRecipient().then(() => { deleted = true; });
    try {
      await Promise.resolve(); expect(deleted).toBe(false);
      expect(f.state.notifications.has(outboxId)).toBe(false); expect(f.handoffs).toHaveLength(0);
      expect(f.locks).toEqual(['tenant', 'user', 'outbox']);
    } finally { release.resolve(); await pending; await deletion; }
    f.assertClosed(); expect(f.handoffs).toHaveLength(1); expect(deleted).toBe(true);
    expect(f.state.outbox.has(outboxId)).toBe(false); expect(f.state.notifications.has(outboxId)).toBe(false);
  });
  for (const key of ['tenant', 'user', 'outbox']) {
    it(`postpones ${key} NOWAIT contention without spending a provider attempt`, async () => {
      const f = fixture(); f.contend(key); await f.make().deliverPendingNow(tenantId, [dedupeKey]);
      expect(f.state.outbox.get(outboxId)).toMatchObject({ status: 'FAILED', attempts: 1, failureCount: 0, leaseUntil: null, lastError: null });
      expect(f.handoffs).toHaveLength(0); expect(f.state.notifications.has(outboxId)).toBe(false);
      vi.setSystemTime(start.getTime() + 2_000); await (f.make() as any).sweep();
      expect(f.state.outbox.get(outboxId)).toMatchObject({ status: 'DELIVERED', attempts: 2, failureCount: 0 }); f.assertClosed();
    });
  }
  it('preserves the committed feed on terminal provider failure while scrubbing terminal outbox diagnostics', async () => {
    const f = fixture(); f.state.outbox.get(outboxId)!.attempts = 1; f.state.outbox.get(outboxId)!.failureCount = 1; f.failNextExternal();
    await f.make().deliverPendingNow(tenantId, [dedupeKey]);
    expect(f.state.notifications.get(outboxId)).toMatchObject({ readAt: null, tenantId, userId });
    expect(f.state.outbox.get(outboxId)).toMatchObject({ status: 'DEAD_LETTERED', attempts: 2, title: '', body: '', lastError: null });
    expect(f.handoffs).toHaveLength(1); expect(f.fanouts).toHaveLength(0); f.assertClosed();
  });
  for (const change of ['email', 'suspended', 'role', 'deleted', 'tenant-purged', 'tenant-deleted', 'suppressed'] as const) {
    it(`checks current ${change} after outside-lock preparation`, async () => {
      const f = fixture(); f.at('prepare', () => {
        if (change === 'email') f.state.user.email = 'changed@example.test';
        if (change === 'suspended') f.state.user.suspendedAt = start;
        if (change === 'role') f.state.user.role = 'ADMIN';
        if (change === 'deleted') { f.state.user.deletedAt = start; f.state.user.email = null; }
        if (change === 'tenant-purged') f.state.tenant.status = 'PURGED';
        if (change === 'tenant-deleted') f.state.tenant.deletedAt = start;
        if (change === 'suppressed') f.state.user.emailDeliverySuppressedAt = start;
      });
      await f.make().deliverPendingNow(tenantId, [dedupeKey]);
      expect(f.handoffs).toHaveLength(0);
      if (change === 'email') expect(f.state.outbox.get(outboxId)).toMatchObject({ status: 'FAILED', attempts: 1, failureCount: 0 });
      else if (change === 'suppressed') { expect(f.state.outbox.get(outboxId)?.status).toBe('DELIVERED'); expect(f.state.notifications.has(outboxId)).toBe(true); }
      else { expect(f.state.outbox.get(outboxId)?.status).toBe('DEAD_LETTERED'); expect(f.state.notifications.has(outboxId)).toBe(false); }
      f.assertClosed();
    });
  }
  for (const boundary of ['sql-budget', 'tenant-lock', 'user-lock', 'outbox-lock', 'clock:1', 'renew', 'clock:2', 'clock:3', 'feed', 'clock:4', 'provider-complete', 'clock:5', 'clock:6', 'transition', 'clock:7', 'clock:8']) {
    it(`refuses commit when finite bookkeeping time expires at ${boundary}`, async () => {
      const f = fixture(); f.at(boundary, () => f.setMono(40_001));
      await f.make().deliverPendingNow(tenantId, [dedupeKey]);
      expect(f.reached).toContain(boundary);
      expect(f.state.notifications.has(outboxId)).toBe(false);
      expect(f.state.outbox.get(outboxId)).toMatchObject({ status: 'PROCESSING', attempts: 1 });
      if (['provider-complete', 'clock:5', 'clock:6', 'transition', 'clock:7', 'clock:8'].includes(boundary)) expect(f.handoffs).toHaveLength(1);
      else expect(f.handoffs).toHaveLength(0);
      expect(f.fanouts).toHaveLength(0); f.assertClosed();
    });
  }
  for (const boundary of ['renew', 'feed', 'provider-complete', 'transition']) {
    it(`rolls back database effects when DB UTC held lease expires at ${boundary}`, async () => {
      const f = fixture(); f.at(boundary, () => vi.setSystemTime(start.getTime() + 45_000));
      await f.make().deliverPendingNow(tenantId, [dedupeKey]);
      expect(f.reached).toContain(boundary); expect(f.state.notifications.has(outboxId)).toBe(false);
      expect(f.state.outbox.get(outboxId)).toMatchObject({ status: 'PROCESSING', attempts: 1 });
      expect(f.fanouts).toHaveLength(0); f.assertClosed();
    });
  }
  for (const boundary of ['candidate', 'prepare', 'feed']) {
    it(`prevents NEW handoff after provider deadline at ${boundary} and preserves same-owned feed failure bookkeeping`, async () => {
      const f = fixture(); f.at(boundary, () => f.setMono(31_001));
      await f.make().deliverPendingNow(tenantId, [dedupeKey]);
      expect(f.reached).toContain(boundary); expect(f.handoffs).toHaveLength(0);
      expect(f.state.notifications.has(outboxId)).toBe(true);
      expect(f.state.outbox.get(outboxId)).toMatchObject({ status: 'FAILED', attempts: 1 }); f.assertClosed();
    });
  }
  it('refuses expired original lease before renewal or feed effects', async () => {
    const f = fixture(); f.at('prepare', () => vi.setSystemTime(start.getTime() + 5_000));
    await f.make().deliverPendingNow(tenantId, [dedupeKey]);
    expect(f.effects.map(x => x.kind)).toEqual(['claim']); expect(f.handoffs).toHaveLength(0); f.assertClosed();
  });

  it('keeps monotonically increasing claim generations and zero failure budget through repeated contention', async () => {
    const f = fixture();
    for (let generation = 1; generation <= 4; generation++) {
      f.contend('user'); await f.make().deliverPendingNow(tenantId, [dedupeKey]);
      expect(f.state.outbox.get(outboxId)).toMatchObject({ status: 'FAILED', attempts: generation, failureCount: 0 });
      vi.setSystemTime(start.getTime() + generation * 2_000);
    }
    f.failNextExternal(); await f.make().deliverPendingNow(tenantId, [dedupeKey]);
    expect(f.state.outbox.get(outboxId)).toMatchObject({ status: 'FAILED', attempts: 5, failureCount: 1 });
    expect(f.state.notifications.has(outboxId)).toBe(true);
    vi.setSystemTime(start.getTime() + 10_000); f.failNextExternal(); await (f.make() as any).sweep();
    expect(f.state.outbox.get(outboxId)).toMatchObject({ status: 'DEAD_LETTERED', attempts: 6, failureCount: 2, lastError: null });
    expect(f.handoffs).toHaveLength(2); f.assertClosed();
  });
  it('refuses stale original lease even when a manipulated row repeats the same generation', async () => {
    const f = fixture(); f.at('prepare', () => { f.state.outbox.get(outboxId)!.leaseUntil = new Date(start.getTime() + 6_000); });
    await f.make().deliverPendingNow(tenantId, [dedupeKey]);
    expect(f.state.outbox.get(outboxId)).toMatchObject({ status: 'PROCESSING', attempts: 1, failureCount: 0 });
    expect(f.handoffs).toHaveLength(0); expect(f.state.notifications.has(outboxId)).toBe(false); f.assertClosed();
  });
  it('refuses a stale claim after a changed generation even when a manipulated row repeats the original lease', async () => {
    const f = fixture(); f.at('prepare', () => { f.state.outbox.get(outboxId)!.attempts = 2; });
    await f.make().deliverPendingNow(tenantId, [dedupeKey]);
    expect(f.state.outbox.get(outboxId)).toMatchObject({ status: 'PROCESSING', attempts: 2, failureCount: 0 });
    expect(f.handoffs).toHaveLength(0); expect(f.state.notifications.has(outboxId)).toBe(false); f.assertClosed();
  });

  for (const expiry of ['monotonic', 'DB-lease']) {
    it(`rolls back feed and failure budget together on ${expiry} expiry after failed-provider budget effect`, async () => {
      const f = fixture(); f.failNextExternal(); f.at('failure-budget', () => {
        if (expiry === 'monotonic') f.setMono(40_001); else vi.setSystemTime(start.getTime() + 45_000);
      });
      await f.make().deliverPendingNow(tenantId, [dedupeKey]);
      expect(f.reached).toContain('failure-budget');
      expect(f.state.outbox.get(outboxId)).toMatchObject({ status: 'PROCESSING', attempts: 1, failureCount: 0 });
      expect(f.state.notifications.has(outboxId)).toBe(false); expect(f.handoffs).toHaveLength(1); f.assertClosed();
    });
  }

  it('preserves eligible durable feed and charges one failure when candidate preparation query rejects', async () => {
    const f = fixture(); f.failCandidate();
    await f.make().deliverPendingNow(tenantId, [dedupeKey]);
    expect(f.state.notifications.has(outboxId)).toBe(true);
    expect(f.state.outbox.get(outboxId)).toMatchObject({ status: 'FAILED', attempts: 1, failureCount: 1 });
    expect(f.handoffs).toHaveLength(0); f.assertClosed();
  });
  it('preserves eligible durable feed and charges one failure when candidate preparation query crosses provider deadline', async () => {
    const f = fixture(); const entered = deferred(); const release = deferred(); const finished = deferred();
    f.pauseEligibility(async () => { entered.resolve(); try { await release.promise; } finally { finished.resolve(); } });
    const pending = f.make(2, 1_000).deliverPendingNow(tenantId, [dedupeKey]);
    try {
      await arrived(entered.promise); await pending;
      expect(f.state.notifications.has(outboxId)).toBe(true);
      expect(f.state.outbox.get(outboxId)).toMatchObject({ status: 'FAILED', attempts: 1, failureCount: 1 });
      expect(f.handoffs).toHaveLength(0); f.assertClosed();
    } finally { release.resolve(); await finished.promise; await pending; }
  });
  it('refuses postponement when original same-generation lease has already expired', async () => {
    const f = fixture(); f.at('candidate', () => vi.setSystemTime(start.getTime() + 6_000)); f.contend('user');
    await f.make().deliverPendingNow(tenantId, [dedupeKey]);
    expect(f.state.outbox.get(outboxId)).toMatchObject({ status: 'PROCESSING', attempts: 1, failureCount: 0, leaseUntil: new Date(start.getTime() + 5_000) });
    expect(f.state.notifications.has(outboxId)).toBe(false); expect(f.handoffs).toHaveLength(0); f.assertClosed();
  });

  it('charges failed preparation even when its rejection reason is undefined', async () => {
    const f = fixture(); f.rejectPreparation(undefined); await f.make().deliverPendingNow(tenantId, [dedupeKey]);
    expect(f.state.outbox.get(outboxId)).toMatchObject({ status: 'FAILED', failureCount: 1 });
    expect(f.state.notifications.has(outboxId)).toBe(true); expect(f.handoffs).toHaveLength(0); f.assertClosed();
  });

});
