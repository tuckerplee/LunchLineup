import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { SessionIdentity } from '@lunchlineup/api-contract';
import type { TenantTransaction } from '../platform/database';
import { ProblemError } from '../platform/problem';

export const MAX_PAYROLL_HISTORY_PAGE_SIZE = 50;
export const MAX_PAYROLL_CARD_PAGE_SIZE = 250;
export const MAX_PAYROLL_REQUEST_ITEMS = 100;
export const MAX_PAYROLL_LOCK_ENTRIES = 5_000;
export const MAX_PAYROLL_EXPORT_LINE_PAGE_SIZE = 500;
export const MAX_RECONCILIATION_OUTCOMES = 500;

export const PAYROLL_CONCURRENT_CHANGE = 'Payroll records changed before the request could be committed. Retry safely.';
export const PAYROLL_REPLAY_CONFLICT = 'Idempotency-Key was already used for a different payroll request.';
export const PAYROLL_INTEGRITY_FAILURE = 'Payroll evidence failed integrity verification.';

export type PayrollOperationName =
  | 'POLICY_CREATE'
  | 'PERIOD_CREATE'
  | 'ADOPT'
  | 'REVIEW'
  | 'APPROVAL'
  | 'LOCK'
  | 'AMENDMENT_CREATE'
  | 'AMENDMENT_DECISION'
  | 'EXPORT'
  | 'RECONCILE';

export type PayrollActor = Pick<SessionIdentity, 'tenantId' | 'sub'>;

export type PayrollCandidateCard = {
  id: string;
  tenantId: string;
  userId: string;
  locationId: string | null;
  payrollPeriodId: string | null;
  workTimeZone: string;
  revision: number;
  clockInAt: Date;
  clockOutAt: Date | null;
  breakMinutes: number;
  status: 'OPEN' | 'CLOSED' | 'VOID';
  deletedAt: Date | null;
};

export type LockedEntrySource = {
  sourceType: 'TIME_CARD' | 'AMENDMENT';
  sourceId: string;
  sourceRevision: number;
  employeeId: string;
  locationId: string | null;
  workTimeZone: string;
  clockInAt: Date | string;
  clockOutAt: Date | string;
  breakMinutes: number;
  payableMinutes: number;
  approvedAt: Date | string;
  approvedByUserId: string;
  breakIntervals?: Array<{ startAt: Date | string; endAt: Date | string }>;
};

export type PayrollCsvLine = {
  id: string;
  lineNumber: number;
  sourceType: 'TIME_CARD' | 'AMENDMENT';
  sourceId: string;
  employeeId: string;
  locationId: string | null;
  workTimeZone: string;
  clockInAt: Date | string;
  clockOutAt: Date | string;
  breakMinutes: number;
  payableMinutes: number;
};

export type ReconciliationPayload = {
  provider: string;
  providerEventId: string;
  providerTotalMinutes: number;
  outcomes: Array<{
    lineId: string;
    status: 'PENDING' | 'ACCEPTED' | 'REJECTED';
    reason: string | null;
  }>;
};

function problem(status: number, code: string, detail: string, title = 'Payroll request failed'): ProblemError {
  return new ProblemError(status, code, detail, title);
}

export function requireId(value: string | undefined, field: string): string {
  const normalized = value?.trim() ?? '';
  if (!normalized || normalized.length > 512 || /[^\x20-\x7e]/.test(normalized)) {
    throw problem(422, `invalid_payroll_${field}`, `${field} is invalid.`, 'Payroll validation failed');
  }
  return normalized;
}

export function parseBoundedLimit(
  value: string | undefined,
  field: string,
  defaultValue: number,
  maximum: number,
): number {
  if (value === undefined || value === '') return defaultValue;
  if (!/^[0-9]+$/.test(value)) {
    throw problem(422, `invalid_payroll_${field}`, `${field} must be a whole number.`, 'Payroll validation failed');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw problem(422, `invalid_payroll_${field}`, `${field} must be between 1 and ${maximum}.`, 'Payroll validation failed');
  }
  return parsed;
}

export function normalizeIdempotencyKey(value: string | undefined): string {
  const key = value?.trim() ?? '';
  if (!key) {
    throw problem(428, 'idempotency_key_required', 'This payroll command requires an Idempotency-Key header.', 'Precondition required');
  }
  if (key.length > 255 || /[^\x20-\x7e]/.test(key)) {
    throw problem(422, 'invalid_idempotency_key', 'Idempotency-Key must contain 255 printable characters or fewer.', 'Payroll validation failed');
  }
  return key;
}

