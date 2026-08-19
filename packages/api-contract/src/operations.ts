import { Static, Type } from '@sinclair/typebox';
import { InstantSchema, ProblemDetailsSchema, UuidSchema } from './scheduling';

const ListLimitSchema = Type.String({ minLength: 1, maxLength: 3, pattern: '^[0-9]+$' });
const CursorSchema = Type.String({ minLength: 1, maxLength: 512 });

export const BoundedPaginationSchema = Type.Object({
  limit: Type.Integer({ minimum: 1, maximum: 200 }),
  maxLimit: Type.Literal(200),
  returned: Type.Integer({ minimum: 0, maximum: 200 }),
  hasMore: Type.Boolean(),
  nextCursor: Type.Union([CursorSchema, Type.Null()]),
  window: Type.Object({
    startDate: Type.Union([InstantSchema, Type.Null()]),
    endDate: Type.Union([InstantSchema, Type.Null()]),
  }),
});

export type BoundedPagination = Static<typeof BoundedPaginationSchema>;

export const OperationsListQuerySchema = Type.Object({
  locationId: Type.Optional(UuidSchema),
  scheduleId: Type.Optional(UuidSchema),
  startDate: Type.Optional(InstantSchema),
  endDate: Type.Optional(InstantSchema),
  limit: Type.Optional(ListLimitSchema),
  cursor: Type.Optional(CursorSchema),
}, { additionalProperties: false });

export type OperationsListQuery = Static<typeof OperationsListQuerySchema>;

export const StaffRosterQuerySchema = Type.Object({
  limit: Type.Optional(ListLimitSchema),
  cursor: Type.Optional(CursorSchema),
}, { additionalProperties: false });

export type StaffRosterQuery = Static<typeof StaffRosterQuerySchema>;

export const ScheduleSummarySchema = Type.Object({
  id: UuidSchema,
  locationId: UuidSchema,
  startDate: InstantSchema,
  endDate: InstantSchema,
  status: Type.Union([
    Type.Literal('DRAFT'),
    Type.Literal('PUBLISHED'),
    Type.Literal('ARCHIVED'),
  ]),
  publishedAt: Type.Union([InstantSchema, Type.Null()]),
  revision: Type.Integer({ minimum: 0 }),
});

export type ScheduleSummary = Static<typeof ScheduleSummarySchema>;

export const ScheduleSummaryListResponseSchema = Type.Object({
  data: Type.Array(ScheduleSummarySchema, { maxItems: 200 }),
  pagination: BoundedPaginationSchema,
});

export type ScheduleSummaryListResponse = Static<typeof ScheduleSummaryListResponseSchema>;

export const ShiftBreakSummarySchema = Type.Object({
  type: Type.Union([
    Type.Literal('break1'),
    Type.Literal('lunch'),
    Type.Literal('break2'),
  ]),
  startTime: InstantSchema,
  endTime: InstantSchema,
  durationMinutes: Type.Integer({ minimum: 1, maximum: 720 }),
  paid: Type.Boolean(),
});

export type ShiftBreakSummary = Static<typeof ShiftBreakSummarySchema>;

export const ShiftSummarySchema = Type.Object({
  id: UuidSchema,
  userId: Type.Union([UuidSchema, Type.Null()]),
  locationId: UuidSchema,
  scheduleId: Type.Union([UuidSchema, Type.Null()]),
  startTime: InstantSchema,
  endTime: InstantSchema,
  role: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
  user: Type.Union([
    Type.Object({
      id: UuidSchema,
      name: Type.String({ minLength: 1, maxLength: 200 }),
      role: Type.Union([Type.Literal('MANAGER'), Type.Literal('STAFF')]),
    }),
    Type.Null(),
  ]),
  breaks: Type.Array(ShiftBreakSummarySchema, { maxItems: 20 }),
});

export type ShiftSummary = Static<typeof ShiftSummarySchema>;

export const ShiftSummaryListResponseSchema = Type.Object({
  data: Type.Array(ShiftSummarySchema, { maxItems: 200 }),
  pagination: BoundedPaginationSchema,
});

export type ShiftSummaryListResponse = Static<typeof ShiftSummaryListResponseSchema>;

export const StaffRosterMemberSchema = Type.Object({
  id: UuidSchema,
  name: Type.String({ minLength: 1, maxLength: 200 }),
  role: Type.Union([Type.Literal('MANAGER'), Type.Literal('STAFF')]),
});

export type StaffRosterMember = Static<typeof StaffRosterMemberSchema>;

export const StaffRosterResponseSchema = Type.Object({
  data: Type.Array(StaffRosterMemberSchema, { maxItems: 200 }),
  pagination: BoundedPaginationSchema,
});

export type StaffRosterResponse = Static<typeof StaffRosterResponseSchema>;

export const LunchBreakPolicySchema = Type.Object({
  break1OffsetMinutes: Type.Integer({ minimum: 10, maximum: 480 }),
  lunchOffsetMinutes: Type.Integer({ minimum: 30, maximum: 600 }),
  break2OffsetMinutes: Type.Integer({ minimum: 10, maximum: 480 }),
  break1DurationMinutes: Type.Integer({ minimum: 5, maximum: 60 }),
  lunchDurationMinutes: Type.Integer({ minimum: 15, maximum: 120 }),
  break2DurationMinutes: Type.Integer({ minimum: 5, maximum: 60 }),
  timeStepMinutes: Type.Integer({ minimum: 1, maximum: 60 }),
}, { additionalProperties: false });

