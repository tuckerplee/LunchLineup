import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsController } from '../../../api/src/settings/settings.controller';
import { TenantPrismaService } from '../../../api/src/database/tenant-prisma.service';
import { RbacService } from '../../../api/src/auth/rbac.service';
import { PayrollPolicyService } from '../../../api/src/payroll/payroll-policy.service';
import { PayrollService } from '../payroll/payroll.service';
import { WorkspaceSettingsService } from './settings.service';

type Row = Record<string, any>;
type Owner = 'native' | 'retained';
type Section = 'general' | 'team' | 'security';
type Axis = 'stored' | 'effective' | 'mfaWall' | 'mfaMonotonic';
type Effect = 'BusinessTenant' | 'Tenant' | 'TenantSetting' | 'Audit';
const monotonic = { now: 1000 };
const clone = <T>(value: T): T => structuredClone(value);
const deferred = () => { let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const flatten = (values: unknown[]): unknown[] => values.flatMap(value => value && typeof value === 'object'
  && 'values' in value ? flatten((value as { values: unknown[] }).values) : [value]);
const tenantId = 'generation-tenant', readerId = 'generation-payroll-reader', writerId = 'generation-settings-editor';
const identity = (id: string): any => ({ sub: id, tenantId, sessionId: id + '-session', role: 'ADMIN',
  legacyRole: 'ADMIN', roles: [], permissions: [id === writerId ? 'settings:write' : 'payroll:policy_write'],
  publicUserId: id === readerId ? '560bb8a3-e716-4813-b224-bdba666a91af' : '560bb8a3-e716-4813-b224-bdba666a91b0',
  pinResetRequired: false, mfaRequired: true, mfaVerified: true });
const policy = { timeZone: 'America/Los_Angeles', cadence: 'WEEKLY' as const,
  anchorDate: '2026-09-28', effectiveFrom: '2026-09-28' };

// Explicit, bounded MVCC model: the transaction's first context/timeout SELECT
// captures committed policy. An unchanged locked Tenant tuple does not refresh
// that snapshot. A real scoped parent UPDATE commits a new tuple version; a
// waiting Serializable reader gets 40001/P2034 and must retry with fresh policy.
// This is documented-semantics modeling, not PostgreSQL/SSI/RLS/lock proof.
function model(writerOwner: Owner, readerOwner: Owner) {
  const users = [readerId, writerId].map(id => ({ id, tenantId, publicId: identity(id).publicUserId,
    role: 'ADMIN', name: id, email: null, username: id, deletedAt: null, suspendedAt: null,
    lockedUntil: null, pinLockedUntil: null, pinResetRequired: false, mfaEnabled: false }));
  const sessions = users.map(user => ({ id: user.id + '-session', userId: user.id,
    createdAt: new Date(Date.now() - (user.id === readerId ? 10 : 1) * 60_000),
    expiresAt: new Date(Date.now() + 3_600_000), revokedAt: null }));
  const roles = users.map(user => ({ id: user.id + '-role', tenantId, publicId: user.publicId,
    name: user.id, slug: user.id, isSystem: false, isDefault: false, legacyRole: null,
    description: null, deletedAt: null,
    rolePermissions: [{ permission: { key: user.id === readerId ? 'payroll:policy_write' : 'settings:write' } }] }));
  const state: { tenant: Row; tenantVersion: number; value: Row; policies: Row[]; audits: Row[] } = {
    tenant: { id: tenantId, name: 'Generation workspace', slug: 'generation-workspace',
    status: 'ACTIVE', deletedAt: null, updatedAt: new Date() }, tenantVersion: 0,
    value: { general: { timezone: 'America/Los_Angeles' }, team: {},
      security: { sessionTimeoutMinutes: 60, requireMfaForAll: false, ssoOidcOnly: false, oidcIssuerUrl: null } },
    policies: [] as Row[], audits: [] as Row[] };
  const controls = { armed: false, writerHolding: false, readerBlocked: false,
    pauseEffect: undefined as Effect | undefined, effectPaused: false,
    failEffect: undefined as Effect | undefined, fenceCount: 1 as unknown,
    shortProof: false, pausePreflight: false, preflightPaused: false,
    rawObservation: null as Row | null, overrideObservation: {} as Row };
  const readerObserved = deferred(), readerObservationRelease = deferred();
  const writerAtPersist = deferred(), writerPersistRelease = deferred();
  const readerAtTenant = deferred(), readerTenantRelease = deferred();
  const effectEntered = deferred(), effectRelease = deferred();
  const noopEntered = deferred(), noopRelease = deferred();
  const preflightEntered = deferred(), preflightRelease = deferred();
  const active = new Set<number>(); let ordinal = 0;
  const attempted: Row[] = [], committed: Row[] = [], transactions: Row[] = [], observed: Row[] = [];
  const observer = { observeSessionMfa: vi.fn(async (actor: Row) => {
    expect(actor).toEqual({ sub: actor.sub, tenantId, sessionId: actor.sub + '-session' });
    expect(users.some(user => user.id === actor.sub)).toBe(true);
    // The caller's DB scope must be released; a distinct concurrent writer may
    // retain its own scope, so a global activeTx===0 oracle would be false.
    expect(transactions.filter(tx => tx.actor === actor.sub && active.has(tx.ordinal))).toEqual([]);
    const observation = { ...actor, expiresAtEpochMs: Date.now() + (controls.shortProof ? 1000 : 120_000),
      expiresAtMonotonicMs: performance.now() + (controls.shortProof ? 1000 : 120_000) };
    Object.assign(observation, controls.overrideObservation);
    if (actor.sub === writerId) controls.rawObservation = observation;
    observed.push(clone(observation));
    if (controls.armed && actor.sub === readerId) {
      readerObserved.release(); await readerObservationRelease.promise;
    }
    return observation;
  }) };
  const transaction = async (operation: (tx: any) => Promise<any>, options?: Row) => {
    const number = ++ordinal;
    const snapshot = clone(state); const pending: Row[] = [];
    const record: Row = { ordinal: number, isolation: options?.isolationLevel ?? 'ReadCommitted',
      snapshotTenantVersion: snapshot.tenantVersion, snapshotTimeout: snapshot.value.security.sessionTimeoutMinutes,
      actor: null, outcome: 'running' };
    transactions.push(record); active.add(number);
    const view = () => record.isolation === 'Serializable' ? snapshot : state;
    const effect = (kind: string, data: Row) => { const item = { ordinal: number, actor: record.actor, kind, data: clone(data) };
      attempted.push(item); pending.push(item); };
    const completedEffect = async (kind: Effect, data: Row) => {
      effect(kind, data);
      if (controls.pauseEffect === kind && !controls.effectPaused) {
        controls.effectPaused = true; effectEntered.release(); await effectRelease.promise;
      }
      if (controls.failEffect === kind) throw new Error('Modeled awaited failure: ' + kind);
    };
    const userFor = (id: string) => { expect([readerId, writerId]).toContain(id); record.actor = id;
      return clone(users.find(user => user.id === id)!); };
    const sqlParts = (sql: any, bound: unknown[]) => ({ text: (Array.isArray(sql) ? sql : sql.strings).join(''),
      values: flatten(Array.isArray(sql) ? bound : sql.values) });
    const tx: any = {
      $queryRaw: async (sql: any, ...bound: unknown[]) => {
        const { text, values } = sqlParts(sql, bound);
        if (text.includes('set_config')) {
          expect(text).toContain("'lock_timeout'"); expect(text).toContain("'statement_timeout'"); return [{}];
        }
        expect(text).toContain('FOR UPDATE');
        if (text.includes('FROM "Tenant"')) {
          expect(values).toEqual([tenantId]);
          if (controls.pausePreflight && !controls.preflightPaused) {
            controls.preflightPaused = true; preflightEntered.release(); await preflightRelease.promise;
          }
          if (controls.writerHolding && controls.armed && !controls.readerBlocked) {
            expect(record.isolation).toBe('Serializable'); controls.readerBlocked = true;
            record.waitedTenant = true; readerAtTenant.release(); await readerTenantRelease.promise;
            if (state.tenantVersion !== snapshot.tenantVersion) {
              record.serializationConflict = true;
              throw Object.assign(new Error('Modeled concurrent Tenant tuple update'), { code: 'P2034' });
            }
          }
          return [{ id: tenantId }];
        }
        if (text.includes('FROM "User"')) { expect(values[0]).toBe(tenantId); expect(values).toHaveLength(2);
          return [userFor(values[1] as string)]; }
        if (text.includes('FROM "Session"')) { expect(values).toEqual([record.actor + '-session', record.actor]);
          return [clone(sessions.find(session => session.userId === record.actor)!)]; }
        if (text.includes('FROM "RoleAssignment"')) { expect(values).toEqual([tenantId, record.actor]);
          return [{ userId: record.actor, roleId: record.actor + '-role' }]; }
        if (text.includes('FROM "RolePermission"')) { expect(values).toEqual([record.actor + '-role']);
          return [{ roleId: record.actor + '-role', permissionId: record.actor + '-permission' }]; }
        if (text.includes('FROM "Role"')) { expect(values).toEqual([tenantId, record.actor + '-role']);
          return [{ id: record.actor + '-role' }]; }
        throw new Error('Unmodeled raw read: ' + text);
      },
      $executeRaw: async (sql: any, ...bound: unknown[]) => {
        const { text, values } = sqlParts(sql, bound);
        if (text.includes('set_current_tenant')) { expect(values).toEqual([tenantId]); return 1; }
        if (text.trim().startsWith('UPDATE')) {
          expect(text.replace(/\s+/g, ' ').trim()).toBe('UPDATE "Tenant" SET "updatedAt" = "updatedAt" WHERE "id" =');
          expect(values).toEqual([tenantId]); expect(record.actor).toBe(writerId);
          await completedEffect('Tenant', { updatedAt: clone(view().tenant.updatedAt) }); return controls.fenceCount;
        }
        expect(text).toContain('pg_advisory_xact_lock'); expect(values).toEqual(['lunchlineup:payroll:' + tenantId]); return 1;
      },
      tenant: {
        findUnique: async ({ where }: Row) => { expect(where).toEqual({ id: tenantId }); return clone(view().tenant); },
        findUniqueOrThrow: async ({ where }: Row) => { expect(where).toEqual({ id: tenantId }); return clone(view().tenant); },
        update: async ({ where, data }: Row) => { expect(where).toEqual({ id: tenantId });
          expect(record.actor).toBe(writerId); expect(data).toEqual({ name: 'Renamed workspace' });
          await completedEffect('BusinessTenant', data); return { ...clone(view().tenant), ...clone(data) }; },
      },
      user: {
        findFirst: async ({ where }: Row) => { expect(where.tenantId).toBe(tenantId); expect(where.deletedAt).toBeNull();
          expect(where.suspendedAt).toBeNull(); return userFor(where.id); },
        findMany: async (args: Row) => { expect(args).toEqual({ where: { tenantId, id: { in: [readerId] } },
          select: { id: true, publicId: true } }); return [{ id: readerId, publicId: identity(readerId).publicUserId }]; },
      },
      session: { findFirst: async ({ where }: Row) => { expect(where).toEqual({ id: record.actor + '-session', userId: record.actor });
        return clone(sessions.find(session => session.userId === record.actor)!); } },
      tenantSetting: {
        findUnique: async ({ where }: Row) => { expect(where).toEqual({ tenantId_key: { tenantId, key: 'workspace_settings' } });
          record.policyReads = (record.policyReads ?? 0) + 1; return { value: clone(view().value) }; },
        upsert: async ({ where, create, update }: Row) => {
          expect(where).toEqual({ tenantId_key: { tenantId, key: 'workspace_settings' } });
          expect(create).toMatchObject({ tenantId, key: 'workspace_settings' }); expect(create.value).toEqual(update.value);
          expect(record.actor).toBe(writerId);
          if (controls.armed) { controls.writerHolding = true; writerAtPersist.release(); await writerPersistRelease.promise; }
          await completedEffect('TenantSetting', update.value); return { tenantId, key: 'workspace_settings', value: clone(update.value) };
        },
      },
      roleAssignment: { findMany: async (args: Row) => {
        expect(args.where.tenantId).toBe(tenantId); expect(args.orderBy).toEqual([{ userId: 'asc' }, { roleId: 'asc' }]);
        if (args.where.userId?.in) expect(args.where.userId.in).toEqual([record.actor]);
        else expect(args.where.userId).toBe(record.actor);
        const role = clone(roles.find(row => row.id === record.actor + '-role')!);
        return [{ tenantId, userId: record.actor, roleId: role.id, ...(args.include ? { role } : {}) }];
      } },
      role: { findMany: async ({ where }: Row) => { expect(where).toEqual({ tenantId, id: { in: [record.actor + '-role'] }, deletedAt: null });
        return [clone(roles.find(row => row.id === record.actor + '-role')!)]; } },
      payrollPolicyVersion: {
        findUnique: async ({ where }: Row) => { expect(Object.keys(where)).toEqual(['operationId']);
          return clone(view().policies.find(row => row.operationId === where.operationId) ?? null); },
        findFirst: async (args: Row) => { expect(args.where).toEqual({ tenantId });
          expect(args.orderBy).toEqual([{ version: 'desc' }, { [readerOwner === 'native' ? 'publicId' : 'id']: 'desc' }]);
          return clone(view().policies.at(-1) ?? null); },
        create: async ({ data }: Row) => { expect(record.actor).toBe(readerId);
          expect(data).toMatchObject({ tenantId, createdByUserId: readerId, version: 1 });
          const row = { ...clone(data), id: 'generation-policy', publicId: '560bb8a3-e716-4813-b224-bdba666a91b1', createdAt: new Date() };
          effect('PayrollPolicy', row); return clone(row); },
      },
      auditLog: { create: async ({ data }: Row) => { expect(data.tenantId).toBe(tenantId);
        expect(data.actorUserId).toBe(record.actor); await completedEffect('Audit', data); return clone(data); } },
    };
    try {
      const result = await operation(tx);
      // Merge only the actual staged effects, never a stale whole-state clone.
      for (const item of pending) {
        if (item.kind === 'Tenant' || item.kind === 'BusinessTenant') { Object.assign(state.tenant, item.data); state.tenantVersion++; }
        else if (item.kind === 'TenantSetting') state.value = clone(item.data);
        else if (item.kind === 'PayrollPolicy') state.policies.push(clone(item.data));
        else if (item.kind === 'Audit') state.audits.push(clone(item.data));
        else throw new Error('Unmodeled commit effect');
      }
      committed.push(...pending); record.outcome = 'committed'; return result;
    } catch (error) { record.outcome = 'rolled-back'; throw error; }
    finally { active.delete(number); }
  };
  const legacyDb = new TenantPrismaService({ $transaction: transaction } as never);
  const rbac = new RbacService(legacyDb);
  const nativeDb: any = { withTenant: async (selected: string, callback: any, options?: Row) => {
    expect(selected).toBe(tenantId); return transaction(callback, options);
  } };
  const nativeSettings = new WorkspaceSettingsService(nativeDb, { oidcSsoAvailable: false }, observer as never);
  const retainedSettings = new SettingsController(legacyDb, rbac, observer as never);
  const nativePayroll = new PayrollService(nativeDb, observer as never);
  const retainedPayroll = new PayrollPolicyService(legacyDb, rbac, observer as never);
  const create = () => readerOwner === 'native'
    ? nativePayroll.createPolicy(identity(readerId), policy, 'generation-policy-key')
    : retainedPayroll.create({ userId: readerId, tenantId, sessionId: readerId + '-session' }, policy, 'generation-policy-key');
  const write = (shorten: boolean) => {
    const body = { sessionTimeoutMinutes: shorten ? 5 : 60, requireMfaForAll: shorten };
    return writerOwner === 'native' ? nativeSettings.updateSecurity(identity(writerId), body)
      : retainedSettings.updateSecurity(body, { user: identity(writerId) });
  };
  const section = (selected: Section, noChange = false) => {
    if (selected === 'security') return write(!noChange);
    if (writerOwner === 'native') return selected === 'general'
      ? nativeSettings.updateGeneral(identity(writerId), { name: 'Renamed workspace' })
      : nativeSettings.updateTeam(identity(writerId), { defaultInviteRole: 'MANAGER' });
    return selected === 'general' ? retainedSettings.updateGeneral({ name: 'Renamed workspace' }, { user: identity(writerId) })
      : retainedSettings.updateTeam({ defaultInviteRole: 'MANAGER' }, { user: identity(writerId) });
  };
  const noop = () => writerOwner === 'native'
    ? (nativeSettings as any).write(identity(writerId), async (_tx: any, current: any) => {
      noopEntered.release(); await noopRelease.promise; return current;
    }) : (retainedSettings as any).writeSettings(identity(writerId), async (_tx: any, current: any) => {
      noopEntered.release(); await noopRelease.promise; return current;
    });
  const deadline = (axis: Axis) => {
    const session = sessions.find(row => row.userId === writerId)!;
    if (axis === 'stored') session.expiresAt = new Date(Date.now() + 1000);
    if (axis === 'effective') session.createdAt = new Date(Date.now() - 60 * 60_000 + 1000);
    controls.shortProof = axis === 'mfaWall' || axis === 'mfaMonotonic';
  };
  return { state, controls, attempted, committed, transactions, observed, observer, create, write,
    section, noop, deadline, sessions, effectEntered, effectRelease, noopEntered, noopRelease, preflightEntered, preflightRelease,
    readerObserved, readerObservationRelease, writerAtPersist, writerPersistRelease, readerAtTenant, readerTenantRelease };
}

async function overlap(f: ReturnType<typeof model>, shorten: boolean) {
  f.controls.armed = true;
  const reader = f.create().then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  let writer: Promise<unknown> | undefined;
  try {
    expect(await Promise.race([f.readerObserved.promise.then(() => 'entered'), reader.then(() => 'settled')])).toBe('entered');
    writer = f.write(shorten);
    expect(await Promise.race([f.writerAtPersist.promise.then(() => 'entered'), writer.then(() => 'settled')])).toBe('entered');
    f.readerObservationRelease.release();
    expect(await Promise.race([f.readerAtTenant.promise.then(() => 'entered'), reader.then(() => 'settled')])).toBe('entered');
    f.writerPersistRelease.release(); await writer; f.controls.writerHolding = false;
    f.readerTenantRelease.release(); return await reader;
  } finally {
    f.readerObservationRelease.release(); f.writerPersistRelease.release(); f.readerTenantRelease.release();
    await writer?.catch(() => {}); await reader;
  }
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-04T20:00:00Z'));
  monotonic.now = 1000; vi.spyOn(performance, 'now').mockImplementation(() => monotonic.now); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('actual Settings writers fence old Serializable payroll policy snapshots', () => {
  for (const writer of ['native', 'retained'] as const) for (const reader of ['native', 'retained'] as const) {
    for (const replay of [false, true]) {
      it(`${writer} writer ${reader} payroll ${replay ? 'replay' : 'create'} refuses shorter policy committed during unchanged Tenant wait`, async () => {
        const f = model(writer, reader); if (replay) await f.create();
        const originalPolicies = clone(f.state.policies), originalAudits = clone(f.state.audits);
        f.attempted.length = 0; f.committed.length = 0; f.observed.length = 0; f.observer.observeSessionMfa.mockClear();
        const result = await overlap(f, true);
        expect(f.state.value.security).toMatchObject({ sessionTimeoutMinutes: 5, requireMfaForAll: true });
        expect(f.committed.filter(row => row.actor === writerId).map(row => row.kind)).toContain('TenantSetting');
        expect(result.error ? (result.error.status ?? result.error.getStatus?.()) : undefined,
          JSON.stringify({ tenantVersion: f.state.tenantVersion, currentTimeout: f.state.value.security.sessionTimeoutMinutes,
            blocked: f.transactions.find(row => row.waitedTenant), readerReturnedSuccess: result.error === undefined,
            readerEffects: f.committed.filter(row => row.actor === readerId).map(row => row.kind) })).toBe(403);
        expect(result.value).toBeUndefined();
        expect(f.state.policies).toEqual(originalPolicies);
        expect(f.state.audits.filter(row => row.actorUserId === readerId)).toEqual(originalAudits.filter(row => row.actorUserId === readerId));
        expect(f.committed.filter(row => row.actor === readerId)).toEqual([]);
        expect(f.observed.filter(row => row.sub === readerId)).toHaveLength(1);
        const blocked = f.transactions.find(row => row.waitedTenant)!;
        expect(blocked.snapshotTimeout).toBe(60); expect(blocked.serializationConflict).toBe(true);
        expect(f.transactions.some(row => row.ordinal > blocked.ordinal && row.snapshotTimeout === 5)).toBe(true);
      });
      it(`${writer} writer ${reader} payroll ${replay ? 'replay' : 'create'} preserves valid unchanged-policy control`, async () => {
        const f = model(writer, reader); const original = replay ? await f.create() : undefined;
        const policyCount = f.state.policies.length; f.committed.length = 0;
        const result = await overlap(f, false);
        expect(result.error).toBeUndefined(); expect(result.value).toMatchObject({ version: 1, ...policy });
        if (replay) expect(result.value).toEqual(original);
        expect(f.state.policies).toHaveLength(policyCount + (replay ? 0 : 1));
        expect(f.committed.filter(row => row.kind === 'PayrollPolicy')).toHaveLength(replay ? 0 : 1);
        expect(f.transactions.find(row => row.waitedTenant)?.snapshotTimeout).toBe(60);
        expect(f.state.value.security.sessionTimeoutMinutes).toBe(60);
      });
    }
  }
});

const effects: Record<Section, Effect[]> = { general: ['BusinessTenant', 'Tenant', 'TenantSetting'],
  team: ['Tenant', 'TenantSetting'], security: ['Tenant', 'TenantSetting', 'Audit'] };
const axes: Axis[] = ['stored', 'effective', 'mfaWall', 'mfaMonotonic'];
const advance = (axis: Axis) => {
  if (axis === 'mfaMonotonic') monotonic.now += 1001;
  else vi.setSystemTime(new Date(Date.now() + 1001));
};
const status = (error: any) => error?.status ?? error?.getStatus?.();
async function afterEffect(f: ReturnType<typeof model>, section: Section, change: () => void, noChange = false) {
  const pending = f.section(section, noChange).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  try {
    expect(await Promise.race([f.effectEntered.promise.then(() => 'entered'), pending.then(() => 'settled')])).toBe('entered');
    change(); f.effectRelease.release(); return await pending;
  } finally { f.effectRelease.release(); await pending; }
}

describe('Settings original finite authorization across every reached effect', () => {
  for (const owner of ['native', 'retained'] as const) {
    for (const section of ['general', 'team', 'security'] as const) {
      it(`${owner} ${section} commits one scoped metadata-neutral fence and preserves original policy and business control`, async () => {
        const f = model(owner, 'native'); const original = clone(f.state.tenant);
        const result = await f.section(section);
        expect(result).toBeDefined(); expect(f.committed.filter(row => row.kind === 'Tenant')).toHaveLength(1);
        expect(f.state.tenant.updatedAt).toEqual(original.updatedAt);
        expect(f.state.tenant.name).toBe(section === 'general' ? 'Renamed workspace' : original.name);
        expect(f.committed.map(row => row.kind)).toEqual(effects[section]);
        expect(f.observed).toHaveLength(1);
      });
      for (const effect of effects[section]) for (const axis of axes) {
        it(`${owner} ${section} rolls back ${axis} expiry at ${effect} completion with exact attempted prefix`, async () => {
          const f = model(owner, 'native'); f.deadline(axis); f.controls.pauseEffect = effect;
          const original = clone(f.state); const result = await afterEffect(f, section, () => advance(axis));
          expect(status(result.error)).toBe(403); expect(result.value).toBeUndefined();
          expect(f.attempted.map(row => row.kind)).toEqual(effects[section].slice(0, effects[section].indexOf(effect) + 1));
          expect(f.committed).toEqual([]); expect(f.state).toEqual(original); expect(f.observed).toHaveLength(1);
        });
      }
    }
    for (const axis of axes) {
      it(`${owner} awaited readonly no-op final callback refuses ${axis} expiry without effects`, async () => {
        const f = model(owner, 'native'); f.deadline(axis); const original = clone(f.state);
        const pending = f.noop().then((value: any) => ({ value, error: undefined }), (error: any) => ({ value: undefined, error }));
        try {
          expect(await Promise.race([f.noopEntered.promise.then(() => 'entered'), pending.then(() => 'settled')])).toBe('entered');
          advance(axis); f.noopRelease.release(); const result = await pending;
          expect(status(result.error)).toBe(403); expect(result.value).toBeUndefined();
          expect(f.attempted).toEqual([]); expect(f.committed).toEqual([]); expect(f.state).toEqual(original);
        } finally { f.noopRelease.release(); await pending; }
      });
      it(`${owner} unchanged security save rolls back ${axis} expiry after upsert without manufacturing audit`, async () => {
        const f = model(owner, 'native'); f.deadline(axis); f.controls.pauseEffect = 'TenantSetting';
        const original = clone(f.state); const result = await afterEffect(f, 'security', () => advance(axis), true);
        expect(status(result.error)).toBe(403); expect(f.attempted.map(row => row.kind)).toEqual(['Tenant', 'TenantSetting']);
        expect(f.committed).toEqual([]); expect(f.state).toEqual(original);
      });
    }
    for (const effect of ['Tenant', 'TenantSetting', 'Audit'] as const) {
      it(`${owner} security ${effect} failure rolls back parent fence, child policy and audit`, async () => {
        const f = model(owner, 'native'); f.controls.failEffect = effect; const original = clone(f.state);
        await expect(f.section('security')).rejects.toThrow('Modeled awaited failure: ' + effect);
        expect(f.attempted.map(row => row.kind)).toEqual(effects.security.slice(0, effects.security.indexOf(effect) + 1));
        expect(f.committed).toEqual([]); expect(f.state).toEqual(original);
      });
    }
    for (const count of [0, 2, NaN, undefined]) {
      it(`${owner} malformed parent affected count ${String(count)} refuses policy and audit writes`, async () => {
        const f = model(owner, 'native'); f.controls.fenceCount = count; const original = clone(f.state);
        const error = await f.section('security').then(() => undefined, error => error);
        expect(status(error)).toBe(503); expect(f.attempted.map(row => row.kind)).toEqual(['Tenant']);
        expect(f.committed).toEqual([]); expect(f.state).toEqual(original);
      });
    }
    it(`${owner} shortening may expire its own ten-minute-old session under new policy without changing original save authority`, async () => {
      const f = model(owner, 'native'); f.sessions.find(row => row.userId === writerId)!.createdAt = new Date(Date.now() - 10 * 60_000);
      const result = await f.write(true);
      expect(result.security.sessionTimeoutMinutes).toBe(5); expect(f.committed.map(row => row.kind)).toEqual(effects.security);
    });
    for (const axis of ['mfaWall', 'mfaMonotonic'] as const) it(`${owner} mutable observed proof cannot renew original ${axis} deadline during parent await`, async () => {
      const f = model(owner, 'native'); f.controls.shortProof = true; f.controls.pauseEffect = 'Tenant'; const original = clone(f.state);
      const result = await afterEffect(f, 'security', () => {
        advance(axis);
        f.controls.rawObservation!.expiresAtEpochMs = Date.now() + 120_000;
        f.controls.rawObservation!.expiresAtMonotonicMs = performance.now() + 120_000;
      });
      expect(status(result.error)).toBe(403); expect(f.state).toEqual(original); expect(f.committed).toEqual([]);
    });
    for (const [label, fields] of [
      ['NaN wall', { expiresAtEpochMs: NaN }], ['infinite wall', { expiresAtEpochMs: Infinity }],
      ['fractional wall', { expiresAtEpochMs: Date.parse('2026-10-04T20:00:00Z') + 1000.5,
        expiresAtMonotonicMs: 3000 }],
      ['NaN monotonic', { expiresAtMonotonicMs: NaN }], ['infinite monotonic', { expiresAtMonotonicMs: Infinity }],
      ['wrong actor', { sub: readerId }], ['wrong tenant', { tenantId: 'another-tenant' }],
      ['wrong session', { sessionId: readerId + '-session' }],
    ] as const) {
      it(`${owner} rejects ${label} observed proof before any final effect`, async () => {
        const f = model(owner, 'native'); f.controls.overrideObservation = fields;
        if (label === 'fractional wall') {
          expect(f.controls.overrideObservation.expiresAtEpochMs).toBeGreaterThan(Date.now());
          expect(Number.isSafeInteger(f.controls.overrideObservation.expiresAtEpochMs)).toBe(false);
          expect(Number.isFinite(f.controls.overrideObservation.expiresAtMonotonicMs)).toBe(true);
          expect(f.controls.overrideObservation.expiresAtMonotonicMs).toBeGreaterThan(performance.now());
        }
        const original = clone(f.state), error = await f.write(true).then(() => undefined, error => error);
        expect(status(error)).toBe(403); expect(f.attempted).toEqual([]); expect(f.committed).toEqual([]); expect(f.state).toEqual(original);
      });
    }
    it(`${owner} failed business Tenant rename rolls back without fence or policy effects`, async () => {
      const f = model(owner, 'native'); f.controls.failEffect = 'BusinessTenant'; const original = clone(f.state);
      await expect(f.section('general')).rejects.toThrow('Modeled awaited failure: BusinessTenant');
      expect(f.attempted.map(row => row.kind)).toEqual(['BusinessTenant']); expect(f.committed).toEqual([]); expect(f.state).toEqual(original);
    });
    it(`${owner} mutation of returned proof identity cannot replace the copied canonical original observation`, async () => {
      const f = model(owner, 'native'); f.controls.pauseEffect = 'Tenant';
      const result = await afterEffect(f, 'security', () => { f.controls.rawObservation!.sub = readerId; });
      expect(result.error).toBeUndefined(); expect(f.committed.map(row => row.kind)).toEqual(effects.security);
    });
    it(`${owner} observer method captured before preflight cannot be replaced across the first Tenant wait`, async () => {
      const f = model(owner, 'native'); f.controls.pausePreflight = true;
      const originalObserve = f.observer.observeSessionMfa; const replacement = vi.fn(async () => null);
      const pending = f.write(true);
      try {
        expect(await Promise.race([f.preflightEntered.promise.then(() => 'entered'), pending.then(() => 'settled')])).toBe('entered');
        f.observer.observeSessionMfa = replacement as any; f.preflightRelease.release(); await pending;
        expect(originalObserve).toHaveBeenCalledOnce(); expect(replacement).not.toHaveBeenCalled();
      } finally { f.preflightRelease.release(); await pending; }
    });
  }
});
