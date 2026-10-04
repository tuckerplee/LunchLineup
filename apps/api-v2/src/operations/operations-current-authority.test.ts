import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionIdentity } from '@lunchlineup/api-contract';
import { authorizeCurrentMutation, assertCurrentMutation } from '../people/mutation-authority';
import { PRIVILEGED_MFA_PERMISSION_KEYS, type MfaSessionIdentity } from '@lunchlineup/rbac';
import { isOperationsReceiptRecovery, OperationsService } from './operations.service';
import { LunchBreakService } from './lunch-breaks.service';
import { registerOperationsRoutes } from './routes';
import { registerSchedulingRoutes } from '../scheduling/routes';

type Row = Record<string, any>;
const tenantId = 'operations-authority-tenant', actorId = 'operations-authority-actor';
const sessionId = 'operations-authority-exact-session', roleId = 'operations-authority-role';
const actorPublicId = '81000000-0000-4000-8000-000000000001';
const locationPublicId = '81000000-0000-4000-8000-000000000002';
const shiftPublicId = '81000000-0000-4000-8000-000000000003';
const schedulePublicId = '81000000-0000-4000-8000-000000000004';
const createdShiftPublicId = '81000000-0000-4000-8000-000000000005';
const rolePublicId = '81000000-0000-4000-8000-000000000006';
const now = '2026-10-05T20:00:00.000Z', key = 'operations-current-authority-baseline';
const permissions = ['schedules:read', 'shifts:read', 'shifts:write', 'lunch_breaks:read', 'lunch_breaks:write'];
const identity: SessionIdentity = { sub: actorId, tenantId, publicUserId: actorPublicId, sessionId,
  role: 'Manager', legacyRole: 'MANAGER', roles: [{ id: rolePublicId, name: 'Manager', isSystem: true,
    legacyRole: 'MANAGER' }], permissions, pinResetRequired: false, mfaRequired: true, mfaVerified: true };
const clone = <T>(value: T): T => structuredClone(value);
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const deferred = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release }; };
const actions = [
  { id: 'listScheduleSummaries', method: 'GET', path: '/v2/schedules', permission: 'schedules:read' },
  { id: 'listShiftSummaries', method: 'GET', path: '/v2/shifts', permission: 'shifts:read' },
  { id: 'listStaffRoster', method: 'GET', path: '/v2/shifts/staff-roster', permission: 'shifts:read' },
  { id: 'listLunchBreakRows', method: 'GET', path: '/v2/lunch-breaks', permission: 'lunch_breaks:read' },
  { id: 'getLunchBreakPolicy', method: 'GET', path: '/v2/lunch-breaks/policy', permission: 'lunch_breaks:read' },
  { id: 'updateLunchBreakPolicy', method: 'PUT', path: '/v2/lunch-breaks/policy', permission: 'lunch_breaks:write' },
  { id: 'generateLunchBreakPlan', method: 'POST', path: '/v2/lunch-breaks/generate', permission: 'lunch_breaks:write' },
  { id: 'importLunchBreakShifts', method: 'POST', path: '/v2/lunch-breaks/setup-shifts', permission: 'lunch_breaks:write' },
  { id: 'updateShiftBreakPlan', method: 'PUT', path: '/v2/lunch-breaks/shift/:shiftId', permission: 'lunch_breaks:write' },
  { id: 'generateScheduleBreaks', method: 'POST', path: '/v2/break-generations', permission: 'lunch_breaks:write' },
] as const;
type Action = typeof actions[number];

/** Explicit scoped row selectors and staged effects, not a blanket ORM proxy or
 * mocked authorization decision. The route handlers and domain/credit owners
 * are actual functions; Fastify registration is captured without a server.
 * This model does not execute PostgreSQL locks/SSI/RLS/triggers or Redis. */
