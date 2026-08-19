import { randomUUID } from 'node:crypto';
import type { ScheduleChangeSetRequest } from '@lunchlineup/api-contract';
import { ProblemError } from '../platform/problem';
import { normalizedRole, parseUtcInstant } from './contract-helpers';

export type PlannedBreak = {
  internalId: string;
  startTime: Date;
  endTime: Date;
};

export type PlannedShift = {
  internalId: string | null;
  publicId: string;
  userInternalId: string | null;
  userPublicId: string | null;
  startTime: Date;
  endTime: Date;
  role: string | null;
  breaks: PlannedBreak[];
  sourcePointer: string;
};

export type ResolvedUser = {
  internalId: string;
  publicId: string;
};

export type ExternalShift = {
  internalId: string;
  userInternalId: string;
  startTime: Date;
  endTime: Date;
};

export type ShiftMutation =
  | { kind: 'create'; after: PlannedShift; clientId: string | null }
  | { kind: 'update'; before: PlannedShift; after: PlannedShift }
  | { kind: 'delete'; before: PlannedShift };

export type ChangeSetPlan = {
  finalShifts: PlannedShift[];
  mutations: ShiftMutation[];
  created: Array<{ clientId: string | null; shiftId: string }>;
};

type PlanInput = {
  scheduleStart: Date;
  scheduleEnd: Date;
  currentShifts: PlannedShift[];
  externalShifts: ExternalShift[];
  usersByPublicId: ReadonlyMap<string, ResolvedUser>;
  operations: ScheduleChangeSetRequest['operations'];
  idFactory?: () => string;
};

function overlaps(left: Pick<PlannedShift, 'startTime' | 'endTime'>, right: Pick<PlannedShift, 'startTime' | 'endTime'>): boolean {
  return left.startTime < right.endTime && left.endTime > right.startTime;
}

function userFor(
  publicId: string | null,
  usersByPublicId: ReadonlyMap<string, ResolvedUser>,
  pointer: string,
): ResolvedUser | null {
  if (publicId === null) return null;
  const user = usersByPublicId.get(publicId);
  if (!user) {
    throw new ProblemError(
      422,
      'staff_not_schedulable',
      'A change references a staff member who is not active and schedulable in this workspace.',
      'Schedule validation failed',
      [{ pointer, code: 'staff_not_schedulable', message: 'Choose an active manager or staff member.' }],
    );
  }
  return user;
}

function translatedBreaks(before: PlannedShift, nextStart: Date, nextEnd: Date, pointer: string): PlannedBreak[] {
  const deltaMs = nextStart.getTime() - before.startTime.getTime();
  const translated = before.breaks.map((item) => ({
    ...item,
    startTime: new Date(item.startTime.getTime() + deltaMs),
    endTime: new Date(item.endTime.getTime() + deltaMs),
  }));
  if (translated.some((item) => item.startTime < nextStart || item.endTime > nextEnd)) {
    throw new ProblemError(
      422,
      'break_outside_shift',
      'Moving this shift would place one of its saved breaks outside the shift window.',
      'Schedule validation failed',
      [{ pointer, code: 'break_outside_shift', message: 'Adjust the shift or its breaks before moving it.' }],
    );
  }
  return translated;
}

function validateWindow(
  shift: PlannedShift,
  scheduleStart: Date,
  scheduleEnd: Date,
): void {
  if (shift.endTime <= shift.startTime) {
    throw new ProblemError(
      422,
      'invalid_shift_window',
      'Shift end time must be after its start time.',
      'Schedule validation failed',
      [{ pointer: shift.sourcePointer, code: 'invalid_shift_window', message: 'End time must be after start time.' }],
    );
  }
  if (shift.startTime < scheduleStart || shift.endTime > scheduleEnd) {
    throw new ProblemError(
      422,
      'shift_outside_schedule',
      'Every shift must stay inside the selected schedule window.',
      'Schedule validation failed',
      [{ pointer: shift.sourcePointer, code: 'shift_outside_schedule', message: 'Keep the shift inside its schedule.' }],
    );
  }
}

function sameShift(left: PlannedShift, right: PlannedShift): boolean {
  return left.userInternalId === right.userInternalId
    && left.startTime.getTime() === right.startTime.getTime()
    && left.endTime.getTime() === right.endTime.getTime()
    && left.role === right.role
    && left.breaks.every((item, index) => (
      item.startTime.getTime() === right.breaks[index]?.startTime.getTime()
      && item.endTime.getTime() === right.breaks[index]?.endTime.getTime()
    ));
}

