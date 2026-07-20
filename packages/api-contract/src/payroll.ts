import { Static, Type } from '@sinclair/typebox';
import { InstantSchema, ProblemDetailsSchema, UuidSchema } from './scheduling';

const CursorSchema = Type.String({ minLength: 1, maxLength: 512 });
const LimitSchema = Type.String({ minLength: 1, maxLength: 3, pattern: '^[0-9]+$' });
const DateOnlySchema = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
const ReasonSchema = Type.String({ minLength: 5, maxLength: 500 });

export const PayrollCadenceSchema = Type.Union([
  Type.Literal('WEEKLY'),
  Type.Literal('BIWEEKLY'),
]);

export type PayrollCadence = Static<typeof PayrollCadenceSchema>;

export const PayrollPeriodStatusSchema = Type.Union([
  Type.Literal('OPEN'),
  Type.Literal('REVIEW'),
  Type.Literal('LOCKED'),
]);

export type PayrollPeriodStatus = Static<typeof PayrollPeriodStatusSchema>;

export const PayrollDecisionSchema = Type.Union([
  Type.Literal('APPROVED'),
  Type.Literal('REJECTED'),
]);

export type PayrollDecision = Static<typeof PayrollDecisionSchema>;

export const PayrollExportStatusSchema = Type.Union([
  Type.Literal('GENERATED'),
  Type.Literal('DOWNLOADED'),
  Type.Literal('RECONCILING'),
  Type.Literal('RECONCILED'),
]);

export const PayrollReconciliationLineStatusSchema = Type.Union([
  Type.Literal('PENDING'),
  Type.Literal('ACCEPTED'),
  Type.Literal('REJECTED'),
]);

export const PayrollPolicySchema = Type.Object({
  id: UuidSchema,
  version: Type.Integer({ minimum: 1 }),
  timeZone: Type.String({ minLength: 1, maxLength: 100 }),
  cadence: PayrollCadenceSchema,
  anchorDate: DateOnlySchema,
  effectiveFrom: DateOnlySchema,
  createdByUserId: UuidSchema,
  createdAt: InstantSchema,
}, { additionalProperties: false });

export type PayrollPolicy = Static<typeof PayrollPolicySchema>;

