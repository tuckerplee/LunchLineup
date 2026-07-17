'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, CheckCheck, Download, FileDown, LockKeyhole, Rows3, ScanSearch, X } from 'lucide-react';
import type { PayrollCapabilities } from '@/lib/permissions';
import { formatSignedMinutes, formatWorkedMinutes, hasExportablePayrollEntries, MAX_PAYROLL_BULK_ROWS, payrollReadiness, payrollStatusExplanation } from './payroll-contract';
import { PayrollAmendments } from './PayrollAmendments';
import { PayrollReconciliation } from './PayrollReconciliation';
import type { PayrollAmendmentInput } from './payroll-api';
import type { PayrollReconciliationReplay } from './payroll-attempt';
import type { PayrollCard, PayrollDecision, PayrollPeriodDetail as PeriodDetail, PayrollPeriodSummary, PayrollReconciliationInput } from './payroll-types';
import styles from './payroll.module.css';

type Confirmation = 'lock' | 'export' | null;

type PayrollPeriodDetailProps = {
  detail: PeriodDetail;
  periods: PayrollPeriodSummary[];
  capabilities: PayrollCapabilities;
  currentUserId: string;
  creditCost: number | null;
  creditCostError: string | null;
  reconciliationReplay: PayrollReconciliationReplay | null;
  busyAction: string | null;
  onLoadCards: () => Promise<void>;
  onLoadExportLines: () => Promise<void>;
  onAdopt: (cardIds: string[]) => Promise<void>;
  onDecision: (cardIds: string[], decision: PayrollDecision, reason?: string) => Promise<void>;
  onReview: () => Promise<void>;
  onLock: () => Promise<void>;
  onAmendment: (entryId: string, input: PayrollAmendmentInput) => Promise<boolean>;
  onAmendmentDecision: (amendmentId: string, decision: PayrollDecision, reason?: string) => Promise<void>;
  onExport: (confirmedCost: number) => Promise<void>;
  onDownload: () => Promise<void>;
  onReconcile: (batchId: string, input: PayrollReconciliationInput) => Promise<void>;
  onReplayReconciliation: () => Promise<void>;
};

function formatCardTime(timestamp: string, timeZone: string): string {
  try { return new Intl.DateTimeFormat(undefined, { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp)); }
  catch { return new Date(timestamp).toLocaleString(); }
}

function employeeLabel(card: PayrollCard): string {
  return card.user.name || card.user.username || card.user.id;
}

