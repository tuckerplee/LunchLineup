import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionIdentity } from '@lunchlineup/api-contract';
import type { MfaSessionIdentity } from '@lunchlineup/rbac';
import { authorizeCurrentMutation, assertCurrentMutation } from '../people/mutation-authority';
import { TimeCardService } from './time-cards.service';

type Row = Record<string, any>;
type Action = 'list' | 'active' | 'get' | 'clockIn' | 'clockOut' | 'correct';
const tenantId = 'time-authority-tenant', actorId = 'time-authority-manager', workerId = 'time-authority-worker';
const actorPublicId = 'f6776d21-bb21-4c35-a6ed-5da8df5ed238';
const workerPublicId = '561c4d26-229a-4d6c-b8c6-435df1909c2d';
const locationPublicId = '34aa4812-63f5-4e5c-8b3a-06b564987a1f';
const cardPublicId = '74023f56-a8ca-441f-8d01-afbcb75892d3';
const sessionId = 'time-authority-exact-session', roleId = 'time-authority-role';
const now = '2026-10-05T20:00:00.000Z';
const permissions = ['time_cards:read', 'time_cards:write', 'users:read', 'shifts:read', 'payroll:read'];
const identity: SessionIdentity = {
  sub: actorId, tenantId, publicUserId: actorPublicId, sessionId, role: 'Manager', legacyRole: 'MANAGER',
  roles: [{ id: '79b6e4ca-1b1e-4653-aaaf-93ad20670fef', name: 'Manager', isSystem: false, legacyRole: null }],
  permissions, pinResetRequired: false, mfaRequired: true, mfaVerified: true,
};
const request = { userId: workerPublicId, locationId: locationPublicId,
  clockInAt: '2026-10-05T19:30:00.000Z', notes: 'Exact retained clock-in hash.' };
const key = 'time-current-authority-exact-clock-in';
const operationId = createHash('sha256').update(`${tenantId}:${key}`, 'utf8').digest('hex');
const expectedHash = createHash('sha256').update(JSON.stringify({ actorUserId: actorId, targetUserId: workerId,
  locationId: 'time-authority-location', shiftId: null, clockInAt: request.clockInAt, notes: request.notes }), 'utf8').digest('hex');
const clone = <T>(value: T): T => structuredClone(value);
const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
function status(error: unknown): number | undefined { return (error as { status?: number } | undefined)?.status; }

/** Closed, explicit row model. Auth state commits independently of staged domain
 * state; a stale transaction can never overwrite a committed revocation. Logical writer fences are explicit below; this
 * does not execute PostgreSQL SSI, physical locks, triggers or RLS. */
