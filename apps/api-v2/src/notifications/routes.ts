import {
  NotificationListQuerySchema,
  NotificationListResponseSchema,
  NotificationReadAllResponseSchema,
  NotificationReadRequestSchema,
  NotificationReadResponseSchema,
  NotificationRouteProblemResponses,
  type NotificationListQuery,
  type NotificationReadRequest,
} from '@lunchlineup/api-contract';
import type { FastifyInstance } from 'fastify';
import type { ApiV2Config } from '../config';
import { type IdentityAdapter, requirePermissions } from '../platform/identity';
import { assertUnsafeRequestSecurity } from '../platform/request-security';
import type { NotificationService } from './notifications.service';

export type NotificationRouteDependencies = {
  config: ApiV2Config;
  identity: IdentityAdapter;
  notifications: Pick<NotificationService, 'list' | 'markRead' | 'markAllRead'>;
};

/** Explicit native routes for the session-scoped notification feed. */
export async function registerNotificationRoutes(
  app: FastifyInstance,
  dependencies: NotificationRouteDependencies,
): Promise<void> {
  app.get<{ Querystring: NotificationListQuery }>('/v2/notifications', {
    schema: {
      operationId: 'listNotifications',
      summary: 'List notifications',
      description: 'Lists the authenticated user notification feed using opaque cursors and public UUIDs only.',
      tags: ['Notifications'],
      querystring: NotificationListQuerySchema,
      response: { 200: NotificationListResponseSchema, ...NotificationRouteProblemResponses },
    },
  }, async (request, reply) => {
    const identity = await dependencies.identity.authenticate(request, reply);
    requirePermissions(identity, ['notifications:read']);
    const response = await dependencies.notifications.list(identity, request.query);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.post<{ Body: NotificationReadRequest }>('/v2/notifications/read', {
    schema: {
      operationId: 'markNotificationRead',
      summary: 'Mark notifications read',
      description: 'Marks the authenticated user public notification UUIDs as read.',
      tags: ['Notifications'],
      body: NotificationReadRequestSchema,
      response: { 200: NotificationReadResponseSchema, ...NotificationRouteProblemResponses },
    },
  }, async (request, reply) => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await dependencies.identity.authenticate(request, reply);
    requirePermissions(identity, ['notifications:write']);
    const response = await dependencies.notifications.markRead(identity, request.body.ids);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.post('/v2/notifications/read-all', {
    schema: {
      operationId: 'markAllNotificationsRead',
      summary: 'Mark all notifications read',
      description: 'Marks all unread notifications for the authenticated user as read.',
      tags: ['Notifications'],
      response: { 200: NotificationReadAllResponseSchema, ...NotificationRouteProblemResponses },
    },
  }, async (request, reply) => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await dependencies.identity.authenticate(request, reply);
    requirePermissions(identity, ['notifications:write']);
    const response = await dependencies.notifications.markAllRead(identity);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });
}