export function canonicalSha256(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalJsonValue(value)), 'utf8')
    .digest('hex');
}

export function canonicalJsonValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => canonicalJsonValue(entry));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
  );
}

export function payrollRequestIdentity(args: {
  tenantId: string;
  actorUserId: string;
  operation: PayrollOperationName;
  idempotencyKey: string;
  body: unknown;
}): { operationId: string; requestHash: string } {
  const scope = {
    actorUserId: args.actorUserId,
    idempotencyKey: args.idempotencyKey,
    operation: args.operation,
    tenantId: args.tenantId,
  };
  return {
    operationId: `payroll-${args.operation.toLowerCase().replace(/_/g, '-')}-${canonicalSha256(scope)}`,
    requestHash: canonicalSha256({
      actorUserId: args.actorUserId,
      body: args.body,
      operation: args.operation,
      tenantId: args.tenantId,
    }),
  };
}

export function childPayrollOperationId(parentOperationId: string, discriminator: string): string {
  return `payroll-child-${canonicalSha256({ discriminator, parentOperationId })}`;
}

export function deterministicPayrollId(prefix: 'batch' | 'line', value: unknown): string {
  return `payroll_${prefix}_${canonicalSha256({ prefix, value }).slice(0, 40)}`;
}

export function normalizeDateOnly(value: string, field: string): string {
  const normalized = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (!match) throw problem(422, `invalid_payroll_${field}`, `${field} must use YYYY-MM-DD.`, 'Payroll validation failed');
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (
    date.getUTCFullYear() !== Number(match[1])
    || date.getUTCMonth() + 1 !== Number(match[2])
    || date.getUTCDate() !== Number(match[3])
  ) {
    throw problem(422, `invalid_payroll_${field}`, `${field} must be a valid calendar date.`, 'Payroll validation failed');
  }
  return normalized;
}

export function dateOnlyForPrisma(value: string): Date {
  return new Date(`${normalizeDateOnly(value, 'date')}T00:00:00.000Z`);
}

export function serializeDateOnly(value: Date | string): string {
  const date = requiredDate(value, 'Stored payroll date is invalid.');
  return date.toISOString().slice(0, 10);
}

export function normalizeTimeZone(value: string): string {
  const timeZone = value.trim();
  if (!timeZone || timeZone.length > 100) {
    throw problem(422, 'invalid_payroll_timezone', 'timeZone must be a valid IANA timezone.', 'Payroll validation failed');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return timeZone;
  } catch {
    throw problem(422, 'invalid_payroll_timezone', 'timeZone must be a valid IANA timezone.', 'Payroll validation failed');
  }
}

export function normalizePayrollPolicy(value: {
  timeZone: string;
  cadence: 'WEEKLY' | 'BIWEEKLY';
  anchorDate: string;
  effectiveFrom: string;
}): {
  timeZone: string;
  cadence: 'WEEKLY' | 'BIWEEKLY';
  anchorDate: string;
  effectiveFrom: string;
} {
  const cadence = value.cadence;
  if (cadence !== 'WEEKLY' && cadence !== 'BIWEEKLY') {
    throw problem(422, 'invalid_payroll_cadence', 'cadence must be WEEKLY or BIWEEKLY.', 'Payroll validation failed');
  }
  return {
    timeZone: normalizeTimeZone(value.timeZone),
    cadence,
    anchorDate: normalizeDateOnly(value.anchorDate, 'anchorDate'),
    effectiveFrom: normalizeDateOnly(value.effectiveFrom, 'effectiveFrom'),
  };
}

function dayNumber(value: string): number {
  const [year, month, day] = value.split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function cadenceDays(value: 'WEEKLY' | 'BIWEEKLY'): number {
  return value === 'WEEKLY' ? 7 : 14;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

export function assertPayrollAnchorAlignment(
  localStartDate: string,
  anchorDate: string,
  cadence: 'WEEKLY' | 'BIWEEKLY',
): void {
  const start = normalizeDateOnly(localStartDate, 'localStartDate');
  const anchor = normalizeDateOnly(anchorDate, 'anchorDate');
  if (positiveModulo(dayNumber(start) - dayNumber(anchor), cadenceDays(cadence)) !== 0) {
    throw problem(422, 'payroll_anchor_misaligned', 'Date must align with the payroll policy anchor and cadence.', 'Payroll validation failed');
  }
}

function zonedParts(value: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.get('year')),
    month: Number(values.get('month')),
    day: Number(values.get('day')),
    hour: Number(values.get('hour')),
    minute: Number(values.get('minute')),
    second: Number(values.get('second')),
  };
}

