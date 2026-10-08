import { describe, expect, it } from 'vitest';
import { breakTimingIssue } from '../../app/dashboard/lunch-breaks/break-timing-validation';

const row = {
  startTime: '2026-09-09T04:30:00Z', endTime: '2026-09-09T08:30:00Z',
  break1: { time: '22:30', durationMinutes: 10, skipped: false },
  lunch: { time: '00:00', durationMinutes: 30, skipped: false },
  break2: { time: '01:10', durationMinutes: 10, skipped: false },
};
describe('break timing validation', () => {
  it('accepts distinct breaks crossing local midnight', () => {
    expect(breakTimingIssue(row, 'America/Los_Angeles')).toBeNull();
  });
  it('rejects a break whose start is valid but whose end exceeds the shift', () => {
    expect(breakTimingIssue({ ...row, break2: { ...row.break2, durationMinutes: 30 } }, 'America/Los_Angeles'))
      .toContain('ends outside');
  });
  it('rejects overlapping breaks even when both fit the shift', () => {
    expect(breakTimingIssue({ ...row, break2: { ...row.break2, time: '00:15' } }, 'America/Los_Angeles'))
      .toContain('overlap');
  });
  it('does not silently repair a zero duration', () => {
    expect(breakTimingIssue({ ...row, lunch: { ...row.lunch, durationMinutes: 0 } }, 'America/Los_Angeles'))
      .toContain('positive whole-minute');
  });
});