export function PayrollPeriodDetail({
  detail, periods, capabilities, currentUserId, creditCost, creditCostError, reconciliationReplay, busyAction,
  onLoadCards, onLoadExportLines, onAdopt, onDecision, onReview, onLock, onAmendment, onAmendmentDecision,
  onExport, onDownload, onReconcile, onReplayReconciliation,
}: PayrollPeriodDetailProps) {
  const { period, cards, nextCardCursor, lockedEntries, amendments } = detail;
  const readiness = payrollReadiness(period);
  const hasExportableEntries = hasExportablePayrollEntries(period);
  const isBusy = busyAction !== null;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [decision, setDecision] = useState<PayrollDecision>('APPROVED');
  const [decisionReason, setDecisionReason] = useState('');
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const confirmationRef = useRef<HTMLDivElement>(null);

  const selectableCards = useMemo(() => cards.filter((card) => (
    period.status === 'OPEN' ? capabilities.canWritePayrollPolicy && card.adoptionEligible
      : period.status === 'REVIEW' ? capabilities.canApprovePayrollTimeCards && card.included && !card.decisionIsCurrent
        : false
  )), [capabilities.canApprovePayrollTimeCards, capabilities.canWritePayrollPolicy, cards, period.status]);

  useEffect(() => {
    setSelected((current) => new Set([...current].filter((id) => selectableCards.some((card) => card.id === id))));
  }, [period.id, period.revision, selectableCards]);

  useEffect(() => { if (confirmation) confirmationRef.current?.focus(); }, [confirmation]);

  function toggle(cardId: string) {
    setSelectionError(null);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(cardId)) next.delete(cardId);
      else if (next.size >= MAX_PAYROLL_BULK_ROWS) setSelectionError(`Select at most ${MAX_PAYROLL_BULK_ROWS} explicitly loaded rows.`);
      else next.add(cardId);
      return next;
    });
  }

  async function submitSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (period.status === 'OPEN') await onAdopt(ids);
    if (period.status === 'REVIEW') await onDecision(ids, decision, decision === 'REJECTED' ? decisionReason : undefined);
    setSelected(new Set());
  }

  async function confirm() {
    if (confirmation === 'lock') await onLock();
    if (confirmation === 'export' && creditCost !== null && hasExportableEntries) await onExport(creditCost);
    setConfirmation(null);
  }

  const batch = period.exportBatch;
  const showAmendments = (period.status === 'LOCKED' || amendments.length > 0)
    && (capabilities.canReconcilePayroll || capabilities.canApprovePayrollTimeCards);

  return (
    <div className={styles.detailStack}>
      <section className={`surface-card ${styles.panel}`} aria-labelledby="payroll-period-title">
        <div className={styles.sectionHeading}>
          <div><div className="workspace-kicker">Selected period</div><h2 id="payroll-period-title" className={styles.sectionTitle}>{period.localStartDate} to {period.localEndDateExclusive}</h2></div>
          <span className={`${styles.statusBadge} ${styles[`status${period.status}`]}`}>{period.status}</span>
        </div>
        <p className={styles.helpText}>{payrollStatusExplanation(period)}</p>
        <dl className={styles.stats} aria-label="Authoritative payroll readiness">
          <div><dt>Assigned</dt><dd>{period.summary.cardCount}</dd></div>
          <div><dt>Closed</dt><dd>{period.summary.closedCardCount}</dd></div>
          <div><dt>Exact approvals</dt><dd>{period.summary.approvedCardCount}</dd></div>
          <div><dt>Rejected</dt><dd>{period.summary.rejectedCardCount}</dd></div>
          <div><dt>Pending / stale</dt><dd>{period.summary.pendingCardCount}</dd></div>
          <div><dt>Amendments pending</dt><dd>{period.summary.pendingAmendmentCount}</dd></div>
          <div><dt>Revision</dt><dd>{period.revision}</dd></div>
        </dl>
        <div className={styles.actionRow}>
          {period.status === 'OPEN' && capabilities.canLockPayroll ? <button className="btn btn-primary btn-sm" type="button" disabled={isBusy || !readiness.canStartReview} onClick={() => void onReview()}><ScanSearch size={15} aria-hidden="true" /> Start review</button> : null}
          {period.status === 'REVIEW' && capabilities.canLockPayroll ? <button className="btn btn-primary btn-sm" type="button" disabled={isBusy || !readiness.canLock} onClick={() => setConfirmation('lock')}><LockKeyhole size={15} aria-hidden="true" /> Terminal lock</button> : null}
          {period.status === 'LOCKED' && capabilities.canExportPayroll && hasExportableEntries && !batch ? <button className="btn btn-primary btn-sm" type="button" disabled={isBusy || creditCost === null} onClick={() => setConfirmation('export')}><FileDown size={15} aria-hidden="true" /> Create deterministic export</button> : null}
          {period.status === 'LOCKED' && capabilities.canExportPayroll && hasExportableEntries && batch ? <button className="btn btn-secondary btn-sm" type="button" disabled={isBusy} onClick={() => void onDownload()}><Download size={15} aria-hidden="true" /> Download existing batch</button> : null}
        </div>
        {period.status === 'LOCKED' ? <div className={styles.lockEvidence}><span>Entry hash <code>{period.lockedEntrySha256 ?? 'Not provided'}</code></span><span>Count <strong>{period.lockedEntryCount}</strong></span><span>Signed minutes <strong>{formatSignedMinutes(period.totalPayableMinutes ?? 0)}</strong></span></div> : null}
        {period.status === 'LOCKED' && capabilities.canExportPayroll && !hasExportableEntries ? <div role="status" className={styles.partialNotice}>This terminal snapshot has no entries, so no export batch can be created.</div> : null}
        {period.status === 'LOCKED' && capabilities.canExportPayroll && hasExportableEntries && creditCostError && !batch ? <div role="alert" className={styles.inlineError}>{creditCostError}</div> : null}
      </section>

      {confirmation ? <div ref={confirmationRef} className={`surface-card ${styles.confirmation}`} role="alertdialog" aria-modal="false" aria-labelledby="payroll-confirmation-title" tabIndex={-1} onKeyDown={(event) => { if (event.key === 'Escape' && !isBusy) setConfirmation(null); }}>
        <div className={styles.sectionHeading}><h3 id="payroll-confirmation-title" className={styles.confirmationTitle}>{confirmation === 'lock' ? 'Create the terminal lock?' : 'Create the deterministic export?'}</h3><button className={styles.iconButton} type="button" onClick={() => setConfirmation(null)} aria-label="Cancel confirmation"><X size={16} aria-hidden="true" /></button></div>
        <p>{confirmation === 'lock' ? 'This permanently snapshots exact approved versions. Original locked entries cannot be changed; later corrections require future-period amendments.' : <>This operation consumes exactly <strong>{creditCost} {creditCost === 1 ? 'credit' : 'credits'}</strong>. The authoritative cost is checked again. Downloads never consume credits.</>}</p>
        <div className={styles.actionRow}><button className="btn btn-primary btn-sm" type="button" disabled={isBusy} onClick={() => void confirm()}>{confirmation === 'lock' ? <LockKeyhole size={15} aria-hidden="true" /> : <FileDown size={15} aria-hidden="true" />}{isBusy ? 'Working...' : confirmation === 'lock' ? 'Confirm terminal lock' : 'Confirm exact cost'}</button><button className="btn btn-secondary btn-sm" type="button" disabled={isBusy} onClick={() => setConfirmation(null)}>Cancel</button></div>
      </div> : null}

      {period.status !== 'LOCKED' ? <section className={`surface-card ${styles.tablePanel}`} aria-labelledby="payroll-cards-title">
        <div className={styles.tableHeader}><div><div className="workspace-kicker">Bounded card pages</div><h2 id="payroll-cards-title" className={styles.sectionTitle}>{cards.length} explicitly loaded</h2></div>{nextCardCursor ? <button className="btn btn-secondary btn-sm" type="button" disabled={isBusy} onClick={() => void onLoadCards()}><Rows3 size={15} aria-hidden="true" /> Load next {250}</button> : <span className={styles.loadedLabel}><Check size={14} aria-hidden="true" /> Last page loaded</span>}</div>
        <div className={styles.partialNotice} role="status">Readiness above is authoritative and independent of this paginated view. Bulk commands affect only selected loaded rows, never more than {MAX_PAYROLL_BULK_ROWS}.</div>
        {selectableCards.length > 0 ? <div className={styles.bulkBar}>
          <span>{selected.size} selected</span>
          {period.status === 'REVIEW' ? <><label className="form-group"><span className="form-label">Decision</span><select className="form-input" value={decision} onChange={(event) => setDecision(event.target.value as PayrollDecision)}><option value="APPROVED">Approve exact versions</option><option value="REJECTED">Reject</option></select></label>{decision === 'REJECTED' ? <label className="form-group"><span className="form-label">Rejection reason</span><input className="form-input" value={decisionReason} onChange={(event) => setDecisionReason(event.target.value)} maxLength={500} required /></label> : null}</> : null}
          <button className="btn btn-primary btn-sm" type="button" disabled={isBusy || selected.size === 0 || (decision === 'REJECTED' && decisionReason.trim().length < 5)} onClick={() => void submitSelected()}><CheckCheck size={15} aria-hidden="true" /> {period.status === 'OPEN' ? 'Adopt selected history' : 'Record selected decisions'}</button>
        </div> : null}
        {selectionError ? <div role="alert" className={styles.inlineError}>{selectionError}</div> : null}
        <div className={styles.tableRegion} role="region" aria-label="Payroll time cards" tabIndex={0}><table className={styles.table}><caption className={styles.visuallyHidden}>Explicitly loaded time-card rows</caption><thead><tr>{selectableCards.length > 0 ? <th scope="col">Select</th> : null}<th scope="col">Employee</th><th scope="col">Clock in</th><th scope="col">Clock out</th><th scope="col">Payable</th><th scope="col">Inclusion</th><th scope="col">Decision</th></tr></thead><tbody>{cards.map((card) => { const selectable = selectableCards.some((candidate) => candidate.id === card.id); return <tr key={card.id}>{selectableCards.length > 0 ? <td>{selectable ? <input type="checkbox" checked={selected.has(card.id)} onChange={() => toggle(card.id)} disabled={isBusy} aria-label={`Select ${employeeLabel(card)} loaded payroll row`} /> : null}</td> : null}<th scope="row"><strong>{employeeLabel(card)}</strong><span>Revision {card.timeCardRevision}</span></th><td>{formatCardTime(card.clockInAt, card.displayTimeZone)}</td><td>{formatCardTime(card.clockOutAt, card.displayTimeZone)}</td><td>{formatWorkedMinutes(card.payableMinutes)}</td><td>{card.included ? 'Included' : card.adoptionEligible ? 'Historical eligible' : 'Excluded'}</td><td>{card.decision ? `${card.decision.decision}${card.decisionIsCurrent ? '' : ' (stale)'}` : 'None'}</td></tr>; })}</tbody></table></div>
      </section> : null}

      {period.status === 'LOCKED' && !showAmendments ? <section className={`surface-card ${styles.tablePanel}`} aria-labelledby="locked-evidence-title"><div className={styles.tableHeader}><h2 id="locked-evidence-title" className={styles.sectionTitle}>Immutable evidence rows</h2></div><div className={styles.tableRegion} role="region" aria-label="Immutable locked payroll entries" tabIndex={0}><table className={styles.table}><caption className={styles.visuallyHidden}>Immutable locked payroll evidence</caption><thead><tr><th scope="col">Entry</th><th scope="col">Employee</th><th scope="col">Source</th><th scope="col">Payable</th><th scope="col">Canonical hash</th></tr></thead><tbody>{lockedEntries.map((entry) => <tr key={entry.id}><th scope="row">#{entry.sequence}</th><td>{entry.employeeName || entry.employeeId}</td><td>{entry.sourceType} r{entry.sourceRevision}</td><td>{formatSignedMinutes(entry.payableMinutes)}</td><td><code>{entry.canonicalSha256}</code></td></tr>)}</tbody></table></div></section> : null}

      {showAmendments ? <PayrollAmendments entries={lockedEntries} amendments={amendments} periods={periods} sourcePeriod={period} currentUserId={currentUserId} canCreate={period.status === 'LOCKED' && capabilities.canReconcilePayroll} canDecide={capabilities.canApprovePayrollTimeCards} isBusy={isBusy} onCreate={onAmendment} onDecision={onAmendmentDecision} /> : null}

      {batch ? <section className={`surface-card ${styles.panel}`} aria-labelledby="export-batch-title"><div className={styles.sectionHeading}><div><div className="workspace-kicker">Deterministic batch</div><h2 id="export-batch-title" className={styles.sectionTitle}>{batch.status}</h2></div><span className={styles.statusBadge}>{batch.rowCount} rows</span></div><dl className={styles.exportDetails}><div><dt>SHA-256</dt><dd><code>{batch.contentSha256 || 'Not provided'}</code></dd></div><div><dt>Signed payable</dt><dd>{formatSignedMinutes(batch.totalPayableMinutes)}</dd></div><div><dt>Consumed</dt><dd>{batch.settlement.consumedCredits} credits</dd></div><div><dt>Balance</dt><dd>{batch.settlement.newBalance}</dd></div></dl><p className={styles.helpText}>A locked or exported batch is not payroll-final. Authoritative payroll remains external until every line is accepted and exact totals are reconciled.</p></section> : null}

      {batch && capabilities.canReconcilePayroll ? <PayrollReconciliation batch={batch} replay={reconciliationReplay} isBusy={isBusy} onLoadLines={onLoadExportLines} onSubmit={onReconcile} onReplay={onReplayReconciliation} /> : null}
    </div>
  );
}