export function planScheduleChangeSet(input: PlanInput): ChangeSetPlan {
  const idFactory = input.idFactory ?? randomUUID;
  const byPublicId = new Map(input.currentShifts.map((shift) => [shift.publicId, shift]));
  const working = new Map(input.currentShifts.map((shift) => [shift.publicId, shift]));
  const touched = new Set<string>();
  const clientIds = new Set<string>();
  const mutations: ShiftMutation[] = [];
  const created: Array<{ clientId: string | null; shiftId: string }> = [];

  input.operations.forEach((operation, index) => {
    const pointer = `/operations/${index}`;
    if (operation.op === 'shift.create') {
      const clientId = operation.clientId ?? null;
      if (clientId && clientIds.has(clientId)) {
        throw new ProblemError(
          422,
          'duplicate_client_id',
          'Each created shift must use a unique clientId.',
          'Schedule validation failed',
          [{ pointer, code: 'duplicate_client_id', message: 'clientId is duplicated in this change set.' }],
        );
      }
      if (clientId) clientIds.add(clientId);
      const user = userFor(operation.userId, input.usersByPublicId, `${pointer}/userId`);
      const shift: PlannedShift = {
        internalId: null,
        publicId: idFactory(),
        userInternalId: user?.internalId ?? null,
        userPublicId: user?.publicId ?? null,
        startTime: parseUtcInstant(operation.startTime, `${pointer}/startTime`),
        endTime: parseUtcInstant(operation.endTime, `${pointer}/endTime`),
        role: normalizedRole(operation.role) ?? null,
        breaks: [],
        sourcePointer: pointer,
      };
      working.set(shift.publicId, shift);
      mutations.push({ kind: 'create', after: shift, clientId });
      created.push({ clientId, shiftId: shift.publicId });
      return;
    }

    if (touched.has(operation.shiftId)) {
      throw new ProblemError(
        422,
        'duplicate_shift_operation',
        'A shift can appear only once in a change set.',
        'Schedule validation failed',
        [{ pointer, code: 'duplicate_shift_operation', message: 'Combine this shift change into one operation.' }],
      );
    }
    touched.add(operation.shiftId);
    const before = byPublicId.get(operation.shiftId);
    if (!before) {
      throw new ProblemError(
        404,
        'shift_not_found',
        'A referenced shift was not found in the selected schedule.',
        'Shift not found',
      );
    }
    if (operation.op === 'shift.delete') {
      working.delete(operation.shiftId);
      mutations.push({ kind: 'delete', before });
      return;
    }

    const nextStart = operation.startTime
      ? parseUtcInstant(operation.startTime, `${pointer}/startTime`)
      : before.startTime;
    const nextEnd = operation.endTime
      ? parseUtcInstant(operation.endTime, `${pointer}/endTime`)
      : before.endTime;
    const user = operation.userId === undefined
      ? {
          internalId: before.userInternalId,
          publicId: before.userPublicId,
        }
      : userFor(operation.userId, input.usersByPublicId, `${pointer}/userId`);
    const after: PlannedShift = {
      ...before,
      userInternalId: user?.internalId ?? null,
      userPublicId: user?.publicId ?? null,
      startTime: nextStart,
      endTime: nextEnd,
      role: operation.role === undefined ? before.role : normalizedRole(operation.role) ?? null,
      breaks: translatedBreaks(before, nextStart, nextEnd, pointer),
      sourcePointer: pointer,
    };
    working.set(operation.shiftId, after);
    if (!sameShift(before, after)) mutations.push({ kind: 'update', before, after });
  });

  if (mutations.length === 0) {
    throw new ProblemError(
      422,
      'no_effective_changes',
      'The change set does not change the saved schedule.',
      'No changes',
    );
  }

  const finalShifts = [...working.values()];
  for (const shift of finalShifts) validateWindow(shift, input.scheduleStart, input.scheduleEnd);

  const assigned = finalShifts
    .filter((shift): shift is PlannedShift & { userInternalId: string } => Boolean(shift.userInternalId))
    .sort((left, right) => (
      left.userInternalId.localeCompare(right.userInternalId)
      || left.startTime.getTime() - right.startTime.getTime()
      || left.publicId.localeCompare(right.publicId)
    ));
  for (let index = 1; index < assigned.length; index += 1) {
    const previous = assigned[index - 1];
    const current = assigned[index];
    if (current.userInternalId === previous.userInternalId && overlaps(previous, current)) {
      throw new ProblemError(
        422,
        'schedule_overlap',
        'The requested final schedule contains overlapping assigned shifts.',
        'Schedule overlap',
        [{
          pointer: current.sourcePointer,
          code: 'shift_overlap',
          message: 'This staff member would have overlapping shifts.',
        }],
      );
    }
  }

  for (const shift of assigned) {
    const conflict = input.externalShifts.find((external) => (
      external.userInternalId === shift.userInternalId && overlaps(shift, external)
    ));
    if (conflict) {
      throw new ProblemError(
        422,
        'schedule_overlap',
        'The requested final schedule overlaps another saved shift for this staff member.',
        'Schedule overlap',
        [{
          pointer: shift.sourcePointer,
          code: 'external_shift_overlap',
          message: 'This staff member already has a shift during that time.',
        }],
      );
    }
  }

  return { finalShifts, mutations, created };
}
