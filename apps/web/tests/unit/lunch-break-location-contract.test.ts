import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lunchBreakDayScopeMatches } from '../../app/dashboard/lunch-breaks/lunch-break-scope';

const pageSource = readFileSync(resolve(process.cwd(), 'app/dashboard/lunch-breaks/page.tsx'), 'utf8');

describe('lunch break location contract', () => {
  it('scopes reads, setup writes, and persisted generation to the selected location', () => {
    expect(pageSource).toContain('locationId,');
    expect(pageSource).toContain('locationId: selectedLocationId,\n        shiftIds: selectedRows.map');
    expect(pageSource).toContain("locationId: selectedLocationId, rows");
    expect(pageSource).toContain('lunchBreakDayWindow(dateValue, timeZone)');
    expect(pageSource).toContain('lunchBreakShiftRange(selectedDate, setupRow.startTime, setupRow.endTime, activeTimeZone)');
    expect(pageSource).toContain("jsonWriteInit('PUT', { locationId: writeScope.locationId, breaks })");
  });

  it('discards a delayed response after a rapid location switch', () => {
    const downtownRequest = { locationId: 'loc-downtown', dateValue: '2026-07-09' };
    const uptownSelection = { locationId: 'loc-uptown', dateValue: '2026-07-09' };

    expect(lunchBreakDayScopeMatches(downtownRequest, uptownSelection)).toBe(false);
    expect(lunchBreakDayScopeMatches(uptownSelection, uptownSelection)).toBe(true);
    expect(pageSource).toContain('requestId !== dayLoadRequestRef.current');
    expect(pageSource).toContain('!lunchBreakDayScopeMatches(requestScope, desiredDayScopeRef.current)');
  });

  it('checks the shared lunch and location permission contract before loading page data', () => {
    expect(pageSource).toContain('hasLunchBreakReadAccess(sessionPermissions)');
    expect(pageSource.indexOf('hasLunchBreakReadAccess(sessionPermissions)'))
      .toBeLessThan(pageSource.indexOf('loadPolicy(),'));
  });
});
