import { performance } from 'node:perf_hooks';
import { setTimeout as realTimeout, clearTimeout as realClearTimeout } from 'node:timers';
import type { SessionIdentity } from '@lunchlineup/api-contract';
import { observeMfaVerification, MFA_MARKER_TTL_SCRIPT, type MfaSessionObserver } from '@lunchlineup/rbac';
import { expect, vi } from 'vitest';
import { buildPayrollCsv, payrollContentSha256, payrollExportLineSha256, materializeLockedSnapshots } from '../../apps/api-v2/src/payroll/domain';
import { TenantDatabase } from '../../apps/api-v2/src/platform/database';
import { TenantPrismaService } from '../../apps/api/src/database/tenant-prisma.service';
import { RbacService } from '../../apps/api/src/auth/rbac.service';
import { authorizeCurrentMutation, assertCurrentMutation } from '../../apps/api-v2/src/people/mutation-authority';

// Actual period owners and actual current-authority/MFA helpers over a closed,
// read-only committed-row model. No HTTP admission, PostgreSQL locks/MVCC/RLS,
// Redis atomicity, native execution, payroll mutations or release qualification.
export type PeriodRow = Record<string, any>;
export type PeriodDeadline = 'stored' | 'policy' | 'mfa-wall' | 'mfa-monotonic';
export type PeriodGate = 'row' | 'summary' | 'receipt' | 'credit';
export type PeriodWriter = 'session' | 'grant' | 'account' | 'pin' | 'policy' | 'tenant' | 'role';
export const periodIds = { tenant: 'period-tenant', actor: 'period-actor', session: 'period-session',
  role: 'period-reader-role', creator: 'period-historical-staff', location: 'period-historical-location', batch: 'period-batch' };
export const periodUuid = (n: number) => `63215e75-1ff1-4a6d-93ee-${String(n).padStart(12, '0')}`;
const NOW = Date.parse('2026-10-05T22:00:00Z');
const clone = <T>(v: T): T => structuredClone(v);
function deferred() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
export async function periodBounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof realTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = realTimeout(() => reject(new Error('Period fixture gate did not settle')), 2000);
  })]); } finally { if (timer) realClearTimeout(timer); }
}
const flatten = (values: unknown[]): unknown[] => values.flatMap(v => v && typeof v === 'object' && 'values' in v
  ? flatten((v as { values: unknown[] }).values) : [v]);