function localDateBoundaryUtc(dateOnly: string, timeZone: string): Date {
  const [year, month, day] = normalizeDateOnly(dateOnly, 'date').split('-').map(Number);
  const targetUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = targetUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(new Date(guess), timeZone);
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const delta = targetUtc - actualUtc;
    guess += delta;
    if (delta === 0) break;
  }
  const result = new Date(guess);
  const verified = zonedParts(result, timeZone);
  if (verified.year !== year || verified.month !== month || verified.day !== day || verified.hour !== 0 || verified.minute !== 0 || verified.second !== 0) {
    throw problem(422, 'invalid_payroll_boundary', 'The local payroll boundary does not exist in its timezone.', 'Payroll validation failed');
  }
  return result;
}

function addDateDays(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function payrollPeriodBoundaries(
  localStartDate: string,
  policy: { timeZone: string; cadence: 'WEEKLY' | 'BIWEEKLY'; anchorDate: string },
): {
  localStartDate: string;
  localEndDateExclusive: string;
  startsAt: Date;
  endsAt: Date;
} {
  const start = normalizeDateOnly(localStartDate, 'localStartDate');
  assertPayrollAnchorAlignment(start, policy.anchorDate, policy.cadence);
  const localEndDateExclusive = addDateDays(start, cadenceDays(policy.cadence));
  const timeZone = normalizeTimeZone(policy.timeZone);
  return {
    localStartDate: start,
    localEndDateExclusive,
    startsAt: localDateBoundaryUtc(start, timeZone),
    endsAt: localDateBoundaryUtc(localEndDateExclusive, timeZone),
  };
}

export function assertFutureEffectiveBoundary(policy: {
  timeZone: string;
  cadence: 'WEEKLY' | 'BIWEEKLY';
  anchorDate: string;
  effectiveFrom: string;
}, now = new Date()): void {
  const parts = zonedParts(now, normalizeTimeZone(policy.timeZone));
  const currentDate = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  if (policy.effectiveFrom <= currentDate) {
    throw problem(422, 'payroll_policy_not_future', 'effectiveFrom must be a future local date.', 'Payroll validation failed');
  }
  assertPayrollAnchorAlignment(policy.effectiveFrom, policy.anchorDate, policy.cadence);
}

export function parseInstant(value: string, field: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw problem(422, `invalid_payroll_${field}`, `${field} must be an ISO UTC instant.`, 'Payroll validation failed');
  }
  return date;
}

export function payrollWorkedMinutes(entry: {
  clockInAt: Date | string;
  clockOutAt: Date | string;
  breakMinutes: number;
}): number {
  const clockInAt = requiredDate(entry.clockInAt, 'Stored payroll time-card duration is invalid.');
  const clockOutAt = requiredDate(entry.clockOutAt, 'Stored payroll time-card duration is invalid.');
  if (!Number.isSafeInteger(entry.breakMinutes) || entry.breakMinutes < 0) {
    throw new Error('Stored payroll break minutes are invalid.');
  }
  const elapsedMilliseconds = clockOutAt.getTime() - clockInAt.getTime();
  const grossMinutes = Math.floor(elapsedMilliseconds / 60_000);
  const workedMinutes = grossMinutes - entry.breakMinutes;
  if (elapsedMilliseconds <= 0 || !Number.isSafeInteger(grossMinutes) || workedMinutes < 0) {
    throw new Error('Stored payroll time-card duration is invalid.');
  }
  return workedMinutes;
}

export function payrollLockAggregateSha256(args: {
  tenantId: string;
  periodId: string;
  entryHashes: string[];
  totalPayableMinutes: number;
}): string {
  if (!Number.isSafeInteger(args.totalPayableMinutes) || args.entryHashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error('Payroll entry evidence is invalid.');
  }
  return canonicalSha256({
    body: {
      count: args.entryHashes.length,
      entryHashes: args.entryHashes,
      totalPayableMinutes: args.totalPayableMinutes,
    },
    operation: 'LOCK_AGGREGATE',
    periodId: args.periodId,
    tenantId: args.tenantId,
  });
}

