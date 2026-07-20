import { describe, expect, it } from 'vitest';
import {
  APPLICATION_API_OPERATIONS,
  applicationApiOperation,
} from './application';

describe('API v2 application operation catalog', () => {
  it('contains only unique, explicit operations', () => {
    const routeKeys = APPLICATION_API_OPERATIONS.map(({ method, path }) => `${method} ${path}`);
    const operationIds = APPLICATION_API_OPERATIONS.map(({ operationId }) => operationId);

    expect(APPLICATION_API_OPERATIONS).toHaveLength(121);
    expect(new Set(routeKeys).size).toBe(routeKeys.length);
    expect(new Set(operationIds).size).toBe(operationIds.length);
    for (const operation of APPLICATION_API_OPERATIONS) {
      expect(operation.path).toMatch(/^\/[A-Za-z0-9:/-]+$/);
      expect(operation.path).not.toContain('*');
      expect(operation.path).not.toContain('..');
      expect(operation.path).not.toMatch(/person|demo-shift/i);
    }
  });

  it('marks only completed API-02 modules as native owners', () => {
    expect(APPLICATION_API_OPERATIONS.filter((operation) => operation.native).map((operation) => operation.operationId))
      .toEqual([
        'getCurrentSession',
        'listLocations',
        'createLocation',
        'getLocationSummary',
        'getLocation',
        'updateLocation',
        'deleteLocation',
        'listStaffMembers',
        'getAccessCatalog',
        'getStaffSchedulingProfile',
        'updateStaffSchedulingProfile',
        'getStaffMember',
        'createStaffInvitation',
        'getStaffInvitation',
        'retryStaffInvitation',
        'reissueStaffInvitation',
        'resetStaffPin',
        'replaceCurrentPin',
        'getStaffAccess',
        'updateStaffAccess',
        'createAccessRole',
        'updateAccessRole',
        'deleteAccessRole',
        'listScheduleSummaries',
        'listShiftSummaries',
        'listStaffRoster',
        'listLunchBreakRows',
        'getLunchBreakPolicy',
        'updateLunchBreakPolicy',
        'generateLunchBreakPlan',
        'importLunchBreakShifts',
        'updateShiftBreakPlan',
        'listTimeCards',
        'getActiveTimeCard',
        'getTimeCard',
        'clockIn',
        'clockOut',
        'correctTimeCard',
        'getWorkspaceSettings',
        'updateGeneralSettings',
        'updateTeamSettings',
        'updateSecuritySettings',
      ]);
  });

  it('does not reintroduce legacy row-at-a-time scheduling mutations', () => {
    for (const [method, path] of [
      ['POST', '/shifts'],
      ['PUT', '/shifts/:shiftId'],
      ['DELETE', '/shifts/:shiftId'],
      ['DELETE', '/schedules/:scheduleId'],
      ['POST', '/schedules/:scheduleId/publish'],
      ['POST', '/schedules/:scheduleId/auto-schedule'],
    ] as const) {
      expect(APPLICATION_API_OPERATIONS).not.toContainEqual(expect.objectContaining({ method, path }));
    }
  });

  it('matches only declared methods, paths, and safe encoded identifiers', () => {
    expect(applicationApiOperation('/users/user-1/scheduling-profile?include=skills', 'GET')?.operationId)
      .toBe('getStaffSchedulingProfile');
    expect(applicationApiOperation('/users/user-1/scheduling-profile', 'POST')).toBeNull();
    expect(applicationApiOperation('/shifts/demo-shift-05-casey-v1', 'PUT')).toBeNull();
    expect(applicationApiOperation('/users/%2e%2e/admin', 'GET')).toBeNull();
    expect(applicationApiOperation('/users/user%2Fadmin', 'GET')).toBeNull();
    expect(applicationApiOperation('/users/%00', 'GET')).toBeNull();
    expect(applicationApiOperation('https://evil.example/users', 'GET')).toBeNull();
  });
});
