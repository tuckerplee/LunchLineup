'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Clock3,
  HeartPulse,
  Shield,
  ShoppingBag,
  Sparkles,
  UtensilsCrossed,
  WandSparkles,
} from 'lucide-react';
import { LunchLineupMark } from '@/components/branding/LunchLineupMark';

const metrics = [
  { value: '98%', label: 'Schedule accuracy before manager edits' },
  { value: '4x', label: 'Faster than spreadsheet workflows' },
  { value: '<30s', label: 'To generate a full day with breaks' },
  { value: '200+', label: 'Teams actively running LunchLineup' },
];

const workflow = [
  {
    icon: CalendarDays,
    title: 'Add shifts',
    body: 'Bring in staffing data from your schedule source or add shifts directly in-app.',
  },
  {
    icon: WandSparkles,
    title: 'Generate breaks',
    body: 'LunchLineup places lunches and breaks automatically while maintaining coverage rules.',
  },
  {
    icon: Shield,
    title: 'Review and publish',
    body: 'Resolve flagged windows, save, and publish a plan your team can execute confidently.',
  },
];

const testimonials = [
  {
    highlight: '3 hours -> 20 minutes',
    quote: 'We cut weekly schedule-building from 3 hours to about 20 minutes.',
    person: 'Sarah K.',
    role: 'Ops Director, QuickBite Group',
  },
  {
    highlight: 'Meal-risk incidents down 80%',
    quote: 'Coverage and break timing are finally predictable across all locations.',
    person: 'Marcus T.',
    role: 'Regional Manager, FreshMart',
  },
  {
    highlight: 'Managers stopped patching breaks',
    quote: 'My team now starts with a viable plan instead of fixing lunch compliance by hand.',
    person: 'Diana L.',
    role: 'Store Manager, UrbanThreads',
  },
];

const useCases: Array<{ title: string; body: string; tone: string; icon: LucideIcon }> = [
  {
    title: 'Restaurants',
    body: 'Handle lunch rush coverage automatically while rotating breaks around peak service windows.',
    tone: 'restaurants',
    icon: UtensilsCrossed,
  },
  {
    title: 'Retail',
    body: 'Maintain floor coverage during breaks so no critical zones or registers are left uncovered.',
    tone: 'retail',
    icon: ShoppingBag,
  },
  {
    title: 'Healthcare & clinics',
    body: 'Keep mandated break windows visible and compliant across high-acuity shift patterns.',
    tone: 'healthcare',
    icon: HeartPulse,
  },
];

const previewLanes = [
  {
    name: 'Alex R.',
    shiftLeft: '2%',
    shiftWidth: '74%',
    lunchLeft: '38%',
    lunchWidth: '18%',
    breakLeft: '60%',
    breakWidth: '14%',
    lunchTime: '14:10',
    breakTime: '16:35',
    note: 'Alex lunch moved 10m later to maintain cashier coverage.',
    warn: false,
  },
  {
    name: 'Jordan M.',
    shiftLeft: '10%',
    shiftWidth: '72%',
    lunchLeft: '44%',
    lunchWidth: '18%',
    breakLeft: '68%',
    breakWidth: '14%',
    lunchTime: '14:30',
    breakTime: '16:55',
    note: 'Jordan break shifted earlier to smooth dinner handoff.',
    warn: false,
  },
  {
    name: 'Casey P.',
    shiftLeft: '18%',
    shiftWidth: '70%',
    lunchLeft: '58%',
    lunchWidth: '18%',
    breakLeft: '78%',
    breakWidth: '14%',
    lunchTime: '17:05',
    breakTime: '19:10',
    note: 'Casey flagged as watch window, still inside legal threshold.',
    warn: true,
  },
];

