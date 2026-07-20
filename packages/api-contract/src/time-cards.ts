import { Static, Type } from '@sinclair/typebox';
import { InstantSchema, ProblemDetailsSchema, UuidSchema } from './scheduling';

const ListLimitSchema = Type.String({ minLength: 1, maxLength: 3, pattern: '^[0-9]+$' });
const CursorSchema = Type.String({ minLength: 1, maxLength: 512 });
const NotesSchema = Type.String({ maxLength: 1_000 });

export const TimeCardStatusSchema = Type.Union([
  Type.Literal('OPEN'),
  Type.Literal('CLOSED'),
  Type.Literal('VOID'),
]);

export type TimeCardStatus = Static<typeof TimeCardStatusSchema>;

export const TimeCardBreakSchema = Type.Object({
  id: UuidSchema,
  startAt: InstantSchema,
  endAt: InstantSchema,
});

export type TimeCardBreak = Static<typeof TimeCardBreakSchema>;

export const TimeCardRecordSchema = Type.Object({
  id: UuidSchema,
  userId: UuidSchema,
  locationId: Type.Union([UuidSchema, Type.Null()]),
  shiftId: Type.Union([UuidSchema, Type.Null()]),
  clockInAt: InstantSchema,
  clockOutAt: Type.Union([InstantSchema, Type.Null()]),
  breakMinutes: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
  status: TimeCardStatusSchema,
  revision: Type.Integer({ minimum: 1 }),
  grossMinutes: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
  workedMinutes: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
  notes: Type.Union([NotesSchema, Type.Null()]),
  createdAt: InstantSchema,
  updatedAt: InstantSchema,
  displayTimeZone: Type.String({ minLength: 1, maxLength: 100 }),
  breaks: Type.Array(TimeCardBreakSchema, { maxItems: 24 }),
  user: Type.Object({
    id: UuidSchema,
    name: Type.String({ minLength: 1, maxLength: 200 }),
    username: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
    role: Type.String({ minLength: 1, maxLength: 64 }),
  }),
  location: Type.Union([
    Type.Object({
      id: UuidSchema,
      name: Type.String({ minLength: 1, maxLength: 200 }),
      timezone: Type.String({ minLength: 1, maxLength: 100 }),
    }),
    Type.Null(),
  ]),
});

export type TimeCardRecord = Static<typeof TimeCardRecordSchema>;

export const TimeCardListQuerySchema = Type.Object({
  userId: Type.Optional(UuidSchema),
  locationId: Type.Optional(UuidSchema),
  startDate: Type.Optional(InstantSchema),
  endDate: Type.Optional(InstantSchema),
  limit: Type.Optional(ListLimitSchema),
  cursor: Type.Optional(CursorSchema),
}, { additionalProperties: false });

export type TimeCardListQuery = Static<typeof TimeCardListQuerySchema>;

export const TimeCardActiveQuerySchema = Type.Object({
  userId: Type.Optional(UuidSchema),
}, { additionalProperties: false });

export type TimeCardActiveQuery = Static<typeof TimeCardActiveQuerySchema>;

export const TimeCardPaginationSchema = Type.Object({
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

export type TimeCardPagination = Static<typeof TimeCardPaginationSchema>;

export const TimeCardListResponseSchema = Type.Object({
  data: Type.Array(TimeCardRecordSchema, { maxItems: 200 }),
  pagination: TimeCardPaginationSchema,
});

export type TimeCardListResponse = Static<typeof TimeCardListResponseSchema>;

export const TimeCardActiveResponseSchema = Type.Object({
  data: Type.Union([TimeCardRecordSchema, Type.Null()]),
});

export type TimeCardActiveResponse = Static<typeof TimeCardActiveResponseSchema>;

export const TimeCardPathSchema = Type.Object({
  timeCardId: UuidSchema,
}, { additionalProperties: false });

export const TimeCardClockInRequestSchema = Type.Object({
  userId: Type.Optional(UuidSchema),
  locationId: Type.Optional(UuidSchema),
  shiftId: Type.Optional(UuidSchema),
  clockInAt: Type.Optional(InstantSchema),
  notes: Type.Optional(NotesSchema),
}, { additionalProperties: false });

export type TimeCardClockInRequest = Static<typeof TimeCardClockInRequestSchema>;

export const TimeCardClockInResponseSchema = Type.Object({
  data: TimeCardRecordSchema,
  reused: Type.Boolean(),
});

export type TimeCardClockInResponse = Static<typeof TimeCardClockInResponseSchema>;

export const TimeCardClockOutRequestSchema = Type.Object({
  clockOutAt: Type.Optional(InstantSchema),
  breakMinutes: Type.Optional(Type.Integer({ minimum: 0, maximum: 44_640 })),
  notes: Type.Optional(NotesSchema),
}, { additionalProperties: false });

export type TimeCardClockOutRequest = Static<typeof TimeCardClockOutRequestSchema>;

export const TimeCardCorrectionRequestSchema = Type.Object({
  clockInAt: Type.Optional(InstantSchema),
  clockOutAt: Type.Optional(Type.Union([InstantSchema, Type.Null()])),
  breakIntervals: Type.Optional(Type.Array(Type.Object({
    startAt: InstantSchema,
    endAt: InstantSchema,
  }, { additionalProperties: false }), { maxItems: 24 })),
  expectedUpdatedAt: InstantSchema,
  reason: Type.String({ minLength: 5, maxLength: 500 }),
}, { additionalProperties: false });

export type TimeCardCorrectionRequest = Static<typeof TimeCardCorrectionRequestSchema>;

export const TimeCardRouteProblemResponses = {
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
