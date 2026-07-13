type ShiftRange = {
  start: string;
  end: string;
};

type LocationShift = {
  id: string;
  locationId: string;
};

type TenantVisibleLocation = {
  id: string;
};

export type LocationShiftScope = {
  locationId: string;
  dateValue: string;
  viewMode: 'day' | 'threeDay' | 'week';
};

type BreakGenerationResponse = {
  locationId?: unknown;
  data?: unknown;
};

export function resolveTenantVisibleLocation<T extends TenantVisibleLocation>(
  locations: T[],
  requestedLocationId: string | null | undefined,
): T | undefined {
  const normalizedLocationId = requestedLocationId?.trim();
  return (normalizedLocationId
    ? locations.find((location) => location.id === normalizedLocationId)
    : undefined) ?? locations[0];
}

export function buildLocationShiftQuery(range: ShiftRange, locationId: string): string {
  const normalizedLocationId = locationId.trim();
  if (!normalizedLocationId) {
    throw new Error('locationId is required to load shifts.');
  }

  const params = new URLSearchParams({
    startDate: range.start,
    endDate: range.end,
    locationId: normalizedLocationId,
  });
  return `/shifts?${params.toString()}`;
}

export function shiftsForLocation<T extends LocationShift>(shifts: T[], locationId: string): T[] {
  return shifts.filter((shift) => shift.locationId === locationId);
}

export function shiftIdsForLocation<T extends LocationShift>(shifts: T[], locationId: string): string[] {
  return shiftsForLocation(shifts, locationId).map((shift) => shift.id);
}

export function locationShiftScopeMatches(
  loadedScope: LocationShiftScope | null,
  expectedScope: LocationShiftScope,
): boolean {
  return Boolean(
    loadedScope &&
    loadedScope.locationId === expectedScope.locationId &&
    loadedScope.dateValue === expectedScope.dateValue &&
    loadedScope.viewMode === expectedScope.viewMode
  );
}

export function assertBreakGenerationResponseScope(
  response: BreakGenerationResponse,
  expectedLocationId: string,
  expectedShiftIds: string[],
): void {
  if (typeof response.locationId === 'string' && response.locationId !== expectedLocationId) {
    throw new Error('Break generation returned data for a different location.');
  }
  if (!Array.isArray(response.data)) return;

  const expectedIds = new Set(expectedShiftIds);
  const hasUnexpectedShift = response.data.some((item) => {
    if (!item || typeof item !== 'object' || !('shiftId' in item)) return false;
    const shiftId = (item as { shiftId?: unknown }).shiftId;
    return typeof shiftId === 'string' && !expectedIds.has(shiftId);
  });
  if (hasUnexpectedShift) {
    throw new Error('Break generation returned shifts outside the selected location.');
  }
}
