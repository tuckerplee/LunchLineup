import type { Metadata } from 'next';
import { PUBLIC_LEGAL_MANIFEST } from '@lunchlineup/config';
import { LEGAL_LAST_UPDATED, legalContacts, selfServiceTermsReadiness } from '../legal-config';
import { LegalContactLink, LegalPage } from '../legal-page';

export const metadata: Metadata = {
  title: 'Terms | LunchLineup',
  description: 'LunchLineup service terms for public beta customers.',
};

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms"
      eyebrow="Service agreement"
      updated={LEGAL_LAST_UPDATED}
      version={PUBLIC_LEGAL_MANIFEST.documents.terms.version}
      summary="This checked-in beta draft is not counsel-approved and is not approved for invite-only or open self-service signup."
      sections={[
        {
          title: 'Approval Status',
          body: (
            <p>
              Status: {selfServiceTermsReadiness.status}. No approved self-service Terms version is recorded.
              Production self-service signup remains closed until counsel approves versioned Terms and a future code change updates the launch gate.
            </p>
          ),
        },
        {
          title: 'Using the Service',
          body: (
            <p>
              LunchLineup provides workforce scheduling, lunch and break planning, time cards, account administration, and related
              operational tools for customer workspaces. Workspace administrators are responsible for inviting authorized users,
              assigning appropriate roles, reviewing schedules before publication, and keeping account contact information current.
            </p>
          ),
        },
        {
          title: 'Customer Data',
          body: (
            <p>
              Customer data remains the customer&apos;s responsibility and is processed to provide, protect, support, and improve the
              service. Privacy, retention, deletion, and subprocessor details are described in the public Privacy and Subprocessors pages.
            </p>
          ),
        },
        {
          title: 'Billing and Cancellation',
          body: (
            <p>
              Paid workspaces use the configured billing provider for checkout, subscriptions, and invoices. Tenant administrators can
              request account cancellation or deletion from workspace settings when their role includes lifecycle access. Off-cycle
              refunds, credits, and account-specific billing adjustments require support review.
            </p>
          ),
        },
        {
          title: 'Acceptable Use',
          body: (
            <ul>
              <li>Do not attempt to bypass authentication, tenant isolation, billing controls, or rate limits.</li>
              <li>Do not upload illegal, harmful, credential, payment-card, or unrelated sensitive data into scheduling fields.</li>
              <li>Do not use LunchLineup to send abusive notifications, scrape other tenants, or interfere with service operations.</li>
            </ul>
          ),
        },
        {
          title: 'Availability and Beta Changes',
          body: (
            <p>
              Public beta features may change as operational controls, integrations, and pricing mature. The status page reports current
              service health. Time cards are operational records, not payroll-final records; customer payroll systems remain authoritative
              for wages, taxes, and filings. LunchLineup may suspend access when needed to protect customers, investigate abuse, comply
              with legal obligations, or prevent service harm.
            </p>
          ),
        },
        {
          title: 'Support and Updates',
          body: (
            <p>
              Support requests, billing questions, security reports, and service-term questions route through{' '}
              <LegalContactLink contact={legalContacts.support} />. Material public legal updates use the Last updated date on this page.
            </p>
          ),
        },
      ]}
    />
  );
}