export function materializeLockedSnapshots(args: {
  tenantId: string;
  periodId: string;
  sources: LockedEntrySource[];
}): {
  entries: Array<LockedEntrySource & { sequence: number; canonicalSha256: string }>;
  aggregateSha256: string;
  totalPayableMinutes: number;
} {
  const entries = [...args.sources]
    .sort((left, right) => compareText(left.employeeId, right.employeeId)
      || requiredDate(left.clockInAt, 'Payroll snapshot instant is invalid.').getTime() - requiredDate(right.clockInAt, 'Payroll snapshot instant is invalid.').getTime()
      || compareText(left.sourceType, right.sourceType)
      || compareText(left.sourceId, right.sourceId))
    .map((source, sequence) => {
      const normalized = {
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        sourceRevision: source.sourceRevision,
        employeeId: source.employeeId,
        locationId: source.locationId,
        workTimeZone: source.workTimeZone,
        clockInAt: requiredDate(source.clockInAt, 'Payroll snapshot instant is invalid.').toISOString(),
        clockOutAt: requiredDate(source.clockOutAt, 'Payroll snapshot instant is invalid.').toISOString(),
        breakMinutes: source.breakMinutes,
        payableMinutes: source.payableMinutes,
        approvedAt: requiredDate(source.approvedAt, 'Payroll snapshot instant is invalid.').toISOString(),
        approvedByUserId: source.approvedByUserId,
        breakIntervals: [...(source.breakIntervals ?? [])]
          .map((interval) => ({
            startAt: requiredDate(interval.startAt, 'Payroll snapshot interval is invalid.').toISOString(),
            endAt: requiredDate(interval.endAt, 'Payroll snapshot interval is invalid.').toISOString(),
          }))
          .sort((left, right) => compareText(left.startAt, right.startAt) || compareText(left.endAt, right.endAt)),
      };
      return {
        ...source,
        sequence,
        canonicalSha256: canonicalSha256({
          body: normalized,
          operation: 'LOCK_ENTRY',
          periodId: args.periodId,
          tenantId: args.tenantId,
        }),
      };
    });
  const totalPayableMinutes = entries.reduce((total, entry) => {
    const next = total + entry.payableMinutes;
    if (!Number.isSafeInteger(next)) throw new Error('Payroll payable total is invalid.');
    return next;
  }, 0);
  return {
    entries,
    totalPayableMinutes,
    aggregateSha256: payrollLockAggregateSha256({
      tenantId: args.tenantId,
      periodId: args.periodId,
      entryHashes: entries.map((entry) => entry.canonicalSha256),
      totalPayableMinutes,
    }),
  };
}

export function payrollExportLineSha256(args: {
  tenantId: string;
  batchId: string;
  lockedEntryId: string;
  line: PayrollCsvLine;
}): string {
  return canonicalSha256({
    body: {
      batchId: args.batchId,
      lockedEntryId: args.lockedEntryId,
      ...args.line,
      clockInAt: requiredDate(args.line.clockInAt, 'Stored payroll instant is invalid.').toISOString(),
      clockOutAt: requiredDate(args.line.clockOutAt, 'Stored payroll instant is invalid.').toISOString(),
    },
    operation: 'EXPORT_LINE',
    tenantId: args.tenantId,
  });
}

export function buildPayrollCsv(lines: PayrollCsvLine[]): Buffer {
  const ordered = [...lines].sort((left, right) => left.lineNumber - right.lineNumber || compareText(left.id, right.id));
  ordered.forEach((line, index) => {
    if (line.lineNumber !== index + 1) throw new Error('Stored payroll line sequence is invalid.');
  });
  const header = 'payroll_line_id,source_type,source_id,employee_id,location_id,work_time_zone,clock_in_utc,clock_out_utc,break_minutes,payable_minutes';
  const rows = ordered.map((line) => [
    line.id,
    line.sourceType,
    line.sourceId,
    line.employeeId,
    line.locationId ?? '',
    line.workTimeZone,
    requiredDate(line.clockInAt, 'Stored payroll instant is invalid.').toISOString(),
    requiredDate(line.clockOutAt, 'Stored payroll instant is invalid.').toISOString(),
    unsignedIntegerCell(line.breakMinutes),
    signedIntegerCell(line.payableMinutes),
  ].map((cell) => `"${cell.replace(/"/g, '""')}"`).join(','));
  return Buffer.from(`${header}\n${rows.length > 0 ? `${rows.join('\n')}\n` : ''}`, 'utf8');
}

