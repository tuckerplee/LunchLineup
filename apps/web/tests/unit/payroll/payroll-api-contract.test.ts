import { readFileSync, readdirSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { payrollExportPath, payrollPeriodDetailPath, payrollPeriodsPath, payrollPoliciesPath } from '../../../app/dashboard/payroll/payroll-paths';

const root = resolve(process.cwd(), 'app/dashboard/payroll');
const apiSource = readFileSync(resolve(root, 'payroll-api.ts'), 'utf8');
const hookSource = readFileSync(resolve(root, 'use-payroll-workspace.ts'), 'utf8');
const policyFormSource = readFileSync(resolve(root, 'PayrollPolicyForm.tsx'), 'utf8');
const amendmentFormSource = readFileSync(resolve(root, 'PayrollAmendments.tsx'), 'utf8');

function ownedSources(): string[] {
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isFile() && ['.ts', '.tsx', '.md'].includes(extname(entry.name))).map((entry) => readFileSync(resolve(root, entry.name), 'utf8'));
}

describe('immutable payroll API contract', () => {
  it('uses bounded policy, period, card, and export-line cursors', () => {
    expect(payrollPoliciesPath('older')).toBe('/payroll/policies?limit=25&cursor=older');
    expect(payrollPeriodsPath()).toBe('/payroll/periods?limit=25');
    expect(payrollPeriodDetailPath('period/1', 'card cursor')).toBe('/payroll/periods/period%2F1?cardLimit=250&lineLimit=500&cardCursor=card+cursor');
    expect(payrollExportPath('export/1', 'line cursor')).toBe('/payroll/exports/export%2F1?lineLimit=500&lineCursor=line+cursor');
  });

  it('covers immutable policy and forward-only period commands with keys', () => {
    expect(apiSource).toContain("normalizePayrollPolicyEnvelope(await fetchJsonWithSession<unknown>('/payroll/policy'))");
    expect(apiSource).toContain("jsonRequest('PUT', input, idempotencyKey)");
    expect(apiSource).toContain("jsonRequest('POST', { localStartDate }, idempotencyKey)");
    expect(apiSource).toContain('/adopt`');
    expect(apiSource).toContain('/review`');
    expect(apiSource).toContain('/decisions`');
    expect(apiSource).toContain('/lock`');
    expect(hookSource).toContain("{ cards: cardIds.map((id) => ({ id, expectedRevision: revisions[id] })) }");
    expect(hookSource).toContain("{ decisions: cardIds.map((timeCardId) => ({");
  });

  it('covers governed amendments, deterministic exports, free download, and line reconciliation', () => {
    expect(apiSource).toContain('/amendments`');
    expect(apiSource).toContain('/decision`');
    expect(apiSource).toContain('/exports`');
    expect(apiSource).toContain('/download`);');
    expect(apiSource).toContain('/reconciliation`');
    expect(apiSource).toContain('outcomes: payload.lines');
    expect(apiSource).toContain('payrollExportPath(exportId, lineCursor)');
    expect(apiSource).toContain("fetchJsonWithSession<unknown>('/payroll/export-entitlement')");
    expect(apiSource).not.toContain('/billing/features');
    expect(apiSource).toContain("jsonRequest('POST', { expectedCreditCost }, idempotencyKey)");
    expect(hookSource).toContain("attemptFor('export', detail.period.id, payload)");
    expect(hookSource).toContain('const payload = { periodId: detail.period.id, expectedCreditCost: authoritativeCost };');
    expect(hookSource).toContain('createPayrollExport(detail.period.id, payload.expectedCreditCost, attempt.key)');
    expect(hookSource).toContain('const authoritativeCost = await loadCreditCost();');
    expect(hookSource).toContain('fetchPayrollExport(batch.id, batch.nextLineCursor)');
    expect(hookSource).toContain('appendPayrollExportLines(batch.lines, page.lines)');
    expect(hookSource).toContain('Downloads consume no credits.');
  });

  it('treats a changed export cost as definitive refresh and reconfirmation', () => {
    expect(hookSource).toContain('isExportCostMismatch(operationError)');
    expect(hookSource).toContain('completeAttempt(attempt);');
    expect(hookSource).toContain('Review and confirm the refreshed exact cost; the rejected request will not be replayed.');
  });

  it('retains policy and amendment forms until creation or exact readback is confirmed', () => {
    expect(policyFormSource).toContain('const created = await onCreate(input);');
    expect(policyFormSource).toContain("if (created) setEffectiveFrom('');");
    expect(amendmentFormSource).toContain('const created = await onCreate(editingEntry.id, {');
    expect(amendmentFormSource).toContain('if (created) setEditingEntryId(null);');
    expect(hookSource).toContain('Submit the unchanged form to replay the same payload and Idempotency-Key.');
    expect(hookSource).toContain('amendment.replacementBreakMinutes === payload.replacementBreakMinutes');
  });

  it('never reclassifies an acknowledged mutation as ambiguous when readback refresh fails', () => {
    expect(hookSource).toContain('refreshAfterConfirmedPeriodMutation');
    expect(hookSource).toContain('do not repeat the completed command');
    expect(hookSource).toContain('Payroll period creation succeeded, but the period list could not be refreshed.');
    expect(hookSource).toContain('installDetail({ ...detail, period: { ...detail.period, exportBatch: batch } });');
    expect(hookSource).toContain('Reconciliation was recorded. Refresh to load the latest batch status; do not replay the completed submission.');
  });

  it('refreshes stale revisions and preserves ambiguous keyed replay', () => {
    expect(hookSource).toContain('if (page.period.revision !== baseRevision)');
    expect(hookSource).toContain("kind === 'stale'");
    expect(hookSource).toContain('replay uses the same Idempotency-Key');
    expect(hookSource).toContain('Replay the saved same request without editing it.');
  });

  it('contains no reverse-transition source in the owned route', () => {
    const forbidden = new RegExp(`(?:${'re' + 'open'}|${'un' + 'lock'})`, 'i');
    expect(ownedSources().filter((source) => forbidden.test(source))).toEqual([]);
  });
});
