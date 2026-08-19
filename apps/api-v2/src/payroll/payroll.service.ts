import { randomUUID } from 'node:crypto';
import { Prisma, type PayrollExportBatch } from '@prisma/client';
import type {
  PayrollCardsAdoptRequest,
  PayrollAmendmentDecisionRequest,
  PayrollAmendmentRequest,
  PayrollDecisionsRequest,
  PayrollExpectedRevisionRequest,
  PayrollExportRequest,
  PayrollPeriodCreateRequest,
  PayrollPeriodDetailQuery,
  PayrollPeriodListQuery,
  PayrollPolicyListQuery,
  PayrollPolicyRequest,
  PayrollReconciliationRequest,
  SessionIdentity,
} from '@lunchlineup/api-contract';
import type { TenantDatabase, TenantTransaction } from '../platform/database';
import { assertFeatureEntitled, debitFeatureCredit, lockTenantForFeature } from '../platform/feature-entitlement';
import { ProblemError } from '../platform/problem';
import {
  MAX_PAYROLL_CARD_PAGE_SIZE,
  MAX_PAYROLL_HISTORY_PAGE_SIZE,
  MAX_PAYROLL_LOCK_ENTRIES,
  PAYROLL_CONCURRENT_CHANGE,
  PAYROLL_REPLAY_CONFLICT,
  applyPayrollTransactionTimeouts,
  assertFutureEffectiveBoundary,
  assertPayrollAnchorAlignment,
  buildPayrollCsv,
  childPayrollOperationId,
  dateOnlyForPrisma,
  deterministicPayrollId,
  isUniqueConflict,
  isLockTimeout,
  type LockedEntrySource,
  type PayrollCandidateCard,
  type ReconciliationPayload,
  loadPayrollPeriodSummary,
  loadPayrollPeriodSummaries,
  lockPayrollCandidateCards,
  lockPayrollPeriod,
  lockPayrollTenant,
  materializeLockedSnapshots,
  normalizeIdempotencyKey,
  normalizeReconciliation,
  normalizePayrollPolicy,
  parseBoundedLimit,
  parseInstant,
  payrollContentSha256,
  payrollExportLineSha256,
  payrollLockAggregateSha256,
  payrollWorkedMinutes,
  payrollPeriodBoundaries,
  payrollRequestIdentity,
  reconciliationCounts,
  reconciliationPayloadSha256,
  retryPayrollSerializableMutation,
  serializeDateOnly,
  validatePayrollCandidateCards,
  writePayrollAudit,
} from './domain';

const TRANSACTION_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  maxWait: 5_000,
  timeout: 20_000,
} as const;

type PayrollRow = {
  id: string;
  publicId: string;
  tenantId: string;
  policyVersionId: string;
  localStartDate: Date;
  localEndDateExclusive: Date;
  startsAt: Date;
  endsAt: Date;
  timeZone: string;
  cadence: 'WEEKLY' | 'BIWEEKLY';
  status: 'OPEN' | 'REVIEW' | 'LOCKED';
  revision: number;
  reviewStartedAt: Date | null;
  lockedAt: Date | null;
  lockOperationId: string | null;
  lockRequestHash: string | null;
  lockedEntrySha256: string | null;
  lockedEntryCount: number | null;
  totalPayableMinutes: number | null;
  createdAt: Date;
  updatedAt: Date;
};

type LockedBreak = {
  id: string;
  timeCardId: string;
  startAt: Date;
  endAt: Date;
};

function payrollProblem(status: number, code: string, detail: string, title = 'Payroll request failed'): ProblemError {
  return new ProblemError(status, code, detail, title);
}

function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(value: string | undefined, field: string): Record<string, unknown> | null {
  if (value === undefined) return null;
  if (!value || value.length > 512) {
    throw payrollProblem(422, `invalid_payroll_${field}`, `${field} is invalid.`, 'Payroll validation failed');
  }
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('invalid cursor');
    return decoded as Record<string, unknown>;
  } catch {
    throw payrollProblem(422, `invalid_payroll_${field}`, `${field} is invalid.`, 'Payroll validation failed');
  }
}

function cursorText(cursor: Record<string, unknown> | null, key: string, field: string): string | null {
  if (!cursor) return null;
  const value = cursor[key];
  if (typeof value !== 'string' || !value || value.length > 512) {
    throw payrollProblem(422, `invalid_payroll_${field}`, `${field} is invalid.`, 'Payroll validation failed');
  }
  return value;
}

function cursorInteger(cursor: Record<string, unknown> | null, key: string, field: string): number | null {
  if (!cursor) return null;
  const value = cursor[key];
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw payrollProblem(422, `invalid_payroll_${field}`, `${field} is invalid.`, 'Payroll validation failed');
  }
  return Number(value);
}

function requiredPublicId(value: string, resource: string): string {
  const id = value.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw payrollProblem(404, `${resource}_not_found`, `The requested ${resource.replace(/_/g, ' ')} was not found in this workspace.`, 'Not found');
  }
  return id;
}

function sameHash(left: unknown, right: string): boolean {
  return typeof left === 'string' && left === right;
}

/**
 * Native API-02 payroll owner. It talks only to tenant-RLS PostgreSQL
 * transactions, preserves immutable payroll evidence, and serializes public
 * UUIDs at every browser boundary.
 */
export class PayrollService {
  constructor(private readonly database: Pick<TenantDatabase, 'withTenant'>) {}