export function payrollContentSha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeReconciliation(value: {
  provider: string;
  providerEventId: string;
  providerTotalMinutes: number;
  outcomes: Array<{ lineId: string; status: 'PENDING' | 'ACCEPTED' | 'REJECTED'; reason?: string }>;
}): ReconciliationPayload {
  const provider = boundedText(value.provider, 'provider', 100);
  const providerEventId = boundedText(value.providerEventId, 'providerEventId', 200);
  if (!Number.isSafeInteger(value.providerTotalMinutes)) {
    throw problem(422, 'invalid_payroll_provider_total', 'providerTotalMinutes must be a whole number.', 'Payroll validation failed');
  }
  if (value.outcomes.length < 1 || value.outcomes.length > MAX_RECONCILIATION_OUTCOMES) {
    throw problem(422, 'invalid_payroll_outcomes', `outcomes must contain between 1 and ${MAX_RECONCILIATION_OUTCOMES} items.`, 'Payroll validation failed');
  }
  const outcomes = value.outcomes.map((outcome) => ({
    lineId: requireId(outcome.lineId, 'lineId'),
    status: outcome.status,
    reason: outcome.reason === undefined ? null : boundedText(outcome.reason, 'reason', 500),
  })).sort((left, right) => compareText(left.lineId, right.lineId));
  if (new Set(outcomes.map((outcome) => outcome.lineId)).size !== outcomes.length) {
    throw problem(422, 'duplicate_payroll_outcomes', 'outcomes must not repeat line IDs.', 'Payroll validation failed');
  }
  return { provider, providerEventId, providerTotalMinutes: value.providerTotalMinutes, outcomes };
}

export function reconciliationPayloadSha256(args: {
  tenantId: string;
  actorUserId: string;
  batchId: string;
  payload: ReconciliationPayload;
}): string {
  return canonicalSha256({
    actorUserId: args.actorUserId,
    body: args.payload,
    operation: 'RECONCILE',
    batchId: args.batchId,
    tenantId: args.tenantId,
  });
}

export function reconciliationCounts(payload: ReconciliationPayload): {
  acceptedCount: number;
  rejectedCount: number;
  pendingCount: number;
} {
  return {
    acceptedCount: payload.outcomes.filter((outcome) => outcome.status === 'ACCEPTED').length,
    rejectedCount: payload.outcomes.filter((outcome) => outcome.status === 'REJECTED').length,
    pendingCount: payload.outcomes.filter((outcome) => outcome.status === 'PENDING').length,
  };
}

export async function applyPayrollTransactionTimeouts(transaction: TenantTransaction): Promise<void> {
  await transaction.$queryRaw`
    SELECT
      set_config('lock_timeout', '2000ms', true),
      set_config('statement_timeout', '12000ms', true)
  `;
}

export async function lockPayrollTenant(transaction: TenantTransaction, tenantId: string): Promise<void> {
  await transaction.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${`lunchlineup:payroll:${tenantId}`}, 0))
  `;
}

export async function lockPayrollPeriod(transaction: TenantTransaction, tenantId: string, periodId: string): Promise<void> {
  await transaction.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${`lunchlineup:payroll:${tenantId}:${periodId}`}, 0))
  `;
}

export async function writePayrollAudit(
  transaction: TenantTransaction,
  actor: PayrollActor,
  args: {
    action: string;
    resource: string;
    resourceId: string;
    oldValue?: Record<string, unknown> | null;
    newValue?: Record<string, unknown> | null;
  },
): Promise<void> {
  await transaction.auditLog.create({
    data: {
      tenantId: actor.tenantId,
      userId: actor.sub,
      actorUserId: actor.sub,
      actorTenantId: actor.tenantId,
      action: args.action,
      resource: args.resource,
      resourceId: args.resourceId,
      ...(args.oldValue === undefined ? {} : { oldValue: args.oldValue as Prisma.InputJsonValue }),
      ...(args.newValue === undefined ? {} : { newValue: args.newValue as Prisma.InputJsonValue }),
    },
  });
}

