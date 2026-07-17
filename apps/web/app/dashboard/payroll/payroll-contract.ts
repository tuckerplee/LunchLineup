import type {
  PayrollCard,
  PayrollExportBatch,
  PayrollExportLine,
  PayrollPeriodSummary,
  PayrollPolicyInput,
  PayrollPolicyVersion,
  PayrollReconciliationInput,
} from './payroll-types';

export const PAYROLL_CARD_PAGE_SIZE = 250;
export const PAYROLL_EXPORT_LINE_PAGE_SIZE = 500;
export const PAYROLL_PERIOD_PAGE_SIZE = 25;
export const PAYROLL_POLICY_PAGE_SIZE = 25;
export const MAX_PAYROLL_BULK_ROWS = 100;
export const MAX_RECONCILIATION_LINES = 500;

export type PayrollPolicyErrors = Partial<Record<keyof PayrollPolicyInput, string>>;
export type PayrollRecoveryKind = 'stale' | 'ambiguous' | 'definitive';

export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function isIanaTimeZone(value: string): boolean {
  const candidate = value.trim();
  if (!candidate || candidate.length > 100 || /^[+-]/.test(candidate)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function validatePayrollPolicy(
  input: PayrollPolicyInput,
  today: string,
  latestPolicy: PayrollPolicyVersion | null = null,
): PayrollPolicyErrors {
  const errors: PayrollPolicyErrors = {};
  if (!isIanaTimeZone(input.timeZone)) errors.timeZone = 'Enter a valid IANA time zone, such as America/Los_Angeles.';
  else if (latestPolicy && input.timeZone !== latestPolicy.timeZone) errors.timeZone = 'Payroll timezone is fixed after version 1.';
  if (input.cadence !== 'WEEKLY' && input.cadence !== 'BIWEEKLY') errors.cadence = 'Choose weekly or biweekly.';
  if (!isCalendarDate(input.anchorDate)) errors.anchorDate = 'Choose a valid calendar anchor date.';
  if (!isCalendarDate(input.effectiveFrom)) {
    errors.effectiveFrom = 'Choose a valid effective date.';
  } else if (latestPolicy && (input.effectiveFrom <= today || input.effectiveFrom <= latestPolicy.effectiveFrom)) {
    errors.effectiveFrom = 'Choose a future effective date after the latest policy boundary.';
  } else if (isCalendarDate(input.anchorDate) && (
    !isCadenceAligned(input.anchorDate, input.effectiveFrom, input.cadence)
    || Boolean(latestPolicy && !isCadenceAligned(latestPolicy.anchorDate, input.effectiveFrom, latestPolicy.cadence))
  )) {
    errors.effectiveFrom = latestPolicy
      ? 'Effective date must align with both the prior and new cadence anchors.'
      : 'Effective date must align with the anchor and cadence.';
  }
  return errors;
}

export function isCadenceAligned(anchorDate: string, effectiveFrom: string, cadence: PayrollPolicyInput['cadence']): boolean {
  if (!isCalendarDate(anchorDate) || !isCalendarDate(effectiveFrom)) return false;
  const dayNumber = (value: string) => {
    const [year, month, day] = value.split('-').map(Number);
    return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
  };
  const cadenceDays = cadence === 'WEEKLY' ? 7 : 14;
  return ((dayNumber(effectiveFrom) - dayNumber(anchorDate)) % cadenceDays + cadenceDays) % cadenceDays === 0;
}

export function payrollReadiness(period: PayrollPeriodSummary): {
  canStartReview: boolean;
  canLock: boolean;
  remainingExactDecisions: number;
} {
  const summary = period.summary;
  const remainingExactDecisions = Math.max(0, summary.closedCardCount - summary.approvedCardCount);
  return {
    canStartReview: period.status === 'OPEN'
      && summary.closedCardCount === summary.cardCount,
    canLock: period.status === 'REVIEW'
      && summary.closedCardCount === summary.cardCount
      && summary.approvedCardCount === summary.cardCount
      && summary.rejectedCardCount === 0
      && summary.pendingCardCount === 0
      && summary.pendingAmendmentCount === 0,
    remainingExactDecisions,
  };
}

export function hasExportablePayrollEntries(period: PayrollPeriodSummary): boolean {
  const lockedEntryCount = period.lockedEntryCount ?? period.summary.lockedEntryCount;
  return period.status === 'LOCKED'
    && Number.isSafeInteger(lockedEntryCount)
    && lockedEntryCount > 0;
}

export function canCreatePayrollAmendmentForEntry(
  hasCreatePermission: boolean,
  currentUserId: string,
  sourceEmployeeId: string,
): boolean {
  return hasCreatePermission && Boolean(sourceEmployeeId) && sourceEmployeeId !== currentUserId;
}

export function payrollAmendmentDecisionBlocker(input: {
  hasDecisionPermission: boolean;
  currentUserId: string;
  requestedByUserId: string;
  sourceEmployeeId?: string | null;
  adjustmentInReview: boolean;
}): string | null {
  if (!input.hasDecisionPermission) return 'Approval permission required to decide.';
  if (input.requestedByUserId === input.currentUserId || input.sourceEmployeeId === input.currentUserId) {
    return 'The requester and source employee cannot decide this amendment.';
  }
  if (!input.sourceEmployeeId) return 'Load source employee evidence before deciding.';
  if (!input.adjustmentInReview) return 'Decision is available when the adjustment period is in review.';
  return null;
}

export function appendPayrollCards(current: PayrollCard[], incoming: PayrollCard[]): PayrollCard[] {
  const byId = new Map(current.map((card) => [card.id, card]));
  for (const card of incoming) byId.set(card.id, card);
  return [...byId.values()];
}

export function appendPayrollExportLines(current: PayrollExportLine[], incoming: PayrollExportLine[]): PayrollExportLine[] {
  const byId = new Map(current.map((line) => [line.id, line]));
  for (const line of incoming) byId.set(line.id, line);
  return [...byId.values()].sort((left, right) => left.lineNumber - right.lineNumber || left.id.localeCompare(right.id));
}

export function buildExpectedRevisions(cards: PayrollCard[], cardIds: readonly string[]): Record<string, number> {
  if (cardIds.length < 1 || cardIds.length > MAX_PAYROLL_BULK_ROWS) {
    throw new Error(`Select between 1 and ${MAX_PAYROLL_BULK_ROWS} loaded rows.`);
  }
  const cardsById = new Map(cards.map((card) => [card.id, card]));
  return Object.fromEntries(cardIds.map((cardId) => {
    const card = cardsById.get(cardId);
    if (!card || !Number.isSafeInteger(card.timeCardRevision)) throw new Error('A selected row is no longer loaded. Refresh the period.');
    return [cardId, card.timeCardRevision];
  }));
}

export function classifyPayrollMutationError(status: number | null): PayrollRecoveryKind {
  if (status === 409 || status === 412) return 'stale';
  if (status === null || status >= 500) return 'ambiguous';
  return 'definitive';
}

export function parsePayrollExportCreditCost(payload: unknown): number {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('The payroll export credit cost is unavailable.');
  }
  const source = payload as Record<string, unknown>;
  const hasEligibility = typeof source.eligible === 'boolean' || typeof source.enabled === 'boolean';
  const eligible = typeof source.eligible === 'boolean' ? source.eligible : source.enabled === true;
  if (!eligible) {
    const reason = typeof source.reason === 'string' ? source.reason.trim() : '';
    if (!hasEligibility) throw new Error('The payroll export credit cost is unavailable.');
    throw new Error(reason && reason.length <= 500 && !/[\u0000-\u001F\u007F]/.test(reason)
      ? reason
      : 'Payroll export is not currently eligible.');
  }
  const cost = source.creditCost;
  if (!Number.isSafeInteger(cost) || Number(cost) <= 0) throw new Error('The payroll export credit cost is unavailable.');
  return Number(cost);
}

export function reconciliationEditableLines(batch: PayrollExportBatch): PayrollExportLine[] {
  const loaded = batch.lines.slice(0, MAX_RECONCILIATION_LINES);
  const unresolved = loaded.filter((line) => line.reconciliationStatus !== 'ACCEPTED');
  return unresolved.length > 0 ? unresolved : loaded;
}

export function validateReconciliation(input: PayrollReconciliationInput): string | null {
  if (!input.provider.trim() || input.provider.length > 100) return 'Provider is required and must be 100 characters or fewer.';
  if (!input.providerEventId.trim() || input.providerEventId.length > 200) return 'Provider event ID is required and must be 200 characters or fewer.';
  if (!Number.isSafeInteger(input.providerTotalMinutes)) return 'Provider total must be a signed whole minute count.';
  if (input.lines.length < 1 || input.lines.length > MAX_RECONCILIATION_LINES) return `Submit between 1 and ${MAX_RECONCILIATION_LINES} explicit line outcomes.`;
  if (new Set(input.lines.map((line) => line.lineId)).size !== input.lines.length) return 'Line outcomes must not contain duplicates.';
  for (const line of input.lines) {
    if (!line.lineId || !['PENDING', 'ACCEPTED', 'REJECTED'].includes(line.status)) return 'Every reconciliation line needs an explicit outcome.';
    if (line.status === 'REJECTED' && !line.reason?.trim()) return 'Rejected lines require a reason.';
    if ((line.reason?.length ?? 0) > 500) return 'Line reasons must be 500 characters or fewer.';
  }
  return null;
}

export function isBatchFullyReconciled(batch: PayrollExportBatch): boolean {
  const summary = batch.reconciliation;
  return batch.status === 'RECONCILED'
    && summary.acceptedCount === batch.rowCount
    && summary.rejectedCount === 0
    && summary.pendingCount === 0
    && summary.providerTotalMinutes === batch.totalPayableMinutes;
}

export function payrollStatusExplanation(period: PayrollPeriodSummary): string {
  if (period.status === 'OPEN') return 'Open for bounded adoption and preparation. Original time cards remain operational records.';
  if (period.status === 'REVIEW') return 'In review for version-bound decisions. Readiness uses server aggregates, not loaded rows.';
  return 'Terminal locked snapshot. Original entries are immutable; corrections use future-period amendments.';
}

export function formatSignedMinutes(minutes: number): string {
  const sign = minutes > 0 ? '+' : minutes < 0 ? '-' : '';
  return `${sign}${formatWorkedMinutes(Math.abs(minutes))}`;
}

export function formatWorkedMinutes(totalMinutes: number): string {
  const safeMinutes = Math.max(0, Math.round(totalMinutes));
  return `${Math.floor(safeMinutes / 60)}h ${(safeMinutes % 60).toString().padStart(2, '0')}m`;
}
