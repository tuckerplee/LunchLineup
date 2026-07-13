import type { Metadata } from 'next';
import { LEGAL_LAST_UPDATED, legalContacts, publicSubprocessors } from '../legal-config';
import { LegalContactLink, LegalPage } from '../legal-page';

export const metadata: Metadata = {
  title: 'Subprocessors | LunchLineup',
  description: 'LunchLineup public beta subprocessor list and DPA request contact.',
};

export default function SubprocessorsPage() {
  return (
    <LegalPage
      title="Subprocessors"
      eyebrow="Data processing"
      updated={LEGAL_LAST_UPDATED}
      summary="LunchLineup uses a small set of service providers to operate billing and transactional email for the public beta."
      sections={[
        {
          title: 'Current Subprocessors',
          body: (
            <ul>
              {publicSubprocessors.map((processor) => (
                <li key={processor.name}>
                  <strong>{processor.name}</strong>: {processor.purpose} Data handled: {processor.data} Processing
                  locations: {processor.location} {processor.notes}
                </li>
              ))}
            </ul>
          ),
        },
        {
          title: 'Infrastructure and Optional Providers',
          body: (
            <p>
              LunchLineup-operated databases, queues, observability services, and backups are treated as internal production
              infrastructure unless production is reconfigured to use a third-party managed provider. Customer-configured
              identity providers receive authentication data only when a workspace enables that provider.
            </p>
          ),
        },
        {
          title: 'DPA Requests',
          body: (
            <p>
              Customers who need a Data Processing Addendum can contact{' '}
              <LegalContactLink contact={legalContacts.dpa} />. DPA review covers processing roles,
              subprocessor notice, retention and deletion handling, incident notice, and any required transfer terms.
            </p>
          ),
        },
      ]}
    />
  );
}
