import { performance } from 'node:perf_hooks';
import type { SessionIdentity } from '@lunchlineup/api-contract';
import type { MfaSessionIdentity } from '@lunchlineup/rbac';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authorizeCurrentMutation, assertCurrentMutation } from '../people/mutation-authority';
import { PayrollService } from './payroll.service';

const ids = { tenant: 'payroll-authority-tenant', actor: 'payroll-authority-actor',
  session: 'payroll-authority-session', role: 'payroll-authority-role',
  publicActor: '560bb8a3-e716-4813-b224-bdba666a91af' };
type Row = Record<string, any>;
const copy = <T>(value: T): T => structuredClone(value);
const gate = () => { let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const flatten = (values: unknown[]): unknown[] => values.flatMap(value => value && typeof value === 'object'
  && 'values' in value ? flatten((value as { values: unknown[] }).values) : [value]);
const policy = { timeZone: 'America/Los_Angeles', cadence: 'WEEKLY' as const,
  anchorDate: '2026-09-28', effectiveFrom: '2026-09-28' };

// This adapter models reads, exact selectors, staged writes and rollback. It
// does not mock an authorization result or run PostgreSQL/Redis. The original
// DB-only owner ignores the supplied observer; the authority reader itself is
// exercised independently below so a fabricated denial cannot make the test pass.
function fixture() {
  let state = {
    tenant: { id: ids.tenant, status: 'ACTIVE', deletedAt: null },
    actor: { id: ids.actor, tenantId: ids.tenant, publicId: ids.publicActor, role: 'ADMIN',
      name: 'Payroll administrator', email: null, username: 'payroll.admin', deletedAt: null,
      suspendedAt: null, lockedUntil: null, pinLockedUntil: null, pinResetRequired: false, mfaEnabled: false },
    session: { id: ids.session, userId: ids.actor, createdAt: new Date(Date.now() - 29 * 60_000),
      expiresAt: new Date(Date.now() + 60 * 60_000), revokedAt: null as Date | null },
    security: { sessionTimeoutMinutes: 30, requireMfaForAll: false },
    role: { id: ids.role, tenantId: ids.tenant, publicId: '560bb8a3-e716-4813-b224-bdba666a91b0',
      name: 'Payroll administrator', slug: 'payroll-admin', description: null, isSystem: true,
      isDefault: false, legacyRole: 'ADMIN', deletedAt: null,
      rolePermissions: [{ permission: { key: 'payroll:policy_write' } }] },
    policies: [] as Row[], audits: [] as Row[],
  };
  const identity: SessionIdentity = { sub: ids.actor, tenantId: ids.tenant, sessionId: ids.session,
    publicUserId: ids.publicActor, role: 'ADMIN', legacyRole: 'ADMIN', roles: [],
    permissions: ['payroll:policy_write'], pinResetRequired: false, mfaRequired: true, mfaVerified: true };
  const attempted: Row[] = [], committed: Row[] = [], locks: string[] = [];
  const entered = gate(), released = gate();
  const controls = { active: 0, pauseAdvisory: false, entered: false };
  const observer = { observeSessionMfa: vi.fn(async (actor: MfaSessionIdentity) => {
    expect(controls.active).toBe(0);
    expect(actor).toEqual({ sub: ids.actor, tenantId: ids.tenant, sessionId: ids.session });
    return { ...actor, expiresAtEpochMs: Date.now() + 120_000,
      expiresAtMonotonicMs: performance.now() + 120_000 };
  }) };
  const withTenant = vi.fn(async (tenantId: string, operation: (tx: any) => Promise<any>, options?: Row) => {
    expect(tenantId).toBe(ids.tenant); expect(controls.active).toBe(0);
    if (options) expect(options.isolationLevel).toBe('Serializable');
    controls.active++;
    const staged = copy(state), pending: Row[] = [];
    const effect = (table: string, args: Row) => { const item = { table, args: copy(args) };
      attempted.push(item); pending.push(item); };
    const tx: any = {
      $queryRaw: async (sql: any, ...bound: unknown[]) => {
        const text = (Array.isArray(sql) ? sql : sql.strings).join('');
        const values = flatten(Array.isArray(sql) ? bound : sql.values);
        if (text.includes('set_config')) {
          expect(text).toContain("'lock_timeout'"); expect(text).toContain("'statement_timeout'"); return [{}];
        }
        expect(text).toContain('FOR UPDATE');
        if (text.includes('FROM "Tenant"')) { expect(values).toEqual([ids.tenant]); locks.push('Tenant'); return [{ id: ids.tenant }]; }
        if (text.includes('FROM "User"')) { expect(values).toEqual([ids.tenant, ids.actor]); locks.push('User'); return [copy(staged.actor)]; }
        if (text.includes('FROM "Session"')) { expect(values).toEqual([ids.session, ids.actor]); locks.push('Session'); return [copy(staged.session)]; }
        if (text.includes('FROM "RolePermission"')) { expect(values).toEqual([ids.role]); locks.push('RolePermission');
          return [{ roleId: ids.role, permissionId: 'permission-payroll-policy' }]; }
        if (text.includes('FROM "Role"')) { expect(values).toEqual([ids.tenant, ids.role]); locks.push('Role'); return [{ id: ids.role }]; }
        throw new Error('Unmodeled raw read: ' + text);
      },
      $executeRaw: async (sql: any, ...bound: unknown[]) => {
        const text = (Array.isArray(sql) ? sql : sql.strings).join('');
        const values = flatten(Array.isArray(sql) ? bound : sql.values);
        expect(text).toContain('pg_advisory_xact_lock');
        expect(values).toEqual(['lunchlineup:payroll:' + ids.tenant]); locks.push('Payroll');
        if (controls.pauseAdvisory && !controls.entered) {
          controls.entered = true; entered.release(); await released.promise;
        }
        return 1;
      },
      tenant: { findUnique: async ({ where }: Row) => { expect(where).toEqual({ id: ids.tenant }); return copy(staged.tenant); } },
      user: {
        findMany: async (args: Row) => { expect(args).toEqual({ where: { tenantId: ids.tenant, id: { in: [ids.actor] } },
          select: { id: true, publicId: true } }); return [{ id: ids.actor, publicId: ids.publicActor }]; },
        findFirst: async ({ where }: Row) => { expect(where).toEqual({ id: ids.actor, tenantId: ids.tenant, deletedAt: null, suspendedAt: null }); return copy(staged.actor); },
      },
      session: { findFirst: async ({ where }: Row) => { expect(where).toEqual({ id: ids.session, userId: ids.actor }); return copy(staged.session); } },
      tenantSetting: { findUnique: async ({ where }: Row) => { expect(where).toEqual({ tenantId_key: { tenantId: ids.tenant, key: 'workspace_settings' } });
        return { value: { security: copy(staged.security) } }; } },
      roleAssignment: { findMany: async (args: Row) => { expect(args).toEqual({ where: { tenantId: ids.tenant, userId: { in: [ids.actor] } },
        select: { userId: true, roleId: true }, orderBy: [{ userId: 'asc' }, { roleId: 'asc' }] });
        locks.push('RoleAssignment'); return [{ userId: ids.actor, roleId: ids.role }]; } },
      role: { findMany: async ({ where }: Row) => { expect(where).toEqual({ tenantId: ids.tenant, id: { in: [ids.role] }, deletedAt: null }); return [copy(staged.role)]; } },
      payrollPolicyVersion: {
        findUnique: async ({ where }: Row) => { expect(Object.keys(where)).toEqual(['operationId']);
          return copy(staged.policies.find(row => row.operationId === where.operationId) ?? null); },
        findFirst: async (args: Row) => { expect(args).toEqual({ where: { tenantId: ids.tenant }, orderBy: [{ version: 'desc' }, { publicId: 'desc' }] });
          return copy(staged.policies.at(-1) ?? null); },
        create: async (args: Row) => { expect(args.data.tenantId).toBe(ids.tenant); expect(args.data.createdByUserId).toBe(ids.actor);
          effect('policy', args); const row = { ...copy(args.data), id: 'policy-internal', publicId: '560bb8a3-e716-4813-b224-bdba666a91b1', createdAt: new Date() };
          staged.policies.push(row); return copy(row); },
      },
      auditLog: { create: async (args: Row) => { expect(args.data.tenantId).toBe(ids.tenant);
        expect(args.data.actorUserId).toBe(ids.actor); effect('audit', args); staged.audits.push(copy(args.data)); return copy(args.data); } },
    };
    try { const result = await operation(tx); state = staged; committed.push(...pending); return result; }
    finally { controls.active--; }
  });
  // Append-only constructor seam supports the proposed lifecycle-owned observer.
  const Owner = PayrollService as unknown as new (db: any, mfaObserver?: typeof observer) => PayrollService;
  const owner = new Owner({ withTenant }, observer);
  return { owner, identity, withTenant, observer, controls, entered, released, attempted, committed, locks,
    state: () => state, snapshot: () => copy(state),
    async authority() { return withTenant(ids.tenant, tx => authorizeCurrentMutation(tx, identity, 'payroll:policy_write')); },
    create() { return owner.createPolicy(identity, policy, 'policy-authority-key'); } };
}

describe('native payroll current authority: actual policy owner initial counterexamples', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-04T20:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('creates one valid policy and audit then replays the exact saved response without another write', async () => {
    const f = fixture(); const result = await f.create(); const replay = await f.create();
    expect(result).toEqual(replay); expect(result).toMatchObject({ version: 1, ...policy, createdByUserId: ids.publicActor });
    expect(f.state().policies).toHaveLength(1); expect(f.state().audits).toHaveLength(1);
    expect(f.committed.map(item => item.table)).toEqual(['policy', 'audit']);
    expect(f.state().audits[0]).toMatchObject({ action: 'PAYROLL_POLICY_VERSION_CREATED', resourceId: 'policy-internal', newValue: result });
  });

  it('reads real ordered current authority and rejects a revoked exact session in that reader', async () => {
    const f = fixture(); const authority = await f.authority();
    expect(authority.actorAccess.permissions.has('payroll:policy_write')).toBe(true);
    expect(authority.requiresMfa).toBe(true);
    const observation = await f.observer.observeSessionMfa(authority.identity); assertCurrentMutation(authority, observation);
    expect(f.locks).toEqual(['Tenant', 'User', 'Session', 'RoleAssignment', 'Role', 'RolePermission']);
    f.state().session.revokedAt = new Date();
    await expect(f.authority()).rejects.toMatchObject({ status: 403, code: 'permission_denied' });
    expect(f.attempted).toEqual([]); expect(f.committed).toEqual([]);
  });

  it('refuses a stale route identity whose exact session was revoked before the owner call without policy or audit writes', async () => {
    const f = fixture(); f.state().session.revokedAt = new Date(); const before = f.snapshot();
    const outcome = await f.create().then(value => ({ value }), error => ({ error }));
    expect(outcome).toMatchObject({ error: { status: 403, code: 'permission_denied' } });
    expect(f.attempted).toEqual([]); expect(f.committed).toEqual([]); expect(f.state()).toEqual(before);
  });

  it('refuses policy-effective expiry crossed while awaiting the actual payroll advisory lock and rolls back all effects', async () => {
    const f = fixture(); f.controls.pauseAdvisory = true; const before = f.snapshot();
    const request = f.create().then(value => ({ value }), error => ({ error }));
    try { await Promise.race([f.entered.promise, request.then(() => { throw new Error('Owner settled before domain lock gate'); })]);
      vi.setSystemTime(new Date(Date.now() + 60_001));
    } finally { f.released.release(); }
    const outcome = await request;
    expect(outcome).toMatchObject({ error: { status: 403, code: 'permission_denied' } });
    expect(f.state().session.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(f.attempted).toEqual([]); expect(f.committed).toEqual([]); expect(f.state()).toEqual(before);
  });
});

// Populated all-command owner model. Every exposed delegate/SQL branch below
// is explicit; an unknown method or statement fails. Helpers and the owner are
// real imports, including settlement, snapshot, CSV and replay integrity logic.
const actions = ['createPolicy', 'createPeriod', 'startReview', 'adoptCards', 'decideCards', 'lockPeriod',
  'createAmendment', 'decideAmendment', 'createExport', 'downloadExport', 'reconcileExport'] as const;
type Action = typeof actions[number];
const grants = ['payroll:policy_write', 'payroll:lock', 'time_cards:approve', 'payroll:export', 'payroll:reconcile'];
const uuid = (n: number) => '560bb8a3-e716-4813-b224-' + n.toString(16).padStart(12, '0');
const mono = { now: 1000 };
type Axis = 'stored' | 'effective' | 'mfaWall' | 'mfaMonotonic';
const axes: Axis[] = ['stored', 'effective', 'mfaWall', 'mfaMonotonic'];
function matchesPayroll(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return value.some((item: Row) => matchesPayroll(row, item));
    if (key === 'AND') return value.every((item: Row) => matchesPayroll(row, item));
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if (key.includes('_') && !('in' in value)) return matchesPayroll(row, value);
      return Object.entries(value).every(([op, wanted]: [string, any]) => {
        if (op === 'in') return wanted.includes(row[key]);
        if (op === 'not') return row[key] !== wanted;
        if (op === 'lt') return row[key] < wanted;
        if (op === 'lte') return row[key] <= wanted;
        if (op === 'gt') return row[key] > wanted;
        if (op === 'gte') return row[key] >= wanted;
        throw new Error('Unmodeled payroll scalar selector: ' + key + ':' + op);
      });
    }
    return value instanceof Date ? row[key]?.getTime() === value.getTime() : row[key] === value;
  });
}
function updatePayroll(row: Row, data: Row) {
  for (const [key, value] of Object.entries(data)) row[key] = value && typeof value === 'object' && 'increment' in value
    ? row[key] + value.increment : value && typeof value === 'object' && 'decrement' in value
      ? row[key] - value.decrement : copy(value);
}
function populate(action: Action) {
  const sourceId = 'period-source', adjustmentId = 'period-adjustment', cardId = 'card-employee';
  const employeeId = 'payroll-employee', requesterId = 'payroll-requester';
  const period = (id: string, publicId: string, start: string, status: string): Row => ({ id, publicId,
    tenantId: ids.tenant, policyVersionId: 'policy-internal', localStartDate: new Date(start),
    localEndDateExclusive: new Date(new Date(start).getTime() + 7 * 86400_000), startsAt: new Date(start),
    endsAt: new Date(new Date(start).getTime() + 7 * 86400_000), timeZone: 'UTC', cadence: 'WEEKLY',
    status, revision: 1, reviewStartedAt: null, lockedAt: null, lockOperationId: null, lockRequestHash: null,
    createdAt: new Date(), updatedAt: new Date(), lockedEntrySha256: null, lockedEntryCount: null, totalPayableMinutes: null });
  const status = ['createExport', 'downloadExport', 'reconcileExport', 'createAmendment', 'decideAmendment'].includes(action)
    ? 'LOCKED' : ['decideCards', 'lockPeriod'].includes(action) ? 'REVIEW' : 'OPEN';
  const card: Row = { id: cardId, publicId: uuid(4), tenantId: ids.tenant, userId: employeeId,
    locationId: 'location-internal', payrollPeriodId: action === 'adoptCards' ? null : sourceId,
    workTimeZone: 'UTC', clockInAt: new Date('2020-01-07T09:00:00Z'), clockOutAt: new Date('2020-01-07T17:00:00Z'),
    breakMinutes: 0, status: 'CLOSED', deletedAt: null, revision: 1, updatedAt: new Date() };
  const snapshot = materializeLockedSnapshots({ tenantId: ids.tenant, periodId: sourceId, sources: [{
    sourceType: 'TIME_CARD', sourceId: cardId, sourceRevision: 1, employeeId, locationId: 'location-internal',
    workTimeZone: 'UTC', clockInAt: card.clockInAt, clockOutAt: card.clockOutAt, breakMinutes: 0,
    payableMinutes: 480, approvedAt: new Date('2020-01-13T01:00:00Z'), approvedByUserId: requesterId }] });
  const entry: Row = { ...snapshot.entries[0], id: 'entry-internal', publicId: uuid(5), tenantId: ids.tenant, periodId: sourceId };
  const source = period(sourceId, uuid(2), '2020-01-06T00:00:00Z', status);
  if (status === 'LOCKED') Object.assign(source, { lockedEntrySha256: snapshot.aggregateSha256,
    lockedEntryCount: 1, totalPayableMinutes: 480 });
  const simpleUser = (id: string, publicId: string): Row => ({ id, publicId, tenantId: ids.tenant,
    role: 'ADMIN', name: id, email: null, username: id, deletedAt: null, suspendedAt: null,
    lockedUntil: null, pinLockedUntil: null, mfaEnabled: false, pinResetRequired: false });
  const tables: Record<string, Row[]> = {
    tenant: [{ id: ids.tenant, status: 'ACTIVE', deletedAt: null, planTier: 'GROWTH', usageCredits: 10, creditDebt: 0,
      stripeSubscriptionId: 'sub_controlled', stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01'), trialEndsAt: null }],
    user: [simpleUser(ids.actor, ids.publicActor), simpleUser(employeeId, uuid(6)), simpleUser(requesterId, uuid(7))],
    session: [{ id: ids.session, userId: ids.actor, createdAt: new Date(Date.now() - 29 * 60_000),
      expiresAt: new Date(Date.now() + 3600_000), revokedAt: null }],
    tenantSetting: [{ tenantId: ids.tenant, key: 'workspace_settings', value: { security: { sessionTimeoutMinutes: 30, requireMfaForAll: false } } }],
    role: [{ id: ids.role, publicId: uuid(8), tenantId: ids.tenant, name: 'Payroll', slug: 'payroll', description: null,
      isSystem: false, isDefault: false, legacyRole: null, deletedAt: null, rolePermissions: grants.map(key => ({ permission: { key } })) }],
    roleAssignment: [{ tenantId: ids.tenant, userId: ids.actor, roleId: ids.role }],
    location: [{ id: 'location-internal', publicId: uuid(9), tenantId: ids.tenant }],
    planDefinition: [{ code: 'GROWTH', metadata: { features: ['time_cards'] } }],
    payrollPolicyVersion: action === 'createPolicy' ? [] : [{ id: 'policy-internal', publicId: uuid(1), tenantId: ids.tenant,
      version: 1, timeZone: 'UTC', cadence: 'WEEKLY', anchorDate: new Date('2020-01-06'), effectiveFrom: new Date('2020-01-06'),
      createdByUserId: ids.actor, createdAt: new Date(), operationId: 'seed-policy', requestHash: 'a'.repeat(64) }],
    payrollPeriod: [source, period(adjustmentId, uuid(3), '2020-01-13T00:00:00Z', action === 'decideAmendment' ? 'REVIEW' : 'OPEN')],
    timeCard: [card], payrollTimeCardApproval: action === 'lockPeriod' ? [{ id: 'approval-seeded', tenantId: ids.tenant,
      periodId: sourceId, timeCardId: cardId, timeCardRevision: 1, decision: 'APPROVED', decidedAt: new Date('2020-01-13T01:00:00Z'),
      decidedByUserId: requesterId }] : [],
    payrollLockedEntry: action === 'lockPeriod' ? [] : [entry],
    payrollAmendment: action === 'decideAmendment' ? [{ id: 'amendment-internal', publicId: uuid(10), tenantId: ids.tenant,
      lockedEntryId: entry.id, adjustmentPeriodId: adjustmentId, requestedByUserId: requesterId, reason: 'Correction',
      replacementClockInAt: card.clockInAt, replacementClockOutAt: new Date('2020-01-07T18:00:00Z'),
      replacementBreakMinutes: 0, replacementPayableMinutes: 540, minuteDelta: 60, createdAt: new Date() }] : [],
    payrollAmendmentDecision: [], payrollOperation: [], payrollExportBatch: [], payrollExportLine: [],
    payrollReconciliationReceipt: [], payrollReconciliationLineEvent: [], payrollReconciliationLineState: [],
    creditTransaction: [], auditLog: [],
  };
  if (action === 'downloadExport' || action === 'reconcileExport') {
    const line: Row = { id: 'line-internal', publicId: uuid(12), tenantId: ids.tenant, batchId: 'batch-internal',
      lockedEntryId: entry.id, lineNumber: 1, sourceType: 'TIME_CARD', sourceId: cardId, employeeId, locationId: 'location-internal',
      workTimeZone: 'UTC', clockInAt: card.clockInAt, clockOutAt: card.clockOutAt, breakMinutes: 0, payableMinutes: 480 };
    const publicLine = { id: line.publicId, lineNumber: line.lineNumber, sourceType: line.sourceType,
      sourceId: card.publicId, employeeId: uuid(6), locationId: uuid(9), workTimeZone: line.workTimeZone,
      clockInAt: line.clockInAt, clockOutAt: line.clockOutAt, breakMinutes: line.breakMinutes, payableMinutes: line.payableMinutes };
    line.canonicalSha256 = payrollExportLineSha256({ tenantId: ids.tenant, batchId: line.batchId, lockedEntryId: entry.id, line: publicLine as any });
    tables.payrollExportLine.push(line);
    tables.payrollExportBatch.push({ id: line.batchId, publicId: uuid(11), tenantId: ids.tenant, periodId: sourceId,
      operationId: 'seed-export', requestHash: 'b'.repeat(64), creditTransactionId: 'feature-usage-payroll-export:seed-export',
      formatVersion: 1, rowCount: 1, totalPayableMinutes: 480, consumedCredits: 1, newBalance: 9,
      contentSha256: payrollContentSha256(buildPayrollCsv([publicLine as any])),
      status: action === 'downloadExport' ? 'GENERATED' : 'DOWNLOADED', createdAt: new Date(), updatedAt: new Date(),
      downloadedAt: action === 'reconcileExport' ? new Date() : null, reconciledAt: null });
    tables.creditTransaction.push({ id: 'feature-usage-payroll-export:seed-export', tenantId: ids.tenant, amount: -1,
      debtAmount: 0, reason: 'Payroll export (period-source)', balanceAfter: 9, debtAfter: 0 });
  }
  return tables;
}

import { materializeLockedSnapshots, payrollExportLineSha256, payrollContentSha256, buildPayrollCsv } from './domain';
function payrollFixture(action: Action) {
  let state = populate(action);
  const identity: SessionIdentity = { sub: ids.actor, tenantId: ids.tenant, sessionId: ids.session, publicUserId: ids.publicActor,
    role: 'ADMIN', legacyRole: 'ADMIN', roles: [], permissions: [...grants], mfaRequired: true, mfaVerified: true, pinResetRequired: false };
  const entered = gate(), release = gate();
  const attempted: Row[] = [], committed: Row[] = [], reads: Row[] = [], lockLog: Row[] = [];
  const controls = { active: 0, transactions: 0, authorityPasses: 0, gate: '' as string, index: 0, entered: false,
    observer: 'valid', axis: 'effective' as Axis, conflict: false, conflictCode: 'P2034', conflictDone: false,
    conflictMutation: undefined as (() => void) | undefined, observation: null as Row | null, readonlyReplay: false, failAdvisoryCodes: [] as string[], recoveryReads: false };
  const pause = async (kind: string, index = 0) => {
    if (controls.gate === kind && controls.index === index && !controls.entered) {
      controls.entered = true; entered.release(); await release.promise;
    }
  };
  const observer = { observeSessionMfa: vi.fn(async (selected: MfaSessionIdentity) => {
    expect(controls.active).toBe(0); expect(selected).toEqual({ sub: ids.actor, tenantId: ids.tenant, sessionId: ids.session });
    if (controls.observer === 'error') throw new Error('private controlled redis error');
    if (controls.observer === 'null') return null;
    const observation = { ...selected, expiresAtEpochMs: Date.now() + (controls.axis === 'mfaWall' ? 1000 : 120_000),
      expiresAtMonotonicMs: mono.now + (controls.axis === 'mfaMonotonic' ? 1000 : 120_000) };
    if (controls.observer === 'wrong' || controls.observer === 'wrongSession') observation.sessionId = 'other-session';
    if (controls.observer === 'wrongTenant') observation.tenantId = 'other-tenant';
    if (controls.observer === 'wrongActor') observation.sub = 'other-actor';
    controls.observation = observation; await pause('observer'); return observation;
  }) };
  const observeMethod = observer.observeSessionMfa;
  Object.defineProperty(observer, 'observeSessionMfa', { get: () => controls.observer === 'missing' ? undefined : observeMethod });
  const allow: Record<string, string[]> = {
    tenant: ['findUnique', 'findUniqueOrThrow', 'findFirst', 'updateMany'], user: ['findFirst', 'findMany'],
    session: ['findFirst'], tenantSetting: ['findUnique'], roleAssignment: ['findMany'], role: ['findMany'],
    planDefinition: ['findUnique'], location: ['findMany'], timeCard: ['findMany', 'updateMany'],
    payrollPolicyVersion: ['findFirst', 'findUnique', 'findMany', 'create'], payrollPeriod: ['findFirst', 'findMany', 'create', 'updateMany'],
    payrollOperation: ['findUnique', 'create'], payrollTimeCardApproval: ['findMany', 'create'], payrollLockedEntry: ['findFirst', 'findMany', 'createMany'],
    payrollAmendment: ['findUnique', 'findFirst', 'findMany', 'create'], payrollAmendmentDecision: ['findUnique', 'findMany', 'create'],
    payrollExportBatch: ['findUnique', 'findFirst', 'create', 'updateMany'], payrollExportLine: ['findFirst', 'findMany', 'createMany'],
    payrollReconciliationReceipt: ['findUnique', 'findFirst', 'create'], payrollReconciliationLineEvent: ['createMany'],
    payrollReconciliationLineState: ['findMany', 'count', 'groupBy', 'upsert'], creditTransaction: ['findUnique', 'create'], auditLog: ['create'],
  };
  const withTenant = vi.fn(async (tenantId: string, operation: (tx: any) => Promise<any>, options?: Row) => {
    expect(tenantId).toBe(ids.tenant); expect(controls.active).toBe(0);
    if (options) expect(options).toEqual({ isolationLevel: 'Serializable', maxWait: 5000, timeout: 20_000 });
    controls.active++; const ordinal = ++controls.transactions; const staged = copy(state), pending: Row[] = [];
    let domain = controls.recoveryReads, effectOrdinal = 0, readOrdinal = 0;
    let afterRollback: (() => void) | undefined;
    const completeRead = async (label: string, result: any) => {
      if (domain) { reads.push({ ordinal, label, index: readOrdinal }); await pause('read', readOrdinal++); }
      return copy(result);
    };
    const effect = async (table: string, method: string, args: Row, mutation: () => any) => {
      const item = { table, method, args: copy(args), index: effectOrdinal }; attempted.push(item); pending.push(item);
      const result = mutation(); await pause('effect', effectOrdinal++);
      if (controls.conflict && !controls.conflictDone) {
        controls.conflictDone = true; afterRollback = controls.conflictMutation; throw { code: controls.conflictCode };
      }
      return copy(result);
    };
    const tx: Row = {
      $queryRaw: async (sql: any, ...bound: unknown[]) => {
        const text = (Array.isArray(sql) ? sql : sql.strings).join('');
        const values = flatten(Array.isArray(sql) ? bound : sql.values);
        if (text.includes('set_config')) { expect(text).toContain("'statement_timeout'"); return [{}]; }
        if (text.includes('FROM "Tenant"')) { expect(values).toEqual([ids.tenant]); lockLog.push({ ordinal, kind: 'Tenant' }); return copy(staged.tenant.filter(row => row.id === values[0])); }
        if (text.includes('FROM "User"')) { expect(values).toEqual([ids.tenant, ids.actor]); lockLog.push({ ordinal, kind: 'User' }); return copy(staged.user.filter(row => row.tenantId === values[0] && row.id === values[1])); }
        if (text.includes('FROM "Session"')) { expect(values).toEqual([ids.session, ids.actor]); lockLog.push({ ordinal, kind: 'Session' }); return copy(staged.session.filter(row => row.id === values[0] && row.userId === values[1])); }
        if (text.includes('FROM "RolePermission"')) { expect(values).toEqual([ids.role]); lockLog.push({ ordinal, kind: 'RolePermission' });
          if (++controls.authorityPasses === 2) await pause('finalRole');
          await pause('authority', controls.authorityPasses);
          return staged.role.filter(row => row.id === ids.role).flatMap(row => row.rolePermissions.map((grant: Row) => ({
            roleId: row.id, permissionId: 'controlled-permission-' + grant.permission.key })));  }
        if (text.includes('FROM "Role"')) { expect(values).toEqual([ids.tenant, ids.role]); lockLog.push({ ordinal, kind: 'Role' }); return staged.role.filter(row => row.tenantId === values[0] && row.id === values[1]).map(row => ({ id: row.id })); }
        if (text.includes('FROM "PayrollExportBatch"')) { expect(values[0]).toBe(ids.tenant); expect(values).toHaveLength(2);
          expect(text).toContain('FOR UPDATE'); return completeRead('batch-lock', staged.payrollExportBatch.filter(row => row.tenantId === values[0] && (row.id === values[1] || row.publicId === values[1]))); }
        if (text.includes('FROM "TimeCard" card')) { expect(values[0]).toBe(ids.tenant); expect(values[1]).toBe('period-source');
          expect(text).toContain('FOR UPDATE'); return completeRead('candidate-lock', staged.timeCard.filter(row => row.tenantId === values[0] && row.payrollPeriodId === values[1])); }
        if (text.includes('FROM "TimeCardBreak"')) { expect(values[0]).toBe(ids.tenant); expect(values.slice(1)).toEqual(['card-employee']);
          expect(text).toContain('FOR UPDATE'); return completeRead('break-lock', []); }
        if (text.includes('FROM "PayrollPeriod" period')) {
          expect(values).toContain(ids.tenant); const periodIds = values.filter(value => value !== ids.tenant);
          return completeRead('period-summary', staged.payrollPeriod.filter(row => periodIds.includes(row.id)).map(row => {
            const cards = staged.timeCard.filter(card => card.tenantId === ids.tenant && card.payrollPeriodId === row.id);
            const approvals = staged.payrollTimeCardApproval.filter(approval => approval.tenantId === ids.tenant && approval.periodId === row.id
              && cards.some(card => card.id === approval.timeCardId && card.revision === approval.timeCardRevision));
            const amendments = staged.payrollAmendment.filter(item => item.adjustmentPeriodId === row.id);
            return { periodId: row.id, cardCount: cards.length, closedCardCount: cards.filter(card => card.status === 'CLOSED').length,
              approvedCardCount: approvals.filter(item => item.decision === 'APPROVED').length, rejectedCardCount: approvals.filter(item => item.decision === 'REJECTED').length,
              amendmentCount: amendments.length, pendingAmendmentCount: amendments.filter(item => !staged.payrollAmendmentDecision.some(decision => decision.amendmentId === item.id)).length,
              approvedAmendmentCount: amendments.filter(item => staged.payrollAmendmentDecision.some(decision => decision.amendmentId === item.id && decision.decision === 'APPROVED')).length,
              lockedEntryCount: staged.payrollLockedEntry.filter(item => item.periodId === row.id).length };
          }));
        }
        throw new Error('Unmodeled all-command SQL read: ' + text);
      },
      $executeRaw: async (sql: any, ...bound: unknown[]) => {
        const text = (Array.isArray(sql) ? sql : sql.strings).join('');
        const values = flatten(Array.isArray(sql) ? bound : sql.values);
        if (text.includes('LOCK TABLE')) { expect(text).toContain('"CreditTransaction"'); expect(values).toEqual([]); return 1; }
        if (!text.includes('pg_advisory_xact_lock')) throw new Error('Unmodeled SQL effect: ' + text);
        expect(values).toHaveLength(1); expect(values[0]).toMatch(/^lunchlineup:payroll:payroll-authority-tenant(?::period-(source|adjustment))?$/);
        domain = true; lockLog.push({ ordinal, kind: 'Payroll' }); await pause('domain');
        const code = controls.failAdvisoryCodes.shift();
        if (code) { if (code !== 'P2034') controls.recoveryReads = true; throw { code }; }
        return 1;
      },
    };
    for (const [table, methods] of Object.entries(allow)) {
      tx[table] = {};
      for (const method of methods) tx[table][method] = async (args: Row) => {
        if (args.where?.tenantId) expect(args.where.tenantId).toBe(ids.tenant);
        if (table === 'tenant' && method.startsWith('find')) expect(args.where).toEqual({ id: ids.tenant, ...(method === 'findFirst' ? { deletedAt: null } : {}) });
        if (table === 'session') expect(args.where).toEqual({ id: ids.session, userId: ids.actor });
        if (table === 'tenantSetting') {
          expect(args.where.tenantId_key.tenantId).toBe(ids.tenant);
          expect(['workspace_settings', 'feature_access']).toContain(args.where.tenantId_key.key);
        }
        const scopedReadTables = ['user', 'role', 'roleAssignment', 'location', 'timeCard', 'payrollPeriod',
          'payrollLockedEntry', 'payrollExportLine', 'payrollTimeCardApproval', 'payrollReconciliationLineState'];
        if (method.startsWith('find') && scopedReadTables.includes(table)) expect(args.where.tenantId).toBe(ids.tenant);
        if (method.startsWith('find') && ['payrollPolicyVersion', 'payrollAmendment', 'payrollExportBatch', 'payrollReconciliationReceipt'].includes(table)
          && method !== 'findUnique') expect(args.where.tenantId).toBe(ids.tenant);
        if (method === 'updateMany' && table !== 'tenant') expect(args.where.tenantId).toBe(ids.tenant);
        if (args.data?.tenantId) expect(args.data.tenantId).toBe(ids.tenant);
        if (method === 'create') expect(args.data.tenantId).toBe(ids.tenant);
        if (method === 'createMany') for (const row of args.data) expect(row.tenantId).toBe(ids.tenant);
        if (method === 'upsert') expect(args.create.tenantId).toBe(ids.tenant);
        const rows = staged[table]; const selected = rows.filter(row => matchesPayroll(row, args.where));
        const ordered = [...selected];
        for (const order of (Array.isArray(args.orderBy) ? [...args.orderBy].reverse() : args.orderBy ? [args.orderBy] : []))
          for (const [key, direction] of Object.entries(order)) ordered.sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (direction === 'desc' ? -1 : 1));
        if (method.startsWith('find')) {
          if (table === 'roleAssignment') { expect(args.where).toEqual({ tenantId: ids.tenant, userId: { in: [ids.actor] } }); lockLog.push({ ordinal, kind: 'RoleAssignmentRead' }); }
          if (table === 'role') expect(args.where).toEqual({ tenantId: ids.tenant, id: { in: [ids.role] }, deletedAt: null });
          const result = method === 'findMany' ? ordered.slice(0, args.take ?? ordered.length) : ordered[0] ?? null;
          if (method.endsWith('OrThrow') && !result) throw new Error('Required model row absent: ' + table);
          return completeRead(table + '.' + method, result);
        }
        if (method === 'count') return completeRead(table + '.count', selected.length);
        if (method === 'groupBy') return completeRead(table + '.groupBy', [...new Set(selected.map(row => row.status))].map(status => ({ status, _count: { _all: selected.filter(row => row.status === status).length } })));
        return effect(table, method, args, () => {
          if (method === 'updateMany') { selected.forEach(row => updatePayroll(row, args.data)); return { count: selected.length }; }
          if (method === 'upsert' && selected[0]) { updatePayroll(selected[0], args.update); return selected[0]; }
          const inputs: Row[] = method === 'createMany' ? args.data : [method === 'upsert' ? args.create : args.data];
          const created = inputs.map((data: Row, n: number) => {
            const row: Row = { id: table + '-created-' + rows.length + '-' + n, publicId: uuid(100 + attempted.length * 10 + n),
              createdAt: new Date(), updatedAt: new Date(), decidedAt: new Date(), receivedAt: new Date(),
              status: table === 'payrollPeriod' ? 'OPEN' : table === 'payrollExportBatch' ? 'GENERATED' : undefined,
              revision: 1, reviewStartedAt: null, lockedAt: null, downloadedAt: null, reconciledAt: null,
              ...copy(data) }; rows.push(row); return row;
          });
          return method === 'createMany' ? { count: created.length } : created[0];
        });
      };
    }
    try { const result = await operation(tx); state = staged; committed.push(...pending); return result; }
    finally { controls.active--; afterRollback?.(); }
  });
  const owner = new PayrollService({ withTenant } as any, observer);
  const bodies: Record<Action, any> = { createPolicy: copy(policy), createPeriod: { localStartDate: '2020-01-20' },
    startReview: { expectedRevision: 1 }, adoptCards: { cards: [{ id: uuid(4), expectedRevision: 1 }] },
    decideCards: { decisions: [{ timeCardId: uuid(4), expectedRevision: 1, decision: 'APPROVED', reason: 'Checked' }] },
    lockPeriod: { expectedRevision: 1 }, createAmendment: { adjustmentPeriodId: uuid(3), reason: 'Correction',
      replacementClockInAt: '2020-01-07T09:00:00.000Z', replacementClockOutAt: '2020-01-07T18:00:00.000Z', replacementBreakMinutes: 0 },
    decideAmendment: { decision: 'APPROVED', reason: 'Checked' }, createExport: { expectedCreditCost: 1 }, downloadExport: {},
    reconcileExport: { provider: 'Controlled provider receipt', providerEventId: 'event-once', providerTotalMinutes: 480,
      outcomes: [{ lineId: uuid(12), status: 'ACCEPTED', reason: 'accepted' }] } };
  const invoke = () => {
    const key = 'authority-' + action;
    switch (action) {
      case 'createPolicy': return owner.createPolicy(identity, bodies[action], key);
      case 'createPeriod': return owner.createPeriod(identity, bodies[action], key);
      case 'startReview': return owner.startReview(identity, uuid(2), bodies[action], key);
      case 'adoptCards': return owner.adoptCards(identity, uuid(2), bodies[action], key);
      case 'decideCards': return owner.decideCards(identity, uuid(2), bodies[action], key);
      case 'lockPeriod': return owner.lockPeriod(identity, uuid(2), bodies[action], key);
      case 'createAmendment': return owner.createAmendment(identity, uuid(5), bodies[action], key);
      case 'decideAmendment': return owner.decideAmendment(identity, uuid(10), bodies[action], key);
      case 'createExport': return owner.createExport(identity, uuid(2), bodies[action], key);
      case 'downloadExport': return owner.downloadExport(identity, uuid(11));
      case 'reconcileExport': return owner.reconcileExport(identity, uuid(11), bodies[action]);
    }
  };
  const expire = (axis: Axis) => {
    if (axis === 'mfaMonotonic') mono.now += 1001;
    else vi.setSystemTime(new Date(Date.now() + (axis === 'mfaWall' ? 1001 : 60_001)));
  };
  const configureAxis = (axis: Axis) => {
    controls.axis = axis;
    if (axis === 'stored') { state.session[0].expiresAt = new Date(Date.now() + 60_000); state.session[0].createdAt = new Date(); }
    if (axis === 'mfaWall' || axis === 'mfaMonotonic') state.session[0].createdAt = new Date();
  };
  return { owner, identity, observer, controls, attempted, committed, reads, lockLog, entered, release, withTenant,
    invoke, bodies, expire, configureAxis, state: () => state, snapshot: () => copy(state) };
}

async function crossGate(f: ReturnType<typeof payrollFixture>, axis: Axis) {
  const committedBefore = f.committed.length;
  const request = f.invoke().then(value => ({ value }), error => ({ error }));
  try { await Promise.race([f.entered.promise, request.then(() => { throw new Error('Owner settled before selected gate'); })]);
    f.expire(axis);
  } finally { f.release.release(); }
  const outcome = await request;
  expect(outcome).toMatchObject({ error: { status: 403, code: axis.startsWith('mfa') ? 'mfa_verification_required' : 'permission_denied' } });
  expect(f.committed).toHaveLength(committedBefore);
}

describe('native payroll all-command current-authority and staged financial conservation', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-04T20:00:00Z'));
    mono.now = 1000; vi.spyOn(performance, 'now').mockImplementation(() => mono.now); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  for (const action of actions) {
    it(action + ': preserves a populated successful domain effect and committed replay without duplicate effects', async () => {
      const f = payrollFixture(action); const result = await f.invoke(); const beforeReplay = f.snapshot(), count = f.committed.length;
      expect(count).toBeGreaterThan(0); expect(f.state().auditLog).toHaveLength(1);
      const replay = await f.invoke(); expect(replay).toEqual(result); expect(f.state()).toEqual(beforeReplay); expect(f.committed).toHaveLength(count);
      expect(f.observer.observeSessionMfa).toHaveBeenCalledTimes(2);
      const domainTransactions = [...new Set(f.lockLog.filter(row => row.kind === 'Payroll').map(row => row.ordinal))];
      for (const ordinal of domainTransactions) {
        const locked = f.lockLog.filter(row => row.ordinal === ordinal).map(row => row.kind);
        expect(locked.indexOf('Tenant')).toBeLessThan(locked.indexOf('User'));
        expect(locked.indexOf('Session')).toBeLessThan(locked.indexOf('Role'));
        expect(locked.indexOf('RolePermission')).toBeLessThan(locked.indexOf('Payroll'));
      }
      if (action === 'createExport') { expect(f.state().tenant[0].usageCredits).toBe(9); expect(f.state().creditTransaction).toHaveLength(1);
        expect(f.state().creditTransaction[0]).toMatchObject({ amount: -1, debtAmount: 0, balanceAfter: 9, debtAfter: 0 }); }
      if (action === 'lockPeriod') expect(f.state().payrollPeriod[0]).toMatchObject({ status: 'LOCKED', lockedEntryCount: 1, totalPayableMinutes: 480 });
      if (action === 'reconcileExport') expect(f.state().payrollExportBatch[0].status).toBe('RECONCILED');
    });
    it(action + ': rejects a revoked exact session before domain effects and refuses committed replay after revocation', async () => {
      const f = payrollFixture(action); f.state().session[0].revokedAt = new Date(); const before = f.snapshot();
      await expect(f.invoke()).rejects.toMatchObject({ status: 403, code: 'permission_denied' });
      expect(f.attempted).toEqual([]); expect(f.state()).toEqual(before);
      f.state().session[0].revokedAt = null; await f.invoke(); f.state().session[0].revokedAt = new Date();
      const completed = f.snapshot(), count = f.committed.length;
      await expect(f.invoke()).rejects.toMatchObject({ status: 403, code: 'permission_denied' });
      expect(f.state()).toEqual(completed); expect(f.committed).toHaveLength(count);
    });
    for (const axis of axes) {
      it(action + ': independently fences ' + axis + ' after final grant wait and actual domain advisory wait', async () => {
        for (const stage of ['finalRole', 'domain']) {
          const f = payrollFixture(action); f.configureAxis(axis); f.controls.gate = stage; const before = f.snapshot();
          await crossGate(f, axis); expect(f.state()).toEqual(before); expect(f.attempted).toEqual([]);
          vi.setSystemTime(new Date('2026-10-04T20:00:00Z')); mono.now = 1000;
        }
      });
      it(action + ': independently rolls back ' + axis + ' at each staged effect completion including last audit', async () => {
        const positive = payrollFixture(action); positive.configureAxis(axis); await positive.invoke();
        const effects = positive.committed.map(row => ({ table: row.table, method: row.method }));
        expect(effects.length).toBeGreaterThan(0);
        for (let index = 0; index < effects.length; index++) {
          const f = payrollFixture(action); f.configureAxis(axis); f.controls.gate = 'effect'; f.controls.index = index;
          const before = f.snapshot(); await crossGate(f, axis); expect(f.state()).toEqual(before);
          expect(f.attempted.map(row => ({ table: row.table, method: row.method }))).toEqual(effects.slice(0, index + 1));
          vi.setSystemTime(new Date('2026-10-04T20:00:00Z')); mono.now = 1000;
        }
      });
    }
  }
});

