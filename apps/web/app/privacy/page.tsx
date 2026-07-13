import type { Metadata } from 'next';
import { LEGAL_LAST_UPDATED, legalContacts } from '../legal-config';
import { LegalContactLink, LegalPage } from '../legal-page';

export const metadata: Metadata = {
  title: 'Privacy | LunchLineup',
  description: 'LunchLineup privacy commitments for public beta customers.',
};

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy"
      eyebrow="Privacy commitments"
      updated={LEGAL_LAST_UPDATED}
      summary="LunchLineup uses workspace and scheduling data to run the service, protect customer accounts, support customers, and maintain reliability."
      sections={[
        {
          title: 'Data We Handle',
          body: (
            <ul>
              <li>Workspace details such as tenant name, locations, plan, status, settings, and usage credits.</li>
              <li>User details such as name, email or username, role, assigned permissions, MFA/PIN state, and session metadata.</li>
              <li>Scheduling details such as schedules, shifts, lunch breaks, break rules, and time-card records when enabled.</li>
              <li>Operational records such as billing events, notifications, webhook metadata, audit logs, and security telemetry.</li>
            </ul>
          ),
        },
        {
          title: 'How We Use Data',
          body: (
            <p>
              We use customer data to provide workforce scheduling, lunch-break planning, time cards, account security, support,
              abuse prevention, incident response, and service reliability. We do not sell customer workspace data.
            </p>
          ),
        },
        {
          title: 'Account Lifecycle',
          body: (
            <p>
              Tenant admins can deactivate users, export workspace data, cancel account access, and request workspace deletion
              from account settings when their role includes the required permissions. Deletion requests start a retained-record
              schedule so billing, audit, security log, legal hold, and backup-retention duties can be completed before physical purge.
            </p>
          ),
        },
        {
          title: 'Retention and Requests',
          body: (
            <p>
              Active workspace data is retained while the workspace is active. Archived workspaces are eligible for deletion after the
              documented retention window unless legal, billing, security, or backup requirements require longer retention.
              Contact your workspace administrator or LunchLineup support for access, export, correction, or deletion requests.
            </p>
          ),
        },
        {
          title: 'Privacy and Support Contacts',
          body: (
            <p>
              Privacy requests are routed through <LegalContactLink contact={legalContacts.privacy} />.
              Workspace support requests are routed through <LegalContactLink contact={legalContacts.support} />.
            </p>
          ),
        },
        {
          title: 'Subprocessors and DPA',
          body: (
            <p>
              The current public beta subprocessor list is published at <a href="/subprocessors">/subprocessors</a>. Customers
              who need a Data Processing Addendum can route requests through{' '}
              <LegalContactLink contact={legalContacts.dpa} /> for review.
            </p>
          ),
        },
      ]}
    />
  );
}
