import { describe, expect, it, vi } from 'vitest';

vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/components/ui/button', () => ({ Button: () => null }));
vi.mock('@/components/scheduling/StaffScheduler', () => ({ StaffScheduler: () => null }));
vi.mock('@/lib/client-api', () => ({
  fetchJsonWithSession: vi.fn(),
  fetchWithSession: vi.fn(),
  idempotentRequestAttempt: (
    payload: unknown,
    current: { key: string; payloadFingerprint: string } | null,
    keyFactory: () => string,
  ) => {
    const payloadFingerprint = JSON.stringify(payload);
    if (current?.payloadFingerprint === payloadFingerprint) return current;
    return { key: keyFactory(), payloadFingerprint };
  },
  withIdempotencyKey: vi.fn(),
}));
vi.mock('@/lib/permissions', () => ({
  getWorkspaceCapabilities: vi.fn(),
  hasSchedulingReadAccess: vi.fn(),
}));
vi.mock('@/lib/location-timezone', () => ({
  addLocalDays: vi.fn(),
  dateValueInTimeZone: vi.fn(),
  formatDateInTimeZone: vi.fn(),
  localDateRange: vi.fn(),
  safeTimeZone: vi.fn(),
  timeValueInTimeZone: vi.fn(),
}));

import {
  executeBreakGenerationWithRecovery,
  type BreakGenerationAttempt,
} from '../../app/dashboard/scheduling/break-generation-recovery';
import {
  assertBreakGenerationResponseScope,
  buildLocationShiftQuery,
  locationShiftScopeMatches,
  resolveTenantVisibleLocation,
  shiftIdsForLocation,
  shiftsForLocation,
} from '../../app/dashboard/scheduling/location-shift-scope';

const shifts = [
  { id: 'shift-downtown', locationId: 'loc-downtown' },
  { id: 'shift-uptown', locationId: 'loc-uptown' },
];

describe('scheduling location shift scope', () => {
  it('always includes the active location in range refresh queries', () => {
    const query = buildLocationShiftQuery({
      start: '2026-07-09T07:00:00.000Z',
      end: '2026-07-10T07:00:00.000Z',
    }, 'loc-uptown');
    const url = new URL(query, 'https://lunchlineup.test');

    expect(url.searchParams.get('locationId')).toBe('loc-uptown');
    expect(url.searchParams.get('startDate')).toBe('2026-07-09T07:00:00.000Z');
    expect(url.searchParams.get('endDate')).toBe('2026-07-10T07:00:00.000Z');
  });

  it('refuses unscoped shift loads', () => {
    expect(() => buildLocationShiftQuery({ start: 'start', end: 'end' }, '  '))
      .toThrow(/locationId is required/i);
  });

  it('honors a linked location only when it is tenant-visible', () => {
    const locations = [
      { id: 'loc-downtown', name: 'Downtown' },
      { id: 'loc-uptown', name: 'Uptown' },
    ];

    expect(resolveTenantVisibleLocation(locations, 'loc-uptown')).toEqual(locations[1]);
    expect(resolveTenantVisibleLocation(locations, 'loc-other-tenant')).toEqual(locations[0]);
  });

  it('never sends or retains another location shift', () => {
    expect(shiftIdsForLocation(shifts, 'loc-uptown')).toEqual(['shift-uptown']);
    expect(shiftsForLocation(shifts, 'loc-uptown')).toEqual([
      { id: 'shift-uptown', locationId: 'loc-uptown' },
    ]);
  });

  it('invalidates Uptown data as soon as Downtown becomes the desired scope', () => {
    const loadedUptown = { locationId: 'loc-uptown', dateValue: '2026-07-09', viewMode: 'threeDay' as const };
    const desiredDowntown = { ...loadedUptown, locationId: 'loc-downtown' };

    expect(locationShiftScopeMatches(loadedUptown, desiredDowntown)).toBe(false);
    expect(locationShiftScopeMatches(desiredDowntown, desiredDowntown)).toBe(true);
  });

  it('rejects generation responses that identify another location or shift set', () => {
    expect(() => assertBreakGenerationResponseScope(
      { locationId: 'loc-uptown', data: [{ shiftId: 'shift-uptown' }] },
      'loc-downtown',
      ['shift-downtown'],
    )).toThrow(/different location/i);
    expect(() => assertBreakGenerationResponseScope(
      { data: [{ shiftId: 'shift-uptown' }] },
      'loc-downtown',
      ['shift-downtown'],
    )).toThrow(/outside the selected location/i);
  });
});

describe('break generation recovery', () => {
  it('reuses one key after an ambiguous POST and skips the charged POST after refresh failure', async () => {
    const requestBody = {
      locationId: 'loc-downtown',
      shiftIds: ['shift-downtown'],
      persist: true,
    };
    let retainedAttempt: BreakGenerationAttempt | null = null;
    const keyFactory = vi.fn(() => 'generation-attempt-1');
    const postGeneration = vi.fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({
        locationId: 'loc-downtown',
        data: [{ shiftId: 'shift-downtown' }],
      });
    const reconcile = vi.fn()
      .mockRejectedValueOnce(new Error('refresh failed'))
      .mockResolvedValueOnce(['shift-downtown']);
    const runAttempt = () => executeBreakGenerationWithRecovery({
      requestBody,
      currentAttempt: retainedAttempt,
      retainAttempt: (attempt) => {
        retainedAttempt = attempt;
      },
      postGeneration,
      reconcile,
      keyFactory,
    });

    await expect(runAttempt()).rejects.toThrow('response lost');
    expect(retainedAttempt).toMatchObject({
      key: 'generation-attempt-1',
      postConfirmed: false,
    });

    await expect(runAttempt()).rejects.toThrow('refresh failed');
    expect(retainedAttempt).toMatchObject({
      key: 'generation-attempt-1',
      postConfirmed: true,
    });

    await expect(runAttempt()).resolves.toEqual(['shift-downtown']);

    expect(keyFactory).toHaveBeenCalledTimes(1);
    expect(postGeneration).toHaveBeenCalledTimes(2);
    expect(postGeneration.mock.calls.map(([key]) => key)).toEqual([
      'generation-attempt-1',
      'generation-attempt-1',
    ]);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(retainedAttempt).toBeNull();
  });
});
