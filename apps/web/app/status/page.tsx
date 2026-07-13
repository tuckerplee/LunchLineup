import Link from 'next/link';
import type { Metadata } from 'next';
import { Activity, AlertTriangle, CheckCircle2, Clock3, Gauge, ShieldCheck } from 'lucide-react';
import { LunchLineupMark } from '@/components/branding/LunchLineupMark';
import { legalContacts } from '../legal-config';
import { LegalContactLink, LegalContactReadinessNotice } from '../legal-page';
import {
  INCIDENT_REVIEW_DATE,
  badgeClass,
  dependencyTone,
  formatDateTime,
  formatLatency,
  readApiHealth,
  statusComponents,
  summaryCopy,
  titleCase,
} from './health';
import type { HealthProbe } from './health';

type IncidentState = {
  activeCount: 0 | 1;
  heading: string;
  detail: string;
  detectedAt: Date | null;
};

export function deriveIncidentState(
  probe: Pick<HealthProbe, 'status' | 'label' | 'detail' | 'checkedAt'>,
): IncidentState {
  if (probe.status === 'degraded' || probe.status === 'unavailable') {
    return {
      activeCount: 1,
      heading: probe.label,
      detail: probe.detail,
      detectedAt: probe.checkedAt,
    };
  }

  return {
    activeCount: 0,
    heading: 'No active incidents',
    detail: 'Automated web/API health signals added to the public beta status page.',
    detectedAt: null,
  };
}