export function payrollPeriodReadFixture(flavor: 'native' | 'retained', deadline: PeriodDeadline = 'stored') {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  let monotonic = 100_000;
  vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
  const i = periodIds, historical = new Date('2026-01-01T00:00:00Z'), creatorRetired = new Date('2026-09-01T00:00:00Z');
  const tables: Record<string, PeriodRow[]> = {
    tenant: [{ id: i.tenant, status: 'ACTIVE', deletedAt: null }],
    user: [{ id: i.actor, tenantId: i.tenant, publicId: periodUuid(1), role: 'STAFF', name: 'Reader', email: null,
      username: 'reader', deletedAt: null, suspendedAt: null, lockedUntil: null, pinLockedUntil: null,
      pinResetRequired: false, mfaEnabled: false },
      { id: i.creator, tenantId: i.tenant, publicId: periodUuid(2), role: 'STAFF', name: 'Historical staff', username: null, deletedAt: creatorRetired, suspendedAt: creatorRetired }],
    session: [{ id: i.session, userId: i.actor, createdAt: new Date(NOW - (deadline === 'policy' ? 240_000 : 60_000)),
      expiresAt: new Date(NOW + (deadline === 'stored' ? 1000 : 3_600_000)), revokedAt: null }],
    tenantSetting: [{ tenantId: i.tenant, key: 'workspace_settings', value: { security: {
      sessionTimeoutMinutes: deadline === 'policy' ? 5 : 480, requireMfaForAll: false } } }],
    role: [{ id: i.role, tenantId: i.tenant, publicId: periodUuid(3), name: 'Policy reader', slug: 'policy-reader',
      description: null, isSystem: false, isDefault: false, legacyRole: null, deletedAt: null,
      rolePermissions: [{ roleId: i.role, permissionId: 'policy-read-permission', permission: { key: 'payroll:read' } }] }],
    roleAssignment: [{ tenantId: i.tenant, userId: i.actor, roleId: i.role }],
    payrollPolicyVersion: [1, 2, 3].map(version => ({ id: `policy-${version}`, publicId: periodUuid(10 + version),
      tenantId: i.tenant, version, timeZone: 'UTC', cadence: 'WEEKLY', anchorDate: historical,
      effectiveFrom: new Date(`${['2026-02-05', '2026-03-05', '2026-04-02'][version - 1]}T00:00:00Z`), createdByUserId: i.creator,
      createdAt: new Date(`2026-0${version}-01T12:00:00Z`) })),
  };
  const createdAt = new Date('2026-06-01T00:00:00Z');
  tables.payrollPeriod = [1, 2, 3].map(n => {
    const start = new Date(['2026-08-13', '2026-07-30', '2026-08-06'][n - 1] + 'T00:00:00Z');
    const end = new Date(start.getTime() + 7 * 86400_000);
    return { id: `period-${n}`, publicId: periodUuid(20 + n), tenantId: i.tenant, policyVersionId: 'policy-3',
      localStartDate: start, localEndDateExclusive: end, startsAt: start, endsAt: end,
      timeZone: 'UTC', cadence: 'WEEKLY', status: n === 2 ? 'LOCKED' : 'OPEN', revision: n === 2 ? 3 : 1,
      reviewStartedAt: n === 2 ? new Date('2026-08-07T00:00:00Z') : null,
      reviewStartedByUserId: n === 2 ? i.creator : null, lockedAt: n === 2 ? new Date('2026-08-07T01:00:00Z') : null,
      lockedByUserId: n === 2 ? i.creator : null, lockedEntrySha256: n === 2 ? 'a'.repeat(64) : null,
      lockedEntryCount: n === 2 ? 2 : null, totalPayableMinutes: n === 2 ? 960 : null, createdAt, updatedAt: createdAt };
  });
  tables.payrollPeriod.push({ ...clone(tables.payrollPeriod[0]), id: 'foreign-period', publicId: periodUuid(99), tenantId: 'foreign-tenant', localStartDate: new Date('2026-09-03T00:00:00Z'), startsAt: new Date('2026-09-03T00:00:00Z'), localEndDateExclusive: new Date('2026-09-10T00:00:00Z'), endsAt: new Date('2026-09-10T00:00:00Z') });
  tables.location = [{ id: i.location, publicId: periodUuid(4), tenantId: i.tenant, deletedAt: creatorRetired }];
  const card = (n: number, period: string | null, clock: string) => ({ id: `card-${n}`, publicId: periodUuid(30 + n), tenantId: i.tenant,
    userId: i.creator, locationId: i.location, payrollPeriodId: period, deletedAt: null, workTimeZone: 'UTC',
    clockInAt: new Date(clock + 'T08:00:00Z'), clockOutAt: new Date(clock + 'T16:00:00Z'), breakMinutes: 0,
    status: 'CLOSED', revision: n === 1 ? 2 : 1, updatedAt: new Date(clock + 'T16:00:00Z'),
    user: { id: i.creator, publicId: periodUuid(2), name: 'Historical staff', username: null }, location: { publicId: periodUuid(4) } });
  tables.timeCard = [card(1, 'period-1', '2026-08-14'), card(2, null, '2026-08-15'), card(3, 'period-1', '2026-08-16'),
    card(4, null, '2026-08-20'), { ...card(5, 'period-1', '2026-08-08'), deletedAt: creatorRetired },
    { ...card(6, 'period-1', '2026-08-08'), tenantId: 'foreign-tenant' }, card(7, 'period-2', '2026-07-31'), card(8, 'period-2', '2026-08-01')];
  tables.payrollTimeCardApproval = [
    { id: 'approval-current', tenantId: i.tenant, periodId: 'period-1', timeCardId: 'card-1', timeCardRevision: 2,
      decision: 'APPROVED', reason: null, decidedAt: new Date('2026-08-20T00:00:00Z'), decidedByUserId: i.creator },
    { id: 'approval-stale', tenantId: i.tenant, periodId: 'period-1', timeCardId: 'card-1', timeCardRevision: 1,
      decision: 'REJECTED', reason: 'old revision', decidedAt: new Date('2026-08-19T00:00:00Z'), decidedByUserId: i.creator },
  ];
  tables.payrollLockedEntry = [7, 8].map((n, index) => ({ id: `entry-${index + 1}`, publicId: periodUuid(40 + index + 1),
    tenantId: i.tenant, periodId: 'period-2', sequence: index, sourceType: 'TIME_CARD', sourceId: `card-${n}`, sourceRevision: 1,
    employeeId: i.creator, locationId: i.location, workTimeZone: 'UTC', clockInAt: tables.timeCard.find(c => c.id === `card-${n}`)!.clockInAt,
    clockOutAt: tables.timeCard.find(c => c.id === `card-${n}`)!.clockOutAt, breakMinutes: 0, payableMinutes: 480,
    approvedAt: new Date('2026-08-07T00:00:00Z'), approvedByUserId: i.creator, canonicalSha256: '', createdAt: new Date('2026-08-07T01:00:00Z') }));
  const locked = materializeLockedSnapshots({ tenantId: i.tenant, periodId: 'period-2',
    sources: tables.payrollLockedEntry.map((entry, index) => ({ sourceType: 'TIME_CARD' as const,
      sourceId: flavor === 'native' ? periodUuid(30 + (index === 0 ? 7 : 8)) : entry.sourceId, sourceRevision: 1,
      employeeId: flavor === 'native' ? periodUuid(2) : i.creator, locationId: flavor === 'native' ? periodUuid(4) : i.location,
      workTimeZone: 'UTC', clockInAt: entry.clockInAt, clockOutAt: entry.clockOutAt, breakMinutes: 0, payableMinutes: 480,
      approvedAt: entry.approvedAt, approvedByUserId: flavor === 'native' ? periodUuid(2) : i.creator })) });
  tables.payrollLockedEntry.forEach((entry, index) => { entry.canonicalSha256 = locked.entries[index].canonicalSha256; });
  tables.payrollPeriod[1].lockedEntrySha256 = locked.aggregateSha256;
  tables.payrollAmendment = [{ id: 'amendment-1', publicId: periodUuid(51), tenantId: i.tenant, lockedEntryId: 'entry-1',
    adjustmentPeriodId: 'period-3', requestedByUserId: i.creator, reason: 'Correct missed break',
    replacementClockInAt: tables.payrollLockedEntry[0].clockInAt, replacementClockOutAt: tables.payrollLockedEntry[0].clockOutAt,
    replacementBreakMinutes: 30, replacementPayableMinutes: 450, minuteDelta: -30, createdAt: new Date('2026-08-08T00:00:00Z') }];
  tables.payrollAmendmentDecision = [{ id: 'amendment-decision', tenantId: i.tenant, amendmentId: 'amendment-1',
    decision: 'APPROVED', reason: null, decidedByUserId: i.creator, decidedAt: new Date('2026-08-09T00:00:00Z') }];
  const publicLines = tables.payrollLockedEntry.map((entry, index) => {
    const line: PeriodRow = { id: `line-${index + 1}`, publicId: periodUuid(60 + index + 1), tenantId: i.tenant,
      batchId: i.batch, lineNumber: index + 1, lockedEntryId: entry.id, employeeId: i.creator, locationId: i.location,
      sourceType: 'TIME_CARD', sourceId: entry.sourceId, workTimeZone: 'UTC', clockInAt: entry.clockInAt,
      clockOutAt: entry.clockOutAt, breakMinutes: 0, payableMinutes: 480 };
    const publicLine = { id: line.publicId, lineNumber: line.lineNumber, sourceType: 'TIME_CARD' as const,
      sourceId: periodUuid(30 + (index === 0 ? 7 : 8)), employeeId: periodUuid(2), locationId: periodUuid(4),
      workTimeZone: 'UTC', clockInAt: line.clockInAt, clockOutAt: line.clockOutAt, breakMinutes: 0, payableMinutes: 480 };
    line.canonicalSha256 = payrollExportLineSha256({ tenantId: i.tenant, batchId: i.batch, lockedEntryId: entry.id, line: publicLine });
    (tables.payrollExportLine ??= []).push(line); return publicLine;
  });
  tables.payrollExportBatch = [{ id: i.batch, publicId: periodUuid(70), tenantId: i.tenant, periodId: 'period-2', formatVersion: 1,
    operationId: 'saved-period-export', creditTransactionId: 'feature-usage-payroll-export:saved-period-export',
    status: 'RECONCILED', rowCount: 2, totalPayableMinutes: 960, consumedCredits: 1, newBalance: 9,
    contentSha256: payrollContentSha256(buildPayrollCsv(publicLines)), createdAt: new Date('2026-08-08T00:00:00Z'), updatedAt: new Date('2026-08-10T00:00:00Z'),
    downloadedAt: new Date('2026-08-08T00:00:00Z'), reconciledAt: new Date('2026-08-10T00:00:00Z') }];
  tables.creditTransaction = [{ id: 'feature-usage-payroll-export:saved-period-export', tenantId: i.tenant,
    amount: -1, debtAmount: 0, reason: 'Payroll export (period-2)', balanceAfter: 9, debtAfter: 0 }];
  tables.payrollReconciliationLineState = [1, 2].map(n => ({ tenantId: i.tenant, batchId: i.batch, lineId: `line-${n}`,
    status: n === 1 ? 'ACCEPTED' : 'REJECTED', reason: n === 1 ? null : 'controlled rejection' }));
  tables.payrollReconciliationReceipt = [{ id: 'receipt-1', publicId: periodUuid(71), tenantId: i.tenant, batchId: i.batch,
    provider: 'controlled-provider', providerEventId: 'event-1', payloadSha256: 'c'.repeat(64), providerTotalMinutes: 960,
    receivedAt: new Date('2026-08-10T00:00:00Z') }];
  const rowsBefore = () => clone(Object.fromEntries(Object.entries(tables).filter(([name]) =>
    !['tenant', 'user', 'session', 'tenantSetting', 'role', 'roleAssignment'].includes(name))));
  const errors: string[] = [], reads: PeriodRow[] = [], effects: PeriodRow[] = [], contexts: PeriodRow[] = [], observations: PeriodRow[] = [];
  let active = 0, phase = 'admission', ordinal = 0, writer: (() => void) | undefined;
  let pause: PeriodGate | undefined, gateHits = 0, pauseEntry = false, entryUsed = false;
  const arrived = deferred(), release = deferred();
  function require(ok: boolean, message: string) { if (!ok) { errors.push(message); throw new Error(message); } }
  function equal(actual: unknown, expected: unknown, label: string) {
    require(JSON.stringify(actual) === JSON.stringify(expected), `${label}: ${JSON.stringify(actual)}`);
  }
  function match(row: PeriodRow, where: PeriodRow, snapshot: Record<string, PeriodRow[]>): boolean {
    return Object.entries(where).every(([key, wanted]) => {
      if (key === 'tenantId_key') return match(row, wanted, snapshot);
      if (key === 'role') return match(snapshot.role.find(r => r.id === row.roleId) ?? {}, wanted, snapshot);
      if (key === 'OR') return (wanted as PeriodRow[]).some(term => match(row, term, snapshot));
      if (wanted && typeof wanted === 'object' && !(wanted instanceof Date)) {
        return Object.entries(wanted).every(([op, value]) => {
          require(['in', 'lt', 'gt', 'gte', 'lte', 'not'].includes(op), `Unknown selector ${key}.${op}`);
          if (op === 'in') return (value as unknown[]).includes(row[key]);
          if (op === 'not') return row[key] !== value;
          if (row[key] === null) return false;
          return op === 'lt' ? row[key] < (value as number) : op === 'gt' ? row[key] > (value as number) : op === 'gte' ? row[key] >= (value as number) : row[key] <= (value as number);
        });
      }
      return wanted instanceof Date ? row[key] instanceof Date && row[key].getTime() === wanted.getTime() : row[key] === wanted;
    });
  }
  function project(row: PeriodRow, select?: PeriodRow): PeriodRow {
    if (!select) return clone(row);
    const out: PeriodRow = {};
    for (const [key, value] of Object.entries(select)) {
      require(value === true || (value && typeof value === 'object' && Object.keys(value).length === 1 && value.select), `Unknown projection ${key}`);
      if (key === 'rolePermissions') { equal(value, { select: { permission: { select: { key: true } } } }, 'Grant projection'); out[key] = clone(row[key]); }
      else out[key] = value === true ? clone(row[key]) : row[key] == null ? null : project(row[key], value.select);
    }
    return out;
  }
  function validateDomain(table: string, method: string, args: PeriodRow, snapshot: Record<string, PeriodRow[]>) {
    const where = args.where, k = (v: object) => Object.keys(v).sort();
    const references = (fields: string[]) => {
      require(method === 'findMany' && Array.isArray(where.id?.in) && where.id.in.length > 0, `Closed ${table} reference ids`);
      equal(where, { tenantId: i.tenant, id: { in: where.id.in } }, `${table} reference scope`);
      require(where.id.in.every((id: string) => snapshot[table].some(row => row.id === id && row.tenantId === i.tenant)), 'Only known own reference ids');
      equal(k(args.select ?? {}), fields.sort(), `${table} exact reference fields`);
      require(Object.values(args.select).every(v => v === true), 'Scalar reference fields');
    };
    // Ledger lookup uses the batch's exact primary key; the owner verifies its tenant.
    require(table === 'creditTransaction' || where.tenantId === i.tenant, `Every domain ${table} query tenant-scoped`);
    if (table === 'payrollPeriod') {
      if (args.select) references(['id', 'publicId']);
      else if (method === 'findFirst') {
        equal(k(where), ['tenantId', flavor === 'native' && where.publicId ? 'publicId' : 'id'].sort(), 'Exact requested period');
        equal(k(args), ['where'], 'Period detail options');
      } else {
        require(method === 'findMany', 'Period list read');
        equal(args.orderBy, [{ localStartDate: 'desc' }, { [flavor === 'native' ? 'publicId' : 'id']: 'desc' }], 'Period list order');
        require(Number.isInteger(args.take) && args.take >= 2 && args.take <= 51, 'Bounded period lookahead');
        if (flavor === 'native') {
          require(!args.cursor && args.skip === undefined, 'Native keyset cursor only');
          if (where.OR) {
            equal(k(where), ['OR', 'tenantId'], 'Native cursor keys');
            const start = where.OR[0]?.localStartDate?.lt, publicId = where.OR[1]?.publicId?.lt;
            require(start instanceof Date && typeof publicId === 'string', 'Native decoded period boundary');
            equal(where.OR, [{ localStartDate: { lt: start } }, { localStartDate: start, publicId: { lt: publicId } }], 'Period keyset');
          } else equal(where, { tenantId: i.tenant }, 'Initial list scope');
        } else { equal(where, { tenantId: i.tenant }, 'Retained list scope');
          if (args.cursor) { equal(k(args.cursor), ['id'], 'Exact private period cursor'); equal(args.skip, 1, 'Private cursor skip'); }
          else require(args.skip === undefined, 'No skip without cursor'); }
      }
    } else if (table === 'payrollPolicyVersion' || table === 'location') references(['id', 'publicId']);
    else if (table === 'timeCard') {
      if (args.select?.publicId && k(args.select).length === 2) references(['id', 'publicId']);
      else {
        require(method === 'findMany' && Number.isInteger(args.take) && args.take >= 2 && args.take <= 251, 'Bounded card lookahead');
        equal(args.orderBy, [{ [flavor === 'native' ? 'publicId' : 'id']: 'asc' }], 'Card order');
        const period = snapshot.payrollPeriod.find(row => row.id === (where.payrollPeriodId ?? where.OR?.[0]?.payrollPeriodId));
        require(Boolean(period) && period!.tenantId === i.tenant, 'Known card period');
        const base = period!.status === 'OPEN' ? { tenantId: i.tenant, deletedAt: null, OR: [
          { payrollPeriodId: period!.id }, { payrollPeriodId: null, status: 'CLOSED',
            clockInAt: { gte: period!.startsAt, lt: period!.endsAt }, clockOutAt: { not: null, lte: period!.endsAt } } ] }
          : { tenantId: i.tenant, payrollPeriodId: period!.id, deletedAt: null };
        const expectedWhere = { ...base, ...(flavor === 'native' && where.publicId ? { publicId: where.publicId } : {}) };
        equal(Object.keys(where).sort().map(key => [key, where[key]]), Object.keys(expectedWhere).sort().map(key => [key, (expectedWhere as PeriodRow)[key]]), 'Complete card-window selector');
        if (where.publicId) { require(flavor === 'native' && typeof where.publicId.gt === 'string', 'Public card boundary'); equal(k(where.publicId), ['gt'], 'Card keyset operator'); }
        if (args.cursor) { require(flavor === 'retained', 'Private card cursor only'); equal(k(args.cursor), ['id'], 'Private card cursor'); equal(args.skip, 1, 'Card skip'); }
        const projection = { id: true, ...(flavor === 'native' ? { publicId: true } : {}), userId: true, locationId: true,
          payrollPeriodId: true, workTimeZone: true, clockInAt: true, clockOutAt: true, breakMinutes: true, status: true,
          revision: true, updatedAt: true, user: { select: { [flavor === 'native' ? 'publicId' : 'id']: true, name: true, username: true } },
          ...(flavor === 'native' ? { location: { select: { publicId: true } } } : {}) };
        equal(args.select, projection, 'Exact card response projection');
      }
    } else if (table === 'payrollTimeCardApproval') {
      require(method === 'findMany' && Array.isArray(where.OR) && where.OR.length > 0, 'Only exact page revision approvals');
      equal(k(where), ['OR', 'periodId', 'tenantId'], 'Approval scope');
      require(snapshot.payrollPeriod.some(row => row.id === where.periodId && row.tenantId === i.tenant), 'Approval own period');
      for (const term of where.OR) {
        equal(k(term), ['timeCardId', 'timeCardRevision'], 'Approval term');
        require(snapshot.timeCard.some(c => c.id === term.timeCardId && c.tenantId === i.tenant && c.revision === term.timeCardRevision), 'Approval current card revision');
      }
      if (flavor === 'retained') { equal(args.orderBy, [{ timeCardId: 'asc' }], 'Approval order'); equal(args.take, where.OR.length, 'Approval cap'); }
      else equal(k(args), ['where'], 'Native approval options');
    } else if (table === 'payrollLockedEntry') {
      if (where.periodId) {
        equal(where, { tenantId: i.tenant, periodId: where.periodId }, 'Locked period scope');
        require(snapshot.payrollPeriod.some(row => row.id === where.periodId && row.tenantId === i.tenant), 'Known locked period');
        equal(args.take, 5001, 'Locked entry hard bound');
        if (args.select) { require(flavor === 'native', 'Only native source set projection'); equal(args.select, { id: true }, 'Locked source set'); equal(k(args), ['select', 'take', 'where'], 'Locked set options'); }
        else equal(args.orderBy, [{ sequence: 'asc' }, { [flavor === 'native' ? 'publicId' : 'id']: 'asc' }], 'Locked entries order');
      } else {
        const fields = args.select?.publicId ? (args.select.employeeId ? ['id', 'publicId', 'employeeId'] : ['id', 'publicId']) : ['id', 'employeeId'];
        references(fields);
        if (flavor === 'retained') { equal(args.orderBy, { id: 'asc' }, 'Amendment sources order'); equal(args.take, where.id.in.length, 'Source cap'); }
      }
    } else if (table === 'payrollAmendment') {
      if (args.select) references(['id', 'publicId']);
      else {
        require(method === 'findMany', 'Amendment history');
        if (where.OR) {
          equal(k(where), ['OR', 'tenantId'], 'Locked amendment scope');
          require(where.OR.length >= 1 && where.OR.length <= 2, 'Closed amendment alternatives');
          equal(k(where.OR[0]), ['adjustmentPeriodId'], 'Adjustment alternative');
          if (where.OR.length === 2) { equal(k(where.OR[1]), ['lockedEntryId'], 'Source alternative'); require(Array.isArray(where.OR[1].lockedEntryId.in), 'Locked source set'); }
        } else equal(k(where), ['adjustmentPeriodId', 'tenantId'], 'Adjustment scope');
        equal(args.orderBy, [{ createdAt: 'asc' }, { [flavor === 'native' ? 'publicId' : 'id']: 'asc' }], 'Amendment history order'); equal(args.take, 5001, 'Amendment cap');
      }
    } else if (table === 'payrollAmendmentDecision') {
      require(method === 'findMany', 'Amendment decision read'); equal(k(where), ['amendmentId', 'tenantId'], 'Decision scope');
      require(Array.isArray(where.amendmentId.in) && where.amendmentId.in.every((id: string) => snapshot.payrollAmendment.some(row => row.id === id && row.tenantId === i.tenant)), 'Own amendment ids');
      if (flavor === 'retained') { equal(args.orderBy, { amendmentId: 'asc' }, 'Decision order'); equal(args.take, where.amendmentId.in.length, 'Decision cap'); }
    } else if (table === 'payrollExportBatch') {
      require(method === 'findFirst', 'Saved period batch lookup'); equal(k(args), ['where'], 'Batch options');
      if (flavor === 'native' && Object.hasOwn(where, 'publicId')) equal(where, { tenantId: i.tenant, publicId: periodUuid(70) }, 'Exact export read scope');
      else {
        equal(where, { tenantId: i.tenant, periodId: where.periodId }, 'Period batch scope');
        require(snapshot.payrollPeriod.some(row => row.id === where.periodId && row.tenantId === i.tenant), 'Own batch period');
      }
    } else if (table === 'creditTransaction') {
      require(flavor === 'native' && method === 'findUnique', 'Native saved export provenance read');
      equal(k(args), ['select', 'where'], 'Ledger options');
      equal(where, { id: snapshot.payrollExportBatch[0].creditTransactionId }, 'Exact saved ledger identity');
      equal(args.select, { id: true, tenantId: true, amount: true, debtAmount: true, reason: true, balanceAfter: true, debtAfter: true }, 'Ledger provenance projection');
    } else if (table === 'payrollExportLine') {
      require(where.batchId === i.batch, 'Exact saved batch');
      if (method === 'findFirst') {
        equal(k(where), ['batchId', flavor === 'native' ? 'publicId' : 'id', 'tenantId'].sort(), 'Exact line cursor scope'); equal(args.select, { lineNumber: true }, 'Line cursor projection');
      } else {
        require(method === 'findMany', 'Saved lines page'); equal(k(where), where.lineNumber ? ['batchId', 'lineNumber', 'tenantId'] : ['batchId', 'tenantId'], 'Line page keys');
        if (where.lineNumber) { equal(k(where.lineNumber), ['gt'], 'Line continuation'); require(Number.isInteger(where.lineNumber.gt), 'Line boundary'); }
        require(args.take === 5001 || (Number.isInteger(args.take) && args.take >= 2 && args.take <= 501), 'Line lookahead or integrity bound');
        equal(args.orderBy, [{ lineNumber: 'asc' }, { [args.take === 5001 || flavor === 'retained' ? 'id' : 'publicId']: 'asc' }], 'Line order');
      }
    } else if (table === 'payrollReconciliationLineState') {
      require(where.batchId === i.batch, 'State batch');
      if (method === 'groupBy') { equal(where, { tenantId: i.tenant, batchId: i.batch }, 'State count scope'); equal(args.by, ['status'], 'Group status'); equal(args._count, { _all: true }, 'State count projection'); }
      else { require(method === 'findMany', 'Line state page'); equal(k(where), ['batchId', 'lineId', 'tenantId'], 'State page scope'); require(Array.isArray(where.lineId.in), 'Line ids');
        if (flavor === 'retained') { equal(args.orderBy, { lineId: 'asc' }, 'State order'); equal(args.take, where.lineId.in.length, 'State cap'); } }
    } else if (table === 'payrollReconciliationReceipt') {
      require(method === 'findFirst', 'Latest saved receipt'); equal(where, { tenantId: i.tenant, batchId: i.batch }, 'Receipt scope');
      equal(args.orderBy, [{ receivedAt: 'desc' }, { [flavor === 'native' ? 'publicId' : 'id']: 'desc' }], 'Receipt order');
    } else require(false, `Unknown domain table ${table}`);
  }
  const permittedFields: Record<string, string[]> = {
    tenant: ['id', 'status', 'deletedAt'], user: ['id', 'publicId', 'name', 'tenantId', 'pinResetRequired', 'mfaEnabled', 'lockedUntil', 'pinLockedUntil'],
    session: ['id', 'userId', 'createdAt', 'expiresAt', 'revokedAt'], tenantSetting: ['value'],
    roleAssignment: ['userId', 'roleId'], role: ['id', 'publicId', 'name', 'slug', 'description', 'isSystem', 'isDefault', 'legacyRole', 'rolePermissions'],
  };
  async function query(table: string, method: string, args: PeriodRow, snapshot: Record<string, PeriodRow[]>) {
    reads.push({ phase, ordinal, table, method, args: clone(args) });
    require(Object.keys(args).every(k => ['where', 'select', 'include', 'orderBy', 'take', 'cursor', 'skip', 'by', '_count'].includes(k)), `Unknown query option ${table}`);
    const where = args.where;
    require(Boolean(where), 'Every query has an explicit selector');
    if (table === 'tenant') { equal(where, { id: i.tenant }, 'Tenant selector'); require(method === 'findUnique', 'Tenant lookup'); }
    else if (table === 'session') { equal(where, { id: i.session, userId: i.actor }, 'Exact Session selector'); require(method === 'findFirst', 'Session lookup'); }
    else if (table === 'tenantSetting') { equal(where, { tenantId_key: { tenantId: i.tenant, key: 'workspace_settings' } }, 'Settings selector'); require(method === 'findUnique', 'Settings lookup'); }
    else if (table === 'user') {
      if (method === 'findMany') {
        require(Array.isArray(where.id?.in) && where.id.in.length > 0 && where.id.in.every((id: string) => id === i.creator), 'Exact historical staff reference ids');
        equal(where, { tenantId: i.tenant, id: { in: where.id.in } }, 'Historical reference selector without activity filter');
        if (flavor === 'native' && args.select?.publicId) equal(args.select, { id: true, publicId: true }, 'Staff public mapping');
        else { equal(args.select, { id: true, name: true }, 'Historical employee name projection');
          if (flavor === 'retained') { equal(args.orderBy, { id: 'asc' }, 'Employee order'); equal(args.take, where.id.in.length, 'Employee cap'); } }
      } else {
        require(method === 'findFirst', 'Actor lookup');
        equal(where, { id: i.actor, tenantId: i.tenant, deletedAt: null, suspendedAt: null }, 'Exact live actor selector');
      }
    } else if (table === 'roleAssignment') {
      require(method === 'findMany', 'Assignments lookup');
      require(where.tenantId === i.tenant && Object.keys(where).every(k => ['tenantId', 'userId', 'role'].includes(k)), 'Closed assignment selector');
      require(where.userId === i.actor || JSON.stringify(where.userId) === JSON.stringify({ in: [i.actor] }), 'Exact assigned actor');
      if (where.role) equal(where.role, { tenantId: i.tenant, deletedAt: null }, 'Active assigned role selector');
      equal(args.orderBy, [{ userId: 'asc' }, { roleId: 'asc' }], 'Assignment order');
      if (args.select) equal(args.select, { userId: true, roleId: true }, 'Assignment projection');
      if (args.include) equal(args.include, { role: { include: { rolePermissions: { include: { permission: true } } } } }, 'Retained role include');
    } else if (table === 'role') {
      require(flavor === 'native' && method === 'findMany', 'Only native current role query');
      equal(where, { tenantId: i.tenant, id: { in: [i.role] }, deletedAt: null }, 'Current roles selector');
      equal(args.orderBy, { id: 'asc' }, 'Role order');
    } else validateDomain(table, method, args, snapshot);
    if (args.select && permittedFields[table]) require(Object.keys(args.select).every(k => permittedFields[table].includes(k)), 'Closed authority select fields');
    if (args.include) require(table === 'roleAssignment', 'Only authority role include');
    let rows = snapshot[table].filter(row => match(row, where, snapshot));
    if (args.orderBy) {
      const order: PeriodRow[] = Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy];
      rows.sort((a, b) => { for (const clause of order) for (const [key, direction] of Object.entries(clause)) {
        if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * (direction === 'desc' ? -1 : 1);
      } return 0; });
    }
    if (args.cursor) {
      const index = rows.findIndex(row => row.id === args.cursor.id); require(index >= 0, 'Controlled retained cursor exists in tenant page'); rows = rows.slice(index + args.skip);
    }
    if (args.take !== undefined) rows = rows.slice(0, args.take);
    const result = rows.map(row => args.include ? { ...clone(row), role: clone(snapshot.role.find(r => r.id === row.roleId)) } : project(row, args.select));
    const isRow = table === 'payrollPeriod' && !args.select, isReceipt = table === 'payrollReconciliationReceipt';
    if (phase === 'owner' && gateHits === 0 && ((pause === 'row' && isRow) || (pause === 'receipt' && isReceipt) || (pause === 'credit' && table === 'creditTransaction'))) {
      gateHits++; arrived.release(); await release.promise;
    }
    if (method === 'groupBy') { const counts = new Map<string, number>(); for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1); return [...counts].map(([status, count]) => ({ status, _count: { _all: count } })); }
    return method === 'findMany' ? result : result[0] ?? null;
  }
  const raw = async (kind: string, sql: any, bound: unknown[], snapshot: Record<string, PeriodRow[]>) => {
    const text = (Array.isArray(sql) ? sql : sql.strings).join('').replace(/\s+/g, ' ').trim();
    const values = flatten(Array.isArray(sql) ? bound : sql.values);
    reads.push({ phase, ordinal, table: '$raw', method: kind, text, values: clone(values) });
    if (kind === '$executeRaw') {
      equal(text, 'SELECT set_current_tenant()', 'Tenant context'); equal(values, [i.tenant], 'Exact context tenant');
      if (phase === 'owner' && pauseEntry && !entryUsed) { entryUsed = true; arrived.release(); await release.promise; }
      return 1;
    }
    if (text === "SELECT set_config('lock_timeout', '2000ms', true), set_config('statement_timeout', '12000ms', true)") { equal(values, [], 'Timeout bindings'); return [{ set_config: '12000ms' }]; }
    if (text === "SELECT period.\"id\" AS \"periodId\", count(card.*)::integer AS \"cardCount\", count(card.*) FILTER (WHERE card.\"status\" = 'CLOSED')::integer AS \"closedCardCount\", count(approval.*) FILTER (WHERE approval.\"decision\" = 'APPROVED')::integer AS \"approvedCardCount\", count(approval.*) FILTER (WHERE approval.\"decision\" = 'REJECTED')::integer AS \"rejectedCardCount\", (SELECT count(*)::integer FROM \"PayrollAmendment\" amendment WHERE amendment.\"tenantId\" = AND amendment.\"adjustmentPeriodId\" = period.\"id\") AS \"amendmentCount\", (SELECT count(*)::integer FROM \"PayrollAmendment\" amendment LEFT JOIN \"PayrollAmendmentDecision\" decision ON decision.\"tenantId\" = amendment.\"tenantId\" AND decision.\"amendmentId\" = amendment.\"id\" WHERE amendment.\"tenantId\" = AND amendment.\"adjustmentPeriodId\" = period.\"id\" AND decision.\"id\" IS NULL) AS \"pendingAmendmentCount\", (SELECT count(*)::integer FROM \"PayrollAmendment\" amendment JOIN \"PayrollAmendmentDecision\" decision ON decision.\"tenantId\" = amendment.\"tenantId\" AND decision.\"amendmentId\" = amendment.\"id\" WHERE amendment.\"tenantId\" = AND amendment.\"adjustmentPeriodId\" = period.\"id\" AND decision.\"decision\" = 'APPROVED') AS \"approvedAmendmentCount\", (SELECT count(*)::integer FROM \"PayrollLockedEntry\" entry WHERE entry.\"tenantId\" = AND entry.\"periodId\" = period.\"id\") AS \"lockedEntryCount\" FROM \"PayrollPeriod\" period LEFT JOIN \"TimeCard\" card ON card.\"tenantId\" = period.\"tenantId\" AND card.\"payrollPeriodId\" = period.\"id\" AND card.\"deletedAt\" IS NULL LEFT JOIN \"PayrollTimeCardApproval\" approval ON approval.\"tenantId\" = card.\"tenantId\" AND approval.\"periodId\" = period.\"id\" AND approval.\"timeCardId\" = card.\"id\" AND approval.\"timeCardRevision\" = card.\"revision\" WHERE period.\"tenantId\" = AND period.\"id\" IN () GROUP BY period.\"id\"".replace('IN ()', 'IN (' + ','.repeat(Array.isArray(sql) ? 0 : Math.max(0, values.length - 6)) + ')')) {
      require(values.length > 5 && values.length <= 55 && values.slice(0, 5).every(v => v === i.tenant), 'Five exact summary tenant bindings');
      const ids = values.slice(5);
      require(ids.every(id => typeof id === 'string' && snapshot.payrollPeriod.some(p => p.id === id && p.tenantId === i.tenant)), 'Exact own summary period ids');
      const result = ids.map(id => {
        const cards = snapshot.timeCard.filter(c => c.tenantId === i.tenant && c.payrollPeriodId === id && c.deletedAt === null);
        const decisions = cards.flatMap(c => snapshot.payrollTimeCardApproval.filter(a => a.tenantId === i.tenant && a.periodId === id && a.timeCardId === c.id && a.timeCardRevision === c.revision));
        const amendments = snapshot.payrollAmendment.filter(a => a.tenantId === i.tenant && a.adjustmentPeriodId === id);
        const decisionOf = (a: PeriodRow) => snapshot.payrollAmendmentDecision.find(d => d.tenantId === i.tenant && d.amendmentId === a.id);
        return { periodId: id, cardCount: cards.length, closedCardCount: cards.filter(c => c.status === 'CLOSED').length,
          approvedCardCount: decisions.filter(d => d.decision === 'APPROVED').length, rejectedCardCount: decisions.filter(d => d.decision === 'REJECTED').length,
          amendmentCount: amendments.length, pendingAmendmentCount: amendments.filter(a => !decisionOf(a)).length,
          approvedAmendmentCount: amendments.filter(a => decisionOf(a)?.decision === 'APPROVED').length,
          lockedEntryCount: snapshot.payrollLockedEntry.filter(e => e.tenantId === i.tenant && e.periodId === id).length };
      });
      if (phase === 'owner' && pause === 'summary' && gateHits === 0) { gateHits++; arrived.release(); await release.promise; }
      return result;
    }
    const nativeLocks = {
      Tenant: 'SELECT "id" FROM "Tenant" WHERE "id" = FOR UPDATE',
      User: 'SELECT "id", "publicId"::text AS "publicId", "role", "name", "email", "username", "suspendedAt", "deletedAt", "lockedUntil", "pinLockedUntil" FROM "User" WHERE "tenantId" = AND "id" IN () ORDER BY "id" FOR UPDATE',
      Session: 'SELECT "id", "userId", "expiresAt", "revokedAt" FROM "Session" WHERE "id" = AND "userId" = FOR UPDATE',
      Role: 'SELECT "id" FROM "Role" WHERE "tenantId" = AND "id" = FOR UPDATE',
      RolePermission: 'SELECT "roleId", "permissionId" FROM "RolePermission" WHERE "roleId" IN () ORDER BY "roleId", "permissionId" FOR UPDATE',
    };
    const retainedLocks = {
      Tenant: 'SELECT "id" FROM "Tenant" WHERE "id" IN () ORDER BY "id" FOR UPDATE',
      User: 'SELECT "id" FROM "User" WHERE "tenantId" = AND "id" IN () AND "deletedAt" IS NULL ORDER BY "id" FOR UPDATE',
      Session: nativeLocks.Session, Role: nativeLocks.Role, RolePermission: nativeLocks.RolePermission,
      RoleAssignment: 'SELECT "userId", "roleId" FROM "RoleAssignment" WHERE "tenantId" = AND "userId" IN () ORDER BY "userId", "roleId" FOR UPDATE',
    };
    const selected = flavor === 'native' ? nativeLocks : retainedLocks;
    const table = Object.entries(selected).find(([, statement]) => statement === text)?.[0];
    require(Boolean(table), `Unrecognized complete lock SQL ${text}`);
    if (table === 'Tenant') { equal(values, [i.tenant], 'Tenant lock'); return clone(snapshot.tenant); }
    if (table === 'User') { equal(values, [i.tenant, i.actor], 'Actor lock'); return clone(snapshot.user.filter(r => r.id === i.actor && !r.deletedAt)); }
    if (table === 'Session') { equal(values, [i.session, i.actor], 'Session lock'); return clone(snapshot.session.filter(r => r.id === i.session && r.userId === i.actor)); }
    if (table === 'RoleAssignment') { equal(values, [i.tenant, i.actor], 'Assignment lock'); return clone(snapshot.roleAssignment); }
    if (table === 'Role') { equal(values, [i.tenant, i.role], 'Role lock'); return snapshot.role.map(r => ({ id: r.id })); }
    equal(values, [i.role], 'Grant lock'); return snapshot.role.flatMap(r => r.rolePermissions.map(() => ({ roleId: r.id, permissionId: 'policy-read-permission' })));
  };
  const client: any = { $transaction: async (callback: (tx: any) => Promise<any>, options?: PeriodRow) => {
    require(active === 0, 'No nested transaction');
    if (writer) { require(phase === 'owner', 'Writer precedes owner context only'); const selected = writer; writer = undefined; selected(); }
    contexts.push({ phase, ordinal: ++ordinal, options: clone(options ?? {}), at: Date.now() });
    const snapshot = clone(tables); active++;
    const tx: any = { $queryRaw: (sql: any, ...values: unknown[]) => raw('$queryRaw', sql, values, snapshot),
      $executeRaw: (sql: any, ...values: unknown[]) => raw('$executeRaw', sql, values, snapshot) };
    for (const table of Object.keys(tables)) {
      tx[table] = {};
      for (const method of ['findFirst', 'findUnique', 'findMany', 'groupBy']) tx[table][method] = (args: PeriodRow) => query(table, method, args, snapshot);
      for (const method of ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']) tx[table][method] = async (args: PeriodRow) => {
        effects.push({ table, method, args: clone(args) }); require(false, 'Period GET attempted domain write');
      };
    }
    try { return await callback(tx); } finally { active--; }
  } };
  const nativeDb = new TenantDatabase(client), tenantDb = new TenantPrismaService(client), rbac = new RbacService(tenantDb);
  const identity: SessionIdentity = { sub: i.actor, tenantId: i.tenant, sessionId: i.session, publicUserId: periodUuid(1),
    role: 'Policy reader', legacyRole: 'STAFF', roles: [], permissions: ['payroll:read'], pinResetRequired: false, mfaRequired: true, mfaVerified: true };
  const actor = { userId: i.actor, tenantId: i.tenant, sessionId: i.session };
  const observer: MfaSessionObserver = { observeSessionMfa: async selected => {
    require(active === 0, 'Proof observed outside own DB callback'); equal(selected, { sub: i.actor, tenantId: i.tenant, sessionId: i.session }, 'Canonical proof identity');
    observations.push({ phase, selected: clone(selected) });
    return observeMfaVerification(selected, async (script, redisKey) => {
      equal(script, MFA_MARKER_TTL_SCRIPT, 'Actual atomic marker script'); equal(redisKey, `session_mfa:${i.session}`, 'Bound marker key');
      return deadline.startsWith('mfa') ? 1000 : 120_000;
    });
  } };
  async function admit() {
    if (flavor === 'native') {
      const authority = await nativeDb.withTenant(i.tenant, tx => authorizeCurrentMutation(tx, identity, 'payroll:read'));
      require(authority.requiresMfa, 'Actual privileged payroll:read requires MFA even when unenrolled');
      const proof = await observer.observeSessionMfa(authority.identity); assertCurrentMutation(authority, proof);
      await nativeDb.withTenant(i.tenant, async tx => assertCurrentMutation(await authorizeCurrentMutation(tx, identity, 'payroll:read'), proof));
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
    expect(errors).toEqual([]); expect(effects).toEqual([]); expect(active).toBe(0); expect(rowsBefore()).toEqual(before);
  }
  function change(which: PeriodWriter) {
    if (which === 'session') tables.session[0].revokedAt = new Date();
    if (which === 'grant') tables.role[0].rolePermissions = [];
    if (which === 'account') tables.user[0].suspendedAt = new Date();
    if (which === 'pin') tables.user[0].pinResetRequired = true;
    if (which === 'policy') tables.tenantSetting[0].value.security.sessionTimeoutMinutes = 5;
    if (which === 'tenant') tables.tenant[0].status = 'SUSPENDED';
    if (which === 'role') tables.role[0].deletedAt = new Date();
  }
  return { tables, identity, actor, nativeDb, tenantDb, rbac, observer, reads, effects, contexts, observations, admit, advance,
    rowsBefore, assertClosed, arrived: arrived.promise, release: release.release, pause(which: PeriodGate) { pause = which; }, gateHits: () => gateHits,
    pauseEntry() { pauseEntry = true; },
    writerFirst(which: PeriodWriter) { writer = () => change(which); },
    async checkWriterDenied() {
      phase = 'countercheck';
      try {
        if (flavor === 'native') await nativeDb.withTenant(i.tenant, tx => authorizeCurrentMutation(tx, identity, 'payroll:read'));
        else await rbac.runCurrentMutation({ actor, requiredPermission: 'payroll:read', mfaObserver: observer },
          (tx, frozen) => rbac.authorizeActorMutationInTransaction(tx, frozen, 'payroll:read'), async (_tx, _authority, assertCurrent) => { assertCurrent(); });
        return null;
      } catch (error) { return error; }
      finally { phase = 'owner'; }
    },
  };
}
export async function runPeriodPaused<T>(f: ReturnType<typeof payrollPeriodReadFixture>, call: () => Promise<T>, expired: boolean) {
  const result = call().then(value => ({ value, error: null }), error => ({ value: null, error }));
  try {
    expect(await periodBounded(Promise.race([f.arrived.then(() => 'entered'), result.then(() => 'settled')]))).toBe('entered');
    expect(f.gateHits()).toBe(1); f.advance(expired); f.release(); return await periodBounded(result);
  } finally { f.release(); await periodBounded(result); }
}
