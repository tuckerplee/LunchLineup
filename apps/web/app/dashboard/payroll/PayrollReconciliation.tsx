'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { RefreshCw, Rows3, Scale } from 'lucide-react';
import { isBatchFullyReconciled, MAX_RECONCILIATION_LINES, reconciliationEditableLines, validateReconciliation } from './payroll-contract';
import type { PayrollExportBatch, PayrollLineStatus, PayrollReconciliationInput } from './payroll-types';
import type { PayrollReconciliationReplay } from './payroll-attempt';
import styles from './payroll.module.css';

type PayrollReconciliationProps = {
  batch: PayrollExportBatch;
  replay: PayrollReconciliationReplay | null;
  isBusy: boolean;
  onLoadLines: () => Promise<void>;
  onSubmit: (batchId: string, payload: PayrollReconciliationInput) => Promise<void>;
  onReplay: () => Promise<void>;
};

type OutcomeDraft = { status: '' | PayrollLineStatus; reason: string };

export function PayrollReconciliation({ batch, replay, isBusy, onLoadLines, onSubmit, onReplay }: PayrollReconciliationProps) {
  const [provider, setProvider] = useState('');
  const [providerEventId, setProviderEventId] = useState('');
  const [providerTotalMinutes, setProviderTotalMinutes] = useState(String(batch.totalPayableMinutes));
  const [outcomes, setOutcomes] = useState<Record<string, OutcomeDraft>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const lines = useMemo(() => reconciliationEditableLines(batch), [batch]);

  useEffect(() => {
    setOutcomes(Object.fromEntries(lines.map((line) => [line.id, {
      status: line.reconciliationStatus === 'PENDING' ? '' : line.reconciliationStatus,
      reason: line.reconciliationReason ?? '',
    }])));
  }, [lines]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload: PayrollReconciliationInput = {
      provider: provider.trim(),
      providerEventId: providerEventId.trim(),
      providerTotalMinutes: Number(providerTotalMinutes),
      lines: lines.flatMap((line) => {
        const outcome = outcomes[line.id];
        return outcome?.status ? [{ lineId: line.id, status: outcome.status, ...(outcome.reason.trim() ? { reason: outcome.reason.trim() } : {}) }] : [];
      }),
    };
    const validationError = validateReconciliation(payload);
    if (validationError) { setFormError(validationError); return; }
    setFormError(null);
    await onSubmit(batch.id, payload);
  }

  const complete = isBatchFullyReconciled(batch);

  return (
    <section className={`surface-card ${styles.panel}`} aria-labelledby="payroll-reconciliation-title">
      <div className={styles.sectionHeading}><div><div className="workspace-kicker">Provider evidence</div><h2 id="payroll-reconciliation-title" className={styles.sectionTitle}>Line-level reconciliation</h2></div><Scale size={19} aria-hidden="true" /></div>
      <div className={styles.reconciliationSummary} role="status">
        <span>Accepted <strong>{batch.reconciliation.acceptedCount}</strong></span><span>Rejected <strong>{batch.reconciliation.rejectedCount}</strong></span><span>Pending <strong>{batch.reconciliation.pendingCount}</strong></span><span>Provider total <strong>{batch.reconciliation.providerTotalMinutes ?? 'Not reported'}</strong></span>
      </div>
      <p className={styles.helpText}>{complete ? 'Every line is accepted and provider totals exactly match this deterministic batch.' : 'This batch is not fully reconciled. Every line must be accepted and provider total minutes must exactly equal the batch total.'}</p>

      {!complete ? <div className={styles.tableHeader}><span className={styles.loadedLabel}>{batch.lines.length} export lines explicitly loaded</span>{batch.nextLineCursor ? <button className="btn btn-secondary btn-sm" type="button" disabled={isBusy} onClick={() => void onLoadLines()}><Rows3 size={14} aria-hidden="true" /> Load next 500 lines</button> : <span className={styles.loadedLabel}>Last line page loaded</span>}</div> : null}

      {replay ? (
        <div className={styles.replayNotice} role="alert">
          <span>An ambiguous transport attempt is saved. Replay sends the exact same provider, event ID, total, and line outcomes.</span>
          <button className="btn btn-primary btn-sm" type="button" disabled={isBusy} onClick={() => void onReplay()}><RefreshCw size={14} aria-hidden="true" /> Replay same request</button>
        </div>
      ) : null}

      {!complete && !replay && lines.length > 0 ? (
        <form className={styles.reconciliationForm} onSubmit={submit} noValidate>
          <div className={styles.formGrid}>
            <label className="form-group"><span className="form-label">Provider</span><input className="form-input" value={provider} onChange={(event) => setProvider(event.target.value)} maxLength={100} required /></label>
            <label className="form-group"><span className="form-label">Provider event ID</span><input className="form-input" value={providerEventId} onChange={(event) => setProviderEventId(event.target.value)} maxLength={200} required /></label>
            <label className="form-group"><span className="form-label">Provider total minutes</span><input className="form-input" type="number" step="1" value={providerTotalMinutes} onChange={(event) => setProviderTotalMinutes(event.target.value)} required /></label>
          </div>
          {batch.nextLineCursor || batch.lines.length > MAX_RECONCILIATION_LINES ? <div role="status" className={styles.partialNotice}>This request is limited to {MAX_RECONCILIATION_LINES} explicitly loaded correctable lines. Record them, then load later bounded pages.</div> : null}
          <div className={styles.tableRegion} role="region" aria-label="Export line reconciliation outcomes" tabIndex={0}>
            <table className={styles.table}><caption className={styles.visuallyHidden}>Explicit outcomes for deterministic export lines</caption><thead><tr><th scope="col">Line</th><th scope="col">Employee</th><th scope="col">Minutes</th><th scope="col">Current</th><th scope="col">New outcome</th><th scope="col">Reason</th></tr></thead><tbody>{lines.map((line) => <tr key={line.id}><th scope="row">{line.lineNumber}</th><td>{line.employeeId}</td><td>{line.payableMinutes}</td><td>{line.reconciliationStatus}</td><td><select className="form-input" aria-label={`Outcome for export line ${line.lineNumber}`} value={outcomes[line.id]?.status ?? ''} onChange={(event) => setOutcomes((current) => ({ ...current, [line.id]: { ...(current[line.id] ?? { reason: '' }), status: event.target.value as OutcomeDraft['status'] } }))}><option value="">Choose outcome</option><option value="ACCEPTED">Accepted</option><option value="REJECTED">Rejected</option><option value="PENDING">Pending</option></select></td><td><input className="form-input" aria-label={`Reason for export line ${line.lineNumber}`} value={outcomes[line.id]?.reason ?? ''} onChange={(event) => setOutcomes((current) => ({ ...current, [line.id]: { ...(current[line.id] ?? { status: '' }), reason: event.target.value } }))} maxLength={500} /></td></tr>)}</tbody></table>
          </div>
          {formError ? <div role="alert" className={styles.inlineError}>{formError}</div> : null}
          <button className="btn btn-primary btn-sm" type="submit" disabled={isBusy}><Scale size={14} aria-hidden="true" /> Record explicit line outcomes</button>
        </form>
      ) : null}
      {!complete && !replay && lines.length === 0 ? <div role="status" className={styles.partialNotice}>{batch.nextLineCursor ? 'Load the next bounded page to reach correctable lines.' : 'No explicitly loaded lines are available for reconciliation correction.'}</div> : null}
    </section>
  );
}
