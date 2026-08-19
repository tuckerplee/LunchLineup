import { describe, expect, it } from 'vitest';

import {
  SCHEDULER_POINTER_ACTIVATION_PX,
  SCHEDULER_TOUCH_ACTIVATION_DELAY_MS,
  resolveSchedulerDrop,
  resourceIdFromSchedulerDroppable,
  schedulerBoardId,
  schedulerDeltaHours,
  schedulerDroppableId,
  schedulerPointerActivated,
} from '../../components/scheduling/scheduler-gesture';

describe('scheduler pointer activation', () => {
  it('keeps clicks and slight movement below the eight-pixel drag threshold', () => {
    expect(SCHEDULER_POINTER_ACTIVATION_PX).toBe(8);
    expect(schedulerPointerActivated(10, 10, 17, 10)).toBe(false);
    expect(schedulerPointerActivated(10, 10, 15, 15)).toBe(false);
    expect(schedulerPointerActivated(10, 10, 18, 10)).toBe(true);
  });

  it('uses a deliberate delayed activation for the touch-only handle', () => {
    expect(SCHEDULER_TOUCH_ACTIVATION_DELAY_MS).toBeGreaterThanOrEqual(250);
    expect(SCHEDULER_TOUCH_ACTIVATION_DELAY_MS).toBeLessThanOrEqual(500);
  });

  it('quantizes horizontal movement to the existing 15-minute callback contract', () => {
    expect(schedulerDeltaHours(7, 56)).toBe(0.25);
    expect(schedulerDeltaHours(-28, 56)).toBe(-0.5);
    expect(schedulerDeltaHours(12, 0)).toBe(0);
  });
});

describe('scheduler board-scoped targets', () => {
  it('round-trips explicit semantic IDs only for the owning board', () => {
    const boardId = schedulerBoardId(':r7:');
    const droppableId = schedulerDroppableId(boardId, 'person/one@example.test');

    expect(boardId).toBe('staff-schedule-r7');
    expect(droppableId).toBe('staff-schedule-r7::staff::person%2Fone%40example.test');
    expect(resourceIdFromSchedulerDroppable(boardId, droppableId)).toBe('person/one@example.test');
    expect(resourceIdFromSchedulerDroppable('staff-schedule-other', droppableId)).toBeNull();
  });
});

describe('scheduler drop safety', () => {
  const validDrop = {
    active: true,
    insideBoard: true,
    locked: false,
    callbackAvailable: true,
    sourceResourceId: 'person-a',
    targetResourceId: 'person-b',
    deltaHours: 0.25,
  } as const;

  it('applies an activated, changed drop to the exact target person', () => {
    expect(resolveSchedulerDrop(validDrop)).toEqual({ kind: 'apply', resourceId: 'person-b' });
  });

  it.each([
    ['not activated', { ...validDrop, active: false }, 'inactive'],
    ['outside release', { ...validDrop, insideBoard: false, targetResourceId: null }, 'outside-board'],
    ['published lock', { ...validDrop, locked: true }, 'locked'],
    ['missing callback', { ...validDrop, callbackAvailable: false }, 'unavailable'],
    ['unchanged release', {
      ...validDrop,
      targetResourceId: validDrop.sourceResourceId,
      deltaHours: 0,
    }, 'no-change'],
  ] as const)('cancels %s without producing an apply decision', (_label, input, reason) => {
    expect(resolveSchedulerDrop(input)).toEqual({ kind: 'cancel', reason });
  });
});