  async listPolicies(identity: SessionIdentity, query: PayrollPolicyListQuery) {
    const limit = parseBoundedLimit(query.limit, 'policy_limit', 25, MAX_PAYROLL_HISTORY_PAGE_SIZE);
    const cursor = decodeCursor(query.cursor, 'policy_cursor');
    const version = cursorInteger(cursor, 'version', 'policy_cursor');
    const publicId = cursorText(cursor, 'publicId', 'policy_cursor');
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const rows = await transaction.payrollPolicyVersion.findMany({
        where: {
          tenantId: identity.tenantId,
          ...(version === null ? {} : {
            OR: [
              { version: { lt: version } },
              { version, publicId: { lt: publicId ?? '' } },
            ],
          }),
        },
        orderBy: [{ version: 'desc' }, { publicId: 'desc' }],
        take: limit + 1,
      });
      const page = rows.slice(0, limit);
      const users = await this.publicUsers(transaction, identity.tenantId, page.map((row) => row.createdByUserId));
      return {
        data: page.map((row) => this.serializePolicy(row, users)),
        nextCursor: rows.length > limit && page.length > 0
          ? encodeCursor({ version: page[page.length - 1].version, publicId: page[page.length - 1].publicId })
          : null,
      };
    });
  }

  async latestPolicy(identity: SessionIdentity) {
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const row = await transaction.payrollPolicyVersion.findFirst({
        where: { tenantId: identity.tenantId },
        orderBy: [{ version: 'desc' }, { publicId: 'desc' }],
      });
      if (!row) return { data: null };
      const users = await this.publicUsers(transaction, identity.tenantId, [row.createdByUserId]);
      return { data: this.serializePolicy(row, users) };
    });
  }

  async createPolicy(identity: SessionIdentity, body: PayrollPolicyRequest, idempotencyKeyRaw: string | undefined) {
    const policy = normalizePayrollPolicy(body);
    assertPayrollAnchorAlignment(policy.effectiveFrom, policy.anchorDate, policy.cadence);
    const request = payrollRequestIdentity({
      tenantId: identity.tenantId,
      actorUserId: identity.sub,
      operation: 'POLICY_CREATE',
      idempotencyKey: normalizeIdempotencyKey(idempotencyKeyRaw),
      body: policy,
    });
    try {
      return await retryPayrollSerializableMutation(() => this.database.withTenant(identity.tenantId, async (transaction) => {
        await applyPayrollTransactionTimeouts(transaction);
        await lockPayrollTenant(transaction, identity.tenantId);
        const replay = await transaction.payrollPolicyVersion.findUnique({ where: { operationId: request.operationId } });
        if (replay) {
          if (replay.tenantId !== identity.tenantId || !sameHash(replay.requestHash, request.requestHash)) {
            throw payrollProblem(409, 'idempotency_conflict', PAYROLL_REPLAY_CONFLICT, 'Conflict');
          }
          const users = await this.publicUsers(transaction, identity.tenantId, [replay.createdByUserId]);
          return this.serializePolicy(replay, users);
        }
        const latest = await transaction.payrollPolicyVersion.findFirst({
          where: { tenantId: identity.tenantId },
          orderBy: [{ version: 'desc' }, { publicId: 'desc' }],
        });
        if (latest && serializeDateOnly(latest.effectiveFrom) >= policy.effectiveFrom) {
          throw payrollProblem(409, 'payroll_policy_boundary_conflict', 'effectiveFrom must be after the latest payroll policy boundary.', 'Conflict');
        }
        if (latest) {
          assertFutureEffectiveBoundary(policy);
          if (latest.timeZone !== policy.timeZone) {
            throw payrollProblem(422, 'payroll_policy_timezone_immutable', 'Payroll policy timezone cannot change after version 1.', 'Payroll validation failed');
          }
          assertPayrollAnchorAlignment(policy.effectiveFrom, serializeDateOnly(latest.anchorDate), latest.cadence);
        }
        const created = await transaction.payrollPolicyVersion.create({
          data: {
            tenantId: identity.tenantId,
            version: (latest?.version ?? 0) + 1,
            timeZone: policy.timeZone,
            cadence: policy.cadence,
            anchorDate: dateOnlyForPrisma(policy.anchorDate),
            effectiveFrom: dateOnlyForPrisma(policy.effectiveFrom),
            operationId: request.operationId,
            requestHash: request.requestHash,
            createdByUserId: identity.sub,
          },
        });
        const users = await this.publicUsers(transaction, identity.tenantId, [identity.sub]);
        const response = this.serializePolicy(created, users);
        await writePayrollAudit(transaction, identity, {
          action: 'PAYROLL_POLICY_VERSION_CREATED',
          resource: 'PayrollPolicyVersion',
          resourceId: created.id,
          newValue: response,
        });
        return response;
      }, TRANSACTION_OPTIONS));
    } catch (error) {
      if (isUniqueConflict(error)) {
        throw payrollProblem(409, 'payroll_policy_boundary_conflict', 'Payroll policy version conflicts with an existing boundary.', 'Conflict');
      }
      throw error;
    }
  }

  async listPeriods(identity: SessionIdentity, query: PayrollPeriodListQuery) {
    const limit = parseBoundedLimit(query.limit, 'period_limit', 25, MAX_PAYROLL_HISTORY_PAGE_SIZE);
    const cursor = decodeCursor(query.cursor, 'period_cursor');
    const localStartDate = cursorText(cursor, 'localStartDate', 'period_cursor');
    const publicId = cursorText(cursor, 'publicId', 'period_cursor');
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const rows = await transaction.payrollPeriod.findMany({
        where: {
          tenantId: identity.tenantId,
          ...(localStartDate === null ? {} : {
            OR: [
              { localStartDate: { lt: dateOnlyForPrisma(localStartDate) } },
              { localStartDate: dateOnlyForPrisma(localStartDate), publicId: { lt: publicId ?? '' } },
            ],
          }),
        },
        orderBy: [{ localStartDate: 'desc' }, { publicId: 'desc' }],
        take: limit + 1,
      }) as unknown as PayrollRow[];
      const page = rows.slice(0, limit);
      const [summaries, policies] = await Promise.all([
        loadPayrollPeriodSummaries(transaction, identity.tenantId, page.map((row) => row.id)),
        this.publicPolicies(transaction, identity.tenantId, page.map((row) => row.policyVersionId)),
      ]);
      return {
        data: page.map((row) => this.serializePeriod(row, summaries.get(row.id) ?? this.emptySummary(), policies, null)),
        nextCursor: rows.length > limit && page.length > 0
          ? encodeCursor({
            localStartDate: serializeDateOnly(page[page.length - 1].localStartDate),
            publicId: page[page.length - 1].publicId,
          })
          : null,
      };
    });
  }

  async createPeriod(identity: SessionIdentity, body: PayrollPeriodCreateRequest, idempotencyKeyRaw: string | undefined) {
    const localStartDate = body.localStartDate;
    const request = payrollRequestIdentity({
      tenantId: identity.tenantId,
      actorUserId: identity.sub,
      operation: 'PERIOD_CREATE',
      idempotencyKey: normalizeIdempotencyKey(idempotencyKeyRaw),
      body: { localStartDate },
    });
    try {
      return await retryPayrollSerializableMutation(() => this.database.withTenant(identity.tenantId, async (transaction) => {
        await applyPayrollTransactionTimeouts(transaction);
        await lockPayrollTenant(transaction, identity.tenantId);
        const replay = await transaction.payrollOperation.findUnique({ where: { operationId: request.operationId } });
        if (replay) return this.replayOperation(replay, request.requestHash);
        const policy = await transaction.payrollPolicyVersion.findFirst({
          where: { tenantId: identity.tenantId, effectiveFrom: { lte: dateOnlyForPrisma(localStartDate) } },
          orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
        });
        if (!policy) {
          throw payrollProblem(422, 'payroll_policy_missing', 'No payroll policy is effective for localStartDate.', 'Payroll validation failed');
        }
        const boundaries = payrollPeriodBoundaries(localStartDate, {
          timeZone: policy.timeZone,
          cadence: policy.cadence,
          anchorDate: serializeDateOnly(policy.anchorDate),
        });
        const overlap = await transaction.payrollPeriod.findFirst({
          where: {
            tenantId: identity.tenantId,
            startsAt: { lt: boundaries.endsAt },
            endsAt: { gt: boundaries.startsAt },
          },
          select: { id: true },
        });
        if (overlap) throw payrollProblem(409, 'payroll_period_overlap', 'Payroll period overlaps an existing period.', 'Conflict');
        const created = await transaction.payrollPeriod.create({
          data: {
            tenantId: identity.tenantId,
            policyVersionId: policy.id,
            localStartDate: dateOnlyForPrisma(boundaries.localStartDate),
            localEndDateExclusive: dateOnlyForPrisma(boundaries.localEndDateExclusive),
            startsAt: boundaries.startsAt,
            endsAt: boundaries.endsAt,
            timeZone: policy.timeZone,
            cadence: policy.cadence,
          },
        }) as unknown as PayrollRow;
        const policies = new Map([[policy.id, policy.publicId]]);
        const response = this.serializePeriod(created, this.emptySummary(), policies, null);
        await transaction.payrollOperation.create({
          data: {
            operationId: request.operationId,
            tenantId: identity.tenantId,
            periodId: created.id,
            kind: 'PERIOD_CREATE',
            requestHash: request.requestHash,
            response: response as Prisma.InputJsonValue,
          },
        });
        await writePayrollAudit(transaction, identity, {
          action: 'PAYROLL_PERIOD_CREATED',
          resource: 'PayrollPeriod',
          resourceId: created.id,
          newValue: response,
        });
        return response;
      }, TRANSACTION_OPTIONS));
    } catch (error) {
      if (isUniqueConflict(error)) {
        throw payrollProblem(409, 'payroll_period_conflict', 'Payroll period conflicts with an existing period.', 'Conflict');
      }
      throw error;
    }
  }

  async getPeriod(identity: SessionIdentity, publicPeriodId: string, query: PayrollPeriodDetailQuery) {
    const periodId = requiredPublicId(publicPeriodId, 'payroll_period');
    const cardLimit = parseBoundedLimit(query.cardLimit, 'card_limit', 100, MAX_PAYROLL_CARD_PAGE_SIZE);
    const cardCursor = cursorText(decodeCursor(query.cardCursor, 'card_cursor'), 'publicId', 'card_cursor');
    const lineLimit = parseBoundedLimit(query.lineLimit, 'line_limit', 500, 500);
    const lineCursor = cursorText(decodeCursor(query.lineCursor, 'line_cursor'), 'publicId', 'line_cursor');
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const period = await this.requirePeriod(transaction, identity.tenantId, periodId);
      const rows = await transaction.timeCard.findMany({
        where: period.status === 'OPEN'
          ? {
            tenantId: identity.tenantId,
            deletedAt: null,
            ...(cardCursor ? { publicId: { gt: cardCursor } } : {}),
            OR: [
              { payrollPeriodId: period.id },
              {
                payrollPeriodId: null,
                status: 'CLOSED',
                clockInAt: { gte: period.startsAt, lt: period.endsAt },
                clockOutAt: { not: null, lte: period.endsAt },
              },
            ],
          }
          : {
            tenantId: identity.tenantId,
            payrollPeriodId: period.id,
            deletedAt: null,
            ...(cardCursor ? { publicId: { gt: cardCursor } } : {}),
          },
        orderBy: [{ publicId: 'asc' }],
        take: cardLimit + 1,
        select: {
          id: true,
          publicId: true,
          userId: true,
          locationId: true,
          payrollPeriodId: true,
          workTimeZone: true,
          clockInAt: true,
          clockOutAt: true,
          breakMinutes: true,
          status: true,
          revision: true,
          updatedAt: true,
          user: { select: { publicId: true, name: true, username: true } },
          location: { select: { publicId: true } },
        },
      });
      const page = rows.slice(0, cardLimit);
      const approvals = page.length === 0 ? [] : await transaction.payrollTimeCardApproval.findMany({
        where: {
          tenantId: identity.tenantId,
          periodId: period.id,
          OR: page.map((card) => ({ timeCardId: card.id, timeCardRevision: card.revision })),
        },
      });
      const approverIds = approvals.map((approval) => approval.decidedByUserId);
      const approvers = await this.publicUsers(transaction, identity.tenantId, approverIds);
      const decisionByCard = new Map(approvals.map((approval) => [`${approval.timeCardId}:${approval.timeCardRevision}`, approval]));
      const summary = await loadPayrollPeriodSummary(transaction, identity.tenantId, period.id);
      const policies = await this.publicPolicies(transaction, identity.tenantId, [period.policyVersionId]);
      const [lockedEntries, amendments, batch] = await Promise.all([
        this.serializedLockedEntries(transaction, identity.tenantId, period.id),
        this.serializedAmendments(transaction, identity.tenantId, period.id, period.status),
        transaction.payrollExportBatch.findFirst({ where: { tenantId: identity.tenantId, periodId: period.id } }),
      ]);
      const exportBatch = batch
        ? await this.serializeExport(transaction, identity.tenantId, batch, lineLimit, lineCursor)
        : null;
      return {
        period: this.serializePeriod(period, summary, policies, exportBatch),
        cards: page.map((card) => {
          const decision = decisionByCard.get(`${card.id}:${card.revision}`);
          const payableMinutes = card.clockOutAt
            ? Math.max(0, Math.floor((card.clockOutAt.getTime() - card.clockInAt.getTime()) / 60_000) - card.breakMinutes)
            : 0;
          return {
            id: card.publicId,
            timeCardRevision: card.revision,
            user: {
              id: card.user.publicId,
              name: card.user.name,
              username: card.user.username ?? '',
            },
            locationId: card.location?.publicId ?? null,
            clockInAt: card.clockInAt.toISOString(),
            clockOutAt: card.clockOutAt?.toISOString() ?? null,
            breakMinutes: card.breakMinutes,
            payableMinutes,
            updatedAt: card.updatedAt.toISOString(),
            displayTimeZone: card.workTimeZone || period.timeZone,
            included: card.payrollPeriodId === period.id,
            adoptionEligible: period.status === 'OPEN'
              && card.payrollPeriodId === null
              && card.status === 'CLOSED'
              && Boolean(card.clockOutAt)
              && card.clockInAt >= period.startsAt
              && (card.clockOutAt ?? period.endsAt) <= period.endsAt,
            decision: decision ? {
              timeCardRevision: decision.timeCardRevision,
              decision: decision.decision,
              reason: decision.reason ?? null,
              decidedAt: decision.decidedAt.toISOString(),
              decidedByUserId: this.requireMapped(approvers, decision.decidedByUserId, 'staff'),
            } : null,
            decisionIsCurrent: Boolean(decision),
          };
        }),
        nextCardCursor: rows.length > cardLimit && page.length > 0
          ? encodeCursor({ publicId: page[page.length - 1].publicId })
          : null,
        lockedEntries,
        amendments,
      };
    });
  }

  async getExport(identity: SessionIdentity, publicExportId: string, query: { lineLimit?: string; lineCursor?: string }) {
    const exportId = requiredPublicId(publicExportId, 'payroll_export');
    const lineLimit = parseBoundedLimit(query.lineLimit, 'line_limit', 500, 500);
    const lineCursor = cursorText(decodeCursor(query.lineCursor, 'line_cursor'), 'publicId', 'line_cursor');
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const batch = await transaction.payrollExportBatch.findFirst({
        where: { tenantId: identity.tenantId, publicId: exportId },
      });
      if (!batch) throw payrollProblem(404, 'payroll_export_not_found', 'The requested payroll export was not found in this workspace.', 'Not found');
      return this.serializeExport(transaction, identity.tenantId, batch, lineLimit, lineCursor);
    });
  }

  async exportEntitlement(identity: SessionIdentity) {
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      try {
        const entitlement = await assertFeatureEntitled(transaction, identity.tenantId, 'time_cards', true);
        if (!entitlement) {
          return {
            creditCost: null,
            eligible: false,
            reason: 'Payroll export requires usage credits.',
          };
        }
        return {
          creditCost: entitlement.creditCost,
          eligible: true,
          reason: 'Payroll export is eligible.',
        };
      } catch (error) {
        if (error instanceof ProblemError && error.status === 403) {
          return { creditCost: null, eligible: false, reason: error.message.slice(0, 500) };
        }
        throw error;
      }
    });
  }

  async createExport(
    identity: SessionIdentity,
    publicPeriodId: string,
    body: PayrollExportRequest,
    idempotencyKeyRaw: string | undefined,
  ) {
    const periodId = await this.resolvePeriodId(identity, publicPeriodId);
    const request = payrollRequestIdentity({
      tenantId: identity.tenantId,
      actorUserId: identity.sub,
      operation: 'EXPORT',
      idempotencyKey: normalizeIdempotencyKey(idempotencyKeyRaw),
      body: { periodId, expectedCreditCost: body.expectedCreditCost },
    });
    try {
      return await retryPayrollSerializableMutation(() => this.database.withTenant(identity.tenantId, async (transaction) => {
        await applyPayrollTransactionTimeouts(transaction);
        // Lock order is shared with every debit path: tenant wallet first, then
        // tenant/period payroll advisory locks.
        await lockTenantForFeature(transaction, identity.tenantId);
        await lockPayrollTenant(transaction, identity.tenantId);
        await lockPayrollPeriod(transaction, identity.tenantId, periodId);
        const replay = await transaction.payrollExportBatch.findUnique({ where: { operationId: request.operationId } });
        if (replay) {
          if (
            replay.tenantId !== identity.tenantId
            || replay.periodId !== periodId
            || replay.requestHash !== request.requestHash
          ) {
            throw payrollProblem(409, 'idempotency_conflict', PAYROLL_REPLAY_CONFLICT, 'Conflict');
          }
          await this.verifyExportCreditProvenance(transaction, replay);
          return this.serializeExport(transaction, identity.tenantId, replay, 500, null);
        }
        const period = await this.requirePeriodById(transaction, identity.tenantId, periodId);
        if (period.status !== 'LOCKED') {
          throw payrollProblem(409, 'payroll_export_state_invalid', 'Only a locked payroll period can be exported.', 'Conflict');
        }
        const existing = await transaction.payrollExportBatch.findFirst({
          where: { tenantId: identity.tenantId, periodId: period.id },
          select: { id: true },
        });
        if (existing) {
          throw payrollProblem(409, 'payroll_export_exists', 'Payroll period already has its canonical export batch.', 'Conflict');
        }
        const entitlement = await assertFeatureEntitled(transaction, identity.tenantId, 'time_cards', true);
        if (!entitlement) {
          throw payrollProblem(403, 'time_cards_not_entitled', 'Payroll export requires usage credits.', 'Feature unavailable');
        }
        if (entitlement.creditCost !== body.expectedCreditCost) {
          throw payrollProblem(409, 'payroll_credit_cost_changed', 'Payroll export credit cost changed; refresh and confirm the current cost.', 'Conflict');
        }
        const entries = await transaction.payrollLockedEntry.findMany({
          where: { tenantId: identity.tenantId, periodId: period.id },
          orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
          take: MAX_PAYROLL_LOCK_ENTRIES + 1,
        });
        if (
          entries.length === 0
          || entries.length > MAX_PAYROLL_LOCK_ENTRIES
          || entries.length !== period.lockedEntryCount
        ) {
          throw payrollProblem(409, 'payroll_export_entry_count_invalid', 'Locked payroll entry count is invalid for export.', 'Conflict');
        }
        const totalPayableMinutes = entries.reduce((total, entry) => total + entry.payableMinutes, 0);
        if (!Number.isSafeInteger(totalPayableMinutes) || totalPayableMinutes !== period.totalPayableMinutes) {
          throw payrollProblem(409, 'payroll_export_totals_invalid', 'Locked payroll totals are invalid for export.', 'Conflict');
        }
        let aggregateSha256: string;
        try {
          aggregateSha256 = payrollLockAggregateSha256({
            tenantId: identity.tenantId,
            periodId: period.id,
            entryHashes: entries.map((entry) => entry.canonicalSha256),
            totalPayableMinutes,
          });
        } catch {
          throw payrollProblem(409, 'payroll_export_integrity_invalid', 'Locked payroll integrity evidence is invalid for export.', 'Conflict');
        }
        if (aggregateSha256 !== period.lockedEntrySha256) {
          throw payrollProblem(409, 'payroll_export_integrity_mismatch', 'Locked payroll integrity evidence does not match the period.', 'Conflict');
        }
        const [users, locations, timeCards, amendments] = await Promise.all([
          this.publicUsers(transaction, identity.tenantId, entries.map((entry) => entry.employeeId)),
          this.publicLocations(transaction, identity.tenantId, entries.map((entry) => entry.locationId)),
          this.publicTimeCards(transaction, identity.tenantId, entries.filter((entry) => entry.sourceType === 'TIME_CARD').map((entry) => entry.sourceId)),
          this.publicAmendments(transaction, identity.tenantId, entries.filter((entry) => entry.sourceType === 'AMENDMENT').map((entry) => entry.sourceId)),
        ]);
        const batchId = deterministicPayrollId('batch', request.operationId);
        const batchPublicId = randomUUID();
        const lines = entries.map((entry, index) => {
          const publicLineId = randomUUID();
          const line = {
            id: publicLineId,
            lineNumber: index + 1,
            sourceType: entry.sourceType,
            sourceId: entry.sourceType === 'TIME_CARD'
              ? this.requireMapped(timeCards, entry.sourceId, 'time card')
              : this.requireMapped(amendments, entry.sourceId, 'payroll amendment'),
            employeeId: this.requireMapped(users, entry.employeeId, 'staff'),
            locationId: entry.locationId ? this.requireMapped(locations, entry.locationId, 'location') : null,
            workTimeZone: entry.workTimeZone,
            clockInAt: entry.clockInAt,
            clockOutAt: entry.clockOutAt,
            breakMinutes: entry.breakMinutes,
            payableMinutes: entry.payableMinutes,
          };
          return {
            publicId: publicLineId,
            id: deterministicPayrollId('line', { batchId, lineNumber: line.lineNumber, lockedEntryId: entry.id }),
            lockedEntryId: entry.id,
            entry,
            line,
            canonicalSha256: payrollExportLineSha256({
              tenantId: identity.tenantId,
              batchId,
              lockedEntryId: entry.id,
              line,
            }),
          };
        });
        let csv: Buffer;
        try {
          csv = buildPayrollCsv(lines.map((entry) => entry.line));
        } catch {
          throw payrollProblem(503, 'payroll_export_integrity_failed', 'Payroll evidence failed integrity verification.', 'Service unavailable');
        }
        const creditTransactionId = `feature-usage-payroll-export:${request.operationId}`;
        const settlement = await debitFeatureCredit(transaction, {
          tenantId: identity.tenantId,
          entitlement,
          operationId: `payroll-export:${request.operationId}`,
          transactionId: creditTransactionId,
          reason: `Payroll export (${period.id})`,
        });
        if (
          settlement.consumedCredits !== entitlement.creditCost
          || !Number.isSafeInteger(settlement.newBalance)
          || settlement.newBalance < 0
        ) {
          throw payrollProblem(503, 'payroll_export_settlement_invalid', 'Payroll export settlement is unavailable.', 'Service unavailable');
        }
        const batch = await transaction.payrollExportBatch.create({
          data: {
            id: batchId,
            publicId: batchPublicId,
            tenantId: identity.tenantId,
            periodId: period.id,
            operationId: request.operationId,
            requestHash: request.requestHash,
            creditTransactionId,
            // The immutable v1-compatible database constraint fixes this
            // field at version 1. Export evidence below detects whether the
            // stored rows use legacy storage IDs or native public UUIDs.
            formatVersion: 1,
            contentSha256: payrollContentSha256(csv),
            rowCount: lines.length,
            totalPayableMinutes,
            consumedCredits: settlement.consumedCredits,
            newBalance: settlement.newBalance,
          },
        });
        await transaction.payrollExportLine.createMany({
          data: lines.map(({ id, publicId, entry, canonicalSha256: lineSha256, line }) => ({
            id,
            publicId,
            tenantId: identity.tenantId,
            batchId: batch.id,
            lineNumber: line.lineNumber,
            lockedEntryId: entry.id,
            sourceType: entry.sourceType,
            sourceId: entry.sourceId,
            employeeId: entry.employeeId,
            locationId: entry.locationId,
            workTimeZone: entry.workTimeZone,
            clockInAt: entry.clockInAt,
            clockOutAt: entry.clockOutAt,
            breakMinutes: entry.breakMinutes,
            payableMinutes: entry.payableMinutes,
            canonicalSha256: lineSha256,
          })),
        });
        const response = await this.serializeExport(transaction, identity.tenantId, batch, 500, null);
        await writePayrollAudit(transaction, identity, {
          action: 'PAYROLL_EXPORT_GENERATED',
          resource: 'PayrollExportBatch',
          resourceId: batch.id,
          newValue: response,
        });
        return response;
      }, TRANSACTION_OPTIONS));
    } catch (error) {
      if (isUniqueConflict(error)) {
        const replay = await this.findExportReplay(identity, periodId, request);
        if (replay) return replay;
        throw payrollProblem(409, 'payroll_export_conflict', 'Payroll period already has its canonical export batch.', 'Conflict');
      }
      if (isLockTimeout(error)) {
        const replay = await this.findExportReplay(identity, periodId, request);
        if (replay) return replay;
        throw payrollProblem(503, 'payroll_concurrent_change', PAYROLL_CONCURRENT_CHANGE, 'Service unavailable');
      }
      throw error;
    }
  }

  async downloadExport(identity: SessionIdentity, publicExportId: string): Promise<{ filename: string; content: Buffer }> {
    const publicId = requiredPublicId(publicExportId, 'payroll_export');
    return retryPayrollSerializableMutation(() => this.database.withTenant(identity.tenantId, async (transaction) => {
      await applyPayrollTransactionTimeouts(transaction);
      await lockPayrollTenant(transaction, identity.tenantId);
      const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "PayrollExportBatch"
        WHERE "tenantId" = ${identity.tenantId} AND "publicId" = CAST(${publicId} AS uuid)
        FOR UPDATE
      `);
      if (rows.length !== 1) {
        throw payrollProblem(404, 'payroll_export_not_found', 'The requested payroll export was not found in this workspace.', 'Not found');
      }
      const batch = await transaction.payrollExportBatch.findFirst({ where: { id: rows[0].id, tenantId: identity.tenantId } });
      if (!batch) throw payrollProblem(503, 'payroll_reference_integrity_failed', 'Saved payroll export evidence is unavailable.', 'Service unavailable');
      await this.verifyExportCreditProvenance(transaction, batch);
      const period = await transaction.payrollPeriod.findFirst({
        where: { id: batch.periodId, tenantId: identity.tenantId },
        select: { localStartDate: true },
      });
      if (!period) throw payrollProblem(503, 'payroll_reference_integrity_failed', 'Saved payroll period evidence is unavailable.', 'Service unavailable');
      const evidence = await this.loadAndVerifyExportLines(transaction, identity.tenantId, batch);
      const content = evidence.publicContent;
      if (batch.status === 'GENERATED') {
        const downloadedAt = new Date();
        const changed = await transaction.payrollExportBatch.updateMany({
          where: { id: batch.id, tenantId: identity.tenantId, status: 'GENERATED' },
          data: { status: 'DOWNLOADED', downloadedAt },
        });
        if (changed.count !== 1) {
          throw payrollProblem(409, 'payroll_download_state_changed', 'Payroll export download state changed. Retry.', 'Conflict');
        }
        await writePayrollAudit(transaction, identity, {
          action: 'PAYROLL_EXPORT_DOWNLOADED',
          resource: 'PayrollExportBatch',
          resourceId: batch.id,
          newValue: { downloadedAt: downloadedAt.toISOString() },
        });
      }
      return {
        filename: `payroll-${serializeDateOnly(period.localStartDate)}-${batch.publicId}.csv`,
        content,
      };
    }, TRANSACTION_OPTIONS));
  }

  async reconcileExport(
    identity: SessionIdentity,
    publicExportId: string,
    body: PayrollReconciliationRequest,
  ) {
    const exportId = await this.resolveExportId(identity, publicExportId);
    const publicPayload = normalizeReconciliation(body);
    // Receipt hashes must keep the v1-compatible canonical storage identity.
    // Public UUIDs are translated before hashing and are never persisted in
    // the reconciliation evidence rows.
    const payload = await this.database.withTenant(identity.tenantId, (transaction) =>
      this.internalReconciliationPayload(transaction, identity.tenantId, exportId, publicPayload));
    const payloadSha256 = reconciliationPayloadSha256({
      tenantId: identity.tenantId,
      actorUserId: identity.sub,
      batchId: exportId,
      payload,
    });
    try {
      return await retryPayrollSerializableMutation(() => this.database.withTenant(identity.tenantId, async (transaction) => {
        await applyPayrollTransactionTimeouts(transaction);
        await lockPayrollTenant(transaction, identity.tenantId);
        const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id"
          FROM "PayrollExportBatch"
          WHERE "tenantId" = ${identity.tenantId} AND "id" = ${exportId}
          FOR UPDATE
        `);
        if (rows.length !== 1) {
          throw payrollProblem(404, 'payroll_export_not_found', 'The requested payroll export was not found in this workspace.', 'Not found');
        }
        const batch = await transaction.payrollExportBatch.findFirst({ where: { id: exportId, tenantId: identity.tenantId } });
        if (!batch) throw payrollProblem(503, 'payroll_reference_integrity_failed', 'Saved payroll export evidence is unavailable.', 'Service unavailable');
        await lockPayrollPeriod(transaction, identity.tenantId, batch.periodId);
        const replay = await transaction.payrollReconciliationReceipt.findUnique({
          where: {
            tenantId_provider_providerEventId: {
              tenantId: identity.tenantId,
              provider: payload.provider,
              providerEventId: payload.providerEventId,
            },
          },
        });
        if (replay) {
          if (replay.batchId !== batch.id || replay.payloadSha256 !== payloadSha256) {
            throw payrollProblem(409, 'idempotency_conflict', PAYROLL_REPLAY_CONFLICT, 'Conflict');
          }
          return this.serializeReceipt(transaction, identity.tenantId, replay);
        }
        if (batch.status === 'GENERATED') {
          throw payrollProblem(409, 'payroll_reconciliation_before_download', 'Payroll export must be downloaded before reconciliation.', 'Conflict');
        }
        if (batch.status === 'RECONCILED') {
          throw payrollProblem(409, 'payroll_reconciliation_terminal', 'Payroll export reconciliation is already terminal.', 'Conflict');
        }
        const canonicalPayload = await this.internalReconciliationPayload(
          transaction,
          identity.tenantId,
          batch.id,
          publicPayload,
        );
        const canonicalPayloadSha256 = reconciliationPayloadSha256({
          tenantId: identity.tenantId,
          actorUserId: identity.sub,
          batchId: batch.id,
          payload: canonicalPayload,
        });
        if (canonicalPayloadSha256 !== payloadSha256) {
          throw payrollProblem(409, 'payroll_reconciliation_state_changed', 'Payroll reconciliation state changed. Retry.', 'Conflict');
        }
        const outcomes = canonicalPayload.outcomes;
        const counts = reconciliationCounts(canonicalPayload);
        const receipt = await transaction.payrollReconciliationReceipt.create({
          data: {
            tenantId: identity.tenantId,
            batchId: batch.id,
            provider: payload.provider,
            providerEventId: payload.providerEventId,
            payloadSha256,
            providerTotalMinutes: payload.providerTotalMinutes,
            ...counts,
            receivedByUserId: identity.sub,
          },
        });
        await transaction.payrollReconciliationLineEvent.createMany({
          data: outcomes.map((outcome) => ({
            tenantId: identity.tenantId,
            receiptId: receipt.id,
            batchId: batch.id,
            lineId: outcome.lineId,
            status: outcome.status,
            reason: outcome.reason,
          })),
        });
        for (const outcome of outcomes) {
          await transaction.payrollReconciliationLineState.upsert({
            where: { batchId_lineId: { batchId: batch.id, lineId: outcome.lineId } },
            create: {
              tenantId: identity.tenantId,
              batchId: batch.id,
              lineId: outcome.lineId,
              status: outcome.status,
              latestReceiptId: receipt.id,
              reason: outcome.reason,
            },
            update: {
              status: outcome.status,
              latestReceiptId: receipt.id,
              reason: outcome.reason,
            },
          });
        }
        if (batch.status === 'DOWNLOADED') {
          const changed = await transaction.payrollExportBatch.updateMany({
            where: { id: batch.id, tenantId: identity.tenantId, status: 'DOWNLOADED' },
            data: { status: 'RECONCILING' },
          });
          if (changed.count !== 1) {
            throw payrollProblem(409, 'payroll_reconciliation_state_changed', 'Payroll reconciliation state changed. Retry.', 'Conflict');
          }
        }
        const accepted = await transaction.payrollReconciliationLineState.count({
          where: { tenantId: identity.tenantId, batchId: batch.id, status: 'ACCEPTED' },
        });
        if (accepted === batch.rowCount && payload.providerTotalMinutes === batch.totalPayableMinutes) {
          const changed = await transaction.payrollExportBatch.updateMany({
            where: { id: batch.id, tenantId: identity.tenantId, status: 'RECONCILING' },
            data: { status: 'RECONCILED', reconciledAt: new Date() },
          });
          if (changed.count !== 1) {
            throw payrollProblem(409, 'payroll_reconciliation_state_changed', 'Payroll reconciliation state changed. Retry.', 'Conflict');
          }
        }
        const response = await this.serializeReceipt(transaction, identity.tenantId, receipt);
        await writePayrollAudit(transaction, identity, {
          action: 'PAYROLL_RECONCILIATION_RECEIVED',
          resource: 'PayrollReconciliationReceipt',
          resourceId: receipt.id,
          newValue: response,
        });
        return response;
      }, TRANSACTION_OPTIONS));
    } catch (error) {
      if (isUniqueConflict(error)) {
        const replay = await this.findReceiptReplay(identity, exportId, payload.provider, payload.providerEventId, payloadSha256);
        if (replay) return replay;
        throw payrollProblem(409, 'idempotency_conflict', PAYROLL_REPLAY_CONFLICT, 'Conflict');
      }
      throw error;
    }
  }

  async startReview(
    identity: SessionIdentity,
    publicPeriodId: string,
    body: PayrollExpectedRevisionRequest,
    idempotencyKeyRaw: string | undefined,
  ) {
    const periodId = await this.resolvePeriodId(identity, publicPeriodId);
    const request = payrollRequestIdentity({
      tenantId: identity.tenantId,
      actorUserId: identity.sub,
      operation: 'REVIEW',
      idempotencyKey: normalizeIdempotencyKey(idempotencyKeyRaw),
      body: { periodId, expectedRevision: body.expectedRevision },
    });
    return retryPayrollSerializableMutation(() => this.database.withTenant(identity.tenantId, async (transaction) => {
      await applyPayrollTransactionTimeouts(transaction);
      await lockPayrollTenant(transaction, identity.tenantId);
      await lockPayrollPeriod(transaction, identity.tenantId, periodId);
      const replay = await transaction.payrollOperation.findUnique({ where: { operationId: request.operationId } });
      if (replay) return this.replayOperation(replay, request.requestHash);
      const period = await this.requirePeriodById(transaction, identity.tenantId, periodId);
      if (period.status !== 'OPEN') throw payrollProblem(409, 'payroll_review_state_invalid', 'Only an open payroll period can enter review.', 'Conflict');
      if (period.revision !== body.expectedRevision) throw payrollProblem(409, 'payroll_concurrent_change', PAYROLL_CONCURRENT_CHANGE, 'Concurrent change');
      if (period.endsAt.getTime() > Date.now()) throw payrollProblem(422, 'payroll_period_not_ended', 'Payroll review cannot begin before the period ends.', 'Payroll validation failed');
      const cards = validatePayrollCandidateCards(
        await lockPayrollCandidateCards(transaction, identity.tenantId, period),
        period,
      );
      void cards;
      const changed = await transaction.payrollPeriod.updateMany({
        where: { id: period.id, tenantId: identity.tenantId, status: 'OPEN', revision: body.expectedRevision },
        data: { status: 'REVIEW', revision: { increment: 1 }, reviewStartedAt: new Date(), reviewStartedByUserId: identity.sub },
      });
      if (changed.count !== 1) throw payrollProblem(409, 'payroll_concurrent_change', PAYROLL_CONCURRENT_CHANGE, 'Concurrent change');
      const updated = await this.requirePeriodById(transaction, identity.tenantId, period.id);
      const [summary, policies] = await Promise.all([
        loadPayrollPeriodSummary(transaction, identity.tenantId, updated.id),
        this.publicPolicies(transaction, identity.tenantId, [updated.policyVersionId]),
      ]);
      const response = this.serializePeriod(updated, summary, policies, null);
      await transaction.payrollOperation.create({
        data: { operationId: request.operationId, tenantId: identity.tenantId, periodId: updated.id, kind: 'REVIEW', requestHash: request.requestHash, response: response as Prisma.InputJsonValue },
      });
      await writePayrollAudit(transaction, identity, {
        action: 'PAYROLL_PERIOD_REVIEW_STARTED',
        resource: 'PayrollPeriod',
        resourceId: updated.id,
        oldValue: this.serializePeriod(period, this.emptySummary(), policies, null),
        newValue: response,
      });
      return response;
    }, TRANSACTION_OPTIONS));
  }

  async adoptCards(
    identity: SessionIdentity,
    publicPeriodId: string,
    body: PayrollCardsAdoptRequest,
    idempotencyKeyRaw: string | undefined,
  ) {
    const periodId = await this.resolvePeriodId(identity, publicPeriodId);
    const cardsByPublicId = await this.resolveTimeCards(identity, body.cards.map((card) => card.id));
    if (new Set(body.cards.map((card) => card.id)).size !== body.cards.length) {
      throw payrollProblem(422, 'duplicate_payroll_cards', 'cards must not contain duplicate IDs.', 'Payroll validation failed');
    }
    const cards = body.cards.map((card) => ({
      id: this.requireMapped(cardsByPublicId, card.id, 'time card'),
      publicId: card.id,
      expectedRevision: card.expectedRevision,
    })).sort((left, right) => left.id.localeCompare(right.id));
    const request = payrollRequestIdentity({
      tenantId: identity.tenantId,
      actorUserId: identity.sub,
      operation: 'ADOPT',
      idempotencyKey: normalizeIdempotencyKey(idempotencyKeyRaw),
      body: { periodId, cards: cards.map(({ id, expectedRevision }) => ({ id, expectedRevision })) },
    });
    try {
      return await retryPayrollSerializableMutation(() => this.database.withTenant(identity.tenantId, async (transaction) => {
        await applyPayrollTransactionTimeouts(transaction);
        await lockPayrollTenant(transaction, identity.tenantId);
        await lockPayrollPeriod(transaction, identity.tenantId, periodId);
        const replay = await transaction.payrollOperation.findUnique({ where: { operationId: request.operationId } });
        if (replay) return this.replayOperation(replay, request.requestHash);
        const period = await this.requirePeriodById(transaction, identity.tenantId, periodId);
        if (period.status !== 'OPEN') {
          throw payrollProblem(409, 'payroll_adoption_state_invalid', 'Cards can be adopted only into an open payroll period.', 'Conflict');
        }
        const rows = await transaction.timeCard.findMany({
          where: { tenantId: identity.tenantId, id: { in: cards.map((card) => card.id) } },
          orderBy: { id: 'asc' },
        });
        if (rows.length !== cards.length) {
          throw payrollProblem(404, 'time_card_not_found', 'One or more time cards were not found in this workspace.', 'Not found');
        }
        const expectedById = new Map(cards.map((card) => [card.id, card.expectedRevision]));
        for (const card of rows) {
          const expectedRevision = expectedById.get(card.id);
          if (
            expectedRevision === undefined
            || card.revision !== expectedRevision
            || card.status !== 'CLOSED'
            || card.deletedAt
            || !card.clockOutAt
            || card.payrollPeriodId
          ) {
            throw payrollProblem(409, 'payroll_concurrent_change', PAYROLL_CONCURRENT_CHANGE, 'Concurrent change');
          }
          if (card.clockInAt < period.startsAt || card.clockOutAt > period.endsAt || !card.workTimeZone.trim()) {
            throw payrollProblem(422, 'payroll_card_not_adoptable', 'Only complete, unassigned time cards wholly inside the payroll period can be adopted.', 'Payroll validation failed');
          }
        }
        for (const card of rows) {
          const updated = await transaction.timeCard.updateMany({
            where: {
              id: card.id,
              tenantId: identity.tenantId,
              revision: expectedById.get(card.id),
              payrollPeriodId: null,
              status: 'CLOSED',
              deletedAt: null,
            },
            data: { payrollPeriodId: period.id, revision: { increment: 1 } },
          });
          if (updated.count !== 1) {
            throw payrollProblem(409, 'payroll_concurrent_change', PAYROLL_CONCURRENT_CHANGE, 'Concurrent change');
          }
        }
        const publicByInternalId = new Map(cards.map((card) => [card.id, card.publicId]));
        const response = {
          periodId: period.publicId,
          cards: rows.map((card) => ({
            id: this.requireMapped(publicByInternalId, card.id, 'time card'),
            revision: card.revision + 1,
          })),
        };
        await transaction.payrollOperation.create({
          data: {
            operationId: request.operationId,
            tenantId: identity.tenantId,
            periodId: period.id,
            kind: 'ADOPT',
            requestHash: request.requestHash,
            response: response as Prisma.InputJsonValue,
          },
        });
        await writePayrollAudit(transaction, identity, {
          action: 'PAYROLL_TIME_CARDS_ADOPTED',
          resource: 'PayrollPeriod',
          resourceId: period.id,
          newValue: response,
        });
        return response;
      }, TRANSACTION_OPTIONS));
    } catch (error) {
      if (isUniqueConflict(error)) {
        throw payrollProblem(409, 'payroll_adoption_conflict', 'A time-card adoption changed before it could be committed.', 'Conflict');
      }
      throw error;
    }
  }

  async decideCards(
    identity: SessionIdentity,
    publicPeriodId: string,
    body: PayrollDecisionsRequest,
    idempotencyKeyRaw: string | undefined,
  ) {
    const periodId = await this.resolvePeriodId(identity, publicPeriodId);
    const cardsByPublicId = await this.resolveTimeCards(identity, body.decisions.map((decision) => decision.timeCardId));
    const decisions = body.decisions.map((decision) => ({
      timeCardId: this.requireMapped(cardsByPublicId, decision.timeCardId, 'time card'),
      publicTimeCardId: decision.timeCardId,
      expectedRevision: decision.expectedRevision,
      decision: decision.decision,
      reason: decision.reason?.trim() || null,
    })).sort((left, right) => left.timeCardId.localeCompare(right.timeCardId));
    if (new Set(decisions.map((decision) => `${decision.timeCardId}:${decision.expectedRevision}`)).size !== decisions.length) {
      throw payrollProblem(422, 'duplicate_payroll_decisions', 'decisions must not repeat a time-card revision.', 'Payroll validation failed');
    }
    const request = payrollRequestIdentity({
      tenantId: identity.tenantId,
      actorUserId: identity.sub,
      operation: 'APPROVAL',
      idempotencyKey: normalizeIdempotencyKey(idempotencyKeyRaw),
      body: { periodId, decisions: decisions.map(({ timeCardId, expectedRevision, decision, reason }) => ({ timeCardId, expectedRevision, decision, reason })) },
    });
    try {
      return await retryPayrollSerializableMutation(() => this.database.withTenant(identity.tenantId, async (transaction) => {
        await applyPayrollTransactionTimeouts(transaction);
        await lockPayrollTenant(transaction, identity.tenantId);
        await lockPayrollPeriod(transaction, identity.tenantId, periodId);
        const replay = await transaction.payrollOperation.findUnique({ where: { operationId: request.operationId } });
        if (replay) return this.replayOperation(replay, request.requestHash);
        const period = await this.requirePeriodById(transaction, identity.tenantId, periodId);
        if (period.status !== 'REVIEW') {
          throw payrollProblem(409, 'payroll_decision_state_invalid', 'Time-card decisions require a payroll period in review.', 'Conflict');
        }
        const rows = await transaction.timeCard.findMany({
          where: {
            tenantId: identity.tenantId,
            payrollPeriodId: period.id,
            id: { in: decisions.map((decision) => decision.timeCardId) },
          },
          orderBy: { id: 'asc' },
        });
        if (rows.length !== decisions.length) {
          throw payrollProblem(404, 'time_card_not_found', 'One or more time cards were not found in this payroll period.', 'Not found');
        }
        const decisionById = new Map(decisions.map((decision) => [decision.timeCardId, decision]));
        for (const card of rows) {
          const decision = decisionById.get(card.id);
          if (!decision || card.status !== 'CLOSED' || card.deletedAt || card.revision !== decision.expectedRevision) {
            throw payrollProblem(409, 'payroll_concurrent_change', PAYROLL_CONCURRENT_CHANGE, 'Concurrent change');
          }
          if (card.userId === identity.sub) {
            throw payrollProblem(409, 'payroll_self_approval_denied', 'Employees cannot approve or reject their own time cards.', 'Conflict');
          }
        }
        const existing = await transaction.payrollTimeCardApproval.findMany({
          where: {
            tenantId: identity.tenantId,
            OR: decisions.map((decision) => ({ timeCardId: decision.timeCardId, timeCardRevision: decision.expectedRevision })),
          },
          select: { id: true },
        });
        if (existing.length > 0) {
          throw payrollProblem(409, 'payroll_decision_exists', 'A decision already exists for a time-card revision.', 'Conflict');
        }
        const created = [];
        for (const decision of decisions) {
          const child = payrollRequestIdentity({
            tenantId: identity.tenantId,
            actorUserId: identity.sub,
            operation: 'APPROVAL',
            idempotencyKey: childPayrollOperationId(request.operationId, `${decision.timeCardId}:${decision.expectedRevision}`),
            body: decision,
          });
          created.push(await transaction.payrollTimeCardApproval.create({
            data: {
              tenantId: identity.tenantId,
              periodId: period.id,
              timeCardId: decision.timeCardId,
              timeCardRevision: decision.expectedRevision,
              decision: decision.decision,
              reason: decision.reason,
              operationId: child.operationId,
              requestHash: child.requestHash,
              decidedByUserId: identity.sub,
            },
          }));
        }
        const publicByInternalId = new Map(decisions.map((decision) => [decision.timeCardId, decision.publicTimeCardId]));
        const response = {
          periodId: period.publicId,
          decisions: created.map((decision) => ({
            timeCardId: this.requireMapped(publicByInternalId, decision.timeCardId, 'time card'),
            timeCardRevision: decision.timeCardRevision,
            decision: decision.decision,
            reason: decision.reason ?? null,
            decidedAt: decision.decidedAt.toISOString(),
            decidedByUserId: identity.publicUserId,
          })),
        };
        await transaction.payrollOperation.create({
          data: {
            operationId: request.operationId,
            tenantId: identity.tenantId,
            periodId: period.id,
            kind: 'APPROVAL',
            requestHash: request.requestHash,
            response: response as Prisma.InputJsonValue,
          },
        });
        await writePayrollAudit(transaction, identity, {
          action: 'PAYROLL_TIME_CARD_DECISIONS_RECORDED',
          resource: 'PayrollPeriod',
          resourceId: period.id,
          newValue: response,
        });
        return response;
      }, TRANSACTION_OPTIONS));
    } catch (error) {
      if (isUniqueConflict(error)) {
        throw payrollProblem(409, 'payroll_decision_conflict', 'A payroll decision already exists for this request or revision.', 'Conflict');
      }
      throw error;
    }
  }

  async lockPeriod(
    identity: SessionIdentity,
    publicPeriodId: string,
    body: PayrollExpectedRevisionRequest,
    idempotencyKeyRaw: string | undefined,
  ) {
    const periodId = await this.resolvePeriodId(identity, publicPeriodId);
    const request = payrollRequestIdentity({
      tenantId: identity.tenantId,
      actorUserId: identity.sub,
      operation: 'LOCK',
      idempotencyKey: normalizeIdempotencyKey(idempotencyKeyRaw),
      body: { periodId, expectedRevision: body.expectedRevision },
    });
    return retryPayrollSerializableMutation(() => this.database.withTenant(identity.tenantId, async (transaction) => {
      await applyPayrollTransactionTimeouts(transaction);
      await lockPayrollTenant(transaction, identity.tenantId);
      await lockPayrollPeriod(transaction, identity.tenantId, periodId);
      const period = await this.requirePeriodById(transaction, identity.tenantId, periodId);
      if (period.status === 'LOCKED') {
        if (period.lockOperationId === request.operationId && period.lockRequestHash === request.requestHash) {
          const [summary, policies] = await Promise.all([
            loadPayrollPeriodSummary(transaction, identity.tenantId, period.id),
            this.publicPolicies(transaction, identity.tenantId, [period.policyVersionId]),
          ]);
          return this.serializePeriod(period, summary, policies, null);
        }
        throw payrollProblem(409, 'idempotency_conflict', PAYROLL_REPLAY_CONFLICT, 'Conflict');
      }
      if (period.status !== 'REVIEW') {
        throw payrollProblem(409, 'payroll_lock_state_invalid', 'Only a payroll period in review can be locked.', 'Conflict');
      }
      if (period.revision !== body.expectedRevision) {
        throw payrollProblem(409, 'payroll_concurrent_change', PAYROLL_CONCURRENT_CHANGE, 'Concurrent change');
      }
      if (period.endsAt.getTime() > Date.now()) {
        throw payrollProblem(422, 'payroll_period_not_ended', 'Payroll period cannot be locked before it ends.', 'Payroll validation failed');
      }
      const cards = validatePayrollCandidateCards(
        await lockPayrollCandidateCards(transaction, identity.tenantId, period),
        period,
      );
      const breaksByCard = await this.lockAndValidateBreaks(transaction, identity.tenantId, cards);
      const cardSources = await this.approvedCardSources(transaction, identity.tenantId, period.id, cards, breaksByCard);
      const amendmentSources = await this.approvedAmendmentSources(transaction, identity.tenantId, period.id);
      if (cardSources.length + amendmentSources.length > MAX_PAYROLL_LOCK_ENTRIES) {
        throw payrollProblem(422, 'payroll_lock_entry_limit', `Payroll period exceeds the ${MAX_PAYROLL_LOCK_ENTRIES}-entry lock limit.`, 'Payroll validation failed');
      }
      let snapshot: ReturnType<typeof materializeLockedSnapshots>;
      try {
        snapshot = materializeLockedSnapshots({
          tenantId: identity.tenantId,
          periodId: period.id,
          sources: [...cardSources, ...amendmentSources],
        });
      } catch {
        throw payrollProblem(422, 'payroll_source_invalid', 'Payroll source data is invalid for locking.', 'Payroll validation failed');
      }
      if (snapshot.entries.length > 0) {
        await transaction.payrollLockedEntry.createMany({
          data: snapshot.entries.map((entry) => ({
            tenantId: identity.tenantId,
            periodId: period.id,
            sequence: entry.sequence,
            sourceType: entry.sourceType,
            sourceId: entry.sourceId,
            sourceRevision: entry.sourceRevision,
            employeeId: entry.employeeId,
            locationId: entry.locationId,
            workTimeZone: entry.workTimeZone,
            clockInAt: new Date(entry.clockInAt),
            clockOutAt: new Date(entry.clockOutAt),
            breakMinutes: entry.breakMinutes,
            payableMinutes: entry.payableMinutes,
            approvedAt: new Date(entry.approvedAt),
            approvedByUserId: entry.approvedByUserId,
            canonicalSha256: entry.canonicalSha256,
          })),
        });
      }
      const changed = await transaction.payrollPeriod.updateMany({
        where: { id: period.id, tenantId: identity.tenantId, status: 'REVIEW', revision: body.expectedRevision },
        data: {
          status: 'LOCKED',
          revision: { increment: 1 },
          lockedAt: new Date(),
          lockedByUserId: identity.sub,
          lockOperationId: request.operationId,
          lockRequestHash: request.requestHash,
          lockedEntrySha256: snapshot.aggregateSha256,
          lockedEntryCount: snapshot.entries.length,
          totalPayableMinutes: snapshot.totalPayableMinutes,
        },
      });
      if (changed.count !== 1) {
        throw payrollProblem(409, 'payroll_concurrent_change', PAYROLL_CONCURRENT_CHANGE, 'Concurrent change');
      }
      const updated = await this.requirePeriodById(transaction, identity.tenantId, period.id);
      const [summary, policies] = await Promise.all([
        loadPayrollPeriodSummary(transaction, identity.tenantId, updated.id),
        this.publicPolicies(transaction, identity.tenantId, [updated.policyVersionId]),
      ]);
      const response = this.serializePeriod(updated, summary, policies, null);
      await writePayrollAudit(transaction, identity, {
        action: 'PAYROLL_PERIOD_LOCKED',
        resource: 'PayrollPeriod',
        resourceId: period.id,
        oldValue: this.serializePeriod(period, this.emptySummary(), policies, null),
        newValue: response,
      });
      return response;
    }, TRANSACTION_OPTIONS));
  }

  async createAmendment(
    identity: SessionIdentity,
    publicEntryId: string,
    body: PayrollAmendmentRequest,
    idempotencyKeyRaw: string | undefined,
  ) {
    const entryId = await this.resolveLockedEntryId(identity, publicEntryId);
    const adjustmentPeriodId = await this.resolvePeriodId(identity, body.adjustmentPeriodId);
    const replacementClockInAt = parseInstant(body.replacementClockInAt, 'replacement_clock_in');
    const replacementClockOutAt = parseInstant(body.replacementClockOutAt, 'replacement_clock_out');
    let replacementPayableMinutes: number;
    try {
      replacementPayableMinutes = payrollWorkedMinutes({
        clockInAt: replacementClockInAt,
        clockOutAt: replacementClockOutAt,
        breakMinutes: body.replacementBreakMinutes,
      });
    } catch {
      throw payrollProblem(422, 'invalid_payroll_amendment_time', 'Replacement payroll times and breaks are invalid.', 'Payroll validation failed');
    }
    const request = payrollRequestIdentity({
      tenantId: identity.tenantId,
      actorUserId: identity.sub,
      operation: 'AMENDMENT_CREATE',
      idempotencyKey: normalizeIdempotencyKey(idempotencyKeyRaw),
      body: {
        entryId,
        adjustmentPeriodId,
        reason: body.reason.trim(),
        replacementClockInAt: replacementClockInAt.toISOString(),
        replacementClockOutAt: replacementClockOutAt.toISOString(),
        replacementBreakMinutes: body.replacementBreakMinutes,
      },
    });
    try {
      return await retryPayrollSerializableMutation(() => this.database.withTenant(identity.tenantId, async (transaction) => {
        await applyPayrollTransactionTimeouts(transaction);
        await lockPayrollTenant(transaction, identity.tenantId);
        const replay = await transaction.payrollAmendment.findUnique({ where: { operationId: request.operationId } });
        if (replay) {
          if (replay.tenantId !== identity.tenantId || replay.requestHash !== request.requestHash) {
            throw payrollProblem(409, 'idempotency_conflict', PAYROLL_REPLAY_CONFLICT, 'Conflict');
          }
          return this.serializeAmendment(transaction, identity.tenantId, replay);
        }
        const [entry, adjustmentPeriod] = await Promise.all([
          transaction.payrollLockedEntry.findFirst({ where: { id: entryId, tenantId: identity.tenantId } }),
          this.requirePeriodById(transaction, identity.tenantId, adjustmentPeriodId),
        ]);
        if (!entry) throw payrollProblem(404, 'payroll_locked_entry_not_found', 'The requested payroll locked entry was not found in this workspace.', 'Not found');
        if (entry.sourceType !== 'TIME_CARD') {
          throw payrollProblem(422, 'payroll_amendment_source_invalid', 'Only original time-card entries can be amended.', 'Payroll validation failed');
        }
        if (entry.employeeId === identity.sub) {
          throw payrollProblem(409, 'payroll_self_amendment_denied', 'Employees cannot request amendments to their own payroll entries.', 'Conflict');
        }
        if (adjustmentPeriod.status !== 'OPEN') {
          throw payrollProblem(409, 'payroll_adjustment_period_invalid', 'The adjustment payroll period must be open.', 'Conflict');
        }
        const sourcePeriod = await this.requirePeriodById(transaction, identity.tenantId, entry.periodId);
        if (adjustmentPeriod.startsAt < sourcePeriod.endsAt) {
          throw payrollProblem(409, 'payroll_adjustment_period_order_invalid', 'The adjustment payroll period must begin after the source payroll period ends.', 'Conflict');
        }
        const minuteDelta = replacementPayableMinutes - entry.payableMinutes;
        if (!Number.isSafeInteger(minuteDelta)) {
          throw payrollProblem(422, 'payroll_amendment_delta_invalid', 'Amendment minute delta is invalid.', 'Payroll validation failed');
        }
        const created = await transaction.payrollAmendment.create({
          data: {
            tenantId: identity.tenantId,
            lockedEntryId: entry.id,
            adjustmentPeriodId: adjustmentPeriod.id,
            operationId: request.operationId,
            requestHash: request.requestHash,
            requestedByUserId: identity.sub,
            reason: body.reason.trim(),
            replacementClockInAt,
            replacementClockOutAt,
            replacementBreakMinutes: body.replacementBreakMinutes,
            replacementPayableMinutes,
            minuteDelta,
          },
        });
        const response = await this.serializeAmendment(transaction, identity.tenantId, created);
        await writePayrollAudit(transaction, identity, {
          action: 'PAYROLL_AMENDMENT_REQUESTED',
          resource: 'PayrollAmendment',
          resourceId: created.id,
          newValue: response,
        });
        return response;
      }, TRANSACTION_OPTIONS));
    } catch (error) {
      if (isUniqueConflict(error)) {
        throw payrollProblem(409, 'payroll_amendment_conflict', 'A saved payroll amendment does not match this request.', 'Conflict');
      }
      throw error;
    }
  }

  async decideAmendment(
    identity: SessionIdentity,
    publicAmendmentId: string,
    body: PayrollAmendmentDecisionRequest,
    idempotencyKeyRaw: string | undefined,
  ) {
    const amendmentId = await this.resolveAmendmentId(identity, publicAmendmentId);
    const request = payrollRequestIdentity({
      tenantId: identity.tenantId,
      actorUserId: identity.sub,
      operation: 'AMENDMENT_DECISION',
      idempotencyKey: normalizeIdempotencyKey(idempotencyKeyRaw),
      body: { amendmentId, decision: body.decision, reason: body.reason?.trim() || null },
    });
    try {
      return await retryPayrollSerializableMutation(() => this.database.withTenant(identity.tenantId, async (transaction) => {
        await applyPayrollTransactionTimeouts(transaction);
        await lockPayrollTenant(transaction, identity.tenantId);
        const replay = await transaction.payrollAmendmentDecision.findUnique({ where: { operationId: request.operationId } });
        if (replay) {
          if (replay.tenantId !== identity.tenantId || replay.requestHash !== request.requestHash) {
            throw payrollProblem(409, 'idempotency_conflict', PAYROLL_REPLAY_CONFLICT, 'Conflict');
          }
          const amendment = await transaction.payrollAmendment.findFirst({ where: { id: replay.amendmentId, tenantId: identity.tenantId } });
          if (!amendment) throw payrollProblem(503, 'payroll_reference_integrity_failed', 'Saved payroll amendment evidence is unavailable.', 'Service unavailable');
          return {
            amendmentId: amendment.publicId,
            decision: replay.decision,
            reason: replay.reason ?? null,
            decidedByUserId: identity.publicUserId,
            decidedAt: replay.decidedAt.toISOString(),
          };
        }
        const amendment = await transaction.payrollAmendment.findFirst({ where: { id: amendmentId, tenantId: identity.tenantId } });
        if (!amendment) throw payrollProblem(404, 'payroll_amendment_not_found', 'The requested payroll amendment was not found in this workspace.', 'Not found');
        await lockPayrollPeriod(transaction, identity.tenantId, amendment.adjustmentPeriodId);
        const [adjustmentPeriod, source] = await Promise.all([
          this.requirePeriodById(transaction, identity.tenantId, amendment.adjustmentPeriodId),
          transaction.payrollLockedEntry.findFirst({ where: { id: amendment.lockedEntryId, tenantId: identity.tenantId } }),
        ]);
        if (!source) throw payrollProblem(503, 'payroll_reference_integrity_failed', 'Saved payroll amendment source evidence is unavailable.', 'Service unavailable');
        if (adjustmentPeriod.status !== 'REVIEW') {
          throw payrollProblem(409, 'payroll_amendment_decision_state_invalid', 'Amendments can be decided only while their adjustment period is in review.', 'Conflict');
        }
        if (amendment.requestedByUserId === identity.sub || source.employeeId === identity.sub) {
          throw payrollProblem(409, 'payroll_self_amendment_decision_denied', 'Requesters and source employees cannot decide payroll amendments.', 'Conflict');
        }
        const existing = await transaction.payrollAmendmentDecision.findUnique({ where: { amendmentId: amendment.id } });
        if (existing) throw payrollProblem(409, 'payroll_amendment_decision_exists', 'A decision already exists for this payroll amendment.', 'Conflict');
        const created = await transaction.payrollAmendmentDecision.create({
          data: {
            tenantId: identity.tenantId,
            amendmentId: amendment.id,
            decision: body.decision,
            reason: body.reason?.trim() || null,
            operationId: request.operationId,
            requestHash: request.requestHash,
            decidedByUserId: identity.sub,
          },
        });
        const response = {
          amendmentId: amendment.publicId,
          decision: created.decision,
          reason: created.reason ?? null,
          decidedByUserId: identity.publicUserId,
          decidedAt: created.decidedAt.toISOString(),
        };
        await writePayrollAudit(transaction, identity, {
          action: 'PAYROLL_AMENDMENT_DECIDED',
          resource: 'PayrollAmendment',
          resourceId: amendment.id,
          newValue: response,
        });
        return response;
      }, TRANSACTION_OPTIONS));
    } catch (error) {
      if (isUniqueConflict(error)) {
        throw payrollProblem(409, 'payroll_amendment_decision_conflict', 'A payroll amendment decision already exists for this request.', 'Conflict');
      }
      throw error;
    }
  }

  private async resolvePeriodId(identity: SessionIdentity, publicPeriodId: string): Promise<string> {
    const publicId = requiredPublicId(publicPeriodId, 'payroll_period');
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const row = await transaction.payrollPeriod.findFirst({
        where: { tenantId: identity.tenantId, publicId },
        select: { id: true },
      });
      if (!row) throw payrollProblem(404, 'payroll_period_not_found', 'The requested payroll period was not found in this workspace.', 'Not found');
      return row.id;
    });
  }

  private async resolveExportId(identity: SessionIdentity, publicExportId: string): Promise<string> {
    const publicId = requiredPublicId(publicExportId, 'payroll_export');
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const row = await transaction.payrollExportBatch.findFirst({
        where: { tenantId: identity.tenantId, publicId },
        select: { id: true },
      });
      if (!row) throw payrollProblem(404, 'payroll_export_not_found', 'The requested payroll export was not found in this workspace.', 'Not found');
      return row.id;
    });
  }

  private async resolveLockedEntryId(identity: SessionIdentity, publicEntryId: string): Promise<string> {
    const publicId = requiredPublicId(publicEntryId, 'payroll_locked_entry');
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const row = await transaction.payrollLockedEntry.findFirst({
        where: { tenantId: identity.tenantId, publicId },
        select: { id: true },
      });
      if (!row) throw payrollProblem(404, 'payroll_locked_entry_not_found', 'The requested payroll locked entry was not found in this workspace.', 'Not found');
      return row.id;
    });
  }

  private async resolveAmendmentId(identity: SessionIdentity, publicAmendmentId: string): Promise<string> {
    const publicId = requiredPublicId(publicAmendmentId, 'payroll_amendment');
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const row = await transaction.payrollAmendment.findFirst({
        where: { tenantId: identity.tenantId, publicId },
        select: { id: true },
      });
      if (!row) throw payrollProblem(404, 'payroll_amendment_not_found', 'The requested payroll amendment was not found in this workspace.', 'Not found');
      return row.id;
    });
  }

  private async lockAndValidateBreaks(
    transaction: TenantTransaction,
    tenantId: string,
    cards: PayrollCandidateCard[],
  ): Promise<Map<string, LockedBreak[]>> {
    const byCard = new Map<string, LockedBreak[]>();
    cards.forEach((card) => byCard.set(card.id, []));
    if (cards.length === 0) return byCard;
    const breaks = await transaction.$queryRaw<LockedBreak[]>(Prisma.sql`
      SELECT "id", "timeCardId", "startAt", "endAt"
      FROM "TimeCardBreak"
      WHERE "tenantId" = ${tenantId}
        AND "timeCardId" IN (${Prisma.join(cards.map((card) => card.id))})
      ORDER BY "timeCardId" ASC, "startAt" ASC, "id" ASC
      FOR UPDATE
    `);
    const cardById = new Map(cards.map((card) => [card.id, card]));
    for (const interval of breaks) byCard.get(interval.timeCardId)?.push(interval);
    for (const [cardId, intervals] of byCard) {
      const card = cardById.get(cardId);
      if (!card) throw payrollProblem(503, 'payroll_reference_integrity_failed', 'Saved payroll time-card evidence is unavailable.', 'Service unavailable');
      let previousEnd = card.clockInAt;
      let total = 0;
      for (const interval of intervals) {
        if (
          interval.startAt < card.clockInAt
          || !card.clockOutAt
          || interval.endAt > card.clockOutAt
          || interval.endAt <= interval.startAt
          || interval.startAt < previousEnd
        ) {
          throw payrollProblem(422, 'payroll_break_evidence_invalid', 'Time-card break evidence is invalid for payroll locking.', 'Payroll validation failed');
        }
        total += Math.floor((interval.endAt.getTime() - interval.startAt.getTime()) / 60_000);
        previousEnd = interval.endAt;
      }
      if (intervals.length > 0 && total !== card.breakMinutes) {
        throw payrollProblem(422, 'payroll_break_minutes_mismatch', 'Time-card breaks do not match aggregate break minutes.', 'Payroll validation failed');
      }
    }
    return byCard;
  }

  private async approvedCardSources(
    transaction: TenantTransaction,
    tenantId: string,
    periodId: string,
    cards: PayrollCandidateCard[],
    breaksByCard: ReadonlyMap<string, LockedBreak[]>,
  ): Promise<LockedEntrySource[]> {
    if (cards.length === 0) return [];
    const approvals = await transaction.payrollTimeCardApproval.findMany({
      where: {
        tenantId,
        periodId,
        OR: cards.map((card) => ({ timeCardId: card.id, timeCardRevision: card.revision })),
      },
      orderBy: [{ timeCardId: 'asc' }],
      take: cards.length,
    });
    const exact = new Map(approvals.map((approval) => [
      `${approval.timeCardId}:${approval.timeCardRevision}`,
      approval,
    ]));
    return cards.map((card) => {
      const approval = exact.get(`${card.id}:${card.revision}`);
      if (!approval || approval.decision !== 'APPROVED' || !card.clockOutAt) {
        throw payrollProblem(422, 'payroll_approval_missing', 'Every current time-card revision must have an approved decision.', 'Payroll validation failed');
      }
      let payableMinutes: number;
      try {
        payableMinutes = payrollWorkedMinutes({
          clockInAt: card.clockInAt,
          clockOutAt: card.clockOutAt,
          breakMinutes: card.breakMinutes,
        });
      } catch {
        throw payrollProblem(422, 'payroll_card_duration_invalid', 'Time-card duration is invalid for payroll locking.', 'Payroll validation failed');
      }
      return {
        sourceType: 'TIME_CARD' as const,
        sourceId: card.id,
        sourceRevision: card.revision,
        employeeId: card.userId,
        locationId: card.locationId,
        workTimeZone: card.workTimeZone,
        clockInAt: card.clockInAt,
        clockOutAt: card.clockOutAt,
        breakMinutes: card.breakMinutes,
        payableMinutes,
        approvedAt: approval.decidedAt,
        approvedByUserId: approval.decidedByUserId,
        breakIntervals: breaksByCard.get(card.id) ?? [],
      };
    });
  }

  private async approvedAmendmentSources(
    transaction: TenantTransaction,
    tenantId: string,
    adjustmentPeriodId: string,
  ): Promise<LockedEntrySource[]> {
    const amendments = await transaction.payrollAmendment.findMany({
      where: { tenantId, adjustmentPeriodId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_PAYROLL_LOCK_ENTRIES + 1,
    });
    if (amendments.length > MAX_PAYROLL_LOCK_ENTRIES) {
      throw payrollProblem(422, 'payroll_amendment_limit_invalid', `Payroll period exceeds the ${MAX_PAYROLL_LOCK_ENTRIES}-amendment lock limit.`, 'Payroll validation failed');
    }
    if (amendments.length === 0) return [];
    const decisions = await transaction.payrollAmendmentDecision.findMany({
      where: { tenantId, amendmentId: { in: amendments.map((amendment) => amendment.id) } },
      orderBy: { amendmentId: 'asc' },
      take: amendments.length,
    });
    const decisionByAmendment = new Map(decisions.map((decision) => [decision.amendmentId, decision]));
    if (amendments.some((amendment) => !decisionByAmendment.has(amendment.id))) {
      throw payrollProblem(422, 'payroll_amendment_pending', 'Pending payroll amendments block payroll locking.', 'Payroll validation failed');
    }
    const approved = amendments.filter((amendment) => decisionByAmendment.get(amendment.id)?.decision === 'APPROVED');
    if (approved.length === 0) return [];
    const originals = await transaction.payrollLockedEntry.findMany({
      where: { tenantId, id: { in: approved.map((amendment) => amendment.lockedEntryId) } },
      orderBy: { id: 'asc' },
      take: approved.length,
    });
    const originalById = new Map(originals.map((entry) => [entry.id, entry]));
    return approved.map((amendment) => {
      const original = originalById.get(amendment.lockedEntryId);
      const decision = decisionByAmendment.get(amendment.id);
      if (!original || !decision) {
        throw payrollProblem(503, 'payroll_reference_integrity_failed', 'Saved payroll amendment evidence is unavailable.', 'Service unavailable');
      }
      return {
        sourceType: 'AMENDMENT' as const,
        sourceId: amendment.id,
        sourceRevision: 1,
        employeeId: original.employeeId,
        locationId: original.locationId,
        workTimeZone: original.workTimeZone,
        clockInAt: amendment.replacementClockInAt,
        clockOutAt: amendment.replacementClockOutAt,
        breakMinutes: amendment.replacementBreakMinutes,
        payableMinutes: amendment.minuteDelta,
        approvedAt: decision.decidedAt,
        approvedByUserId: decision.decidedByUserId,
      };
    });
  }

  private async serializeAmendment(
    transaction: TenantTransaction,
    tenantId: string,
    row: { publicId: string; adjustmentPeriodId: string },
  ) {
    const adjustmentPeriod = await this.requirePeriodById(transaction, tenantId, row.adjustmentPeriodId);
    const amendments = await this.serializedAmendments(transaction, tenantId, adjustmentPeriod.id, adjustmentPeriod.status);
    const amendment = amendments.find((candidate) => candidate.id === row.publicId);
    if (!amendment) {
      throw payrollProblem(503, 'payroll_reference_integrity_failed', 'Saved payroll amendment evidence is unavailable.', 'Service unavailable');
    }
    return amendment;
  }

  private async serializedLockedEntries(transaction: TenantTransaction, tenantId: string, periodId: string) {
    const rows = await transaction.payrollLockedEntry.findMany({
      where: { tenantId, periodId },
      orderBy: [{ sequence: 'asc' }, { publicId: 'asc' }],
      take: 5_001,
    });
    if (rows.length > 5_000) {
      throw payrollProblem(503, 'payroll_entry_limit_invalid', 'Stored payroll entry evidence exceeds the supported limit.', 'Service unavailable');
    }
    const [users, locations, timeCards, amendments] = await Promise.all([
      this.publicUsers(transaction, tenantId, rows.flatMap((row) => [row.employeeId, row.approvedByUserId])),
      this.publicLocations(transaction, tenantId, rows.map((row) => row.locationId)),
      this.publicTimeCards(transaction, tenantId, rows.filter((row) => row.sourceType === 'TIME_CARD').map((row) => row.sourceId)),
      this.publicAmendments(transaction, tenantId, rows.filter((row) => row.sourceType === 'AMENDMENT').map((row) => row.sourceId)),
    ]);
    const employeeNames = rows.length === 0 ? new Map<string, string>() : new Map((await transaction.user.findMany({
      where: { tenantId, id: { in: [...new Set(rows.map((row) => row.employeeId))] } },
      select: { id: true, name: true },
    })).map((user) => [user.id, user.name]));
    return rows.map((row) => ({
      id: row.publicId,
      sequence: row.sequence,
      sourceType: row.sourceType,
      sourceId: row.sourceType === 'TIME_CARD'
        ? this.requireMapped(timeCards, row.sourceId, 'time card')
        : this.requireMapped(amendments, row.sourceId, 'payroll amendment'),
      sourceRevision: row.sourceRevision,
      employeeId: this.requireMapped(users, row.employeeId, 'staff'),
      employeeName: employeeNames.get(row.employeeId) ?? null,
      locationId: row.locationId ? this.requireMapped(locations, row.locationId, 'location') : null,
      workTimeZone: row.workTimeZone,
      clockInAt: row.clockInAt.toISOString(),
      clockOutAt: row.clockOutAt.toISOString(),
      breakMinutes: row.breakMinutes,
      payableMinutes: row.payableMinutes,
      approvedAt: row.approvedAt.toISOString(),
      approvedByUserId: this.requireMapped(users, row.approvedByUserId, 'staff'),
      canonicalSha256: row.canonicalSha256,
    }));
  }

  private async serializedAmendments(
    transaction: TenantTransaction,
    tenantId: string,
    periodId: string,
    status: PayrollRow['status'],
  ) {
    const lockedEntryIds = status === 'LOCKED'
      ? (await transaction.payrollLockedEntry.findMany({
        where: { tenantId, periodId },
        select: { id: true },
        take: 5_001,
      })).map((entry) => entry.id)
      : [];
    const rows = await transaction.payrollAmendment.findMany({
      where: status === 'LOCKED'
        ? { tenantId, OR: [{ adjustmentPeriodId: periodId }, ...(lockedEntryIds.length > 0 ? [{ lockedEntryId: { in: lockedEntryIds } }] : [])] }
        : { tenantId, adjustmentPeriodId: periodId },
      orderBy: [{ createdAt: 'asc' }, { publicId: 'asc' }],
      take: 5_001,
    });
    if (rows.length > 5_000) {
      throw payrollProblem(503, 'payroll_amendment_limit_invalid', 'Stored payroll amendment evidence exceeds the supported limit.', 'Service unavailable');
    }
    const decisions = rows.length === 0 ? [] : await transaction.payrollAmendmentDecision.findMany({
      where: { tenantId, amendmentId: { in: rows.map((row) => row.id) } },
    });
    const sources = rows.length === 0 ? [] : await transaction.payrollLockedEntry.findMany({
      where: { tenantId, id: { in: [...new Set(rows.map((row) => row.lockedEntryId))] } },
      select: { id: true, publicId: true, employeeId: true },
    });
    const [periods, users] = await Promise.all([
      this.publicPeriods(transaction, tenantId, rows.map((row) => row.adjustmentPeriodId)),
      this.publicUsers(transaction, tenantId, [
        ...rows.map((row) => row.requestedByUserId),
        ...decisions.map((decision) => decision.decidedByUserId),
        ...sources.map((source) => source.employeeId),
      ]),
    ]);
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const decisionByAmendment = new Map(decisions.map((decision) => [decision.amendmentId, decision]));
    return rows.map((row) => {
      const decision = decisionByAmendment.get(row.id);
      const source = sourceById.get(row.lockedEntryId);
      return {
        id: row.publicId,
        lockedEntryId: source?.publicId ?? this.missingReference('payroll locked entry'),
        sourceEmployeeId: source ? this.requireMapped(users, source.employeeId, 'staff') : null,
        adjustmentPeriodId: this.requireMapped(periods, row.adjustmentPeriodId, 'payroll period'),
        requestedByUserId: this.requireMapped(users, row.requestedByUserId, 'staff'),
        reason: row.reason,
        replacementClockInAt: row.replacementClockInAt.toISOString(),
        replacementClockOutAt: row.replacementClockOutAt.toISOString(),
        replacementBreakMinutes: row.replacementBreakMinutes,
        replacementPayableMinutes: row.replacementPayableMinutes,
        minuteDelta: row.minuteDelta,
        createdAt: row.createdAt.toISOString(),
        decision: decision ? {
          decision: decision.decision,
          reason: decision.reason ?? null,
          decidedByUserId: this.requireMapped(users, decision.decidedByUserId, 'staff'),
          decidedAt: decision.decidedAt.toISOString(),
        } : null,
      };
    });
  }

  private async serializeExport(
    transaction: TenantTransaction,
    tenantId: string,
    batch: PayrollExportBatch,
    lineLimit: number,
    lineCursor: string | null,
  ) {
    const cursor = lineCursor
      ? await transaction.payrollExportLine.findFirst({
        where: { tenantId, batchId: batch.id, publicId: lineCursor },
        select: { lineNumber: true },
      })
      : null;
    if (lineCursor && !cursor) {
      throw payrollProblem(422, 'invalid_payroll_line_cursor', 'lineCursor is invalid for this payroll export.', 'Payroll validation failed');
    }
    const rows = await transaction.payrollExportLine.findMany({
      where: {
        tenantId,
        batchId: batch.id,
        ...(cursor ? { lineNumber: { gt: cursor.lineNumber } } : {}),
      },
      orderBy: [{ lineNumber: 'asc' }, { publicId: 'asc' }],
      take: lineLimit + 1,
    });
    const page = rows.slice(0, lineLimit);
    const [states, entries, users, periods] = await Promise.all([
      page.length === 0 ? [] : transaction.payrollReconciliationLineState.findMany({
        where: { tenantId, batchId: batch.id, lineId: { in: page.map((line) => line.id) } },
      }),
      this.publicLockedEntries(transaction, tenantId, page.map((line) => line.lockedEntryId)),
      this.publicUsers(transaction, tenantId, page.map((line) => line.employeeId)),
      this.publicPeriods(transaction, tenantId, [batch.periodId]),
    ]);
    const stateByLineId = new Map(states.map((state) => [state.lineId, state]));
    const stateCounts = await transaction.payrollReconciliationLineState.groupBy({
      by: ['status'],
      where: { tenantId, batchId: batch.id },
      _count: { _all: true },
    });
    const countByStatus = new Map(stateCounts.map((state) => [state.status, state._count._all]));
    const acceptedCount = countByStatus.get('ACCEPTED') ?? 0;
    const rejectedCount = countByStatus.get('REJECTED') ?? 0;
    const pendingCount = batch.rowCount - acceptedCount - rejectedCount;
    if (pendingCount < 0) {
      throw payrollProblem(503, 'payroll_reconciliation_integrity_failed', 'Stored payroll reconciliation evidence is invalid.', 'Service unavailable');
    }
    const latestReceipt = await transaction.payrollReconciliationReceipt.findFirst({
      where: { tenantId, batchId: batch.id },
      orderBy: [{ receivedAt: 'desc' }, { publicId: 'desc' }],
    });
    const contentSha256 = (await this.loadAndVerifyExportLines(transaction, tenantId, batch)).publicContentSha256;
    return {
      id: batch.publicId,
      periodId: this.requireMapped(periods, batch.periodId, 'payroll period'),
      formatVersion: batch.formatVersion,
      status: batch.status,
      contentSha256,
      rowCount: batch.rowCount,
      totalPayableMinutes: batch.totalPayableMinutes,
      settlement: { consumedCredits: batch.consumedCredits, newBalance: batch.newBalance },
      createdAt: batch.createdAt.toISOString(),
      downloadedAt: batch.downloadedAt?.toISOString() ?? null,
      reconciledAt: batch.reconciledAt?.toISOString() ?? null,
      updatedAt: batch.updatedAt.toISOString(),
      lines: page.map((line) => {
        const state = stateByLineId.get(line.id);
        return {
          id: line.publicId,
          lineNumber: line.lineNumber,
          lockedEntryId: this.requireMapped(entries, line.lockedEntryId, 'payroll locked entry'),
          employeeId: this.requireMapped(users, line.employeeId, 'staff'),
          payableMinutes: line.payableMinutes,
          canonicalSha256: line.canonicalSha256,
          reconciliationStatus: state?.status ?? 'PENDING',
          reconciliationReason: state?.reason ?? null,
        };
      }),
      nextLineCursor: rows.length > lineLimit && page.length > 0
        ? encodeCursor({ publicId: page[page.length - 1].publicId })
        : null,
      reconciliation: {
        acceptedCount,
        rejectedCount,
        pendingCount,
        providerTotalMinutes: latestReceipt?.providerTotalMinutes ?? null,
        latestProvider: latestReceipt?.provider ?? null,
        latestProviderEventId: latestReceipt?.providerEventId ?? null,
        latestPayloadSha256: latestReceipt?.payloadSha256 ?? null,
      },
    };
  }

  private async findExportReplay(
    identity: SessionIdentity,
    periodId: string,
    request: { operationId: string; requestHash: string },
  ): Promise<unknown | null> {
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const batch = await transaction.payrollExportBatch.findUnique({ where: { operationId: request.operationId } });
      if (!batch) return null;
      if (
        batch.tenantId !== identity.tenantId
        || batch.periodId !== periodId
        || batch.requestHash !== request.requestHash
      ) {
        throw payrollProblem(409, 'idempotency_conflict', PAYROLL_REPLAY_CONFLICT, 'Conflict');
      }
      await this.verifyExportCreditProvenance(transaction, batch);
      return this.serializeExport(transaction, identity.tenantId, batch, 500, null);
    });
  }

  private async verifyExportCreditProvenance(
    transaction: TenantTransaction,
    batch: {
      tenantId: string;
      periodId: string;
      operationId: string;
      creditTransactionId: string;
      consumedCredits: number;
      newBalance: number;
    },
  ): Promise<void> {
    const expectedId = `feature-usage-payroll-export:${batch.operationId}`;
    const ledger = await transaction.creditTransaction.findUnique({
      where: { id: batch.creditTransactionId },
      select: { id: true, tenantId: true, amount: true, debtAmount: true, reason: true, balanceAfter: true, debtAfter: true },
    });
    if (
      batch.creditTransactionId !== expectedId
      || !ledger
      || ledger.id !== expectedId
      || ledger.tenantId !== batch.tenantId
      || ledger.amount !== -batch.consumedCredits
      || ledger.debtAmount !== 0
      || ledger.reason !== `Payroll export (${batch.periodId})`
      || ledger.balanceAfter !== batch.newBalance
      || ledger.debtAfter !== 0
    ) {
      throw payrollProblem(503, 'payroll_export_integrity_failed', 'Payroll evidence failed integrity verification.', 'Service unavailable');
    }
  }

  private async loadAndVerifyExportLines(
    transaction: TenantTransaction,
    tenantId: string,
    batch: { id: string; rowCount: number; totalPayableMinutes: number; contentSha256: string },
  ) {
    if (batch.rowCount < 1 || batch.rowCount > MAX_PAYROLL_LOCK_ENTRIES) {
      throw payrollProblem(503, 'payroll_export_integrity_failed', 'Payroll evidence failed integrity verification.', 'Service unavailable');
    }
    const rows = await transaction.payrollExportLine.findMany({
      where: { tenantId, batchId: batch.id },
      orderBy: [{ lineNumber: 'asc' }, { id: 'asc' }],
      take: MAX_PAYROLL_LOCK_ENTRIES + 1,
    });
    if (rows.length !== batch.rowCount || rows.length > MAX_PAYROLL_LOCK_ENTRIES) {
      throw payrollProblem(503, 'payroll_export_integrity_failed', 'Payroll evidence failed integrity verification.', 'Service unavailable');
    }
    const [users, locations, timeCards, amendments] = await Promise.all([
      this.publicUsers(transaction, tenantId, rows.map((row) => row.employeeId)),
      this.publicLocations(transaction, tenantId, rows.map((row) => row.locationId)),
      this.publicTimeCards(transaction, tenantId, rows.filter((row) => row.sourceType === 'TIME_CARD').map((row) => row.sourceId)),
      this.publicAmendments(transaction, tenantId, rows.filter((row) => row.sourceType === 'AMENDMENT').map((row) => row.sourceId)),
    ]);
    let total = 0;
    let encoding: 'legacy' | 'public' | null = null;
    const lines = rows.map((row) => {
      const publicLine = {
        id: row.publicId,
        lineNumber: row.lineNumber,
        sourceType: row.sourceType,
        sourceId: row.sourceType === 'TIME_CARD'
          ? this.requireMapped(timeCards, row.sourceId, 'time card')
          : this.requireMapped(amendments, row.sourceId, 'payroll amendment'),
        employeeId: this.requireMapped(users, row.employeeId, 'staff'),
        locationId: row.locationId ? this.requireMapped(locations, row.locationId, 'location') : null,
        workTimeZone: row.workTimeZone,
        clockInAt: row.clockInAt,
        clockOutAt: row.clockOutAt,
        breakMinutes: row.breakMinutes,
        payableMinutes: row.payableMinutes,
      };
      const legacyLine = {
        id: row.id,
        lineNumber: row.lineNumber,
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        employeeId: row.employeeId,
        locationId: row.locationId,
        workTimeZone: row.workTimeZone,
        clockInAt: row.clockInAt,
        clockOutAt: row.clockOutAt,
        breakMinutes: row.breakMinutes,
        payableMinutes: row.payableMinutes,
      };
      const publicHash = payrollExportLineSha256({
        tenantId,
        batchId: batch.id,
        lockedEntryId: row.lockedEntryId,
        line: publicLine,
      });
      const legacyHash = payrollExportLineSha256({
        tenantId,
        batchId: batch.id,
        lockedEntryId: row.lockedEntryId,
        line: legacyLine,
      });
      const rowEncoding = row.canonicalSha256 === publicHash
        ? 'public'
        : row.canonicalSha256 === legacyHash
          ? 'legacy'
          : null;
      if (!rowEncoding || (encoding && encoding !== rowEncoding)) {
        throw payrollProblem(503, 'payroll_export_integrity_failed', 'Payroll evidence failed integrity verification.', 'Service unavailable');
      }
      encoding = rowEncoding;
      total += row.payableMinutes;
      return { publicLine, legacyLine };
    });
    if (!Number.isSafeInteger(total) || total !== batch.totalPayableMinutes) {
      throw payrollProblem(503, 'payroll_export_integrity_failed', 'Payroll evidence failed integrity verification.', 'Service unavailable');
    }
    let publicContent: Buffer;
    let legacyContent: Buffer;
    try {
      publicContent = buildPayrollCsv(lines.map((line) => line.publicLine));
      legacyContent = buildPayrollCsv(lines.map((line) => line.legacyLine));
    } catch {
      throw payrollProblem(503, 'payroll_export_integrity_failed', 'Payroll evidence failed integrity verification.', 'Service unavailable');
    }
    const publicContentSha256 = payrollContentSha256(publicContent);
    const legacyContentSha256 = payrollContentSha256(legacyContent);
    if (
      (encoding === 'public' && batch.contentSha256 === publicContentSha256)
      || (encoding === 'legacy' && batch.contentSha256 === legacyContentSha256)
    ) {
      return { publicContent, publicContentSha256 };
    }
    throw payrollProblem(503, 'payroll_export_integrity_failed', 'Payroll evidence failed integrity verification.', 'Service unavailable');
  }

  private async findReceiptReplay(
    identity: SessionIdentity,
    batchId: string,
    provider: string,
    providerEventId: string,
    payloadSha256: string,
  ): Promise<unknown | null> {
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const receipt = await transaction.payrollReconciliationReceipt.findUnique({
        where: {
          tenantId_provider_providerEventId: {
            tenantId: identity.tenantId,
            provider,
            providerEventId,
          },
        },
      });
      if (!receipt) return null;
      if (receipt.batchId !== batchId || receipt.payloadSha256 !== payloadSha256) {
        throw payrollProblem(409, 'idempotency_conflict', PAYROLL_REPLAY_CONFLICT, 'Conflict');
      }
      return this.serializeReceipt(transaction, identity.tenantId, receipt);
    });
  }

  private async internalReconciliationPayload(
    transaction: TenantTransaction,
    tenantId: string,
    batchId: string,
    payload: ReconciliationPayload,
  ): Promise<ReconciliationPayload> {
    const publicLineIds = payload.outcomes.map((outcome) => requiredPublicId(outcome.lineId, 'payroll_export_line'));
    const lines = await transaction.payrollExportLine.findMany({
      where: { tenantId, batchId, publicId: { in: publicLineIds } },
      select: { id: true, publicId: true },
      take: publicLineIds.length,
    });
    if (lines.length !== publicLineIds.length) {
      throw payrollProblem(409, 'payroll_reconciliation_line_invalid', 'Reconciliation outcomes contain an unknown or cross-batch payroll line.', 'Conflict');
    }
    const lineByPublicId = new Map(lines.map((line) => [line.publicId, line.id]));
    return {
      ...payload,
      outcomes: payload.outcomes.map((outcome) => ({
        ...outcome,
        lineId: this.requireMapped(lineByPublicId, outcome.lineId, 'payroll export line'),
      })).sort((left, right) => left.lineId.localeCompare(right.lineId)),
    };
  }

  private async serializeReceipt(
    transaction: TenantTransaction,
    tenantId: string,
    receipt: {
      publicId: string;
      batchId: string;
      provider: string;
      providerEventId: string;
      payloadSha256: string;
      providerTotalMinutes: number;
      acceptedCount: number;
      rejectedCount: number;
      pendingCount: number;
      receivedByUserId: string;
      receivedAt: Date;
    },
  ) {
    const [batch, users] = await Promise.all([
      transaction.payrollExportBatch.findFirst({
        where: { tenantId, id: receipt.batchId },
        select: { publicId: true },
      }),
      this.publicUsers(transaction, tenantId, [receipt.receivedByUserId]),
    ]);
    if (!batch) {
      throw payrollProblem(503, 'payroll_reference_integrity_failed', 'Saved payroll export evidence is unavailable.', 'Service unavailable');
    }
    return {
      id: receipt.publicId,
      batchId: batch.publicId,
      provider: receipt.provider,
      providerEventId: receipt.providerEventId,
      payloadSha256: receipt.payloadSha256,
      providerTotalMinutes: receipt.providerTotalMinutes,
      acceptedCount: receipt.acceptedCount,
      rejectedCount: receipt.rejectedCount,
      pendingCount: receipt.pendingCount,
      receivedByUserId: this.requireMapped(users, receipt.receivedByUserId, 'staff'),
      receivedAt: receipt.receivedAt.toISOString(),
    };
  }

  private async resolveTimeCards(identity: SessionIdentity, publicIds: readonly string[]): Promise<Map<string, string>> {
    const uniqueIds = [...new Set(publicIds.map((publicId) => requiredPublicId(publicId, 'time_card')))];
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const rows = await transaction.timeCard.findMany({
        where: { tenantId: identity.tenantId, publicId: { in: uniqueIds } },
        select: { id: true, publicId: true },
      });
      const map = new Map(rows.map((row) => [row.publicId, row.id]));
      if (uniqueIds.some((publicId) => !map.has(publicId))) {
        throw payrollProblem(404, 'time_card_not_found', 'One or more time cards were not found in this workspace.', 'Not found');
      }
      return map;
    });
  }

  private async requirePeriod(transaction: TenantTransaction, tenantId: string, publicId: string): Promise<PayrollRow> {
    const row = await transaction.payrollPeriod.findFirst({ where: { tenantId, publicId } }) as unknown as PayrollRow | null;
    if (!row) throw payrollProblem(404, 'payroll_period_not_found', 'The requested payroll period was not found in this workspace.', 'Not found');
    return row;
  }

  private async requirePeriodById(transaction: TenantTransaction, tenantId: string, id: string): Promise<PayrollRow> {
    const row = await transaction.payrollPeriod.findFirst({ where: { tenantId, id } }) as unknown as PayrollRow | null;
    if (!row) throw payrollProblem(404, 'payroll_period_not_found', 'The requested payroll period was not found in this workspace.', 'Not found');
    return row;
  }

  private async publicUsers(transaction: TenantTransaction, tenantId: string, ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
    const uniqueIds = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (uniqueIds.length === 0) return new Map();
    const rows = await transaction.user.findMany({
      where: { tenantId, id: { in: uniqueIds } },
      select: { id: true, publicId: true },
    });
    return new Map(rows.map((row) => [row.id, row.publicId]));
  }

  private async publicPolicies(transaction: TenantTransaction, tenantId: string, ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
    const uniqueIds = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (uniqueIds.length === 0) return new Map();
    const rows = await transaction.payrollPolicyVersion.findMany({
      where: { tenantId, id: { in: uniqueIds } },
      select: { id: true, publicId: true },
    });
    return new Map(rows.map((row) => [row.id, row.publicId]));
  }

  private async publicPeriods(transaction: TenantTransaction, tenantId: string, ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
    const uniqueIds = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (uniqueIds.length === 0) return new Map();
    const rows = await transaction.payrollPeriod.findMany({
      where: { tenantId, id: { in: uniqueIds } },
      select: { id: true, publicId: true },
    });
    return new Map(rows.map((row) => [row.id, row.publicId]));
  }

  private async publicLocations(transaction: TenantTransaction, tenantId: string, ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
    const uniqueIds = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (uniqueIds.length === 0) return new Map();
    const rows = await transaction.location.findMany({
      where: { tenantId, id: { in: uniqueIds } },
      select: { id: true, publicId: true },
    });
    return new Map(rows.map((row) => [row.id, row.publicId]));
  }

  private async publicTimeCards(transaction: TenantTransaction, tenantId: string, ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
    const uniqueIds = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (uniqueIds.length === 0) return new Map();
    const rows = await transaction.timeCard.findMany({
      where: { tenantId, id: { in: uniqueIds } },
      select: { id: true, publicId: true },
    });
    return new Map(rows.map((row) => [row.id, row.publicId]));
  }

  private async publicAmendments(transaction: TenantTransaction, tenantId: string, ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
    const uniqueIds = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (uniqueIds.length === 0) return new Map();
    const rows = await transaction.payrollAmendment.findMany({
      where: { tenantId, id: { in: uniqueIds } },
      select: { id: true, publicId: true },
    });
    return new Map(rows.map((row) => [row.id, row.publicId]));
  }

  private async publicLockedEntries(transaction: TenantTransaction, tenantId: string, ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
    const uniqueIds = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (uniqueIds.length === 0) return new Map();
    const rows = await transaction.payrollLockedEntry.findMany({
      where: { tenantId, id: { in: uniqueIds } },
      select: { id: true, publicId: true },
    });
    return new Map(rows.map((row) => [row.id, row.publicId]));
  }

  private serializePolicy(
    row: { publicId: string; version: number; timeZone: string; cadence: 'WEEKLY' | 'BIWEEKLY'; anchorDate: Date; effectiveFrom: Date; createdByUserId: string; createdAt: Date },
    publicUsers: ReadonlyMap<string, string>,
  ) {
    return {
      id: row.publicId,
      version: row.version,
      timeZone: row.timeZone,
      cadence: row.cadence,
      anchorDate: serializeDateOnly(row.anchorDate),
      effectiveFrom: serializeDateOnly(row.effectiveFrom),
      createdByUserId: this.requireMapped(publicUsers, row.createdByUserId, 'staff'),
      createdAt: row.createdAt.toISOString(),
    };
  }

  private serializePeriod(
    row: PayrollRow,
    summary: ReturnType<PayrollService['emptySummary']>,
    publicPolicies: ReadonlyMap<string, string>,
    exportBatch: unknown,
  ) {
    return {
      id: row.publicId,
      policyVersionId: this.requireMapped(publicPolicies, row.policyVersionId, 'payroll policy'),
      localStartDate: serializeDateOnly(row.localStartDate),
      localEndDateExclusive: serializeDateOnly(row.localEndDateExclusive),
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      timeZone: row.timeZone,
      cadence: row.cadence,
      status: row.status,
      revision: row.revision,
      reviewStartedAt: row.reviewStartedAt?.toISOString() ?? null,
      lockedAt: row.lockedAt?.toISOString() ?? null,
      lockedEntrySha256: row.lockedEntrySha256 ?? null,
      lockedEntryCount: row.lockedEntryCount ?? null,
      totalPayableMinutes: row.totalPayableMinutes ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      summary,
      exportBatch,
    };
  }

  private replayOperation(row: { tenantId: string; requestHash: string; response: Prisma.JsonValue }, requestHash: string): unknown {
    if (!sameHash(row.requestHash, requestHash)) {
      throw payrollProblem(409, 'idempotency_conflict', PAYROLL_REPLAY_CONFLICT, 'Conflict');
    }
    if (!row.response || typeof row.response !== 'object' || Array.isArray(row.response)) {
      throw payrollProblem(503, 'payroll_replay_unavailable', 'Saved payroll replay evidence is invalid.', 'Service unavailable');
    }
    return row.response;
  }

  private requireMapped(values: ReadonlyMap<string, string>, id: string, resource: string): string {
    const value = values.get(id);
    if (!value) {
      throw payrollProblem(503, 'payroll_reference_integrity_failed', `Saved ${resource} reference is unavailable.`, 'Service unavailable');
    }
    return value;
  }

  private missingReference(resource: string): never {
    throw payrollProblem(503, 'payroll_reference_integrity_failed', `Saved ${resource} reference is unavailable.`, 'Service unavailable');
  }

  private emptySummary() {
    return {
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
}