async function fixture(action: Action) {
  const tenant: Row = { id: tenantId, deletedAt: null, status: 'ACTIVE', planTier: 'GROWTH',
    stripeSubscriptionId: 'sub_controlled_operations', stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00Z'),
    trialEndsAt: null, usageCredits: 5, creditDebt: 0 };
  const actor: Row = { id: actorId, publicId: actorPublicId, tenantId, role: 'MANAGER', name: 'Current manager',
    username: 'current-manager', email: null, deletedAt: null, suspendedAt: null, lockedUntil: null,
    pinLockedUntil: null, pinResetRequired: false, mfaEnabled: true };
  const role: Row = { id: roleId, publicId: rolePublicId, tenantId, name: 'Manager', slug: 'manager',
    description: null, isSystem: true, isDefault: false, legacyRole: 'MANAGER', deletedAt: null,
    rolePermissions: permissions.map(key => ({ permission: { key } })) };
  const location: Row = { id: 'operations-location', publicId: locationPublicId, tenantId, deletedAt: null };
  const schedule: Row = { id: 'operations-schedule', publicId: schedulePublicId, tenantId,
    location: { publicId: locationPublicId }, deletedAt: null, status: 'DRAFT', revision: 3, publishedAt: null,
    startDate: new Date('2026-10-05T00:00:00Z'), endDate: new Date('2026-10-06T00:00:00Z') };
  const initialShift: Row = { id: 'operations-shift', publicId: shiftPublicId, tenantId, locationId: location.id,
    location: { publicId: locationPublicId }, userId: actorId, user: { id: actorId, publicId: actorPublicId,
      name: actor.name, role: 'MANAGER' }, scheduleId: schedule.id, schedule: clone(schedule), deletedAt: null,
    role: null, startTime: new Date('2026-10-05T08:00:00Z'), endTime: new Date('2026-10-05T16:00:00Z'),
    updatedAt: new Date('2026-10-05T07:00:00Z'), breaks: [{ id: 'operations-break', type: 'LUNCH',
      startTime: new Date('2026-10-05T12:00:00Z'), endTime: new Date('2026-10-05T12:30:00Z'), paid: false }] };
  const state = { tenant, actor, role, location, assignmentEnabled: true,
    session: { id: sessionId, userId: actorId, createdAt: new Date('2026-10-05T19:56:00Z'),
      expiresAt: new Date('2026-10-05T21:00:00Z'), revokedAt: null as Date | null },
    security: { security: { requireMfaForAll: true, sessionTimeoutMinutes: 5 } },
    domain: { wallet: 5, policy: null as Row | null, shifts: [initialShift], schedule,
      credits: [] as Row[], audits: [] as Row[], generations: [] as Row[] } };
  const entered = deferred(), released = deferred();
  const hooks: { context?: (ordinal: number) => void | Promise<void>; observed?: (selected: MfaSessionIdentity) => void | Promise<void>;
    completion?: (entry: Row) => void | Promise<void>; commit?: (entry: Row) => void } = {};
  let observation: Row | null | undefined;
  const completions: Row[] = [];
  const pendingWriters: Array<() => void> = [], writerRecords: Row[] = [];
  const control = { armed: false, reached: false, ordinal: 1,
    phase: 'contextOrdinal' as 'contextOrdinal' | 'postCommittedClaim',
    mode: 'none' as 'none' | 'revoked' | 'effective-expiry' };
  const active = new Set<number>(), sessionFences = new Set<number>(), userFences = new Set<number>();
  const attempted: Row[] = [], committed: Row[] = [], transactions: Row[] = [], reads: Row[] = [];
  let ownerOrdinal = 0, txOrdinal = 0, validating = false;
  const observer = { observeSessionMfa: vi.fn(async (selected: MfaSessionIdentity) => {
    expect(active.size).toBe(0); expect(selected).toEqual({ sub: actorId, tenantId, sessionId });
    await hooks.observed?.(selected);
    if (observation !== undefined) return observation;
    return { ...selected, expiresAtEpochMs: Date.now() + 120_000, expiresAtMonotonicMs: performance.now() + 120_000 };
  }) };
  function tenantScope(args: Row) { expect(args.where.tenantId).toBe(tenantId); }
  function shiftMatches(row: Row, where: Row) {
    tenantScope({ where });
    if (where.id?.in && !where.id.in.includes(row.id)) return false;
    if (typeof where.id === 'string' && row.id !== where.id) return false;
    if (where.publicId?.in && !where.publicId.in.includes(row.publicId)) return false;
    if (typeof where.publicId === 'string' && row.publicId !== where.publicId) return false;
    if (where.locationId && row.locationId !== where.locationId) return false;
    if (where.location?.is?.publicId && row.location.publicId !== where.location.is.publicId) return false;
    if (where.schedule?.is?.publicId && row.schedule?.publicId !== where.schedule.is.publicId) return false;
    if (where.schedule?.is?.status && row.schedule?.status !== where.schedule.is.status) return false;
    if (where.userId && row.userId !== where.userId) return false;
    return !row.deletedAt;
  }
  const database: any = { async withTenant(selectedTenant: string, callback: (tx: any) => Promise<unknown>, options?: Row) {
    expect(selectedTenant).toBe(tenantId);
    const txId = ++txOrdinal, ordinal = validating ? 0 : ++ownerOrdinal;
    let stage = clone(state.domain); const effects: Row[] = [];
    active.add(txId); const record: Row = { txId, ordinal, options: clone(options ?? {}), status: 'running' };
    transactions.push(record);
    function read(name: string, args: Row) { reads.push({ txId, name, args: clone(args) }); }
    function effect(name: string, args: Row) { const row = { txId, ordinal, name, args: clone(args) };
      attempted.push(row); effects.push(row); }
    const flattenSqlValues = (values: unknown[]): unknown[] => values.flatMap(value => {
      if (value && typeof value === 'object' && 'strings' in value && 'values' in value
        && Array.isArray(value.strings) && Array.isArray(value.values)) return flattenSqlValues(value.values);
      return [value];
    });
    const raw = (sql: any, bound: unknown[]) => ({ text: (Array.isArray(sql) ? sql : sql.strings).join('').replace(/\s+/g, ' ').trim(),
      values: flattenSqlValues(Array.isArray(sql) ? bound : sql.values) });
    const tx: any = {
      async $queryRaw(sql: any, ...bound: unknown[]) {
        const { text, values } = raw(sql, bound); read('raw.query', { text, values });
        if (text.includes('FROM "Tenant"') && text.endsWith('FOR UPDATE')) { expect(values).toEqual([tenantId]); return [{ id: tenantId }]; }
        if (text.includes('FROM "User"') && text.includes('"id" IN')) {
          expect(values).toEqual([tenantId, actorId]); userFences.add(txId); return [clone(state.actor)];
        }
        if (text.includes('FROM "Session"') && text.endsWith('FOR UPDATE')) {
          expect(values).toEqual([sessionId, actorId]); sessionFences.add(txId); return state.session.userId === actorId ? [clone(state.session)] : [];
        }
        if (text.includes('FROM "RolePermission"')) { expect(values).toEqual([roleId]);
          return state.role.rolePermissions.map((_: Row, i: number) => ({ roleId, permissionId: `permission-${i}` })); }
        if (text.includes('FROM "Role"')) { expect(values).toEqual([tenantId, roleId]); return [{ id: roleId }]; }
        if (text.includes('FROM "Schedule"')) { expect(values).toEqual([tenantId, schedule.id]); return [{ id: schedule.id, status: stage.schedule.status }]; }
        if (text.includes('FROM "Shift"')) { expect(values).toEqual([tenantId, initialShift.id]); return [{ id: initialShift.id }]; }
        if (text.includes('FROM "Break"')) { expect(values).toEqual([initialShift.id]); return initialShift.breaks.map((entry: Row) => ({ id: entry.id })); }
        throw new Error('Unmodeled raw query: ' + text);
      },
      async $executeRaw(sql: any, ...bound: unknown[]) {
        const { text, values } = raw(sql, bound); read('raw.execute', { text, values });
        if (text.includes('pg_advisory_xact_lock')) { expect(values).toEqual([`lunchlineup:scheduling:${tenantId}`]); return 1; }
        if (text === 'LOCK TABLE "Tenant", "CreditTransaction" IN ROW EXCLUSIVE MODE') { expect(values).toEqual([]); return 0; }
        throw new Error('Unmodeled raw execute: ' + text);
      },
      tenant: {
        async findFirst(args: Row) { expect(args.where).toEqual({ id: tenantId, deletedAt: null }); read('tenant.findFirst', args);
          return { ...clone(state.tenant), usageCredits: stage.wallet }; },
        async findUnique(args: Row) { expect(args.where).toEqual({ id: tenantId }); read('tenant.findUnique', args); return clone(state.tenant); },
        async findUniqueOrThrow(args: Row) { expect(args.where).toEqual({ id: tenantId }); read('tenant.findUniqueOrThrow', args);
          return { usageCredits: stage.wallet, creditDebt: 0 }; },
        async updateMany(args: Row) { expect(args.where).toEqual({ id: tenantId, creditDebt: 0, usageCredits: { gte: 1 } });
          expect(args.data).toEqual({ usageCredits: { decrement: 1 } }); effect('tenant.debit', args);
          if (stage.wallet < 1) return { count: 0 }; stage.wallet -= 1; return { count: 1 }; },
      },
      tenantSetting: {
        async findUnique(args: Row) { expect(args.where.tenantId_key.tenantId).toBe(tenantId); read('tenantSetting.findUnique', args);
          const k = args.where.tenantId_key.key;
          if (k === 'workspace_settings') return { value: clone(state.security) };
          if (k === 'feature_access') return null;
          if (k === 'lunch_break_policy') return stage.policy ? { value: clone(stage.policy) } : null;
          throw new Error('Unmodeled setting: ' + k); },
        async upsert(args: Row) { expect(args.where).toEqual({ tenantId_key: { tenantId, key: 'lunch_break_policy' } });
          expect(args.create).toEqual({ tenantId, key: 'lunch_break_policy', value: args.update.value });
          effect('tenantSetting.upsert', args); stage.policy = clone(args.update.value); return { value: clone(stage.policy) }; },
      },
      user: {
        async findFirst(args: Row) { expect(args.where).toEqual({ id: actorId, tenantId, deletedAt: null, suspendedAt: null });
          read('user.findFirst', args); return clone(state.actor); },
        async findMany(args: Row) { tenantScope(args); read('user.findMany', args);
          expect(args.where.role.in).toEqual(['MANAGER', 'STAFF']);
          return !state.actor.deletedAt && !state.actor.suspendedAt && (!args.where.id || args.where.id === actorId) ? [clone(state.actor)] : []; },
      },
      session: { async findFirst(args: Row) { expect(args.where).toEqual({ id: sessionId, userId: actorId });
        read('session.findFirst', args); return state.session.userId === actorId ? clone(state.session) : null; } },
      roleAssignment: { async findMany(args: Row) { expect(args.where).toEqual({ tenantId, userId: { in: [actorId] } });
        expect(args.select).toEqual({ userId: true, roleId: true }); read('roleAssignment.findMany', args); return state.assignmentEnabled ? [{ userId: actorId, roleId }] : []; } },
      role: { async findMany(args: Row) { expect(args.where).toEqual({ tenantId, id: { in: [roleId] }, deletedAt: null });
        expect(args.select.rolePermissions).toEqual({ select: { permission: { select: { key: true } } } });
        read('role.findMany', args); return state.role.deletedAt ? [] : [clone(state.role)]; } },
      planDefinition: { async findUnique(args: Row) { expect(args).toEqual({ where: { code: 'GROWTH' }, select: { metadata: true } });
        read('planDefinition.findUnique', args); return { metadata: { features: ['lunch_breaks', 'scheduling', 'time_cards'] } }; } },
      location: { async findFirst(args: Row) { expect(args.where).toEqual({ tenantId, publicId: locationPublicId, deletedAt: null });
        read('location.findFirst', args); return clone(location); } },
      schedule: {
        async findMany(args: Row) { tenantScope(args); read('schedule.findMany', args);
          return (!args.where.status || stage.schedule.status === args.where.status) ? [clone(stage.schedule)] : []; },
        async updateMany(args: Row) { expect(args.where).toEqual({ tenantId, id: { in: [schedule.id] }, status: 'DRAFT', deletedAt: null });
          expect(args.data).toEqual({ revision: { increment: 1 } }); effect('schedule.updateMany', args); stage.schedule.revision += 1; return { count: 1 }; },
      },
      shift: {
        async findMany(args: Row) { tenantScope(args); read('shift.findMany', args);
          return stage.shifts.filter(row => shiftMatches(row, args.where)).map(row => ({ ...clone(row), schedule: row.scheduleId ? clone(stage.schedule) : null })); },
        async findFirst(args: Row) { tenantScope(args); read('shift.findFirst', args);
          const row = stage.shifts.find(row => shiftMatches(row, args.where)); return row ? { ...clone(row), schedule: row.scheduleId ? clone(stage.schedule) : null } : null; },
        async count(args: Row) { tenantScope(args); read('shift.count', args);
          return stage.shifts.filter(row => row.userId === args.where.userId && !row.deletedAt
            && row.startTime < args.where.startTime.lt && row.endTime > args.where.endTime.gt
            && !args.where.id?.notIn?.includes(row.id)).length; },
        async update(args: Row) { expect(args.where).toEqual({ id: initialShift.id }); effect('shift.update', args);
          Object.assign(stage.shifts[0], clone(args.data)); return clone(stage.shifts[0]); },
        async updateMany(args: Row) { tenantScope(args); effect('shift.updateMany', args);
          const rows = stage.shifts.filter(row => shiftMatches(row, args.where)); rows.forEach(row => Object.assign(row, clone(args.data))); return { count: rows.length }; },
        async create(args: Row) { expect(args.data.tenantId).toBe(tenantId); expect(args.data.locationId).toBe(location.id);
          expect(args.data.userId).toBeNull(); effect('shift.create', args);
          stage.shifts.push({ ...clone(args.data), id: 'operations-new-shift', publicId: createdShiftPublicId,
            location: { publicId: locationPublicId }, scheduleId: null, schedule: null, user: null, breaks: [], deletedAt: null,
            updatedAt: new Date() }); return { publicId: createdShiftPublicId }; },
      },
      break: {
        async deleteMany(args: Row) { expect(args.where.shiftId === initialShift.id || args.where.shiftId?.in?.includes(initialShift.id)).toBe(true);
          effect('break.deleteMany', args); const count = stage.shifts[0].breaks.length; stage.shifts[0].breaks = []; return { count }; },
        async createMany(args: Row) { expect(args.data.every((row: Row) => row.shiftId === initialShift.id)).toBe(true);
          effect('break.createMany', args); stage.shifts[0].breaks.push(...args.data.map((row: Row, i: number) => ({ ...clone(row), id: `new-break-${i}` })));
          return { count: args.data.length }; },
      },
      creditTransaction: {
        async findUnique(args: Row) { read('creditTransaction.findUnique', args); return clone(stage.credits.find(row => row.id === args.where.id) ?? null); },
        async create(args: Row) { expect(args.data.tenantId).toBe(tenantId); expect(args.data.amount).toBe(-1);
          expect(args.data.debtAmount).toBe(0); expect(args.data.balanceAfter).toBe(stage.wallet); expect(args.data.debtAfter).toBe(0);
          expect(stage.credits.some(row => row.id === args.data.id)).toBe(false); effect('creditTransaction.create', args);
          stage.credits.push(clone(args.data)); return clone(args.data); },
      },
      auditLog: {
        async findFirst(args: Row) { tenantScope(args); read('auditLog.findFirst', args);
          return clone(stage.audits.find(row => row.tenantId === tenantId && row.action === args.where.action
            && row.resource === args.where.resource && row.resourceId === args.where.resourceId) ?? null); },
        async create(args: Row) { expect(args.data.tenantId).toBe(tenantId); expect(args.data.actorUserId).toBe(actorId);
          expect(args.data.actorTenantId).toBe(tenantId); effect('auditLog.create', args); stage.audits.push(clone(args.data)); return clone(args.data); },
      },
      lunchBreakGenerationRequest: {
        async findUnique(args: Row) { expect(args.where.tenantId_requestKeyHash).toEqual({ tenantId, requestKeyHash: hash(key) });
          read('generation.findUnique', args); return clone(stage.generations.find(row => row.requestKeyHash === hash(key)) ?? null); },
        async create(args: Row) { expect(args.data.tenantId).toBe(tenantId); expect(args.data.requestKeyHash).toBe(hash(key));
          expect(stage.generations).toHaveLength(0); effect('generation.create', args); const row = { ...clone(args.data), response: null };
          stage.generations.push(row); return clone(row); },
        async updateMany(args: Row) { expect(args.where.tenantId).toBe(tenantId); effect('generation.updateMany', args);
          const rows = stage.generations.filter(row => row.id === args.where.id && row.tenantId === tenantId
            && (!args.where.status || row.status === args.where.status)
            && (!args.where.requestHash || row.requestHash === args.where.requestHash)
            && (!args.where.claimToken || row.claimToken === args.where.claimToken)
            && (!args.where.OR || args.where.OR.some((condition: Row) => row.status === condition.status
              && (condition.claimExpiresAt === undefined || (condition.claimExpiresAt === null
                ? row.claimExpiresAt === null : row.claimExpiresAt !== null && row.claimExpiresAt <= condition.claimExpiresAt.lte)))));
          rows.forEach(row => { const data = clone(args.data);
            if (data.attempts !== undefined) { expect(data.attempts).toEqual({ increment: 1 }); data.attempts = row.attempts + 1; }
            Object.assign(row, data);
          }); return { count: rows.length }; },
        async update(args: Row) { effect('generation.update', args); const row = stage.generations.find(row => row.id === args.where.id);
          expect(row).toBeDefined(); Object.assign(row!, clone(args.data)); return clone(row); },
      },
    };
    // Explicit closed completion gates after modeled statements stage their result,
    // before the actual owner's await resumes; no generic proxy/queued callback.
    const completionMethods = [
      ['tenant', 'findFirst'], ['tenant', 'findUnique'], ['tenant', 'findUniqueOrThrow'], ['tenant', 'updateMany'],
      ['tenantSetting', 'findUnique'], ['tenantSetting', 'upsert'], ['user', 'findFirst'], ['user', 'findMany'],
      ['session', 'findFirst'], ['roleAssignment', 'findMany'], ['role', 'findMany'], ['planDefinition', 'findUnique'],
      ['location', 'findFirst'], ['schedule', 'findMany'], ['schedule', 'updateMany'], ['shift', 'findMany'],
      ['shift', 'findFirst'], ['shift', 'count'], ['shift', 'update'], ['shift', 'updateMany'], ['shift', 'create'],
      ['break', 'deleteMany'], ['break', 'createMany'], ['creditTransaction', 'findUnique'], ['creditTransaction', 'create'],
      ['auditLog', 'findFirst'], ['auditLog', 'create'], ['lunchBreakGenerationRequest', 'findUnique'],
      ['lunchBreakGenerationRequest', 'create'], ['lunchBreakGenerationRequest', 'updateMany'], ['lunchBreakGenerationRequest', 'update'],
    ] as const;
    for (const [group, method] of completionMethods) {
      const original = tx[group][method];
      tx[group][method] = async (args: Row) => {
        const result = await original(args);
        const entry = { txId, ordinal, name: `${group}.${method}`, args: clone(args), result: clone(result), effectCount: effects.length };
        completions.push(entry); if (!validating) await hooks.completion?.(entry); return result;
      };
    }
    for (const method of ['$queryRaw', '$executeRaw']) {
      const original = tx[method];
      tx[method] = async (...args: any[]) => {
        const result = await original(...args); const parsed = raw(args[0], args.slice(1));
        const entry = { txId, ordinal, name: method, args: parsed, result: clone(result), effectCount: effects.length };
        completions.push(entry); if (!validating) await hooks.completion?.(entry); return result;
      };
    }
    try {
      if (!validating) await hooks.context?.(ordinal);
      const committedClaim = state.domain.generations.find(row => row.tenantId === tenantId
        && row.requestKeyHash === hash(key) && row.status === 'PENDING');
      const priorClaimEffect = committed.find(row => row.name === 'generation.create'
        && row.args.data.id === committedClaim?.id);
      const phaseReached = control.phase === 'postCommittedClaim'
        ? !!committedClaim && !!priorClaimEffect : ordinal === control.ordinal;
      if (control.armed && !control.reached && phaseReached) {
        if (control.phase === 'postCommittedClaim') {
          expect(committedClaim).toMatchObject({ tenantId, requestKeyHash: hash(key), status: 'PENDING', attempts: 1 });
          expect(typeof committedClaim!.claimToken).toBe('string');
          expect(transactions.find(row => row.txId === priorClaimEffect!.txId)?.status).toBe('committed');
          expect(active.has(priorClaimEffect!.txId)).toBe(false);
          expect(sessionFences.size).toBe(0); expect(userFences.size).toBe(0);
        }
        control.reached = true; entered.release(); await released.promise;
      }
      // No domain statement has executed before this released context gate.
      // Bind staged reads to current committed rows at callback entry (ReadCommitted).
      stage = clone(state.domain);
      const result = await callback(tx);
      state.domain = stage; state.tenant.usageCredits = stage.wallet;
      committed.push(...effects); record.status = 'committed'; hooks.commit?.(record); return result;
    } catch (error) { if (record.status !== 'committed') record.status = 'rolled-back'; else record.acknowledgementFailed = true; throw error; }
    finally { active.delete(txId); sessionFences.delete(txId); userFences.delete(txId);
      if (!sessionFences.size && !userFences.size) pendingWriters.splice(0).forEach(commit => commit()); }
  } };
  // Actual owner + actual authorization helper with a bounded explicit observer.
  const operations = new (OperationsService as any)(database, observer);
  const lunchBreaks = new (LunchBreakService as any)(database, observer);
  const handlers = new Map<string, (request: any, reply: any) => Promise<unknown>>();
  const app: any = {};
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    app[method] = (path: string, _options: Row, handler: (request: any, reply: any) => Promise<unknown>) => {
      const pair = `${method.toUpperCase()} ${path}`; expect(handlers.has(pair)).toBe(false); handlers.set(pair, handler);
    };
  }
  const quotaCalls: string[] = [], authenticateCalls: string[] = [];
  const common: any = { config: { allowedOrigins: new Set(['http://source-only.invalid']) },
    identity: { authenticate: async () => { authenticateCalls.push('snapshot'); return requestIdentity; } },
    quota: { consume: async (operation: string) => { quotaCalls.push(operation); } }, operations, lunchBreaks };
  await registerOperationsRoutes(app, common);
  await registerSchedulingRoutes(app, { ...common, board: {}, scheduleCreate: {}, changeSets: {}, demandWindows: {}, lifecycle: {}, retainedScheduling: {} });
  const generationBody = { locationId: locationPublicId, shiftIds: [shiftPublicId], persist: true };
  const body: Row = action.id === 'updateLunchBreakPolicy' ? { lunchDurationMinutes: 45 }
    : action.id === 'importLunchBreakShifts' ? { locationId: locationPublicId, rows: [{ userId: null,
      startTime: '2026-10-07T08:00:00.000Z', endTime: '2026-10-07T16:00:00.000Z' }] }
    : action.id === 'updateShiftBreakPlan' ? { locationId: locationPublicId,
      breaks: [{ type: 'lunch', startTime: '2026-10-05T12:00:00.000Z', durationMinutes: 45 }] }
    : action.id === 'generateScheduleBreaks' ? { locationId: locationPublicId, shiftIds: [shiftPublicId] } : generationBody;
  const headers: Row = {};
  const reply: any = { header: (name: string, value: string) => { headers[name] = value; return reply; } };
  let requestIdentity = clone(identity);
  async function call() {
    const handler = handlers.get(`${action.method} ${action.path}`); expect(handler).toBeDefined();
    return handler!({ headers: { authorization: 'Bearer controlled-source-only', 'idempotency-key': key }, cookies: {},
      query: {}, body: clone(body), params: { shiftId: shiftPublicId } }, reply);
  }
  async function validateReadiness() {
    validating = true;
    try {
      const authority = await database.withTenant(tenantId, (tx: any) => authorizeCurrentMutation(tx, identity, action.permission));
      assertCurrentMutation(authority, { sub: actorId, tenantId, sessionId, expiresAtEpochMs: Date.now() + 120_000,
        expiresAtMonotonicMs: performance.now() + 120_000 });
      expect(authority.actorAccess.permissions.has(action.permission)).toBe(true);
      if (action.id === 'importLunchBreakShifts') expect(authority.actorAccess.permissions.has('shifts:write')).toBe(true);
      expect(authority.identity).toEqual({ sub: actorId, tenantId, sessionId });
      expect(authority.requiresMfa).toBe(true); expect(active.size).toBe(0);
      expect(sessionFences.size).toBe(0); expect(userFences.size).toBe(0);
    } finally { validating = false; }
  }
  function changeAuthority(mode: 'revoked' | 'effective-expiry') {
    // Committed writer-first changes are legal only before any actor fence.
    expect(sessionFences.size).toBe(0); expect(userFences.size).toBe(0);
    if (mode === 'revoked') state.session.revokedAt = new Date();
    else vi.setSystemTime(new Date(Date.parse(now) + 61_000));
  }
  async function controlled(mode: 'revoked' | 'effective-expiry', phase: number | 'postCommittedClaim' = 1) {
    control.armed = true; control.ordinal = typeof phase === 'number' ? phase : 1;
    control.phase = typeof phase === 'number' ? 'contextOrdinal' : phase; control.mode = mode;
    const pending = call(); const arrival = await Promise.race([entered.promise.then(() => 'entered'),
      pending.then(() => 'settled', () => 'settled')]);
    expect(arrival).toBe('entered'); changeAuthority(mode); released.release();
    try { return { result: await pending, error: undefined }; } catch (error) { return { result: undefined, error }; }
  }
  function assertPositive(result: any) {
    expect(headers['Cache-Control']).toBe('private, no-store');
    expect(authenticateCalls.at(-1)).toBe('snapshot'); expect(quotaCalls.at(-1)).toBe(action.id);
    assertDomainPositive(result);
  }
  function assertDomainPositive(result: any) {
    if (action.id === 'listScheduleSummaries') expect(result.data).toMatchObject([{ id: schedulePublicId, revision: 3 }]);
    else if (action.id === 'listStaffRoster') expect(result.data).toEqual([{ id: actorPublicId, name: actor.name, role: 'MANAGER' }]);
    else if (['listShiftSummaries', 'listLunchBreakRows'].includes(action.id)) expect(result.data).toHaveLength(1);
    else if (action.id === 'getLunchBreakPolicy') expect(result.lunchDurationMinutes).toBe(30);
    else if (action.id === 'updateLunchBreakPolicy') { expect(result.lunchDurationMinutes).toBe(45); expect(state.domain.policy?.lunchDurationMinutes).toBe(45); }
    else if (action.id === 'importLunchBreakShifts') { expect(result.shiftIds).toEqual([createdShiftPublicId]);
      expect(state.domain.shifts).toHaveLength(2); expect(state.domain.audits).toHaveLength(2); }
    else if (action.id === 'updateShiftBreakPlan') { expect(result.breaks).toEqual([{ type: 'lunch',
      startTime: '2026-10-05T12:00:00.000Z', endTime: '2026-10-05T12:45:00.000Z', durationMinutes: 45, paid: false }]);
      expect(state.domain.shifts[0].breaks).toHaveLength(1); expect(state.domain.schedule.revision).toBe(4); }
    else { expect(result.data).toHaveLength(1); expect(result.persisted).toBe(true); expect(result.reused).toBe(false);
      expect(state.domain.generations).toHaveLength(1); expect(state.domain.generations[0].status).toBe('SUCCEEDED');
      expect(state.domain.generations[0].requestHash).toBe(hash(JSON.stringify({ locationId: locationPublicId, persist: true, shiftIds: [shiftPublicId] })));
      expect(state.domain.shifts[0].breaks).toHaveLength(3); expect(state.domain.schedule.revision).toBe(4); }
    const paid = ['generateLunchBreakPlan', 'generateScheduleBreaks', 'importLunchBreakShifts', 'updateShiftBreakPlan'].includes(action.id);
    expect(state.domain.wallet).toBe(paid ? 4 : 5); expect(state.domain.credits).toHaveLength(paid ? 1 : 0);
    expect(active.size).toBe(0); expect(sessionFences.size).toBe(0); expect(userFences.size).toBe(0);
  }
  return { state, attempted, committed, transactions, reads, completions, hooks, observer, headers, call, controlled, body,
    operations, lunchBreaks, requestIdentity, writerRecords,
    actorWriter: (write: () => void) => {
      const record = { status: 'waiting' }; writerRecords.push(record);
      return new Promise<void>(resolve => { const commit = () => { expect(sessionFences.size).toBe(0); expect(userFences.size).toBe(0);
        write(); record.status = 'committed'; resolve(); };
        if (sessionFences.size || userFences.size) pendingWriters.push(commit); else commit(); });
    },
    setObservation: (value: Row | null) => { observation = value; },
    validateReadiness, assertPositive, assertDomainPositive, release: released.release, active, userFences, sessionFences };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(now)); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('actual native Operations owners and captured alias current-authority baseline', () => {
  for (const action of actions) {
    it(`${action.id}: populated route/owner/domain positive with actual current-authority readiness`, async () => {
      const f = await fixture(action); await f.validateReadiness(); const result = await f.call(); f.assertPositive(result);
    });
    for (const mode of ['revoked', 'effective-expiry'] as const) {
      it(`${action.id}: refuses ${mode} committed before any actor fence at reached owner context`, async () => {
        const f = await fixture(action); await f.validateReadiness(); const before = clone(f.state.domain);
        try {
          const outcome = await f.controlled(mode);
          expect(outcome.error, 'Original source completes despite genuine current-session/policy loss').toMatchObject({ status: 403 });
          expect(outcome.result).toBeUndefined(); expect(f.committed).toEqual([]); expect(f.state.domain).toEqual(before);
          expect(f.active.size).toBe(0);
        } finally { f.release(); }
      });
    }
  }
  for (const action of actions.filter(action => ['generateLunchBreakPlan', 'generateScheduleBreaks', 'importLunchBreakShifts', 'updateShiftBreakPlan'].includes(action.id))) {
    it(`${action.id}: exact committed replay returns receipt with no recharge or domain effects`, async () => {
      const f = await fixture(action); await f.validateReadiness(); f.assertPositive(await f.call());
      const before = clone(f.state.domain), count = f.committed.length; const response: any = await f.call();
      expect(response).toBeDefined(); expect(f.state.domain).toEqual(before); expect(f.committed).toHaveLength(count);
      if (action.id.includes('generate') || action.id === 'generateScheduleBreaks') expect(response.reused).toBe(true);
    });
    it(`${action.id}: revoked exact session cannot disclose a prior committed receipt`, async () => {
      const f = await fixture(action); await f.validateReadiness(); f.assertPositive(await f.call());
      const before = clone(f.state.domain), count = f.committed.length;
      // Replay's next owner context, not a forced mutation under held fences.
      const nextOrdinal = f.transactions.filter(row => row.ordinal > 0).length + 1;
      try { const outcome = await f.controlled('revoked', nextOrdinal);
        expect(outcome.error, 'Receipt durability is not permission to return it to a revoked session').toMatchObject({ status: 403 });
        expect(outcome.result).toBeUndefined(); expect(f.state.domain).toEqual(before); expect(f.committed).toHaveLength(count);
      } finally { f.release(); }
    });
  }
  for (const action of actions.filter(action => ['generateLunchBreakPlan', 'generateScheduleBreaks'].includes(action.id))) {
    it(`${action.id}: released claim permits legal revocation before prepare without financial completion`, async () => {
      const f = await fixture(action); await f.validateReadiness();
      try { const outcome = await f.controlled('revoked', 'postCommittedClaim');
        expect(outcome.error, 'Later phases need current authority after the durable claim transaction releases').toMatchObject({ status: 403 });
        expect(outcome.result).toBeUndefined(); expect(f.state.domain.wallet).toBe(5); expect(f.state.domain.credits).toEqual([]);
        expect(f.state.domain.shifts[0].breaks).toHaveLength(1); expect(f.state.domain.schedule.revision).toBe(3);
        // Exact internal claim cleanup may mark FAILED without actor disclosure.
        expect(f.state.domain.generations).toHaveLength(1); expect(f.state.domain.generations[0].status).toBe('FAILED');
        expect(f.state.domain.generations[0].failureStatus).toBe(403);
      } finally { f.release(); }
    });
  }
});


