import { FormatRegistry, Static, Type } from '@sinclair/typebox';

if (!FormatRegistry.Has('uuid')) {
  FormatRegistry.Set('uuid', (value) => (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ));
}
if (!FormatRegistry.Has('date-time')) {
  FormatRegistry.Set('date-time', (value) => (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(new Date(value).getTime())
  ));
}

export const UuidSchema = Type.String({ format: 'uuid' });
export const InstantSchema = Type.String({ format: 'date-time' });
export const LocalDateSchema = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
export const SchedulerViewSchema = Type.Union([
  Type.Literal('day'),
  Type.Literal('threeDay'),
  Type.Literal('week'),
]);

export type SchedulerView = Static<typeof SchedulerViewSchema>;

export const ProblemViolationSchema = Type.Object({
  pointer: Type.String({ maxLength: 512 }),
  code: Type.String({ maxLength: 128 }),
  message: Type.String({ maxLength: 240 }),
});

export const ProblemDetailsSchema = Type.Object({
  type: Type.String({ maxLength: 512 }),
  title: Type.String({ maxLength: 160 }),
  status: Type.Integer({ minimum: 400, maximum: 599 }),
  detail: Type.String({ maxLength: 240 }),
  message: Type.Optional(Type.String({ maxLength: 240 })),
  instance: Type.Optional(Type.String({ maxLength: 512 })),
  code: Type.String({ maxLength: 128 }),
  legacyCode: Type.Optional(Type.String({ maxLength: 128 })),
  remediation: Type.Optional(Type.String({ maxLength: 240 })),
  retryAfterSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 86_400 })),
  requestId: Type.Optional(Type.String({ maxLength: 128 })),
  violations: Type.Optional(Type.Array(ProblemViolationSchema, { maxItems: 100 })),
  currentEtag: Type.Optional(Type.String({ maxLength: 160 })),
});

export type ProblemDetails = Static<typeof ProblemDetailsSchema>;

export const LocationSchema = Type.Object({
  id: UuidSchema,
  name: Type.String({ minLength: 1, maxLength: 200 }),
  timezone: Type.String({ minLength: 1, maxLength: 100 }),
});

export const StaffMemberSchema = Type.Object({
  id: UuidSchema,
  name: Type.String({ minLength: 1, maxLength: 200 }),
  role: Type.Union([Type.Literal('MANAGER'), Type.Literal('STAFF')]),
});

export const ScheduleSchema = Type.Object({
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
  etag: Type.String({ minLength: 1, maxLength: 160 }),
});

export const ShiftBreakSchema = Type.Object({
  startTime: InstantSchema,
  endTime: InstantSchema,
  paid: Type.Boolean(),
});

export const ShiftSchema = Type.Object({
  id: UuidSchema,
  userId: Type.Union([UuidSchema, Type.Null()]),
  locationId: UuidSchema,
  scheduleId: UuidSchema,
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
  breaks: Type.Array(ShiftBreakSchema, { maxItems: 20 }),
});

export const ScheduleBoardResponseSchema = Type.Object({
  data: Type.Object({
    permissions: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 200 }),
    locations: Type.Array(LocationSchema, { maxItems: 500 }),
    locationsTruncated: Type.Boolean(),
    selectedLocationId: Type.Union([UuidSchema, Type.Null()]),
    staff: Type.Array(StaffMemberSchema, { maxItems: 1000 }),
    schedules: Type.Array(ScheduleSchema, { maxItems: 200 }),
    shifts: Type.Array(ShiftSchema, { maxItems: 5000 }),
    range: Type.Object({
      start: InstantSchema,
      end: InstantSchema,
    }),
  }),
  meta: Type.Object({
    generatedAt: InstantSchema,
  }),
});

export type ScheduleBoardResponse = Static<typeof ScheduleBoardResponseSchema>;

export const ScheduleCreateRequestSchema = Type.Object({
  startDate: InstantSchema,
  endDate: InstantSchema,
}, { additionalProperties: false });

export type ScheduleCreateRequest = Static<typeof ScheduleCreateRequestSchema>;

export const ScheduleCreateResponseSchema = Type.Object({
  data: ScheduleSchema,
});

export type ScheduleCreateResponse = Static<typeof ScheduleCreateResponseSchema>;

const ShiftCreateOperationSchema = Type.Object({
  op: Type.Literal('shift.create'),
  clientId: Type.Optional(UuidSchema),
  userId: Type.Union([UuidSchema, Type.Null()]),
  startTime: InstantSchema,
  endTime: InstantSchema,
  role: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])),
}, { additionalProperties: false });

const ShiftUpdateOperationSchema = Type.Object({
  op: Type.Literal('shift.update'),
  shiftId: UuidSchema,
  userId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  startTime: Type.Optional(InstantSchema),
  endTime: Type.Optional(InstantSchema),
  role: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])),
}, { additionalProperties: false });

const ShiftDeleteOperationSchema = Type.Object({
  op: Type.Literal('shift.delete'),
  shiftId: UuidSchema,
}, { additionalProperties: false });

