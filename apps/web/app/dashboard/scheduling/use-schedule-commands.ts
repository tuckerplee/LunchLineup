'use client';

import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  ApiV2ClientError,
  type ScheduleChangeSetRequest,
} from '@lunchlineup/api-contract';
import { apiV2 } from '@/lib/api-v2';
import {
  idempotentRequestAttempt,
  type IdempotentRequestAttempt,
} from '@/lib/client-api';
import { dateValueInTimeZone } from '@/lib/location-timezone';
import type { SchedulerViewMode } from '@/components/scheduling/StaffScheduler';
import { containingDraftScheduleForShift, fallbackDraftWindowForShift } from './manual-shift-schedule';
import type { LocationShiftScope } from './location-shift-scope';
import {
  beginShiftUpdateAttempt,
  clearShiftUpdateAttempt,
  scheduleChangeSetAttemptRequiresRotation,
} from './shift-update-recovery';
import {
  EMPTY_SCHEDULE_COMMAND_STATE,
  scheduleCommandReducer,
  shiftPlacementMatches,
  type ScheduleCommandFeedback,
  type ShiftPlacementSnapshot,
} from './schedule-command-reducer';

const UNASSIGNED_RESOURCE_ID = 'unassigned';
const UNDO_WINDOW_MS = 12_000;

export type ScheduleCommandShift = {
  id: string;
  userId: string | null;
  locationId: string;
  scheduleId?: string | null;
  startTime: string;
  endTime: string;
  role: string | null;
  user?: { id: string; name: string; role: string } | null;
};

export type ScheduleCommandSchedule = {
  id: string;
  locationId: string;
  startDate: string;
  endDate: string;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  revision: number;
  etag: string;
};

export type ScheduleCommandStaff = { id: string; name: string; role: string };
export type ScheduleCommandStatus = {
  tone: 'loading' | 'ready' | 'saving' | 'saved' | 'warning' | 'error';
  message: string;
};

type ScheduleCommandOptions<
  TShift extends ScheduleCommandShift,
  TSchedule extends ScheduleCommandSchedule,
  TStaff extends ScheduleCommandStaff,
> = {
  canWriteShifts: boolean;
  canDeleteShifts: boolean;
  locationDataCurrent: boolean;
  loadedShiftScope: LocationShiftScope | null;
  shifts: TShift[];
  schedules: TSchedule[];
  staff: TStaff[];
  selectedDate: string;
  viewMode: SchedulerViewMode;
  selectedLocationId: string;
  setShifts: Dispatch<SetStateAction<TShift[]>>;
  setSchedules: Dispatch<SetStateAction<TSchedule[]>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setScheduleStatus: Dispatch<SetStateAction<ScheduleCommandStatus>>;
  scopeIsStillSelected: (scope: LocationShiftScope) => boolean;
  locationTimeZone: (locationId: string) => string;
  isShiftLocked: (shift: TShift) => boolean;
  publishedScheduleForDraft: (locationId: string, dateValue: string) => TSchedule | undefined;
  scheduleLabel: (schedule: TSchedule, timeZone: string) => string;
  locationName: (locationId: string) => string;
  loadSchedule: (dateValue: string, viewMode: SchedulerViewMode, locationId?: string) => Promise<unknown>;
  onDeleteCommitted?: (shiftId: string) => void;
};

function snapshot(shift: ScheduleCommandShift): ShiftPlacementSnapshot | null {
  if (!shift.scheduleId) return null;
  return {
    id: shift.id,
    scheduleId: shift.scheduleId,
    startTime: shift.startTime,
    endTime: shift.endTime,
    userId: shift.userId,
  };
}

function requiresAttemptRotation(error: unknown): boolean {
  return error instanceof ApiV2ClientError
    && scheduleChangeSetAttemptRequiresRotation(error.status, error.problem.code);
}

async function replayOneAmbiguousTransport<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ApiV2ClientError) throw error;
    return operation();
  }
}

function statusTime(): string {
  return new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function readableTime(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(instant));
}

export function useScheduleCommands<
  TShift extends ScheduleCommandShift,
  TSchedule extends ScheduleCommandSchedule,
  TStaff extends ScheduleCommandStaff,
