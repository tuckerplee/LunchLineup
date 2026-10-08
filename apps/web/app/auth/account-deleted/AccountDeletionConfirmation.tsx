'use client';

import { CheckCircle2, Clock3 } from 'lucide-react';
import { fetchJsonWithSession } from '@/lib/client-api';
import { useEffect, useState } from 'react';
import {
  ACCOUNT_DELETION_RECOVERY_KEY,
  ACCOUNT_DELETION_RECEIPT_STORAGE_KEY,
  accountDeletionReceiptFromResponse,
  storeAccountDeletionReceipt,
  type AccountDeletionResponse,
  readAccountDeletionReceipt,
  type AccountDeletionReceipt,
} from './account-deletion-receipt';

function formatDate(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

export function AccountDeletionConfirmation() {
  const [receipt, setReceipt] = useState<AccountDeletionReceipt | null>();

  const [recoveryMessage, setRecoveryMessage] = useState('Checking whether the deletion request was recorded.');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stored = readAccountDeletionReceipt(window.sessionStorage);
    if (stored) { setReceipt(stored); return; }
    const token = window.sessionStorage.getItem(ACCOUNT_DELETION_RECOVERY_KEY);
    if (!token) { setRecoveryMessage('This tab does not have a recent deletion receipt. Contact support to confirm the request.'); setReceipt(null); return; }
    setReceipt(undefined);
    let attempts = 0;
    async function recover() {
      try {
        const result = await fetchJsonWithSession<{ state: string; receipt: AccountDeletionResponse | null }>('/account-deletion/receipt', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
        });
        if (cancelled) return;
        if (result.state === 'CONFIRMED' && result.receipt) {
          const confirmed = accountDeletionReceiptFromResponse(result.receipt);
          storeAccountDeletionReceipt(window.sessionStorage, confirmed);
          setReceipt(confirmed);
          return;
        }
        setRecoveryMessage('Deletion has not been confirmed yet. The request may still be processing.');
      } catch {
        if (cancelled) return;
        setRecoveryMessage('Deletion confirmation is temporarily unavailable. This does not establish whether the request completed.');
      }
      if (++attempts < 15) timer = setTimeout(() => void recover(), 2000);
      else setReceipt(null);
    }
    void recover();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [retry]);

  if (receipt === undefined) {
    return (
      <div className="public-doc__intro" role="status" aria-live="polite">
        <span className="public-home__eyebrow">
          <Clock3 size={16} aria-hidden="true" />
          Deletion receipt
        </span>
        <h1>Preparing confirmation</h1>
        <p>{recoveryMessage}</p>
      </div>
    );
  }

  if (!receipt) {
    return (
      <div className="public-doc__intro">
        <span className="public-home__eyebrow">
          <Clock3 size={16} aria-hidden="true" />
          Deletion receipt
        </span>
        <h1>Deletion receipt unavailable</h1>
        <p>{recoveryMessage}</p>
        <button className="btn btn-primary" onClick={() => setRetry((value) => value + 1)}>Check deletion status again</button>
        <p><a href="/dashboard/settings">Return to account settings</a> if the request was not submitted.</p>
      </div>
    );
  }

  const billingCleanupPending = receipt.deletionState === 'PENDING_BILLING_CLEANUP';
  const rows = [
    {
      label: billingCleanupPending ? 'Deletion access barrier committed' : 'Deletion requested',
      value: receipt.deletionRequestedAt,
    },
    { label: 'Application data purge eligible', value: receipt.applicationDataEligibleAt },
    { label: 'Database backup purge eligible', value: receipt.databaseBackupEligibleAt },
    { label: 'Security log purge eligible', value: receipt.securityLogEligibleAt },
    { label: 'Full database purge eligible', value: receipt.fullDatabasePurgeEligibleAt },
  ];

  return (
    <>
      <div className="public-doc__intro">
        <span className="public-home__eyebrow">
          {billingCleanupPending
            ? <Clock3 size={16} aria-hidden="true" />
            : <CheckCircle2 size={16} aria-hidden="true" />}
          Deletion receipt
        </span>
        <h1>{billingCleanupPending ? 'Account deletion is in progress' : 'Account deletion requested'}</h1>
        <p>
          {billingCleanupPending
            ? 'Your access is disabled and existing sessions have been revoked. Billing cleanup is still being reconciled, so LunchLineup has not finalized deletion yet. The scheduled reconciliation process will retry safely.'
            : 'Workspace access has ended. This is the finalized retention schedule returned when LunchLineup accepted the deletion request.'}
        </p>
      </div>

      {billingCleanupPending ? <button className="btn btn-secondary" onClick={() => {
        window.sessionStorage.removeItem(ACCOUNT_DELETION_RECEIPT_STORAGE_KEY);
        setRetry((value) => value + 1);
      }}>Refresh deletion status</button> : null}
      <section className="public-doc__section" aria-labelledby="retention-schedule-heading">
        <h2 id="retention-schedule-heading">Retention and purge schedule</h2>
        <dl style={{ display: 'grid', gap: '0.75rem', margin: 0 }}>
          {rows.map((row) => (
            <div
              key={row.label}
              style={{
                display: 'grid',
                gap: '0.25rem',
                paddingBottom: '0.75rem',
                borderBottom: '1px solid var(--border)',
              }}
            >
              <dt style={{ color: 'var(--text-muted)', fontSize: '0.82rem', fontWeight: 750 }}>{row.label}</dt>
              <dd style={{ color: 'var(--text-primary)', fontSize: '0.95rem', fontWeight: 750, margin: 0 }}>
                {row.value ? formatDate(row.value) : 'Not provided in the deletion receipt'}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </>
  );
}