export const ScheduleChangeOperationSchema = Type.Union([
  ShiftCreateOperationSchema,
  ShiftUpdateOperationSchema,
  ShiftDeleteOperationSchema,
]);

export const ScheduleChangeSetRequestSchema = Type.Object({
  operations: Type.Array(ScheduleChangeOperationSchema, { minItems: 1, maxItems: 100 }),
}, { additionalProperties: false });

export type ScheduleChangeSetRequest = Static<typeof ScheduleChangeSetRequestSchema>;

export const ScheduleChangeSetResponseSchema = Type.Object({
  data: Type.Object({
    changeSetId: UuidSchema,
    scheduleId: UuidSchema,
    baseRevision: Type.Integer({ minimum: 0 }),
    revision: Type.Integer({ minimum: 1 }),
    etag: Type.String({ minLength: 1, maxLength: 160 }),
    shifts: Type.Array(ShiftSchema, { maxItems: 5000 }),
    created: Type.Array(Type.Object({
      clientId: Type.Union([UuidSchema, Type.Null()]),
      shiftId: UuidSchema,
    }), { maxItems: 100 }),
  }),
});

export type ScheduleChangeSetResponse = Static<typeof ScheduleChangeSetResponseSchema>;

export const DemandWindowSchema = Type.Object({
  id: UuidSchema,
  startTime: InstantSchema,
  endTime: InstantSchema,
  requiredStaff: Type.Integer({ minimum: 1, maximum: 200 }),
  skill: Type.Union([Type.String({ maxLength: 128 }), Type.Null()]),
});

export const DemandWindowListResponseSchema = Type.Object({
  data: Type.Array(DemandWindowSchema, { maxItems: 500 }),
});

export type DemandWindowListResponse = Static<typeof DemandWindowListResponseSchema>;

export const DemandWindowReplaceRequestSchema = Type.Object({
  windows: Type.Array(Type.Object({
    startTime: InstantSchema,
    endTime: InstantSchema,
    requiredStaff: Type.Integer({ minimum: 1, maximum: 200 }),
    skill: Type.Union([Type.String({ maxLength: 128 }), Type.Null()]),
  }, { additionalProperties: false }), { maxItems: 500 }),
}, { additionalProperties: false });

export type DemandWindowReplaceRequest = Static<typeof DemandWindowReplaceRequestSchema>;

export const DemandWindowReplaceResponseSchema = Type.Object({
  data: Type.Array(DemandWindowSchema, { maxItems: 500 }),
  changeSetId: UuidSchema,
  scheduleId: UuidSchema,
  baseRevision: Type.Integer({ minimum: 0 }),
  revision: Type.Integer({ minimum: 1 }),
  etag: Type.String({ minLength: 1, maxLength: 160 }),
});

export type DemandWindowReplaceResponse = Static<typeof DemandWindowReplaceResponseSchema>;

const SchedulePublishCostSchema = Type.Object({
  totalConfiguredCost: Type.Integer({ minimum: 1 }),
  scheduleCost: Type.Integer({ minimum: 1 }),
  matchingWebhookDeliveryCount: Type.Integer({ minimum: 0 }),
  matchingWebhookDeliveryUnitCost: Type.Integer({ minimum: 0 }),
  matchingWebhookDeliveryCost: Type.Integer({ minimum: 0 }),
});

export const SchedulePublishAcceptedContractSchema = Type.Intersect([
  SchedulePublishCostSchema,
  Type.Object({ version: Type.Integer({ minimum: 0 }) }),
]);

export type SchedulePublishAcceptedContract = Static<typeof SchedulePublishAcceptedContractSchema>;

export const SchedulePublishPlanResponseSchema = Type.Intersect([
  SchedulePublishCostSchema,
  Type.Object({
    scheduleId: UuidSchema,
    acceptedContract: SchedulePublishAcceptedContractSchema,
    availableCredits: Type.Integer({ minimum: 0 }),
    sufficientCredits: Type.Boolean(),
  }),
]);

export type SchedulePublishPlanResponse = Static<typeof SchedulePublishPlanResponseSchema>;

export const SchedulePublicationRequestSchema = Type.Object({
  acceptedContract: SchedulePublishAcceptedContractSchema,
}, { additionalProperties: false });

export type SchedulePublicationRequest = Static<typeof SchedulePublicationRequestSchema>;

