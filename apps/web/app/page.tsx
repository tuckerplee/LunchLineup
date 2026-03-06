'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  Shield,
  Zap,
  Sparkles,
  ShieldCheck,
  ShieldAlert,
  Eye,
  MousePointer2,
  Layers,
} from 'lucide-react';

/* ────────────────────────────────────────────
   Scroll-reveal primitive (below-fold only)
   ──────────────────────────────────────────── */
function Reveal({
  children,
  delay = 0,
  className = '',
  style,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setVisible(true);
          obs.disconnect();
        }
      },
      { threshold: 0.1 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={className}
      style={{
        ...style,
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(32px)',
        transition: `opacity 0.78s cubic-bezier(0.16, 1, 0.3, 1) ${delay}ms, transform 0.78s cubic-bezier(0.16, 1, 0.3, 1) ${delay}ms`,
      }}
    >
      {children}
    </div>
  );
}

/* ────────────────────────────────────────────
   Data
   ──────────────────────────────────────────── */
const STATS = [
  { value: '98%', label: 'Schedule accuracy', sub: 'on first publish' },
  { value: '4x', label: 'Faster to build', sub: 'vs. spreadsheets' },
  { value: '<30s', label: 'Auto-schedule', sub: 'for a full week' },
  { value: '200+', label: 'Teams running', sub: 'in beta rollout' },
];

const PREVIEW_ROWS = [
  { name: 'Alex R.', role: 'Frontline staff', shift: '9:00 AM – 5:00 PM', lunch: '12:30 PM', brk: '3:15 PM', status: 'safe' as const, label: 'Coverage safe' },
  { name: 'Jordan M.', role: 'Shift lead', shift: '10:00 AM – 6:00 PM', lunch: '1:15 PM', brk: '4:00 PM', status: 'compliant' as const, label: 'Compliant' },
  { name: 'Casey P.', role: 'Frontline staff', shift: '11:00 AM – 7:00 PM', lunch: '2:00 PM', brk: '5:10 PM', status: 'warning' as const, label: 'Late lunch risk' },
];

const FEATURES = [
  {
    Icon: Zap,
    accent: '#4171ff',
    accentBg: 'rgba(65, 113, 255, 0.10)',
    eyebrow: 'Auto-build',
    title: 'One click, complete day plan.',
    body: 'Shifts, lunches, and breaks placed together so managers start from a finished schedule — not a blank grid.',
  },
  {
    Icon: Shield,
    accent: '#17b26a',
    accentBg: 'rgba(23, 178, 106, 0.10)',
    eyebrow: 'Guardrails',
    title: 'Catch issues before they ship.',
    body: 'Coverage gaps, late lunches, and policy risks surface while editing — not after publish.',
  },
  {
    Icon: MousePointer2,
    accent: '#f59e0b',
    accentBg: 'rgba(245, 158, 11, 0.10)',
    eyebrow: 'Overrides',
    title: 'Flexible without breaking.',
    body: 'Drag, swap, and adjust plans while keeping underlying compliance rules intact.',
  },
  {
    Icon: Eye,
    accent: '#22b8cf',
    accentBg: 'rgba(34, 184, 207, 0.10)',
    eyebrow: 'Clarity',
    title: 'See what needs attention.',
    body: 'The interface prioritizes decisions, not dashboard noise. Clean views for what matters.',
  },
];

/* ────────────────────────────────────────────
   Page
   ──────────────────────────────────────────── */