// All gates below start in a valid, independently populated current actor state.
// The frozen V3 original-domain-wait baseline remains separately retained.
type Fixture = Awaited<ReturnType<typeof fixture>>;
function finance(f: Fixture) {
  return clone({ wallet: f.state.domain.wallet, policy: f.state.domain.policy, shifts: f.state.domain.shifts,
    schedule: f.state.domain.schedule, credits: f.state.domain.credits, audits: f.state.domain.audits });
}
async function gatedCompletion(f: Fixture, match: (entry: Row) => boolean, mutate: (entry: Row) => void,
  invoke: () => Promise<unknown> = f.call) {
  const entered = deferred(), released = deferred(); let reached: Row | undefined;
  f.hooks.completion = async entry => { if (reached || !match(entry)) return;
    reached = entry; entered.release(); await released.promise; };
  const pending = invoke();
  try {
    expect(await Promise.race([entered.promise.then(() => 'entered'), pending.then(() => 'settled', () => 'settled')])).toBe('entered');
    expect(reached).toBeDefined(); mutate(reached!); released.release();
    try { return { result: await pending, error: undefined, reached: reached! }; }
    catch (error) { return { result: undefined, error, reached: reached! }; }
  } finally { released.release(); }
}
function authorityEntry(f: Fixture, write: () => void) {
  // Preflight releases before the final context; no writer is forced through a held fence.
  f.hooks.context = ordinal => { if (ordinal !== 2) return;
    expect(f.sessionFences.size).toBe(0); expect(f.userFences.size).toBe(0); write(); };
}
function deadline(f: Fixture, axis: 'stored' | 'effective' | 'wall' | 'monotonic') {
  let monotonic = 1000; vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
  const wall = Date.parse(now);
  f.state.security.security.sessionTimeoutMinutes = axis === 'effective' ? 30 : 480;
  f.state.session.createdAt = new Date(wall - (axis === 'effective' ? 29 * 60_000 : 4 * 60_000));
  f.state.session.expiresAt = new Date(wall + (axis === 'stored' ? 1000 : 60 * 60_000));
  f.setObservation({ sub: actorId, tenantId, sessionId,
    expiresAtEpochMs: wall + (axis === 'wall' ? 1000 : 120_000),
    expiresAtMonotonicMs: 1000 + (axis === 'monotonic' ? 1000 : 120_000) });
  return () => { if (axis === 'monotonic') monotonic = 2000;
    else vi.setSystemTime(new Date(wall + (axis === 'effective' ? 60_000 : 1000))); };
}

