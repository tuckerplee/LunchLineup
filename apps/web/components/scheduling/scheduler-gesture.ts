export const SCHEDULER_POINTER_ACTIVATION_PX = 8;
export const SCHEDULER_TOUCH_ACTIVATION_DELAY_MS = 300;

export type SchedulerGestureMode = 'move' | 'copy';

export type SchedulerDropDecision =
  | { kind: 'cancel'; reason: 'inactive' | 'outside-board' | 'locked' | 'unavailable' }
  | { kind: 'cancel'; reason: 'no-change' }
  | { kind: 'apply'; resourceId: string };

export function schedulerPointerDistance(
  startX: number,
  startY: number,
  clientX: number,
  clientY: number,
): number {
  return Math.hypot(clientX - startX, clientY - startY);
}

export function schedulerPointerActivated(
  startX: number,
  startY: number,
  clientX: number,
  clientY: number,
): boolean {
  return schedulerPointerDistance(startX, startY, clientX, clientY)
    >= SCHEDULER_POINTER_ACTIVATION_PX;
}

export function schedulerDeltaHours(deltaPx: number, hourWidth: number): number {
  if (!Number.isFinite(deltaPx) || !Number.isFinite(hourWidth) || hourWidth <= 0) return 0;
  return Math.round((deltaPx / hourWidth) * 4) / 4;
}

export function schedulerBoardId(reactId: string): string {
  const suffix = reactId.replace(/[^a-zA-Z0-9_-]/g, '') || 'timeline';
  return `staff-schedule-${suffix}`;
}

export function schedulerDroppableId(boardId: string, resourceId: string): string {
  return `${boardId}::staff::${encodeURIComponent(resourceId)}`;
}

export function resourceIdFromSchedulerDroppable(
  boardId: string,
  droppableId: string,
): string | null {
  const prefix = `${boardId}::staff::`;
  if (!droppableId.startsWith(prefix)) return null;
  try {
    const resourceId = decodeURIComponent(droppableId.slice(prefix.length));
    return resourceId || null;
  } catch {
    return null;
  }
}

export function resolveSchedulerDrop(input: {
  active: boolean;
  insideBoard: boolean;
  locked: boolean;
  callbackAvailable: boolean;
  sourceResourceId: string;
  targetResourceId: string | null;
  deltaHours: number;
}): SchedulerDropDecision {
  if (!input.active) return { kind: 'cancel', reason: 'inactive' };
  if (!input.insideBoard || !input.targetResourceId) {
    return { kind: 'cancel', reason: 'outside-board' };
  }
  if (input.locked) return { kind: 'cancel', reason: 'locked' };
  if (!input.callbackAvailable) return { kind: 'cancel', reason: 'unavailable' };
  if (input.deltaHours === 0 && input.targetResourceId === input.sourceResourceId) {
    return { kind: 'cancel', reason: 'no-change' };
  }
  return { kind: 'apply', resourceId: input.targetResourceId };
}