const permissionFor: Record<Action, string> = { createPolicy: 'payroll:policy_write', createPeriod: 'payroll:policy_write',
  startReview: 'payroll:lock', adoptCards: 'payroll:policy_write', decideCards: 'time_cards:approve', lockPeriod: 'payroll:lock',
  createAmendment: 'payroll:reconcile', decideAmendment: 'time_cards:approve', createExport: 'payroll:export',
  downloadExport: 'payroll:export', reconcileExport: 'payroll:reconcile' };
const restoreClock = () => { vi.setSystemTime(new Date('2026-10-04T20:00:00Z')); mono.now = 1000; };
async function outsideObserverChange(f: ReturnType<typeof payrollFixture>, change: () => void) {
  f.controls.gate = 'observer'; const request = f.invoke().then(value => ({ value }), error => ({ error }));
  try { await Promise.race([f.entered.promise, request.then(() => { throw new Error('Owner settled before outside observation gate'); })]);
    expect(f.controls.active).toBe(0); change();
  } finally { f.release.release(); }
  return request;
}

describe('native payroll observer custody, final replay reads and bounded current-authority retry', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); restoreClock(); vi.spyOn(performance, 'now').mockImplementation(() => mono.now); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  for (const action of actions) {
    it(action + ': uses actual current required grant and rejects its loss during outside observation', async () => {
      const f = payrollFixture(action);
      const outcome = await outsideObserverChange(f, () => {
        f.state().role[0].rolePermissions = f.state().role[0].rolePermissions.filter((item: Row) => item.permission.key !== permissionFor[action]);
      });
      expect(outcome).toMatchObject({ error: { status: 403, code: 'permission_denied' } });
      expect(f.attempted).toEqual([]); expect(f.committed).toEqual([]); expect(f.observer.observeSessionMfa).toHaveBeenCalledTimes(1);
      expect(f.controls.authorityPasses).toBe(2);
    });
    it(action + ': revalidates current Tenant, account, forced PIN, exact session and shortened policy after outside observation', async () => {
      const changes = [
        (f: ReturnType<typeof payrollFixture>) => { f.state().tenant[0].status = 'SUSPENDED'; },
        (f: ReturnType<typeof payrollFixture>) => { f.state().tenant[0].deletedAt = new Date(); },
        (f: ReturnType<typeof payrollFixture>) => { f.state().user[0].suspendedAt = new Date(); },
        (f: ReturnType<typeof payrollFixture>) => { f.state().user[0].pinResetRequired = true; },
        (f: ReturnType<typeof payrollFixture>) => { f.state().session[0].revokedAt = new Date(); },
        (f: ReturnType<typeof payrollFixture>) => { f.state().session[0].userId = 'other-account'; },
        (f: ReturnType<typeof payrollFixture>) => { f.state().tenantSetting[0].value.security.sessionTimeoutMinutes = 5; },
      ];
      for (let index = 0; index < changes.length; index++) {
        const f = payrollFixture(action); const outcome = await outsideObserverChange(f, () => changes[index](f));
        expect(outcome).toMatchObject({ error: { status: 403, code: index === 3 ? 'pin_rotation_required' : 'permission_denied' } });
        expect(f.attempted).toEqual([]); expect(f.committed).toEqual([]); expect(f.controls.active).toBe(0);
      }
    });
    for (const mode of ['null', 'error', 'missing', 'wrongActor', 'wrongTenant', 'wrongSession']) {
      it(action + ': fails closed for outside observer ' + mode + ' without any domain effect', async () => {
        const f = payrollFixture(action); f.controls.observer = mode;
        await expect(f.invoke()).rejects.toMatchObject({ status: ['error', 'missing'].includes(mode) ? 503 : 403,
          code: ['error', 'missing'].includes(mode) ? 'identity_service_unavailable' : 'mfa_verification_required' });
        expect(f.attempted).toEqual([]); expect(f.committed).toEqual([]); expect(f.controls.active).toBe(0);
      });
    }
    it(action + ': freezes canonical actor and exact command body before outside observation', async () => {
      const f = payrollFixture(action); const originalBody = copy(f.bodies[action]);
      const outcome = await outsideObserverChange(f, () => {
        f.identity.sub = 'other-actor'; f.identity.tenantId = 'other-tenant'; f.identity.sessionId = 'other-session';
        switch (action) {
          case 'createPolicy': f.bodies[action].cadence = 'INVALID'; break;
          case 'createPeriod': f.bodies[action].localStartDate = 'invalid'; break;
          case 'startReview': case 'lockPeriod': f.bodies[action].expectedRevision = 99; break;
          case 'adoptCards': f.bodies[action].cards[0].id = uuid(99); break;
          case 'decideCards': f.bodies[action].decisions[0].expectedRevision = 99; break;
          case 'createAmendment': f.bodies[action].replacementClockOutAt = 'invalid'; break;
          case 'decideAmendment': f.bodies[action].decision = 'REJECTED'; break;
          case 'createExport': f.bodies[action].expectedCreditCost = 99; break;
          case 'reconcileExport': f.bodies[action].providerEventId = 'changed-event'; f.bodies[action].outcomes[0].lineId = uuid(99); break;
          case 'downloadExport': break;
        }
      });
      expect(outcome).toHaveProperty('value'); expect(f.state().auditLog).toHaveLength(1);
      expect(f.state().auditLog[0]).toMatchObject({ tenantId: ids.tenant, actorUserId: ids.actor });
      const reference = payrollFixture(action); reference.bodies[action] = originalBody; const value = await reference.invoke();
      // Random batch/line public UUIDs are owner-generated independently, so
      // financial semantics and exact actor/body effects are compared there.
      if (action !== 'createExport') expect(outcome).toEqual({ value });
      else { expect(f.state().tenant[0].usageCredits).toBe(9); expect(f.state().creditTransaction[0]).toMatchObject({ amount: -1, balanceAfter: 9 }); }
    });
    it(action + ': retries serialization with fresh authority and one unchanged outside observation', async () => {
      const f = payrollFixture(action); f.controls.conflict = true; const result = await f.invoke();
      expect(result).toBeDefined(); expect(f.state().auditLog).toHaveLength(1); expect(f.controls.authorityPasses).toBe(3);
      expect(f.observer.observeSessionMfa).toHaveBeenCalledTimes(1); expect(f.attempted.length).toBe(f.committed.length + 1);
      expect(f.attempted[0].table).toBe(f.committed[0].table);
      if (action === 'createExport') { expect(f.state().tenant[0].usageCredits).toBe(9); expect(f.state().creditTransaction).toHaveLength(1); }
    });
    it(action + ': serialization retry rechecks revoked session and never extends proof after a failed staged effect', async () => {
      const f = payrollFixture(action); f.controls.conflict = true;
      f.controls.conflictMutation = () => { expect(f.controls.active).toBe(0); f.state().session[0].revokedAt = new Date(); };
      await expect(f.invoke()).rejects.toMatchObject({ status: 403, code: 'permission_denied' });
      expect(f.attempted).toHaveLength(1); expect(f.committed).toEqual([]); expect(f.state().auditLog).toEqual([]);
      expect(f.observer.observeSessionMfa).toHaveBeenCalledTimes(1);
    });
    for (const axis of axes) {
      it(action + ': refuses ' + axis + ' at last actual read of committed replay without publishing a stale success', async () => {
        const viable = payrollFixture(action); await viable.invoke(); viable.reads.length = 0; await viable.invoke();
        const last = viable.reads.at(-1); expect(last).toBeDefined();
        const f = payrollFixture(action); await f.invoke(); f.configureAxis(axis); const before = f.snapshot(), attemptedCount = f.attempted.length;
        f.controls.gate = 'read'; f.controls.index = last!.index; await crossGate(f, axis);
        expect(f.state()).toEqual(before); expect(f.attempted).toHaveLength(attemptedCount);
        restoreClock();
      });
      it(action + ': serialization retry keeps the original ' + axis + ' deadline after a failed effect', async () => {
        const f = payrollFixture(action); f.configureAxis(axis); f.controls.conflict = true;
        f.controls.conflictMutation = () => { expect(f.controls.active).toBe(0); f.expire(axis); };
        await expect(f.invoke()).rejects.toMatchObject({ status: 403, code: axis.startsWith('mfa') ? 'mfa_verification_required' : 'permission_denied' });
        expect(f.attempted).toHaveLength(1); expect(f.committed).toEqual([]); expect(f.observer.observeSessionMfa).toHaveBeenCalledTimes(1);
      });
    }
  }
  for (const action of ['createExport', 'reconcileExport'] as const) {
    const errors = action === 'createExport' ? ['P2002', '55P03'] : ['P2002'];
    for (const code of errors) {
      it(action + ': recovers exact committed replay after second serial attempt ' + code + ' with fresh authority and the same proof', async () => {
        const f = payrollFixture(action); const first = await f.invoke(); const before = f.snapshot(), count = f.committed.length;
        f.controls.failAdvisoryCodes = ['P2034', code]; const result = await f.invoke();
        expect(result).toEqual(first); expect(f.state()).toEqual(before); expect(f.committed).toHaveLength(count);
        expect(f.controls.authorityPasses).toBe(6); expect(f.observer.observeSessionMfa).toHaveBeenCalledTimes(2);
      });
      for (const axis of axes) {
        it(action + ': fences original ' + axis + ' in ' + code + ' replay recovery after final lock wait', async () => {
          const f = payrollFixture(action); await f.invoke(); f.configureAxis(axis); const before = f.snapshot();
          f.controls.failAdvisoryCodes = ['P2034', code]; f.controls.gate = 'authority'; f.controls.index = 6;
          await crossGate(f, axis); expect(f.state()).toEqual(before); expect(f.observer.observeSessionMfa).toHaveBeenCalledTimes(2);
        });
      }
    }
  }
});