function model(action: Action) {
  const actor: Row = { id: actorId, publicId: actorPublicId, tenantId, role: 'MANAGER', name: 'Manager',
    email: null, username: 'current-manager', deletedAt: null, suspendedAt: null, lockedUntil: null,
    pinLockedUntil: null, pinResetRequired: false, mfaEnabled: true };
  const worker: Row = { ...actor, id: workerId, publicId: workerPublicId, role: 'STAFF', name: 'Worker',
    username: 'current-worker', mfaEnabled: false };
  const location: Row = { id: 'time-authority-location', publicId: locationPublicId, tenantId,
    name: 'Time Location', timezone: 'UTC', deletedAt: null };
  const role: Row = { id: roleId, publicId: identity.roles[0].id, tenantId, name: 'Manager', slug: 'manager',
    description: null, isSystem: false, isDefault: false, legacyRole: null, deletedAt: null,
    rolePermissions: permissions.map(key => ({ permission: { key } })) };
  const tenant: Row = { id: tenantId, status: 'ACTIVE', deletedAt: null, planTier: 'GROWTH',
    stripeSubscriptionId: 'sub_controlled_time', stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00Z'),
    trialEndsAt: null, usageCredits: 5, creditDebt: 0 };
  const initialCard: Row = { id: 'time-authority-card', publicId: cardPublicId, tenantId, userId: workerId,
    locationId: location.id, shiftId: null, clockInOperationId: null, clockInRequestHash: null,
    clockInAt: new Date('2026-10-05T18:00:00Z'), clockOutAt: action === 'correct' ? new Date('2026-10-05T19:00:00Z') : null,
    payrollPeriodId: 'time-authority-period', workTimeZone: 'UTC', revision: 1, breakMinutes: 0,
    notes: null, status: action === 'correct' ? 'CLOSED' : 'OPEN', deletedAt: null,
    createdAt: new Date('2026-10-05T18:00:00Z'), updatedAt: new Date('2026-10-05T18:00:00Z'),
    user: { publicId: workerPublicId, name: 'Worker', username: 'current-worker', role: 'STAFF' },
    location: { publicId: locationPublicId, name: location.name, timezone: location.timezone }, shift: null, breaks: [] };
  const state = { actor, worker, tenant, location, role,
    session: { id: sessionId, userId: actorId, createdAt: new Date('2026-10-05T19:59:00Z'),
      expiresAt: new Date('2026-10-05T21:00:00Z'), revokedAt: null as Date | null },
    setting: { security: { sessionTimeoutMinutes: 60, requireMfaForAll: true } },
    cards: action === 'clockIn' ? [] as Row[] : [initialCard], credits: [] as Row[], audits: [] as Row[] };
  const entered = deferred(), release = deferred();
  const controls = { armed: false, gate: '', gateOrdinal: 2, reached: false, loseCommitAck: false, recoveryPending: false,
    shortWall: false, shortMono: false, observerError: false, observerMissing: false,
    observerFields: {} as Row, rawObservation: null as Row | null,
    serialEffect: '', serialRemaining: 0, afterAbort: undefined as (() => void) | undefined,
    failEffect: '', failCode: '', explicitTarget: false, zeroCas: false, overlap: false, periodLocked: false };
  const selectedIdentity = clone(identity), selectedBody = clone(request);
  let controlValidation = false, ownerOrdinal = 0;
  const fenceReleased = new Set<ReturnType<typeof deferred>>();
  const observer = { observeSessionMfa: vi.fn(async (selected: MfaSessionIdentity) => {
    expect(active.size, 'Trusted observer must run outside every DB transaction').toBe(0);
    expect(selected).toEqual({ sub: actorId, tenantId, sessionId });
    await wait('observer', ownerOrdinal);
    if (controls.observerError) throw new Error('Controlled observer unavailable');
    const value = { ...selected, expiresAtEpochMs: Date.now() + (controls.shortWall ? 1000 : 120_000),
      expiresAtMonotonicMs: performance.now() + (controls.shortMono ? 1000 : 120_000), ...controls.observerFields };
    controls.rawObservation = value; return value;
  }) };
  const attempted: Row[] = [], committed: Row[] = [], transactions: Row[] = [], reached: string[] = [];
  const active = new Set<number>(), sessionFences = new Set<number>(), actorUserFences = new Set<number>(); let ordinal = 0;
  const payrollInstant = action === 'correct' ? new Date('2026-10-05T18:00:00Z') : new Date(request.clockInAt);
  async function wait(name: string, selectedOrdinal = ownerOrdinal) {
    reached.push(name);
    if (controls.armed && !controls.reached && controls.gate === name && controls.gateOrdinal === selectedOrdinal) {
      controls.reached = true; entered.release(); await release.promise;
    }
  }
  function assertSelect(input: Row, keys: readonly string[]) {
    expect(Object.keys(input).sort()).toEqual([...keys].sort());
  }
  const database: any = {
    async withTenant(selectedTenant: string, callback: (tx: any) => Promise<unknown>, options?: Row) {
      expect(selectedTenant).toBe(tenantId);
      const txId = ++ordinal, effects: Row[] = [];
      const selectedOrdinal = controlValidation ? 0 : ++ownerOrdinal;
      let cardReadCount = 0;
      const domain = clone({ cards: state.cards, credits: state.credits, audits: state.audits,
        usageCredits: state.tenant.usageCredits });
      active.add(txId); const record: Row = { txId, ownerOrdinal: selectedOrdinal, options: clone(options ?? {}), outcome: 'running', effects: [] };
      transactions.push(record);
      const effect = (name: string, input: Row) => { const row = { txId, name, input: clone(input) };
        attempted.push(row); effects.push(row); record.effects.push(name); };
      const cardFor = (where: Row) => domain.cards.find(card => {
        expect(where.tenantId).toBe(tenantId);
        return (!where.publicId || where.publicId === card.publicId)
          && (!where.userId || where.userId === card.userId)
          && (!where.user?.is?.publicId || where.user.is.publicId === card.user.publicId)
          && (typeof where.status !== 'string' || where.status === card.status)
          && (!where.status?.not || card.status !== where.status.not) && !card.deletedAt && card.tenantId === tenantId;
      });
      const sqlParts = (sql: any, bound: unknown[]) => ({
        text: (Array.isArray(sql) ? sql : sql.strings).join('').replace(/\s+/g, ' ').trim(),
        values: Array.isArray(sql) ? bound : sql.values,
      });
      await wait('contextEntry', selectedOrdinal);
      const tx: any = {
        async $queryRaw(sql: any, ...bound: unknown[]) {
          const { text, values } = sqlParts(sql, bound);
          if (text.includes('FROM "Tenant"') && text.endsWith('FOR UPDATE')) {
            expect(values).toEqual([tenantId]); await wait(Array.isArray(sql) ? 'featureTenant' : 'authorityTenant', selectedOrdinal); return [{ id: tenantId }];
          }
          if (text.includes('FROM "User"') && text.includes('"publicId" =')) {
            expect(values).toEqual([tenantId, workerPublicId, 'MANAGER', 'STAFF']);
            await wait('activeTarget'); return state.worker.deletedAt || state.worker.suspendedAt ? [] : [clone(state.worker)];
          }
          if (text.includes('FROM "User"') && text.includes('"id" IN')) {
            expect(values[0]).toBe(tenantId);
            const ids = values.slice(1); expect(ids).toEqual([...new Set(ids)].sort());
            expect(ids.every((id: string) => [actorId, workerId].includes(id))).toBe(true);
            if (ids.includes(actorId)) actorUserFences.add(txId);
            return [state.actor, state.worker].filter(user => user.tenantId === tenantId && ids.includes(user.id)).map(user => clone(user));
          }
          if (text.includes('FROM "Session"')) {
            expect(values).toEqual([sessionId, actorId]); sessionFences.add(txId); return state.session.id === sessionId && state.session.userId === actorId ? [clone(state.session)] : [];
          }
          if (text.includes('FROM "RolePermission"')) {
            expect(values).toEqual([roleId]); await wait('rolePermissions', selectedOrdinal);
            return state.role.rolePermissions.map((_: Row, i: number) => ({ roleId, permissionId: `permission-${i}` }));
          }
          if (text.includes('FROM "Role"')) { expect(values).toEqual([tenantId, roleId]); await wait('roleFence', selectedOrdinal); return [{ id: roleId }]; }
          if (text.includes('FROM "PayrollPeriod"')) {
            expect(values.slice(0, 2)).toEqual(['time-authority-period', tenantId]);
            if (text.includes('"policyVersionId"') && controls.periodLocked) return [];
            if (text.includes('"policyVersionId"')) expect(values).toEqual(['time-authority-period', tenantId, 'time-authority-policy', payrollInstant, payrollInstant]);
            await wait('periodRow'); return [{ id: 'time-authority-period', status: controls.periodLocked ? 'LOCKED' : 'OPEN',
              startsAt: new Date('2026-10-05T00:00:00Z'), endsAt: new Date('2026-10-06T00:00:00Z') }];
          }
          if (text.includes('FROM "TimeCardBreak"')) { expect(values).toEqual(['time-authority-card', tenantId]); await wait('breakRow'); return []; }
          if (text.includes('FROM "TimeCard"')) { expect(values).toEqual(['time-authority-card', tenantId]); await wait('cardRow'); return [{ id: 'time-authority-card' }]; }
          throw new Error(`Unmodeled raw query: ${text}`);
        },
        async $executeRaw(sql: any, ...bound: unknown[]) {
          const { text, values } = sqlParts(sql, bound);
          if (text === "SET LOCAL lock_timeout = '5s'") { expect(values).toEqual([]); return 0; }
          if (text.includes('pg_advisory_xact_lock')) {
            expect(values.length).toBe(1); expect([`lunchlineup:payroll:${tenantId}`, `lunchlineup:payroll:${tenantId}:time-authority-period`]).toContain(values[0]);
            await wait(values[0] === `lunchlineup:payroll:${tenantId}` ? 'payrollAdvisory' : 'periodAdvisory'); return 1;
          }
          if (text === 'LOCK TABLE "Tenant", "CreditTransaction" IN ROW EXCLUSIVE MODE') { expect(values).toEqual([]); return 0; }
          throw new Error(`Unmodeled raw execution: ${text}`);
        },
        tenant: {
          async findUnique(input: Row) { expect(input.where).toEqual({ id: tenantId }); return clone(state.tenant); },
          async findFirst(input: Row) { expect(input.where).toEqual({ id: tenantId, deletedAt: null }); return clone(state.tenant); },
          async updateMany(input: Row) {
            expect(input.where).toEqual({ id: tenantId, creditDebt: 0, usageCredits: { gte: 1 } });
            expect(input.data).toEqual({ usageCredits: { decrement: 1 } });
            if (domain.usageCredits < 1) return { count: 0 };
            effect('TenantDebit', input); domain.usageCredits--; await completeEffect('TenantDebit'); return { count: 1 };
          },
          async findUniqueOrThrow(input: Row) { expect(input.where).toEqual({ id: tenantId }); return { usageCredits: domain.usageCredits, creditDebt: 0 }; },
        },
        tenantSetting: { async findUnique(input: Row) {
          expect(input.where.tenantId_key.tenantId).toBe(tenantId);
          if (input.where.tenantId_key.key === 'workspace_settings') return { value: clone(state.setting) };
          expect(input.where.tenantId_key.key).toBe('feature_access'); return null;
        } },
        session: { async findFirst(input: Row) {
          expect(input.where).toEqual({ id: sessionId, userId: actorId }); return state.session.id === sessionId && state.session.userId === actorId ? clone(state.session) : null;
        } },
        roleAssignment: { async findMany(input: Row) {
          expect(input.where.tenantId).toBe(tenantId);
          expect(input.where.userId.in).toEqual([...new Set(input.where.userId.in)].sort());
          expect(input.where.userId.in).toContain(actorId);
          expect(input.orderBy).toEqual([{ userId: 'asc' }, { roleId: 'asc' }]);
          return [{ userId: actorId, roleId }];
        } },
        role: { async findMany(input: Row) {
          expect(input.where).toEqual({ tenantId, id: { in: [roleId] }, deletedAt: null }); await wait('roleRead', selectedOrdinal); return state.role.deletedAt ? [] : [clone(state.role)];
        } },
        user: { async findFirst(input: Row) {
          if (input.where.id) { expect(input.where).toEqual({ id: actorId, tenantId, deletedAt: null, suspendedAt: null }); return clone(state.actor); }
          expect(input.where).toEqual({ tenantId, publicId: workerPublicId, ...(input.where.role
            ? { role: { in: ['MANAGER', 'STAFF'] }, deletedAt: null, suspendedAt: null } : {}) }); if (input.where.role) { expect(input.where.role).toEqual({ in: ['MANAGER', 'STAFF'] });
            if (state.worker.deletedAt || state.worker.suspendedAt) return null; }
          return { id: workerId, publicId: workerPublicId };
        } },
        location: { async findFirst(input: Row) {
          expect(input.where).toEqual({ tenantId, publicId: locationPublicId, ...(input.where.deletedAt === null ? { deletedAt: null } : {}) });
          return clone(state.location);
        } },
        planDefinition: { async findUnique(input: Row) { expect(input.where).toEqual({ code: 'GROWTH' }); return { metadata: { features: ['time_cards'] } }; } },
        payrollPolicyVersion: { async findMany(input: Row) {
          expect(input.where).toEqual({ tenantId }); expect(input.take).toBe(100);
          return [{ id: 'time-authority-policy', version: 1, timeZone: 'UTC', effectiveFrom: new Date('2026-10-01T00:00:00Z') }];
        } },
        payrollPeriod: { async findFirst(input: Row) {
          expect(input.where).toEqual({ tenantId, policyVersionId: 'time-authority-policy', status: 'OPEN',
            startsAt: { lte: payrollInstant }, endsAt: { gt: payrollInstant } });
          return { id: 'time-authority-period' };
        } },
        timeCard: {
          async findMany(input: Row) {
            expect(input.where).toEqual({ tenantId, deletedAt: null, ...(input.where.user ? { user: { is: { publicId: controls.explicitTarget ? workerPublicId : actorPublicId } } } : {}) }); expect(input.take).toBe(2);
            expect(input.orderBy).toEqual([{ clockInAt: 'desc' }, { publicId: 'desc' }]); await wait('cardList');
            const result = clone(domain.cards.filter(card => !input.where.user || card.user.publicId === input.where.user.is.publicId)); await wait('afterCardList', selectedOrdinal); return result;
          },
          async findUnique(input: Row) {
            expect(input.where).toEqual({ clockInOperationId: operationId });
            await wait(controls.recoveryPending ? 'recoveryReplay' : 'replayRead');
            const result = clone(domain.cards.find(card => card.clockInOperationId === operationId) ?? null);
            await wait(controls.recoveryPending ? 'afterRecoveryReplay' : 'afterReplay', selectedOrdinal); return result;
          },
          async findFirst(input: Row) {
            assertSelect(input, ['where', 'select', ...(input.orderBy ? ['orderBy'] : [])]);
            if (input.where.id?.not) { expect(input.where.userId).toBe(workerId); expect(input.where.id.not).toBe('time-authority-card'); await wait('afterOverlap', selectedOrdinal); return controls.overlap ? { id: 'another-card' } : null; }
            if (input.where.publicId) expect(input.where.publicId).toBe(cardPublicId);
            if (input.where.userId) expect([workerId, actorId]).toContain(input.where.userId);
            if (input.where.user) expect(input.where.user).toEqual({ is: { publicId: workerPublicId } });
            await wait('cardRead'); const result = clone(cardFor(input.where) ?? null);
            await wait(`afterCardRead:${++cardReadCount}`, selectedOrdinal); return result;
          },
          async create(input: Row) {
            expect(input.data).toMatchObject({ tenantId, userId: workerId, locationId: location.id,
              shiftId: null, clockInOperationId: operationId, clockInRequestHash: expectedHash, clockInAt: new Date(request.clockInAt),
              payrollPeriodId: 'time-authority-period', workTimeZone: 'UTC', notes: request.notes, status: 'OPEN' });
            effect('TimeCardCreate', input);
            const row = { ...clone(initialCard), ...clone(input.data), clockOutAt: null, status: 'OPEN' };
            domain.cards.push(row); await completeEffect('TimeCardCreate'); return clone(row);
          },
          async updateMany(input: Row) {
            expect(input.where.id).toBe('time-authority-card'); expect(input.where.tenantId).toBe(tenantId);
            expect(input.where.deletedAt).toBe(null); expect(input.where.revision).toBe(1);
            if (action === 'clockOut') expect(input.where).toEqual({ id: 'time-authority-card', tenantId, deletedAt: null,
              status: 'OPEN', clockOutAt: null, revision: 1 });
            else expect(input.where).toEqual({ id: 'time-authority-card', tenantId, deletedAt: null,
              updatedAt: initialCard.updatedAt, revision: 1 });
            const card = domain.cards[0]; if (controls.zeroCas || !card || card.revision !== input.where.revision) return { count: 0 };
            effect('TimeCardUpdate', input); Object.assign(card, clone(input.data), { revision: card.revision + 1, updatedAt: new Date() }); await completeEffect('TimeCardUpdate'); return { count: 1 };
          },
        },
        timeCardBreak: {
          async deleteMany(input: Row) {
            expect(input.where).toEqual({ tenantId, timeCardId: 'time-authority-card' }); effect('BreakDelete', input); domain.cards[0].breaks = []; await completeEffect('BreakDelete'); return { count: 0 };
          },
          async createMany(input: Row) {
            expect(input.data).toEqual([{ tenantId, timeCardId: 'time-authority-card',
              startAt: new Date('2026-10-05T18:20:00Z'), endAt: new Date('2026-10-05T18:30:00Z') }]);
            effect('BreakCreate', input); domain.cards[0].breaks = input.data.map((row: Row) => ({ ...clone(row), publicId: '4257960e-356b-4109-a4f3-b8d796c23de8' })); await completeEffect('BreakCreate'); return { count: 1 };
          },
        },
        creditTransaction: {
          async findUnique(input: Row) { expect(input.where).toEqual({ id: `feature-usage-${operationId}` }); return clone(domain.credits.find(row => row.id === input.where.id) ?? null); },
          async create(input: Row) {
            expect(input.data).toEqual({ id: `feature-usage-${operationId}`, tenantId, amount: -1, debtAmount: 0,
              reason: 'Time card clock-in (time-authority-card)', balanceAfter: 4, debtAfter: 0 });
            effect('CreditCreate', input); domain.credits.push(clone(input.data)); await completeEffect('CreditCreate'); return clone(input.data);
          },
        },
        auditLog: { async create(input: Row) {
          expect(input.data).toMatchObject({ tenantId, userId: actorId, actorUserId: actorId, actorTenantId: tenantId,
            resource: 'TimeCard', resourceId: 'time-authority-card' });
          expect(['TIME_CARD_CLOCKED_IN', 'TIME_CARD_CLOCKED_OUT', 'TIME_CARD_CORRECTED']).toContain(input.data.action);
          effect('AuditCreate', input); domain.audits.push(clone(input.data)); await completeEffect('AuditCreate'); return clone(input.data);
        } },
      };
      async function completeEffect(name: string) {
        await wait('after' + name, selectedOrdinal);
        if (controls.failEffect === name) throw controls.failCode ? { code: controls.failCode } : new Error('Controlled effect failure: ' + name);
        if (controls.serialEffect === name && controls.serialRemaining > 0) {
          controls.serialRemaining--; throw { code: 'P2034' };
        }
      }
      try {
        const result = await callback(tx);
        if (effects.length) {
          state.cards = domain.cards; state.credits = domain.credits; state.audits = domain.audits;
          state.tenant.usageCredits = domain.usageCredits; committed.push(...effects);
        }
        record.outcome = 'committed';
        if (controls.loseCommitAck && effects.some(row => row.name === 'TimeCardCreate')) {
          controls.loseCommitAck = false; controls.recoveryPending = true;
          throw new Error('Controlled committed clock-in response loss');
        }
        return result;
      } catch (error) {
        if (record.outcome !== 'committed') record.outcome = 'rolled-back';
        throw error;
      } finally {
        active.delete(txId); sessionFences.delete(txId); actorUserFences.delete(txId);
        if (record.outcome === 'rolled-back' && controls.afterAbort) { const change = controls.afterAbort; controls.afterAbort = undefined; change(); }
        for (const gate of fenceReleased) gate.release();
      }
    },
  };
  const service = new TimeCardService(database, controls.observerMissing ? undefined : observer);
  async function validBefore() {
    const permission = ['list', 'active', 'get'].includes(action) ? 'time_cards:read' : 'time_cards:write';
    controlValidation = true;
    try { await database.withTenant(tenantId, async (tx: any) => {
      const authority = await authorizeCurrentMutation(tx, identity, permission);
      expect(authority.actor.id).toBe(actorId); expect(authority.identity).toEqual({ sub: actorId, tenantId, sessionId });
      expect(authority.actorAccess.permissions.has(permission)).toBe(true);
      expect(authority.actorAccess.permissions.has('users:read')).toBe(true);
      expect(authority.actorAccess.permissions.has('shifts:read')).toBe(true);
      assertCurrentMutation(authority, { sub: actorId, tenantId, sessionId,
        expiresAtEpochMs: Date.now() + 120_000, expiresAtMonotonicMs: performance.now() + 120_000 });
    });
    } finally { controlValidation = false; }
    expect(state.session.revokedAt).toBe(null); expect(committed).toEqual([]);
  }
  const selectedCorrection = { expectedUpdatedAt: initialCard.updatedAt.toISOString(),
    breakIntervals: [{ startAt: '2026-10-05T18:20:00.000Z', endAt: '2026-10-05T18:30:00.000Z' }],
    reason: 'Record verified meal break.' };
  function invoke() {
    switch (action) {
      case 'list': return service.list(selectedIdentity, { limit: '1', ...(controls.explicitTarget ? { userId: workerPublicId } : {}) });
      case 'active': return service.active(selectedIdentity, { userId: workerPublicId });
      case 'get': return service.get(selectedIdentity, cardPublicId);
      case 'clockIn': return service.clockIn(selectedIdentity, selectedBody, key);
      case 'clockOut': return service.clockOut(selectedIdentity, cardPublicId, { clockOutAt: now, breakMinutes: 0 });
      case 'correct': return service.correct(selectedIdentity, cardPublicId, selectedCorrection);
    }
  }
  function commitRevocation() {
    // A writer cannot commit under an existing actor Session FOR UPDATE fence.
    // This source-original schedule is only valid before Time owns that fence.
    expect(sessionFences.size, 'External revocation must not bypass a held exact Session lock').toBe(0);
    expect(actorUserFences.size, 'External revocation must not bypass a held actor User lock').toBe(0);
    state.session.revokedAt = new Date();
  }
  async function revokeWhenUnlocked() {
    const gate = deferred(); fenceReleased.add(gate);
    try {
      while (sessionFences.size || actorUserFences.size) await gate.promise;
      commitRevocation();
    } finally { fenceReleased.delete(gate); }
  }
  return { state, service, database, observer, selectedIdentity, selectedBody, selectedCorrection, wait,
    nextFinal: () => ownerOrdinal + 2, controls, entered, release, attempted, committed, transactions, active,
    sessionFences, actorUserFences, reached, validBefore, invoke, commitRevocation, revokeWhenUnlocked };
}

