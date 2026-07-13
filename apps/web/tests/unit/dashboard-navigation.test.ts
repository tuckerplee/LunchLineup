import { describe, expect, it } from 'vitest';

import {
  canOpenDashboardAccountSettings,
  getDashboardCurrentPage,
  getDashboardUserInitials,
  getVisibleDashboardNavItems,
} from '../../app/dashboard/dashboard-navigation';

function labelsFor(permissions: string[]): string[] {
  return getVisibleDashboardNavItems(permissions).map((item) => item.label);
}

describe('dashboard navigation helpers', () => {
  it('keeps permissioned workspace sections hidden without matching read access', () => {
    expect(labelsFor(['dashboard:access'])).toEqual(['Overview']);
  });

  it('builds the visible nav from workspace read capabilities', () => {
    expect(
      labelsFor([
        'schedules:read',
        'shifts:read',
        'locations:read',
        'lunch_breaks:read',
        'time_cards:read',
        'users:read',
        'settings:read',
      ]),
    ).toEqual(['Overview', 'Calendar', 'Lunch & Breaks', 'Time Cards', 'Staff', 'Locations', 'Settings']);
  });

  it('adds admin console access without granting settings account access', () => {
    const labels = labelsFor(['admin_portal:access']);

    expect(labels).toEqual(['Overview', 'Admin Console']);
    expect(canOpenDashboardAccountSettings(['admin_portal:access'])).toBe(false);
  });

  it('hides lunch and breaks unless the custom role can also read locations', () => {
    expect(labelsFor(['lunch_breaks:read'])).toEqual(['Overview']);
    expect(labelsFor(['locations:read'])).toEqual(['Overview', 'Locations']);
    expect(labelsFor(['lunch_breaks:read', 'locations:read'])).toEqual(['Overview', 'Lunch & Breaks', 'Locations']);
  });

  it('matches nested dashboard routes to their parent nav item', () => {
    const navItems = getVisibleDashboardNavItems(['schedules:read', 'shifts:read', 'locations:read']);

    expect(getDashboardCurrentPage('/dashboard/scheduling/week', navItems)).toBe('Calendar');
    expect(getDashboardCurrentPage('/dashboard/unknown', navItems)).toBe('Workspace');
  });

  it('formats account initials from name, username, email, or the default profile label', () => {
    expect(getDashboardUserInitials({ name: 'Tucker Lee' })).toBe('TL');
    expect(getDashboardUserInitials({ username: 'manager' })).toBe('MA');
    expect(getDashboardUserInitials({ email: 'ops@example.com' })).toBe('OP');
    expect(getDashboardUserInitials(null)).toBe('US');
  });
});