export async function retryPayrollSerializableMutation<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === 0 && isSerializationConflict(error)) continue;
      throw error;
    }
  }
  throw new Error('Payroll serializable retry limit is invalid.');
}

export function isUniqueConflict(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'P2002');
}

export function isLockTimeout(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; meta?: { code?: unknown } };
  return candidate.code === '55P03' || (candidate.code === 'P2010' && candidate.meta?.code === '55P03');
}

function isSerializationConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; meta?: { code?: unknown } };
  return candidate.code === 'P2034' || candidate.code === '40001' || (candidate.code === 'P2010' && candidate.meta?.code === '40001');
}

export async function lockPayrollCandidateCards(
  transaction: TenantTransaction,
  tenantId: string,
  period: { id: string; startsAt: Date; endsAt: Date },
): Promise<PayrollCandidateCard[]> {
  const cards = await transaction.$queryRaw<PayrollCandidateCard[]>(Prisma.sql`
    SELECT card."id", card."tenantId", card."userId", card."locationId",
           card."payrollPeriodId", card."workTimeZone", card."revision",
           card."clockInAt", card."clockOutAt", card."breakMinutes",
           card."status", card."deletedAt"
    FROM "TimeCard" card
    WHERE card."tenantId" = ${tenantId}
      AND (
        card."payrollPeriodId" = ${period.id}
        OR (
          card."deletedAt" IS NULL
          AND card."clockInAt" < ${period.endsAt}
          AND (card."clockOutAt" IS NULL OR card."clockOutAt" > ${period.startsAt})
        )
      )
    ORDER BY card."id" ASC
    LIMIT ${MAX_PAYROLL_LOCK_ENTRIES + 1}
    FOR UPDATE
  `);
  if (cards.length > MAX_PAYROLL_LOCK_ENTRIES) {
    throw problem(422, 'payroll_period_card_limit', `Payroll period exceeds the ${MAX_PAYROLL_LOCK_ENTRIES}-card limit.`, 'Payroll validation failed');
  }
  return cards;
}

export function validatePayrollCandidateCards(
  cards: PayrollCandidateCard[],
  period: { id: string; startsAt: Date; endsAt: Date },
): PayrollCandidateCard[] {
  const assigned = cards.filter((card) => card.payrollPeriodId === period.id);
  if (cards.some((card) => card.status === 'OPEN')) {
    throw problem(409, 'payroll_open_card_overlap', 'Open time cards overlap or belong to this payroll period.', 'Payroll conflict');
  }
  if (cards.some((card) => card.status === 'VOID' || card.deletedAt)) {
    throw problem(409, 'payroll_invalid_card_state', 'Void or deleted assigned time cards block payroll review and locking.', 'Payroll conflict');
  }
  if (cards.some((card) => card.payrollPeriodId !== period.id)) {
    throw problem(409, 'payroll_unassigned_card_overlap', 'Unassigned or other-period time cards overlap this payroll period.', 'Payroll conflict');
  }
  if (assigned.some((card) => (
    card.status !== 'CLOSED'
    || !card.clockOutAt
    || card.clockInAt < period.startsAt
    || card.clockOutAt > period.endsAt
  ))) {
    throw problem(409, 'payroll_card_window_invalid', 'Assigned time cards must be closed and wholly within the payroll period.', 'Payroll conflict');
  }
  for (const card of assigned) {
    if (!card.userId.trim() || !card.workTimeZone.trim()) {
      throw problem(409, 'payroll_card_context_invalid', 'A time card is missing required payroll context.', 'Payroll conflict');
    }
    normalizeTimeZone(card.workTimeZone);
  }
  return assigned;
}

