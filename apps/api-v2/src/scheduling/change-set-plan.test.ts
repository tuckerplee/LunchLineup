import { describe, expect, it } from 'vitest';
import { ProblemError } from '../platform/problem';
import { planScheduleChangeSet, type PlannedShift } from './change-set-plan';

const scheduleStart = new Date('2026-07-18T00:00:00.000Z');
const scheduleEnd = new Date('2026-07-20T00:00:00.000Z');
const userA = { internalId: 'user-a', publicId: '11111111-1111-4111-8111-111111111111' };
const userB = { internalId: 'user-b', publicId: '22222222-2222-4222-8222-222222222222' };
const shiftAId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const shiftBId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function shift(
  publicId: string,
  user: typeof userA,
  start: string,
  end: string,
): PlannedShift {
  return {
    internalId: `internal-${publicId}`,
    publicId,
    userInternalId: user.internalId,
    userPublicId: user.publicId,
    startTime: new Date(start),
    endTime: new Date(end),
    role: 'STAFF',
    breaks: [],
    sourcePointer: '/saved',
  };
}

describe('schedule change-set final-state planner', () => {
  it('accepts an atomic two-shift assignment swap', () => {
    const plan = planScheduleChangeSet({
      scheduleStart,
      scheduleEnd,
      currentShifts: [
        shift(shiftAId, userA, '2026-07-18T08:00:00.000Z', '2026-07-18T12:00:00.000Z'),
        shift(shiftBId, userB, '2026-07-18T08:00:00.000Z', '2026-07-18T12:00:00.000Z'),
      ],
      externalShifts: [],
      usersByPublicId: new Map([[userA.publicId, userA], [userB.publicId, userB]]),
      operations: [
        { op: 'shift.update', shiftId: shiftAId, userId: userB.publicId },
        { op: 'shift.update', shiftId: shiftBId, userId: userA.publicId },
      ],
    });

    expect(plan.mutations).toHaveLength(2);
    expect(plan.finalShifts.find((item) => item.publicId === shiftAId)?.userPublicId).toBe(userB.publicId);
  });

  it('rejects overlap in the final aggregate with a 422 machine code', () => {
    expect(() => planScheduleChangeSet({
      scheduleStart,
      scheduleEnd,
      currentShifts: [
        shift(shiftAId, userA, '2026-07-18T08:00:00.000Z', '2026-07-18T12:00:00.000Z'),
        shift(shiftBId, userB, '2026-07-18T12:00:00.000Z', '2026-07-18T16:00:00.000Z'),
      ],
      externalShifts: [],
      usersByPublicId: new Map([[userA.publicId, userA], [userB.publicId, userB]]),
      operations: [{
        op: 'shift.update',
        shiftId: shiftBId,
        userId: userA.publicId,
        startTime: '2026-07-18T10:00:00.000Z',
      }],
    })).toThrowError(expect.objectContaining<Partial<ProblemError>>({
      status: 422,
      code: 'schedule_overlap',
    }));
  });

  it('moves dependent breaks by the same offset', () => {
    const withBreak = shift(
      shiftAId,
      userA,
      '2026-07-18T08:00:00.000Z',
      '2026-07-18T16:00:00.000Z',
    );
    withBreak.breaks = [{
      internalId: 'break-1',
      startTime: new Date('2026-07-18T12:00:00.000Z'),
      endTime: new Date('2026-07-18T12:30:00.000Z'),
    }];
    const plan = planScheduleChangeSet({
      scheduleStart,
      scheduleEnd,
      currentShifts: [withBreak],
      externalShifts: [],
      usersByPublicId: new Map([[userA.publicId, userA]]),
      operations: [{
        op: 'shift.update',
        shiftId: shiftAId,
        startTime: '2026-07-18T09:00:00.000Z',
        endTime: '2026-07-18T17:00:00.000Z',
      }],
    });
    expect(plan.finalShifts[0].breaks[0].startTime.toISOString()).toBe('2026-07-18T13:00:00.000Z');
  });

  it('rejects a stale staff reference before mutation planning', () => {
    expect(() => planScheduleChangeSet({
      scheduleStart,
      scheduleEnd,
      currentShifts: [shift(shiftAId, userA, '2026-07-18T08:00:00.000Z', '2026-07-18T12:00:00.000Z')],
      externalShifts: [],
      usersByPublicId: new Map(),
      operations: [{ op: 'shift.update', shiftId: shiftAId, userId: userB.publicId }],
    })).toThrowError(expect.objectContaining<Partial<ProblemError>>({
      code: 'staff_not_schedulable',
    }));
  });
});
