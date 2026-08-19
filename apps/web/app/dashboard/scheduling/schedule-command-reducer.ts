export type ShiftPlacementSnapshot = {
  id: string;
  scheduleId: string;
  startTime: string;
  endTime: string;
  userId: string | null;
};

export type ScheduleCommandKind = 'move' | 'copy' | 'delete' | 'undo';
export type ScheduleCommandPhase = 'saving' | 'confirming' | 'saved' | 'failed' | 'undone';

export type ScheduleCommandFeedback = {
  commandId: string;
  shiftId: string;
  kind: ScheduleCommandKind;
  phase: ScheduleCommandPhase;
  message: string;
  before: ShiftPlacementSnapshot | null;
  requested: ShiftPlacementSnapshot | null;
  canUndo: boolean;
  updatedAt: number;
};

export type ScheduleCommandState = {
  byShiftId: Record<string, ScheduleCommandFeedback>;
};

export type ScheduleCommandAction =
  | { type: 'begin'; feedback: ScheduleCommandFeedback }
  | {
      type: 'transition';
      shiftId: string;
      commandId: string;
      phase: ScheduleCommandPhase;
      message: string;
      canUndo?: boolean;
      updatedAt: number;
    }
  | { type: 'dismiss'; shiftId: string; commandId?: string }
  | { type: 'clear' };

export const EMPTY_SCHEDULE_COMMAND_STATE: ScheduleCommandState = { byShiftId: {} };

export function scheduleCommandReducer(
  state: ScheduleCommandState,
  action: ScheduleCommandAction,
): ScheduleCommandState {
  if (action.type === 'clear') return EMPTY_SCHEDULE_COMMAND_STATE;
  if (action.type === 'begin') {
    return {
      byShiftId: {
        ...state.byShiftId,
        [action.feedback.shiftId]: action.feedback,
      },
    };
  }
  const current = state.byShiftId[action.shiftId];
  if (!current || (action.commandId && current.commandId !== action.commandId)) return state;
  if (action.type === 'dismiss') {
    const next = { ...state.byShiftId };
    delete next[action.shiftId];
    return { byShiftId: next };
  }
  return {
    byShiftId: {
      ...state.byShiftId,
      [action.shiftId]: {
        ...current,
        phase: action.phase,
        message: action.message,
        canUndo: action.canUndo ?? current.canUndo,
        updatedAt: action.updatedAt,
      },
    },
  };
}

export function shiftPlacementMatches(
  shift: Pick<ShiftPlacementSnapshot, 'id' | 'scheduleId' | 'startTime' | 'endTime' | 'userId'> | null | undefined,
  expected: ShiftPlacementSnapshot | null | undefined,
): boolean {
  return Boolean(
    shift
    && expected
    && shift.id === expected.id
    && shift.scheduleId === expected.scheduleId
    && shift.startTime === expected.startTime
    && shift.endTime === expected.endTime
    && shift.userId === expected.userId,
  );
}