export default function HomePage() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 32);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="lp">
      {/* ── Background orbs ── */}
      <div className="lp-orbs" aria-hidden="true">
        <div className="lp-orb lp-orb--1" />
        <div className="lp-orb lp-orb--2" />
        <div className="lp-orb lp-orb--3" />
      </div>

      {/* ── Dot grid overlay ── */}
      <div className="lp-dots" aria-hidden="true" />

      {/* ━━━ Nav ━━━ */}
      <nav className={`lp-nav${scrolled ? ' lp-nav--scrolled' : ''}`}>
        <div className="lp-nav__inner">
          <Link href="/" className="lp-nav__logo">
            <div className="lp-nav__icon">🍱</div>
            <div>
              <div className="lp-nav__wordmark">LunchLineup</div>
              <div className="lp-nav__tagline">Shift + break autopilot</div>
            </div>
          </Link>
          <div className="lp-nav__actions">
            <Link href="/auth/login" className="lp-nav__signin">Sign in</Link>
            <Link href="/onboarding" className="btn btn-primary">Start Free</Link>
          </div>
        </div>
      </nav>

      {/* ━━━ Hero ━━━ */}
      <section className="lp-hero">
        <div className="lp-hero__badge animate-fade-up">
          <Sparkles size={13} />
          <span>Now scheduling 200+ teams in beta</span>
          <ArrowRight size={12} />
        </div>

        <h1 className="lp-hero__title animate-fade-up delay-100">
          Shift scheduling that{' '}
          <span className="lp-gradient-text">looks finished</span>{' '}
          before managers touch it.
        </h1>

        <p className="lp-hero__subtitle animate-fade-up delay-200">
          LunchLineup auto-builds shifts, lunches, and breaks with coverage and
          compliance handled up front — so teams stop living inside spreadsheet
          logic.
        </p>

        <div className="lp-hero__actions animate-fade-up delay-300">
          <Link href="/onboarding" className="btn btn-primary btn-lg lp-hero__cta">
            Start scheduling free
            <ArrowRight size={17} />
          </Link>
          <Link href="/auth/login" className="btn btn-secondary btn-lg">
            Open demo workspace
          </Link>
        </div>

        <p className="lp-hero__trust animate-fade-up delay-400">
          Free for teams under 25 · No credit card required
        </p>
      </section>

      {/* ━━━ Stats ━━━ */}
      <Reveal>
        <section className="lp-stats">
          <div className="lp-stats__card">
            {STATS.map((s) => (
              <div key={s.label} className="lp-stat">
                <div className="lp-stat__value">{s.value}</div>
                <div className="lp-stat__label">{s.label}</div>
                <div className="lp-stat__sub">{s.sub}</div>
              </div>
            ))}
          </div>
        </section>
      </Reveal>

      {/* ━━━ Product Preview ━━━ */}
      <section className="lp-section">
        <Reveal>
          <div className="lp-section__header">
            <span className="lp-kicker">Product preview</span>
            <h2 className="lp-section__title">
              The first thing people should feel:{' '}
              <span className="lp-gradient-text">order.</span>
            </h2>
            <p className="lp-section__subtitle">
              A live look at how schedules come together — coverage, compliance,
              and clarity from the start.
            </p>
          </div>
        </Reveal>

        <Reveal delay={120}>
          <div className="lp-preview-wrap">
            <div className="lp-preview-glow" />
            <div className="lp-preview">
              {/* Chrome bar */}
              <div className="lp-preview__chrome">
                <div className="lp-preview__dots">
                  <span style={{ background: '#ff8fa4' }} />
                  <span style={{ background: '#ffd480' }} />
                  <span style={{ background: '#8de8b8' }} />
                </div>
                <div className="lp-preview__tab">Friday lunch coverage</div>
              </div>

              {/* Table head */}
              <div className="lp-preview__thead">
                <span>Employee</span>
                <span>Shift</span>
                <span>Break plan</span>
                <span style={{ textAlign: 'right' }}>Status</span>
              </div>

              {/* Rows */}
              {PREVIEW_ROWS.map((row) => (
                <div key={row.name} className="lp-preview__row">
                  <div>
                    <div className="lp-preview__name">{row.name}</div>
                    <div className="lp-preview__role">{row.role}</div>
                  </div>
                  <div className="lp-preview__shift">{row.shift}</div>
                  <div className="lp-preview__breaks">
                    <span>Lunch {row.lunch}</span>
                    <span>Break {row.brk}</span>
                  </div>
                  <div className={`lp-preview__status lp-preview__status--${row.status}`}>
                    {row.status === 'warning' ? <ShieldAlert size={12} /> : <ShieldCheck size={12} />}
                    {row.label}
                  </div>
                </div>
              ))}

              {/* Floating badges */}
              <div className="lp-float-badge lp-float-badge--compliance">
                <ShieldCheck size={13} /> Compliance: 100%
              </div>
              <div className="lp-float-badge lp-float-badge--coverage">
                <Layers size={13} /> 3 staff on floor
              </div>
            </div>
          </div>
        </Reveal>
      </section>

      {/* ━━━ Features ━━━ */}
      <section className="lp-section">
        <Reveal>
          <div className="lp-section__header">
            <span className="lp-kicker">Why it works</span>
            <h2 className="lp-section__title">
              Built so managers feel in control{' '}
              <span className="lp-gradient-text">from day one.</span>
            </h2>
          </div>
        </Reveal>

        <div className="lp-features">
          {FEATURES.map((f, i) => (
            <Reveal key={f.eyebrow} delay={i * 100}>
              <div className="lp-feature">
                <div
                  className="lp-feature__icon"
                  style={{ background: f.accentBg, color: f.accent }}
                >
                  <f.Icon size={22} />
                </div>
                <div className="lp-feature__eyebrow" style={{ color: f.accent }}>
                  {f.eyebrow}
                </div>
                <h3 className="lp-feature__title">{f.title}</h3>
                <p className="lp-feature__body">{f.body}</p>
                <div className="lp-feature__glow" style={{ background: f.accent }} />
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ━━━ Testimonial ━━━ */}
      <section className="lp-section">
        <Reveal>
          <div className="lp-testimonial">
            <div className="lp-testimonial__accent" />
            <blockquote className="lp-testimonial__quote">
              &ldquo;We went from three hours of weekly scheduling to fifteen
              minutes. Managers stopped dreading Sundays.&rdquo;
            </blockquote>
            <div className="lp-testimonial__attr">
              <div className="lp-testimonial__avatar">SK</div>
              <div>
                <div className="lp-testimonial__name">Sarah K.</div>
                <div className="lp-testimonial__role">
                  Ops Director, QuickBite Group
                </div>
              </div>
            </div>
          </div>
        </Reveal>
      </section>

      {/* ━━━ CTA ━━━ */}
      <section className="lp-section">
        <Reveal>
          <div className="lp-cta">
            <div className="lp-cta__orb lp-cta__orb--1" />
            <div className="lp-cta__orb lp-cta__orb--2" />
            <span className="lp-kicker lp-kicker--light">Ready</span>
            <h2 className="lp-cta__title">
              Replace spreadsheet scheduling this week.
            </h2>
            <p className="lp-cta__subtitle">
              Set up your first location and publish a schedule that already
              includes lunches and breaks.
            </p>
            <div className="lp-cta__actions">
              <Link href="/onboarding" className="btn lp-cta__btn-primary">
                Create account
                <ArrowRight size={16} />
              </Link>
              <Link href="/auth/login" className="btn lp-cta__btn-secondary">
                Sign in
              </Link>
            </div>
          </div>
        </Reveal>
      </section>

      {/* ━━━ Footer ━━━ */}
      <footer className="lp-footer">
        <div className="lp-footer__inner">
          <div className="lp-footer__brand">
            <div className="lp-nav__icon" style={{ width: 28, height: 28, fontSize: '0.85rem' }}>🍱</div>
            <span className="lp-footer__name">LunchLineup</span>
          </div>
          <div className="lp-footer__copy">
            © {new Date().getFullYear()} LunchLineup. All rights reserved.
          </div>
        </div>
      </footer>

      {/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          Scoped global styles for the landing page
          ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <style jsx global>{`
        /* ── Base ── */
        .lp {
          position: relative;
          min-height: 100vh;
          overflow-x: hidden;
        }

        /* ── Background orbs ── */
        .lp-orbs {
          position: fixed;
          inset: 0;
          pointer-events: none;
          z-index: 0;
          overflow: hidden;
        }
        .lp-orb {
          position: absolute;
          border-radius: 50%;
          filter: blur(100px);
          will-change: transform;
        }
        .lp-orb--1 {
          width: 720px;
          height: 720px;
          top: -22%;
          left: -12%;
          background: radial-gradient(circle, rgba(65, 113, 255, 0.18), transparent 70%);
          animation: float-slow 24s ease-in-out infinite;
        }
        .lp-orb--2 {
          width: 560px;
          height: 560px;
          top: -6%;
          right: -10%;
          background: radial-gradient(circle, rgba(34, 184, 207, 0.16), transparent 70%);
          animation: float-med 20s ease-in-out infinite;
        }
        .lp-orb--3 {
          width: 480px;
          height: 480px;
          top: 42%;
          left: 28%;
          background: radial-gradient(circle, rgba(79, 121, 255, 0.11), transparent 70%);
          animation: float-slow 28s ease-in-out infinite reverse;
        }

        /* ── Dot grid ── */
        .lp-dots {
          position: fixed;
          inset: 0;
          pointer-events: none;
          z-index: 0;
          background-image: radial-gradient(rgba(31, 42, 68, 0.045) 1px, transparent 1px);
          background-size: 28px 28px;
          -webkit-mask-image: radial-gradient(ellipse 80% 60% at 50% 30%, black 20%, transparent 72%);
          mask-image: radial-gradient(ellipse 80% 60% at 50% 30%, black 20%, transparent 72%);
        }

        /* ── Nav ── */
        .lp-nav {
          position: sticky;
          top: 0;
          z-index: 50;
          transition: background 0.4s cubic-bezier(0.16, 1, 0.3, 1),
                      box-shadow 0.4s cubic-bezier(0.16, 1, 0.3, 1),
                      border-color 0.4s;
          border-bottom: 1px solid transparent;
        }
        .lp-nav--scrolled {
          background: rgba(248, 250, 255, 0.78);
          backdrop-filter: blur(18px);
          -webkit-backdrop-filter: blur(18px);
          border-bottom-color: rgba(31, 42, 68, 0.07);
          box-shadow: 0 1px 16px rgba(31, 42, 68, 0.05);
        }
        .lp-nav__inner {
          max-width: 1200px;
          margin: 0 auto;
          padding: 0.9rem 1.5rem;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .lp-nav__logo {
          display: flex;
          align-items: center;
          gap: 0.6rem;
          transition: opacity 0.2s;
        }
        .lp-nav__logo:hover { opacity: 0.85; }
        .lp-nav__icon {
          width: 34px;
          height: 34px;
          border-radius: 10px;
          background: linear-gradient(135deg, #4171ff, #2f63ff 60%, #22b8cf);
          color: #fff;
          display: grid;
          place-items: center;
          font-size: 1rem;
          flex-shrink: 0;
        }
        .lp-nav__wordmark {
          font-weight: 800;
          letter-spacing: -0.02em;
          color: var(--text-primary);
          font-size: 0.95rem;
          line-height: 1.2;
        }
        .lp-nav__tagline {
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--text-muted);
          font-weight: 700;
          font-size: 0.6rem;
        }
        .lp-nav__actions {
          display: flex;
          align-items: center;
          gap: 0.8rem;
        }
        .lp-nav__signin {
          font-size: 0.88rem;
          font-weight: 700;
          color: var(--text-secondary);
          transition: color 0.2s;
        }
        .lp-nav__signin:hover { color: var(--text-primary); }

        /* ── Hero ── */
        .lp-hero {
          position: relative;
          z-index: 1;
          max-width: 1200px;
          margin: 0 auto;
          padding: 5.5rem 1.5rem 3.5rem;
          text-align: center;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 1.1rem;
        }
        .lp-hero__badge {
          display: inline-flex;
          align-items: center;
          gap: 0.45rem;
          padding: 0.38rem 0.95rem;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.78);
          border: 1px solid rgba(47, 99, 255, 0.14);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          font-size: 0.78rem;
          font-weight: 660;
          color: var(--brand);
          cursor: default;
          transition: all 0.35s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .lp-hero__badge:hover {
          border-color: rgba(47, 99, 255, 0.35);
          box-shadow: 0 0 24px rgba(47, 99, 255, 0.1);
          transform: translateY(-1px);
        }
        .lp-hero__title {
          font-size: clamp(2.8rem, 7vw, 5.4rem);
          line-height: 1;
          font-weight: 840;
          letter-spacing: -0.055em;
          color: var(--text-primary);
          max-width: 840px;
        }
        .lp-gradient-text {
          background: linear-gradient(135deg, #2f63ff 0%, #22b8cf 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }
        .lp-hero__subtitle {
          max-width: 580px;
          font-size: 1.12rem;
          line-height: 1.6;
          color: var(--text-secondary);
        }
        .lp-hero__actions {
          display: flex;
          gap: 0.8rem;
          flex-wrap: wrap;
          justify-content: center;
          margin-top: 0.4rem;
        }
        .lp-hero__cta {
          position: relative;
          box-shadow: 0 14px 36px rgba(47, 99, 255, 0.32),
                      0 0 0 0 rgba(47, 99, 255, 0);
          transition: all 0.35s cubic-bezier(0.16, 1, 0.3, 1) !important;
        }
        .lp-hero__cta:hover {
          box-shadow: 0 18px 44px rgba(47, 99, 255, 0.4),
                      0 0 0 4px rgba(47, 99, 255, 0.08) !important;
          transform: translateY(-2px) !important;
        }
        .lp-hero__trust {
          font-size: 0.8rem;
          color: var(--text-muted);
          margin-top: 0.15rem;
        }

        /* ── Stats ── */
        .lp-stats {
          position: relative;
          z-index: 1;
          max-width: 1200px;
          margin: 0 auto;
          padding: 0 1.5rem 5.5rem;
        }
        .lp-stats__card {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          background: rgba(255, 255, 255, 0.7);
          border: 1px solid rgba(31, 42, 68, 0.07);
          border-radius: 20px;
          backdrop-filter: blur(14px);
          -webkit-backdrop-filter: blur(14px);
          box-shadow: 0 12px 44px rgba(31, 42, 68, 0.06);
          overflow: hidden;
        }
        .lp-stat {
          padding: 1.8rem 1.5rem;
          text-align: center;
          border-right: 1px solid rgba(31, 42, 68, 0.05);
          transition: background 0.3s;
        }
        .lp-stat:last-child { border-right: none; }
        .lp-stat:hover { background: rgba(47, 99, 255, 0.025); }
        .lp-stat__value {
          font-size: 2.3rem;
          font-weight: 840;
          letter-spacing: -0.04em;
          line-height: 1;
          background: linear-gradient(135deg, #1d2d66, #3058e8);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }
        .lp-stat__label {
          font-size: 0.84rem;
          font-weight: 720;
          color: var(--text-secondary);
          margin-top: 0.25rem;
        }
        .lp-stat__sub {
          font-size: 0.72rem;
          color: var(--text-muted);
          margin-top: 0.1rem;
        }

        /* ── Section shell ── */
        .lp-section {
          position: relative;
          z-index: 1;
          max-width: 1200px;
          margin: 0 auto;
          padding: 0 1.5rem 6.5rem;
        }
        .lp-section__header {
          text-align: center;
          margin-bottom: 3.5rem;
        }
        .lp-kicker {
          display: inline-block;
          font-size: 0.72rem;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          font-weight: 760;
          color: var(--brand);
          margin-bottom: 0.7rem;
        }
        .lp-kicker--light { color: rgba(255, 255, 255, 0.6); }
        .lp-section__title {
          font-size: clamp(1.8rem, 4vw, 2.8rem);
          line-height: 1.08;
          font-weight: 830;
          letter-spacing: -0.04em;
          color: var(--text-primary);
          max-width: 700px;
          margin: 0 auto;
        }
        .lp-section__subtitle {
          font-size: 1.02rem;
          color: var(--text-secondary);
          max-width: 540px;
          margin: 0.85rem auto 0;
          line-height: 1.55;
        }

        /* ── Product preview ── */
        .lp-preview-wrap {
          position: relative;
          max-width: 880px;
          margin: 0 auto;
        }
        .lp-preview-glow {
          position: absolute;
          inset: 50px -28px -28px -28px;
          background: radial-gradient(ellipse at center, rgba(47, 99, 255, 0.11), transparent 68%);
          border-radius: 34px;
          filter: blur(44px);
          z-index: -1;
        }
        .lp-preview {
          position: relative;
          background: rgba(255, 255, 255, 0.82);
          border: 1px solid rgba(31, 42, 68, 0.09);
          border-radius: 22px;
          backdrop-filter: blur(14px);
          -webkit-backdrop-filter: blur(14px);
          box-shadow: 0 28px 64px rgba(31, 42, 68, 0.1),
                      0 1px 3px rgba(31, 42, 68, 0.05);
          overflow: visible;
          transition: transform 0.45s cubic-bezier(0.16, 1, 0.3, 1),
                      box-shadow 0.45s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .lp-preview:hover {
          transform: translateY(-5px);
          box-shadow: 0 36px 80px rgba(31, 42, 68, 0.14),
                      0 1px 3px rgba(31, 42, 68, 0.05);
        }
        .lp-preview__chrome {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0.95rem 1.4rem;
          border-bottom: 1px solid rgba(31, 42, 68, 0.06);
          background: rgba(248, 250, 255, 0.55);
          border-radius: 22px 22px 0 0;
        }
        .lp-preview__dots {
          display: flex;
          gap: 7px;
        }
        .lp-preview__dots span {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .lp-preview:hover .lp-preview__dots span {
          transform: scale(1.15);
        }
        .lp-preview__tab {
          font-size: 0.72rem;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          font-weight: 720;
          color: var(--text-muted);
        }
        .lp-preview__thead {
          display: grid;
          grid-template-columns: 1.2fr 1.1fr 1.1fr auto;
          gap: 1rem;
          padding: 0.75rem 1.4rem;
          font-size: 0.68rem;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          font-weight: 720;
          color: var(--text-muted);
          border-bottom: 1px solid rgba(31, 42, 68, 0.05);
        }
        .lp-preview__row {
          display: grid;
          grid-template-columns: 1.2fr 1.1fr 1.1fr auto;
          gap: 1rem;
          align-items: center;
          padding: 1rem 1.4rem;
          border-bottom: 1px solid rgba(31, 42, 68, 0.04);
          transition: background 0.25s;
        }
        .lp-preview__row:last-child { border-bottom: none; }
        .lp-preview__row:hover { background: rgba(47, 99, 255, 0.018); }
        .lp-preview__name {
          font-size: 0.88rem;
          font-weight: 730;
          color: var(--text-primary);
        }
        .lp-preview__role {
          font-size: 0.72rem;
          color: var(--text-muted);
          margin-top: 1px;
        }
        .lp-preview__shift {
          font-size: 0.82rem;
          color: var(--text-secondary);
        }
        .lp-preview__breaks {
          display: flex;
          flex-direction: column;
          gap: 2px;
          font-size: 0.78rem;
          color: var(--text-secondary);
        }
        .lp-preview__status {
          display: inline-flex;
          align-items: center;
          gap: 0.32rem;
          padding: 0.3rem 0.65rem;
          border-radius: 999px;
          font-size: 0.7rem;
          font-weight: 730;
          white-space: nowrap;
          justify-self: end;
          transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .lp-preview__row:hover .lp-preview__status {
          transform: scale(1.04);
        }
        .lp-preview__status--safe {
          background: #edf3ff;
          color: #175cd3;
          border: 1px solid #cddfff;
        }
        .lp-preview__status--compliant {
          background: #ecfdf3;
          color: #107569;
          border: 1px solid #b7ebcf;
        }
        .lp-preview__status--warning {
          background: #fff6ed;
          color: #b54708;
          border: 1px solid #fecdca;
        }

        /* Floating badges */
        .lp-float-badge {
          position: absolute;
          display: inline-flex;
          align-items: center;
          gap: 0.38rem;
          padding: 0.48rem 0.9rem;
          border-radius: 999px;
          font-size: 0.76rem;
          font-weight: 720;
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          box-shadow: 0 10px 28px rgba(31, 42, 68, 0.14);
          animation: lp-badge-bob 4.5s ease-in-out infinite;
          z-index: 2;
        }
        .lp-float-badge--compliance {
          top: -16px;
          right: 28px;
          background: rgba(236, 253, 243, 0.92);
          color: #107569;
          border: 1px solid #b7ebcf;
        }
        .lp-float-badge--coverage {
          bottom: 22px;
          left: -20px;
          background: rgba(237, 243, 255, 0.92);
          color: #175cd3;
          border: 1px solid #cddfff;
          animation-delay: -2.2s;
        }
        @keyframes lp-badge-bob {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-7px); }
        }

        /* ── Features ── */
        .lp-features {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 1.3rem;
        }
        .lp-feature {
          position: relative;
          overflow: hidden;
          background: rgba(255, 255, 255, 0.68);
          border: 1px solid rgba(31, 42, 68, 0.07);
          border-radius: 20px;
          padding: 2rem 2rem 2.2rem;
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          transition: all 0.38s cubic-bezier(0.16, 1, 0.3, 1);
          cursor: default;
        }
        .lp-feature:hover {
          border-color: rgba(47, 99, 255, 0.18);
          box-shadow: 0 22px 52px rgba(31, 42, 68, 0.1);
          transform: translateY(-4px);
        }
        .lp-feature__icon {
          width: 50px;
          height: 50px;
          border-radius: 14px;
          display: grid;
          place-items: center;
          margin-bottom: 1.1rem;
          transition: transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .lp-feature:hover .lp-feature__icon {
          transform: scale(1.1) rotate(-2deg);
        }
        .lp-feature__eyebrow {
          font-size: 0.72rem;
          text-transform: uppercase;
          letter-spacing: 0.09em;
          font-weight: 760;
          margin-bottom: 0.35rem;
        }
        .lp-feature__title {
          font-size: 1.14rem;
          font-weight: 780;
          letter-spacing: -0.02em;
          color: var(--text-primary);
          line-height: 1.2;
          margin-bottom: 0.5rem;
        }
        .lp-feature__body {
          font-size: 0.88rem;
          color: var(--text-secondary);
          line-height: 1.55;
        }
        .lp-feature__glow {
          position: absolute;
          top: -50px;
          right: -50px;
          width: 140px;
          height: 140px;
          border-radius: 50%;
          opacity: 0;
          filter: blur(48px);
          transition: opacity 0.45s;
          pointer-events: none;
        }
        .lp-feature:hover .lp-feature__glow { opacity: 0.13; }

        /* ── Testimonial ── */
        .lp-testimonial {
          position: relative;
          max-width: 780px;
          margin: 0 auto;
          background: rgba(255, 255, 255, 0.68);
          border: 1px solid rgba(31, 42, 68, 0.07);
          border-radius: 24px;
          padding: 2.8rem 3.2rem;
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          box-shadow: 0 18px 44px rgba(31, 42, 68, 0.06);
          overflow: hidden;
          transition: all 0.38s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .lp-testimonial:hover {
          transform: translateY(-3px);
          box-shadow: 0 24px 56px rgba(31, 42, 68, 0.09);
        }
        .lp-testimonial__accent {
          position: absolute;
          top: 0;
          left: 0;
          width: 4px;
          height: 100%;
          background: linear-gradient(180deg, #4171ff, #22b8cf);
          border-radius: 4px 0 0 4px;
        }
        .lp-testimonial__quote {
          font-size: clamp(1.3rem, 2.5vw, 1.72rem);
          line-height: 1.38;
          letter-spacing: -0.015em;
          color: var(--text-primary);
          font-weight: 500;
          font-style: italic;
        }
        .lp-testimonial__attr {
          display: flex;
          align-items: center;
          gap: 0.8rem;
          margin-top: 1.6rem;
        }
        .lp-testimonial__avatar {
          width: 44px;
          height: 44px;
          border-radius: 50%;
          background: linear-gradient(135deg, #4171ff, #22b8cf);
          color: #fff;
          display: grid;
          place-items: center;
          font-size: 0.82rem;
          font-weight: 760;
          flex-shrink: 0;
        }
        .lp-testimonial__name {
          font-size: 0.9rem;
          font-weight: 730;
          color: var(--text-primary);
        }
        .lp-testimonial__role {
          font-size: 0.78rem;
          color: var(--text-muted);
        }

        /* ── CTA ── */
        .lp-cta {
          position: relative;
          overflow: hidden;
          border-radius: 28px;
          padding: 4.5rem 2.5rem;
          text-align: center;
          background: linear-gradient(135deg, #1a2756 0%, #2f63ff 48%, #1da8c1 110%);
          box-shadow: 0 28px 68px rgba(47, 99, 255, 0.22);
          transition: box-shadow 0.4s;
        }
        .lp-cta:hover {
          box-shadow: 0 34px 80px rgba(47, 99, 255, 0.28);
        }
        .lp-cta__orb {
          position: absolute;
          border-radius: 50%;
          pointer-events: none;
        }
        .lp-cta__orb--1 {
          width: 420px;
          height: 420px;
          top: -160px;
          right: -100px;
          background: radial-gradient(circle, rgba(34, 184, 207, 0.3), transparent 70%);
          animation: float-slow 18s ease-in-out infinite;
        }
        .lp-cta__orb--2 {
          width: 320px;
          height: 320px;
          bottom: -120px;
          left: -80px;
          background: radial-gradient(circle, rgba(255, 255, 255, 0.07), transparent 70%);
          animation: float-med 22s ease-in-out infinite;
        }
        .lp-cta__title {
          position: relative;
          font-size: clamp(1.8rem, 4vw, 2.8rem);
          font-weight: 840;
          letter-spacing: -0.04em;
          line-height: 1.08;
          color: #ffffff;
          max-width: 600px;
          margin: 0.5rem auto 0;
        }
        .lp-cta__subtitle {
          position: relative;
          font-size: 1.02rem;
          color: rgba(255, 255, 255, 0.72);
          max-width: 450px;
          margin: 1.1rem auto 0;
          line-height: 1.55;
        }
        .lp-cta__actions {
          position: relative;
          display: flex;
          gap: 0.8rem;
          justify-content: center;
          flex-wrap: wrap;
          margin-top: 2.2rem;
        }
        .lp-cta__btn-primary {
          background: #ffffff !important;
          color: #2f63ff !important;
          font-weight: 730 !important;
          box-shadow: 0 10px 28px rgba(0, 0, 0, 0.15) !important;
          transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1) !important;
        }
        .lp-cta__btn-primary:hover {
          transform: translateY(-2px) !important;
          box-shadow: 0 14px 36px rgba(0, 0, 0, 0.22) !important;
        }
        .lp-cta__btn-secondary {
          background: transparent !important;
          color: rgba(255, 255, 255, 0.88) !important;
          border: 1px solid rgba(255, 255, 255, 0.28) !important;
          transition: all 0.3s !important;
        }
        .lp-cta__btn-secondary:hover {
          background: rgba(255, 255, 255, 0.1) !important;
          border-color: rgba(255, 255, 255, 0.48) !important;
        }

        /* ── Footer ── */
        .lp-footer {
          position: relative;
          z-index: 1;
          border-top: 1px solid rgba(31, 42, 68, 0.06);
          padding: 2rem 0;
        }
        .lp-footer__inner {
          max-width: 1200px;
          margin: 0 auto;
          padding: 0 1.5rem;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .lp-footer__brand {
          display: flex;
          align-items: center;
          gap: 0.55rem;
        }
        .lp-footer__name {
          font-weight: 760;
          font-size: 0.88rem;
          color: var(--text-secondary);
        }
        .lp-footer__copy {
          font-size: 0.78rem;
          color: var(--text-muted);
        }

        /* ━━━ Responsive ━━━ */
        @media (max-width: 960px) {
          .lp-hero { padding-top: 4rem; }
          .lp-stats__card { grid-template-columns: repeat(2, 1fr); }
          .lp-stat:nth-child(2) { border-right: none; }
          .lp-stat:nth-child(1),
          .lp-stat:nth-child(2) { border-bottom: 1px solid rgba(31, 42, 68, 0.05); }
          .lp-features { grid-template-columns: 1fr; }
          .lp-preview__thead,
          .lp-preview__row {
            grid-template-columns: 1fr 1fr;
            gap: 0.5rem 1rem;
          }
          .lp-preview__status { justify-self: start; }
          .lp-testimonial { padding: 2.2rem 2rem; }
          .lp-cta { padding: 3.5rem 1.5rem; }
          .lp-section { padding-bottom: 5rem; }
        }

        @media (max-width: 640px) {
          .lp-hero__title {
            font-size: clamp(2.2rem, 10vw, 3.4rem);
          }
          .lp-stats__card { grid-template-columns: 1fr 1fr; }
          .lp-hero__actions {
            flex-direction: column;
            width: 100%;
          }
          .lp-hero__actions .btn {
            width: 100%;
            justify-content: center;
          }
          .lp-preview__thead,
          .lp-preview__row {
            grid-template-columns: 1fr;
          }
          .lp-float-badge { display: none; }
          .lp-testimonial { padding: 1.8rem 1.4rem; }
          .lp-footer__inner {
            flex-direction: column;
            gap: 0.8rem;
            text-align: center;
          }
        }

        @media (max-width: 420px) {
          .lp-stats__card { grid-template-columns: 1fr; }
          .lp-stat { border-right: none !important; border-bottom: 1px solid rgba(31, 42, 68, 0.05); }
          .lp-stat:last-child { border-bottom: none; }
        }
      `}</style>
    </div>
  );
}
