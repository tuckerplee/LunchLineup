import { performance } from 'node:perf_hooks';
import { setTimeout as realTimeout, clearTimeout as realClearTimeout } from 'node:timers';
import type { SessionIdentity } from '@lunchlineup/api-contract';
import type { MfaSessionIdentity } from '@lunchlineup/rbac';
import { expect, vi } from 'vitest';
import { TenantDatabase } from '../../apps/api-v2/src/platform/database';
import { TenantPrismaService } from '../../apps/api/src/database/tenant-prisma.service';
import { RbacService } from '../../apps/api/src/auth/rbac.service';
import { authorizeCurrentMutation, assertCurrentMutation } from '../../apps/api-v2/src/people/mutation-authority';
import { buildPayrollCsv, payrollContentSha256, payrollExportLineSha256 } from '../../apps/api-v2/src/payroll/domain';

// Closed, read-only committed-row adapter for actual owners/current helpers.
// It models callback snapshots and legal writer-first scheduling, not SQL locks,
// MVCC/SSI/RLS, HTTP guards, Redis, or real financial/provider settlement.
export type Row = Record<string, any>;
export type Deadline = 'stored' | 'policy' | 'mfa-wall' | 'mfa-monotonic';
export type ReadGate = 'page' | 'final';
export const NOW = Date.parse('2026-10-05T12:00:00Z');
export const ids = { tenant: 'read-tenant', actor: 'read-actor', session: 'read-session', role: 'read-role',
  batch: 'read-batch', period: 'read-period', employee: 'historical-staff', location: 'historical-location' };
export const uuid = (n: number) => `6b22cfea-b6e6-4afa-8a3b-${String(n).padStart(12, '0')}`;
const clone = <T>(v: T): T => structuredClone(v);
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
export async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof realTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = realTimeout(() => reject(new Error('Controlled payroll gate did not settle within 2000ms')), 2000);
  })]); } finally { if (timer) realClearTimeout(timer); }
}
const flatten = (values: unknown[]): unknown[] => values.flatMap(v => v && typeof v === 'object' && 'values' in v
  ? flatten((v as { values: unknown[] }).values) : [v]);

