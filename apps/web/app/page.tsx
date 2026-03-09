import Link from 'next/link';
import {
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Shield,
  Sparkles,
  WandSparkles,
} from 'lucide-react';
import { LunchLineupMark } from '@/components/branding/LunchLineupMark';

const metrics = [
  { value: '98%', label: 'Schedule accuracy before manager edits' },
  { value: '4x', label: 'Faster than spreadsheet workflows' },
  { value: '<30s', label: 'To generate a full day with breaks' },
  { value: '200+', label: 'Teams actively running LunchLineup' },
];

const features = [
  {
    icon: WandSparkles,
    title: 'Generate lunch and break coverage in one pass',
    body: 'Start with shifts, click Generate, and get policy-aware assignments instantly.',
  },
  {
    icon: Shield,
    title: 'Catch meal-window risks before publish',
    body: 'Compliance checks run while editing so managers fix issues before they go live.',
  },
  {
    icon: CalendarDays,
    title: 'Operate in a calm workspace, not a control panel',
    body: 'Inputs and outputs stay separated, making high-density schedules easy to scan.',
  },
];

const testimonials = [
  {
    quote: 'We cut weekly schedule-building from 3 hours to about 20 minutes.',
    person: 'Sarah K.',
    role: 'Ops Director, QuickBite Group',
  },
  {
    quote: 'Coverage and break timing are finally predictable across all locations.',
    person: 'Marcus T.',
    role: 'Regional Manager, FreshMart',
  },
  {
    quote: 'Managers stopped doing manual lunch math and started coaching the floor.',
    person: 'Diana L.',
    role: 'Store Manager, UrbanThreads',
  },
];

const useCases = [
  {
    title: 'Restaurants',
    body: 'Handle lunch rush coverage automatically while rotating breaks around peak service windows.',
  },
  {
    title: 'Retail',
    body: 'Maintain floor coverage during breaks so no critical zones or registers are left uncovered.',
  },
  {
    title: 'Healthcare & clinics',
    body: 'Keep mandated break windows visible and compliant across high-acuity shift patterns.',
  },
];

