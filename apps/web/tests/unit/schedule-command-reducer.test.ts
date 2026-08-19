import { describe, expect, it } from 'vitest';
import {
  EMPTY_SCHEDULE_COMMAND_STATE,
  scheduleCommandReducer,
  shiftPlacementMatches,
  type ScheduleCommandFeedback,
} from '../../app/dashboard/scheduling/schedule-command-reducer';

const before = {
  id: 'shift-1',
  scheduleId: 'schedule-1',
  startTime: '2026-08-20T16:00:00.000Z',
  endTime: '2026-08-21T00:00:00.000Z',
  userId: 'staff-1',
};

const requested = {
  ...before,
  startTime: '2026-08-20T16:30:00.000Z',
  endTime: '2026-08-21T00:30:00.000Z',
  userId: 'staff-2',
};

function saving(): ScheduleCommandFeedback {
  return {
    commandId: 'command-1',
    shiftId: before.id,
    kind: 'move',
    phase: 'saving',
    message: 'Saving move...',
    before,
    requested,
    canUndo: false,
    updatedAt: 1,
  };
}

describe('schedule command reducer', () => {
  it('keeps one latest command per shift and ignores stale completions', () => {
    const started = scheduleCommandReducer(EMPTY_SCHEDULE_COMMAND_STATE, {
      type: 'begin',
      feedback: saving(),
    });
    const replaced = scheduleCommandReducer(started, {
      type: 'begin',
      feedback: { ...saving(), commandId: 'command-2', updatedAt: 2 },
    });
    const stale = scheduleCommandReducer(replaced, {
      type: 'transition',
      shiftId: before.id,
      commandId: 'command-1',
      phase: 'failed',
      message: 'Stale failure',
      updatedAt: 3,
    });

    expect(stale.byShiftId[before.id]).toMatchObject({
      commandId: 'command-2',
      phase: 'saving',
    });
  });

  it('exposes Undo only after an authoritative save and dismisses by identity', () => {
    const started = scheduleCommandReducer(EMPTY_SCHEDULE_COMMAND_STATE, {
      type: 'begin',
      feedback: saving(),
    });
    const saved = scheduleCommandReducer(started, {
      type: 'transition',
      shiftId: before.id,
      commandId: 'command-1',
      phase: 'saved',
      message: 'Saved.',
      canUndo: true,
      updatedAt: 2,
    });
    expect(saved.byShiftId[before.id]).toMatchObject({ phase: 'saved', canUndo: true });
    expect(scheduleCommandReducer(saved, {
      type: 'dismiss',
      shiftId: before.id,
      commandId: 'different-command',
    })).toBe(saved);
    expect(scheduleCommandReducer(saved, {
      type: 'dismiss',
      shiftId: before.id,
      commandId: 'command-1',
    }).byShiftId).toEqual({});
  });

  it('matches the complete server-relevant placement before allowing inverse commands', () => {
    expect(shiftPlacementMatches(requested, requested)).toBe(true);
    expect(shiftPlacementMatches({ ...requested, endTime: '2026-08-21T01:00:00.000Z' }, requested)).toBe(false);
    expect(shiftPlacementMatches({ ...requested, userId: null }, requested)).toBe(false);
    expect(shiftPlacementMatches(null, requested)).toBe(false);
  });
});