export function payrollReadFixture(flavor: 'native' | 'retained', deadline: Deadline = 'stored') {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  let monotonic = 100_000;
  vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
  const time = new Date('2026-05-09T12:00:00Z');
  const tables: Record<string, Row[]> = {
    tenant: [{ id: ids.tenant, status: 'ACTIVE', deletedAt: null }],
    user: [{ id: ids.actor, tenantId: ids.tenant, publicId: uuid(1), role: 'ADMIN', name: 'Reader', email: null,
      username: 'reader', deletedAt: null, suspendedAt: null, lockedUntil: null, pinLockedUntil: null,
      pinResetRequired: false, mfaEnabled: true },
      { id: ids.employee, tenantId: ids.tenant, publicId: uuid(2), role: 'STAFF', deletedAt: time, suspendedAt: time }],
    session: [{ id: ids.session, userId: ids.actor, createdAt: new Date(NOW - (deadline === 'policy' ? 240_000 : 60_000)),
      expiresAt: new Date(NOW + (deadline === 'stored' ? 1000 : 3_600_000)), revokedAt: null }],
    tenantSetting: [{ tenantId: ids.tenant, key: 'workspace_settings', value: { security: {
      sessionTimeoutMinutes: deadline === 'policy' ? 5 : 480, requireMfaForAll: false } } }],
    role: [{ id: ids.role, tenantId: ids.tenant, publicId: uuid(3), name: 'Payroll reader', slug: 'payroll-reader',
      description: null, isSystem: false, isDefault: false, legacyRole: null, deletedAt: null,
      rolePermissions: [{ permission: { key: 'payroll:read' } }] }],
    roleAssignment: [{ tenantId: ids.tenant, userId: ids.actor, roleId: ids.role }],
    payrollPeriod: [{ id: ids.period, tenantId: ids.tenant, publicId: uuid(4) }],
    location: [{ id: ids.location, tenantId: ids.tenant, publicId: uuid(5), deletedAt: time }],
    timeCard: [], payrollLockedEntry: [], payrollExportLine: [], payrollExportBatch: [],
    payrollReconciliationLineState: [], payrollReconciliationReceipt: [], creditTransaction: [], auditLog: [],
  };
  const publicLines = [1, 2].map(n => {
    const card = { id: `historical-card-${n}`, tenantId: ids.tenant, publicId: uuid(10 + n), deletedAt: time };
    const entry = { id: `locked-${n}`, tenantId: ids.tenant, publicId: uuid(20 + n) };
    const line: Row = { id: `line-${n}`, publicId: uuid(30 + n), tenantId: ids.tenant, batchId: ids.batch,
      lineNumber: n, lockedEntryId: entry.id, employeeId: ids.employee, locationId: ids.location,
      sourceType: 'TIME_CARD', sourceId: card.id, workTimeZone: 'UTC', clockInAt: time,
      clockOutAt: new Date(time.getTime() + 480 * 60_000), breakMinutes: 0, payableMinutes: 480 };
    const publicLine = { id: line.publicId, lineNumber: n, sourceType: 'TIME_CARD' as const, sourceId: card.publicId,
      employeeId: uuid(2), locationId: uuid(5), workTimeZone: 'UTC', clockInAt: line.clockInAt,
      clockOutAt: line.clockOutAt, breakMinutes: 0, payableMinutes: 480 };
    line.canonicalSha256 = payrollExportLineSha256({ tenantId: ids.tenant, batchId: ids.batch, lockedEntryId: entry.id, line: publicLine });
    tables.timeCard.push(card); tables.payrollLockedEntry.push(entry); tables.payrollExportLine.push(line);
    return publicLine;
  });
  const batch = { id: ids.batch, publicId: uuid(6), tenantId: ids.tenant, periodId: ids.period,
    operationId: 'read-export-operation', requestHash: 'b'.repeat(64),
    creditTransactionId: 'feature-usage-payroll-export:read-export-operation', formatVersion: 1,
    status: 'GENERATED', rowCount: 2, totalPayableMinutes: 960, consumedCredits: 1, newBalance: 9,
    contentSha256: payrollContentSha256(buildPayrollCsv(publicLines)), createdAt: time, updatedAt: time,
    downloadedAt: null, reconciledAt: null };
  tables.payrollExportBatch.push(batch);
  tables.creditTransaction.push({ id: batch.creditTransactionId, tenantId: ids.tenant, amount: -1, debtAmount: 0,
    reason: `Payroll export (${ids.period})`, balanceAfter: 9, debtAfter: 0 });
  tables.payrollReconciliationLineState.push({ tenantId: ids.tenant, batchId: ids.batch, lineId: 'line-1', status: 'ACCEPTED', reason: null });
  tables.payrollReconciliationReceipt.push({ id: 'receipt', publicId: uuid(40), tenantId: ids.tenant, batchId: ids.batch,
    receivedAt: time, provider: 'controlled-provider', providerEventId: 'event-1', payloadSha256: 'c'.repeat(64), providerTotalMinutes: 960 });
  const financial = () => clone(Object.fromEntries(Object.entries(tables).filter(([name]) =>
    !['tenant', 'user', 'session', 'tenantSetting', 'role', 'roleAssignment'].includes(name))));
  const errors: string[] = [], reads: Row[] = [], effects: Row[] = [], contexts: Row[] = [], observations: Row[] = [];
  let active = 0, phase = 'admission', writer: (() => void) | undefined;
  let pause: ReadGate | undefined, gateHits = 0;
  const arrived = deferred(), release = deferred();
  function require(ok: boolean, message: string) { if (!ok) { errors.push(message); throw new Error(message); } }
  function equal(actual: unknown, expected: unknown, label: string) {
    require(JSON.stringify(actual) === JSON.stringify(expected), `${label}: ${JSON.stringify(actual)}`);
  }
  function match(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, wanted]) => {
      if (key === 'tenantId_key') return match(row, wanted);
      if (key === 'role') return match(tables.role.find(r => r.id === row.roleId) ?? {}, wanted);
      if (wanted && typeof wanted === 'object' && !(wanted instanceof Date)) {
        return Object.entries(wanted).every(([op, value]) => {
          require(op === 'in' || op === 'gt', `Unknown selector ${key}.${op}`);
          return op === 'in' ? (value as unknown[]).includes(row[key]) : row[key] > (value as number);
        });
      }
      return row[key] === wanted;
    });
  }
  function project(row: Row, select?: Row): Row {
    if (!select) return clone(row);
    const out: Row = {};
    for (const [key, value] of Object.entries(select)) {
      require(value === true || key === 'rolePermissions', `Unknown projection ${key}`);
      out[key] = clone(row[key]);
    }
    return out;
  }
  async function query(table: string, method: string, args: Row, snapshot: Record<string, Row[]>) {
    reads.push({ phase, table, method, args: clone(args) });
    require(Object.keys(args).every(k => ['where', 'select', 'include', 'orderBy', 'take', 'by', '_count'].includes(k)), `Unknown query option ${table}`);
    const where = args.where ?? {};
    if (table === 'tenant') equal(where, { id: ids.tenant }, 'Tenant selector');
    else if (table === 'session') equal(where, { id: ids.session, userId: ids.actor }, 'Exact Session selector');
    else if (table === 'tenantSetting') equal(where, { tenantId_key: { tenantId: ids.tenant, key: 'workspace_settings' } }, 'Policy selector');
    else if (table === 'creditTransaction') {
      equal(where, { id: batch.creditTransactionId }, 'Ledger exact immutable id');
      equal(args.select, { id: true, tenantId: true, amount: true, debtAmount: true, reason: true, balanceAfter: true, debtAfter: true }, 'Ledger fields');
    } else {
      require(where.tenantId === ids.tenant, `Unscoped ${table} query`);
      const allowed: Record<string, string[]> = {
        user: ['tenantId', 'id', 'deletedAt', 'suspendedAt'], role: ['tenantId', 'id', 'deletedAt'],
        roleAssignment: ['tenantId', 'userId', 'role'], payrollExportBatch: ['tenantId', 'id', 'publicId'],
        payrollExportLine: ['tenantId', 'batchId', 'id', 'publicId', 'lineNumber'],
        payrollReconciliationLineState: ['tenantId', 'batchId', 'lineId'], payrollReconciliationReceipt: ['tenantId', 'batchId'],
        payrollPeriod: ['tenantId', 'id'], payrollLockedEntry: ['tenantId', 'id'], location: ['tenantId', 'id'], timeCard: ['tenantId', 'id'],
      };
      require(Boolean(allowed[table]) && Object.keys(where).every(k => allowed[table].includes(k)), `Unknown ${table} selector`);
      if (table === 'payrollExportBatch') equal(where, flavor === 'native'
        ? { tenantId: ids.tenant, publicId: uuid(6) } : { id: ids.batch, tenantId: ids.tenant }, 'Exact export target');
      if (table.startsWith('payrollReconciliation') || table === 'payrollExportLine') require(where.batchId === ids.batch, 'Export batch scope');
      if (['payrollPeriod', 'payrollLockedEntry', 'location', 'timeCard'].includes(table) || (table === 'user' && method === 'findMany')) {
        require(Array.isArray(where.id?.in), `Exact ${table} reference ids`);
        equal(args.select, { id: true, publicId: true }, 'Public reference projection');
      }
    }
    if (args.include) equal(args.include, { role: { include: { rolePermissions: { include: { permission: true } } } } }, 'Current role include');
    if (table === 'roleAssignment') {
      require(where.userId === ids.actor || JSON.stringify(where.userId) === JSON.stringify({ in: [ids.actor] }), 'Exact assigned actor');
      equal(args.orderBy, [{ userId: 'asc' }, { roleId: 'asc' }], 'Assignment order');
      if (args.select) equal(args.select, { userId: true, roleId: true }, 'Assignment fields');
    }
    if (table === 'payrollExportLine' && method === 'findMany') {
      const full = args.take === 5001;
      equal(args.orderBy, [{ lineNumber: 'asc' }, { [full || flavor === 'retained' ? 'id' : 'publicId']: 'asc' }], 'Line order');
      require(full || args.take === 2, 'Bounded line limit plus lookahead');
      require(Object.keys(where).length === (where.lineNumber ? 3 : 2), 'Closed line page selector');
      if (where.lineNumber) equal(where.lineNumber, { gt: 1 }, 'Exact continuation boundary');
    }
    if (table === 'payrollExportLine' && method === 'findFirst') {
      equal(args.select, { lineNumber: true }, 'Cursor fields');
      require(Object.keys(where).length === 3 && (flavor === 'native' ? typeof where.publicId === 'string' : typeof where.id === 'string'), 'Closed cursor target');
    }
    if (table === 'payrollReconciliationReceipt') equal(args.orderBy, [{ receivedAt: 'desc' }, { [flavor === 'native' ? 'publicId' : 'id']: 'desc' }], 'Latest receipt order');
    if (table === 'payrollReconciliationLineState' && method === 'findMany' && flavor === 'retained') {
      equal(args.orderBy, { lineId: 'asc' }, 'Read state order'); require(args.take === where.lineId.in.length, 'State page cap');
    }
    let rows = snapshot[table].filter(row => match(row, where));
    if (method === 'groupBy') {
      equal(args.by, ['status'], 'State group'); equal(args._count, { _all: true }, 'State count');
      const counts = new Map<string, number>(); for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
      return [...counts].map(([status, count]) => ({ status, _count: { _all: count } }));
    }
    if (args.orderBy) {
      const order: Row[] = Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy];
      rows.sort((a, b) => { for (const clause of order) for (const [key, direction] of Object.entries(clause)) {
        if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * (direction === 'desc' ? -1 : 1);
      } return 0; });
    }
    if (args.take !== undefined) rows = rows.slice(0, args.take);
    const result = rows.map(row => args.include ? { ...clone(row), role: clone(snapshot.role.find(r => r.id === row.roleId)) } : project(row, args.select));
    const hitsPage = table === 'payrollExportLine' && method === 'findMany' && args.take === 2;
    const hitsFinal = flavor === 'native' ? table === 'timeCard' && method === 'findMany' : table === 'payrollReconciliationReceipt';
    if (phase === 'owner' && gateHits === 0 && ((pause === 'page' && hitsPage) || (pause === 'final' && hitsFinal))) {
      gateHits++; arrived.resolve(); await release.promise;
    }
    return method === 'findMany' ? result : result[0] ?? null;
  }
  const raw = async (kind: string, sql: any, bound: unknown[], snapshot: Record<string, Row[]>) => {
    const text = (Array.isArray(sql) ? sql : sql.strings).join('').replace(/\s+/g, ' ').trim();
    const values = flatten(Array.isArray(sql) ? bound : sql.values);
    reads.push({ phase, table: '$raw', method: kind, text, values: clone(values) });
    if (kind === '$executeRaw') {
      equal(text, 'SELECT set_current_tenant()', 'Actual tenant context'); equal(values, [ids.tenant], 'Tenant binding'); return 1;
    }
    if (text === "SELECT set_config('lock_timeout', '2000ms', true), set_config('statement_timeout', '12000ms', true)") {
      equal(values, [], 'Exact transaction budget SELECT has no interpolated bindings');
      return [{ set_config: '12000ms' }];
    }
    require(text.startsWith('SELECT ') && text.endsWith('FOR UPDATE'), 'Only closed authority lock SELECT allowed');
    const table = /FROM "(Tenant|User|Session|RoleAssignment|RolePermission|Role)"/.exec(text)?.[1];
    require(Boolean(table), 'Unknown raw table');
    if (table === 'Tenant') { equal(values, [ids.tenant], 'Tenant lock'); return clone(snapshot.tenant); }
    if (table === 'User') { equal(values, [ids.tenant, ids.actor], 'Actor lock'); return clone(snapshot.user.filter(r => r.id === ids.actor && !r.deletedAt)); }
    if (table === 'Session') { equal(values, [ids.session, ids.actor], 'Exact Session lock'); return clone(snapshot.session); }
    if (table === 'RoleAssignment') { equal(values, [ids.tenant, ids.actor], 'Assignment lock'); return clone(snapshot.roleAssignment); }
    if (table === 'Role') { equal(values, [ids.tenant, ids.role], 'Role lock'); return snapshot.role.map(r => ({ id: r.id })); }
    equal(values, [ids.role], 'Grant lock'); return snapshot.role[0].rolePermissions.map(() => ({ roleId: ids.role, permissionId: 'payroll-read-permission' }));
  };
  const client: any = { $transaction: async (callback: (tx: any) => Promise<any>, options?: Row) => {
    require(active === 0, 'Nested transaction');
    if (writer) { require(phase === 'owner', 'Writer only before owner context'); const selected = writer; writer = undefined; selected(); }
    contexts.push({ phase, options: clone(options ?? {}), at: Date.now() });
    const snapshot = clone(tables); active++;
    const tx: any = { $queryRaw: (sql: any, ...values: unknown[]) => raw('$queryRaw', sql, values, snapshot),
      $executeRaw: (sql: any, ...values: unknown[]) => raw('$executeRaw', sql, values, snapshot) };
    for (const table of Object.keys(tables)) {
      tx[table] = {};
      for (const method of ['findFirst', 'findUnique', 'findMany', 'groupBy']) tx[table][method] = (args: Row) => query(table, method, args, snapshot);
      for (const method of ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']) tx[table][method] = async (args: Row) => {
        effects.push({ table, method, args: clone(args) }); require(false, 'Export GET attempted write');
      };
    }
    try { return await callback(tx); } finally { active--; }
  } };
  const nativeDb = new TenantDatabase(client), tenantDb = new TenantPrismaService(client), rbac = new RbacService(tenantDb);
  const identity: SessionIdentity = { sub: ids.actor, tenantId: ids.tenant, sessionId: ids.session, publicUserId: uuid(1),
    role: 'ADMIN', legacyRole: 'ADMIN', roles: [], permissions: ['payroll:read'], pinResetRequired: false, mfaRequired: true, mfaVerified: true };
  const actor = { userId: ids.actor, tenantId: ids.tenant, sessionId: ids.session };
  const proofLifetime = deadline.startsWith('mfa') ? 1000 : 120_000;
  const observer = { observeSessionMfa: async (selected: MfaSessionIdentity) => {
    require(active === 0, 'Trusted proof must be observed outside own DB callback');
    equal(selected, { sub: ids.actor, tenantId: ids.tenant, sessionId: ids.session }, 'Proof exact identity');
    observations.push({ phase, selected: clone(selected) });
    return { ...selected, expiresAtEpochMs: Date.now() + proofLifetime, expiresAtMonotonicMs: monotonic + proofLifetime };
  } };
  async function admit() {
    if (flavor === 'native') {
      const authority = await nativeDb.withTenant(ids.tenant, tx => authorizeCurrentMutation(tx, identity, 'payroll:read'));
      require(authority.requiresMfa, 'payroll:read requires trusted MFA');
      const proof = await observer.observeSessionMfa(authority.identity); assertCurrentMutation(authority, proof);
      await nativeDb.withTenant(ids.tenant, async tx => assertCurrentMutation(await authorizeCurrentMutation(tx, identity, 'payroll:read'), proof));
    } else {
      await rbac.runCurrentMutation({ actor, requiredPermission: 'payroll:read', mfaObserver: observer },
        (tx, frozen) => rbac.authorizeActorMutationInTransaction(tx, frozen, 'payroll:read'), async (_tx, _authority, assertCurrent) => { assertCurrent(); });
    }
    expect(errors).toEqual([]); expect(contexts.filter(r => r.phase === 'admission')).toHaveLength(2);
    expect(observations.filter(r => r.phase === 'admission')).toHaveLength(1); expect(active).toBe(0); phase = 'owner';
  }
  function advance(expired: boolean) {
    if (deadline === 'mfa-monotonic') monotonic += expired ? 1001 : 999;
    else vi.setSystemTime(NOW + (deadline === 'policy' ? (expired ? 60_001 : 59_999) : (expired ? 1001 : 999)));
  }
  function assertClosed(before: unknown) {
    expect(errors).toEqual([]); expect(effects).toEqual([]); expect(active).toBe(0); expect(financial()).toEqual(before);
  }
  return { tables, batch, identity, actor, nativeDb, tenantDb, rbac, observer, reads, effects, contexts, observations,
    admit, advance, financial, assertClosed, arrived: arrived.promise, release: release.resolve,
    pause: (which: ReadGate) => { pause = which; }, gateHits: () => gateHits,
    checkWriterDenied: async () => {
      phase = 'countercheck';
      try {
        if (flavor === 'native') await nativeDb.withTenant(ids.tenant, tx => authorizeCurrentMutation(tx, identity, 'payroll:read'));
        else await tenantDb.withTenant(ids.tenant, tx => rbac.authorizeActorMutationInTransaction(tx, actor, 'payroll:read'));
        return null;
      } catch (error) { return error; }
      finally { phase = 'owner'; }
    },
    writerFirst: (which: 'session' | 'grant') => { writer = () => {
      if (which === 'session') tables.session[0].revokedAt = new Date();
      else tables.role[0].rolePermissions = [];
    }; },
  };
}

export async function runPaused<T>(f: ReturnType<typeof payrollReadFixture>, call: () => Promise<T>, expired: boolean) {
  const result = call().then(value => ({ value, error: null }), error => ({ value: null, error }));
  try { await bounded(f.arrived); expect(f.gateHits()).toBe(1); f.advance(expired); f.release(); return await bounded(result); }
  finally { f.release(); await bounded(result); }
}
