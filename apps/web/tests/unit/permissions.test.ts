import { describe, expect, it } from 'vitest';

import {
  getWorkspaceCapabilities,
  hasLunchBreakReadAccess,
  hasSchedulingReadAccess,
  LUNCH_BREAK_READ_PERMISSIONS,
  SCHEDULING_READ_PERMISSIONS,
} from '../../lib/permissions';

describe('workspace permission capabilities', () => {
  it('keeps schedule readers separate from schedule writers', () => {
    const capabilities = getWorkspaceCapabilities(['dashboard:access', 'shifts:read', 'schedules:read', 'locations:read']);

    expect(capabilities.canReadScheduling).toBe(true);
    expect(capabilities.canWriteSchedules).toBe(false);
    expect(capabilities.canWriteShifts).toBe(false);
    expect(capabilities.canDeleteShifts).toBe(false);
    expect(capabilities.canPublishSchedules).toBe(false);
  });

  it('requires the explicit schedule publish permission for finalize actions', () => {
    expect(getWorkspaceCapabilities(['schedules:write']).canPublishSchedules).toBe(false);
    expect(getWorkspaceCapabilities(['schedules:publish']).canPublishSchedules).toBe(true);
  });

  it('tracks schedule-write separately from shift-delete access', () => {
    const capabilities = getWorkspaceCapabilities(['schedules:write']);

    expect(capabilities.canWriteSchedules).toBe(true);
    expect(capabilities.canWriteShifts).toBe(false);
    expect(capabilities.canDeleteShifts).toBe(false);
  });

  it('requires every unconditional calendar-read permission', () => {
    expect(SCHEDULING_READ_PERMISSIONS).toEqual(['schedules:read', 'shifts:read', 'locations:read']);
    expect(hasSchedulingReadAccess(['schedules:read', 'shifts:read', 'locations:read'])).toBe(true);

    for (const omitted of SCHEDULING_READ_PERMISSIONS) {
      const permissions = SCHEDULING_READ_PERMISSIONS.filter((permission) => permission !== omitted);
      expect(hasSchedulingReadAccess(permissions)).toBe(false);
      expect(getWorkspaceCapabilities(permissions).canReadScheduling).toBe(false);
    }
  });

  it('requires lunch-break and location reads for the lunch workspace', () => {
    expect(LUNCH_BREAK_READ_PERMISSIONS).toEqual(['lunch_breaks:read', 'locations:read']);
    expect(hasLunchBreakReadAccess(['lunch_breaks:read', 'locations:read'])).toBe(true);
    expect(hasLunchBreakReadAccess(['lunch_breaks:read'])).toBe(false);
    expect(hasLunchBreakReadAccess(['locations:read'])).toBe(false);
  });

  it('requires shift-write permission for shift editing', () => {
    expect(getWorkspaceCapabilities(['schedules:write']).canWriteShifts).toBe(false);
    expect(getWorkspaceCapabilities(['shifts:write']).canWriteShifts).toBe(true);
  });

  it('requires explicit write permissions for tenant write affordances', () => {
    const capabilities = getWorkspaceCapabilities([
      'settings:read',
      'billing:read',
      'lunch_breaks:read',
      'locations:read',
      'time_cards:read',
    ]);

    expect(capabilities.canReadSettings).toBe(true);
    expect(capabilities.canWriteSettings).toBe(false);
    expect(capabilities.canReadBilling).toBe(true);
    expect(capabilities.canWriteBilling).toBe(false);
    expect(capabilities.canManageAccountLifecycle).toBe(false);
    expect(capabilities.canReadLunchBreaks).toBe(true);
    expect(capabilities.canWriteLunchBreaks).toBe(false);
    expect(capabilities.canReadTimeCards).toBe(true);
    expect(capabilities.canWriteTimeCards).toBe(false);
  });

  it('does not let admin portal access bypass tenant calendar permissions', () => {
    const capabilities = getWorkspaceCapabilities(['admin_portal:access']);

    expect(capabilities.hasAdminPortal).toBe(true);
    expect(capabilities.canReadScheduling).toBe(false);
    expect(capabilities.canReadLunchBreaks).toBe(false);
    expect(capabilities.canWriteShifts).toBe(false);
  });

  it('requires explicit lifecycle permission for account cancellation and deletion', () => {
    expect(getWorkspaceCapabilities(['settings:write']).canManageAccountLifecycle).toBe(false);
    expect(getWorkspaceCapabilities(['tenant_account:lifecycle']).canManageAccountLifecycle).toBe(true);
  });
});