export const PayrollReadinessSchema = Type.Object({
  cardCount: Type.Integer({ minimum: 0 }),
  closedCardCount: Type.Integer({ minimum: 0 }),
  approvedCardCount: Type.Integer({ minimum: 0 }),
  rejectedCardCount: Type.Integer({ minimum: 0 }),
  pendingCardCount: Type.Integer({ minimum: 0 }),
  amendmentCount: Type.Integer({ minimum: 0 }),
  pendingAmendmentCount: Type.Integer({ minimum: 0 }),
  approvedAmendmentCount: Type.Integer({ minimum: 0 }),
  lockedEntryCount: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

export const PayrollExportLineSchema = Type.Object({
  id: UuidSchema,
  lineNumber: Type.Integer({ minimum: 1 }),
  lockedEntryId: UuidSchema,
  employeeId: UuidSchema,
  payableMinutes: Type.Integer(),
  canonicalSha256: Type.String({ minLength: 64, maxLength: 64, pattern: '^[a-f0-9]{64}$' }),
  reconciliationStatus: PayrollReconciliationLineStatusSchema,
  reconciliationReason: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
}, { additionalProperties: false });

export const PayrollReconciliationSummarySchema = Type.Object({
  acceptedCount: Type.Integer({ minimum: 0 }),
  rejectedCount: Type.Integer({ minimum: 0 }),
  pendingCount: Type.Integer({ minimum: 0 }),
  providerTotalMinutes: Type.Union([Type.Integer(), Type.Null()]),
  latestProvider: Type.Union([Type.String({ maxLength: 100 }), Type.Null()]),
  latestProviderEventId: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
  latestPayloadSha256: Type.Union([Type.String({ minLength: 64, maxLength: 64, pattern: '^[a-f0-9]{64}$' }), Type.Null()]),
}, { additionalProperties: false });

export const PayrollExportSchema = Type.Object({
  id: UuidSchema,
  periodId: UuidSchema,
  formatVersion: Type.Integer({ minimum: 1 }),
  status: PayrollExportStatusSchema,
  contentSha256: Type.String({ minLength: 64, maxLength: 64, pattern: '^[a-f0-9]{64}$' }),
  rowCount: Type.Integer({ minimum: 0 }),
  totalPayableMinutes: Type.Integer(),
  settlement: Type.Object({
    consumedCredits: Type.Integer({ minimum: 0 }),
    newBalance: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false }),
  createdAt: InstantSchema,
  downloadedAt: Type.Union([InstantSchema, Type.Null()]),
  reconciledAt: Type.Union([InstantSchema, Type.Null()]),
  updatedAt: InstantSchema,
  lines: Type.Array(PayrollExportLineSchema, { maxItems: 500 }),
  nextLineCursor: Type.Union([CursorSchema, Type.Null()]),
  reconciliation: PayrollReconciliationSummarySchema,
}, { additionalProperties: false });

export type PayrollExport = Static<typeof PayrollExportSchema>;

export const PayrollPeriodSchema = Type.Object({
  id: UuidSchema,
  policyVersionId: UuidSchema,
  localStartDate: DateOnlySchema,
  localEndDateExclusive: DateOnlySchema,
  startsAt: InstantSchema,
  endsAt: InstantSchema,
  timeZone: Type.String({ minLength: 1, maxLength: 100 }),
  cadence: PayrollCadenceSchema,
  status: PayrollPeriodStatusSchema,
  revision: Type.Integer({ minimum: 0 }),
  reviewStartedAt: Type.Union([InstantSchema, Type.Null()]),
  lockedAt: Type.Union([InstantSchema, Type.Null()]),
  lockedEntrySha256: Type.Union([Type.String({ minLength: 64, maxLength: 64, pattern: '^[a-f0-9]{64}$' }), Type.Null()]),
  lockedEntryCount: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  totalPayableMinutes: Type.Union([Type.Integer(), Type.Null()]),
  createdAt: InstantSchema,
  updatedAt: InstantSchema,
  summary: PayrollReadinessSchema,
  exportBatch: Type.Union([PayrollExportSchema, Type.Null()]),
}, { additionalProperties: false });

export type PayrollPeriod = Static<typeof PayrollPeriodSchema>;

export const PayrollCardSchema = Type.Object({
  id: UuidSchema,
  timeCardRevision: Type.Integer({ minimum: 1 }),
  user: Type.Object({
    id: UuidSchema,
    name: Type.String({ minLength: 1, maxLength: 200 }),
    username: Type.String({ maxLength: 128 }),
  }, { additionalProperties: false }),
  locationId: Type.Union([UuidSchema, Type.Null()]),
  clockInAt: InstantSchema,
  clockOutAt: Type.Union([InstantSchema, Type.Null()]),
  breakMinutes: Type.Integer({ minimum: 0 }),
  payableMinutes: Type.Integer({ minimum: 0 }),
  updatedAt: InstantSchema,
  displayTimeZone: Type.String({ minLength: 1, maxLength: 100 }),
  included: Type.Boolean(),
  adoptionEligible: Type.Boolean(),
  decision: Type.Union([
    Type.Object({
      timeCardRevision: Type.Integer({ minimum: 1 }),
      decision: PayrollDecisionSchema,
      reason: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
      decidedAt: InstantSchema,
      decidedByUserId: UuidSchema,
    }, { additionalProperties: false }),
    Type.Null(),
  ]),
  decisionIsCurrent: Type.Boolean(),
}, { additionalProperties: false });

export const PayrollLockedEntrySchema = Type.Object({
  id: UuidSchema,
  sequence: Type.Integer({ minimum: 0 }),
  sourceType: Type.Union([Type.Literal('TIME_CARD'), Type.Literal('AMENDMENT')]),
  sourceId: UuidSchema,
  sourceRevision: Type.Integer({ minimum: 1 }),
  employeeId: UuidSchema,
  employeeName: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
  locationId: Type.Union([UuidSchema, Type.Null()]),
  workTimeZone: Type.String({ minLength: 1, maxLength: 100 }),
  clockInAt: InstantSchema,
  clockOutAt: InstantSchema,
  breakMinutes: Type.Integer({ minimum: 0 }),
  payableMinutes: Type.Integer(),
  approvedAt: InstantSchema,
  approvedByUserId: UuidSchema,
  canonicalSha256: Type.String({ minLength: 64, maxLength: 64, pattern: '^[a-f0-9]{64}$' }),
}, { additionalProperties: false });

export const PayrollAmendmentSchema = Type.Object({
  id: UuidSchema,
  lockedEntryId: UuidSchema,
  sourceEmployeeId: Type.Union([UuidSchema, Type.Null()]),
  adjustmentPeriodId: UuidSchema,
  requestedByUserId: UuidSchema,
  reason: ReasonSchema,
  replacementClockInAt: InstantSchema,
  replacementClockOutAt: InstantSchema,
  replacementBreakMinutes: Type.Integer({ minimum: 0 }),
  replacementPayableMinutes: Type.Integer(),
  minuteDelta: Type.Integer(),
  createdAt: InstantSchema,
  decision: Type.Union([
    Type.Object({
      decision: PayrollDecisionSchema,
      reason: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
      decidedByUserId: UuidSchema,
      decidedAt: InstantSchema,
    }, { additionalProperties: false }),
    Type.Null(),
  ]),
}, { additionalProperties: false });

export const PayrollPolicyListQuerySchema = Type.Object({
  limit: Type.Optional(LimitSchema),
  cursor: Type.Optional(CursorSchema),
}, { additionalProperties: false });

export type PayrollPolicyListQuery = Static<typeof PayrollPolicyListQuerySchema>;

export const PayrollPolicyListResponseSchema = Type.Object({
  data: Type.Array(PayrollPolicySchema, { maxItems: 50 }),
  nextCursor: Type.Union([CursorSchema, Type.Null()]),
}, { additionalProperties: false });

export const PayrollPolicyResponseSchema = Type.Object({
  data: Type.Union([PayrollPolicySchema, Type.Null()]),
}, { additionalProperties: false });

export const PayrollPolicyRequestSchema = Type.Object({
  timeZone: Type.String({ minLength: 1, maxLength: 100 }),
  cadence: PayrollCadenceSchema,
  anchorDate: DateOnlySchema,
  effectiveFrom: DateOnlySchema,
}, { additionalProperties: false });

export type PayrollPolicyRequest = Static<typeof PayrollPolicyRequestSchema>;

export const PayrollPeriodListQuerySchema = Type.Object({
  limit: Type.Optional(LimitSchema),
  cursor: Type.Optional(CursorSchema),
}, { additionalProperties: false });

export type PayrollPeriodListQuery = Static<typeof PayrollPeriodListQuerySchema>;

export const PayrollPeriodListResponseSchema = Type.Object({
  data: Type.Array(PayrollPeriodSchema, { maxItems: 50 }),
  nextCursor: Type.Union([CursorSchema, Type.Null()]),
}, { additionalProperties: false });

export const PayrollPeriodPathSchema = Type.Object({
  periodId: UuidSchema,
}, { additionalProperties: false });

export const PayrollPeriodDetailQuerySchema = Type.Object({
  cardLimit: Type.Optional(LimitSchema),
  cardCursor: Type.Optional(CursorSchema),
  lineLimit: Type.Optional(LimitSchema),
  lineCursor: Type.Optional(CursorSchema),
}, { additionalProperties: false });

export type PayrollPeriodDetailQuery = Static<typeof PayrollPeriodDetailQuerySchema>;

export const PayrollPeriodDetailResponseSchema = Type.Object({
  period: PayrollPeriodSchema,
  cards: Type.Array(PayrollCardSchema, { maxItems: 250 }),
  nextCardCursor: Type.Union([CursorSchema, Type.Null()]),
  lockedEntries: Type.Array(PayrollLockedEntrySchema, { maxItems: 5_000 }),
  amendments: Type.Array(PayrollAmendmentSchema, { maxItems: 5_000 }),
}, { additionalProperties: false });

export const PayrollPeriodCreateRequestSchema = Type.Object({
  localStartDate: DateOnlySchema,
}, { additionalProperties: false });

export type PayrollPeriodCreateRequest = Static<typeof PayrollPeriodCreateRequestSchema>;

const RevisionSchema = Type.Integer({ minimum: 0, maximum: 2_147_483_647 });

export const PayrollCardsAdoptRequestSchema = Type.Object({
  cards: Type.Array(Type.Object({
    id: UuidSchema,
    expectedRevision: RevisionSchema,
  }, { additionalProperties: false }), { minItems: 1, maxItems: 100 }),
}, { additionalProperties: false });

export type PayrollCardsAdoptRequest = Static<typeof PayrollCardsAdoptRequestSchema>;

export const PayrollCardsAdoptResponseSchema = Type.Object({
  periodId: UuidSchema,
  cards: Type.Array(Type.Object({
    id: UuidSchema,
    revision: Type.Integer({ minimum: 1 }),
  }, { additionalProperties: false }), { maxItems: 100 }),
}, { additionalProperties: false });

export const PayrollExpectedRevisionRequestSchema = Type.Object({
  expectedRevision: RevisionSchema,
}, { additionalProperties: false });

export type PayrollExpectedRevisionRequest = Static<typeof PayrollExpectedRevisionRequestSchema>;

export const PayrollDecisionsRequestSchema = Type.Object({
  decisions: Type.Array(Type.Object({
    timeCardId: UuidSchema,
    expectedRevision: RevisionSchema,
    decision: PayrollDecisionSchema,
    reason: Type.Optional(ReasonSchema),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 100 }),
}, { additionalProperties: false });

export type PayrollDecisionsRequest = Static<typeof PayrollDecisionsRequestSchema>;

export const PayrollDecisionsResponseSchema = Type.Object({
  periodId: UuidSchema,
  decisions: Type.Array(Type.Object({
    timeCardId: UuidSchema,
    timeCardRevision: Type.Integer({ minimum: 1 }),
    decision: PayrollDecisionSchema,
    reason: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
    decidedAt: InstantSchema,
    decidedByUserId: UuidSchema,
  }, { additionalProperties: false }), { maxItems: 100 }),
}, { additionalProperties: false });

export const PayrollEntryPathSchema = Type.Object({
  entryId: UuidSchema,
}, { additionalProperties: false });

export const PayrollAmendmentRequestSchema = Type.Object({
  adjustmentPeriodId: UuidSchema,
  reason: ReasonSchema,
  replacementClockInAt: InstantSchema,
  replacementClockOutAt: InstantSchema,
  replacementBreakMinutes: Type.Integer({ minimum: 0, maximum: 44_640 }),
}, { additionalProperties: false });

export type PayrollAmendmentRequest = Static<typeof PayrollAmendmentRequestSchema>;

export const PayrollAmendmentPathSchema = Type.Object({
  amendmentId: UuidSchema,
}, { additionalProperties: false });

export const PayrollAmendmentDecisionRequestSchema = Type.Object({
  decision: PayrollDecisionSchema,
  reason: Type.Optional(ReasonSchema),
}, { additionalProperties: false });

export type PayrollAmendmentDecisionRequest = Static<typeof PayrollAmendmentDecisionRequestSchema>;

export const PayrollAmendmentDecisionResponseSchema = Type.Object({
  amendmentId: UuidSchema,
  decision: PayrollDecisionSchema,
  reason: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
  decidedByUserId: UuidSchema,
  decidedAt: InstantSchema,
}, { additionalProperties: false });

export const PayrollExportRequestSchema = Type.Object({
  expectedCreditCost: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
}, { additionalProperties: false });

export type PayrollExportRequest = Static<typeof PayrollExportRequestSchema>;

export const PayrollExportPathSchema = Type.Object({
  exportId: UuidSchema,
}, { additionalProperties: false });

export const PayrollExportQuerySchema = Type.Object({
  lineLimit: Type.Optional(LimitSchema),
  lineCursor: Type.Optional(CursorSchema),
}, { additionalProperties: false });

export type PayrollExportQuery = Static<typeof PayrollExportQuerySchema>;

export const PayrollReconciliationRequestSchema = Type.Object({
  provider: Type.String({ minLength: 1, maxLength: 100 }),
  providerEventId: Type.String({ minLength: 1, maxLength: 200 }),
  providerTotalMinutes: Type.Integer(),
  outcomes: Type.Array(Type.Object({
    lineId: UuidSchema,
    status: PayrollReconciliationLineStatusSchema,
    reason: Type.Optional(ReasonSchema),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 500 }),
}, { additionalProperties: false });

export type PayrollReconciliationRequest = Static<typeof PayrollReconciliationRequestSchema>;

export const PayrollReconciliationReceiptSchema = Type.Object({
  id: UuidSchema,
  batchId: UuidSchema,
  provider: Type.String({ minLength: 1, maxLength: 100 }),
  providerEventId: Type.String({ minLength: 1, maxLength: 200 }),
  payloadSha256: Type.String({ minLength: 64, maxLength: 64, pattern: '^[a-f0-9]{64}$' }),
  providerTotalMinutes: Type.Integer(),
  acceptedCount: Type.Integer({ minimum: 0 }),
  rejectedCount: Type.Integer({ minimum: 0 }),
  pendingCount: Type.Integer({ minimum: 0 }),
  receivedByUserId: UuidSchema,
  receivedAt: InstantSchema,
}, { additionalProperties: false });

export const PayrollExportEntitlementSchema = Type.Object({
  creditCost: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  eligible: Type.Boolean(),
  reason: Type.String({ minLength: 1, maxLength: 500 }),
}, { additionalProperties: false });

export const PayrollRouteProblemResponses = {
  400: ProblemDetailsSchema,
  401: ProblemDetailsSchema,
  403: ProblemDetailsSchema,
  404: ProblemDetailsSchema,
  409: ProblemDetailsSchema,
  422: ProblemDetailsSchema,
  428: ProblemDetailsSchema,
  429: ProblemDetailsSchema,
  500: ProblemDetailsSchema,
  503: ProblemDetailsSchema,
};
