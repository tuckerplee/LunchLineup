import type {
  PayrollAmendment,
  PayrollCard,
  PayrollExportBatch,
  PayrollExportLine,
  PayrollLockedEntry,
  PayrollPeriodDetail,
  PayrollPeriodSummary,
  PayrollPolicyVersion,
  PayrollReadiness,
} from './payroll-types';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function integer(value: unknown, fallback = 0): number {
  return Number.isSafeInteger(value) ? Number(value) : fallback;
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export function normalizePayrollPolicy(value: unknown): PayrollPolicyVersion {
  const source = record(value);
  return {
    id: text(source.id), version: integer(source.version), timeZone: text(source.timeZone),
    cadence: source.cadence === 'WEEKLY' ? 'WEEKLY' : 'BIWEEKLY', anchorDate: text(source.anchorDate),
    effectiveFrom: text(source.effectiveFrom), createdByUserId: text(source.createdByUserId), createdAt: text(source.createdAt),
  };
}

export function normalizePayrollPolicyEnvelope(value: unknown): PayrollPolicyVersion | null {
  const source = record(value);
  const candidate = source.data ?? source.policy ?? value;
  return candidate === null || candidate === undefined ? null : normalizePayrollPolicy(candidate);
}

export function normalizePayrollReadiness(value: unknown): PayrollReadiness {
  const source = record(value);
  return {
    cardCount: integer(source.cardCount), closedCardCount: integer(source.closedCardCount),
    approvedCardCount: integer(source.approvedCardCount), rejectedCardCount: integer(source.rejectedCardCount),
    pendingCardCount: integer(source.pendingCardCount), amendmentCount: integer(source.amendmentCount),
    pendingAmendmentCount: integer(source.pendingAmendmentCount), approvedAmendmentCount: integer(source.approvedAmendmentCount),
    lockedEntryCount: integer(source.lockedEntryCount),
  };
}

export function normalizePayrollPeriod(value: unknown): PayrollPeriodSummary {
  const root = record(value);
  const source = Object.keys(record(root.period)).length > 0 ? record(root.period) : root;
  const batchValue = source.exportBatch ?? root.exportBatch;
  return {
    id: text(source.id), policyVersionId: text(source.policyVersionId), localStartDate: text(source.localStartDate),
    localEndDateExclusive: text(source.localEndDateExclusive), startsAt: text(source.startsAt), endsAt: text(source.endsAt),
    timeZone: text(source.timeZone), cadence: source.cadence === 'WEEKLY' ? 'WEEKLY' : 'BIWEEKLY',
    status: source.status === 'REVIEW' ? 'REVIEW' : source.status === 'LOCKED' ? 'LOCKED' : 'OPEN',
    revision: integer(source.revision), summary: normalizePayrollReadiness(source.summary ?? root.summary),
    reviewStartedAt: nullableText(source.reviewStartedAt), lockedAt: nullableText(source.lockedAt),
    lockedEntrySha256: nullableText(source.lockedEntrySha256),
    lockedEntryCount: source.lockedEntryCount === null ? null : integer(source.lockedEntryCount),
    totalPayableMinutes: source.totalPayableMinutes === null ? null : integer(source.totalPayableMinutes),
    exportBatch: batchValue ? normalizePayrollExport(batchValue) : null,
  };
}

export function normalizePayrollCard(value: unknown): PayrollCard {
  const source = record(value);
  const user = record(source.user);
  const decision = record(source.decision);
  const clockInAt = text(source.clockInAt);
  const clockOutAt = text(source.clockOutAt);
  const breakMinutes = integer(source.breakMinutes);
  const gross = clockInAt && clockOutAt ? Math.floor((new Date(clockOutAt).getTime() - new Date(clockInAt).getTime()) / 60_000) : 0;
  return {
    id: text(source.id), timeCardRevision: integer(source.timeCardRevision ?? source.revision),
    user: { id: text(user.id ?? source.userId), name: text(user.name, text(source.userId)), username: text(user.username, text(source.userId)) },
    locationId: nullableText(source.locationId), clockInAt, clockOutAt, breakMinutes,
    payableMinutes: integer(source.payableMinutes, Math.max(0, gross - breakMinutes)), updatedAt: text(source.updatedAt),
    displayTimeZone: text(source.displayTimeZone ?? source.workTimeZone, 'Etc/UTC'),
    included: typeof source.included === 'boolean' ? source.included : true,
    adoptionEligible: source.adoptionEligible === true,
    decision: Object.keys(decision).length > 0 ? {
      decision: decision.decision === 'REJECTED' ? 'REJECTED' : 'APPROVED',
      timeCardRevision: integer(decision.timeCardRevision), reason: nullableText(decision.reason),
      decidedAt: text(decision.decidedAt), decidedByUserId: text(decision.decidedByUserId),
    } : null,
    decisionIsCurrent: Object.keys(decision).length > 0
      && integer(decision.timeCardRevision) === integer(source.timeCardRevision ?? source.revision),
  };
}

export function normalizePayrollLockedEntry(value: unknown): PayrollLockedEntry {
  const source = record(value);
  return {
    id: text(source.id), sequence: integer(source.sequence), sourceType: source.sourceType === 'AMENDMENT' ? 'AMENDMENT' : 'TIME_CARD',
    sourceId: text(source.sourceId), sourceRevision: integer(source.sourceRevision), employeeId: text(source.employeeId),
    employeeName: nullableText(source.employeeName), locationId: nullableText(source.locationId), workTimeZone: text(source.workTimeZone),
    clockInAt: text(source.clockInAt), clockOutAt: text(source.clockOutAt), breakMinutes: integer(source.breakMinutes),
    payableMinutes: integer(source.payableMinutes), approvedAt: text(source.approvedAt), approvedByUserId: text(source.approvedByUserId),
    canonicalSha256: text(source.canonicalSha256),
  };
}

export function normalizePayrollAmendment(value: unknown): PayrollAmendment {
  const source = record(value);
  const decision = record(source.decision);
  const lockedEntry = record(source.lockedEntry);
  return {
    id: text(source.id), lockedEntryId: text(source.lockedEntryId), adjustmentPeriodId: text(source.adjustmentPeriodId),
    sourceEmployeeId: nullableText(source.sourceEmployeeId ?? lockedEntry.employeeId),
    requestedByUserId: text(source.requestedByUserId), reason: text(source.reason), replacementClockInAt: text(source.replacementClockInAt),
    replacementClockOutAt: text(source.replacementClockOutAt), replacementBreakMinutes: integer(source.replacementBreakMinutes),
    replacementPayableMinutes: integer(source.replacementPayableMinutes), minuteDelta: integer(source.minuteDelta), createdAt: text(source.createdAt),
    decision: Object.keys(decision).length > 0 ? {
      decision: decision.decision === 'REJECTED' ? 'REJECTED' : 'APPROVED', reason: nullableText(decision.reason),
      decidedByUserId: text(decision.decidedByUserId), decidedAt: text(decision.decidedAt),
    } : null,
  };
}

function normalizePayrollExportLine(value: unknown): PayrollExportLine {
  const source = record(value);
  return {
    id: text(source.id), lineNumber: integer(source.lineNumber), lockedEntryId: text(source.lockedEntryId), employeeId: text(source.employeeId),
    payableMinutes: integer(source.payableMinutes), canonicalSha256: text(source.canonicalSha256),
    reconciliationStatus: source.reconciliationStatus === 'ACCEPTED' ? 'ACCEPTED' : source.reconciliationStatus === 'REJECTED' ? 'REJECTED' : 'PENDING',
    reconciliationReason: nullableText(source.reconciliationReason),
  };
}

export function normalizePayrollExport(value: unknown): PayrollExportBatch {
  const root = record(value);
  const source = Object.keys(record(root.exportBatch)).length > 0 ? record(root.exportBatch) : root;
  const settlement = record(source.settlement);
  const lines = Array.isArray(source.lines) ? source.lines.map(normalizePayrollExportLine) : [];
  const reconciliation = record(source.reconciliation);
  return {
    id: text(source.id), periodId: text(source.periodId), formatVersion: integer(source.formatVersion, 1),
    status: source.status === 'DOWNLOADED' ? 'DOWNLOADED' : source.status === 'RECONCILING' ? 'RECONCILING' : source.status === 'RECONCILED' ? 'RECONCILED' : 'GENERATED',
    contentSha256: text(source.contentSha256), rowCount: integer(source.rowCount), totalPayableMinutes: integer(source.totalPayableMinutes),
    settlement: { consumedCredits: integer(settlement.consumedCredits), newBalance: integer(settlement.newBalance) },
    createdAt: text(source.createdAt), downloadedAt: nullableText(source.downloadedAt), reconciledAt: nullableText(source.reconciledAt), lines,
    nextLineCursor: nullableText(source.nextLineCursor),
    reconciliation: {
      acceptedCount: integer(reconciliation.acceptedCount), rejectedCount: integer(reconciliation.rejectedCount),
      pendingCount: integer(reconciliation.pendingCount, lines.filter((line) => line.reconciliationStatus === 'PENDING').length),
      providerTotalMinutes: reconciliation.providerTotalMinutes === null ? null : integer(reconciliation.providerTotalMinutes),
      latestProvider: nullableText(reconciliation.latestProvider), latestProviderEventId: nullableText(reconciliation.latestProviderEventId),
    },
  };
}

export function normalizePayrollPeriodDetail(value: unknown): PayrollPeriodDetail {
  const root = record(value);
  const cardsContainer = root.cards;
  const cardsRecord = record(cardsContainer);
  const cardValues = Array.isArray(cardsContainer) ? cardsContainer : Array.isArray(cardsRecord.data) ? cardsRecord.data : [];
  const lockedValues = Array.isArray(root.lockedEntries) ? root.lockedEntries : Array.isArray(record(root.lockedEntries).data) ? record(root.lockedEntries).data as unknown[] : [];
  const amendmentValues = Array.isArray(root.amendments) ? root.amendments : Array.isArray(record(root.amendments).data) ? record(root.amendments).data as unknown[] : [];
  return {
    period: normalizePayrollPeriod(value), cards: cardValues.map(normalizePayrollCard),
    nextCardCursor: nullableText(root.nextCardCursor ?? cardsRecord.nextCursor),
    lockedEntries: lockedValues.map(normalizePayrollLockedEntry), amendments: amendmentValues.map(normalizePayrollAmendment),
  };
}