async function atWait(f: ReturnType<typeof model>, name: string, operation: () => Promise<unknown>,
  change: () => void, selectedOrdinal = f.nextFinal()) {
  f.controls.gate = name; f.controls.gateOrdinal = selectedOrdinal; f.controls.armed = true;
  const pending = operation().then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  try {
    const first = await Promise.race([f.entered.promise.then(() => 'entered'), pending.then(() => 'settled')]);
    expect(first, 'Actual owner must enter the selected wait before settling').toBe('entered');
    expect(f.active.size).toBe(name === 'observer' ? 0 : 1); expect(f.state.session.revokedAt).toBe(null);
    change(); f.release.release();
    const result = await pending;
    expect(f.active.size).toBe(0); return result;
  } finally { f.release.release(); await pending; }
}
function assertPositive(action: Action, result: any, f: ReturnType<typeof model>) {
  const names = f.committed.map(row => row.name);
  if (action === 'clockIn') {
    expect(result).toMatchObject({ reused: false, data: { id: cardPublicId, userId: workerPublicId, status: 'OPEN' } });
    expect(names).toEqual(['TimeCardCreate', 'TenantDebit', 'CreditCreate', 'AuditCreate']);
    expect(f.state.cards).toHaveLength(1); expect(f.state.tenant.usageCredits).toBe(4);
    expect(f.state.cards[0].clockInOperationId).toBe(operationId); expect(f.state.cards[0].clockInRequestHash).toBe(expectedHash);
    expect(f.state.credits).toHaveLength(1); expect(f.state.credits[0].amount).toBe(-1);
  } else if (action === 'clockOut') {
    expect(result).toMatchObject({ id: cardPublicId, status: 'CLOSED', revision: 2, clockOutAt: now });
    expect(names).toEqual(['TimeCardUpdate', 'AuditCreate']); expect(f.state.cards[0].status).toBe('CLOSED');
  } else if (action === 'correct') {
    expect(result).toMatchObject({ id: cardPublicId, status: 'CLOSED', revision: 2, breakMinutes: 10 });
    expect(result.breaks).toHaveLength(1); expect(f.state.cards[0].breaks).toHaveLength(1);
    expect(names).toEqual(['TimeCardUpdate', 'BreakDelete', 'BreakCreate', 'AuditCreate']);
  } else {
    expect(action === 'list' ? result.data[0].id : action === 'active' ? result.data.id : result.id).toBe(cardPublicId);
    expect(names).toEqual([]);
  }
  if (action !== 'clockIn') { expect(f.state.tenant.usageCredits).toBe(5); expect(f.state.credits).toEqual([]); }
}