describe('native payroll authority preserves existing financial and independent-approval contracts', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); restoreClock(); vi.spyOn(performance, 'now').mockImplementation(() => mono.now); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it('allows exact committed export replay after current entitlement and wallet changes without another debit', async () => {
    const f = payrollFixture('createExport'); const first = await f.invoke();
    Object.assign(f.state().tenant[0], { status: 'CANCELLED', stripeSubscriptionId: null, usageCredits: 0, creditDebt: 99 });
    const before = f.snapshot(), count = f.committed.length; expect(await f.invoke()).toEqual(first);
    expect(f.state()).toEqual(before); expect(f.committed).toHaveLength(count); expect(f.state().creditTransaction).toHaveLength(1);
  });
  it('refuses changed fresh export cost without debit, batch or audit', async () => {
    const f = payrollFixture('createExport'); f.bodies.createExport.expectedCreditCost = 99;
    const before = f.snapshot(); await expect(f.invoke()).rejects.toMatchObject({ status: 409, code: 'payroll_credit_cost_changed' });
    expect(f.state()).toEqual(before); expect(f.attempted).toEqual([]);
  });
  it('retains export snapshot and download ledger integrity refusal before financial effects', async () => {
    const f = payrollFixture('createExport'); f.state().payrollPeriod[0].lockedEntrySha256 = '0'.repeat(64);
    await expect(f.invoke()).rejects.toMatchObject({ status: 409, code: 'payroll_export_integrity_mismatch' }); expect(f.attempted).toEqual([]);
    const download = payrollFixture('downloadExport'); download.state().creditTransaction[0].amount = -2;
    await expect(download.invoke()).rejects.toMatchObject({ status: 503, code: 'payroll_export_integrity_failed' }); expect(download.attempted).toEqual([]);
  });
  it('retains current actor self-approval refusal while historical approver suspension does not invalidate immutable approved evidence', async () => {
    const cards = payrollFixture('decideCards'); cards.state().timeCard[0].userId = ids.actor;
    await expect(cards.invoke()).rejects.toMatchObject({ status: 409, code: 'payroll_self_approval_denied' }); expect(cards.attempted).toEqual([]);
    const amendment = payrollFixture('decideAmendment'); amendment.state().payrollAmendment[0].requestedByUserId = ids.actor;
    await expect(amendment.invoke()).rejects.toMatchObject({ status: 409, code: 'payroll_self_amendment_decision_denied' }); expect(amendment.attempted).toEqual([]);
    const lock = payrollFixture('lockPeriod'); lock.state().user.find(row => row.id === 'payroll-requester')!.suspendedAt = new Date();
    await expect(lock.invoke()).resolves.toMatchObject({ status: 'LOCKED', lockedEntryCount: 1, totalPayableMinutes: 480 });
  });
  it('preserves nonbillable current authority for PAST_DUE and CANCELLED and refuses fresh unsubscribed export', async () => {
    for (const status of ['PAST_DUE', 'CANCELLED']) {
      const policyOwner = payrollFixture('createPolicy'); policyOwner.state().tenant[0].status = status;
      await expect(policyOwner.invoke()).resolves.toMatchObject({ version: 1 });
      const exported = payrollFixture('createExport'); exported.state().tenant[0].status = status;
      await expect(exported.invoke()).rejects.toMatchObject({ status: 403, code: 'time_cards_not_entitled' }); expect(exported.attempted).toEqual([]);
    }
  });
});