>(options: ScheduleCommandOptions<TShift, TSchedule, TStaff>) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [state, dispatch] = useReducer(scheduleCommandReducer, EMPTY_SCHEDULE_COMMAND_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const updateAttemptsRef = useRef<Record<string, IdempotentRequestAttempt>>({});
  const copyAttemptsRef = useRef<Record<string, IdempotentRequestAttempt>>({});
  const undoTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => () => {
    for (const timer of undoTimersRef.current.values()) clearTimeout(timer);
    undoTimersRef.current.clear();
  }, []);

  const transition = useCallback((
    shiftId: string,
    commandId: string,
    phase: ScheduleCommandFeedback['phase'],
    message: string,
    canUndo = false,
  ) => {
    dispatch({
      type: 'transition',
      shiftId,
      commandId,
      phase,
      message,
      canUndo,
      updatedAt: Date.now(),
    });
  }, []);

  const expireUndo = useCallback((shiftId: string, commandId: string) => {
    const previous = undoTimersRef.current.get(shiftId);
    if (previous) clearTimeout(previous);
    undoTimersRef.current.set(shiftId, setTimeout(() => {
      transition(shiftId, commandId, 'saved', 'Shift saved.', false);
      undoTimersRef.current.delete(shiftId);
    }, UNDO_WINDOW_MS));
  }, [transition]);

  const clearAttempt = useCallback((shiftId: string, commandId: string) => {
    clearShiftUpdateAttempt(window.sessionStorage, shiftId, commandId);
    if (updateAttemptsRef.current[shiftId]?.key === commandId) {
      delete updateAttemptsRef.current[shiftId];
    }
  }, []);

  const discardAttempt = useCallback((shiftId: string) => {
    const attempt = updateAttemptsRef.current[shiftId];
    if (attempt) clearShiftUpdateAttempt(window.sessionStorage, shiftId, attempt.key);
    delete updateAttemptsRef.current[shiftId];
  }, []);

  const replaceScheduleResult = useCallback((
    scheduleId: string,
    result: { revision: number; etag: string; shifts: unknown[] },
  ) => {
    const current = optionsRef.current;
    current.setSchedules((items) => items.map((item) => item.id === scheduleId
      ? { ...item, revision: result.revision, etag: result.etag }
      : item));
    current.setShifts((items) => [
      ...items.filter((item) => item.scheduleId !== scheduleId),
      ...(result.shifts as TShift[]),
    ]);
  }, []);

  const placementWithStaff = useCallback((
    current: TShift,
    placement: ShiftPlacementSnapshot,
  ): TShift => {
    const staffMember = placement.userId
      ? optionsRef.current.staff.find((person) => person.id === placement.userId) ?? null
      : null;
    return {
      ...current,
      startTime: placement.startTime,
      endTime: placement.endTime,
      userId: placement.userId,
      user: staffMember
        ? { id: staffMember.id, name: staffMember.name, role: staffMember.role }
        : null,
    };
  }, []);

  const restoreFullShift = useCallback((beforeShift: TShift) => {
    optionsRef.current.setShifts((items) => {
      if (!items.some((item) => item.id === beforeShift.id)) return [...items, beforeShift];
      return items.map((item) => item.id === beforeShift.id ? beforeShift : item);
    });
  }, []);

  const reconcileAuthoritative = useCallback(async (
    shiftId: string,
    commandId: string,
    message: string,
    locationId?: string,
  ) => {
    const current = optionsRef.current;
    transition(shiftId, commandId, 'confirming', message);
    current.setScheduleStatus({ tone: 'warning', message });
    try {
      await current.loadSchedule(current.selectedDate, current.viewMode, locationId || current.selectedLocationId || undefined);
      transition(shiftId, commandId, 'failed', 'Saved schedule reconciled. Review the shift before retrying.');
    } catch {
      transition(shiftId, commandId, 'failed', 'The shift could not be confirmed. Reload the board before retrying.');
    }
  }, [transition]);

  const updateShift = useCallback(async (id: string, start: string, end: string, userId: string) => {
    const current = optionsRef.current;
    if (!current.canWriteShifts || !current.locationDataCurrent || !current.loadedShiftScope) return;
    const writeScope = current.loadedShiftScope;
    const shift = current.shifts.find((item) => item.id === id);
    if (shift && current.isShiftLocked(shift)) {
      current.setError('Published schedules are locked. Create a new draft before changing shifts.');
      current.setScheduleStatus({ tone: 'warning', message: 'Published schedule shifts cannot be moved.' });
      return;
    }
    const schedule = current.schedules.find((item) => item.id === shift?.scheduleId);
    const before = shift ? snapshot(shift) : null;
    if (!shift || !schedule || !before) {
      current.setError('The shift schedule is no longer loaded.');
      return;
    }
    const nextUserId = userId === UNASSIGNED_RESOURCE_ID ? null : userId;
    const selectedStaff = nextUserId
      ? current.staff.find((person) => person.id === nextUserId) ?? null
      : null;
    if (nextUserId && !selectedStaff) {
      current.setError('The destination staff member is no longer available for scheduling.');
      return;
    }
    const requested: ShiftPlacementSnapshot = {
      ...before,
      startTime: start,
      endTime: end,
      userId: nextUserId,
    };
    const operation: ScheduleChangeSetRequest['operations'][number] = {
      op: 'shift.update',
      shiftId: id,
      startTime: start,
      endTime: end,
      userId: nextUserId,
    };
    const attempt = beginShiftUpdateAttempt(
      window.sessionStorage,
      id,
      { scheduleId: schedule.id, operation },
      updateAttemptsRef.current[id],
    );
    updateAttemptsRef.current[id] = attempt;
    const timeZone = current.locationTimeZone(shift.locationId);
    const targetName = selectedStaff?.name ?? 'Open shifts';
    const targetLabel = `${targetName}, ${readableTime(start, timeZone)}–${readableTime(end, timeZone)}`;
    current.setError(null);
    current.setScheduleStatus({ tone: 'saving', message: `Saving ${targetLabel}...` });
    dispatch({
      type: 'begin',
      feedback: {
        commandId: attempt.key,
        shiftId: id,
        kind: 'move',
        phase: 'saving',
        message: `Saving ${targetLabel}...`,
        before,
        requested,
        canUndo: false,
        updatedAt: Date.now(),
      },
    });
    current.setShifts((items) => items.map((item) => (
      item.id === id ? placementWithStaff(item, requested) : item
    )));

    try {
      const updated = await replayOneAmbiguousTransport(() => apiV2.applyScheduleChangeSet(
        schedule.id,
        { operations: [operation] },
        schedule.etag,
        attempt.key,
      ));
      clearAttempt(id, attempt.key);
      if (!current.scopeIsStillSelected(writeScope)) return;
      replaceScheduleResult(schedule.id, updated.data);
      const savedMessage = `Saved ${targetLabel} at ${statusTime()}.`;
      current.setScheduleStatus({ tone: 'saved', message: savedMessage });
      transition(id, attempt.key, 'saved', savedMessage, true);
      expireUndo(id, attempt.key);
    } catch (error) {
      const rotateAttempt = requiresAttemptRotation(error);
      if (rotateAttempt) discardAttempt(id);
      if (!current.scopeIsStillSelected(writeScope)) {
        transition(id, attempt.key, 'failed', 'Move outcome belongs to a different calendar view. Reload that schedule before retrying.');
        return;
      }
      if (rotateAttempt || (error instanceof ApiV2ClientError && error.status === 412)) {
        current.setShifts((items) => items.map((item) => item.id === id ? placementWithStaff(item, before) : item));
        await reconcileAuthoritative(
          id,
          attempt.key,
          rotateAttempt
            ? 'The move response could not be replayed. Confirming the saved shift...'
            : 'The schedule changed elsewhere. Restoring and reconciling this shift...',
          shift.locationId,
        );
        return;
      }
      if (!(error instanceof ApiV2ClientError)) {
        await reconcileAuthoritative(id, attempt.key, 'Connection interrupted. Confirming whether the shift was saved...', shift.locationId);
        return;
      }
      current.setShifts((items) => items.map((item) => item.id === id ? placementWithStaff(item, before) : item));
      const message = error.problem.detail || 'The move was rejected. The original shift was restored.';
      current.setError(message);
      current.setScheduleStatus({ tone: 'error', message: 'Move rejected. The original shift was restored.' });
      transition(id, attempt.key, 'failed', message);
    }
  }, [clearAttempt, discardAttempt, expireUndo, placementWithStaff, reconcileAuthoritative, replaceScheduleResult, transition]);

  const copyShift = useCallback(async (id: string, start: string, end: string, userId: string) => {
    const current = optionsRef.current;
    if (!current.canWriteShifts || !current.locationDataCurrent || !current.loadedShiftScope) return;
    const writeScope = current.loadedShiftScope;
    const sourceShift = current.shifts.find((item) => item.id === id);
    if (!sourceShift) {
      current.setError('The source shift is no longer loaded.');
      return;
    }
    const nextUserId = userId === UNASSIGNED_RESOURCE_ID ? null : userId;
    const selectedStaff = nextUserId
      ? current.staff.find((person) => person.id === nextUserId) ?? null
      : null;
    if (nextUserId && !selectedStaff) {
      current.setError('The destination staff member is no longer available for scheduling.');
      return;
    }
    const timeZone = current.locationTimeZone(sourceShift.locationId);
    const targetDate = dateValueInTimeZone(start, timeZone);
    const lockedSchedule = current.publishedScheduleForDraft(sourceShift.locationId, targetDate);
    if (lockedSchedule) {
      current.setError(`Published schedules are locked for ${current.scheduleLabel(lockedSchedule, timeZone)} at ${current.locationName(sourceShift.locationId)}.`);
      current.setScheduleStatus({ tone: 'warning', message: 'Copy into a draft schedule or reopen the published target first.' });
      return;
    }
    const request = {
      sourceShiftId: sourceShift.id,
      locationId: sourceShift.locationId,
      userId: nextUserId,
      role: sourceShift.role,
      startTime: start,
      endTime: end,
    };
    const attempt = idempotentRequestAttempt(request, copyAttemptsRef.current[id]);
    copyAttemptsRef.current[id] = attempt;
    const targetName = selectedStaff?.name ?? 'Open shifts';
    const targetLabel = `${targetName}, ${readableTime(start, timeZone)}–${readableTime(end, timeZone)}`;
    dispatch({
      type: 'begin',
      feedback: {
        commandId: attempt.key,
        shiftId: id,
        kind: 'copy',
        phase: 'saving',
        message: `Copying to ${targetLabel}...`,
        before: snapshot(sourceShift),
        requested: null,
        canUndo: false,
        updatedAt: Date.now(),
      },
    });
    current.setError(null);
    current.setScheduleStatus({ tone: 'saving', message: `Copying to ${targetLabel}...` });
    try {
      let schedule = containingDraftScheduleForShift(
        current.schedules,
        sourceShift.locationId,
        start,
        end,
      ) as TSchedule | null;
      if (!schedule) {
        const scheduleRange = fallbackDraftWindowForShift(start, end, timeZone);
        const created = await apiV2.createSchedule(
          sourceShift.locationId,
          { startDate: scheduleRange.start, endDate: scheduleRange.end },
          `${attempt.key}:schedule`,
        );
        schedule = created.data as unknown as TSchedule;
        if (current.scopeIsStillSelected(writeScope)) {
          current.setSchedules((items) => items.some((item) => item.id === schedule!.id)
            ? items
            : [...items, schedule!]);
        }
      }
      const operation: ScheduleChangeSetRequest['operations'][number] = {
        op: 'shift.create',
        clientId: attempt.key,
        userId: nextUserId,
        role: sourceShift.role,
        startTime: start,
        endTime: end,
      };
      const copied = await replayOneAmbiguousTransport(() => apiV2.applyScheduleChangeSet(
        schedule!.id,
        { operations: [operation] },
        schedule!.etag,
        `${attempt.key}:shift`,
      ));
      if (copyAttemptsRef.current[id]?.key === attempt.key) delete copyAttemptsRef.current[id];
      if (!current.scopeIsStillSelected(writeScope)) return;
      replaceScheduleResult(schedule.id, copied.data);
      const message = `Copied to ${targetLabel} at ${statusTime()}.`;
      current.setScheduleStatus({ tone: 'saved', message });
      transition(id, attempt.key, 'saved', message);
    } catch (error) {
      const rotateAttempt = requiresAttemptRotation(error);
      if (rotateAttempt) delete copyAttemptsRef.current[id];
      if (!current.scopeIsStillSelected(writeScope)) {
        transition(id, attempt.key, 'failed', 'Copy outcome belongs to a different calendar view. Reload that schedule before retrying.');
        return;
      }
      const message = rotateAttempt
        ? 'The copy response could not be replayed. Reload the draft before retrying.'
        : error instanceof ApiV2ClientError
          ? error.problem.detail || 'The shift could not be copied.'
          : 'Connection interrupted while copying. Reload the board to confirm the result.';
      current.setError(message);
      current.setScheduleStatus({ tone: rotateAttempt ? 'warning' : 'error', message });
      transition(id, attempt.key, 'failed', message);
      if (rotateAttempt || !(error instanceof ApiV2ClientError) || error.status === 412) {
        await current.loadSchedule(current.selectedDate, current.viewMode, sourceShift.locationId);
      }
    }
  }, [replaceScheduleResult, transition]);

  const deleteShift = useCallback(async (id: string) => {
    const current = optionsRef.current;
    if (!current.canDeleteShifts) {
      current.setError('You need shift delete access to remove shifts.');
      return;
    }
    if (!current.locationDataCurrent || !current.loadedShiftScope) return;
    const writeScope = current.loadedShiftScope;
    const shift = current.shifts.find((item) => item.id === id);
    if (!shift) return;
    if (current.isShiftLocked(shift)) {
      current.setError('Published schedules are locked. Create a new draft before deleting shifts.');
      current.setScheduleStatus({ tone: 'warning', message: 'Published schedule shifts cannot be deleted.' });
      return;
    }
    const schedule = current.schedules.find((item) => item.id === shift.scheduleId);
    const before = snapshot(shift);
    if (!schedule || !before) {
      current.setError('The shift schedule is no longer loaded.');
      return;
    }
    const operation: ScheduleChangeSetRequest['operations'][number] = { op: 'shift.delete', shiftId: id };
    const attempt = beginShiftUpdateAttempt(
      window.sessionStorage,
      id,
      { scheduleId: schedule.id, operation },
      updateAttemptsRef.current[id],
    );
    updateAttemptsRef.current[id] = attempt;
    dispatch({
      type: 'begin',
      feedback: {
        commandId: attempt.key,
        shiftId: id,
        kind: 'delete',
        phase: 'saving',
        message: 'Deleting shift...',
        before,
        requested: null,
        canUndo: false,
        updatedAt: Date.now(),
      },
    });
    current.setError(null);
    current.setScheduleStatus({ tone: 'saving', message: 'Deleting shift...' });
    current.setShifts((items) => items.filter((item) => item.id !== id));
    try {
      const deleted = await replayOneAmbiguousTransport(() => apiV2.applyScheduleChangeSet(
        schedule.id,
        { operations: [operation] },
        schedule.etag,
        attempt.key,
      ));
      clearAttempt(id, attempt.key);
      if (!current.scopeIsStillSelected(writeScope)) return;
      replaceScheduleResult(schedule.id, deleted.data);
      current.onDeleteCommitted?.(id);
      const message = `Shift deleted at ${statusTime()}.`;
      current.setScheduleStatus({ tone: 'saved', message });
      transition(id, attempt.key, 'saved', message);
    } catch (error) {
      const rotateAttempt = requiresAttemptRotation(error);
      if (rotateAttempt) discardAttempt(id);
      if (!current.scopeIsStillSelected(writeScope)) {
        transition(id, attempt.key, 'failed', 'Delete outcome belongs to a different calendar view. Reload that schedule before retrying.');
        return;
      }
      restoreFullShift(shift);
      if (rotateAttempt || !(error instanceof ApiV2ClientError) || error.status === 412) {
        await reconcileAuthoritative(id, attempt.key, 'Delete outcome was uncertain. Reconciling the saved schedule...', shift.locationId);
        return;
      }
      const message = error.problem.detail || 'Delete rejected. The original shift was restored.';
      current.setError(message);
      current.setScheduleStatus({ tone: 'error', message: 'Delete rejected. The original shift was restored.' });
      transition(id, attempt.key, 'failed', message);
    }
  }, [clearAttempt, discardAttempt, reconcileAuthoritative, replaceScheduleResult, restoreFullShift, transition]);

  const undoShift = useCallback(async (shiftId: string) => {
    const current = optionsRef.current;
    const feedback = stateRef.current.byShiftId[shiftId];
    if (
      !feedback
      || feedback.kind !== 'move'
      || feedback.phase !== 'saved'
      || !feedback.canUndo
      || !feedback.before
      || !feedback.requested
    ) return;
    const currentShift = current.shifts.find((item) => item.id === shiftId);
    if (!shiftPlacementMatches(currentShift ? {
      ...currentShift,
      scheduleId: currentShift.scheduleId ?? '',
    } : null, feedback.requested)) {
      transition(shiftId, feedback.commandId, 'failed', 'Undo expired because the shift changed again.');
      return;
    }
    const schedule = current.schedules.find((item) => item.id === feedback.before!.scheduleId);
    if (!schedule || schedule.status !== 'DRAFT') {
      transition(shiftId, feedback.commandId, 'failed', 'Undo is unavailable because the schedule is no longer an editable draft.');
      return;
    }
    const timer = undoTimersRef.current.get(shiftId);
    if (timer) clearTimeout(timer);
    undoTimersRef.current.delete(shiftId);
    const operation: ScheduleChangeSetRequest['operations'][number] = {
      op: 'shift.update',
      shiftId,
      startTime: feedback.before.startTime,
      endTime: feedback.before.endTime,
      userId: feedback.before.userId,
    };
    const attempt = beginShiftUpdateAttempt(
      window.sessionStorage,
      shiftId,
      { scheduleId: schedule.id, operation },
      undefined,
    );
    updateAttemptsRef.current[shiftId] = attempt;
    dispatch({
      type: 'begin',
      feedback: {
        commandId: attempt.key,
        shiftId,
        kind: 'undo',
        phase: 'saving',
        message: 'Undoing saved move...',
        before: feedback.requested,
        requested: feedback.before,
        canUndo: false,
        updatedAt: Date.now(),
      },
    });
    current.setShifts((items) => items.map((item) => (
      item.id === shiftId ? placementWithStaff(item, feedback.before!) : item
    )));
    current.setScheduleStatus({ tone: 'saving', message: 'Undoing saved move...' });
    try {
      const undone = await replayOneAmbiguousTransport(() => apiV2.applyScheduleChangeSet(
        schedule.id,
        { operations: [operation] },
        schedule.etag,
        attempt.key,
      ));
      clearAttempt(shiftId, attempt.key);
      replaceScheduleResult(schedule.id, undone.data);
      const message = `Move undone at ${statusTime()}.`;
      current.setScheduleStatus({ tone: 'saved', message });
      transition(shiftId, attempt.key, 'undone', message);
    } catch (error) {
      current.setShifts((items) => items.map((item) => (
        item.id === shiftId ? placementWithStaff(item, feedback.requested!) : item
      )));
      if (requiresAttemptRotation(error)) discardAttempt(shiftId);
      if (!(error instanceof ApiV2ClientError) || error.status === 412 || requiresAttemptRotation(error)) {
        await reconcileAuthoritative(shiftId, attempt.key, 'Undo outcome was uncertain. Reconciling the saved schedule...', currentShift?.locationId);
        return;
      }
      const message = error.problem.detail || 'Undo was rejected. The saved move remains in place.';
      current.setError(message);
      current.setScheduleStatus({ tone: 'error', message: 'Undo rejected. The saved move remains in place.' });
      transition(shiftId, attempt.key, 'failed', message);
    }
  }, [clearAttempt, discardAttempt, placementWithStaff, reconcileAuthoritative, replaceScheduleResult, transition]);

  const dismissFeedback = useCallback((shiftId: string, commandId: string) => {
    const timer = undoTimersRef.current.get(shiftId);
    if (timer) clearTimeout(timer);
    undoTimersRef.current.delete(shiftId);
    dispatch({ type: 'dismiss', shiftId, commandId });
  }, []);

  return {
    commandState: state,
    updateShift,
    copyShift,
    deleteShift,
    undoShift,
    dismissFeedback,
  };
}
