import { describe, expect, it } from 'vitest';
import { profileVersion } from './profile-version';

describe('profile version', () => {
  it('ignores database row ordering but detects each scheduling input change', () => {
    const windows = [
      { locationId: null, dayOfWeek: 1, startTimeMinutes: 540, endTimeMinutes: 1020 },
      { locationId: 'east', dayOfWeek: 2, startTimeMinutes: 600, endTimeMinutes: 960 },
    ];
    const version = profileVersion('employee', ['stock', 'cashier'], windows, []);
    expect(profileVersion('employee', ['cashier', 'stock'], [...windows].reverse(), [])).toBe(version);
    expect(profileVersion('employee', ['stock'], windows, [])).not.toBe(version);
    expect(profileVersion('other employee', ['stock', 'cashier'], windows, [])).not.toBe(version);
    expect(profileVersion('employee', ['stock', 'cashier'], [windows[0]], [])).not.toBe(version);
    expect(profileVersion('employee', ['stock', 'cashier'], windows, [{
      locationId: null, localDate: new Date('2026-09-14'), kind: 'UNAVAILABLE', startTimeMinutes: 0, endTimeMinutes: 1440,
    }])).not.toBe(version);
  });
});