describe('native Operations fresh phases, finite proof, and staged owner effects', () => {
  for (const action of actions) {
    for (const loss of ['permission', 'forced-pin', 'suspended-account'] as const) {
      it(`${action.id}: fresh final context refuses current ${loss} after released observation`, async () => {
        const f = await fixture(action); await f.validateReadiness(); const before = finance(f);
        authorityEntry(f, () => {
          if (loss === 'permission') f.state.role.rolePermissions = f.state.role.rolePermissions.filter((row: Row) => row.permission.key !== action.permission);
          else if (loss === 'forced-pin') f.state.actor.pinResetRequired = true;
          else f.state.actor.suspendedAt = new Date();
        });
        await expect(f.call()).rejects.toMatchObject({ status: 403 });
        expect(finance(f)).toEqual(before); expect(f.committed).toEqual([]); expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce();
      });
    }
    it(`${action.id}: held actor fences serialize owner-first work before a queued actor writer`, async () => {
      const f = await fixture(action); await f.validateReadiness(); let writer: Promise<void> | undefined;
      const completion = action.id === 'listScheduleSummaries' ? 'schedule.findMany'
        : action.id === 'listStaffRoster' ? 'user.findMany'
        : action.id === 'listShiftSummaries' || action.id === 'listLunchBreakRows' ? 'shift.findMany'
        : action.id === 'getLunchBreakPolicy' ? 'tenantSetting.findUnique'
        : action.id === 'updateLunchBreakPolicy' ? 'tenantSetting.upsert'
        : action.id === 'importLunchBreakShifts' || action.id === 'updateShiftBreakPlan' ? 'auditLog.create'
        : 'lunchBreakGenerationRequest.update';
      const outcome = await gatedCompletion(f, entry => entry.name === completion
        && (completion !== 'tenantSetting.findUnique' || entry.args.where.tenantId_key.key === 'lunch_break_policy'), () => {
        expect(f.userFences.size).toBe(1); expect(f.sessionFences.size).toBe(1);
        writer = f.actorWriter(() => { f.state.session.revokedAt = new Date(); });
        expect(f.writerRecords).toEqual([{ status: 'waiting' }]); expect(f.state.session.revokedAt).toBeNull();
      });
      expect(outcome.error).toBeUndefined(); f.assertPositive(outcome.result); await writer;
      expect(f.writerRecords).toEqual([{ status: 'committed' }]); expect(f.state.session.revokedAt).not.toBeNull();
    });
    for (const axis of ['stored', 'effective', 'wall', 'monotonic'] as const) {
      it(`${action.id}: ${axis} deadline refuses each distinct reached effect completion and final read with rollback`, async () => {
        const viable = await fixture(action); await viable.validateReadiness(); viable.assertPositive(await viable.call());
        // Every reached state effect, plus the final domain read for each owner transaction.
        const effectNames = new Set(['tenant.updateMany', 'creditTransaction.create', 'break.deleteMany', 'break.createMany',
          'shift.update', 'shift.updateMany', 'shift.create', 'schedule.updateMany', 'auditLog.create',
          'tenantSetting.upsert', 'lunchBreakGenerationRequest.create', 'lunchBreakGenerationRequest.updateMany', 'lunchBreakGenerationRequest.update']);
        const finalDomains = new Map<number, Row>();
        for (const entry of viable.completions.filter(entry => entry.ordinal > 1)) {
          if (['schedule.findMany', 'shift.findMany', 'shift.findFirst', 'user.findMany', 'auditLog.findFirst', 'lunchBreakGenerationRequest.findUnique'].includes(entry.name)
            || (entry.name === 'tenantSetting.findUnique' && entry.args.where.tenantId_key.key === 'lunch_break_policy')) finalDomains.set(entry.ordinal, entry);
        }
        const targets = viable.completions.filter(entry => entry.ordinal > 1 && effectNames.has(entry.name));
        for (const entry of finalDomains.values()) if (!targets.includes(entry)) targets.push(entry);
        expect(targets.length).toBeGreaterThan(0);
        for (const target of targets) {
          vi.setSystemTime(new Date(now)); vi.restoreAllMocks();
          const f = await fixture(action); await f.validateReadiness(); const before = finance(f), expire = deadline(f, axis);
          const position = viable.completions.filter(entry => entry.txId === target.txId && entry.name === target.name).indexOf(target);
          let count = 0;
          const outcome = await gatedCompletion(f, entry => entry.ordinal === target.ordinal && entry.name === target.name && count++ === position, expire);
          expect(outcome.error, `${action.id}/${axis}/${target.ordinal}/${target.name}/${position}`).toMatchObject({ status: 403 });
          expect(outcome.result).toBeUndefined(); expect(finance(f)).toEqual(before);
          const record = f.transactions.find(row => row.txId === outcome.reached.txId); expect(record?.status).toBe('rolled-back');
          expect(f.committed.filter(row => row.txId === outcome.reached.txId)).toEqual([]);
          expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce(); expect(f.active.size).toBe(0);
        }
      });
    }
  }
  it('setup rechecks shifts:write from the same final locked access snapshot', async () => {
    const f = await fixture(actions[7]); await f.validateReadiness(); const before = finance(f);
    authorityEntry(f, () => { f.state.role.rolePermissions = f.state.role.rolePermissions.filter((row: Row) => row.permission.key !== 'shifts:write'); });
    await expect(f.call()).rejects.toMatchObject({ status: 403 }); expect(finance(f)).toEqual(before);
    expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce();
  });
  for (const action of [actions[0], actions[1], actions[3]]) {
    it(`${action.id}: fresh Staff role scope excludes draft records despite stale Manager request roles`, async () => {
      const f = await fixture(action); await f.validateReadiness();
      authorityEntry(f, () => { f.state.role.legacyRole = 'STAFF'; f.state.role.name = 'Staff'; });
      const result: any = await f.call(); expect(result.data).toEqual([]); expect(f.requestIdentity.legacyRole).toBe('MANAGER');
      expect([...f.reads].reverse().find(row => row.name === (action.id === 'listScheduleSummaries' ? 'schedule.findMany' : 'shift.findMany'))?.args.where)
        .toMatchObject(action.id === 'listScheduleSummaries' ? { status: 'PUBLISHED' } : { userId: actorId, schedule: { is: { status: 'PUBLISHED' } } });
    });
  }
  for (const action of actions.slice(0, 5)) {
    it(`${action.id}: genuinely non-MFA current read needs no external marker`, async () => {
      const f = await fixture(action); f.state.actor.mfaEnabled = false; f.state.security.security.requireMfaForAll = false;
      f.state.role.rolePermissions = f.state.role.rolePermissions.filter((row: Row) => !['shifts:write', 'lunch_breaks:write'].includes(row.permission.key));
      const result = await f.call(); f.assertPositive(result); expect(f.observer.observeSessionMfa).not.toHaveBeenCalled();
    });
    for (const change of ['workspace', 'enrollment', 'privileged-grant'] as const) {
      it(`${action.id}: fresh ${change} MFA requirement cannot reuse an absent preflight observation`, async () => {
        const f = await fixture(action); f.state.actor.mfaEnabled = false; f.state.security.security.requireMfaForAll = false;
        f.state.role.rolePermissions = f.state.role.rolePermissions.filter((row: Row) => !['shifts:write', 'lunch_breaks:write'].includes(row.permission.key));
        authorityEntry(f, () => { if (change === 'workspace') f.state.security.security.requireMfaForAll = true;
          else if (change === 'enrollment') f.state.actor.mfaEnabled = true;
          else { expect(PRIVILEGED_MFA_PERMISSION_KEYS.has('settings:write')).toBe(true);
            f.state.role.rolePermissions.push({ permission: { key: 'settings:write' } }); } });
        await expect(f.call()).rejects.toMatchObject({ status: 403, code: 'mfa_verification_required' });
        expect(f.observer.observeSessionMfa).not.toHaveBeenCalled(); expect(f.committed).toEqual([]);
      });
    }
  }
  for (const invalid of ['missing', 'wrong-actor', 'wrong-tenant', 'wrong-session', 'nonfinite-wall', 'fractional-wall', 'nonfinite-monotonic'] as const) {
    it(`bounded canonical observation refuses ${invalid} without state effects`, async () => {
      const f = await fixture(actions[5]); const observation: Row = { sub: actorId, tenantId, sessionId,
        expiresAtEpochMs: Date.parse(now) + 60_000, expiresAtMonotonicMs: performance.now() + 60_000 };
      if (invalid === 'wrong-actor') observation.sub = 'other';
      if (invalid === 'wrong-tenant') observation.tenantId = 'other';
      if (invalid === 'wrong-session') observation.sessionId = 'other';
      if (invalid === 'nonfinite-wall') observation.expiresAtEpochMs = Infinity;
      if (invalid === 'fractional-wall') { observation.expiresAtEpochMs += .5; expect(observation.expiresAtEpochMs).toBeGreaterThan(Date.now()); }
      if (invalid === 'nonfinite-monotonic') observation.expiresAtMonotonicMs = Infinity;
      f.setObservation(invalid === 'missing' ? null : observation);
      await expect(f.call()).rejects.toMatchObject({ status: 403 }); expect(f.committed).toEqual([]);
    });
  }
  it('observer failure is unavailable and never enters a domain phase', async () => {
    const f = await fixture(actions[5]); f.hooks.observed = () => { throw new Error('controlled observer unavailable'); };
    await expect(f.call()).rejects.toMatchObject({ status: 503 }); expect(f.committed).toEqual([]);
  });
  it('original preflight policy cap survives a final timeout extension', async () => {
    const f = await fixture(actions[5]); await f.validateReadiness();
    authorityEntry(f, () => { f.state.security.security.sessionTimeoutMinutes = 480; });
    const outcome = await gatedCompletion(f, entry => entry.name === 'tenantSetting.upsert', () => vi.setSystemTime(new Date(Date.parse(now) + 61_000)));
    expect(outcome.error).toMatchObject({ status: 403 }); expect(f.state.domain.policy).toBeNull(); expect(f.committed).toEqual([]);
  });
  it('copied observation and captured method cannot extend the request during later waits', async () => {
    const f = await fixture(actions[5]); const proof = { sub: actorId, tenantId, sessionId,
      expiresAtEpochMs: Date.parse(now) + 1000, expiresAtMonotonicMs: performance.now() + 60_000 }; f.setObservation(proof);
    authorityEntry(f, () => { proof.expiresAtEpochMs = Date.parse(now) + 60_000;
      f.observer.observeSessionMfa.mockImplementation(async () => ({ ...proof })); });
    const outcome = await gatedCompletion(f, entry => entry.name === 'tenantSetting.upsert', () => vi.setSystemTime(new Date(Date.parse(now) + 1000)));
    expect(outcome.error).toMatchObject({ status: 403 }); expect(f.committed).toEqual([]); expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce();
  });
  it('direct owner freezes canonical actor and generation body before external observation', async () => {
    const f = await fixture(actions[6]); const actor = { ...clone(f.requestIdentity), sub: ` ${actorId} `, tenantId: ` ${tenantId} `, sessionId: ` ${sessionId} ` };
    const body = clone(f.body); f.hooks.observed = () => { actor.sub = 'other'; actor.tenantId = 'other'; actor.sessionId = 'other'; body.locationId = 'other'; body.shiftIds.length = 0; };
    const result = await f.lunchBreaks.generate(actor as never, body as never, key); f.assertDomainPositive(result);
    expect(f.headers).toEqual({});
    expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce();
  });
  for (const action of [actions[5], actions[6], actions[7], actions[8]]) {
    it(`${action.id}: final serial retry reauthorizes with the same finite observation`, async () => {
      const f = await fixture(action); await f.validateReadiness(); let failed = false;
      f.hooks.completion = entry => { if (!failed && entry.name === 'role.findMany' && entry.ordinal === 2) { failed = true; throw { code: 'P2034' }; } };
      f.assertPositive(await f.call()); expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce();
      expect(f.transactions.some(row => row.status === 'rolled-back' && row.ordinal === 2)).toBe(true);
      expect(f.reads.filter(row => row.name === 'session.findFirst').length).toBeGreaterThan(2);
    });
  }
  for (const action of [actions[6], actions[7], actions[8]]) {
    for (const known of [true, false]) {
      it(`${action.id}: own committed acknowledgement ${known ? 'known driver' : 'arbitrary'} failure has bounded receipt recovery`, async () => {
        const f = await fixture(action); const failure = known ? { code: 'P1001' } : new Error('controlled arbitrary acknowledgement error');
        let thrown = false; f.hooks.commit = entry => { if (!thrown && f.state.domain.credits.length === 1
          && (!['generateLunchBreakPlan', 'generateScheduleBreaks'].includes(action.id) || f.state.domain.generations[0]?.status === 'SUCCEEDED')) {
          thrown = true; throw failure; } };
        if (known) { const result: any = await f.call(); expect(result).toBeDefined(); }
        else await expect(f.call()).rejects.toBe(failure);
        expect(thrown).toBe(true); expect(f.state.domain.wallet).toBe(4); expect(f.state.domain.credits).toHaveLength(1);
        const before = finance(f), count = f.committed.length; expect(await f.call()).toBeDefined();
        expect(finance(f)).toEqual(before); expect(f.committed).toHaveLength(count);
      });
    }
  }
  it('generation cleanup settles only the owned PENDING claim when authorized recovery itself refuses', async () => {
    const f = await fixture(actions[6]); let failed = false, revoked = false;
    f.hooks.completion = entry => { if (!failed && entry.name === 'location.findFirst') { failed = true; throw { code: 'P1001' }; } };
    f.hooks.context = () => { if (failed && !revoked) { expect(f.sessionFences.size).toBe(0); expect(f.userFences.size).toBe(0);
      revoked = true; f.state.session.revokedAt = new Date(); } };
    await expect(f.call()).rejects.toMatchObject({ status: 403 }); expect(f.state.domain.wallet).toBe(5); expect(f.state.domain.credits).toEqual([]);
    expect(f.state.domain.generations[0]).toMatchObject({ status: 'FAILED', failureStatus: 403, claimToken: null });
    const cleanup = f.committed.find(row => row.name === 'generation.updateMany' && row.args.data.status === 'FAILED');
    expect(cleanup?.args.where).toMatchObject({ tenantId, status: 'PENDING', id: f.state.domain.generations[0].id });
    expect(typeof cleanup?.args.where.claimToken).toBe('string');
  });
  it('generation cannot disclose SUCCEEDED receipt to revoked recovery and cleanup cannot overwrite success', async () => {
    const f = await fixture(actions[6]); let acknowledgement = false, revoked = false;
    f.hooks.commit = () => { if (!acknowledgement && f.state.domain.generations[0]?.status === 'SUCCEEDED') { acknowledgement = true; throw { code: 'P1001' }; } };
    f.hooks.context = () => { if (acknowledgement && !revoked) { expect(f.sessionFences.size).toBe(0); revoked = true; f.state.session.revokedAt = new Date(); } };
    await expect(f.call()).rejects.toMatchObject({ status: 403 }); expect(f.state.domain.generations[0].status).toBe('SUCCEEDED');
    expect(f.state.domain.wallet).toBe(4); expect(f.state.domain.credits).toHaveLength(1);
  });

  for (const revoked of [false, true]) {
    it(`generation expired own claim ${revoked ? 'refuses revoked recovery without overwriting' : 'reuses authorized'} actual later-owner SUCCEEDED receipt`, async () => {
      const f = await fixture(actions[6]); f.state.security.security.sessionTimeoutMinutes = 480;
      f.setObservation({ sub: actorId, tenantId, sessionId, expiresAtEpochMs: Date.now() + 600_000,
        expiresAtMonotonicMs: performance.now() + 600_000 });
      await f.validateReadiness();
      const entered = deferred(), released = deferred(); let gated = false, missed = false, writerCommitted = false;
      let failedTxId: number | undefined, originalClaimToken: string | undefined;
      f.hooks.context = async () => {
        if (missed && revoked && !writerCommitted) {
          expect(f.transactions.find(row => row.txId === failedTxId)?.status).toBe('rolled-back');
          expect(f.sessionFences.size).toBe(0); expect(f.userFences.size).toBe(0);
          writerCommitted = true; f.state.session.revokedAt = new Date();
        }
        if (gated || f.state.domain.generations[0]?.status !== 'PENDING') return;
        const prepared = f.transactions.find(row => row.status === 'committed'
          && f.reads.some(read => read.txId === row.txId && read.name === 'shift.findMany'));
        if (!prepared) return;
        expect(f.active.has(prepared.txId)).toBe(false);
        expect(f.sessionFences.size).toBe(0); expect(f.userFences.size).toBe(0);
        gated = true; entered.release(); await released.promise;
      };
      f.hooks.completion = entry => {
        if (entry.name === 'lunchBreakGenerationRequest.updateMany' && entry.args.where.status === 'PENDING'
          && entry.args.data.status === undefined && entry.result.count === 0) {
          expect(entry.args.where.claimToken).toBe(originalClaimToken); missed = true; failedTxId = entry.txId;
        }
      };
      const pending = f.call();
      try {
        expect(await Promise.race([entered.promise.then(() => 'entered'), pending.then(() => 'settled', () => 'settled')])).toBe('entered');
        const originalClaim = clone(f.state.domain.generations[0]); originalClaimToken = originalClaim.claimToken;
        expect(originalClaim).toMatchObject({ status: 'PENDING', attempts: 1 });
        vi.setSystemTime(new Date(Date.parse(now) + 121_000));
        expect(originalClaim.claimExpiresAt.getTime()).toBeLessThan(Date.now());
        // A separate actual owner creates the replacement receipt; it is not injected as fabricated success.
        const peer = await fixture(actions[6]); peer.state.security.security.sessionTimeoutMinutes = 480;
        peer.state.domain = clone(f.state.domain); await peer.validateReadiness();
        const peerResult = await peer.call(); peer.assertPositive(peerResult);
        expect(peer.state.domain.generations[0]).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });
        expect(peer.committed.find(row => row.name === 'generation.updateMany' && row.args.data.attempts)?.args.where)
          .toMatchObject({ id: originalClaim.id, tenantId, requestHash: originalClaim.requestHash });
        expect(peer.committed.find(row => row.name === 'generation.updateMany' && row.args.data.attempts)?.args.data.claimToken)
          .not.toBe(originalClaimToken);
        expect(peer.observer.observeSessionMfa).toHaveBeenCalledOnce();
        f.state.domain = clone(peer.state.domain); f.state.tenant.usageCredits = peer.state.domain.wallet;
        const settledDomain = clone(f.state.domain); released.release();
        if (revoked) await expect(pending).rejects.toMatchObject({ status: 403 });
        else expect(await pending).toEqual({ ...(peerResult as Row), reused: true });
        expect(missed).toBe(true); expect(writerCommitted).toBe(revoked);
        expect(f.transactions.find(row => row.txId === failedTxId)?.status).toBe('rolled-back');
        expect(f.state.domain).toEqual(settledDomain); expect(f.state.domain.wallet).toBe(4);
        expect(f.state.domain.credits).toHaveLength(1); expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce();
        expect(f.committed.filter(row => ['tenant.debit', 'creditTransaction.create', 'break.deleteMany', 'break.createMany', 'schedule.updateMany', 'generation.update'].includes(row.name))).toEqual([]);
        if (revoked) expect(f.completions.find(row => row.name === 'lunchBreakGenerationRequest.updateMany'
          && row.args.data.status === 'FAILED')?.result).toEqual({ count: 0 });
      } finally { released.release(); await pending.catch(() => undefined); }
    });
  }

  it('final serial retry refuses a committed writer-first session loss without reminting MFA', async () => {
    const f = await fixture(actions[5]); let failed = false;
    f.hooks.completion = entry => { if (!failed && entry.name === 'role.findMany' && entry.ordinal === 2) { failed = true; throw { code: 'P2034' }; } };
    f.hooks.context = ordinal => { if (ordinal === 3) { expect(f.sessionFences.size).toBe(0); expect(f.userFences.size).toBe(0);
      f.state.session.revokedAt = new Date(); } };
    await expect(f.call()).rejects.toMatchObject({ status: 403 }); expect(f.committed).toEqual([]);
    expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce();
  });
  for (const change of ['session', 'grant', 'effective-expiry'] as const) {
    it(`generation fresh completion refuses ${change} after a genuinely committed preparation phase`, async () => {
      const f = await fixture(actions[6]); let changed = false;
      f.hooks.context = () => {
        if (changed || f.state.domain.generations[0]?.status !== 'PENDING') return;
        const preparation = f.transactions.find(row => row.status === 'committed'
          && f.reads.some(read => read.txId === row.txId && read.name === 'shift.findMany'));
        if (!preparation) return;
        expect(f.active.has(preparation.txId)).toBe(false); expect(f.sessionFences.size).toBe(0); expect(f.userFences.size).toBe(0);
        changed = true;
        if (change === 'session') f.state.session.revokedAt = new Date();
        else if (change === 'grant') f.state.role.rolePermissions = f.state.role.rolePermissions.filter((row: Row) => row.permission.key !== 'lunch_breaks:write');
        else vi.setSystemTime(new Date(Date.parse(now) + 61_000));
      };
      await expect(f.call()).rejects.toMatchObject({ status: 403 }); expect(changed).toBe(true);
      expect(f.state.domain.generations[0]).toMatchObject({ status: 'FAILED', failureStatus: 403 });
      expect(f.state.domain.wallet).toBe(5); expect(f.state.domain.credits).toEqual([]);
      expect(f.state.domain.shifts[0].breaks).toHaveLength(1); expect(f.state.domain.schedule.revision).toBe(3);
      expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce();
    });
  }
  for (const action of [actions[6], actions[7], actions[8], actions[9]]) {
    it(`${action.id}: immutable exact replay survives absent historical domain targets without new eligibility reads`, async () => {
      const f = await fixture(action); f.assertPositive(await f.call());
      f.state.domain.shifts = []; f.state.domain.schedule.status = 'ARCHIVED'; f.state.location.deletedAt = new Date();
      const before = clone(f.state.domain), readCount = f.reads.length, effects = f.committed.length;
      expect(await f.call()).toBeDefined(); expect(f.state.domain).toEqual(before); expect(f.committed).toHaveLength(effects);
      expect(f.reads.slice(readCount).filter(row => ['location.findFirst', 'shift.findFirst', 'shift.findMany'].includes(row.name))).toEqual([]);
    });
  }
  it('claim create unique acknowledgement uses fresh transaction and cannot query an aborted transaction', async () => {
    const f = await fixture(actions[6]); let lost = false;
    f.hooks.commit = () => { if (!lost && f.state.domain.generations[0]?.status === 'PENDING') { lost = true; throw { code: 'P2002' }; } };
    await expect(f.call()).rejects.toMatchObject({ status: 409, code: 'generation_in_progress' });
    expect(lost).toBe(true); expect(f.state.domain.generations).toHaveLength(1); expect(f.state.domain.generations[0].attempts).toBe(1);
    expect(f.state.domain.wallet).toBe(5); expect(f.state.domain.credits).toEqual([]);
    expect(f.transactions.filter(row => row.ordinal > 1)).toHaveLength(2); expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce();
  });

  it('observer method is selected before the preflight await and remains bound to its owner', async () => {
    const f = await fixture(actions[5]); const selected = f.observer.observeSessionMfa;
    const replacement = vi.fn(async (_identity: MfaSessionIdentity) => null);
    f.hooks.context = ordinal => { if (ordinal === 1) f.observer.observeSessionMfa = replacement as never; };
    f.assertPositive(await f.call()); expect(selected).toHaveBeenCalledOnce(); expect(replacement).not.toHaveBeenCalled();
  });
  for (const loss of ['assignment', 'deleted-role', 'foreign-session', 'tenant-suspended'] as const) {
    it(`actual scoped authority refuses final ${loss} before policy state effects`, async () => {
      const f = await fixture(actions[5]); const before = finance(f);
      authorityEntry(f, () => {
        if (loss === 'assignment') f.state.assignmentEnabled = false;
        else if (loss === 'deleted-role') f.state.role.deletedAt = new Date();
        else if (loss === 'foreign-session') f.state.session.userId = 'foreign-actor';
        else f.state.tenant.status = 'SUSPENDED';
      });
      await expect(f.call()).rejects.toMatchObject({ status: 403 }); expect(finance(f)).toEqual(before); expect(f.committed).toEqual([]);
    });
  }
  for (const code of ['P2002', 'P2034', '40001', '55P03', 'P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028']) {
    it(`receipt classifier accepts only the finite primitive known code ${code}`, () => { expect(isOperationsReceiptRecovery({ code })).toBe(true); });
  }
  it('receipt classifier refuses arbitrary or coercible codes without invoking coercion', () => {
    const toString = vi.fn(() => 'P2002');
    expect(isOperationsReceiptRecovery({ code: { toString } })).toBe(false); expect(toString).not.toHaveBeenCalled();
    expect(isOperationsReceiptRecovery({ code: 'P2010', meta: { code: { toString } } })).toBe(false);
    expect(isOperationsReceiptRecovery(new Error('arbitrary'))).toBe(false);
    expect(isOperationsReceiptRecovery({ code: 'P2010', meta: { code: '40001' } })).toBe(true);
    expect(isOperationsReceiptRecovery({ code: 'P2010', meta: { code: '55P03' } })).toBe(true);
  });
});
