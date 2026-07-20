import { describe, expect, it } from 'vitest';
import { decodeTimeCardCursor, encodeTimeCardCursor, parseTimeCardLimit } from './pagination';
import { serializeTimeCard } from './serialization';
import { validateTimeCardCorrection } from './validation';

const publicCardId = '74023f56-a8ca-441f-8d01-afbcb75892d3';
const publicUserId = 'f6776d21-bb21-4c35-a6ed-5da8df5ed238';
const publicLocationId = '34aa4812-63f5-4e5c-8b3a-06b564987a1f';

describe('native time-card validation', () => {
  it('uses bounded opaque public-ID cursors', () => {
    const cursor = encodeTimeCardCursor({
      clockInAt: new Date('2026-07-18T16:00:00.000Z'),
      publicId: publicCardId,
    });
    expect(decodeTimeCardCursor(cursor)).toEqual({
      clockInAt: new Date('2026-07-18T16:00:00.000Z'),
      publicId: publicCardId,
    });
    expect(parseTimeCardLimit(undefined)).toBe(100);
    expect(parseTimeCardLimit('200')).toBe(200);
    expect(() => parseTimeCardLimit('201')).toThrow('limit must be an integer');
  });

  it('validates a correction window and derives aggregate break minutes', () => {
    const corrected = validateTimeCardCorrection({
      expectedUpdatedAt: '2026-07-18T18:00:00.000Z',
      breakIntervals: [{
        startAt: '2026-07-18T16:20:00.000Z',
        endAt: '2026-07-18T16:30:00.000Z',
      }],
      reason: 'Add recorded meal break.',
    }, {
      clockInAt: new Date('2026-07-18T16:00:00.000Z'),
      clockOutAt: new Date('2026-07-18T17:00:00.000Z'),
      breakMinutes: 0,
      updatedAt: new Date('2026-07-18T18:00:00.000Z'),
      breaks: [],
    }, new Date('2026-07-18T19:00:00.000Z'));

    expect(corrected.breakMinutes).toBe(10);
    expect(corrected.status).toBe('CLOSED');
    expect(() => validateTimeCardCorrection({
      expectedUpdatedAt: '2026-07-18T18:00:00.000Z',
      breakIntervals: [{
        startAt: '2026-07-18T16:20:00.000Z',
        endAt: '2026-07-18T18:20:00.000Z',
      }],
      reason: 'Invalid break window.',
    }, {
      clockInAt: new Date('2026-07-18T16:00:00.000Z'),
      clockOutAt: new Date('2026-07-18T17:00:00.000Z'),
      breakMinutes: 0,
      updatedAt: new Date('2026-07-18T18:00:00.000Z'),
      breaks: [],
    }, new Date('2026-07-18T19:00:00.000Z'))).toThrow('inside the time-card window');
  });

  it('serializes only public resource identifiers', () => {
    const record = serializeTimeCard({
      publicId: publicCardId,
      clockInAt: new Date('2026-07-18T16:00:00.000Z'),
      clockOutAt: new Date('2026-07-18T17:00:00.000Z'),
      breakMinutes: 0,
      status: 'CLOSED',
      revision: 2,
      notes: null,
      createdAt: new Date('2026-07-18T16:00:00.000Z'),
      updatedAt: new Date('2026-07-18T17:00:00.000Z'),
      workTimeZone: 'UTC',
      user: { publicId: publicUserId, name: 'Casey', username: null, role: 'STAFF' },
      location: { publicId: publicLocationId, name: 'Downtown', timezone: 'UTC' },
      shift: null,
      breaks: [],
    });

    expect(record).toMatchObject({
      id: publicCardId,
      userId: publicUserId,
      locationId: publicLocationId,
      workedMinutes: 60,
    });
    expect(JSON.stringify(record)).not.toContain('storage-primary-key');
  });
});