export default function HomePage() {
  return (
    <>
      <main className="marketing-page">
        <nav className="marketing-nav">
          <div className="marketing-nav__inner">
            <Link href="/" className="marketing-brand" aria-label="LunchLineup home">
              <span className="marketing-brand__mark">
                <LunchLineupMark size={30} />
              </span>
              <span>
                <strong>LunchLineup</strong>
                <small>Automatic lunch & break scheduling</small>
              </span>
            </Link>
            <div className="marketing-nav__actions">
              <Link href="/auth/login" className="btn btn-secondary">Sign in</Link>
              <Link href="/onboarding" className="btn btn-primary">Start free trial</Link>
            </div>
          </div>
        </nav>

        <section className="hero container">
          <div className="hero__copy">
            <span className="hero__badge"><Sparkles size={14} /> Built for multi-location teams</span>
            <h1>
              Build labor-compliant lunch schedules
              <span>without spreadsheet cleanup.</span>
            </h1>
            <p>
              LunchLineup generates shifts, lunches, and breaks in one workflow so managers can review, adjust, and publish with confidence.
            </p>
            <div className="hero__actions">
              <Link href="/onboarding" className="btn btn-primary btn-lg">
                Generate breaks
                <ArrowRight size={16} />
              </Link>
              <Link href="/dashboard/scheduling" className="btn btn-secondary btn-lg">View scheduler</Link>
            </div>
          </div>

          <div className="hero__preview surface-card" role="img" aria-label="LunchLineup scheduler preview">
            <div className="hero__halo" aria-hidden="true" />
            <header>
              <div>
                <strong>Friday Lunch Coverage</strong>
                <small>Downtown Bistro</small>
              </div>
              <span className="badge badge-success"><CheckCircle2 size={12} /> 0 meal risks</span>
            </header>
            <div className="preview-row">
              <span>Alex R.</span>
              <div className="preview-track">
                <i className="shift" style={{ left: '2%', width: '74%' }} />
                <i className="lunch" style={{ left: '38%', width: '14%' }} />
                <i className="break" style={{ left: '60%', width: '9%' }} />
              </div>
            </div>
            <div className="preview-row">
              <span>Jordan M.</span>
              <div className="preview-track">
                <i className="shift" style={{ left: '10%', width: '72%' }} />
                <i className="lunch" style={{ left: '44%', width: '15%' }} />
                <i className="break" style={{ left: '68%', width: '8%' }} />
              </div>
            </div>
            <div className="preview-row">
              <span>Casey P.</span>
              <div className="preview-track">
                <i className="shift" style={{ left: '18%', width: '70%' }} />
                <i className="lunch warn" style={{ left: '58%', width: '15%' }} />
                <i className="break" style={{ left: '78%', width: '8%' }} />
              </div>
            </div>
            <footer>
              <Clock3 size={14} />
              <span>Coverage remains above floor minimum all day</span>
            </footer>
          </div>
        </section>

        <section className="container metrics">
          {metrics.map((item) => (
            <article key={item.label} className="surface-card metric-card">
              <h2>{item.value}</h2>
              <p>{item.label}</p>
            </article>
          ))}
        </section>

        <section className="container section">
          <header>
            <span className="section-kicker">How teams use it</span>
            <h2>One workflow from shift inputs to publish-ready break plans.</h2>
          </header>
          <div className="features-grid">
            {features.map((feature) => (
              <article key={feature.title} className="surface-card feature-card">
                <div className="feature-icon"><feature.icon size={18} /></div>
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="container section testimonials">
          <header>
            <span className="section-kicker">Trusted outcomes</span>
            <h2>Operations leaders switch for consistency, then stay for speed.</h2>
          </header>
          <div className="testimonial-grid">
            {testimonials.map((item) => (
              <article key={item.person} className="surface-card testimonial-card">
                <p>“{item.quote}”</p>
                <strong>{item.person}</strong>
                <small>{item.role}</small>
              </article>
            ))}
          </div>
        </section>

        <section className="container section">
          <header>
            <span className="section-kicker">Use cases</span>
            <h2>Built for teams that run on shifts.</h2>
          </header>
          <div className="use-cases-grid">
            <article className="surface-card use-cases-lead">
              <h3>One planner for service-heavy teams.</h3>
              <p>
                LunchLineup adapts to each operating model while keeping meal compliance and floor coverage visible in real time.
              </p>
            </article>
            {useCases.map((item) => (
              <article key={item.title} className="surface-card use-case-card">
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="container final-cta">
          <div className="final-cta__panel surface-card">
            <h2>Ready to replace manual break planning?</h2>
            <p>Set shifts, click generate, and publish a schedule your team can trust.</p>
            <div className="hero__actions">
              <Link href="/onboarding" className="btn btn-primary btn-lg">
                Start free trial
                <ArrowRight size={16} />
              </Link>
              <Link href="/auth/login" className="btn btn-secondary btn-lg">Sign in</Link>
            </div>
          </div>
        </section>

        <footer className="marketing-footer">
          <div className="container">
            <p>Copyright {new Date().getFullYear()} LunchLineup. Workforce scheduling for modern teams.</p>
          </div>
        </footer>
      </main>

      <style jsx>{`
        .container {
          width: min(1120px, calc(100% - 48px));
          margin: 0 auto;
        }

        .marketing-page {
          position: relative;
          overflow: hidden;
          padding-bottom: 56px;
        }

        .marketing-nav {
          position: sticky;
          top: 0;
          z-index: 20;
          backdrop-filter: blur(10px);
          background: rgba(246, 247, 251, 0.84);
          border-bottom: 1px solid var(--border);
        }

        .marketing-nav__inner {
          width: min(1120px, calc(100% - 48px));
          margin: 0 auto;
          min-height: 72px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }

        .marketing-brand {
          display: inline-flex;
          align-items: center;
          gap: 10px;
        }

        .marketing-brand__mark {
          width: 34px;
          height: 34px;
          display: grid;
          place-items: center;
        }

        .marketing-brand strong {
          display: block;
          line-height: 1.1;
        }

        .marketing-brand small {
          display: block;
          font-size: 12px;
          color: var(--text-muted);
        }

        .marketing-nav__actions {
          display: inline-flex;
          align-items: center;
          gap: 10px;
        }

        .hero {
          padding: 96px 0 72px;
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 32px;
          align-items: center;
        }

        .hero__copy h1 {
          margin: 16px 0;
          font-size: clamp(34px, 5vw, 56px);
          line-height: 1.1;
          letter-spacing: -0.03em;
        }

        .hero__copy h1 span {
          display: block;
          color: var(--brand-700);
        }

        .hero__copy p {
          max-width: 52ch;
          margin: 0;
          color: var(--text-muted);
          font-size: 16px;
        }

        .hero__badge {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          height: 30px;
          padding: 0 12px;
          border-radius: var(--r-pill);
          background: var(--brand-050);
          color: var(--brand-800);
          font-size: 13px;
          font-weight: 600;
        }

        .hero__actions {
          margin-top: 24px;
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
        }

        .hero__preview {
          position: relative;
          overflow: hidden;
          min-height: 420px;
          padding: 20px;
          display: flex;
          flex-direction: column;
          gap: 16px;
          box-shadow: var(--e-3);
        }

        .hero__halo {
          position: absolute;
          inset: -20% -15% auto auto;
          width: 420px;
          height: 320px;
          background: var(--hero-ambient);
          pointer-events: none;
        }

        .hero__preview header,
        .hero__preview footer {
          position: relative;
          z-index: 1;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
        }

        .hero__preview header strong {
          display: block;
          font-size: 18px;
        }

        .hero__preview header small,
        .hero__preview footer {
          font-size: 13px;
          color: var(--text-muted);
        }

        .preview-row {
          position: relative;
          z-index: 1;
          display: grid;
          grid-template-columns: 88px 1fr;
          gap: 12px;
          align-items: center;
          font-size: 13px;
          font-weight: 650;
          color: var(--text-muted);
        }

        .preview-track {
          position: relative;
          height: 44px;
          border: 1px solid var(--border);
          border-radius: 12px;
          background: var(--surface-soft);
        }

        .preview-track i {
          position: absolute;
          top: 7px;
          height: 28px;
          border-radius: 10px;
        }

        .preview-track .shift {
          background: rgba(79, 70, 229, 0.22);
          border: 1px solid rgba(79, 70, 229, 0.28);
        }

        .preview-track .lunch {
          background: rgba(21, 128, 61, 0.22);
          border: 1px solid rgba(21, 128, 61, 0.32);
        }

        .preview-track .lunch.warn {
          background: rgba(220, 38, 38, 0.18);
          border: 1px solid rgba(220, 38, 38, 0.32);
        }

        .preview-track .break {
          background: rgba(15, 118, 110, 0.2);
          border: 1px solid rgba(15, 118, 110, 0.3);
        }

        .metrics {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 16px;
        }

        .metric-card {
          padding: 24px;
        }

        .metric-card h2 {
          margin: 0;
          font-size: 40px;
          line-height: 1.1;
        }

        .metric-card p {
          margin: 10px 0 0;
          color: var(--text-muted);
          font-size: 14px;
        }

        .section {
          padding-top: 64px;
        }

        .section header {
          max-width: 760px;
          margin-bottom: 24px;
        }

        .section-kicker {
          display: inline-block;
          margin-bottom: 8px;
          font-size: 12px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--text-soft);
        }

        .section h2 {
          margin: 0;
          font-size: clamp(28px, 3.5vw, 40px);
          line-height: 1.2;
          letter-spacing: -0.02em;
        }

        .features-grid,
        .testimonial-grid,
        .use-cases-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 16px;
          align-items: stretch;
        }

        .feature-card,
        .testimonial-card,
        .use-case-card,
        .use-cases-lead {
          padding: 24px;
          border-radius: var(--r-lg);
          height: 100%;
        }

        .use-cases-grid {
          grid-template-columns: repeat(4, minmax(0, 1fr));
          grid-auto-rows: 1fr;
        }

        .use-cases-lead {
          grid-column: span 1;
          background: linear-gradient(180deg, #fff, #f8faff);
        }

        .use-case-card {
          display: flex;
          flex-direction: column;
          justify-content: flex-start;
        }

        .use-cases-lead h3,
        .use-case-card h3 {
          margin: 0;
          font-size: 28px;
          line-height: 1.2;
          letter-spacing: -0.02em;
        }

        .use-case-card h3 {
          font-size: 26px;
        }

        .use-cases-lead p,
        .use-case-card p {
          margin: 12px 0 0;
          color: var(--text-muted);
          font-size: 15px;
        }

        .feature-icon {
          width: 36px;
          height: 36px;
          border-radius: 12px;
          display: grid;
          place-items: center;
          color: var(--brand-700);
          background: var(--brand-050);
          margin-bottom: 14px;
        }

        .feature-card h3 {
          margin: 0;
          font-size: 20px;
          line-height: 1.3;
          letter-spacing: -0.01em;
        }

        .feature-card p,
        .testimonial-card p {
          margin: 10px 0 0;
          color: var(--text-muted);
          font-size: 14px;
        }

        .testimonial-card strong {
          display: block;
          margin-top: 18px;
        }

        .testimonial-card small {
          display: block;
          margin-top: 4px;
          color: var(--text-soft);
        }

        .final-cta {
          padding-top: 64px;
        }

        .final-cta__panel {
          position: relative;
          overflow: hidden;
          padding: 48px;
          background:
            linear-gradient(180deg, #ffffff, #fbfcff),
            var(--hero-ambient);
          text-align: center;
        }

        .final-cta__panel h2 {
          margin: 0;
          font-size: clamp(28px, 4vw, 40px);
          line-height: 1.15;
        }

        .final-cta__panel p {
          margin: 12px auto 0;
          max-width: 58ch;
          color: var(--text-muted);
        }

        .final-cta__panel .hero__actions {
          justify-content: center;
        }

        .marketing-footer {
          padding: 48px 0 20px;
          color: var(--text-soft);
          font-size: 13px;
          text-align: center;
        }

        @media (max-width: 1024px) {
          .hero {
            grid-template-columns: 1fr;
            padding-top: 72px;
          }

          .metrics,
          .features-grid,
          .testimonial-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }

          .use-cases-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
        }

        @media (max-width: 720px) {
          .container,
          .marketing-nav__inner {
            width: min(1120px, calc(100% - 32px));
          }

          .marketing-nav__actions {
            display: none;
          }

          .metrics,
          .features-grid,
          .testimonial-grid,
          .use-cases-grid {
            grid-template-columns: 1fr;
          }

          .final-cta__panel {
            padding: 32px 20px;
          }

          .hero {
            padding-top: 56px;
            padding-bottom: 40px;
          }
        }
      `}</style>
    </>
  );
}