export async function loadPayrollPeriodSummaries(
  transaction: TenantTransaction,
  tenantId: string,
  periodIds: string[],
): Promise<Map<string, {
  cardCount: number;
  closedCardCount: number;
  approvedCardCount: number;
  rejectedCardCount: number;
  pendingCardCount: number;
  amendmentCount: number;
  pendingAmendmentCount: number;
  approvedAmendmentCount: number;
  lockedEntryCount: number;
}>> {
  if (periodIds.length === 0) return new Map();
  const rows = await transaction.$queryRaw<Array<Record<string, string | number | bigint>>>(Prisma.sql`
    SELECT
      period."id" AS "periodId",
      count(card.*)::integer AS "cardCount",
      count(card.*) FILTER (WHERE card."status" = 'CLOSED')::integer AS "closedCardCount",
      count(approval.*) FILTER (WHERE approval."decision" = 'APPROVED')::integer AS "approvedCardCount",
      count(approval.*) FILTER (WHERE approval."decision" = 'REJECTED')::integer AS "rejectedCardCount",
      (SELECT count(*)::integer FROM "PayrollAmendment" amendment
        WHERE amendment."tenantId" = ${tenantId}
          AND amendment."adjustmentPeriodId" = period."id") AS "amendmentCount",
      (SELECT count(*)::integer FROM "PayrollAmendment" amendment
        LEFT JOIN "PayrollAmendmentDecision" decision
          ON decision."tenantId" = amendment."tenantId" AND decision."amendmentId" = amendment."id"
        WHERE amendment."tenantId" = ${tenantId}
          AND amendment."adjustmentPeriodId" = period."id"
          AND decision."id" IS NULL) AS "pendingAmendmentCount",
      (SELECT count(*)::integer FROM "PayrollAmendment" amendment
        JOIN "PayrollAmendmentDecision" decision
          ON decision."tenantId" = amendment."tenantId" AND decision."amendmentId" = amendment."id"
        WHERE amendment."tenantId" = ${tenantId}
          AND amendment."adjustmentPeriodId" = period."id"
          AND decision."decision" = 'APPROVED') AS "approvedAmendmentCount",
      (SELECT count(*)::integer FROM "PayrollLockedEntry" entry
        WHERE entry."tenantId" = ${tenantId}
          AND entry."periodId" = period."id") AS "lockedEntryCount"
    FROM "PayrollPeriod" period
    LEFT JOIN "TimeCard" card
      ON card."tenantId" = period."tenantId"
     AND card."payrollPeriodId" = period."id"
     AND card."deletedAt" IS NULL
    LEFT JOIN "PayrollTimeCardApproval" approval
      ON approval."tenantId" = card."tenantId"
     AND approval."periodId" = period."id"
     AND approval."timeCardId" = card."id"
     AND approval."timeCardRevision" = card."revision"
    WHERE period."tenantId" = ${tenantId}
      AND period."id" IN (${Prisma.join(periodIds)})
    GROUP BY period."id"
  `);
  return new Map(rows.map((row) => {
    const closedCardCount = countValue(row.closedCardCount);
    const approvedCardCount = countValue(row.approvedCardCount);
    const rejectedCardCount = countValue(row.rejectedCardCount);
    return [String(row.periodId), {
      cardCount: countValue(row.cardCount),
      closedCardCount,
      approvedCardCount,
      rejectedCardCount,
      pendingCardCount: Math.max(0, closedCardCount - approvedCardCount - rejectedCardCount),
      amendmentCount: countValue(row.amendmentCount),
      pendingAmendmentCount: countValue(row.pendingAmendmentCount),
      approvedAmendmentCount: countValue(row.approvedAmendmentCount),
      lockedEntryCount: countValue(row.lockedEntryCount),
    }];
  }));
}

export async function loadPayrollPeriodSummary(
  transaction: TenantTransaction,
  tenantId: string,
  periodId: string,
) {
  const summaries = await loadPayrollPeriodSummaries(transaction, tenantId, [periodId]);
  return summaries.get(periodId) ?? {
    cardCount: 0,
    closedCardCount: 0,
    approvedCardCount: 0,
    rejectedCardCount: 0,
    pendingCardCount: 0,
    amendmentCount: 0,
    pendingAmendmentCount: 0,
    approvedAmendmentCount: 0,
    lockedEntryCount: 0,
  };
}

function countValue(value: string | number | bigint | undefined): number {
  const count = Number(value ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Stored payroll count is invalid.');
  return count;
}

function boundedText(value: string, field: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw problem(422, `invalid_payroll_${field}`, `${field} is invalid.`, 'Payroll validation failed');
  }
  return normalized;
}

function requiredDate(value: Date | string, message: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(message);
  return date;
}

function unsignedIntegerCell(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Stored payroll CSV integer is invalid.');
  return String(value);
}

function signedIntegerCell(value: number): string {
  if (!Number.isSafeInteger(value)) throw new Error('Stored payroll CSV integer is invalid.');
  return String(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