export type LunchBreakPolicy = Static<typeof LunchBreakPolicySchema>;

export const LunchBreakPolicyPatchSchema = Type.Partial(LunchBreakPolicySchema, { additionalProperties: false });

export type LunchBreakPolicyPatch = Static<typeof LunchBreakPolicyPatchSchema>;

export const LunchBreakListQuerySchema = Type.Object({
  locationId: Type.Optional(UuidSchema),
  scheduleId: Type.Optional(UuidSchema),
  shiftIds: Type.Optional(Type.String({ minLength: 1, maxLength: 40_000 })),
  startDate: Type.Optional(InstantSchema),
  endDate: Type.Optional(InstantSchema),
  limit: Type.Optional(ListLimitSchema),
  cursor: Type.Optional(CursorSchema),
}, { additionalProperties: false });

export type LunchBreakListQuery = Static<typeof LunchBreakListQuerySchema>;

export const LunchBreakRowSchema = Type.Object({
  shiftId: Type.Union([UuidSchema, Type.Null()]),
  userId: Type.Union([UuidSchema, Type.Null()]),
  employeeName: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
  startTime: InstantSchema,
  endTime: InstantSchema,
  breaks: Type.Array(ShiftBreakSummarySchema, { maxItems: 3 }),
});

export type LunchBreakRow = Static<typeof LunchBreakRowSchema>;

export const LunchBreakListResponseSchema = Type.Object({
  data: Type.Array(LunchBreakRowSchema, { maxItems: 200 }),
  pagination: BoundedPaginationSchema,
});

export type LunchBreakListResponse = Static<typeof LunchBreakListResponseSchema>;

const ManualLunchBreakShiftSchema = Type.Object({
  id: Type.Optional(UuidSchema),
  userId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  employeeName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  startTime: InstantSchema,
  endTime: InstantSchema,
  lunchDurationMinutes: Type.Optional(Type.Integer({ minimum: 15, maximum: 120 })),
}, { additionalProperties: false });

export const LunchBreakGenerationRequestSchema = Type.Object({
  scheduleId: Type.Optional(UuidSchema),
  locationId: Type.Optional(UuidSchema),
  shiftIds: Type.Optional(Type.Array(UuidSchema, { minItems: 1, maxItems: 1000, uniqueItems: true })),
  persist: Type.Optional(Type.Boolean()),
  policy: Type.Optional(LunchBreakPolicyPatchSchema),
  shifts: Type.Optional(Type.Array(ManualLunchBreakShiftSchema, { minItems: 1, maxItems: 1000 })),
}, { additionalProperties: false });

export type LunchBreakGenerationRequest = Static<typeof LunchBreakGenerationRequestSchema>;

export const CreditConsumptionSchema = Type.Object({
  consumedCredits: Type.Integer({ minimum: 1 }),
  newBalance: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  source: Type.Literal('credits'),
});

export type CreditConsumption = Static<typeof CreditConsumptionSchema>;

export const LunchBreakGenerationResponseSchema = Type.Object({
  locationId: Type.Union([UuidSchema, Type.Null()]),
  source: Type.Union([Type.Literal('shared_schedule'), Type.Literal('standalone')]),
  persisted: Type.Boolean(),
  policy: LunchBreakPolicySchema,
  creditConsumption: CreditConsumptionSchema,
  data: Type.Array(LunchBreakRowSchema, { maxItems: 1000 }),
  reused: Type.Boolean(),
});

export type LunchBreakGenerationResponse = Static<typeof LunchBreakGenerationResponseSchema>;

export const SetupShiftInputSchema = Type.Object({
  shiftId: Type.Optional(UuidSchema),
  userId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  startTime: InstantSchema,
  endTime: InstantSchema,
}, { additionalProperties: false });

export const SetupShiftsRequestSchema = Type.Object({
  locationId: UuidSchema,
  rows: Type.Array(SetupShiftInputSchema, { minItems: 1, maxItems: 200 }),
}, { additionalProperties: false });

export type SetupShiftsRequest = Static<typeof SetupShiftsRequestSchema>;

export const SetupShiftsResponseSchema = Type.Object({
  shiftIds: Type.Array(UuidSchema, { maxItems: 200 }),
});

export type SetupShiftsResponse = Static<typeof SetupShiftsResponseSchema>;

export const ShiftBreakPathSchema = Type.Object({
  shiftId: UuidSchema,
}, { additionalProperties: false });

export const ShiftBreakUpdateRequestSchema = Type.Object({
  locationId: UuidSchema,
  breaks: Type.Array(Type.Object({
    type: Type.Union([
      Type.Literal('break1'),
      Type.Literal('lunch'),
      Type.Literal('break2'),
    ]),
    startTime: Type.Optional(InstantSchema),
    durationMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
    skip: Type.Boolean(),
  }, { additionalProperties: false }), { maxItems: 3 }),
}, { additionalProperties: false });

export type ShiftBreakUpdateRequest = Static<typeof ShiftBreakUpdateRequestSchema>;

export const OperationsRouteProblemResponses = {
  400: ProblemDetailsSchema,
  401: ProblemDetailsSchema,
  402: ProblemDetailsSchema,
  403: ProblemDetailsSchema,
  404: ProblemDetailsSchema,
  409: ProblemDetailsSchema,
  412: ProblemDetailsSchema,
  422: ProblemDetailsSchema,
  428: ProblemDetailsSchema,
  429: ProblemDetailsSchema,
  500: ProblemDetailsSchema,
  503: ProblemDetailsSchema,
};
