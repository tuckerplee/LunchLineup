import { formatSignedMinutes } from './payroll-contract';
import type { PayrollCard, PayrollExportBatch, PayrollLockedEntry, PayrollPeriodSummary } from './payroll-types';
import styles from './payroll.module.css';

type PayrollAuditDetailsProps = {
  period: PayrollPeriodSummary;
  cards: PayrollCard[];
  lockedEntries: PayrollLockedEntry[];
  batch: PayrollExportBatch | null | undefined;
};

function employeeLabel(card: PayrollCard): string {
  return card.user.name || card.user.username || card.user.id;
}

export function PayrollAuditDetails({ period, cards, lockedEntries, batch }: PayrollAuditDetailsProps) {
  return (
    <details className={`surface-card ${styles.auditDetails}`}>
      <summary>Audit details</summary>
      <div className={styles.auditBody}>
        <p className={styles.helpText}>Technical evidence for troubleshooting and independent review. Manager actions use payload-bound idempotency keys, and locked entries remain immutable.</p>
        <dl className={styles.auditFacts}>
          <div><dt>Period revision</dt><dd>{period.revision}</dd></div>
          <div><dt>Idempotency</dt><dd>Payload-bound command protection</dd></div>
          {period.status === 'LOCKED' ? <>
            <div><dt>Locked entry SHA-256</dt><dd><code>{period.lockedEntrySha256 ?? 'Not provided'}</code></dd></div>
            <div><dt>Locked entries</dt><dd>{period.lockedEntryCount ?? 0}</dd></div>
            <div><dt>Signed minutes</dt><dd>{formatSignedMinutes(period.totalPayableMinutes ?? 0)}</dd></div>
          </> : null}
          {batch ? <>
            <div><dt>Export SHA-256</dt><dd><code>{batch.contentSha256 || 'Not provided'}</code></dd></div>
            <div><dt>Export format</dt><dd>Version {batch.formatVersion}</dd></div>
          </> : null}
        </dl>

        {cards.length > 0 ? <div className={styles.auditSection}>
          <h3>Time-card revisions</h3>
          <div className={styles.tableRegion} role="region" aria-label="Payroll time-card revision evidence" tabIndex={0}>
            <table className={styles.table}>
              <caption className={styles.visuallyHidden}>Loaded payroll time-card revisions</caption>
              <thead><tr><th scope="col">Employee</th><th scope="col">Revision</th><th scope="col">Decision revision</th></tr></thead>
              <tbody>{cards.map((card) => <tr key={card.id}><th scope="row">{employeeLabel(card)}</th><td>{card.timeCardRevision}</td><td>{card.decision?.timeCardRevision ?? 'None'}</td></tr>)}</tbody>
            </table>
          </div>
        </div> : null}

        {lockedEntries.length > 0 ? <div className={styles.auditSection}>
          <h3>Immutable locked entries</h3>
          <div className={styles.tableRegion} role="region" aria-label="Immutable locked payroll evidence" tabIndex={0}>
            <table className={styles.table}>
              <caption className={styles.visuallyHidden}>Immutable locked payroll evidence</caption>
              <thead><tr><th scope="col">Entry</th><th scope="col">Employee</th><th scope="col">Source</th><th scope="col">Payable</th><th scope="col">Canonical hash</th></tr></thead>
              <tbody>{lockedEntries.map((entry) => <tr key={entry.id}><th scope="row">#{entry.sequence}</th><td>{entry.employeeName || entry.employeeId}</td><td>{entry.sourceType} r{entry.sourceRevision}</td><td>{formatSignedMinutes(entry.payableMinutes)}</td><td><code>{entry.canonicalSha256}</code></td></tr>)}</tbody>
            </table>
          </div>
        </div> : null}
      </div>
    </details>
  );
}
