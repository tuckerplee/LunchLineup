import { lunchBreakDayScopeMatches, type LunchBreakDayScope } from './lunch-break-scope';

export type LunchBreakMutationBusyOwner = {
  requestId: number;
  scope: LunchBreakDayScope;
};

export function claimLunchBreakDayLoadRequest(
  requestScope: LunchBreakDayScope,
  desiredScope: LunchBreakDayScope,
  currentRequestId: number,
): number | null {
  if (!lunchBreakDayScopeMatches(requestScope, desiredScope)) return null;
  return currentRequestId + 1;
}

export function claimLunchBreakMutationBusyOwner(
  requestScope: LunchBreakDayScope,
  currentRequestId: number,
): LunchBreakMutationBusyOwner {
  if (!Number.isSafeInteger(currentRequestId) || currentRequestId >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Lunch/break mutation ownership is unavailable. Refresh before continuing.');
  }
  return {
    requestId: currentRequestId + 1,
    scope: { ...requestScope },
  };
}

export function lunchBreakMutationBusyOwnerMatches(
  currentOwner: LunchBreakMutationBusyOwner | null,
  expectedOwner: LunchBreakMutationBusyOwner,
): boolean {
  return Boolean(
    currentOwner
    && currentOwner.requestId === expectedOwner.requestId
    && lunchBreakDayScopeMatches(currentOwner.scope, expectedOwner.scope)
  );
}

export function lunchBreakMutationBusyOwnerOwnsScope(
  currentOwner: LunchBreakMutationBusyOwner | null,
  activeScope: LunchBreakDayScope,
): boolean {
  return Boolean(currentOwner && lunchBreakDayScopeMatches(currentOwner.scope, activeScope));
}

export function releaseLunchBreakMutationBusyOwner(
  currentOwner: LunchBreakMutationBusyOwner | null,
  completedOwner: LunchBreakMutationBusyOwner,
): LunchBreakMutationBusyOwner | null {
  return lunchBreakMutationBusyOwnerMatches(currentOwner, completedOwner) ? null : currentOwner;
}
