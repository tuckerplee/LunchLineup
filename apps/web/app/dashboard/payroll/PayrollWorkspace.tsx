'use client';

import { useState, type FormEvent } from 'react';
import { CalendarPlus, ChevronDown, RefreshCw } from 'lucide-react';
import type { PayrollCapabilities } from '@/lib/permissions';
import { isBatchFullyReconciled, isCalendarDate } from './payroll-contract';
import { PayrollPeriodDetail } from './PayrollPeriodDetail';
import { PayrollPolicyForm } from './PayrollPolicyForm';
import { usePayrollWorkspace } from './use-payroll-workspace';
import styles from './payroll.module.css';

type PayrollWorkspaceProps = {
  capabilities: PayrollCapabilities;
  currentUserId: string;
};

export function PayrollWorkspace({ capabilities, currentUserId }: PayrollWorkspaceProps) {
  const payroll = usePayrollWorkspace(capabilities.canExportPayroll, currentUserId);
  const [newPeriodStart, setNewPeriodStart] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  async function createPeriod(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isCalendarDate(newPeriodStart)) { setCreateError('Choose a valid local period start date.'); return; }
    setCreateError(null);
    await payroll.createPeriod(newPeriodStart);
  }

  if (payroll.busyAction === 'bootstrap') {
    return <section className={`surface-card ${styles.loading}`} role="status" aria-live="polite">Loading payroll...</section>;
  }

  const fullyReconciled = payroll.detail?.period.exportBatch
    ? isBatchFullyReconciled(payroll.detail.period.exportBatch)
    : false;

  return (
    <div className={styles.workspace}>
      <header className={styles.pageHeader}>
        <div><div className="workspace-kicker">Manager workspace</div><h1>Payroll</h1><p>Versioned policy, exact review decisions, terminal evidence, amendments, export, and provider reconciliation.</p></div>
        <button className="btn btn-secondary btn-sm" type="button" disabled={payroll.busyAction !== null} onClick={() => void payroll.retryBootstrap()}><RefreshCw size={15} aria-hidden="true" /> Refresh</button>
      </header>

      {!fullyReconciled ? <div role="note" className={styles.sourceNotice}>Operational records and locked batches are not payroll-final. The external payroll system remains authoritative for wages, taxes, and filings until every export line is accepted and exact totals are reconciled.</div> : null}
      {payroll.error ? <div role="alert" aria-live="assertive" className={styles.errorBanner}>{payroll.error}</div> : null}
      {payroll.notice ? <div role="status" aria-live="polite" className={styles.noticeBanner}>{payroll.notice}</div> : null}

      <PayrollPolicyForm currentPolicy={payroll.currentPolicy} policies={payroll.policies} hasMore={Boolean(payroll.nextPolicyCursor)} canCreate={capabilities.canWritePayrollPolicy} isBusy={payroll.busyAction === 'policy' || payroll.busyAction === 'policies'} onCreate={payroll.createPolicy} onLoadMore={payroll.loadMorePolicies} />

      <section className={`surface-card ${styles.panel}`} aria-labelledby="payroll-period-selector-title">
        <div className={styles.sectionHeading}><div><div className="workspace-kicker">Periods</div><h2 id="payroll-period-selector-title" className={styles.sectionTitle}>Select a payroll period</h2></div></div>
        <div className={styles.periodControls}>
          <label className="form-group"><span className="form-label">Selected period</span><select className="form-input" value={payroll.selectedPeriodId} onChange={(event) => void payroll.loadPeriod(event.target.value)} disabled={payroll.periods.length === 0 || payroll.busyAction !== null}>{payroll.periods.length === 0 ? <option value="">No periods yet</option> : null}{payroll.periods.map((period) => <option key={period.id} value={period.id}>{period.localStartDate} to {period.localEndDateExclusive} · {period.status}</option>)}</select></label>
          {capabilities.canWritePayrollPolicy ? <form className={styles.createPeriodForm} onSubmit={createPeriod} noValidate><label className="form-group"><span className="form-label">New local start date</span><input className="form-input" type="date" value={newPeriodStart} onChange={(event) => setNewPeriodStart(event.target.value)} aria-invalid={Boolean(createError)} aria-describedby={createError ? 'payroll-create-period-error' : undefined} required />{createError ? <span id="payroll-create-period-error" role="alert" className={styles.fieldError}>{createError}</span> : null}</label><button className="btn btn-primary btn-sm" type="submit" disabled={payroll.busyAction !== null}><CalendarPlus size={15} aria-hidden="true" /> {payroll.busyAction === 'period-create' ? 'Creating...' : 'Create period'}</button></form> : null}
        </div>
        {payroll.nextPeriodCursor ? <button className="btn btn-secondary btn-sm" type="button" disabled={payroll.busyAction !== null} onClick={() => void payroll.loadMorePeriods()}><ChevronDown size={15} aria-hidden="true" /> Load older periods</button> : null}
      </section>

      {payroll.busyAction === 'period' ? <section className={`surface-card ${styles.loading}`} role="status" aria-live="polite">Loading selected period...</section> : null}
      {payroll.detail ? <PayrollPeriodDetail detail={payroll.detail} periods={payroll.periods} capabilities={capabilities} currentUserId={currentUserId} creditCost={payroll.creditCost} creditCostError={payroll.creditCostError} reconciliationReplay={payroll.reconciliationReplay} busyAction={payroll.busyAction} onLoadCards={payroll.loadMoreCards} onLoadExportLines={payroll.loadMoreExportLines} onAdopt={payroll.adoptCards} onDecision={payroll.decideCards} onReview={payroll.startReview} onLock={payroll.lockPeriod} onAmendment={payroll.createAmendment} onAmendmentDecision={payroll.decideAmendment} onExport={payroll.exportPeriod} onDownload={payroll.downloadExport} onReconcile={payroll.reconcileExport} onReplayReconciliation={payroll.replaySavedReconciliation} /> : null}
    </div>
  );
}
