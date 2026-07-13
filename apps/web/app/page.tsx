import Link from 'next/link';
import { CalendarDays, CheckCircle2, Clock3, ShieldCheck } from 'lucide-react';
import { LunchLineupMark } from '@/components/branding/LunchLineupMark';
import { isSelfServiceSignupAvailable } from './onboarding/challenge';

const PROOF_POINTS = [
  { label: 'Break rules', value: 'Built in' },
  { label: 'Coverage', value: 'Protected' },
  { label: 'Setup', value: 'Email verified' },
];

const PREVIEW_ROWS = [
  { name: 'Alex R.', shift: '9:00-5:00', lunch: '12:10', breakTime: '2:35', status: 'Covered' },
  { name: 'Casey P.', shift: '10:00-6:00', lunch: '1:05', breakTime: '3:10', status: 'Watch' },
  { name: 'Jordan M.', shift: '11:00-7:00', lunch: '2:00', breakTime: '4:25', status: 'Covered' },
];

function isSelfServeSignupOpen(): boolean {
  return isSelfServiceSignupAvailable(
    process.env.NEXT_PUBLIC_SIGNUP_MODE ?? process.env.PUBLIC_SIGNUP_MODE,
  );
}

export default function HomePage() {
  const selfServeSignupOpen = isSelfServeSignupOpen();

  return (
    <main className="public-home">
      <header className="public-home__nav">
        <Link href="/" className="public-home__brand" aria-label="LunchLineup home">
          <LunchLineupMark size={38} />
          <span>LunchLineup</span>
        </Link>
        <nav aria-label="Account actions" className="public-home__actions">
          <Link href="/status" className="btn btn-ghost">Status</Link>
          <Link href="/privacy" className="btn btn-ghost">Privacy</Link>
          <Link href="/terms" className="btn btn-ghost">Terms</Link>
          <Link href="/security" className="btn btn-ghost">Security</Link>
          <Link href="/subprocessors" className="btn btn-ghost">Subprocessors</Link>
          <Link href="/auth/login" className="btn btn-secondary">Sign in</Link>
          {selfServeSignupOpen ? (
            <Link href="/onboarding" className="btn btn-primary">Create workspace</Link>
          ) : null}
        </nav>
      </header>

      <section className="public-home__hero">
        <div className="public-home__copy">
          <span className="public-home__eyebrow">
            <ShieldCheck size={16} aria-hidden="true" />
            Workforce scheduling SaaS
          </span>
          <h1>LunchLineup</h1>
          <p>
            Build shift schedules with lunches, breaks, and floor coverage already planned before managers make edits.
          </p>
          <div className="public-home__cta">
            {selfServeSignupOpen ? (
              <Link href="/onboarding" className="btn btn-primary btn-lg">Start with email verification</Link>
            ) : null}
            <Link href="/auth/login" className="btn btn-secondary btn-lg">Open existing workspace</Link>
          </div>
          <dl className="public-home__proof">
            {PROOF_POINTS.map((item) => (
              <div key={item.label}>
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
        </div>

        <aside className="public-home__preview" aria-label="Schedule preview">
          <div className="public-preview__toolbar">
            <div>
              <span>Today</span>
              <strong>Frontline schedule</strong>
            </div>
            <span className="badge badge-success">84% coverage</span>
          </div>

          <div className="public-preview__grid">
            {PREVIEW_ROWS.map((row) => (
              <article key={row.name} className="public-preview__row">
                <div className="public-preview__person">
                  <strong>{row.name}</strong>
                  <span>{row.shift}</span>
                </div>
                <div className="public-preview__lane" aria-hidden="true">
                  <span className="public-preview__block public-preview__block--shift">Shift</span>
                  <span className="public-preview__block public-preview__block--lunch">Lunch {row.lunch}</span>
                  <span className="public-preview__block public-preview__block--break">Break {row.breakTime}</span>
                </div>
                <span className={row.status === 'Covered' ? 'badge badge-success' : 'badge badge-warn'}>{row.status}</span>
              </article>
            ))}
          </div>
        </aside>
      </section>

      <section className="public-home__band" aria-label="Product capabilities">
        <div>
          <CalendarDays size={19} aria-hidden="true" />
          <strong>Schedule board</strong>
          <span>Drag shifts, edit coverage, and print schedules from the dashboard.</span>
        </div>
        <div>
          <Clock3 size={19} aria-hidden="true" />
          <strong>Time cards</strong>
          <span>Clock-in flows and manager review stay tenant-scoped.</span>
        </div>
        <div>
          <CheckCircle2 size={19} aria-hidden="true" />
          <strong>Launch path</strong>
          <span>New teams can verify email, create a workspace, and add the first location.</span>
        </div>
      </section>
    </main>
  );
}
