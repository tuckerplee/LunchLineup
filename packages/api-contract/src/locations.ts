import { Static, Type } from '@sinclair/typebox';
import { InstantSchema, ProblemDetailsSchema, UuidSchema } from './scheduling';

const LocationNameSchema = Type.String({ minLength: 1, maxLength: 200 });
const LocationAddressSchema = Type.String({ maxLength: 500 });
const TimeZoneSchema = Type.String({ minLength: 1, maxLength: 100 });

/**
 * Public location representation. `id` is the stable public UUID; storage
 * primary keys and create-idempotency hashes never cross the API boundary.
 */
export const LocationRecordSchema = Type.Object({
  id: UuidSchema,
  name: LocationNameSchema,
  address: Type.Union([LocationAddressSchema, Type.Null()]),
  timezone: TimeZoneSchema,
  createdAt: InstantSchema,
  updatedAt: InstantSchema,
});

export type LocationRecord = Static<typeof LocationRecordSchema>;

export const LocationListQuerySchema = Type.Object({
  limit: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,2}$', maxLength: 3 })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
}, { additionalProperties: false });

export type LocationListQuery = Static<typeof LocationListQuerySchema>;

export const LocationPaginationSchema = Type.Object({
  limit: Type.Integer({ minimum: 1, maximum: 200 }),
  maxLimit: Type.Literal(200),
  returned: Type.Integer({ minimum: 0, maximum: 200 }),
  hasMore: Type.Boolean(),
  nextCursor: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
});

export const LocationListResponseSchema = Type.Object({
  data: Type.Array(LocationRecordSchema, { maxItems: 200 }),
  pagination: LocationPaginationSchema,
});

export type LocationListResponse = Static<typeof LocationListResponseSchema>;

export const LocationSummaryResponseSchema = Type.Object({
  count: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
});

export type LocationSummaryResponse = Static<typeof LocationSummaryResponseSchema>;

export const LocationCreateRequestSchema = Type.Object({
  name: LocationNameSchema,
  address: Type.Optional(LocationAddressSchema),
  timezone: TimeZoneSchema,
  tenantName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  workspaceSlug: Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: '^[a-z0-9][a-z0-9-]*$' })),
}, { additionalProperties: false });

export type LocationCreateRequest = Static<typeof LocationCreateRequestSchema>;

export const LocationUpdateRequestSchema = Type.Object({
  name: Type.Optional(LocationNameSchema),
  address: Type.Optional(Type.Union([LocationAddressSchema, Type.Null()])),
  timezone: TimeZoneSchema,
}, { additionalProperties: false });

export type LocationUpdateRequest = Static<typeof LocationUpdateRequestSchema>;

export const LocationPathSchema = Type.Object({
  locationId: UuidSchema,
}, { additionalProperties: false });

export const LocationRouteProblemResponses = {
  401: ProblemDetailsSchema,
  403: ProblemDetailsSchema,
  404: ProblemDetailsSchema,
  409: ProblemDetailsSchema,
  422: ProblemDetailsSchema,
  500: ProblemDetailsSchema,
  503: ProblemDetailsSchema,
};
