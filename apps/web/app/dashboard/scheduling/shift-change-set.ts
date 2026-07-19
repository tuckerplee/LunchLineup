import type { ScheduleChangeSetRequest } from '@lunchlineup/api-contract';

type ShiftUpdateOperation = Extract<
  ScheduleChangeSetRequest['operations'][number],
  { op: 'shift.update' }
>;

type ShiftUpdateState = {
  startTime: string;
  endTime: string;
  userId: string | null;
  role: string | null | undefined;
  userRole: string | null | undefined;
};

type CurrentShiftUpdateState = ShiftUpdateState & {
  shiftId: string;
};

function sameInstant(left: string, right: string): boolean {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime)
    ? leftTime === rightTime
    : left === right;
}

export function shiftRoleDraftValue(
  role: string | null | undefined,
  fallbackRole: string | null | undefined,
): string {
  return role?.trim() || fallbackRole?.trim() || 'STAFF';
}

export function buildShiftUpdateOperation(input: {
  current: CurrentShiftUpdateState;
  next: ShiftUpdateState;
}): ShiftUpdateOperation | null {
  const operation: ShiftUpdateOperation = {
    op: 'shift.update',
    shiftId: input.current.shiftId,
  };

  if (!sameInstant(input.current.startTime, input.next.startTime)) {
    operation.startTime = input.next.startTime;
  }
  if (!sameInstant(input.current.endTime, input.next.endTime)) {
    operation.endTime = input.next.endTime;
  }
  if (input.current.userId !== input.next.userId) {
    operation.userId = input.next.userId;
  }

  const currentRole = shiftRoleDraftValue(input.current.role, input.current.userRole);
  const nextRole = shiftRoleDraftValue(input.next.role, input.next.userRole);
  if (currentRole !== nextRole) {
    operation.role = nextRole;
  }

  return Object.keys(operation).length > 2 ? operation : null;
}
