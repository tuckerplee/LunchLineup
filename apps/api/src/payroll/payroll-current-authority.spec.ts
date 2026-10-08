import { ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RbacService } from '../auth/rbac.service';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { PayrollController } from './payroll.controller';
import { PayrollPolicyService } from './payroll-policy.service';
import { PayrollPeriodService } from './payroll-period.service';
import { PayrollCardService } from './payroll-card.service';
import { PayrollLockService } from './payroll-lock.service';
import { PayrollAmendmentService } from './payroll-amendment.service';
import { PayrollExportService } from './payroll-export.service';
import { PayrollReconciliationService } from './payroll-reconciliation.service';
import { buildPayrollCsv, payrollContentSha256, payrollExportLineSha256, type PayrollCsvLine } from './payroll-csv';
import { materializeLockedSnapshots } from './payroll-lock-snapshot';

// Actual controller/owners/TenantPrismaService/RbacService and current-policy
// helpers, with explicit scoped rows and staged callback commit/rollback.
// This is not PostgreSQL locking/MVCC/RLS, HTTP guards, Redis or financial proof.
// The closed FeatureAccess adapter models an already-approved cost and durable
// debit provenance; it does not qualify billing policy or real settlement.
type Row = Record<string, any>;
const actor = { userId: 'operator', tenantId: 'tenant', sessionId: 'exact-session' };
const permissions = ['payroll:policy_write', 'payroll:lock', 'time_cards:approve', 'payroll:export', 'payroll:reconcile', 'payroll:read'];
const commands = ['policy', 'period', 'review', 'adopt', 'decide', 'lock', 'amend', 'amendDecision', 'export', 'download', 'reconcile'] as const;
type Command = typeof commands[number];
const requiredPermission: Record<Command, string> = {
  policy: 'payroll:policy_write', period: 'payroll:policy_write', review: 'payroll:lock', adopt: 'payroll:policy_write',
  decide: 'time_cards:approve', lock: 'payroll:lock', amend: 'payroll:reconcile', amendDecision: 'time_cards:approve',
  export: 'payroll:export', download: 'payroll:export', reconcile: 'payroll:reconcile',
};
const effects: Record<Command, string[]> = {
  policy: ['payrollPolicyVersion.create', 'auditLog.create'],
  period: ['payrollPeriod.create', 'payrollOperation.create', 'auditLog.create'],
  review: ['payrollPeriod.updateMany', 'payrollOperation.create', 'auditLog.create'],
  adopt: ['timeCard.updateMany', 'timeCard.updateMany', 'payrollOperation.create', 'auditLog.create'],
  decide: ['payrollTimeCardApproval.create', 'payrollTimeCardApproval.create', 'payrollOperation.create', 'auditLog.create'],
  lock: ['payrollLockedEntry.createMany', 'payrollPeriod.updateMany', 'auditLog.create'],
  amend: ['payrollAmendment.create', 'auditLog.create'], amendDecision: ['payrollAmendmentDecision.create', 'auditLog.create'],
  export: ['credit.debit', 'payrollExportBatch.create', 'payrollExportLine.createMany', 'auditLog.create'],
  download: ['payrollExportBatch.updateMany', 'auditLog.create'],
  reconcile: ['payrollReconciliationReceipt.create', 'payrollReconciliationLineEvent.createMany',
    'payrollReconciliationLineState.upsert', 'payrollExportBatch.updateMany', 'payrollExportBatch.updateMany', 'auditLog.create'],
};
const copy = <T>(value: T): T => structuredClone(value);
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, wanted]) => {
    if (key === 'OR') return (wanted as Row[]).some(clause => matches(row, clause));
    if (key === 'AND') return (wanted as Row[]).every(clause => matches(row, clause));
    if (key === 'role') return row.role && matches(row.role, wanted);
    if (['tenantId_key', 'batchId_lineId', 'tenantId_provider_providerEventId'].includes(key)) return matches(row, wanted);
    const actual = row[key];
    if (wanted instanceof Date) return actual instanceof Date && actual.getTime() === wanted.getTime();
    if (wanted && typeof wanted === 'object') {
      return Object.entries(wanted).every(([operator, value]) => {
        if (operator === 'in') return (value as any[]).includes(actual);
        if (operator === 'not') return actual !== value;
        if (operator === 'lt') return actual < (value as any);
        if (operator === 'lte') return actual <= (value as any);
        if (operator === 'gt') return actual > (value as any);
        if (operator === 'gte') return actual >= (value as any);
        throw new Error(`Unmodeled payroll selector ${key}.${operator}`);
      });
    }
    return actual === wanted;
  });
}
function ordered(rows: Row[], orderBy: any) {
  const clauses = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  return rows.slice().sort((a, b) => {
    for (const clause of clauses) for (const [key, direction] of Object.entries(clause)) {
      if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * (direction === 'desc' ? -1 : 1);
    }
    return 0;
  });
}
function fixture(command: Command) {
  const initialNow = Date.now(); let now = initialNow; let monotonic = performance.now();
  vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const time = new Date('2026-05-09T12:00:00Z');
  const period = (id = 'period', status = 'OPEN'): Row => ({ id, tenantId: actor.tenantId, policyVersionId: 'policy',
    localStartDate: new Date('2026-05-01T00:00:00Z'), localEndDateExclusive: new Date('2026-05-08T00:00:00Z'),
    startsAt: new Date('2026-05-01T00:00:00Z'), endsAt: new Date('2026-05-08T00:00:00Z'), timeZone: 'UTC',
    cadence: 'WEEKLY', status, revision: 4, createdAt: time, updatedAt: time,
    reviewStartedAt: status === 'REVIEW' ? time : null, reviewStartedByUserId: null,
    lockedAt: null, lockedByUserId: null, lockOperationId: null, lockRequestHash: null,
    lockedEntrySha256: null, lockedEntryCount: null, totalPayableMinutes: null });
  const main = period('period', ['decide', 'lock'].includes(command) ? 'REVIEW'
    : ['amend', 'amendDecision', 'export', 'download', 'reconcile'].includes(command) ? 'LOCKED' : 'OPEN');
  const adjustment: Row = { ...period('adjustment', command === 'amendDecision' ? 'REVIEW' : 'OPEN'),
    startsAt: new Date('2026-05-08T00:00:00Z'), endsAt: new Date('2026-05-15T00:00:00Z'),
    localStartDate: new Date('2026-05-08T00:00:00Z'), localEndDateExclusive: new Date('2026-05-15T00:00:00Z') };
  const card = (id: string): Row => ({ id, tenantId: actor.tenantId, userId: 'staff', locationId: null,
    payrollPeriodId: command === 'adopt' ? null : 'period', workTimeZone: 'UTC', revision: 4,
    clockInAt: new Date('2026-05-02T08:00:00Z'), clockOutAt: new Date('2026-05-02T16:00:00Z'),
    breakMinutes: 30, status: 'CLOSED', deletedAt: null });
  const snapshot = materializeLockedSnapshots({ tenantId: actor.tenantId, periodId: main.id, sources: [{
    sourceType: 'TIME_CARD', sourceId: 'card-1', sourceRevision: 4, employeeId: 'staff', locationId: null,
    workTimeZone: 'UTC', clockInAt: card('card-1').clockInAt, clockOutAt: card('card-1').clockOutAt,
    breakMinutes: 30, payableMinutes: 450, approvedAt: time, approvedByUserId: 'historical-approver',
  }] });
  const entry = { id: 'entry', tenantId: actor.tenantId, periodId: main.id, ...snapshot.entries[0] };
  if (main.status === 'LOCKED') Object.assign(main, { lockedEntryCount: 1, totalPayableMinutes: 450,
    lockedEntrySha256: snapshot.aggregateSha256, lockedAt: time });
  const exportLine = { id: 'line', lineNumber: 1, sourceType: entry.sourceType, sourceId: entry.sourceId,
    employeeId: entry.employeeId, locationId: entry.locationId, workTimeZone: entry.workTimeZone,
    clockInAt: entry.clockInAt, clockOutAt: entry.clockOutAt, breakMinutes: 30, payableMinutes: 450 };
  const csv = buildPayrollCsv([exportLine]);
  const seededBatch = { id: 'batch', tenantId: actor.tenantId, periodId: main.id, operationId: 'seed-export',
    requestHash: 'a'.repeat(64), creditTransactionId: 'feature-usage-payroll-export:seed-export', formatVersion: 1,
    status: command === 'reconcile' ? 'DOWNLOADED' : 'GENERATED', contentSha256: payrollContentSha256(csv),
    rowCount: 1, totalPayableMinutes: 450, consumedCredits: 2, newBalance: 18,
    createdAt: time, updatedAt: time, downloadedAt: command === 'reconcile' ? time : null, reconciledAt: null };
  const user = (id: string, tenantId: string): Row => ({ id, tenantId, role: id === actor.userId ? 'ADMIN' : 'STAFF',
    deletedAt: null, suspendedAt: null, pinResetRequired: false, mfaEnabled: true, lockedUntil: null, pinLockedUntil: null });
  let state = {
    tenants: [{ id: actor.tenantId, status: 'ACTIVE', deletedAt: null, usageCredits: 20, creditDebt: 0 },
      { id: 'foreign', status: 'ACTIVE', deletedAt: null, usageCredits: 77, creditDebt: 0 }] as Row[],
    users: [user(actor.userId, actor.tenantId), user('staff', actor.tenantId), user('foreign-user', 'foreign')] as Row[],
    sessions: [{ id: actor.sessionId, userId: actor.userId, createdAt: new Date(initialNow - 60_000),
      expiresAt: new Date(initialNow + 3_600_000), revokedAt: null },
      { id: 'other-live-session', userId: actor.userId, createdAt: new Date(initialNow),
        expiresAt: new Date(initialNow + 3_600_000), revokedAt: null }] as Row[],
    roles: [{ id: 'custom-role', tenantId: actor.tenantId, name: 'Payroll operator', isSystem: false, legacyRole: null,
      deletedAt: null, rolePermissions: permissions.map(key => ({ permission: { key } })) },
      { id: 'foreign-role', tenantId: 'foreign', deletedAt: null, rolePermissions: permissions.map(key => ({ permission: { key } })) }] as Row[],
    assignments: [{ userId: actor.userId, tenantId: actor.tenantId, roleId: 'custom-role' },
      { userId: 'foreign-user', tenantId: 'foreign', roleId: 'foreign-role' }] as Row[],
    settings: [{ tenantId: actor.tenantId, key: 'workspace_settings', value: { security: { sessionTimeoutMinutes: 480, requireMfaForAll: false } } }] as Row[],
    payrollPolicyVersion: (command === 'policy' ? [] : [{ id: 'policy', tenantId: actor.tenantId, version: 1,
      timeZone: 'UTC', cadence: 'WEEKLY', anchorDate: new Date('2026-05-01T00:00:00Z'),
      effectiveFrom: new Date('2026-05-01T00:00:00Z'), createdByUserId: 'historical-approver', createdAt: time }]) as Row[],
    payrollPeriod: (command === 'period' ? [] : [main, adjustment]) as Row[],
    timeCard: (['review', 'adopt', 'decide', 'lock'].includes(command)
      ? ['adopt', 'decide'].includes(command) ? [card('card-1'), card('card-2')] : [card('card-1')] : []) as Row[],
    payrollTimeCardApproval: (command === 'lock' ? [{ id: 'approval', tenantId: actor.tenantId, periodId: 'period',
      timeCardId: 'card-1', timeCardRevision: 4, decision: 'APPROVED', decidedAt: time, decidedByUserId: 'historical-approver' }] : []) as Row[],
    payrollLockedEntry: (['amend', 'amendDecision', 'export', 'download', 'reconcile'].includes(command) ? [entry] : []) as Row[],
    payrollAmendment: (command === 'amendDecision' ? [{ id: 'amendment', tenantId: actor.tenantId, lockedEntryId: entry.id,
      adjustmentPeriodId: adjustment.id, requestedByUserId: 'requester', reason: 'Valid future correction',
      replacementClockInAt: card('card-1').clockInAt, replacementClockOutAt: new Date('2026-05-02T17:00:00Z'),
      replacementBreakMinutes: 30, replacementPayableMinutes: 510, minuteDelta: 60, createdAt: time }] : []) as Row[],
    payrollAmendmentDecision: [] as Row[], payrollOperation: [] as Row[], auditLog: [] as Row[],
    payrollExportBatch: (['download', 'reconcile'].includes(command) ? [seededBatch] : []) as Row[],
    payrollExportLine: (['download', 'reconcile'].includes(command) ? [{ ...exportLine, tenantId: actor.tenantId,
      batchId: seededBatch.id, lockedEntryId: entry.id, canonicalSha256: payrollExportLineSha256({
        tenantId: actor.tenantId, batchId: seededBatch.id, lockedEntryId: entry.id, line: exportLine }) }] : []) as Row[],
    payrollReconciliationReceipt: [] as Row[], payrollReconciliationLineEvent: [] as Row[], payrollReconciliationLineState: [] as Row[],
    creditTransaction: (['download', 'reconcile'].includes(command) ? [{ id: seededBatch.creditTransactionId,
      tenantId: actor.tenantId, amount: -2, reason: 'Payroll export (period)', balanceAfter: 18 }] : []) as Row[],
  };
  type State = typeof state;
  let draft: State | undefined; let pending: string[] = []; let serial = 0;
  const attempts: string[] = []; const committed: string[] = [];
  const raw: Array<{ sql: string; values: any[]; ordinal: number }> = [];
  const observations: Array<{ active: number; identity: Row }> = [];
  const controls = { active: 0, transactions: 0, finalOrdinal: 2, advisoryVisits: 0,
    advisoryHook: undefined as (() => void) | undefined, finalRoleHook: undefined as (() => void) | undefined,
    effectHook: undefined as ((name: string, index: number) => void) | undefined,
    observerHook: undefined as (() => void | Promise<void>) | undefined, observerTtl: 120_000,
    finalRoleVisits: 0, readHook: undefined as ((name: string, row: any) => void) | undefined,
    afterAbort: undefined as ((error: any) => void) | undefined, observerMode: 'valid' as 'valid' | 'none' | 'throw' };
  const view = () => draft ?? state;
  const effect = (name: string, mutate: (data: State) => unknown) => {
    if (!draft) draft = copy(state);
    attempts.push(name); pending.push(name); const result = mutate(draft);
    controls.effectHook?.(name, pending.length); return copy(result);
  };
  const parts = (query: any, values: any[]) => {
    const flatten = (xs: any[]): any[] => xs.flatMap(value => Array.isArray(value?.values) ? flatten(value.values) : [value]);
    const boundValues = Array.isArray(query) ? values
      : values.length ? values : Array.isArray(query?.values) ? query.values : [];
    return { sql: Array.isArray(query) ? query.join('?') : query.strings?.join('?') ?? '',
      values: flatten(boundValues) };
  };
  const prisma: any = {
    $transaction: vi.fn(async (work: (tx: any) => Promise<unknown>, options: any) => {
      expect(controls.active).toBe(0); if (options) expect(options).toEqual({ isolationLevel: 'Serializable', maxWait: 5000, timeout: 20000 });
      controls.active++; controls.transactions++; draft = undefined; pending = [];
      let failed: any;
      try { const result = await work(prisma); if (draft) { state = draft; committed.push(...pending); } return result; }
      catch (error) { failed = error; throw error; }
      finally { controls.active--; draft = undefined; pending = []; if (failed) controls.afterAbort?.(failed); }
    }),
    $executeRaw: vi.fn(async (query: any, ...values: any[]) => {
      const p = parts(query, values); raw.push({ ...copy(p), ordinal: controls.transactions });
      if (p.sql.includes('set_current_tenant')) { expect(p.values).toEqual([actor.tenantId]); return 1; }
      if (p.sql.includes('pg_advisory_xact_lock')) {
        expect(p.values).toHaveLength(1);
        expect(p.values[0]).toMatch(/^lunchlineup:payroll:tenant(?::(?:period|adjustment))?$/);
        // Original download has no separate replay/preflight transaction and
        // reaches its domain advisory in ordinal1; the fenced owner reaches2.
        // Authority preflight itself never issues a payroll advisory.
        const originalDownload = command === 'download' && controls.transactions === 1;
        if ((controls.transactions === controls.finalOrdinal || originalDownload)
          && p.values[0] === 'lunchlineup:payroll:tenant') {
          controls.advisoryVisits++; controls.advisoryHook?.();
        }
        return 1;
      }
      throw new Error(`Unmodeled payroll raw effect ${p.sql}`);
    }),
    $queryRaw: vi.fn(async (query: any, ...values: any[]) => {
      const p = parts(query, values); raw.push({ ...copy(p), ordinal: controls.transactions });
      if (p.sql.includes('set_config')) { expect(p.values).toEqual([]); return []; }
      if (p.sql.includes('FROM "Tenant"')) return copy(view().tenants.filter(row => p.values.includes(row.id)));
      if (p.sql.includes('FROM "User"')) { const [tenantId, ...ids] = p.values;
        expect(tenantId).toBe(actor.tenantId); return copy(view().users.filter(row => row.tenantId === tenantId && ids.includes(row.id) && !row.deletedAt)); }
      if (p.sql.includes('FROM "Session"')) {
        expect(p.values).toEqual([req.user.sessionId, actor.userId]);
        return copy(view().sessions.filter(row => row.id === p.values[0] && row.userId === p.values[1]));
      }
      if (p.sql.includes('FROM "RoleAssignment"')) { const [tenantId, ...ids] = p.values;
        return copy(view().assignments.filter(row => row.tenantId === tenantId && ids.includes(row.userId))); }
      if (p.sql.includes('FROM "RolePermission"')) {
        if (controls.transactions === controls.finalOrdinal) { controls.finalRoleVisits++; controls.finalRoleHook?.(); }
        return copy(view().roles.filter(row => p.values.includes(row.id)).flatMap(row => row.rolePermissions));
      }
      if (p.sql.includes('FROM "Role"')) return copy(view().roles.filter(row => row.tenantId === p.values[0] && row.id === p.values[1]));
      if (p.sql.includes('FROM "TimeCard" card')) {
        const [tenantId, periodId, endsAt, startsAt] = p.values;
        expect(p.values.slice(0, 2)).toEqual([actor.tenantId, 'period']);
        return copy(view().timeCard.filter(row => row.tenantId === tenantId && (row.payrollPeriodId === periodId
          || !row.deletedAt && row.clockInAt < endsAt && (!row.clockOutAt || row.clockOutAt > startsAt))));
      }
      if (p.sql.includes('FROM "TimeCardBreak"')) { expect(p.values[0]).toBe(actor.tenantId); return []; }
      if (p.sql.includes('FROM "PayrollPeriod"')) return copy(view().payrollPeriod.filter(row => row.tenantId === p.values[0] && row.id === p.values[1]));
      if (p.sql.includes('FROM "PayrollExportBatch"')) return copy(view().payrollExportBatch.filter(row => row.tenantId === p.values[0] && row.id === p.values[1]));
      throw new Error(`Unmodeled payroll raw read ${p.sql}`);
    }),
    tenant: { findUnique: vi.fn(async ({ where }: any) => copy(view().tenants.find(row => matches(row, where)) ?? null)) },
    tenantSetting: { findUnique: vi.fn(async ({ where }: any) => copy(view().settings.find(row => matches(row, where)) ?? null)) },
    user: { findFirst: vi.fn(async ({ where }: any) => copy(view().users.find(row => matches(row, where)) ?? null)) },
    session: { findFirst: vi.fn(async ({ where }: any) => {
      expect(where).toEqual({ id: req.user.sessionId, userId: actor.userId });
      return copy(view().sessions.find(row => matches(row, where)) ?? null);
    }) },
    roleAssignment: { findMany: vi.fn(async ({ where }: any) => view().assignments.flatMap(row => {
      const role = view().roles.find(role => role.id === row.roleId && role.tenantId === row.tenantId);
      const expanded = { ...row, role }; return matches(expanded, where) ? [copy(expanded)] : [];
    })) },
  };
  const tables = ['payrollPolicyVersion', 'payrollPeriod', 'timeCard', 'payrollTimeCardApproval', 'payrollLockedEntry',
    'payrollAmendment', 'payrollAmendmentDecision', 'payrollOperation', 'auditLog', 'payrollExportBatch', 'payrollExportLine',
    'payrollReconciliationReceipt', 'payrollReconciliationLineEvent', 'payrollReconciliationLineState', 'creditTransaction'] as const;
  for (const table of tables) {
    const rows = () => view()[table];
    const read = (method: string, value: any) => { const selected = copy(value);
      controls.readHook?.(`${table}.${method}`, selected); return selected; };
    const prepare = (data: Row): Row => ({ id: `${table}-${++serial}`, createdAt: time, updatedAt: time, decidedAt: time,
      receivedAt: time, revision: 0, status: table === 'payrollExportBatch' ? 'GENERATED' : 'OPEN', ...copy(data) });
    const update = (row: Row, data: Row) => { for (const [key, value] of Object.entries(data))
      row[key] = value && typeof value === 'object' && 'increment' in value ? row[key] + value.increment : copy(value); };
    prisma[table] = {
      findUnique: vi.fn(async ({ where }: any) => read('findUnique', rows().find(row => matches(row, where)) ?? null)),
      findFirst: vi.fn(async ({ where = {}, orderBy }: any) => read('findFirst', ordered(rows().filter(row => matches(row, where)), orderBy)[0] ?? null)),
      findMany: vi.fn(async ({ where = {}, orderBy, take }: any) => read('findMany', ordered(rows().filter(row => matches(row, where)), orderBy).slice(0, take))),
      count: vi.fn(async ({ where }: any) => rows().filter(row => matches(row, where)).length),
      create: vi.fn(async ({ data }: any) => effect(`${table}.create`, value => {
        if (data.tenantId) expect(data.tenantId).toBe(actor.tenantId);
        const created = prepare(data); value[table].push(created); return created;
      })),
      createMany: vi.fn(async ({ data }: any) => effect(`${table}.createMany`, value => {
        data.forEach((row: Row) => expect(row.tenantId).toBe(actor.tenantId));
        value[table].push(...data.map(prepare)); return { count: data.length };
      })),
      updateMany: vi.fn(async ({ where, data }: any) => effect(`${table}.updateMany`, value => {
        const selected = value[table].filter(row => matches(row, where)); selected.forEach(row => update(row, data));
        return { count: selected.length };
      })),
      upsert: vi.fn(async ({ where, create, update: change }: any) => effect(`${table}.upsert`, value => {
        const selected = value[table].find(row => matches(row, where));
        if (selected) { update(selected, change); return selected; }
        const created = prepare(create); value[table].push(created); return created;
      })),
    };
  }
  const tenantDb = new TenantPrismaService(prisma); const rbac = new RbacService(tenantDb);
  const observer = { observeSessionMfa: vi.fn(async (identity: Row) => {
    observations.push({ active: controls.active, identity: copy(identity) });
    expect(controls.active).toBe(0); expect(identity).toEqual({ sub: actor.userId, tenantId: actor.tenantId, sessionId: req.user.sessionId });
    const observation = { ...identity, expiresAtEpochMs: now + controls.observerTtl,
      expiresAtMonotonicMs: performance.now() + controls.observerTtl };
    await controls.observerHook?.();
    if (controls.observerMode === 'throw') throw new Error('Synthetic observer unavailable');
    return controls.observerMode === 'none' ? null : observation as any;
  }) };
  const featureAccess = {
    lockTenantInTransaction: async (tx: any, tenantId: string) => tx.$queryRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE`,
    assertFeatureEnabledInTransaction: async (_tx: any, tenantId: string, feature: string) => {
      expect(tenantId).toBe(actor.tenantId); expect(feature).toBe('time_cards');
      return { enabled: true, source: 'credits', creditCost: 2 };
    },
    recordFeatureUsageInTransaction: async (_tx: any, tenantId: string, resolution: Row, reason: string, operationId: string, transactionId?: string, assertCurrent?: () => void) => {
      expect(transactionId).toBeUndefined(); expect(typeof assertCurrent).toBe('function'); assertCurrent!();
      const result = effect('credit.debit', value => {
        expect(tenantId).toBe(actor.tenantId); expect(resolution.creditCost).toBe(2);
        const tenant = value.tenants.find(row => row.id === tenantId)!; tenant.usageCredits -= 2;
        value.creditTransaction.push({ id: `feature-usage-${operationId}`, tenantId, amount: -2,
          reason, balanceAfter: tenant.usageCredits }); return { consumedCredits: 2, newBalance: tenant.usageCredits };
      }); assertCurrent!(); return result; },
  };
  // The appended dependencies are deliberately ignored by the original owners;
  // the same real Rbac/observer become active when the source fence is integrated.
  const make = (Owner: any) => new Owner(tenantDb, rbac, observer);
  const controller = new PayrollController(make(PayrollPolicyService), make(PayrollPeriodService), make(PayrollCardService),
    make(PayrollAmendmentService), {} as any, make(PayrollLockService),
    new (PayrollExportService as any)(tenantDb, featureAccess, rbac, observer), make(PayrollReconciliationService));
  const req = { user: { sub: actor.userId, tenantId: actor.tenantId, sessionId: actor.sessionId,
    permissions: permissions.slice(), mfaVerified: true } };
  const headers: Record<string, string> = {}; const sent: Buffer[] = [];
  const response = { setHeader: (key: string, value: string) => { expect(controls.active).toBe(0); headers[key] = value; },
    send: (bytes: Buffer) => { expect(controls.active).toBe(0); sent.push(Buffer.from(bytes)); } };
  const key = `authority-${command}`;
  const invoke = () => {
    switch (command) {
      case 'policy': return controller.createPolicy(req, { timeZone: 'UTC', cadence: 'WEEKLY', anchorDate: '2026-05-01', effectiveFrom: '2026-05-01' }, key);
      case 'period': return controller.createPeriod(req, { localStartDate: '2026-05-01' }, key);
      case 'review': return controller.startReview(req, 'period', { expectedRevision: 4 }, key);
      case 'adopt': return controller.adoptCards(req, 'period', { cards: ['card-1', 'card-2'].map(id => ({ id, expectedRevision: 4 })) }, key);
      case 'decide': return controller.decideCards(req, 'period', { decisions: ['card-1', 'card-2'].map(timeCardId => ({ timeCardId, expectedRevision: 4, decision: 'APPROVED' })) }, key);
      case 'lock': return controller.lockPeriod(req, 'period', { expectedRevision: 4 }, key);
      case 'amend': return controller.createAmendment(req, 'entry', { adjustmentPeriodId: 'adjustment', reason: 'Valid future correction', replacementClockInAt: '2026-05-02T08:00:00Z', replacementClockOutAt: '2026-05-02T17:00:00Z', replacementBreakMinutes: 30 }, key);
      case 'amendDecision': return controller.decideAmendment(req, 'amendment', { decision: 'APPROVED' }, key);
      case 'export': return controller.createExport(req, 'period', { expectedCreditCost: 2 }, key);
      case 'download': return controller.downloadExport(req, 'batch', response);
      case 'reconcile': return controller.reconcileExport(req, 'batch', { provider: 'controlled', providerEventId: 'event', providerTotalMinutes: 450, outcomes: [{ lineId: 'line', status: 'ACCEPTED' }] });
    }
  };
  return { invoke, controls, observer, rbac, prisma, req, raw, attempts, committed, headers, sent,
    observations, get state() { return state; }, snapshot: () => copy(state), advance: (ms: number) => { now += ms; }, advanceMonotonic: (ms: number) => { monotonic += ms; } };
}
afterEach(() => vi.restoreAllMocks());

describe('actual legacy payroll owner current authority (modeled database)', () => {
  for (const command of commands) {
    it(`${command}: valid current actor commits the populated scoped command`, async () => {
      const f = fixture(command); const foreign = copy(f.state.tenants[1]);
      await f.invoke();
      expect(f.attempts).toEqual(effects[command]); expect(f.committed).toEqual(effects[command]);
      expect(f.controls.active).toBe(0); expect(f.state.tenants[1]).toEqual(foreign);
      expect(f.state.auditLog).toHaveLength(1);
      expect(f.state.auditLog[0]).toMatchObject({ tenantId: actor.tenantId, actorTenantId: actor.tenantId, actorUserId: actor.userId });
      if (command === 'export') { expect(f.state.tenants[0].usageCredits).toBe(18); expect(f.state.creditTransaction).toHaveLength(1); }
      if (command === 'download') { expect(f.sent).toHaveLength(1); expect(f.sent[0].equals(buildPayrollCsv([f.state.payrollExportLine[0] as PayrollCsvLine]))).toBe(true); }
      if (command === 'reconcile') expect(f.state.payrollExportBatch[0].status).toBe('RECONCILED');
    });
    it(`${command}: refuses a revoked exact session after request admission despite another live session`, async () => {
      const f = fixture(command); f.state.sessions[0].revokedAt = new Date(); const before = f.snapshot();
      await expect(f.invoke()).rejects.toBeInstanceOf(ForbiddenException);
      expect(f.attempts).toEqual([]); expect(f.committed).toEqual([]); expect(f.snapshot()).toEqual(before); expect(f.sent).toEqual([]);
    });
    it(`${command}: refuses the removed current custom-role required grant after request admission`, async () => {
      const f = fixture(command); f.state.roles[0].rolePermissions = f.state.roles[0].rolePermissions
        .filter((grant: Row) => grant.permission.key !== requiredPermission[command]); const before = f.snapshot();
      await expect(f.invoke()).rejects.toBeInstanceOf(ForbiddenException);
      expect(f.attempts).toEqual([]); expect(f.committed).toEqual([]); expect(f.snapshot()).toEqual(before); expect(f.sent).toEqual([]);
    });
    it(`${command}: refuses effective session expiry at the final transaction payroll advisory wait`, async () => {
      const f = fixture(command);
      f.state.settings[0].value.security.sessionTimeoutMinutes = 5;
      f.state.sessions[0].createdAt = new Date(Date.now() - 4 * 60_000);
      // Stored and observed MFA lifetimes remain future; only effective expiry crosses.
      f.controls.observerTtl = 3_600_000;
      f.controls.advisoryHook = () => f.advance(60_000); const before = f.snapshot();
      await expect(f.invoke()).rejects.toBeInstanceOf(ForbiddenException);
      expect(f.controls.advisoryVisits).toBe(1); expect(f.attempts).toEqual([]);
      expect(f.committed).toEqual([]); expect(f.snapshot()).toEqual(before); expect(f.sent).toEqual([]);
    });
  }
});

type Deadline = 'stored' | 'effective' | 'mfa-wall' | 'mfa-monotonic';
function deadline(f: ReturnType<typeof fixture>, axis: Deadline) {
  f.controls.observerTtl = axis.startsWith('mfa-') ? 1000 : 3_600_000;
  if (axis === 'stored') f.state.sessions[0].expiresAt = new Date(Date.now() + 1000);
  if (axis === 'effective') {
    f.state.settings[0].value.security.sessionTimeoutMinutes = 5;
    f.state.sessions[0].createdAt = new Date(Date.now() - 4 * 60_000);
  }
  return () => axis === 'mfa-monotonic' ? f.advanceMonotonic(1000)
    : f.advance(axis === 'effective' ? 60_000 : 1000);
}
const replayRead: Record<Command, string> = {
  policy: 'payrollPolicyVersion.findUnique', period: 'payrollOperation.findUnique', review: 'payrollOperation.findUnique',
  adopt: 'payrollOperation.findUnique', decide: 'payrollOperation.findUnique', lock: 'payrollPeriod.findFirst',
  amend: 'payrollAmendment.findUnique', amendDecision: 'payrollAmendmentDecision.findUnique',
  export: 'payrollExportBatch.findUnique', download: 'payrollExportLine.findMany', reconcile: 'payrollReconciliationReceipt.findUnique',
};
function freshRequest(f: ReturnType<typeof fixture>) {
  f.controls.transactions = 0; f.controls.advisoryVisits = 0; f.controls.finalRoleVisits = 0;
  f.attempts.splice(0); f.committed.splice(0); f.sent.splice(0); f.observer.observeSessionMfa.mockClear();
}

describe('legacy payroll integrated current-authority lifetime and staged rollback', () => {
  for (const command of commands) {
    for (const change of ['tenant', 'account', 'pin', 'session', 'grant', 'timeout'] as const) {
      it(`${command}: rereads ${change} authority after the released outside observer`, async () => {
        const f = fixture(command); let external: ReturnType<typeof f.snapshot> | undefined;
        f.controls.observerHook = () => {
          expect(f.controls.active).toBe(0); expect(f.controls.transactions).toBe(1);
          if (change === 'tenant') f.state.tenants[0].status = 'SUSPENDED';
          if (change === 'account') f.state.users[0].suspendedAt = new Date();
          if (change === 'pin') f.state.users[0].pinResetRequired = true;
          if (change === 'session') f.state.sessions[0].revokedAt = new Date();
          if (change === 'grant') f.state.roles[0].rolePermissions = f.state.roles[0].rolePermissions.filter((r: Row) => r.permission.key !== requiredPermission[command]);
          if (change === 'timeout') { f.state.settings[0].value.security.sessionTimeoutMinutes = 5; f.state.sessions[0].createdAt = new Date(Date.now() - 5 * 60_000); }
          external = f.snapshot();
        };
        await expect(f.invoke()).rejects.toBeInstanceOf(ForbiddenException);
        expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce(); expect(external).toBeDefined();
        expect(f.controls.transactions).toBe(2); expect(f.controls.active).toBe(0);
        expect(f.attempts).toEqual([]); expect(f.committed).toEqual([]); expect(f.sent).toEqual([]); expect(f.snapshot()).toEqual(external);
      });
    }
    for (const mode of ['none', 'throw'] as const) {
      it(`${command}: refuses ${mode} MFA observation before domain effects`, async () => {
        const f = fixture(command); f.controls.observerMode = mode; const before = f.snapshot();
        await expect(f.invoke()).rejects.toBeInstanceOf(mode === 'none' ? ForbiddenException : ServiceUnavailableException);
        expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce(); expect(f.controls.transactions).toBe(1);
        expect(f.observations).toEqual([{ active: 0, identity: { sub: actor.userId, tenantId: actor.tenantId, sessionId: actor.sessionId } }]);
        expect(f.controls.active).toBe(0); expect(f.attempts).toEqual([]); expect(f.committed).toEqual([]); expect(f.snapshot()).toEqual(before); expect(f.sent).toEqual([]);
      });
    }
    for (const axis of ['stored', 'effective', 'mfa-wall', 'mfa-monotonic'] as const) {
      it(`${command}: refuses independent ${axis} expiry at final transaction RolePermission completion`, async () => {
        const f = fixture(command); const expire = deadline(f, axis); const before = f.snapshot(); const wall = Date.now();
        f.controls.finalRoleHook = expire;
        await expect(f.invoke()).rejects.toBeInstanceOf(ForbiddenException);
        expect(f.controls.finalRoleVisits).toBe(1); expect(f.controls.transactions).toBe(2);
        if (axis === 'mfa-monotonic') expect(Date.now()).toBe(wall);
        expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce(); expect(f.controls.active).toBe(0);
        expect(f.attempts).toEqual([]); expect(f.committed).toEqual([]); expect(f.snapshot()).toEqual(before); expect(f.sent).toEqual([]);
      });
      for (const [index, name] of effects[command].entries()) {
        it(`${command}: rolls back exact prefix on ${axis} expiry after effect ${index + 1} ${name}`, async () => {
          const f = fixture(command); const expire = deadline(f, axis); const before = f.snapshot(); const wall = Date.now(); let reached = 0;
          f.controls.effectHook = (actual, ordinal) => { if (ordinal === index + 1) { expect(actual).toBe(name); reached++; expire(); } };
          await expect(f.invoke()).rejects.toBeInstanceOf(ForbiddenException);
          expect(reached).toBe(1); expect(f.attempts).toEqual(effects[command].slice(0, index + 1));
          expect(f.committed).toEqual([]); expect(f.snapshot()).toEqual(before); expect(f.sent).toEqual([]);
          expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce(); expect(f.controls.transactions).toBe(2); expect(f.controls.active).toBe(0);
          if (axis === 'mfa-monotonic') expect(Date.now()).toBe(wall);
        });
      }
    }
    it(`${command}: exact same-session replay or repeated download remains authorized with zero new effects`, async () => {
      const f = fixture(command); await f.invoke(); freshRequest(f); const before = f.snapshot();
      await f.invoke(); expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce(); expect(f.controls.transactions).toBe(2);
      expect(f.attempts).toEqual([]); expect(f.committed).toEqual([]); expect(f.snapshot()).toEqual(before); expect(f.controls.active).toBe(0);
      expect(f.sent).toHaveLength(command === 'download' ? 1 : 0);
    });
    it(`${command}: revoked exact session cannot retrieve the existing replay or repeated download`, async () => {
      const f = fixture(command); await f.invoke(); freshRequest(f); f.state.sessions[0].revokedAt = new Date(); const before = f.snapshot();
      await expect(f.invoke()).rejects.toBeInstanceOf(ForbiddenException);
      expect(f.observer.observeSessionMfa).not.toHaveBeenCalled(); expect(f.attempts).toEqual([]); expect(f.committed).toEqual([]); expect(f.snapshot()).toEqual(before); expect(f.sent).toEqual([]);
    });
    it(`${command}: expiry after actual final replay response read refuses with zero new effects`, async () => {
      const f = fixture(command); await f.invoke(); freshRequest(f); const expire = deadline(f, 'effective'); const before = f.snapshot(); let reached = 0;
      f.controls.readHook = (name, row) => { if (f.controls.transactions === 2 && name === replayRead[command] && row) { reached++; expire(); } };
      await expect(f.invoke()).rejects.toBeInstanceOf(ForbiddenException);
      expect(reached).toBe(1); expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce(); expect(f.controls.transactions).toBe(2);
      expect(f.attempts).toEqual([]); expect(f.committed).toEqual([]); expect(f.snapshot()).toEqual(before); expect(f.sent).toEqual([]); expect(f.controls.active).toBe(0);
    });
    it(`${command}: serialization retry discards first draft and reuses one observation`, async () => {
      const f = fixture(command); let failed = 0;
      f.controls.effectHook = (_name, index) => { if (f.controls.transactions === 2 && index === 1) { failed++; throw { code: 'P2034' }; } };
      await f.invoke(); expect(failed).toBe(1); expect(f.controls.transactions).toBe(3); expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce();
      expect(f.attempts).toEqual([effects[command][0], ...effects[command]]); expect(f.committed).toEqual(effects[command]); expect(f.state.auditLog).toHaveLength(1); expect(f.controls.active).toBe(0);
      if (command === 'export') expect(f.state.tenants[0].usageCredits).toBe(18);
    });
    it(`${command}: retry rereads revoked exact session after aborted draft without another observation`, async () => {
      const f = fixture(command); let external: ReturnType<typeof f.snapshot> | undefined;
      f.controls.effectHook = (_name, index) => { if (f.controls.transactions === 2 && index === 1) throw { code: 'P2034' }; };
      f.controls.afterAbort = error => { if (error.code === 'P2034') { expect(f.controls.active).toBe(0); f.state.sessions[0].revokedAt = new Date(); external = f.snapshot(); } };
      await expect(f.invoke()).rejects.toBeInstanceOf(ForbiddenException);
      expect(external).toBeDefined(); expect(f.controls.transactions).toBe(3); expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce();
      expect(f.attempts).toEqual(effects[command].slice(0, 1)); expect(f.committed).toEqual([]); expect(f.snapshot()).toEqual(external); expect(f.sent).toEqual([]); expect(f.controls.active).toBe(0);
    });
  }
});

const recoverable = ['policy', 'period', 'decide', 'amend', 'amendDecision', 'export', 'reconcile'] as const;
const racedTables: Record<typeof recoverable[number], string[]> = {
  policy: ['payrollPolicyVersion'], period: ['payrollOperation'], decide: ['payrollOperation'],
  amend: ['payrollAmendment'], amendDecision: ['payrollAmendmentDecision'],
  export: ['payrollExportBatch', 'creditTransaction'], reconcile: ['payrollReconciliationReceipt'],
};
describe('legacy payroll explicit fresh-transaction receipt recovery', () => {
  for (const command of recoverable) {
    for (const serialFirst of [false, true]) {
      it(`${command}: unique receipt recovery after ${serialFirst ? 'second' : 'first'} domain attempt uses same observation and no new debit`, async () => {
        const winner = fixture(command); await winner.invoke(); const receiptState: any = winner.snapshot();
        const f = fixture(command); let unique = 0;
        f.controls.effectHook = (_name, index) => { if (index === 1) { if (serialFirst && f.controls.transactions === 2) throw { code: 'P2034' }; unique++; throw { code: 'P2002' }; } };
        f.controls.afterAbort = error => { if (error.code === 'P2002') { expect(f.controls.active).toBe(0); for (const table of racedTables[command]) (f.state as any)[table] = copy(receiptState[table]); } };
        await f.invoke(); expect(unique).toBe(1); expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce(); expect(f.controls.transactions).toBe(serialFirst ? 4 : 3);
        expect(f.attempts).toEqual(Array(serialFirst ? 2 : 1).fill(effects[command][0])); expect(f.committed).toEqual([]); expect(f.state.auditLog).toEqual([]); expect(f.controls.active).toBe(0);
        expect(f.state.tenants[0].usageCredits).toBe(20);
      });
    }
    it(`${command}: unique recovery absence preserves original conflict without new domain effects`, async () => {
      const f = fixture(command); const before = f.snapshot(); f.controls.effectHook = (_name, index) => { if (index === 1) throw { code: 'P2002' }; };
      await expect(f.invoke()).rejects.toBeInstanceOf(ConflictException);
      expect(f.controls.transactions).toBe(3); expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce(); expect(f.attempts).toEqual(effects[command].slice(0, 1));
      expect(f.committed).toEqual([]); expect(f.snapshot()).toEqual(before); expect(f.controls.active).toBe(0);
    });
    it(`${command}: unique recovery refuses current actor revocation without a second observation`, async () => {
      const f = fixture(command); let external: ReturnType<typeof f.snapshot> | undefined;
      f.controls.effectHook = (_name, index) => { if (index === 1) throw { code: 'P2002' }; };
      f.controls.afterAbort = error => { if (error.code === 'P2002') { expect(f.controls.active).toBe(0); f.state.sessions[0].revokedAt = new Date(); external = f.snapshot(); } };
      await expect(f.invoke()).rejects.toBeInstanceOf(ForbiddenException); expect(f.controls.transactions).toBe(3);
      expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce(); expect(f.attempts).toEqual(effects[command].slice(0, 1)); expect(f.committed).toEqual([]); expect(f.snapshot()).toEqual(external); expect(f.sent).toEqual([]); expect(f.controls.active).toBe(0);
    });
  }
  for (const code of ['55P03', 'nested55P03'] as const) {
    it(`export: ${code} without durable replay remains503 and cannot debit in recovery`, async () => {
      const f = fixture('export'); const before = f.snapshot();
      f.controls.advisoryHook = () => { throw code === '55P03' ? { code } : { code: 'P2010', meta: { code: '55P03' } }; };
      await expect(f.invoke()).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(f.controls.transactions).toBe(3); expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce(); expect(f.attempts).toEqual([]); expect(f.committed).toEqual([]); expect(f.snapshot()).toEqual(before); expect(f.controls.active).toBe(0);
    });
  }
});

describe('legacy payroll replay identity and recovery late read controls', () => {
  for (const command of commands) {
    it(`${command}: another live exact session of the same actor preserves stored request replay identity`, async () => {
      const f = fixture(command); await f.invoke(); freshRequest(f); f.req.user.sessionId = 'other-live-session'; const before = f.snapshot();
      await f.invoke(); expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce();
      expect(f.observations.at(-1)).toEqual({ active: 0, identity: { sub: actor.userId, tenantId: actor.tenantId, sessionId: 'other-live-session' } });
      expect(f.controls.transactions).toBe(2); expect(f.attempts).toEqual([]); expect(f.committed).toEqual([]); expect(f.snapshot()).toEqual(before); expect(f.controls.active).toBe(0);
    });
  }
  for (const command of recoverable) {
    it(`${command}: current receipt recovery lifetime expires after its actual final read`, async () => {
      const winner = fixture(command); await winner.invoke(); const receiptState: any = winner.snapshot();
      const f = fixture(command); const expire = deadline(f, 'effective'); let external: ReturnType<typeof f.snapshot> | undefined; let reached = 0;
      f.controls.effectHook = (_name, index) => { if (index === 1) throw { code: 'P2002' }; };
      f.controls.afterAbort = error => { if (error.code === 'P2002') { for (const table of racedTables[command]) (f.state as any)[table] = copy(receiptState[table]); external = f.snapshot(); } };
      f.controls.readHook = (name, row) => { if (f.controls.transactions === 3 && name === replayRead[command] && row) { reached++; expire(); } };
      await expect(f.invoke()).rejects.toBeInstanceOf(ForbiddenException); expect(reached).toBe(1); expect(external).toBeDefined();
      expect(f.controls.transactions).toBe(3); expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce(); expect(f.attempts).toEqual(effects[command].slice(0, 1)); expect(f.committed).toEqual([]); expect(f.snapshot()).toEqual(external); expect(f.sent).toEqual([]); expect(f.controls.active).toBe(0);
    });
    it(`${command}: changed raced receipt digest remains a conflict under current authority`, async () => {
      const winner = fixture(command); await winner.invoke(); const receiptState: any = winner.snapshot();
      const f = fixture(command); let external: ReturnType<typeof f.snapshot> | undefined;
      f.controls.effectHook = (_name, index) => { if (index === 1) throw { code: 'P2002' }; };
      f.controls.afterAbort = error => { if (error.code === 'P2002') {
        for (const table of racedTables[command]) (f.state as any)[table] = copy(receiptState[table]);
        const receipt = (f.state as any)[racedTables[command][0]][0]; receipt[command === 'reconcile' ? 'payloadSha256' : 'requestHash'] = '0'.repeat(64); external = f.snapshot();
      } };
      await expect(f.invoke()).rejects.toBeInstanceOf(ConflictException); expect(external).toBeDefined(); expect(f.controls.transactions).toBe(3);
      expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce(); expect(f.attempts).toEqual(effects[command].slice(0, 1)); expect(f.committed).toEqual([]); expect(f.snapshot()).toEqual(external); expect(f.controls.active).toBe(0);
    });
  }
  for (const nested of [false, true]) {
    it(`export: ${nested ? 'nested' : 'raw'}55P03 recovery returns the exact raced batch without a new debit`, async () => {
      const winner = fixture('export'); await winner.invoke(); const receiptState: any = winner.snapshot(); const f = fixture('export');
      f.controls.advisoryHook = () => { throw nested ? { code: 'P2010', meta: { code: '55P03' } } : { code: '55P03' }; };
      f.controls.afterAbort = error => { if (error.code === '55P03' || error.meta?.code === '55P03') { for (const table of racedTables.export) (f.state as any)[table] = copy(receiptState[table]); } };
      await expect(f.invoke()).resolves.toMatchObject({ id: receiptState.payrollExportBatch[0].id, contentSha256: receiptState.payrollExportBatch[0].contentSha256 });
      expect(f.controls.transactions).toBe(3); expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce(); expect(f.attempts).toEqual([]); expect(f.committed).toEqual([]); expect(f.state.tenants[0].usageCredits).toBe(20); expect(f.state.auditLog).toEqual([]); expect(f.controls.active).toBe(0);
    });
  }
});

describe('legacy payroll requires an exact session for every mutation', () => {
  for (const command of commands) {
    it(`${command}: missing Session identity refuses before any database work or observation`, async () => {
      const f = fixture(command); f.req.user.sessionId = undefined as any; const before = f.snapshot();
      await expect(f.invoke()).rejects.toBeInstanceOf(ForbiddenException);
      expect(f.controls.transactions).toBe(0); expect(f.observer.observeSessionMfa).not.toHaveBeenCalled();
      expect(f.attempts).toEqual([]); expect(f.committed).toEqual([]); expect(f.snapshot()).toEqual(before); expect(f.sent).toEqual([]);
    });
  }
});
