import { describe, expect, it } from 'vitest';
import {
  payrollInstantToLocalInput,
  payrollLocalInputToIso,
} from '../../../app/dashboard/payroll/payroll-amendment-time';

describe('payroll amendment work-timezone inputs', () => {
  it('renders and parses wall time in the locked entry timezone', () => {
    expect(payrollInstantToLocalInput('2026-07-09T16:30:00.000Z', 'America/Los_Angeles')).toBe('2026-07-09T09:30');
    expect(payrollLocalInputToIso('2026-07-09T09:30', 'America/Los_Angeles')).toBe('2026-07-09T16:30:00.000Z');
  });

  it('fails closed for nonexistent and ambiguous DST wall times', () => {
    expect(() => payrollLocalInputToIso('2026-03-08T02:30', 'America/Los_Angeles')).toThrow('does not exist');
    expect(() => payrollLocalInputToIso('2026-11-01T01:30', 'America/Los_Angeles')).toThrow('unambiguous');
  });
});
