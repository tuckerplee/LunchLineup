import Link from 'next/link';
import type { ReactNode } from 'react';
import { LunchLineupMark } from '@/components/branding/LunchLineupMark';
import type { LegalContact } from './legal-config';
import { legalContactReadiness } from './legal-config';

type LegalSection = {
  title: string;
  body: ReactNode;
};

type LegalPageProps = {
  title: string;
  eyebrow: string;
  updated: string;
  summary: string;
  sections: LegalSection[];
};

export function LegalContactLink({ contact }: { contact: LegalContact }) {
  if (!contact.href || !contact.email) {
    return <span>{contact.text}</span>;
  }

  return <a href={contact.href}>{contact.email}</a>;
}

export function LegalContactReadinessNotice() {
  if (legalContactReadiness.ready) return null;

  return (
    <section className="public-doc__section" aria-labelledby="legal-contact-readiness-heading">
      <h2 id="legal-contact-readiness-heading">Owner Signoff Required</h2>
      <p>
        Production contact routing is pending owner signoff for {legalContactReadiness.missingNames.join(', ')}.
        Configure monitored public contact values through {legalContactReadiness.missingEnvVars.join(', ')} before
        treating this public copy as approved production legal, security, status, or DPA routing.
      </p>
    </section>
  );
}

export function LegalPage({ title, eyebrow, updated, summary, sections }: LegalPageProps) {
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
          <Link href="/terms" className="btn btn-ghost">Terms</Link>
          <Link href="/security" className="btn btn-ghost">Security</Link>
          <Link href="/subprocessors" className="btn btn-ghost">Subprocessors</Link>
          <Link href="/auth/login" className="btn btn-secondary">Sign in</Link>
        </nav>
      </header>

      <article className="public-doc__main">
        <div className="public-doc__intro">
          <span className="public-home__eyebrow">{eyebrow}</span>
          <h1>{title}</h1>
          <p>{summary}</p>
          <span className="public-doc__updated">Last updated {updated}</span>
        </div>

        <LegalContactReadinessNotice />

        <div className="public-doc__sections">
          {sections.map((section) => (
            <section key={section.title} className="public-doc__section">
              <h2>{section.title}</h2>
              {section.body}
            </section>
          ))}
        </div>
      </article>
    </main>
  );
}
