import { Static, Type } from '@sinclair/typebox';
import { InstantSchema, ProblemDetailsSchema, UuidSchema } from './scheduling';

const NotificationLimitSchema = Type.String({ minLength: 1, maxLength: 3, pattern: '^[0-9]+$' });
const NotificationCursorSchema = Type.String({ minLength: 1, maxLength: 512 });

export const NotificationTypeSchema = Type.Union([
  Type.Literal('INFO'),
  Type.Literal('SUCCESS'),
  Type.Literal('WARNING'),
  Type.Literal('ERROR'),
  Type.Literal('SCHEDULE_PUBLISHED'),
  Type.Literal('SHIFT_ASSIGNED'),
  Type.Literal('SHIFT_CHANGED'),
]);

export type NotificationType = Static<typeof NotificationTypeSchema>;

export const NotificationRecordSchema = Type.Object({
  id: UuidSchema,
  type: NotificationTypeSchema,
  title: Type.String(),
  body: Type.String(),
  readAt: Type.Union([InstantSchema, Type.Null()]),
  createdAt: InstantSchema,
}, { additionalProperties: false });

export type NotificationRecord = Static<typeof NotificationRecordSchema>;

export const NotificationListQuerySchema = Type.Object({
  status: Type.Optional(Type.Union([Type.Literal('all'), Type.Literal('unread')])),
  limit: Type.Optional(NotificationLimitSchema),
  cursor: Type.Optional(NotificationCursorSchema),
}, { additionalProperties: false });

export type NotificationListQuery = Static<typeof NotificationListQuerySchema>;

export const NotificationPaginationSchema = Type.Object({
  limit: Type.Integer({ minimum: 1, maximum: 100 }),
  maxLimit: Type.Literal(100),
  returned: Type.Integer({ minimum: 0, maximum: 100 }),
  hasMore: Type.Boolean(),
  nextCursor: Type.Union([NotificationCursorSchema, Type.Null()]),
});

export type NotificationPagination = Static<typeof NotificationPaginationSchema>;

export const NotificationListResponseSchema = Type.Object({
  data: Type.Array(NotificationRecordSchema, { maxItems: 100 }),
  unreadCount: Type.Integer({ minimum: 0 }),
  pagination: NotificationPaginationSchema,
}, { additionalProperties: false });

export type NotificationListResponse = Static<typeof NotificationListResponseSchema>;

export const NotificationReadRequestSchema = Type.Object({
  ids: Type.Array(UuidSchema, { minItems: 1, maxItems: 100, uniqueItems: true }),
}, { additionalProperties: false });

export type NotificationReadRequest = Static<typeof NotificationReadRequestSchema>;

export const NotificationReadResponseSchema = Type.Object({
  updated: Type.Integer({ minimum: 0, maximum: 100 }),
  unreadCount: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

export type NotificationReadResponse = Static<typeof NotificationReadResponseSchema>;

export const NotificationReadAllResponseSchema = Type.Object({
  success: Type.Literal(true),
  updated: Type.Integer({ minimum: 0 }),
  unreadCount: Type.Literal(0),
}, { additionalProperties: false });

export type NotificationReadAllResponse = Static<typeof NotificationReadAllResponseSchema>;

export const NotificationRouteProblemResponses = {
  400: ProblemDetailsSchema,
  401: ProblemDetailsSchema,
  403: ProblemDetailsSchema,
  422: ProblemDetailsSchema,
  429: ProblemDetailsSchema,
  500: ProblemDetailsSchema,
  503: ProblemDetailsSchema,
};