export const SchedulePublicationResponseSchema = Type.Object({
  id: UuidSchema,
  status: Type.Literal('PUBLISHED'),
  publishedAt: InstantSchema,
  settlement: Type.Intersect([
    SchedulePublishCostSchema,
    Type.Object({
      acceptedContract: SchedulePublishAcceptedContractSchema,
      creditsConsumed: Type.Integer({ minimum: 0 }),
      newBalance: Type.Integer({ minimum: 0 }),
      ledgerIdentities: Type.Object({
        schedule: Type.String({ minLength: 1, maxLength: 512 }),
        webhookDeliveries: Type.Array(Type.Object({
          deliveryId: Type.String({ minLength: 1, maxLength: 512 }),
          ledgerId: Type.String({ minLength: 1, maxLength: 512 }),
        }), { maxItems: 500 }),
      }),
    }),
  ]),
  notifications: Type.Object({
    status: Type.Union([
      Type.Literal('DELIVERED'),
      Type.Literal('NOT_REQUIRED'),
      Type.Literal('PENDING'),
      Type.Literal('PARTIAL'),
      Type.Literal('FAILED'),
    ]),
    delivered: Type.Integer({ minimum: 0 }),
    pending: Type.Integer({ minimum: 0 }),
    failed: Type.Integer({ minimum: 0 }),
  }),
});

export type SchedulePublicationResponse = Static<typeof SchedulePublicationResponseSchema>;

export const ScheduleReopenResponseSchema = Type.Object({
  data: ScheduleSchema,
});

export type ScheduleReopenResponse = Static<typeof ScheduleReopenResponseSchema>;

export const ScheduleSolveRequestSchema = Type.Object({
  constraints: Type.Record(Type.String({ maxLength: 128 }), Type.Unknown()),
  confirmReplace: Type.Boolean(),
}, { additionalProperties: false });

export type ScheduleSolveRequest = Static<typeof ScheduleSolveRequestSchema>;

const CreditConsumptionSchema = Type.Object({
  consumedCredits: Type.Integer({ minimum: 0 }),
  newBalance: Type.Integer({ minimum: 0 }),
  source: Type.Literal('credits'),
});

export const ScheduleSolveResponseSchema = Type.Object({
  jobId: UuidSchema,
  status: Type.String({ minLength: 1, maxLength: 64 }),
  statusUrl: Type.String({ minLength: 1, maxLength: 512 }),
  creditConsumption: Type.Optional(CreditConsumptionSchema),
  publicationStatus: Type.Optional(Type.String({ maxLength: 64 })),
  reused: Type.Optional(Type.Boolean()),
});

export type ScheduleSolveResponse = Static<typeof ScheduleSolveResponseSchema>;

export const ScheduleSolveJobSchema = Type.Object({
  jobId: UuidSchema,
  scheduleId: UuidSchema,
  locationId: UuidSchema,
  status: Type.String({ minLength: 1, maxLength: 64 }),
  statusReason: Type.Union([Type.String({ maxLength: 240 }), Type.Null()]),
  retryCount: Type.Integer({ minimum: 0 }),
  resultShiftCount: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  publicationStatus: Type.String({ maxLength: 64 }),
  startedAt: Type.Union([InstantSchema, Type.Null()]),
  completedAt: Type.Union([InstantSchema, Type.Null()]),
  statusUrl: Type.String({ minLength: 1, maxLength: 512 }),
});

export type ScheduleSolveJob = Static<typeof ScheduleSolveJobSchema>;

const BreakPolicySchema = Type.Object({
  break1OffsetMinutes: Type.Integer({ minimum: 0 }),
  lunchOffsetMinutes: Type.Integer({ minimum: 0 }),
  break2OffsetMinutes: Type.Integer({ minimum: 0 }),
  break1DurationMinutes: Type.Integer({ minimum: 1 }),
  lunchDurationMinutes: Type.Integer({ minimum: 1 }),
  break2DurationMinutes: Type.Integer({ minimum: 1 }),
  timeStepMinutes: Type.Integer({ minimum: 1 }),
});

export const BreakGenerationRequestSchema = Type.Object({
  locationId: UuidSchema,
  shiftIds: Type.Array(UuidSchema, { minItems: 1, maxItems: 5000, uniqueItems: true }),
  persist: Type.Literal(true),
}, { additionalProperties: false });

export type BreakGenerationRequest = Static<typeof BreakGenerationRequestSchema>;

export const BreakGenerationResponseSchema = Type.Object({
  locationId: UuidSchema,
  source: Type.Union([Type.Literal('shared_schedule'), Type.Literal('standalone')]),
  persisted: Type.Boolean(),
  policy: BreakPolicySchema,
  creditConsumption: CreditConsumptionSchema,
  data: Type.Array(Type.Object({
    shiftId: Type.Union([UuidSchema, Type.Null()]),
    userId: Type.Union([UuidSchema, Type.Null()]),
    employeeName: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
    startTime: InstantSchema,
    endTime: InstantSchema,
    breaks: Type.Array(Type.Object({
      type: Type.Union([Type.Literal('break1'), Type.Literal('lunch'), Type.Literal('break2')]),
      startTime: InstantSchema,
      endTime: InstantSchema,
      durationMinutes: Type.Integer({ minimum: 1 }),
      paid: Type.Boolean(),
    }), { maxItems: 3 }),
  }), { maxItems: 5000 }),
  reused: Type.Boolean(),
});

export type BreakGenerationResponse = Static<typeof BreakGenerationResponseSchema>;
