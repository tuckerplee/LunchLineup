export type PayrollCadence = 'WEEKLY' | 'BIWEEKLY';
export type PayrollPeriodStatus = 'OPEN' | 'REVIEW' | 'LOCKED';
export type PayrollDecision = 'APPROVED' | 'REJECTED';
export type PayrollExportStatus = 'GENERATED' | 'DOWNLOADED' | 'RECONCILING' | 'RECONCILED';
export type PayrollLineStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED';

export type PayrollPolicyVersion = {
  id: string;
  version: number;
  timeZone: string;
  cadence: PayrollCadence;
  anchorDate: string;
  effectiveFrom: string;
  createdByUserId: string;
  createdAt: string;
};

export type PayrollPolicyInput = Pick<PayrollPolicyVersion, 'timeZone' | 'cadence' | 'anchorDate' | 'effectiveFrom'>;

export type PayrollReadiness = {
  cardCount: number;
  closedCardCount: number;
  approvedCardCount: number;
  rejectedCardCount: number;
  pendingCardCount: number;
  amendmentCount: number;
  pendingAmendmentCount: number;
  approvedAmendmentCount: number;
  lockedEntryCount: number;
};

export type PayrollDecisionRecord = {
  decision: PayrollDecision;
  timeCardRevision: number;
  reason?: string | null;
  decidedAt: string;
  decidedByUserId: string;
};

export type PayrollCard = {
  id: string;
  timeCardRevision: number;
  user: { id: string; name: string; username: string };
  locationId?: string | null;
  clockInAt: string;
  clockOutAt: string;
  breakMinutes: number;
  payableMinutes: number;
  updatedAt: string;
  displayTimeZone: string;
  included: boolean;
  adoptionEligible: boolean;
  decision?: PayrollDecisionRecord | null;
  decisionIsCurrent: boolean;
};

export type PayrollLockedEntry = {
  id: string;
  sequence: number;
  sourceType: 'TIME_CARD' | 'AMENDMENT';
  sourceId: string;
  sourceRevision: number;
  employeeId: string;
  employeeName?: string | null;
  locationId?: string | null;
  workTimeZone: string;
  clockInAt: string;
  clockOutAt: string;
  breakMinutes: number;
  payableMinutes: number;
  approvedAt: string;
  approvedByUserId: string;
  canonicalSha256: string;
};

export type PayrollAmendment = {
  id: string;
  lockedEntryId: string;
  sourceEmployeeId?: string | null;
  adjustmentPeriodId: string;
  requestedByUserId: string;
  reason: string;
  replacementClockInAt: string;
  replacementClockOutAt: string;
  replacementBreakMinutes: number;
  replacementPayableMinutes: number;
  minuteDelta: number;
  createdAt: string;
  decision?: {
    decision: PayrollDecision;
    reason?: string | null;
    decidedByUserId: string;
    decidedAt: string;
  } | null;
};

export type PayrollExportLine = {
  id: string;
  lineNumber: number;
  lockedEntryId: string;
  employeeId: string;
  payableMinutes: number;
  canonicalSha256: string;
  reconciliationStatus: PayrollLineStatus;
  reconciliationReason?: string | null;
};

export type PayrollReconciliationSummary = {
  acceptedCount: number;
  rejectedCount: number;
  pendingCount: number;
  providerTotalMinutes?: number | null;
  latestProvider?: string | null;
  latestProviderEventId?: string | null;
};

export type PayrollExportBatch = {
  id: string;
  periodId: string;
  formatVersion: number;
  status: PayrollExportStatus;
  contentSha256: string;
  rowCount: number;
  totalPayableMinutes: number;
  settlement: { consumedCredits: number; newBalance: number };
  createdAt: string;
  downloadedAt?: string | null;
  reconciledAt?: string | null;
  lines: PayrollExportLine[];
  nextLineCursor: string | null;
  reconciliation: PayrollReconciliationSummary;
};

export type PayrollPeriodSummary = {
  id: string;
  policyVersionId: string;
  localStartDate: string;
  localEndDateExclusive: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  cadence: PayrollCadence;
  status: PayrollPeriodStatus;
  revision: number;
  summary: PayrollReadiness;
  reviewStartedAt?: string | null;
  lockedAt?: string | null;
  lockedEntrySha256?: string | null;
  lockedEntryCount?: number | null;
  totalPayableMinutes?: number | null;
  exportBatch?: PayrollExportBatch | null;
};

export type PayrollPeriodDetail = {
  period: PayrollPeriodSummary;
  cards: PayrollCard[];
  nextCardCursor: string | null;
  lockedEntries: PayrollLockedEntry[];
  amendments: PayrollAmendment[];
};

export type PayrollPeriodsPage = { data: PayrollPeriodSummary[]; nextCursor: string | null };
export type PayrollPoliciesPage = { data: PayrollPolicyVersion[]; nextCursor: string | null };

export type PayrollReconciliationLineInput = {
  lineId: string;
  status: PayrollLineStatus;
  reason?: string;
};

export type PayrollReconciliationInput = {
  provider: string;
  providerEventId: string;
  providerTotalMinutes: number;
  lines: PayrollReconciliationLineInput[];
};
