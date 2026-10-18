import { Static, Type } from '@sinclair/typebox';
import { ProblemDetailsSchema } from './scheduling';

/** Stable machine code, e.g. `lunch_breaks.generate.failed`. Never free text. */
export const ClientEventCodePattern = '^[a-z0-9_]+(?:\.[a-z0-9_]+){1,5}$';

/** Normalized in-app route, e.g. `/dashboard/lunch-breaks`. Identifiers are replaced by `:id`. */
export const ClientEventRoutePattern = '^/[a-z0-9_:/-]{0,127}$';

/** Short non-PII reason key, e.g. `payment_required`. */
export const ClientEventDetailPattern = '^[a-z0-9_.-]{1,48}$';

export const MAX_CLIENT_EVENTS_PER_BATCH = 20;

export const ClientEventLevelSchema = Type.Union([
  Type.Literal('success'),
  Type.Literal('info'),
  Type.Literal('warning'),
  Type.Literal('error'),
]);

export const ClientEventKindSchema = Type.Union([
  Type.Literal('message'),
  Type.Literal('confirm'),
  Type.Literal('prompt'),
]);

export const ClientEventOutcomeSchema = Type.Union([
  Type.Literal('confirmed'),
  Type.Literal('cancelled'),
]);

export const ClientEventSchema = Type.Object({
  code: Type.String({ minLength: 3, maxLength: 96, pattern: ClientEventCodePattern }),
  level: ClientEventLevelSchema,
  kind: ClientEventKindSchema,
  route: Type.String({ minLength: 1, maxLength: 128, pattern: ClientEventRoutePattern }),
  outcome: Type.Optional(ClientEventOutcomeSchema),
  detail: Type.Optional(Type.String({ minLength: 1, maxLength: 48, pattern: ClientEventDetailPattern })),
}, { additionalProperties: false });

export type ClientEvent = Static<typeof ClientEventSchema>;

export const ClientEventBatchRequestSchema = Type.Object({
  events: Type.Array(ClientEventSchema, { minItems: 1, maxItems: MAX_CLIENT_EVENTS_PER_BATCH }),
}, { additionalProperties: false });

export type ClientEventBatchRequest = Static<typeof ClientEventBatchRequestSchema>;

export const ClientEventBatchResponseSchema = Type.Object({
  accepted: Type.Integer({ minimum: 1, maximum: MAX_CLIENT_EVENTS_PER_BATCH }),
}, { additionalProperties: false });

export type ClientEventBatchResponse = Static<typeof ClientEventBatchResponseSchema>;

export const ClientEventRouteProblemResponses = {
  400: ProblemDetailsSchema,
  401: ProblemDetailsSchema,
  403: ProblemDetailsSchema,
  422: ProblemDetailsSchema,
  429: ProblemDetailsSchema,
  500: ProblemDetailsSchema,
  503: ProblemDetailsSchema,
};
