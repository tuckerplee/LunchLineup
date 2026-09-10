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
  it('preserves the exact saved custom role when an update omits role', () => {
    const saved = shift(
      shiftAId,
      userA,
      '2026-07-18T08:00:00.000Z',
      '2026-07-18T12:00:00.000Z',
    );
    saved.role = 'Barista';

    const plan = planScheduleChangeSet({
      scheduleStart,
      scheduleEnd,
      currentShifts: [saved],
      externalShifts: [],
      usersByPublicId: new Map([[userA.publicId, userA]]),
      operations: [{
        op: 'shift.update',
        shiftId: shiftAId,
        endTime: '2026-07-18T12:15:00.000Z',
      }],
    });

    expect(plan.finalShifts[0].role).toBe('Barista');
  });

  it('trims an explicitly changed custom role without changing its casing', () => {
    const plan = planScheduleChangeSet({
      scheduleStart,
      scheduleEnd,
      currentShifts: [
        shift(shiftAId, userA, '2026-07-18T08:00:00.000Z', '2026-07-18T12:00:00.000Z'),
      ],
      externalShifts: [],
      usersByPublicId: new Map([[userA.publicId, userA]]),
      operations: [{
        op: 'shift.update',
        shiftId: shiftAId,
        role: '  Shift Lead  ',
      }],
    });

    expect(plan.finalShifts[0].role).toBe('Shift Lead');
  });

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

describe('overnight start-day ownership', () => {
  const overnight = () => shift(shiftAId, userA, '2026-07-19T22:00:00Z', '2026-07-20T02:00:00Z');
  const input = () => ({ scheduleStart, scheduleEnd, currentShifts: [overnight()], externalShifts: [], usersByPublicId: new Map([[userA.publicId, userA]]), operations: [{ op: 'shift.update' as const, shiftId: shiftAId, role: 'Lead' }] });
  it('allows an overnight shift in its start-day schedule', () => {
    expect(planScheduleChangeSet(input()).finalShifts).toHaveLength(1);
  });
  it('rejects an overlap with a shift owned by the next schedule', () => {
    expect(() => planScheduleChangeSet({ ...input(), externalShifts: [{ internalId: 'next-day', userInternalId: userA.internalId, startTime: new Date('2026-07-20T01:00:00Z'), endTime: new Date('2026-07-20T05:00:00Z') }] })).toThrow();
  });
  it('allows an adjacent next-day shift without overlap', () => {
    expect(planScheduleChangeSet({ ...input(), externalShifts: [{ internalId: 'next-day', userInternalId: userA.internalId, startTime: new Date('2026-07-20T02:00:00Z'), endTime: new Date('2026-07-20T05:00:00Z') }] }).finalShifts).toHaveLength(1);
  });
  it.each([['2026-07-20T00:00:00Z','2026-07-20T04:00:00Z'], ['2026-07-19T22:00:00Z','2026-07-21T00:00:00Z']])('rejects another start-day or an overlong shift', (start, end) => {
    expect(() => planScheduleChangeSet({ ...input(), currentShifts: [shift(shiftAId,userA,start,end)] })).toThrow();
  });
});
