'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { Check, FilePenLine, X } from 'lucide-react';
import type { PayrollAmendmentInput } from './payroll-api';
import { payrollInstantToLocalInput, payrollLocalInputToIso } from './payroll-amendment-time';
import { canCreatePayrollAmendmentForEntry, formatSignedMinutes, payrollAmendmentDecisionBlocker } from './payroll-contract';
import type { PayrollAmendment, PayrollDecision, PayrollLockedEntry, PayrollPeriodSummary } from './payroll-types';
import styles from './payroll.module.css';

type PayrollAmendmentsProps = {
  entries: PayrollLockedEntry[];
  amendments: PayrollAmendment[];
  periods: PayrollPeriodSummary[];
  sourcePeriod: PayrollPeriodSummary;
  currentUserId: string;
  canCreate: boolean;
  canDecide: boolean;
  isBusy: boolean;
  onCreate: (entryId: string, payload: PayrollAmendmentInput) => Promise<boolean>;
  onDecision: (amendmentId: string, decision: PayrollDecision, reason?: string) => Promise<void>;
};

export function PayrollAmendments({ entries, amendments, periods, sourcePeriod, currentUserId, canCreate, canDecide, isBusy, onCreate, onDecision }: PayrollAmendmentsProps) {
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [adjustmentPeriodId, setAdjustmentPeriodId] = useState('');
  const [reason, setReason] = useState('');
  const [clockIn, setClockIn] = useState('');
  const [clockOut, setClockOut] = useState('');
  const [breakMinutes, setBreakMinutes] = useState('0');
  const [decisionReason, setDecisionReason] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const editingEntry = entries.find((entry) => entry.id === editingEntryId) ?? null;

  const futureAdjustmentPeriods = useMemo(() => periods.filter((period) => (
    period.status === 'OPEN' && period.startsAt >= sourcePeriod.endsAt
  )), [periods, sourcePeriod.endsAt]);

  function openForm(entry: PayrollLockedEntry) {
    if (!canCreatePayrollAmendmentForEntry(canCreate, currentUserId, entry.employeeId)) return;
    setEditingEntryId(entry.id);
    setAdjustmentPeriodId(futureAdjustmentPeriods[0]?.id ?? '');
    setReason('');
    setClockIn(payrollInstantToLocalInput(entry.clockInAt, entry.workTimeZone));
    setClockOut(payrollInstantToLocalInput(entry.clockOutAt, entry.workTimeZone));
    setBreakMinutes(String(entry.breakMinutes));
    setFormError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingEntry || !canCreatePayrollAmendmentForEntry(canCreate, currentUserId, editingEntry.employeeId) || !adjustmentPeriodId || reason.trim().length < 5) {
      setFormError('Choose a future open period and enter an amendment reason of at least 5 characters.');
      return;
    }
    const parsedBreak = Number(breakMinutes);
    let clockInAt: string;
    let clockOutAt: string;
    try {
      clockInAt = payrollLocalInputToIso(clockIn, editingEntry.workTimeZone);
      clockOutAt = payrollLocalInputToIso(clockOut, editingEntry.workTimeZone);
    } catch (timeError) {
      setFormError(timeError instanceof Error ? timeError.message : 'Enter valid replacement times in the locked entry timezone.');
      return;
    }
    if (!Number.isSafeInteger(parsedBreak) || parsedBreak < 0 || new Date(clockOutAt) <= new Date(clockInAt)) {
      setFormError('Enter a valid replacement time range and non-negative whole break minutes.');
      return;
    }
    const created = await onCreate(editingEntry.id, {
      adjustmentPeriodId,
      reason: reason.trim(),
      replacementClockInAt: clockInAt,
      replacementClockOutAt: clockOutAt,
      replacementBreakMinutes: parsedBreak,
    });
    if (created) setEditingEntryId(null);
  }

  return (
    <section className={`surface-card ${styles.panel}`} aria-labelledby="payroll-amendments-title">
      <div className={styles.sectionHeading}>
        <div><div className="workspace-kicker">Post-lock corrections</div><h2 id="payroll-amendments-title" className={styles.sectionTitle}>Future-period amendments</h2></div>
        <FilePenLine size={19} aria-hidden="true" />
      </div>
      <p className={styles.helpText}>Original locked entries never change. An amendment records a signed minute delta in a future open period; the requester and source employee cannot decide it.</p>

      {canCreate && editingEntry ? (
        <form className={styles.amendmentForm} onSubmit={submit} noValidate>
          <div className={styles.sectionHeading}>
            <strong>Create amendment</strong>
            <button className={styles.iconButton} type="button" onClick={() => setEditingEntryId(null)} aria-label="Cancel amendment"><X size={16} aria-hidden="true" /></button>
          </div>
          <div className={styles.formGrid}>
            <label className="form-group"><span className="form-label">Future open period</span><select className="form-input" value={adjustmentPeriodId} onChange={(event) => setAdjustmentPeriodId(event.target.value)} required><option value="">Choose period</option>{futureAdjustmentPeriods.map((period) => <option key={period.id} value={period.id}>{period.localStartDate} to {period.localEndDateExclusive}</option>)}</select></label>
            <label className="form-group"><span className="form-label">Replacement clock in ({editingEntry.workTimeZone})</span><input className="form-input" type="datetime-local" value={clockIn} onChange={(event) => setClockIn(event.target.value)} required /></label>
            <label className="form-group"><span className="form-label">Replacement clock out ({editingEntry.workTimeZone})</span><input className="form-input" type="datetime-local" value={clockOut} onChange={(event) => setClockOut(event.target.value)} required /></label>
            <label className="form-group"><span className="form-label">Replacement break minutes</span><input className="form-input" type="number" min="0" step="1" value={breakMinutes} onChange={(event) => setBreakMinutes(event.target.value)} required /></label>
          </div>
          <label className="form-group"><span className="form-label">Reason</span><textarea className="form-input" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={3} required /></label>
          {formError ? <div role="alert" className={styles.inlineError}>{formError}</div> : null}
          <button className="btn btn-primary btn-sm" type="submit" disabled={isBusy || futureAdjustmentPeriods.length === 0}><FilePenLine size={15} aria-hidden="true" /> Create amendment only</button>
        </form>
      ) : null}

      <div className={styles.tableRegion} role="region" aria-label="Locked payroll evidence" tabIndex={0}>
        <table className={styles.table}>
          <caption className={styles.visuallyHidden}>Immutable locked entries available for future-period amendments</caption>
          <thead><tr><th scope="col">Entry</th><th scope="col">Employee</th><th scope="col">Payable</th><th scope="col">Evidence hash</th><th scope="col">Command</th></tr></thead>
          <tbody>{entries.map((entry) => { const canCreateForEntry = canCreatePayrollAmendmentForEntry(canCreate, currentUserId, entry.employeeId); return <tr key={entry.id}><th scope="row">#{entry.sequence}</th><td>{entry.employeeName || entry.employeeId}</td><td>{formatSignedMinutes(entry.payableMinutes)}</td><td><code>{entry.canonicalSha256}</code></td><td>{canCreateForEntry ? <button className="btn btn-secondary btn-sm" type="button" disabled={isBusy || futureAdjustmentPeriods.length === 0} onClick={() => openForm(entry)}><FilePenLine size={14} aria-hidden="true" /> Amend into future period</button> : <span className={styles.fieldHelp}>{entry.employeeId === currentUserId ? 'Unavailable for your own entry' : 'Create permission required'}</span>}</td></tr>; })}</tbody>
        </table>
      </div>

      <div className={styles.amendmentList}>
        {amendments.map((amendment) => {
          const sourceEntry = entries.find((entry) => entry.id === amendment.lockedEntryId);
          const sourceEmployeeId = sourceEntry?.employeeId ?? amendment.sourceEmployeeId;
          const adjustmentInReview = periods.some((period) => period.id === amendment.adjustmentPeriodId && period.status === 'REVIEW');
          const decisionBlocker = payrollAmendmentDecisionBlocker({
            hasDecisionPermission: canDecide,
            currentUserId,
            requestedByUserId: amendment.requestedByUserId,
            sourceEmployeeId,
            adjustmentInReview,
          });
          return <article key={amendment.id} className={styles.evidenceRow}>
            <div><strong>{formatSignedMinutes(amendment.minuteDelta)}</strong><span>{amendment.reason}</span><span>Future period {amendment.adjustmentPeriodId}</span></div>
            {amendment.decision ? <span className={styles.statusBadge}>{amendment.decision.decision}</span>
              : decisionBlocker ? <span className={styles.fieldHelp}>{decisionBlocker}</span>
                : <div className={styles.decisionBox}><input className="form-input" aria-label={`Decision reason for amendment ${amendment.id}`} placeholder="Reason for rejection (required)" maxLength={500} value={decisionReason[amendment.id] ?? ''} onChange={(event) => setDecisionReason((current) => ({ ...current, [amendment.id]: event.target.value }))} /><div className={styles.actionRow}><button className="btn btn-primary btn-sm" type="button" disabled={isBusy} onClick={() => void onDecision(amendment.id, 'APPROVED')}><Check size={14} aria-hidden="true" /> Approve amendment</button><button className="btn btn-secondary btn-sm" type="button" disabled={isBusy || (decisionReason[amendment.id] ?? '').trim().length < 5} onClick={() => void onDecision(amendment.id, 'REJECTED', decisionReason[amendment.id])}><X size={14} aria-hidden="true" /> Reject amendment</button></div></div>}
          </article>;
        })}
        {amendments.length === 0 ? <p className={styles.helpText}>No amendments have been recorded against this locked snapshot.</p> : null}
      </div>
    </section>
  );
}
