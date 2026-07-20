import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import {
  TimeCardClockInRequestSchema,
  TimeCardListResponseSchema,
  TimeCardPathSchema,
} from './time-cards';

const card = {
  id: '74023f56-a8ca-441f-8d01-afbcb75892d3',
  userId: 'f6776d21-bb21-4c35-a6ed-5da8df5ed238',
  locationId: '34aa4812-63f5-4e5c-8b3a-06b564987a1f',
  shiftId: null,
  clockInAt: '2026-07-18T16:00:00.000Z',
  clockOutAt: null,
  breakMinutes: 0,
  status: 'OPEN',
  revision: 1,
  grossMinutes: 60,
  workedMinutes: 60,
  notes: null,
  createdAt: '2026-07-18T16:00:00.000Z',
  updatedAt: '2026-07-18T16:00:00.000Z',
  displayTimeZone: 'America/Los_Angeles',
  breaks: [{
    id: 'a49bc1a3-f1f2-4d6d-8b8c-c2c8ab481068',
    startAt: '2026-07-18T16:20:00.000Z',
    endAt: '2026-07-18T16:30:00.000Z',
  }],
  user: { id: 'f6776d21-bb21-4c35-a6ed-5da8df5ed238', name: 'Casey', username: null, role: 'STAFF' },
  location: { id: '34aa4812-63f5-4e5c-8b3a-06b564987a1f', name: 'Downtown', timezone: 'America/Los_Angeles' },
};

describe('API v2 time-card contract', () => {
  it('accepts only public UUID records in a bounded list envelope', () => {
    expect(Value.Check(TimeCardListResponseSchema, {
      data: [card],
      pagination: {
        limit: 100,
        maxLimit: 200,
        returned: 1,
        hasMore: false,
        nextCursor: null,
        window: { startDate: null, endDate: null },
      },
    })).toBe(true);
  });

  it('rejects undeclared private identifiers and invalid public paths', () => {
    expect(Value.Check(TimeCardClockInRequestSchema, {
      userId: card.userId,
      locationId: card.locationId,
      storageUserId: 'private-primary-key',
    })).toBe(false);
    expect(Value.Check(TimeCardPathSchema, { timeCardId: 'private-primary-key' })).toBe(false);
  });
});
