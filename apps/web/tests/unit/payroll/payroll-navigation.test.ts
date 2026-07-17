import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getVisibleDashboardNavItems } from '../../../app/dashboard/dashboard-navigation';
import { getPayrollCapabilities, PAYROLL_PERMISSIONS } from '../../../lib/permissions';

describe('exact payroll permission visibility', () => {
  it('shows navigation with payroll:read alone and never infers it from time-card writes', () => {
    expect(getVisibleDashboardNavItems([PAYROLL_PERMISSIONS.read]).map((item) => item.href)).toContain('/dashboard/payroll');
    expect(getVisibleDashboardNavItems(['time_cards:write']).map((item) => item.href)).not.toContain('/dashboard/payroll');
    expect(getVisibleDashboardNavItems(['admin_portal:access']).map((item) => item.href)).not.toContain('/dashboard/payroll');
  });

  it('projects every command from only its exact permission', () => {
    const cases = [
      [PAYROLL_PERMISSIONS.policyWrite, 'canWritePayrollPolicy'], [PAYROLL_PERMISSIONS.lock, 'canLockPayroll'],
      [PAYROLL_PERMISSIONS.decide, 'canApprovePayrollTimeCards'], [PAYROLL_PERMISSIONS.export, 'canExportPayroll'],
      [PAYROLL_PERMISSIONS.reconcile, 'canReconcilePayroll'],
    ] as const;
    for (const [permission, capability] of cases) {
      const projected = getPayrollCapabilities([PAYROLL_PERMISSIONS.read, permission]);
      expect(projected[capability]).toBe(true);
      for (const [, otherCapability] of cases.filter(([candidate]) => candidate !== permission)) expect(projected[otherCapability]).toBe(false);
    }
  });

  it('allows historical-card adoption for policy managers, never lock-only managers', () => {
    const policyManager = getPayrollCapabilities([PAYROLL_PERMISSIONS.read, PAYROLL_PERMISSIONS.policyWrite]);
    const lockOnlyManager = getPayrollCapabilities([PAYROLL_PERMISSIONS.read, PAYROLL_PERMISSIONS.lock]);

    expect(policyManager.canWritePayrollPolicy).toBe(true);
    expect(policyManager.canLockPayroll).toBe(false);
    expect(lockOnlyManager.canWritePayrollPolicy).toBe(false);
    expect(lockOnlyManager.canLockPayroll).toBe(true);

    const detailSource = readFileSync(resolve(process.cwd(), 'app/dashboard/payroll/PayrollPeriodDetail.tsx'), 'utf8');
    expect(detailSource).toContain("period.status === 'OPEN' ? capabilities.canWritePayrollPolicy && card.adoptionEligible");
    expect(detailSource).not.toContain("period.status === 'OPEN' ? capabilities.canLockPayroll && card.adoptionEligible");
    const workspaceSource = readFileSync(resolve(process.cwd(), 'app/dashboard/payroll/PayrollWorkspace.tsx'), 'utf8');
    expect(workspaceSource).toContain('capabilities.canWritePayrollPolicy ? <form');
  });

  it('splits amendment creation and decision capabilities for every combination', () => {
    const approvalOnly = getPayrollCapabilities([PAYROLL_PERMISSIONS.read, PAYROLL_PERMISSIONS.decide]);
    const reconcileOnly = getPayrollCapabilities([PAYROLL_PERMISSIONS.read, PAYROLL_PERMISSIONS.reconcile]);
    const both = getPayrollCapabilities([PAYROLL_PERMISSIONS.read, PAYROLL_PERMISSIONS.decide, PAYROLL_PERMISSIONS.reconcile]);
    const neither = getPayrollCapabilities([PAYROLL_PERMISSIONS.read]);

    expect([approvalOnly.canReconcilePayroll, approvalOnly.canApprovePayrollTimeCards]).toEqual([false, true]);
    expect([reconcileOnly.canReconcilePayroll, reconcileOnly.canApprovePayrollTimeCards]).toEqual([true, false]);
    expect([both.canReconcilePayroll, both.canApprovePayrollTimeCards]).toEqual([true, true]);
    expect([neither.canReconcilePayroll, neither.canApprovePayrollTimeCards]).toEqual([false, false]);

    const detailSource = readFileSync(resolve(process.cwd(), 'app/dashboard/payroll/PayrollPeriodDetail.tsx'), 'utf8');
    expect(detailSource).toContain("capabilities.canReconcilePayroll || capabilities.canApprovePayrollTimeCards");
    expect(detailSource).toContain("canCreate={period.status === 'LOCKED' && capabilities.canReconcilePayroll}");
    expect(detailSource).toContain('canDecide={capabilities.canApprovePayrollTimeCards}');
  });

  it('gates the server route only on payroll read and passes command capabilities', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/dashboard/payroll/page.tsx'), 'utf8');
    expect(source).toContain('if (!capabilities.canReadPayroll)');
    expect(source).toContain('<PayrollWorkspace capabilities={capabilities} currentUserId={user.id} />');
  });
});
