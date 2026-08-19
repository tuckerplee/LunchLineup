import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(resolve(process.cwd(), 'app/dashboard/lunch-breaks/page.tsx'), 'utf8');
const onboardingSource = readFileSync(resolve(process.cwd(), 'app/onboarding/page.tsx'), 'utf8');

describe('lunch and break launch-safety UI contract', () => {
  it('keeps schedule-backed shift times read-only and routes corrections to Calendar', () => {
    expect(pageSource).toContain("row.source === 'schedule'");
    expect(pageSource).toContain('originalStartIso: row.startTime');
    expect(pageSource).toContain('originalEndIso: row.endTime');
    expect(pageSource).toContain('href="/dashboard/scheduling"');
    expect(pageSource).toContain('Preview only. This canvas never changes shift times.');
    expect(pageSource).not.toContain('startSetupDrag');
    expect(pageSource).not.toContain('role="slider"');
  });

  it('shows every staff result with search, visible counts, and select-scheduled controls', () => {
    expect(pageSource).toContain('visibleStep3EmployeePool.map');
    expect(pageSource).toContain('Showing {visibleStep3EmployeePool.length} of {step3EmployeePool.length} staff');
    expect(pageSource).toContain('Select scheduled ({scheduledEmployees.length})');
    expect(pageSource).not.toContain('step3EmployeePool.slice(0, 24)');
  });

  it('names and confirms the exact billable setup mutation before network submission', () => {
    const confirmationIndex = pageSource.indexOf('window.confirm(`Confirm setup:');
    const submissionIndex = pageSource.indexOf('const result = await submitSetupShifts(');
    expect(pageSource).toContain('setupShiftMutationLabel');
    expect(pageSource).toContain('exactly ${setupShiftsCreditCost} usage credit');
    expect(confirmationIndex).toBeGreaterThan(-1);
    expect(confirmationIndex).toBeLessThan(submissionIndex);
  });

  it('removes placeholder controls and unsupported break-card movement claims', () => {
    expect(pageSource).not.toContain("['Timeline', 'Staff', 'Conflicts']");
    expect(onboardingSource).not.toContain('Drag break cards');
    expect(onboardingSource).toContain('Review break placement before publishing');
  });
});
