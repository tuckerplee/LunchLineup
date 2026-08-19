import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(process.cwd(), 'app/dashboard/payroll');
const workspace = readFileSync(resolve(root, 'PayrollWorkspace.tsx'), 'utf8');
const detail = readFileSync(resolve(root, 'PayrollPeriodDetail.tsx'), 'utf8');
const audit = readFileSync(resolve(root, 'PayrollAuditDetails.tsx'), 'utf8');
const policy = readFileSync(resolve(root, 'PayrollPolicyForm.tsx'), 'utf8');
const amendments = readFileSync(resolve(root, 'PayrollAmendments.tsx'), 'utf8');
const reconciliation = readFileSync(resolve(root, 'PayrollReconciliation.tsx'), 'utf8');
const styles = readFileSync(resolve(root, 'payroll.module.css'), 'utf8');

describe('payroll responsive and accessibility contracts', () => {
  it('keeps bounded evidence tables in named focusable horizontal regions at 375px', () => {
    expect(detail).toContain('role="region" aria-label="Payroll time cards" tabIndex={0}');
    expect(amendments).toContain('role="region" aria-label="Locked payroll entries available for correction" tabIndex={0}');
    expect(audit).toContain('role="region" aria-label="Immutable locked payroll evidence" tabIndex={0}');
    expect(reconciliation).toContain('role="region" aria-label="Export line reconciliation outcomes" tabIndex={0}');
    expect(styles).toContain('overflow-x: auto;');
    expect(styles).toContain('@media (max-width: 640px)');
    expect(styles).toContain('grid-template-columns: minmax(0, 1fr);');
  });

  it('labels future policy validation, manager confirmation, and live outcomes', () => {
    expect(policy).toContain('aria-invalid={Boolean(errors.timeZone)}');
    expect(policy).toContain('aria-invalid={Boolean(errors.effectiveFrom)}');
    expect(policy).toContain('readOnly={Boolean(currentPolicy)}');
    expect(policy).toContain('Version 1 may establish an aligned historical boundary.');
    expect(policy).toContain('both the prior and new cadence anchors');
    expect(detail).toContain('role="alertdialog"');
    expect(detail).toContain('confirmationRef.current?.focus()');
    expect(detail).toContain("if (event.key === 'Escape'");
    expect(workspace).toContain('role="alert" aria-live="assertive"');
    expect(workspace).toContain('role="status" aria-live="polite"');
  });

  it('keeps technical evidence in a closed-by-default audit disclosure', () => {
    expect(audit).toContain('<details className={`surface-card ${styles.auditDetails}`}>');
    expect(audit).toContain('<summary>Audit details</summary>');
    expect(audit).not.toMatch(/<details[^>]+open/);
    expect(audit).toContain('Period revision');
    expect(audit).toContain('Idempotency');
    expect(audit).toContain('lockedEntrySha256');
    expect(audit).toContain('canonicalSha256');
    expect(detail).not.toContain('lockedEntrySha256');
    expect(detail).not.toContain('Revision {card.timeCardRevision}');
    expect(amendments).not.toContain('canonicalSha256');
    expect(styles).toContain('min-height: 52px;');
  });

  it('preserves the provider limitation until results are fully confirmed', () => {
    expect(workspace).toContain('isBatchFullyReconciled');
    expect(workspace).toContain('Your payroll provider remains the final source');
    expect(detail).toContain('confirm the provider results below');
    expect(reconciliation).toContain('Every row is accepted and the provider total matches this export.');
  });

  it('uses exact permission branches and lucide command icons', () => {
    expect(detail).toContain('capabilities.canLockPayroll');
    expect(detail).toContain('capabilities.canWritePayrollPolicy');
    expect(detail).toContain('capabilities.canApprovePayrollTimeCards');
    expect(detail).toContain('capabilities.canExportPayroll');
    expect(detail).toContain('capabilities.canReconcilePayroll');
    expect(workspace).toContain('capabilities.canWritePayrollPolicy');
    expect(detail).toContain("from 'lucide-react'");
  });

  it('keeps zero-entry locked periods visible but not exportable', () => {
    expect(detail).toContain('const hasExportableEntries = hasExportablePayrollEntries(period);');
    expect(detail).toContain('capabilities.canExportPayroll && hasExportableEntries && !batch');
    expect(detail).toContain('This locked period has no entries to export.');
  });

  it('fails export closed without a positive confirmed cost', () => {
    expect(detail).toContain('disabled={isBusy || creditCost === null}');
    expect(detail).toContain('Creating this export uses <strong>{creditCost}');
    expect(detail).toContain("if (confirmation === 'export' && creditCost !== null && hasExportableEntries) await onExport(creditCost);");
  });

  it('uses signed totals, bounded correctable-line paging, and exact amendment separation', () => {
    expect(reconciliation).toContain('reconciliationEditableLines(batch)');
    expect(reconciliation).toContain('<th scope="col">Current</th><th scope="col">New outcome</th>');
    expect(reconciliation).toContain('batch.nextLineCursor');
    expect(reconciliation).toContain('Load next 500 lines');
    expect(reconciliation).not.toContain('min="0" step="1" value={providerTotalMinutes}');
    expect(amendments).toContain("period.status === 'OPEN' && period.startsAt >= sourcePeriod.endsAt");
    expect(amendments).toContain('canCreatePayrollAmendmentForEntry(canCreate, currentUserId, entry.employeeId)');
    expect(amendments).toContain('payrollAmendmentDecisionBlocker({');
    expect(amendments).toContain('payrollLocalInputToIso(clockIn, editingEntry.workTimeZone)');
    expect(amendments).toContain('payrollInstantToLocalInput(entry.clockInAt, entry.workTimeZone)');
  });
});