export const metadata: Metadata = {
  title: 'Status | LunchLineup',
  description: 'Public beta service status and incident history for LunchLineup.',
};

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function StatusPage() {
  const probe = await readApiHealth();
  const summary = summaryCopy(probe);
  const systems = statusComponents(probe);
  const automatedChecks = probe.payload?.checks ?? [];
  const incident = deriveIncidentState(probe);
  const checks = [
    {
      label: 'Active incidents',
      value: String(incident.activeCount),
      helper: incident.activeCount === 0 ? 'Manual incident log' : 'Automated health signal',
    },
    { label: 'Automated signal', value: probe.label, helper: `Latency ${formatLatency(probe.latencyMs)}` },
    { label: 'Last check', value: formatDateTime(probe.checkedAt), helper: 'No-store server probe' },
  ];

  return (
    <main className="public-doc status-page">
      <header className="public-home__nav">
        <Link href="/" className="public-home__brand" aria-label="LunchLineup home">
          <LunchLineupMark size={38} />
          <span>LunchLineup</span>
        </Link>
        <nav aria-label="Public pages" className="public-home__actions">
          <Link href="/status" className="btn btn-ghost" aria-current="page">Status</Link>
          <Link href="/privacy" className="btn btn-ghost">Privacy</Link>
          <Link href="/security" className="btn btn-ghost">Security</Link>
          <Link href="/subprocessors" className="btn btn-ghost">Subprocessors</Link>
          <Link href="/auth/login" className="btn btn-secondary">Sign in</Link>
        </nav>
      </header>

      <article className="public-doc__main">
        <div className="public-doc__intro">
          <span className="public-home__eyebrow">
            <Activity size={16} aria-hidden="true" />
            Public beta status
          </span>
          <h1>LunchLineup Status</h1>
          <p>
            Current availability for the public LunchLineup beta. This page runs a server-side health probe where
            production endpoints expose one, and keeps the incident log visible before sign-in.
          </p>
          <span className="public-doc__updated">
            Automated check {formatDateTime(probe.checkedAt)}; incident log reviewed {INCIDENT_REVIEW_DATE}
          </span>
        </div>

        <LegalContactReadinessNotice />

        <section className="public-doc__section status-summary" aria-labelledby="status-summary-heading">
          <div className="status-summary__header">
            <div>
              <h2 id="status-summary-heading">{summary.heading}</h2>
              <p>{summary.copy}</p>
            </div>
            <span className={`${badgeClass(summary.tone)} status-summary__badge`} role="status" aria-live="polite">
              {summary.tone === 'success' ? (
                <CheckCircle2 size={14} aria-hidden="true" />
              ) : (
                <AlertTriangle size={14} aria-hidden="true" />
              )}
              {summary.label}
            </span>
          </div>

          <dl className="status-summary__checks" aria-label="Status summary metrics">
            {checks.map((check) => (
              <div key={check.label}>
                <dt>{check.label}</dt>
                <dd>
                  <strong>{check.value}</strong>
                  <span>{check.helper}</span>
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="public-doc__section" aria-labelledby="automated-health-heading">
          <div className="status-section__title">
            <Gauge size={18} aria-hidden="true" />
            <h2 id="automated-health-heading">Automated Health</h2>
          </div>
          <div className="status-health-grid">
            <div className="status-health-card">
              <span className="status-health-card__label">API health probe</span>
              <strong>{probe.label}</strong>
              <p>{probe.detail}</p>
              <dl className="status-health-card__meta">
                <div>
                  <dt>HTTP status</dt>
                  <dd>{probe.httpStatus ?? 'No response'}</dd>
                </div>
                <div>
                  <dt>Response time</dt>
                  <dd>{formatLatency(probe.latencyMs)}</dd>
                </div>
              </dl>
            </div>
            <div className="status-health-card">
              <span className="status-health-card__label">Dependency checks</span>
              {automatedChecks.length > 0 ? (
                <ul className="status-health-checks" aria-label="Automated dependency checks">
                  {automatedChecks.map((check) => (
                    <li key={check.name}>
                      <div>
                        <strong>{titleCase(check.name)}</strong>
                        <span>{check.details ?? 'Health check reported by API'}</span>
                      </div>
                      <span className={badgeClass(dependencyTone(check.status))}>
                        {titleCase(check.status)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>
                  Dependency details will appear here when the API health endpoint returns database and cache checks.
                </p>
              )}
            </div>
          </div>
        </section>

        <section className="public-doc__section" aria-labelledby="components-heading">
          <div className="status-section__title">
            <ShieldCheck size={18} aria-hidden="true" />
            <h2 id="components-heading">Tracked Components</h2>
          </div>
          <ul className="status-list" aria-label="Tracked service components">
            {systems.map((system) => (
              <li key={system.name} className="status-list__item">
                <div className="status-list__copy">
                  <span className={`status-list__dot status-list__dot--${system.tone}`} aria-hidden="true" />
                  <div>
                    <h3>{system.name}</h3>
                    <p>{system.detail}</p>
                    <span className="status-list__source">{system.source}</span>
                  </div>
                </div>
                <span className={badgeClass(system.tone)}>{system.state}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="public-doc__section" aria-labelledby="incidents-heading">
          <div className="status-section__title">
            <Clock3 size={18} aria-hidden="true" />
            <h2 id="incidents-heading">Incident History</h2>
          </div>
          <ol className="status-incident-list">
            <li>
              {incident.detectedAt ? (
                <time dateTime={incident.detectedAt.toISOString()}>{formatDateTime(incident.detectedAt)}</time>
              ) : (
                <time dateTime="2026-07-09">July 9, 2026</time>
              )}
              <strong>{incident.heading}</strong>
              <span>{incident.detail}</span>
            </li>
          </ol>
        </section>

        <section className="public-doc__section" aria-labelledby="support-heading">
          <h2 id="support-heading">Need Help?</h2>
          <p>
            Workspace-specific issues should be handled from the authenticated dashboard so operators can review the
            tenant, user, and schedule context safely. Public support requests can be sent to{' '}
            <LegalContactLink contact={legalContacts.support} />.
          </p>
          <div className="status-actions">
            <Link href="/auth/login" className="btn btn-primary">Sign in</Link>
            <Link href="/security" className="btn btn-secondary">Review security</Link>
          </div>
        </section>
      </article>
    </main>
  );
}
