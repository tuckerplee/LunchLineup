'use client';

import { CheckCircle2, Clock3 } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
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

  useEffect(() => {
    setReceipt(readAccountDeletionReceipt(window.sessionStorage));
  }, []);

  if (receipt === undefined) {
    return (
      <div className="public-doc__intro" role="status" aria-live="polite">
        <span className="public-home__eyebrow">
          <Clock3 size={16} aria-hidden="true" />
          Deletion receipt
        </span>
        <h1>Preparing confirmation</h1>
        <p>Loading the account deletion receipt returned with your request.</p>
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
        <p>This tab does not have a recent account-deletion receipt. Contact support to confirm the request.</p>
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
            ? 'Your access is disabled and your browser session has ended. Billing cleanup is still being reconciled, so LunchLineup has not finalized deletion yet. The scheduled reconciliation process will retry safely.'
            : 'Your browser session has ended. This is the finalized retention schedule returned when LunchLineup accepted the deletion request.'}
        </p>
      </div>

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
