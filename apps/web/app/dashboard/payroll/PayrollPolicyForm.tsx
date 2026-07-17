'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { ChevronDown, FilePlus2, History } from 'lucide-react';
import { validatePayrollPolicy, type PayrollPolicyErrors } from './payroll-contract';
import type { PayrollCadence, PayrollPolicyInput, PayrollPolicyVersion } from './payroll-types';
import styles from './payroll.module.css';

type PayrollPolicyFormProps = {
  currentPolicy: PayrollPolicyVersion | null;
  policies: PayrollPolicyVersion[];
  hasMore: boolean;
  canCreate: boolean;
  isBusy: boolean;
  onCreate: (input: PayrollPolicyInput) => Promise<boolean>;
  onLoadMore: () => Promise<void>;
};

const COMMON_TIME_ZONES = [
  'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York',
  'America/Anchorage', 'Pacific/Honolulu', 'Etc/UTC',
];

function localToday(timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${value.year}-${value.month}-${value.day}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function PayrollPolicyForm({
  currentPolicy,
  policies,
  hasMore,
  canCreate,
  isBusy,
  onCreate,
  onLoadMore,
}: PayrollPolicyFormProps) {
  const [timeZone, setTimeZone] = useState(currentPolicy?.timeZone ?? 'America/Los_Angeles');
  const [cadence, setCadence] = useState<PayrollCadence>(currentPolicy?.cadence ?? 'BIWEEKLY');
  const [anchorDate, setAnchorDate] = useState(currentPolicy?.anchorDate ?? '');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [errors, setErrors] = useState<PayrollPolicyErrors>({});

  useEffect(() => {
    if (!currentPolicy) return;
    setTimeZone(currentPolicy.timeZone);
    setCadence(currentPolicy.cadence);
    setAnchorDate(currentPolicy.anchorDate);
  }, [currentPolicy]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = { timeZone: timeZone.trim(), cadence, anchorDate, effectiveFrom };
    const nextErrors = validatePayrollPolicy(input, localToday(input.timeZone), currentPolicy);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    const created = await onCreate(input);
    if (created) setEffectiveFrom('');
  }

  return (
    <section className={`surface-card ${styles.panel}`} aria-labelledby="payroll-policy-title">
      <div className={styles.sectionHeading}>
        <div>
          <div className="workspace-kicker">Policy versions</div>
          <h2 id="payroll-policy-title" className={styles.sectionTitle}>Immutable payroll calendar</h2>
        </div>
        <History size={19} aria-hidden="true" />
      </div>

      <ol className={styles.policyTimeline} aria-label="Payroll policy version history">
        {policies.map((policy) => (
          <li key={policy.id}>
            <strong>Version {policy.version}</strong>
            <span>Effective {policy.effectiveFrom}</span>
            <span>{policy.cadence === 'WEEKLY' ? 'Weekly' : 'Biweekly'} · {policy.timeZone}</span>
            <span>Anchor {policy.anchorDate}</span>
          </li>
        ))}
        {policies.length === 0 ? <li>No payroll policy version exists yet.</li> : null}
      </ol>
      {hasMore ? (
        <button className="btn btn-secondary btn-sm" type="button" disabled={isBusy} onClick={() => void onLoadMore()}>
          <ChevronDown size={15} aria-hidden="true" /> Load older versions
        </button>
      ) : null}

      {canCreate ? (
        <form className={styles.policyVersionForm} onSubmit={submit} noValidate>
          <div className={styles.formHeading}>
            <FilePlus2 size={17} aria-hidden="true" />
            <div>
              <strong>{currentPolicy ? 'Create a future version' : 'Create initial version'}</strong>
              <span>{currentPolicy
                ? 'Timezone is fixed. The future boundary must align with both the prior and new cadence anchors.'
                : 'Version 1 may establish an aligned historical boundary. Existing versions are never edited.'}</span>
            </div>
          </div>
          <div className={styles.policyGrid}>
            <label className="form-group">
              <span className="form-label">IANA time zone</span>
              <input className="form-input" value={timeZone} onChange={(event) => setTimeZone(event.target.value)} list={currentPolicy ? undefined : 'payroll-time-zones'} autoComplete="off" readOnly={Boolean(currentPolicy)} aria-readonly={Boolean(currentPolicy)} aria-invalid={Boolean(errors.timeZone)} aria-describedby={errors.timeZone ? 'payroll-time-zone-error' : 'payroll-time-zone-help'} required />
              <datalist id="payroll-time-zones">{COMMON_TIME_ZONES.map((zone) => <option key={zone} value={zone} />)}</datalist>
              <span id="payroll-time-zone-help" className={styles.fieldHelp}>{currentPolicy ? 'Fixed after version 1.' : 'Use a named IANA zone, not a fixed offset.'}</span>
              {errors.timeZone ? <span id="payroll-time-zone-error" role="alert" className={styles.fieldError}>{errors.timeZone}</span> : null}
            </label>
            <label className="form-group">
              <span className="form-label">Cadence</span>
              <select className="form-input" value={cadence} onChange={(event) => setCadence(event.target.value as PayrollCadence)}>
                <option value="WEEKLY">Weekly</option><option value="BIWEEKLY">Biweekly</option>
              </select>
            </label>
            <label className="form-group">
              <span className="form-label">Calendar anchor</span>
              <input className="form-input" type="date" value={anchorDate} onChange={(event) => setAnchorDate(event.target.value)} aria-invalid={Boolean(errors.anchorDate)} aria-describedby={errors.anchorDate ? 'payroll-anchor-error' : undefined} required />
              {errors.anchorDate ? <span id="payroll-anchor-error" role="alert" className={styles.fieldError}>{errors.anchorDate}</span> : null}
            </label>
            <label className="form-group">
              <span className="form-label">{currentPolicy ? 'Future effective date' : 'Effective date'}</span>
              <input className="form-input" type="date" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} aria-invalid={Boolean(errors.effectiveFrom)} aria-describedby={errors.effectiveFrom ? 'payroll-effective-error' : undefined} required />
              {errors.effectiveFrom ? <span id="payroll-effective-error" role="alert" className={styles.fieldError}>{errors.effectiveFrom}</span> : null}
            </label>
          </div>
          <button className="btn btn-primary btn-sm" type="submit" disabled={isBusy}>
            <FilePlus2 size={15} aria-hidden="true" /> {isBusy ? 'Creating...' : 'Create policy version'}
          </button>
        </form>
      ) : null}
    </section>
  );
}