export default function HomePage() {
  const [activeLane, setActiveLane] = useState(0);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setActiveLane((prev) => (prev + 1) % previewLanes.length);
    }, 2800);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'));
    if (!nodes.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      },
      { threshold: 0.14, rootMargin: '0px 0px -6% 0px' },
    );

    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <main className="marketing-page">
        <header className="site-header">
          <div className="site-header-inner">
            <Link href="/" className="nav-brand" aria-label="LunchLineup home">
              <div className="brand-mark" aria-hidden="true">
                <LunchLineupMark size={32} />
              </div>
              <div className="brand-copy">
                <span className="brand-name">LunchLineup</span>
                <span className="brand-tag">Automatic lunch & break scheduling</span>
              </div>
            </Link>
            <div className="site-actions">
              <Link href="/auth/login" className="btn btn-secondary">Sign in</Link>
              <Link href="/onboarding" className="btn btn-primary nav-trial">Start free trial</Link>
            </div>
          </div>
        </header>

        <section className="hero" data-reveal>
          <div className="container hero-inner">
            <div className="hero-copy" data-reveal style={{ ['--reveal-delay' as string]: '60ms' }}>
              <span className="hero-eyebrow"><Sparkles size={14} /> Built for multi-location teams</span>
              <h1>Lunch schedules with breaks built in — not patched in later.</h1>
              <p>
                LunchLineup generates shifts, lunches, and breaks in one workflow so managers can review, adjust, and publish with confidence.
              </p>
              <div className="hero-actions">
                <Link href="/onboarding" className="btn btn-primary btn-lg">
                  Generate breaks
                  <ArrowRight size={16} />
                </Link>
                <Link href="/dashboard/scheduling" className="btn btn-secondary btn-lg">View scheduler</Link>
              </div>
            </div>

            <div className="hero-preview-wrap" data-reveal style={{ ['--reveal-delay' as string]: '130ms' }}>
              <div className="hero-halo" aria-hidden="true" />
              <div className="hero-preview-card" role="img" aria-label="LunchLineup scheduler preview">
                <div className="preview-chrome" aria-hidden="true">
                  <div className="chrome-dots">
                    <span />
                    <span />
                    <span />
                  </div>
                  <span className="chrome-tab">Coverage Planner</span>
                  <span className="chrome-date">Fri 11:00-22:00</span>
                </div>

                <div className="preview-toolbar">
                  <div>
                    <strong>Friday Lunch Coverage</strong>
                    <small>Downtown Bistro</small>
                  </div>
                  <span className="risk-badge"><CheckCircle2 size={12} /> 0 meal risks</span>
                </div>

                <div className="preview-metrics">
                  <span className="metric-chip">Coverage 97%</span>
                  <span className="metric-chip">15 breaks generated</span>
                  <span className="metric-chip">1 watch window resolved</span>
                </div>

                <div className="preview-timeline-body">
                  <div className="timeline-scale" aria-hidden="true">
                    <span>11:00</span>
                    <span>14:00</span>
                    <span>17:00</span>
                    <span>20:00</span>
                  </div>
                  {previewLanes.map((lane, index) => (
                    <button
                      type="button"
                      key={lane.name}
                      className={`preview-row ${activeLane === index ? 'is-active' : ''}`}
                      onMouseEnter={() => setActiveLane(index)}
                      onFocus={() => setActiveLane(index)}
                      onClick={() => setActiveLane(index)}
                    >
                      <span>{lane.name}</span>
                      <div className="preview-track">
                        <span className="track-block shift" style={{ left: lane.shiftLeft, width: lane.shiftWidth }} />
                        <span className={`track-block lunch ${lane.warn ? 'warn' : ''}`} style={{ left: lane.lunchLeft, width: lane.lunchWidth }}>
                          {lane.lunchTime}
                        </span>
                        <span className="track-block break" style={{ left: lane.breakLeft, width: lane.breakWidth }}>
                          {lane.breakTime}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>

                <div className="preview-footer">
                  <Clock3 size={14} />
                  <span>{previewLanes[activeLane].note}</span>
                </div>

                <div className="preview-controls" aria-label="Demo steps">
                  {previewLanes.map((lane, index) => (
                    <button
                      type="button"
                      key={`${lane.name}-control`}
                      className={activeLane === index ? 'active' : ''}
                      onClick={() => setActiveLane(index)}
                      aria-label={`Show ${lane.name} adjustment`}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="container metrics" data-reveal>
          {metrics.map((item) => (
            <article
              key={item.label}
              className="metric-card"
              data-reveal
              style={{ ['--reveal-delay' as string]: `${120 + metrics.indexOf(item) * 35}ms` }}
            >
              <h2 className="metric-value">{item.value}</h2>
              <p className="metric-label">{item.label}</p>
            </article>
          ))}
        </section>

        <section className="container workflow-section" data-reveal>
          <header className="section-heading" data-reveal style={{ ['--reveal-delay' as string]: '40ms' }}>
            <span className="section-kicker">Workflow</span>
            <h2>From shifts to publish-ready break plans</h2>
          </header>
          <div className="workflow-grid">
            {workflow.map((step, index) => (
              <article
                key={step.title}
                className="workflow-card surface-card"
                data-reveal
                style={{ ['--reveal-delay' as string]: `${90 + index * 40}ms` }}
              >
                <div className="workflow-top">
                  <span className="workflow-number">{index + 1}</span>
                  <div className="workflow-icon"><step.icon size={18} /></div>
                </div>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="container testimonials-section" data-reveal>
          <header className="section-heading" data-reveal style={{ ['--reveal-delay' as string]: '40ms' }}>
            <span className="section-kicker">What changes after rollout</span>
            <h2>Outcomes teams feel in week one, not quarter four.</h2>
          </header>
          <div className="testimonial-grid">
            {testimonials.map((item, index) => (
              <article
                key={item.person}
                className="testimonial-card"
                data-reveal
                style={{ ['--reveal-delay' as string]: `${90 + index * 40}ms` }}
              >
                <div className="testimonial-highlight">{item.highlight}</div>
                <p>“{item.quote}”</p>
                <strong>{item.person}</strong>
                <small>{item.role}</small>
              </article>
            ))}
          </div>
        </section>

        <section className="container use-cases-section" data-reveal>
          <header className="section-heading" data-reveal style={{ ['--reveal-delay' as string]: '40ms' }}>
            <span className="section-kicker">Built for shift-heavy teams</span>
            <h2>One planner for service-heavy operations.</h2>
          </header>
          <div className="use-cases-grid">
            {useCases.map((item, index) => (
              <article
                key={item.title}
                className={`use-case-card ${item.tone}`}
                data-reveal
                style={{ ['--reveal-delay' as string]: `${90 + index * 40}ms` }}
              >
                <div className="use-case-icon"><item.icon size={18} /></div>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="container cta-section" data-reveal>
          <div className="final-cta" data-reveal style={{ ['--reveal-delay' as string]: '60ms' }}>
            <h2>Ready to replace manual break planning?</h2>
            <p>Set shifts, click generate, and publish a schedule your team can trust.</p>
            <div className="hero-actions final-cta-actions">
              <Link href="/onboarding" className="btn btn-primary btn-lg cta-primary">
                Start free trial
                <ArrowRight size={16} />
              </Link>
              <Link href="/auth/login" className="btn btn-secondary btn-lg">Sign in</Link>
            </div>
          </div>
        </section>

        <footer className="site-footer" data-reveal>
          <div className="container site-footer-top" data-reveal style={{ ['--reveal-delay' as string]: '50ms' }}>
            <div className="footer-brand">
              <div className="brand-mark" aria-hidden="true">
                <LunchLineupMark size={30} />
              </div>
              <div>
                <strong>LunchLineup</strong>
                <p>Schedules with breaks built in for compliant shift teams.</p>
              </div>
            </div>
            <div className="footer-links">
              <div>
                <span>Product</span>
                <Link href="/dashboard/scheduling">Scheduler</Link>
                <Link href="/onboarding">Get started</Link>
              </div>
              <div>
                <span>Company</span>
                <Link href="/auth/login">Sign in</Link>
                <Link href="/">Homepage</Link>
              </div>
            </div>
          </div>
          <div className="container site-footer-bottom" data-reveal style={{ ['--reveal-delay' as string]: '90ms' }}>
            Copyright {new Date().getFullYear()} LunchLineup. All rights reserved.
          </div>
        </footer>
      </main>

      <style jsx>{`
        .container {
          width: min(1120px, calc(100% - 48px));
          margin: 0 auto;
        }

        .marketing-page {
          min-height: 100vh;
          color: #0f172a;
        }

        [data-reveal] {
          opacity: 0;
          transform: translateY(12px);
          transition:
            opacity 320ms var(--ease-decelerate),
            transform 320ms var(--ease-decelerate);
          transition-delay: var(--reveal-delay, 0ms);
        }

        [data-reveal].is-visible {
          opacity: 1;
          transform: translateY(0);
        }

        .site-header {
          position: sticky;
          top: 0;
          z-index: 100;
          height: 72px;
          backdrop-filter: blur(14px);
          background: rgba(246, 247, 251, 0.72);
          border-bottom: 1px solid rgba(226, 232, 240, 0.8);
        }

        .site-header-inner {
          max-width: 1120px;
          margin: 0 auto;
          padding: 0 24px;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }

        .nav-brand {
          display: inline-flex;
          align-items: center;
          gap: 10px;
        }

        .brand-mark {
          width: 34px;
          height: 34px;
          display: grid;
          place-items: center;
        }

        .brand-copy {
          display: grid;
          gap: 2px;
        }

        .brand-name {
          font-size: 16px;
          font-weight: 700;
          line-height: 1.1;
          color: #0f172a;
        }

        .brand-tag {
          font-size: 12px;
          font-weight: 500;
          line-height: 1.2;
          color: #64748b;
        }

        .site-actions {
          display: inline-flex;
          align-items: center;
          gap: 10px;
        }

        .nav-trial {
          transition: transform 120ms var(--ease-saas), box-shadow 120ms var(--ease-saas), background-color 120ms var(--ease-saas);
        }

        .nav-trial:hover {
          transform: translateY(-1px);
          box-shadow: var(--e-2);
        }

        .hero {
          position: relative;
          overflow: hidden;
          background:
            radial-gradient(1200px 560px at 2% -2%, rgba(79, 70, 229, 0.12), transparent 72%),
            radial-gradient(1080px 560px at 98% -4%, rgba(15, 118, 110, 0.1), transparent 74%),
            radial-gradient(1300px 440px at 50% 100%, rgba(148, 163, 184, 0.16), transparent 68%),
            linear-gradient(180deg, #f9fbff 0%, #f4f7ff 58%, #eff3fb 100%);
          padding: 96px 0 72px;
        }

        .hero::before {
          content: '';
          position: absolute;
          inset: 0;
          background: linear-gradient(180deg, rgba(255, 255, 255, 0.24), rgba(255, 255, 255, 0.08) 42%, rgba(255, 255, 255, 0));
          pointer-events: none;
        }

        .hero-inner {
          position: relative;
          z-index: 1;
          display: grid;
          grid-template-columns: minmax(0, 540px) minmax(420px, 520px);
          gap: 48px;
          align-items: center;
          justify-content: space-between;
        }

        .hero-eyebrow {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          font-size: 14px;
          font-weight: 650;
          letter-spacing: 0.02em;
          color: #3730a3;
        }

        .hero-copy h1 {
          margin: 16px 0;
          font-size: clamp(40px, 5.2vw, 56px);
          font-weight: 700;
          line-height: 1.05;
          letter-spacing: -0.03em;
          text-wrap: balance;
        }

        .hero-copy p {
          margin: 0;
          font-size: 18px;
          font-weight: 450;
          line-height: 1.6;
          color: #475569;
          max-width: 56ch;
        }

        .hero-actions {
          margin-top: 24px;
          display: flex;
          gap: 12px;
          flex-wrap: wrap;
        }

        .hero-preview-wrap {
          position: relative;
        }

        .hero-halo {
          position: absolute;
          inset: -90px -70px auto auto;
          width: 580px;
          height: 520px;
          background: radial-gradient(circle at 30% 20%, rgba(79, 70, 229, 0.18), rgba(15, 118, 110, 0.1) 55%, rgba(255, 255, 255, 0) 75%);
          filter: blur(10px);
          pointer-events: none;
        }

        .hero-preview-card {
          position: relative;
          background: rgba(255, 255, 255, 0.92);
          border: 1px solid rgba(226, 232, 240, 0.9);
          border-radius: 24px;
          box-shadow: 0 24px 60px rgba(15, 23, 42, 0.12), 0 8px 20px rgba(15, 23, 42, 0.08);
          padding: 24px;
          overflow: hidden;
          display: grid;
          gap: 16px;
          opacity: 0;
          transform: translateY(10px);
          animation: preview-in 260ms var(--ease-decelerate) forwards;
        }

        .hero-preview-card::before {
          content: '';
          position: absolute;
          inset: 0;
          background: linear-gradient(180deg, rgba(255, 255, 255, 0.55), rgba(255, 255, 255, 0));
          pointer-events: none;
        }

        .preview-toolbar,
        .preview-footer,
        .preview-metrics,
        .preview-timeline-body,
        .preview-chrome {
          position: relative;
          z-index: 1;
        }

        .preview-chrome {
          min-height: 28px;
          display: grid;
          grid-template-columns: auto 1fr auto;
          align-items: center;
          gap: 8px;
          padding-bottom: 8px;
          border-bottom: 1px solid #e2e8f0;
        }

        .chrome-dots {
          display: inline-flex;
          gap: 5px;
        }

        .chrome-dots span {
          width: 7px;
          height: 7px;
          border-radius: 999px;
          background: #cbd5e1;
        }

        .chrome-tab {
          justify-self: center;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: #64748b;
        }

        .chrome-date {
          justify-self: end;
          font-size: 11px;
          font-weight: 650;
          color: #475569;
          background: #eef2ff;
          border-radius: 999px;
          padding: 2px 8px;
        }

        .preview-toolbar {
          display: flex;
          justify-content: space-between;
          gap: 10px;
          align-items: center;
        }

        .preview-toolbar strong {
          display: block;
          font-size: 18px;
          line-height: 1.2;
        }

        .preview-toolbar small {
          font-size: 13px;
          color: #64748b;
        }

        .risk-badge {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          height: 24px;
          border-radius: 999px;
          padding: 0 10px;
          background: #dcfce7;
          color: #15803d;
          font-size: 12px;
          font-weight: 650;
        }

        .preview-metrics {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }

        .metric-chip {
          display: inline-flex;
          align-items: center;
          height: 24px;
          padding: 0 10px;
          border-radius: 999px;
          background: #eef2ff;
          color: #3730a3;
          font-size: 12px;
          font-weight: 650;
          opacity: 0;
          transform: translateY(4px);
          animation: chip-in 180ms var(--ease-decelerate) forwards;
        }

        .metric-chip:nth-child(2) { animation-delay: 20ms; }
        .metric-chip:nth-child(3) { animation-delay: 40ms; }

        .preview-timeline-body {
          display: grid;
          gap: 10px;
          border-top: 1px solid #e2e8f0;
          border-bottom: 1px solid #e2e8f0;
          padding: 14px 0;
        }

        .timeline-scale {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          padding-left: 100px;
          margin-bottom: 4px;
          font-size: 11px;
          font-weight: 650;
          color: #94a3b8;
        }

        .preview-row {
          display: grid;
          grid-template-columns: 88px 1fr;
          align-items: center;
          gap: 12px;
          width: 100%;
          border: 0;
          background: transparent;
          padding: 0;
          text-align: left;
          cursor: pointer;
          font-size: 13px;
          font-weight: 650;
          color: #475569;
        }

        .preview-row > span:first-child {
          transition: color 140ms var(--ease-saas);
        }

        .preview-row.is-active > span:first-child {
          color: #1e293b;
        }

        .preview-track {
          position: relative;
          height: 50px;
          border: 1px solid #e2e8f0;
          border-radius: 12px;
          background:
            repeating-linear-gradient(
              to right,
              rgba(148, 163, 184, 0.14) 0,
              rgba(148, 163, 184, 0.14) 1px,
              transparent 1px,
              transparent 25%
            ),
            #f8faff;
          transition: border-color 140ms var(--ease-saas), box-shadow 140ms var(--ease-saas), transform 140ms var(--ease-saas);
        }

        .preview-row.is-active .preview-track {
          border-color: #a5b4fc;
          box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.12);
          transform: translateY(-1px);
        }

        .track-block {
          position: absolute;
          top: 7px;
          height: 34px;
          border-radius: 10px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          overflow: visible;
          min-width: 74px;
          font-size: 12px;
          font-weight: 800;
          line-height: 1;
          letter-spacing: 0.01em;
          white-space: nowrap;
          padding: 0 10px;
          z-index: 3;
          box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.92), 0 2px 6px rgba(15, 23, 42, 0.18);
        }

        .preview-track .shift {
          font-size: 0;
          padding: 0;
        }

        .preview-track .shift {
          background: rgba(79, 70, 229, 0.22);
          border: 1px solid rgba(79, 70, 229, 0.28);
        }

        .preview-track .lunch {
          background: #059669;
          border: 1px solid #047857;
          color: #ffffff;
        }

        .preview-track .lunch.warn {
          background: #dc2626;
          border: 1px solid #b91c1c;
          color: #ffffff;
        }

        .preview-track .break {
          background: #0e7490;
          border: 1px solid #155e75;
          color: #ffffff;
        }

        .preview-footer {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          color: #64748b;
          font-size: 13px;
          font-weight: 600;
        }

        .preview-controls {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          justify-content: center;
        }

        .preview-controls button {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          border: 0;
          background: #cbd5e1;
          cursor: pointer;
          transition: transform 140ms var(--ease-saas), background-color 140ms var(--ease-saas), width 140ms var(--ease-saas);
        }

        .preview-controls button.active {
          width: 22px;
          background: #4f46e5;
        }

        .metrics {
          margin-top: -20px;
          position: relative;
          z-index: 2;
          padding-top: 0;
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 16px;
        }

        .metric-card {
          background: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 18px;
          padding: 20px;
          box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
          transition:
            transform 160ms var(--ease-standard),
            box-shadow 160ms var(--ease-standard),
            border-color 160ms var(--ease-standard);
        }

        .metric-card:hover {
          transform: translateY(-2px);
          border-color: #c7d2fe;
          box-shadow: var(--e-2);
        }

        .metric-card:hover .metric-value {
          transform: translateY(-1px);
        }

        .metric-value {
          margin: 0;
          font-size: 40px;
          font-weight: 700;
          line-height: 1;
          color: #0f172a;
          transition: transform 160ms var(--ease-standard);
        }

        .metric-label {
          margin-top: 8px;
          font-size: 14px;
          line-height: 1.4;
          color: #64748b;
        }

        .workflow-section,
        .testimonials-section,
        .use-cases-section {
          padding: 88px 0 0;
        }

        .section-heading {
          max-width: 720px;
          margin-bottom: 24px;
        }

        .section-kicker {
          display: inline-block;
          margin-bottom: 8px;
          font-size: 12px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: #64748b;
        }

        .section-heading h2 {
          margin: 0;
          font-size: clamp(30px, 4vw, 42px);
          line-height: 1.15;
          letter-spacing: -0.02em;
        }

        .workflow-grid,
        .testimonial-grid,
        .use-cases-grid {
          display: grid;
          gap: 16px;
          align-items: stretch;
        }

        .workflow-grid,
        .testimonial-grid,
        .use-cases-grid {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }

        .workflow-card {
          padding: 24px;
          transition: transform 160ms var(--ease-standard), border-color 160ms var(--ease-standard), box-shadow 160ms var(--ease-standard);
        }

        .workflow-card:hover {
          transform: translateY(-2px);
          border-color: #c7d2fe;
          box-shadow: var(--e-2);
        }

        .workflow-top {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 14px;
        }

        .workflow-number {
          width: 32px;
          height: 32px;
          border-radius: 999px;
          display: grid;
          place-items: center;
          background: #eef2ff;
          color: #3730a3;
          font-size: 14px;
          font-weight: 700;
        }

        .workflow-icon {
          width: 32px;
          height: 32px;
          border-radius: 999px;
          display: grid;
          place-items: center;
          color: #4338ca;
          background: rgba(79, 70, 229, 0.12);
          transition: transform 160ms var(--ease-standard);
        }

        .workflow-card:hover .workflow-icon {
          transform: rotate(2deg);
        }

        .workflow-card h3,
        .use-case-card h3 {
          margin: 0;
          font-size: 22px;
          line-height: 1.2;
          letter-spacing: -0.01em;
        }

        .workflow-card p,
        .use-case-card p {
          margin: 10px 0 0;
          color: #475569;
          font-size: 15px;
          line-height: 1.6;
        }

        .testimonial-card {
          background: linear-gradient(180deg, #ffffff 0%, #fbfcff 100%);
          border: 1px solid #e2e8f0;
          border-radius: 20px;
          padding: 24px;
          box-shadow: 0 6px 20px rgba(15, 23, 42, 0.05);
          transition:
            transform 160ms var(--ease-standard),
            box-shadow 160ms var(--ease-standard),
            border-color 160ms var(--ease-standard);
        }

        .testimonial-card:hover {
          transform: translateY(-2px);
          border-color: #cbd5e1;
          box-shadow: 0 12px 26px rgba(15, 23, 42, 0.1);
        }

        .testimonial-card:hover .testimonial-highlight {
          background: #e0e7ff;
        }

        .testimonial-highlight {
          display: inline-flex;
          align-items: center;
          min-height: 24px;
          border-radius: 999px;
          padding: 0 10px;
          background: #eef2ff;
          color: #3730a3;
          font-size: 12px;
          font-weight: 700;
          margin-bottom: 12px;
        }

        .testimonial-card p {
          margin: 0;
          font-size: 18px;
          font-weight: 500;
          line-height: 1.6;
          color: #0f172a;
        }

        .testimonial-card strong {
          display: block;
          margin-top: 14px;
          font-size: 15px;
          font-weight: 650;
        }

        .testimonial-card small {
          display: block;
          margin-top: 4px;
          font-size: 13px;
          font-weight: 500;
          color: #64748b;
        }

        .use-case-card {
          border-radius: 20px;
          border: 1px solid;
          padding: 24px;
          transition: box-shadow 160ms var(--ease-standard), transform 160ms var(--ease-standard), border-color 160ms var(--ease-standard);
        }

        .use-case-icon {
          width: 38px;
          height: 38px;
          border-radius: 999px;
          display: grid;
          place-items: center;
          margin-bottom: 14px;
          transition: transform 160ms var(--ease-standard);
        }

        .use-case-card:hover {
          transform: translateY(-2px);
          box-shadow: var(--e-2);
        }

        .use-case-card:hover .use-case-icon {
          transform: scale(1.03);
        }

        .use-case-card:hover h3 {
          color: #0f172a;
        }

        .use-case-card.restaurants {
          background: #fff7ed;
          border-color: #fed7aa;
        }

        .use-case-card.retail {
          background: #f5f3ff;
          border-color: #ddd6fe;
        }

        .use-case-card.healthcare {
          background: #ecfeff;
          border-color: #bae6fd;
        }

        .use-case-card.restaurants .use-case-icon {
          background: #ffedd5;
          color: #b45309;
        }

        .use-case-card.retail .use-case-icon {
          background: #ede9fe;
          color: #6d28d9;
        }

        .use-case-card.healthcare .use-case-icon {
          background: #cffafe;
          color: #0f766e;
        }

        .cta-section {
          padding-top: 88px;
        }

        .final-cta {
          position: relative;
          overflow: hidden;
          background:
            radial-gradient(circle at 20% 20%, rgba(79, 70, 229, 0.14), transparent 36%),
            radial-gradient(circle at 80% 10%, rgba(15, 118, 110, 0.1), transparent 30%),
            linear-gradient(180deg, #ffffff 0%, #f7f8ff 100%);
          border: 1px solid #e2e8f0;
          border-radius: 28px;
          padding: 48px;
          box-shadow: 0 20px 50px rgba(15, 23, 42, 0.08);
          text-align: center;
          transition:
            transform 220ms var(--ease-standard),
            box-shadow 220ms var(--ease-standard);
        }

        .final-cta:hover {
          transform: translateY(-2px);
          box-shadow: 0 24px 54px rgba(15, 23, 42, 0.12);
        }

        .final-cta h2 {
          margin: 0;
          font-size: clamp(32px, 4vw, 40px);
          font-weight: 700;
          line-height: 1.15;
        }

        .final-cta p {
          margin: 12px auto 0;
          max-width: 56ch;
          font-size: 18px;
          font-weight: 450;
          line-height: 1.6;
          color: #475569;
        }

        .final-cta-actions {
          justify-content: center;
        }

        .cta-primary {
          position: relative;
          isolation: isolate;
        }

        .cta-primary::after {
          content: '';
          position: absolute;
          inset: -4px;
          border-radius: inherit;
          z-index: -1;
          box-shadow: 0 0 0 0 rgba(79, 70, 229, 0.35);
          animation: cta-pulse 3.5s var(--ease-standard) infinite;
        }

        .site-footer {
          margin-top: 56px;
          border-top: 1px solid #e2e8f0;
          padding-top: 32px;
        }

        .site-footer-top {
          display: flex;
          justify-content: space-between;
          gap: 24px;
          align-items: flex-start;
          padding-bottom: 20px;
        }

        .footer-brand {
          display: flex;
          gap: 10px;
          align-items: flex-start;
        }

        .footer-brand strong {
          display: block;
          line-height: 1.2;
        }

        .footer-brand p {
          margin: 6px 0 0;
          color: #64748b;
          font-size: 13px;
          line-height: 1.5;
        }

        .footer-links {
          display: flex;
          gap: 24px;
        }

        .footer-links > div {
          display: grid;
          gap: 6px;
          min-width: 120px;
        }

        .footer-links span {
          font-size: 11px;
          font-weight: 700;
          color: #64748b;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          margin-bottom: 2px;
        }

        .footer-links a {
          font-size: 13px;
          color: #334155;
          transition: color 120ms var(--ease-saas), transform 120ms var(--ease-saas);
        }

        .footer-links a:hover {
          color: #0f172a;
          transform: translateY(-1px);
        }

        .site-footer-bottom {
          border-top: 1px solid #e2e8f0;
          padding: 12px 0 20px;
          font-size: 13px;
          color: #64748b;
        }

        @keyframes preview-in {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }

        @keyframes chip-in {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }

        @keyframes cta-pulse {
          0%, 78%, 100% { box-shadow: 0 0 0 0 rgba(79, 70, 229, 0); }
          84% { box-shadow: 0 0 0 12px rgba(79, 70, 229, 0.12); }
        }

        @media (max-width: 1080px) {
          .hero-inner {
            grid-template-columns: 1fr;
            gap: 28px;
          }

          .metrics,
          .workflow-grid,
          .testimonial-grid,
          .use-cases-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }

          .metrics {
            margin-top: 8px;
          }

          .site-footer-top {
            flex-direction: column;
          }
        }

        @media (max-width: 720px) {
          .container,
          .site-header-inner {
            width: min(1120px, calc(100% - 32px));
            padding-left: 0;
            padding-right: 0;
          }

          .site-actions {
            display: none;
          }

          .hero {
            padding-top: 64px;
            padding-bottom: 48px;
          }

          .hero-copy h1 {
            font-size: 42px;
          }

          .metrics,
          .workflow-grid,
          .testimonial-grid,
          .use-cases-grid {
            grid-template-columns: 1fr;
          }

          .timeline-scale {
            padding-left: 0;
          }

          .final-cta {
            padding: 32px 20px;
          }

          .footer-links {
            width: 100%;
            justify-content: space-between;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          [data-reveal] {
            opacity: 1 !important;
            transform: none !important;
            transition: none !important;
          }

          .hero-preview-card,
          .metric-chip,
          .cta-primary::after {
            animation: none !important;
          }

          .nav-trial,
          .workflow-card,
          .workflow-icon,
          .use-case-card,
          .use-case-icon {
            transition: none !important;
          }
        }
      `}</style>
    </>
  );
}
