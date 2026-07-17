export type LunchBreakDaySelection = {
  locationId: string;
  dateValue: string;
};

export type LunchBreakDayScope = LunchBreakDaySelection & {
  epoch: number;
};

export function lunchBreakDaySelectionMatches(
  left: LunchBreakDaySelection | null,
  right: LunchBreakDaySelection,
): boolean {
  return Boolean(
    left &&
    left.locationId === right.locationId &&
    left.dateValue === right.dateValue
  );
}

export function nextLunchBreakDayScope(
  currentScope: LunchBreakDayScope,
  nextSelection: LunchBreakDaySelection,
): LunchBreakDayScope {
  if (!Number.isSafeInteger(currentScope.epoch) || currentScope.epoch >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Lunch/break day scope epoch is unavailable. Refresh before continuing.');
  }
  return { ...nextSelection, epoch: currentScope.epoch + 1 };
}

export function lunchBreakDayScopeMatches(
  loadedScope: LunchBreakDayScope | null,
  desiredScope: LunchBreakDayScope,
): boolean {
  return Boolean(
    lunchBreakDaySelectionMatches(loadedScope, desiredScope) &&
    loadedScope?.epoch === desiredScope.epoch
  );
}

export function commitLunchBreakDayScope(
  requestScope: LunchBreakDayScope,
  activeScope: LunchBreakDayScope,
  commit: () => void,
): boolean {
  if (!lunchBreakDayScopeMatches(requestScope, activeScope)) return false;
  commit();
  return true;
}
