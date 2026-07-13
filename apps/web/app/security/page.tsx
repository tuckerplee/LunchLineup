import type { Metadata } from 'next';
import { LEGAL_LAST_UPDATED, legalContacts } from '../legal-config';
import { LegalContactLink, LegalPage } from '../legal-page';

export const metadata: Metadata = {
  title: 'Security | LunchLineup',
  description: 'LunchLineup security commitments for public beta customers.',
};

export default function SecurityPage() {
  return (
    <LegalPage
      title="Security"
      eyebrow="Security commitments"
      updated={LEGAL_LAST_UPDATED}
      summary="LunchLineup is built around tenant isolation, role-based access, secure authentication, protected operations, and auditable account lifecycle controls."
      sections={[
        {
          title: 'Tenant Isolation',
          body: (
            <p>
              Workspace data is tenant-scoped in the application and reinforced by database row-level security. Production database roles
              are expected to avoid superuser ownership of tenant tables so row-level security cannot be bypassed by normal app traffic.
            </p>
          ),
        },
        {
          title: 'Authentication and Access',
          body: (
            <ul>
              <li>Sessions use secure cookies and server-side token validation.</li>
              <li>Role-based permissions protect tenant and platform administration routes.</li>
              <li>MFA, OTP, PIN lockout, and tenant status checks are available for account protection.</li>
            </ul>
          ),
        },
        {
          title: 'Operations',
          body: (
            <p>
              Production startup blocks unsafe CORS, host, cookie, metrics, body-limit, and email-sender settings. Public API responses
              use no-store cache behavior, protected metrics credentials, and hardened browser security headers.
            </p>
          ),
        },
        {
          title: 'Monitoring and Incidents',
          body: (
            <p>
              Sensitive actions are intended to be audit logged. Production runbooks cover security incidents, rollback, database
              failover, high error rates, high CPU, and public SaaS readiness checks. Report suspected security issues through{' '}
              <LegalContactLink contact={legalContacts.support} /> so the incident runbook can be started.
            </p>
          ),
        },
        {
          title: 'DPA and Vendor Review',
          body: (
            <p>
              DPA requests and vendor security reviews can be routed to{' '}
              <LegalContactLink contact={legalContacts.dpa} />. Current subprocessors are published at{' '}
              <a href="/subprocessors">/subprocessors</a> and should be reviewed before vendor changes.
            </p>
          ),
        },
      ]}
    />
  );
}
