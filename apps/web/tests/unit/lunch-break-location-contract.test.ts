import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  claimLunchBreakDayLoadRequest,
  claimLunchBreakMutationBusyOwner,
  lunchBreakMutationBusyOwnerOwnsScope,
  releaseLunchBreakMutationBusyOwner,
} from '../../app/dashboard/lunch-breaks/lunch-break-load-ownership';
import {
  commitLunchBreakDayScope,
  lunchBreakDaySelectionMatches,
  lunchBreakDayScopeMatches,
  nextLunchBreakDayScope,
} from '../../app/dashboard/lunch-breaks/lunch-break-scope';

const pageSource = readFileSync(resolve(process.cwd(), 'app/dashboard/lunch-breaks/page.tsx'), 'utf8');

describe('lunch break location contract', () => {
  it('scopes reads, setup writes, and persisted generation to the selected location', () => {
    expect(pageSource).toContain('locationId,');
    const scheduledOwner = pageSource.indexOf('const generateForSelectedDay = useCallback');
    const scheduledScopeCapture = pageSource.indexOf('const mutationScope = desiredDayScopeRef.current;', scheduledOwner);
    const scheduledRequestBody = pageSource.indexOf('locationId: mutationScope.locationId,', scheduledScopeCapture);
    expect(scheduledOwner).toBeGreaterThan(-1);
    expect(scheduledScopeCapture).toBeGreaterThan(scheduledOwner);
    expect(scheduledRequestBody).toBeGreaterThan(scheduledScopeCapture);
    expect(pageSource.slice(scheduledRequestBody, scheduledRequestBody + 160))
      .toContain('shiftIds: selectedRows.map');
    expect(pageSource).toContain('const requestBody = { locationId: mutationScope.locationId, rows };');
    const setupSubmission = pageSource.indexOf('const result = await submitSetupShifts(');
    const setupRecoveryLocation = pageSource.indexOf('locationId: mutationScope.locationId,', setupSubmission);
    expect(setupSubmission).toBeGreaterThan(-1);
    expect(setupRecoveryLocation).toBeGreaterThan(setupSubmission);
    expect(pageSource).toContain('lunchBreakDayWindow(dateValue, timeZone)');
    expect(pageSource).toContain('lunchBreakShiftRange(mutationScope.dateValue, setupRow.startTime, setupRow.endTime, mutationTimeZone)');
    expect(pageSource).toContain('const requestBody: ShiftBreakUpdateRequestBody = { locationId: writeScope.locationId, breaks };');
    expect(pageSource).toContain("withIdempotencyKey(jsonWriteInit('PUT', retainedBody), idempotencyKey)");
  });

  it('discards a delayed response after a rapid location switch', () => {
    const downtownRequest = { locationId: 'loc-downtown', dateValue: '2026-07-09', epoch: 1 };
    const uptownSelection = { locationId: 'loc-uptown', dateValue: '2026-07-09', epoch: 2 };

    expect(lunchBreakDayScopeMatches(downtownRequest, uptownSelection)).toBe(false);
    expect(lunchBreakDayScopeMatches(uptownSelection, uptownSelection)).toBe(true);
    expect(pageSource).toContain('requestId !== dayLoadRequestRef.current');
    expect(pageSource).toContain('!lunchBreakDayScopeMatches(requestScope, desiredDayScopeRef.current)');
  });

  it('refuses stale mutation refresh ownership before request IDs or active rows can change', () => {
    const scopeA = { locationId: 'location-a', dateValue: '2026-07-16', epoch: 1 };
    const scopeB = { locationId: 'location-b', dateValue: '2026-07-16', epoch: 2 };

    expect(claimLunchBreakDayLoadRequest(scopeA, scopeB, 7)).toBeNull();
    expect(claimLunchBreakDayLoadRequest(scopeB, scopeB, 7)).toBe(8);

    const claimIndex = pageSource.indexOf('const requestId = claimLunchBreakDayLoadRequest(');
    const staleReturnIndex = pageSource.indexOf('if (requestId === null) return [];', claimIndex);
    const ownershipIndex = pageSource.indexOf('dayLoadRequestRef.current = requestId;', claimIndex);
    const clearIndex = pageSource.indexOf('clearDayRows();', claimIndex);
    expect(claimIndex).toBeGreaterThan(-1);
    expect(staleReturnIndex).toBeGreaterThan(claimIndex);
    expect(staleReturnIndex).toBeLessThan(ownershipIndex);
    expect(staleReturnIndex).toBeLessThan(clearIndex);
  });

  it('atomically rejects every stale mutation-owned visible state write', () => {
    const scopeA = { locationId: 'location-a', dateValue: '2026-07-16', epoch: 1 };
    const scopeB = { locationId: 'location-b', dateValue: '2026-07-16', epoch: 2 };
    const visibleState = {
      rows: ['scope-b-row'],
      lastRun: null as string | null,
      preview: ['scope-b-preview'],
      plannerMode: null as 'auto' | 'manual' | null,
      guideStep: 1,
    };

    expect(commitLunchBreakDayScope(scopeA, scopeB, () => {
      visibleState.rows = ['scope-a-row'];
      visibleState.lastRun = 'scope-a-run';
      visibleState.preview = ['scope-a-preview'];
      visibleState.plannerMode = 'auto';
      visibleState.guideStep = 5;
    })).toBe(false);
    expect(visibleState).toEqual({
      rows: ['scope-b-row'],
      lastRun: null,
      preview: ['scope-b-preview'],
      plannerMode: null,
      guideStep: 1,
    });

    expect(commitLunchBreakDayScope(scopeB, scopeB, () => {
      visibleState.plannerMode = 'manual';
      visibleState.guideStep = 5;
    })).toBe(true);
    expect(visibleState.plannerMode).toBe('manual');
    expect(visibleState.guideStep).toBe(5);
  });

  it('rejects a deferred old A completion after an A-to-B-to-A revisit', () => {
    const firstA = { locationId: 'location-a', dateValue: '2026-07-16', epoch: 7 };
    const scopeB = nextLunchBreakDayScope(firstA, {
      locationId: 'location-b',
      dateValue: '2026-07-16',
    });
    const secondA = nextLunchBreakDayScope(scopeB, {
      locationId: 'location-a',
      dateValue: '2026-07-16',
    });
    let visibleOwner = 'second-a';

    expect(secondA.epoch).toBe(9);
    expect(lunchBreakDaySelectionMatches(firstA, secondA)).toBe(true);
    expect(lunchBreakDayScopeMatches(firstA, secondA)).toBe(false);
    expect(commitLunchBreakDayScope(firstA, secondA, () => {
      visibleOwner = 'first-a';
    })).toBe(false);
    expect(claimLunchBreakDayLoadRequest(firstA, secondA, 12)).toBeNull();
    expect(visibleOwner).toBe('second-a');
  });

  it('keeps mutation busy ownership scoped and releases only the exact request owner', () => {
    const scopeA = { locationId: 'location-a', dateValue: '2026-07-16', epoch: 7 };
    const scopeB = nextLunchBreakDayScope(scopeA, {
      locationId: 'location-b',
      dateValue: '2026-07-16',
    });
    const ownerA = claimLunchBreakMutationBusyOwner(scopeA, 10);
    const ownerB = claimLunchBreakMutationBusyOwner(scopeB, ownerA.requestId);

    expect(lunchBreakMutationBusyOwnerOwnsScope(ownerA, scopeA)).toBe(true);
    expect(lunchBreakMutationBusyOwnerOwnsScope(ownerA, scopeB)).toBe(false);
    expect(lunchBreakMutationBusyOwnerOwnsScope(ownerB, scopeB)).toBe(true);
    expect(releaseLunchBreakMutationBusyOwner(ownerB, ownerA)).toBe(ownerB);
    expect(releaseLunchBreakMutationBusyOwner(ownerB, ownerB)).toBeNull();
  });

  it('routes every delayed mutation completion through the active-scope commit guard', () => {
    for (const mutationOwner of [
      'handleSavePolicy',
      'saveRow',
      'generateForSelectedDay',
      'generateFromManualShifts',
      'applySetupShifts',
    ]) {
      const ownerIndex = pageSource.indexOf(`const ${mutationOwner} = useCallback`);
      const nextOwnerIndex = pageSource.indexOf('\n  const ', ownerIndex + 6);
      const ownerSource = pageSource.slice(ownerIndex, nextOwnerIndex === -1 ? undefined : nextOwnerIndex);
      expect(ownerIndex).toBeGreaterThan(-1);
      expect(ownerSource).toContain('commitActiveDayScope(');
    }
    expect(pageSource).toContain('setPlannerMode(null);');
    expect(pageSource).toContain('setAutoGuideStep(1);');
  });

  it('routes every mutation-completion refresh through the scope-checked day loader', () => {
    for (const mutationOwner of ['handleSavePolicy', 'generateForSelectedDay', 'applySetupShifts']) {
      const ownerIndex = pageSource.indexOf(`const ${mutationOwner} = useCallback`);
      const nextOwnerIndex = pageSource.indexOf('\n  const ', ownerIndex + 6);
      const ownerSource = pageSource.slice(ownerIndex, nextOwnerIndex === -1 ? undefined : nextOwnerIndex);
      expect(ownerIndex).toBeGreaterThan(-1);
      expect(ownerSource).toContain('await loadDayRows(mutationScope,');
    }
  });

  it('owns one Strict Mode bootstrap read and only reads again for explicit scope or retry actions', () => {
    expect(pageSource).toContain('if (bootstrapStartedRef.current) return;');
    expect(pageSource).toContain('const selectDayScope = useCallback');
    expect(pageSource).toContain('const retryDayRows = useCallback');
    expect(pageSource).not.toContain('window.setInterval');
  });

  it('keeps the server and first client render deterministic before date bootstrap', () => {
    expect(pageSource).toContain("const DATE_BOOTSTRAP_PLACEHOLDER = '1970-01-01';");
    expect(pageSource).toContain('const [serverToday, setServerToday] = useState(DATE_BOOTSTRAP_PLACEHOLDER);');
    expect(pageSource).toContain('const [selectedDate, setSelectedDate] = useState(DATE_BOOTSTRAP_PLACEHOLDER);');
    expect(pageSource).toContain("if (isLoading) return 'Loading date';");
    expect(pageSource).toContain(': toDateInputValue(new Date());');
    expect(pageSource).not.toContain('useState<string>(toDateInputValue(new Date()))');
    expect(pageSource).not.toContain('toLocaleDateString([],');
  });

  it('invalidates scoped rows and derived display state before a request and fails closed', () => {
    expect(pageSource.indexOf('clearDayRows();')).toBeLessThan(pageSource.indexOf('fetchAllBoundedPages('));
    expect(pageSource).toContain('clearScopedDisplayState();');
    expect(pageSource).toContain('setDayReadError(loadError instanceof Error');
    expect(pageSource).toContain('Planning changes remain disabled until this day loads.');
    expect(pageSource).toContain('|| !canWriteLoadedDay');
  });

  it('labels the guided day with the active location and a truthful fallback', () => {
    expect(pageSource).toContain("activeLocation?.name.trim()");
    expect(pageSource).toContain("selectedLocationId ? 'Location name unavailable' : 'No location selected'");
    expect(pageSource).not.toContain('>Downtown Bistro<');
  });

  it('checks the shared lunch and location permission contract before loading page data', () => {
    expect(pageSource).toContain('hasLunchBreakReadAccess(sessionPermissions)');
    expect(pageSource.indexOf('hasLunchBreakReadAccess(sessionPermissions)'))
      .toBeLessThan(pageSource.indexOf('loadPolicy(),'));
  });
});
