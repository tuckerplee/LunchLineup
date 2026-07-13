export type LunchBreakDayScope = {
  locationId: string;
  dateValue: string;
};

export function lunchBreakDayScopeMatches(
  loadedScope: LunchBreakDayScope | null,
  desiredScope: LunchBreakDayScope,
): boolean {
  return Boolean(
    loadedScope &&
    loadedScope.locationId === desiredScope.locationId &&
    loadedScope.dateValue === desiredScope.dateValue
  );
}