const monotonic = { now: 1000 };
beforeEach(() => { monotonic.now = 1000; vi.spyOn(performance, 'now').mockImplementation(() => monotonic.now); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(now)); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('native Time actual owner current Session boundary baseline', () => {
  for (const action of ['list', 'active', 'get', 'clockIn', 'clockOut', 'correct'] as const) {
    const gate = action === 'active' ? 'cardRead' : ['clockIn', 'clockOut', 'correct'].includes(action) ? 'payrollAdvisory' : 'featureTenant';
    it(`${action} preserves populated valid actor and no-change owner wait control`, async () => {
      const f = model(action); await f.validBefore();
      const result = await atWait(f, gate, f.invoke, () => {});
      expect(result.error).toBeUndefined(); assertPositive(action, result.value, f);
    });
    it(`${action} refuses writer-first exact Session revocation before its final authority fence`, async () => {
      const f = model(action); await f.validBefore(); const original = clone(f.state);
      const result = await atWait(f, 'contextEntry', f.invoke, f.commitRevocation);
      const diagnostic = { action, gate, reached: f.reached, sessionRevoked: !!f.state.session.revokedAt,
        returnedSuccess: result.value !== undefined, committed: f.committed.map(row => row.name) };
      expect(status(result.error), JSON.stringify(diagnostic)).toBe(403);
      expect(f.committed).toEqual([]); expect(f.state.cards).toEqual(original.cards);
      expect(f.state.tenant.usageCredits).toBe(original.tenant.usageCredits); expect(f.state.credits).toEqual([]); expect(f.state.audits).toEqual([]);
    });
  }
  for (const revoke of [false, true]) {
    it(`clockIn early exact committed replay ${revoke ? 'refuses revoked exact Session' : 'preserves valid actor after historical target and entitlement loss'}`, async () => {
      const f = model('clockIn'); await f.validBefore(); const first = await f.invoke(); assertPositive('clockIn', first, f);
      f.state.worker.suspendedAt = new Date(); f.state.location.deletedAt = new Date(); f.state.tenant.status = 'PAST_DUE';
      const settled = clone(f.state), originalEffects = clone(f.committed); f.attempted.length = 0; f.committed.length = 0;
      const result = await atWait(f, revoke ? 'contextEntry' : 'replayRead', f.invoke, () => { if (revoke) f.commitRevocation(); });
      if (revoke) expect(status(result.error), JSON.stringify({ returned: result.value, session: f.state.session, effects: f.committed })).toBe(403);
      else { expect(result.error).toBeUndefined(); expect(result.value).toMatchObject({ reused: true, data: { id: cardPublicId } }); }
      expect(originalEffects.map(row => row.name)).toEqual(['TimeCardCreate', 'TenantDebit', 'CreditCreate', 'AuditCreate']);
      expect(f.attempted).toEqual([]); expect(f.committed).toEqual([]); expect(f.state.cards).toEqual(settled.cards);
      expect(f.state.credits).toEqual(settled.credits); expect(f.state.audits).toEqual(settled.audits); expect(f.state.tenant.usageCredits).toBe(4);
    });
    it(`clockIn committed response-loss recovery ${revoke ? 'refuses revoked exact Session without reexecuting settled effects' : 'returns exact settled receipt with one financial settlement'}`, async () => {
      const f = model('clockIn'); await f.validBefore(); f.controls.loseCommitAck = true;
      let settled: typeof f.state | undefined;
      const result = await atWait(f, revoke ? 'contextEntry' : 'recoveryReplay', f.invoke, () => {
        // The first transaction has genuinely committed and then thrown an
        // acknowledgment error. It cannot be rolled back by a later refusal.
        expect(f.committed.map(row => row.name)).toEqual(['TimeCardCreate', 'TenantDebit', 'CreditCreate', 'AuditCreate']);
        expect(f.transactions.at(-2)?.outcome).toBe('committed');
        expect(f.state.cards[0].clockInRequestHash).toBe(expectedHash);
        settled = clone(f.state); f.committed.length = 0; f.attempted.length = 0;
        if (revoke) f.commitRevocation();
      }, f.nextFinal() + 1);
      if (revoke) expect(status(result.error), JSON.stringify({ returned: result.value, session: f.state.session, effects: f.committed })).toBe(403);
      else { expect(result.error).toBeUndefined(); expect(result.value).toMatchObject({ reused: true, data: { id: cardPublicId } }); }
      expect(f.committed).toEqual([]); expect(f.attempted).toEqual([]); expect(f.state.cards).toEqual(settled!.cards);
      expect(f.state.credits).toEqual(settled!.credits); expect(f.state.audits).toEqual(settled!.audits);
      expect(f.state.tenant.usageCredits).toBe(4); expect(f.state.credits).toHaveLength(1);
    });
  }
  for (const action of ['active', 'clockOut'] as const) {
    it(`${action} preserves valid PAST_DUE recovery without a new paid entitlement or debit`, async () => {
      const f = model(action); f.state.tenant.status = 'PAST_DUE'; await f.validBefore();
      f.reached.length = 0; // Exclude the completed, separate authority-validity transaction.
      const result = await f.invoke(); assertPositive(action, result, f);
      expect(f.reached).not.toContain('featureTenant'); expect(f.state.tenant.usageCredits).toBe(5);
    });
  }
});

const actions: Action[] = ['list', 'active', 'get', 'clockIn', 'clockOut', 'correct'];
type Lifetime = 'stored' | 'effective' | 'mfa-wall' | 'mfa-monotonic';
const lifetimes: Lifetime[] = ['stored', 'effective', 'mfa-wall', 'mfa-monotonic'];
function shorten(f: ReturnType<typeof model>, axis: Lifetime) {
  if (axis === 'stored') f.state.session.expiresAt = new Date(Date.now() + 1000);
  if (axis === 'effective') {
    f.state.setting.security.sessionTimeoutMinutes = 5;
    f.state.session.createdAt = new Date(Date.now() - 5 * 60_000 + 1000);
  }
  if (axis === 'mfa-wall') f.controls.shortWall = true;
  if (axis === 'mfa-monotonic') f.controls.shortMono = true;
}
function expire(axis: Lifetime) {
  if (axis === 'mfa-monotonic') monotonic.now += 1001;
  else vi.setSystemTime(new Date(Date.now() + 1001));
}
function assertNoDomainCommit(f: ReturnType<typeof model>, original: ReturnType<typeof model>['state']) {
  expect(f.committed).toEqual([]);
  expect(f.state.cards).toEqual(original.cards);
  expect(f.state.credits).toEqual(original.credits);
  expect(f.state.audits).toEqual(original.audits);
  expect(f.state.tenant.usageCredits).toBe(original.tenant.usageCredits);
  expect(f.active.size).toBe(0);
}
const effectNames: Record<'clockIn' | 'clockOut' | 'correct', string[]> = {
  clockIn: ['TimeCardCreate', 'TenantDebit', 'CreditCreate', 'AuditCreate'],
  clockOut: ['TimeCardUpdate', 'AuditCreate'],
  correct: ['TimeCardUpdate', 'BreakDelete', 'BreakCreate', 'AuditCreate'],
};

describe('native Time current authority legal interleavings and finite lifetime', () => {
  for (const action of actions) {
    it(`${action} holds its actor fences through the domain wait and lets a competing writer commit afterwards`, async () => {
      const f = model(action); await f.validBefore();
      const gate = action === 'active' ? 'cardRead' : ['clockIn', 'clockOut', 'correct'].includes(action) ? 'payrollAdvisory' : 'featureTenant';
      let writer: Promise<void> | undefined;
      const result = await atWait(f, gate, f.invoke, () => {
        expect(f.sessionFences.size).toBe(1); expect(f.actorUserFences.size).toBe(1);
        writer = f.revokeWhenUnlocked();
        expect(f.state.session.revokedAt).toBeNull();
      });
      expect(result.error).toBeUndefined(); assertPositive(action, result.value, f);
      await writer; expect(f.state.session.revokedAt).not.toBeNull();
      const settled = clone(f.state); f.committed.length = 0; f.attempted.length = 0;
      await expect(f.invoke()).rejects.toMatchObject({ status: 403 });
      assertNoDomainCommit(f, settled); expect(f.attempted).toEqual([]);
    });
    const losses: Array<[string, (f: ReturnType<typeof model>) => void]> = [
      ['workspace suspended', f => { f.state.tenant.status = 'SUSPENDED'; }],
      ['workspace deleted', f => { f.state.tenant.deletedAt = new Date(); }],
      ['actor suspended', f => { f.state.actor.suspendedAt = new Date(); }],
      ['actor temporary PIN required', f => { f.state.actor.pinResetRequired = true; }],
      ['exact Session owner changed', f => { f.state.session.userId = workerId; }],
      ['current required grant removed', f => {
        const required = ['list', 'active', 'get'].includes(action) ? 'time_cards:read' : 'time_cards:write';
        f.state.role.rolePermissions = f.state.role.rolePermissions.filter((row: Row) => row.permission.key !== required);
      }],
    ];
    for (const [loss, change] of losses) {
      it(`${action} refuses writer-first ${loss} despite valid original request claims`, async () => {
        const f = model(action); await f.validBefore(); const original = clone(f.state);
        const result = await atWait(f, 'contextEntry', f.invoke, () => change(f));
        expect(status(result.error)).toBe(403); expect(f.attempted).toEqual([]); assertNoDomainCommit(f, original);
        expect(f.observer.observeSessionMfa).toHaveBeenCalledTimes(1);
      });
    }
    for (const axis of lifetimes) {
      it(`${action} denies ${axis} expiry after the final current RolePermission wait`, async () => {
        const f = model(action); await f.validBefore(); shorten(f, axis); const original = clone(f.state);
        const result = await atWait(f, 'rolePermissions', f.invoke, () => expire(axis));
        expect(status(result.error)).toBe(403); expect(f.attempted).toEqual([]); assertNoDomainCommit(f, original);
        expect(f.observer.observeSessionMfa).toHaveBeenCalledTimes(1);
      });
    }
  }
  for (const action of ['clockIn', 'clockOut', 'correct'] as const) {
    const payrollGates = action === 'clockIn'
      ? ['payrollAdvisory', 'periodAdvisory', 'periodRow']
      : ['payrollAdvisory', 'periodAdvisory', 'periodRow', 'cardRow', 'breakRow'];
    for (const gate of payrollGates) for (const axis of lifetimes) {
      it(`${action} checks ${axis} after the reached ${gate} payroll wait before any effect`, async () => {
        const f = model(action); await f.validBefore(); shorten(f, axis); const original = clone(f.state);
        const result = await atWait(f, gate, f.invoke, () => expire(axis));
        expect(status(result.error)).toBe(403); expect(f.attempted).toEqual([]); assertNoDomainCommit(f, original);
      });
    }
    for (const [index, effect] of effectNames[action].entries()) {
      for (const axis of lifetimes) {
        it(`${action} rolls back the exact attempted prefix after ${effect} await crosses ${axis}`, async () => {
          const f = model(action); await f.validBefore(); shorten(f, axis); const original = clone(f.state);
          const result = await atWait(f, 'after' + effect, f.invoke, () => expire(axis));
          expect(status(result.error)).toBe(403);
          expect(f.attempted.map(row => row.name)).toEqual(effectNames[action].slice(0, index + 1));
          assertNoDomainCommit(f, original); expect(f.observer.observeSessionMfa).toHaveBeenCalledTimes(1);
        });
      }
      it(`${action} preserves domain rollback when ${effect} itself rejects`, async () => {
        const f = model(action); await f.validBefore(); const original = clone(f.state);
        f.controls.failEffect = effect;
        await expect(f.invoke()).rejects.toThrow('Controlled effect failure: ' + effect);
        expect(f.attempted.map(row => row.name)).toEqual(effectNames[action].slice(0, index + 1));
        assertNoDomainCommit(f, original);
      });
    }
  }
  const returnGates: Array<[Action, string]> = [
    ['list', 'afterCardList'], ['active', 'afterCardRead:1'], ['get', 'afterCardRead:1'],
    ['clockOut', 'afterCardRead:3'], ['correct', 'afterCardRead:3'],
  ];
  for (const [action, gate] of returnGates) for (const axis of lifetimes) {
    it(`${action} refuses ${axis} expiry after its final protected row read`, async () => {
      const f = model(action); await f.validBefore(); shorten(f, axis); const original = clone(f.state);
      const result = await atWait(f, gate, f.invoke, () => expire(axis));
      expect(status(result.error)).toBe(403); assertNoDomainCommit(f, original);
      expect(f.observer.observeSessionMfa).toHaveBeenCalledTimes(1);
    });
  }
  for (const replay of ['early', 'recovery'] as const) for (const axis of lifetimes) {
    it(`clockIn ${replay} receipt refuses ${axis} expiry without undoing an earlier settlement`, async () => {
      const f = model('clockIn'); await f.validBefore();
      if (replay === 'early') await f.invoke(); else f.controls.loseCommitAck = true;
      shorten(f, axis); f.committed.length = 0; f.attempted.length = 0;
      let settled: typeof f.state | undefined;
      const result = await atWait(f, replay === 'early' ? 'afterReplay' : 'afterRecoveryReplay', f.invoke, () => {
        settled = clone(f.state); expect(settled.cards).toHaveLength(1); expect(settled.tenant.usageCredits).toBe(4);
        f.committed.length = 0; f.attempted.length = 0; expire(axis);
      }, f.nextFinal() + (replay === 'recovery' ? 1 : 0));
      expect(status(result.error)).toBe(403); expect(f.attempted).toEqual([]); assertNoDomainCommit(f, settled!);
      // Each separate request observes once; recovery never renews its proof.
      expect(f.observer.observeSessionMfa).toHaveBeenCalledTimes(replay === 'early' ? 2 : 1);
    });
  }
  for (const axis of lifetimes) {
    it(`shared Time callback final guard refuses ${axis} after an otherwise empty callback await`, async () => {
      const f = model('active'); await f.validBefore(); shorten(f, axis); const original = clone(f.state);
      // Direct private seam isolates final-callback coverage, not a catalog action.
      const scope = await (f.service as any).prepare(identity, 'time_cards:read');
      const result = await atWait(f, 'callbackReturn', () => scope.run(async () => {
        await f.wait('callbackReturn'); return 'unprotected-result';
      }), () => expire(axis), 2);
      expect(status(result.error)).toBe(403); assertNoDomainCommit(f, original);
    });
  }
});

describe('native Time same-proof retries, current scope and observer custody', () => {
  for (const action of ['clockIn', 'clockOut', 'correct'] as const) {
    for (const outcome of ['valid', 'revoked', 'proof-expired'] as const) {
      it(`${action} serialization retry ${outcome} re-reads authority with the original single MFA observation`, async () => {
        const f = model(action); await f.validBefore(); const original = clone(f.state);
        f.controls.serialEffect = effectNames[action][0]; f.controls.serialRemaining = 1;
        if (outcome === 'revoked') f.controls.afterAbort = f.commitRevocation;
        if (outcome === 'proof-expired') { f.controls.shortMono = true; f.controls.afterAbort = () => expire('mfa-monotonic'); }
        if (outcome === 'valid') {
          const result = await f.invoke(); assertPositive(action, result, f);
          expect(f.attempted.map(row => row.name)).toEqual([effectNames[action][0], ...effectNames[action]]);
        } else { await expect(f.invoke()).rejects.toMatchObject({ status: 403 }); assertNoDomainCommit(f, original); }
        expect(f.observer.observeSessionMfa).toHaveBeenCalledTimes(1);
        expect(f.transactions.filter(row => row.outcome === 'rolled-back').length).toBeGreaterThanOrEqual(1);
      });
    }
  }
  for (const action of actions) {
    it(`${action} derives team scope from current grants instead of stale identity permissions`, async () => {
      const f = model(action); await f.validBefore(); f.controls.explicitTarget = true; const original = clone(f.state);
      const result = await atWait(f, 'contextEntry', f.invoke, () => {
        f.state.role.rolePermissions = f.state.role.rolePermissions.filter((row: Row) => row.permission.key !== 'shifts:read');
      });
      expect(status(result.error)).toBe(action === 'get' ? 404 : 403);
      const codes: Record<Action, string> = { list: 'time_card_scope_denied', active: 'time_card_scope_denied',
        get: 'time_card_not_found', clockIn: 'time_card_scope_denied', clockOut: 'manual_clock_time_denied',
        correct: 'time_card_correction_denied' };
      expect(result.error).toMatchObject({ code: codes[action] });
      expect(f.attempted).toEqual([]); assertNoDomainCommit(f, original);
    });
  }
  const invalidProofs: Array<[string, Row]> = [
    ['wrong actor', { sub: workerId }], ['wrong tenant', { tenantId: 'other-tenant' }], ['wrong Session', { sessionId: 'other-session' }],
    ['expired wall', { expiresAtEpochMs: Date.parse(now) }], ['expired monotonic', { expiresAtMonotonicMs: 1000 }],
    ['nonfinite wall', { expiresAtEpochMs: Infinity }], ['nonfinite monotonic', { expiresAtMonotonicMs: NaN }],
    ['future fractional wall', { expiresAtEpochMs: Date.parse(now) + 1000.5 }],
  ];
  for (const [label, fields] of invalidProofs) {
    it(`denies ${label} observer proof before opening its final transaction`, async () => {
      const f = model('clockIn'); await f.validBefore(); const original = clone(f.state); f.controls.observerFields = fields;
      if (label === 'future fractional wall') { expect(fields.expiresAtEpochMs).toBeGreaterThan(Date.now()); expect(Number.isInteger(fields.expiresAtEpochMs)).toBe(false); }
      await expect(f.invoke()).rejects.toMatchObject({ status: 403 }); assertNoDomainCommit(f, original);
      expect(f.transactions.filter(row => row.ownerOrdinal > 0)).toHaveLength(1);
    });
  }
  it('missing trusted observer capability fails closed without domain effects', async () => {
    const f = model('clockIn'); await f.validBefore(); const original = clone(f.state);
    (f.observer as any).observeSessionMfa = undefined;
    await expect(f.invoke()).rejects.toMatchObject({ status: 503 }); assertNoDomainCommit(f, original);
  });
  it('trusted observer failure fails closed outside DB without domain effects', async () => {
    const f = model('clockIn'); await f.validBefore(); const original = clone(f.state); f.controls.observerError = true;
    await expect(f.invoke()).rejects.toMatchObject({ status: 503 }); assertNoDomainCommit(f, original);
  });
  it('copied original MFA observation cannot be renewed by mutating the observer result during an effect wait', async () => {
    const f = model('clockIn'); await f.validBefore(); f.controls.shortMono = true; const original = clone(f.state);
    const result = await atWait(f, 'afterTimeCardCreate', f.invoke, () => {
      expect(f.controls.rawObservation).not.toBeNull(); f.controls.rawObservation!.expiresAtMonotonicMs += 120_000;
      expire('mfa-monotonic');
    });
    expect(status(result.error)).toBe(403); assertNoDomainCommit(f, original);
  });
  it('captures the trusted observer method before its preflight wait', async () => {
    const f = model('clockIn'); await f.validBefore(); const originalObserver = f.observer.observeSessionMfa;
    const replacement = vi.fn(async () => { throw new Error('Replacement capability must not be adopted'); });
    const result = await atWait(f, 'authorityTenant', f.invoke, () => { f.observer.observeSessionMfa = replacement; }, 1);
    expect(result.error).toBeUndefined(); assertPositive('clockIn', result.value, f);
    expect(originalObserver).toHaveBeenCalledTimes(1); expect(replacement).not.toHaveBeenCalled();
  });
  for (const action of ['clockIn', 'correct'] as const) {
    it(`${action} freezes submitted actor and request values before the external observer await`, async () => {
      const f = model(action); await f.validBefore();
      const result = await atWait(f, 'observer', f.invoke, () => {
        f.selectedIdentity.sub = workerId; f.selectedIdentity.tenantId = 'foreign'; f.selectedIdentity.sessionId = 'foreign';
        f.selectedIdentity.permissions.length = 0; f.selectedBody.notes = 'Mutated later notes'; f.selectedBody.userId = actorPublicId;
        f.selectedCorrection.breakIntervals[0].endAt = '2026-10-05T18:59:00.000Z';
      }, 1);
      expect(result.error).toBeUndefined(); assertPositive(action, result.value, f);
      expect(f.observer.observeSessionMfa).toHaveBeenCalledTimes(1);
    });
  }
  it('does not consult MFA storage for an actor with no current enrollment, policy or privileged grant', async () => {
    const f = model('active'); await f.validBefore(); f.state.actor.mfaEnabled = false;
    f.state.setting.security.requireMfaForAll = false;
    f.state.role.rolePermissions = f.state.role.rolePermissions.filter((row: Row) => ['time_cards:read', 'time_cards:write', 'users:read', 'shifts:read'].includes(row.permission.key));
    const result = await f.invoke(); assertPositive('active', result, f); expect(f.observer.observeSessionMfa).not.toHaveBeenCalled();
  });
  for (const action of actions) for (const source of ['workspace policy', 'actor enrollment', 'privileged grant'] as const) {
    it(`${action} refuses newly required MFA from ${source} with the original null proof`, async () => {
      const f = model(action);
      f.state.actor.mfaEnabled = false; f.state.setting.security.requireMfaForAll = false;
      f.state.role.rolePermissions = f.state.role.rolePermissions.filter((row: Row) => row.permission.key !== 'payroll:read');
      await f.validBefore(); const original = clone(f.state);
      const result = await atWait(f, 'contextEntry', f.invoke, () => {
        expect(f.actorUserFences.size).toBe(0); expect(f.sessionFences.size).toBe(0);
        expect(f.observer.observeSessionMfa).not.toHaveBeenCalled(); expect(f.controls.rawObservation).toBeNull();
        if (source === 'workspace policy') f.state.setting.security.requireMfaForAll = true;
        if (source === 'actor enrollment') f.state.actor.mfaEnabled = true;
        if (source === 'privileged grant') f.state.role.rolePermissions.push({ permission: { key: 'payroll:read' } });
      });
      expect(result.error).toMatchObject({ status: 403, code: 'mfa_verification_required' });
      expect(f.observer.observeSessionMfa).not.toHaveBeenCalled(); expect(f.controls.rawObservation).toBeNull();
      expect(f.attempted).toEqual([]); assertNoDomainCommit(f, original);
    });
  }
  for (const action of ['clockOut', 'correct'] as const) {
    it(`${action} retains historical inactive target recovery under a currently valid actor`, async () => {
      const f = model(action); await f.validBefore(); f.state.worker.deletedAt = new Date(); f.state.worker.suspendedAt = new Date();
      const result = await f.invoke(); assertPositive(action, result, f);
    });
    it(`${action} preserves zero CAS conflict with no staged financial effects`, async () => {
      const f = model(action); await f.validBefore(); const original = clone(f.state); f.controls.zeroCas = true;
      await expect(f.invoke()).rejects.toMatchObject({ status: 409 }); expect(f.attempted).toEqual([]); assertNoDomainCommit(f, original);
    });
    it(`${action} preserves locked payroll period conflict before card effects`, async () => {
      const f = model(action); await f.validBefore(); const original = clone(f.state); f.controls.periodLocked = true;
      await expect(f.invoke()).rejects.toMatchObject({ status: 409 }); expect(f.attempted).toEqual([]); assertNoDomainCommit(f, original);
    });
  }
  it('clockIn new creation still refuses an inactive target instead of adopting replay eligibility', async () => {
    const f = model('clockIn'); await f.validBefore(); f.state.worker.suspendedAt = new Date(); const original = clone(f.state);
    await expect(f.invoke()).rejects.toMatchObject({ status: 422 }); expect(f.attempted).toEqual([]); assertNoDomainCommit(f, original);
  });
  it('clockIn unique collision with no exact durable receipt retains its open-card validation error', async () => {
    const f = model('clockIn'); await f.validBefore(); const original = clone(f.state); f.controls.failEffect = 'TimeCardCreate'; f.controls.failCode = 'P2002';
    await expect(f.invoke()).rejects.toMatchObject({ status: 422 }); assertNoDomainCommit(f, original);
    expect(f.observer.observeSessionMfa).toHaveBeenCalledTimes(1);
  });
  it('clockIn exact operation key with a different retained financial hash is a conflict without a second settlement', async () => {
    const f = model('clockIn'); await f.validBefore(); await f.invoke(); f.state.cards[0].clockInRequestHash = 'different-retained-hash';
    const original = clone(f.state); f.committed.length = 0; f.attempted.length = 0;
    await expect(f.invoke()).rejects.toMatchObject({ status: 409 }); expect(f.attempted).toEqual([]); assertNoDomainCommit(f, original);
  });
  it('correct preserves overlap conflict and does not stage correction, break replacement or audit', async () => {
    const f = model('correct'); await f.validBefore(); const original = clone(f.state); f.controls.overlap = true;
    await expect(f.invoke()).rejects.toMatchObject({ status: 409 }); expect(f.attempted).toEqual([]); assertNoDomainCommit(f, original);
  });
});


describe('C04 original request policy cap regression', () => {
  it('time retains original cap across payroll waits, but a fresh request may use the longer policy', async () => {
    const f = model('clockIn'); await f.validBefore(); shorten(f, 'effective');
    const original = clone(f.state), observe = f.observer.observeSessionMfa.getMockImplementation()!;
    f.observer.observeSessionMfa.mockImplementation(async selected => {
      const proof = await observe(selected); f.state.setting.security.sessionTimeoutMinutes = 480; return proof;
    });
    const result = await atWait(f, 'payrollAdvisory', f.invoke, () => expire('effective'));
    expect(result.error).toMatchObject({ status: 403, code: 'permission_denied' });
    expect(f.attempted).toEqual([]); assertNoDomainCommit(f, original);
    expect(f.observer.observeSessionMfa).toHaveBeenCalledTimes(1);
    assertPositive('clockIn', await f.invoke(), f);
    expect(f.observer.observeSessionMfa).toHaveBeenCalledTimes(2);
  });
  it('time still enforces a stricter current cap within the original lifetime', async () => {
    const f = model('clockIn'); await f.validBefore();
    f.state.session.createdAt = new Date(Date.now() - 10 * 60_000);
    const original = clone(f.state);
    const result = await atWait(f, 'observer', f.invoke, () => {
      f.state.setting.security.sessionTimeoutMinutes = 5;
    }, 1);
    expect(result.error).toMatchObject({ status: 403, code: 'permission_denied' });
    expect(f.attempted).toEqual([]); assertNoDomainCommit(f, original);
  });
  it('time serialization retry and committed replay cannot renew the original policy cap', async () => {
    const f = model('clockIn'); await f.validBefore(); shorten(f, 'effective');
    const original = clone(f.state);
    f.controls.serialEffect = 'TimeCardCreate'; f.controls.serialRemaining = 1;
    f.controls.afterAbort = () => { f.state.setting.security.sessionTimeoutMinutes = 480; expire('effective'); };
    await expect(f.invoke()).rejects.toMatchObject({ status: 403, code: 'permission_denied' });
    expect(f.attempted).toHaveLength(1); assertNoDomainCommit(f, original);
    expect(f.observer.observeSessionMfa).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(now));
    const replay = model('clockIn'); await replay.validBefore(); await replay.invoke();
    replay.committed.length = 0; replay.attempted.length = 0;
    shorten(replay, 'effective'); const saved = clone(replay.state);
    const observe = replay.observer.observeSessionMfa.getMockImplementation()!;
    replay.observer.observeSessionMfa.mockImplementation(async selected => {
      const proof = await observe(selected); replay.state.setting.security.sessionTimeoutMinutes = 480; return proof;
    });
    const result = await atWait(replay, 'contextEntry', replay.invoke, () => expire('effective'));
    expect(result.error).toMatchObject({ status: 403, code: 'permission_denied' });
    expect(replay.attempted).toEqual([]); assertNoDomainCommit(replay, saved);
    expect(replay.observer.observeSessionMfa).toHaveBeenCalledTimes(2);
  });
});
