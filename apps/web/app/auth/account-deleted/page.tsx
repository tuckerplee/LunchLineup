import type { Metadata } from 'next';
import Link from 'next/link';
import { LifeBuoy } from 'lucide-react';
import { LunchLineupMark } from '@/components/branding/LunchLineupMark';
import { legalContacts } from '../../legal-config';
import { LegalContactLink } from '../../legal-page';
import { AccountDeletionConfirmation } from './AccountDeletionConfirmation';

export const metadata: Metadata = {
  title: 'Account Deletion Confirmation | LunchLineup',
  description: 'Account deletion retention and purge confirmation.',
  robots: { index: false, follow: false },
};

export default function AccountDeletedPage() {
  return (
    <main className="public-doc">
      <header className="public-home__nav">
        <Link href="/" className="public-home__brand" aria-label="LunchLineup home">
          <LunchLineupMark size={38} />
          <span>LunchLineup</span>
        </Link>
        <nav aria-label="Public pages" className="public-home__actions">
          <Link href="/status" className="btn btn-ghost">Status</Link>
          <Link href="/privacy" className="btn btn-ghost">Privacy</Link>
          <Link href="/auth/login" className="btn btn-secondary">Sign in</Link>
        </nav>
      </header>

      <article className="public-doc__main">
        <AccountDeletionConfirmation />

        <section className="public-doc__section" aria-labelledby="deletion-support-heading">
          <h2 id="deletion-support-heading" style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
            <LifeBuoy size={18} aria-hidden="true" />
            Deletion support
          </h2>
          <p>
            Questions about this receipt or the purge schedule go to our monitored support contact:{' '}
            <LegalContactLink contact={legalContacts.support} />.
          </p>
          <div className="status-actions">
            <Link href="/" className="btn btn-primary">Return to LunchLineup</Link>
          </div>
        </section>
      </article>
    </main>
  );
}
