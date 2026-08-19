import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import {
  NotificationListResponseSchema,
  NotificationReadRequestSchema,
} from './notifications';

const notificationId = 'd5bb9831-0454-48b7-bb15-8c328874535d';

describe('API v2 notifications contract', () => {
  it('accepts public notification records with an opaque cursor envelope', () => {
    expect(Value.Check(NotificationListResponseSchema, {
      data: [{
        id: notificationId,
        type: 'SCHEDULE_PUBLISHED',
        title: 'Schedule published',
        body: 'Your schedule is ready.',
        readAt: null,
        createdAt: '2026-07-19T00:00:00.000Z',
      }],
      unreadCount: 1,
      pagination: { limit: 20, maxLimit: 100, returned: 1, hasMore: false, nextCursor: null },
    })).toBe(true);
  });

  it('requires bounded public UUID read targets and rejects caller tenant control', () => {
    expect(Value.Check(NotificationReadRequestSchema, { ids: [notificationId] })).toBe(true);
    expect(Value.Check(NotificationReadRequestSchema, { ids: [] })).toBe(false);
    expect(Value.Check(NotificationReadRequestSchema, {
      ids: [notificationId],
      tenantId: 'caller-selected-tenant',
    })).toBe(false);
  });
});
