'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { LunchLineupMark } from '@/components/branding/LunchLineupMark';
import {
  ArrowRight,
  Shield,
  Zap,
  Sparkles,
  ShieldAlert,
  MousePointer2,
  Layers,
  Users,
  Settings,
  Play,
  ChevronDown,
  Utensils,
  Store,
  HeartPulse,
  Clock,
  CheckCircle2,
  AlertTriangle,
  XCircle,
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
   FAQ accordion item
   ──────────────────────────────────────────── */
function FaqItem({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`lp-faq__item${open ? ' lp-faq__item--open' : ''}`}>
      <button
        className="lp-faq__trigger"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span>{question}</span>
        <ChevronDown size={18} className="lp-faq__chevron" />
      </button>
      <div className="lp-faq__answer">
        <p>{answer}</p>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────
   Data
   ──────────────────────────────────────────── */
const STATS = [
  {
    Icon: Shield,
    value: '98%',
    label: 'Schedule accuracy before manager edits',
    sub: 'Validated across break and lunch windows',
    accent: '#2f63ff',
    surface: 'linear-gradient(140deg, #edf3ff, #f7f9ff)',
  },
  {
    Icon: Zap,
    value: '4x',
    label: 'Faster scheduling than spreadsheets',
    sub: 'Less manual break placement each week',
    accent: '#22b8cf',
    surface: 'linear-gradient(140deg, #ebfcff, #f4feff)',
  },
  {
    Icon: Clock,
    value: '<30s',
    label: 'To generate a full week schedule',
    sub: 'From blank board to publish-ready timeline',
    accent: '#f59e0b',
    surface: 'linear-gradient(140deg, #fff5e8, #fffaf2)',
  },
  {
    Icon: Users,
    value: '200+',
    label: 'Teams running in beta',
    sub: 'Across multi-location operations',
    accent: '#17b26a',
    surface: 'linear-gradient(140deg, #ebfdf4, #f6fffb)',
  },
];

const FEATURES = [
  {
    Icon: Zap,
    accent: '#4171ff',
    accentBg: 'rgba(65, 113, 255, 0.10)',
    eyebrow: 'Auto-build',
    title: 'Start from a finished schedule instead of a blank grid.',
    body: 'Managers open a complete day plan with lunches and breaks already placed.',
  },
  {
    Icon: Shield,
    accent: '#17b26a',
    accentBg: 'rgba(23, 178, 106, 0.10)',
    eyebrow: 'Compliance guardrails',
    title: 'Late lunches and break violations appear instantly.',
    body: 'Risks surface while editing, so managers fix them before publish.',
  },
  {
    Icon: Layers,
    accent: '#22b8cf',
    accentBg: 'rgba(34, 184, 207, 0.10)',
    eyebrow: 'Coverage awareness',
    title: 'Breaks rotate automatically without leaving stations empty.',
    body: 'Coverage stays above floor minimums as lunches and breaks are placed.',
  },
  {
    Icon: MousePointer2,
    accent: '#f59e0b',
    accentBg: 'rgba(245, 158, 11, 0.10)',
    eyebrow: 'Flexible overrides',
    title: 'Drag breaks or shifts and compliance stays intact.',
    body: 'Manual adjustments keep policy and coverage constraints in place.',
  },
];

const PAIN_POINTS = [
  { Icon: Clock, text: 'Managers build shifts first' },
  { Icon: AlertTriangle, text: 'Lunches get added manually after' },
  { Icon: XCircle, text: 'Coverage breaks when breaks overlap' },
  { Icon: ShieldAlert, text: 'Compliance problems appear after publish' },
];

const HOW_IT_WORKS = [
  {
    step: '1',
    Icon: Users,
    title: 'Add your staff',
    body: 'Import employees or enter shifts directly.',
  },
  {
    step: '2',
    Icon: Settings,
    title: 'Set your rules',
    body: 'Lunch windows, break requirements, minimum floor coverage.',
  },
  {
    step: '3',
    Icon: Play,
    title: 'Generate the schedule',
    body: 'LunchLineup builds the entire day plan — shifts, lunches, breaks, and coverage — in seconds.',
  },
];

const TESTIMONIALS = [
  {
    quote: 'We went from three hours of weekly scheduling to fifteen minutes. Managers stopped dreading Sundays.',
    name: 'Sarah K.',
    role: 'Ops Director',
    company: 'QuickBite Group',
    scale: '12 locations',
    initials: 'SK',
  },
  {
    quote: 'We used to get compliance warnings every week. Since switching to LunchLineup, we haven\'t had one in four months.',
    name: 'Marcus T.',
    role: 'Regional Manager',
    company: 'FreshMart',
    scale: '18 stores',
    initials: 'MT',
  },
  {
    quote: 'The auto-scheduling handles lunch coverage perfectly. My team actually takes their breaks on time now.',
    name: 'Diana L.',
    role: 'Store Manager',
    company: 'UrbanThreads',
    scale: '9 locations',
    initials: 'DL',
  },
];

const LOGOS = [
  'QuickBite',
  'FreshMart',
  'UrbanThreads',
  'ClearHealth',
  'PeakRetail',
];

const USE_CASES = [
  {
    Icon: Utensils,
    title: 'Restaurants',
    body: 'Handle lunch rush coverage automatically. Breaks rotate around peak service hours without manual juggling.',
  },
  {
    Icon: Store,
    title: 'Retail',
    body: 'Maintain floor coverage while breaks rotate. No more empty registers during shift changes.',
  },
  {
    Icon: HeartPulse,
    title: 'Healthcare & clinics',
    body: 'Ensure compliance with mandated break windows. Staff coverage stays safe during critical hours.',
  },
];

const FAQ_ITEMS = [
  {
    question: 'Can managers still edit schedules?',
    answer: 'Yes — drag shifts or breaks and compliance rules stay intact. LunchLineup validates changes in real time so you never accidentally create a violation.',
  },
  {
    question: 'Does it work with existing systems?',
    answer: 'Export schedules as CSV or PDF, or integrate with POS and workforce management tools. We support common formats out of the box.',
  },
  {
    question: 'How long does setup take?',
    answer: 'Most teams publish their first schedule in under an hour. Import your staff, define your rules, and generate — that\'s it.',
  },
  {
    question: 'What if our break rules are complicated?',
    answer: 'LunchLineup supports meal period windows, rest break intervals, minimum coverage thresholds, and state-specific compliance rules. If you can describe the rule, we can enforce it.',
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
            <div className="lp-nav__icon"><LunchLineupMark size={34} /></div>
            <div>
              <div className="lp-nav__wordmark">LunchLineup</div>
              <div className="lp-nav__tagline">Break compliance scheduling</div>
            </div>
          </Link>
          <div className="lp-nav__actions">
            <Link href="/auth/login" className="lp-nav__signin">Sign in</Link>
            <Link href="/onboarding" className="btn btn-primary">Start Free</Link>
          </div>
        </div>
      </nav>

      {/* ━━━ 1. Hero ━━━ */}
      <section className="lp-hero">
        <div className="lp-hero__badge animate-fade-up">
          <Sparkles size={13} />
          <span>The only scheduler that handles lunches and breaks automatically</span>
        </div>

        <h1 className="lp-hero__title animate-fade-up delay-100">
          The only scheduler that handles{' '}
          <span className="lp-gradient-text">lunches and breaks automatically.</span>
        </h1>

        <p className="lp-hero__subtitle animate-fade-up delay-200">
          Schedules already include lunches and breaks before the manager opens the editor.
        </p>

        <div className="lp-hero__actions animate-fade-up delay-300">
          <Link href="/onboarding" className="btn btn-primary btn-lg lp-hero__cta">
            Create your first schedule
            <ArrowRight size={17} />
          </Link>
          <Link href="/auth/login" className="btn btn-secondary btn-lg">
            View demo workspace
          </Link>
        </div>

        <p className="lp-hero__trust animate-fade-up delay-400">
          Free for teams under 25 · No credit card required
        </p>
        <p className="lp-hero__segment animate-fade-up delay-400">
          Built for restaurants, retail, and healthcare teams.
        </p>
      </section>

      {/* ━━━ 2. Product Preview ━━━ */}
      <section className="lp-section">
        <Reveal>
          <div className="lp-section__header">
            <span className="lp-kicker">Product experience</span>
            <h2 className="lp-section__title">
              Your schedule{' '}
              <span className="lp-gradient-text">before anyone edits it.</span>
            </h2>
            <p className="lp-section__subtitle">
              Shifts, lunches, breaks, and compliance flags — all placed
              automatically before anyone opens the editor.
            </p>
          </div>
        </Reveal>

        <Reveal delay={120}>
          <div className="lp-preview-wrap">
            <div className="lp-preview-glow" />
            <div className="lp-preview">
              <div className="lp-preview__chrome">
                <div className="lp-preview__dots">
                  <span style={{ background: '#ff8fa4' }} />
                  <span style={{ background: '#ffd480' }} />
                  <span style={{ background: '#8de8b8' }} />
                </div>
                <div className="lp-preview__tab">Friday lunchlineup editor</div>
              </div>
              <div className="lp-ui">
                <aside className="lp-ui__rail">
                  <div className="lp-ui__pill lp-ui__pill--active">Timeline</div>
                  <div className="lp-ui__pill">Coverage</div>
                  <div className="lp-ui__pill">Compliance</div>
                </aside>

                <div className="lp-ui__main">
                  <div className="lp-ui__toolbar">
                    <div>
                      <div className="lp-ui__title">Frontline lunch schedule</div>
                      <div className="lp-ui__meta">Drag break cards to rebalance coverage</div>
                    </div>
                    <div className="lp-ui__coverage">
                      <span>Coverage</span>
                      <strong>84%</strong>
                      <div className="lp-ui__coverage-bar">
                        <div className="lp-ui__coverage-fill" />
                      </div>
                    </div>
                  </div>
                  <div className="lp-ui__legend">
                    <span><i className="lp-dot lp-dot--shift" /> Shift block</span>
                    <span><i className="lp-dot lp-dot--lunch" /> Lunch block</span>
                    <span><i className="lp-dot lp-dot--break" /> Break block</span>
                  </div>
                  <div className="lp-ui__warning-badge">
                    <ShieldAlert size={13} />
                    1 compliance warning
                  </div>

                  <div className="lp-timeline">
                    <div className="lp-timeline__head">
                      <span>10:00</span>
                      <span>11:00</span>
                      <span>12:00</span>
                      <span>1:00</span>
                      <span>2:00</span>
                      <span>3:00</span>
                    </div>

                    <div className="lp-lane">
                      <div className="lp-lane__name">Alex R.</div>
                      <div className="lp-lane__grid">
                        <div className="lp-shift-block">Shift</div>
                        <div className="lp-break-block lp-break-block--lunch lp-break-block--drag">
                          <MousePointer2 size={12} />
                          Lunch 12:10
                        </div>
                        <div className="lp-break-block lp-break-block--break lp-break-block--rest">
                          Break 2:35
                        </div>
                      </div>
                    </div>

                    <div className="lp-lane">
                      <div className="lp-lane__name">Jordan M.</div>
                      <div className="lp-lane__grid">
                        <div className="lp-shift-block">Shift</div>
                        <div className="lp-break-block lp-break-block--lunch">Lunch 1:20</div>
                        <div className="lp-break-block lp-break-block--break lp-break-block--rest-2">Break 2:50</div>
                      </div>
                    </div>

                    <div className="lp-lane">
                      <div className="lp-lane__name">Casey P.</div>
                      <div className="lp-lane__grid">
                        <div className="lp-shift-block">Shift</div>
                        <div className="lp-break-block lp-break-block--lunch lp-break-block--warn">
                          <AlertTriangle size={12} />
                          Lunch overdue
                        </div>
                        <div className="lp-break-block lp-break-block--break lp-break-block--rest-3">Break 3:10</div>
                      </div>
                    </div>
                  </div>

                  <div className="lp-ui__alerts">
                    <div className="lp-alert lp-alert--warn">
                      <ShieldAlert size={14} />
                      Casey exceeds meal window in 14 min
                    </div>
                    <div className="lp-alert">
                      <Layers size={14} />
                      Floor coverage remains above 3 staff
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Reveal>
      </section>

      {/* ━━━ 3. Pain Statement ━━━ */}
      <section className="lp-section">
        <Reveal>
          <div className="lp-section__header">
            <span className="lp-kicker">The problem</span>
            <h2 className="lp-section__title">
              Scheduling breaks is where schedules{' '}
              <span className="lp-gradient-text">fall apart.</span>
            </h2>
          </div>
        </Reveal>

        <Reveal delay={100}>
          <div className="lp-pain">
            <p className="lp-pain__intro">
              Most scheduling tools handle shifts. Breaks get solved afterward — and that&apos;s where problems start.
            </p>
            <div className="lp-pain__list">
              {PAIN_POINTS.map((p, i) => (
                <div key={i} className="lp-pain__item">
                  <div className="lp-pain__icon">
                    <p.Icon size={18} />
                  </div>
                  <span>{p.text}</span>
                </div>
              ))}
            </div>
            <div className="lp-pain__divider">
              <div className="lp-pain__line" />
              <div className="lp-pain__vs">vs</div>
              <div className="lp-pain__line" />
            </div>
            <div className="lp-pain__solution">
              <CheckCircle2 size={22} className="lp-pain__check" />
              <p>
                <strong>LunchLineup builds the entire day plan together.</strong>{' '}
                Shifts, lunches, breaks, and coverage — placed in one step so nothing
                falls through the cracks.
              </p>
            </div>
          </div>
        </Reveal>
      </section>

      {/* ━━━ 4. How It Works ━━━ */}
      <section className="lp-section">
        <Reveal>
          <div className="lp-section__header">
            <span className="lp-kicker">How it works</span>
            <h2 className="lp-section__title">
              Three steps to a{' '}
              <span className="lp-gradient-text">finished schedule.</span>
            </h2>
            <p className="lp-section__subtitle">
              No spreadsheet formulas. No manual break placement. No guesswork.
            </p>
          </div>
        </Reveal>

        <div className="lp-steps">
          {HOW_IT_WORKS.map((s, i) => (
            <Reveal key={s.step} delay={i * 120}>
              <div className="lp-step">
                <div className="lp-step__number">{s.step}</div>
                <div className="lp-step__icon">
                  <s.Icon size={24} />
                </div>
                <h3 className="lp-step__title">{s.title}</h3>
                <p className="lp-step__body">{s.body}</p>
                {i < HOW_IT_WORKS.length - 1 && (
                  <div className="lp-step__connector" aria-hidden="true" />
                )}
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ━━━ 5. Features ━━━ */}
      <section className="lp-section">
        <Reveal>
          <div className="lp-section__header">
            <span className="lp-kicker">Capabilities</span>
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

      {/* ━━━ 6. Social Proof ━━━ */}
      <section className="lp-section">
        <Reveal>
          <div className="lp-section__header">
            <span className="lp-kicker">Trusted by teams</span>
            <h2 className="lp-section__title">
              Teams that stopped wrestling{' '}
              <span className="lp-gradient-text">spreadsheet schedules.</span>
            </h2>
          </div>
        </Reveal>

        <Reveal delay={80}>
          <div className="lp-logos">
            {LOGOS.map((name) => (
              <div key={name} className="lp-logos__item">{name}</div>
            ))}
          </div>
        </Reveal>

        <div className="lp-testimonials">
          {TESTIMONIALS.map((t, i) => (
            <Reveal key={t.name} delay={i * 100}>
              <div className="lp-testimonial">
                <div className="lp-testimonial__accent" />
                <blockquote className="lp-testimonial__quote">
                  &ldquo;{t.quote}&rdquo;
                </blockquote>
                <div className="lp-testimonial__attr">
                  <div className="lp-testimonial__avatar">{t.initials}</div>
                  <div>
                    <div className="lp-testimonial__name">{t.name}</div>
                    <div className="lp-testimonial__role">{t.role}</div>
                    <div className="lp-testimonial__company">{t.company}</div>
                    <div className="lp-testimonial__scale">{t.scale}</div>
                  </div>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ━━━ 7. Stats ━━━ */}
      <Reveal>
        <section className="lp-stats">
          <div className="lp-section__header" style={{ marginBottom: '2.5rem' }}>
            <span className="lp-kicker">Results</span>
            <h2 className="lp-section__title">
              Numbers that{' '}
              <span className="lp-gradient-text">speak for themselves.</span>
            </h2>
          </div>
          <div className="lp-stats__grid">
            {STATS.map((s) => (
              <div key={s.label} className="lp-stat-card" style={{ background: s.surface }}>
                <div className="lp-stat-card__head">
                  <div className="lp-stat-card__icon" style={{ color: s.accent }}>
                    <s.Icon size={18} />
                  </div>
                  <div className="lp-stat-card__bar">
                    <span style={{ width: '26%', background: s.accent }} />
                    <span style={{ width: '22%', background: s.accent, opacity: 0.4 }} />
                  </div>
                </div>
                <div className="lp-stat-card__value">{s.value}</div>
                <div className="lp-stat-card__label">{s.label}</div>
                <div className="lp-stat-card__sub">{s.sub}</div>
              </div>
            ))}
          </div>
        </section>
      </Reveal>

      {/* ━━━ 8. Use Cases ━━━ */}
      <section className="lp-section">
        <Reveal>
          <div className="lp-section__header">
            <span className="lp-kicker">Use cases</span>
            <h2 className="lp-section__title">
              Built for teams that run on{' '}
              <span className="lp-gradient-text">shifts.</span>
            </h2>
          </div>
        </Reveal>

        <div className="lp-usecases-layout">
          <Reveal delay={60}>
            <div className="lp-usecases-copy">
              <h3>One planner for service-heavy teams.</h3>
              <p>
                LunchLineup adapts to each operating model while keeping meal compliance
                and floor coverage visible in real time.
              </p>
            </div>
          </Reveal>

          <div className="lp-usecases">
            {USE_CASES.map((uc, i) => (
              <Reveal key={uc.title} delay={i * 100}>
                <div className="lp-usecase">
                  <div className="lp-usecase__icon">
                    <uc.Icon size={24} />
                  </div>
                  <h3 className="lp-usecase__title">{uc.title}</h3>
                  <p className="lp-usecase__body">{uc.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ━━━ 9. FAQ ━━━ */}
      <section className="lp-section">
        <Reveal>
          <div className="lp-section__header">
            <span className="lp-kicker">Common questions</span>
            <h2 className="lp-section__title">
              Everything you need to{' '}
              <span className="lp-gradient-text">know.</span>
            </h2>
          </div>
        </Reveal>

        <Reveal delay={80}>
          <div className="lp-faq">
            {FAQ_ITEMS.map((item) => (
              <FaqItem key={item.question} question={item.question} answer={item.answer} />
            ))}
          </div>
        </Reveal>
      </section>

      {/* ━━━ 10. Final CTA ━━━ */}
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
              Generate your first schedule in minutes — lunches and breaks included.
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
            <div className="lp-nav__icon" style={{ width: 28, height: 28 }}><LunchLineupMark size={28} /></div>
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
          display: grid;
          place-items: center;
          flex-shrink: 0;
        }
        .lp-nav__icon svg {
          width: 100%;
          height: 100%;
          filter: drop-shadow(0 6px 16px rgba(47, 99, 255, 0.35));
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
        .lp-hero__segment {
          font-size: 0.78rem;
          color: var(--text-secondary);
          margin-top: -0.25rem;
          font-weight: 640;
        }

        /* ── Stats ── */
        .lp-stats {
          position: relative;
          z-index: 1;
          max-width: 1200px;
          margin: 0 auto;
          padding: 0 1.5rem 6.5rem;
        }
        .lp-stats__grid {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 1rem;
        }
        .lp-stat-card {
          position: relative;
          border: 1px solid rgba(31, 42, 68, 0.08);
          border-radius: 20px;
          box-shadow: 0 16px 38px rgba(31, 42, 68, 0.08);
          padding: 1.25rem 1.2rem 1.35rem;
          overflow: hidden;
          transition: transform 0.35s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.35s cubic-bezier(0.16, 1, 0.3, 1);
          animation: stat-float 7s ease-in-out infinite;
        }
        .lp-stat-card:nth-child(2) { animation-delay: 0.5s; }
        .lp-stat-card:nth-child(3) { animation-delay: 1s; }
        .lp-stat-card:nth-child(4) { animation-delay: 1.5s; }
        .lp-stat-card:hover {
          transform: translateY(-6px);
          box-shadow: 0 24px 52px rgba(31, 42, 68, 0.13);
        }
        .lp-stat-card__head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 0.85rem;
        }
        .lp-stat-card__icon {
          width: 38px;
          height: 38px;
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.8);
          border: 1px solid rgba(31, 42, 68, 0.08);
          display: grid;
          place-items: center;
        }
        .lp-stat-card__bar {
          display: flex;
          align-items: center;
          gap: 0.3rem;
        }
        .lp-stat-card__bar span {
          display: inline-block;
          height: 5px;
          border-radius: 999px;
        }
        .lp-stat-card__value {
          font-size: 2.1rem;
          font-weight: 840;
          letter-spacing: -0.04em;
          line-height: 1;
          background: linear-gradient(135deg, #1d2d66, #3058e8);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }
        .lp-stat-card__label {
          font-size: 0.84rem;
          font-weight: 720;
          color: var(--text-secondary);
          margin-top: 0.2rem;
        }
        .lp-stat-card__sub {
          font-size: 0.72rem;
          color: var(--text-muted);
          margin-top: 0.2rem;
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
          max-width: 1080px;
          margin: 0 auto;
        }
        .lp-preview-glow {
          position: absolute; inset: 40px -20px -20px -20px;
          background: radial-gradient(ellipse at center, rgba(47, 99, 255, 0.12), transparent 70%);
          border-radius: 28px; filter: blur(46px);
          z-index: -1;
        }
        .lp-preview {
          position: relative;
          background: rgba(255, 255, 255, 0.88);
          border: 1px solid rgba(31, 42, 68, 0.09);
          border-radius: 24px;
          backdrop-filter: blur(14px);
          -webkit-backdrop-filter: blur(14px);
          box-shadow: 0 30px 74px rgba(31, 42, 68, 0.12),
                      0 1px 3px rgba(31, 42, 68, 0.05);
          overflow: hidden;
          transition: transform 0.45s cubic-bezier(0.16, 1, 0.3, 1),
                      box-shadow 0.45s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .lp-preview:hover {
          transform: translateY(-5px);
          box-shadow: 0 40px 92px rgba(31, 42, 68, 0.16),
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
        .lp-ui {
          display: grid;
          grid-template-columns: 160px 1fr;
          min-height: 460px;
        }
        .lp-ui__rail {
          border-right: 1px solid rgba(31, 42, 68, 0.08);
          background: linear-gradient(180deg, rgba(248, 250, 255, 0.86), rgba(243, 246, 255, 0.48));
          padding: 1.2rem 0.95rem;
          display: flex;
          flex-direction: column;
          gap: 0.6rem;
        }
        .lp-ui__pill {
          padding: 0.55rem 0.7rem;
          border-radius: 10px;
          font-size: 0.74rem;
          font-weight: 700;
          color: var(--text-muted);
          border: 1px solid transparent;
        }
        .lp-ui__pill--active {
          background: #edf3ff;
          border-color: #cddfff;
          color: #175cd3;
        }
        .lp-ui__main { padding: 1.15rem 1.2rem 1.25rem; }
        .lp-ui__toolbar {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 1rem;
          margin-bottom: 1rem;
        }
        .lp-ui__title {
          font-size: 0.95rem;
          font-weight: 760;
          color: var(--text-primary);
        }
        .lp-ui__meta {
          font-size: 0.74rem;
          color: var(--text-muted);
          margin-top: 2px;
        }
        .lp-ui__coverage {
          min-width: 160px;
          font-size: 0.72rem;
          color: var(--text-muted);
        }
        .lp-ui__coverage strong {
          display: block;
          margin-top: 0.15rem;
          font-size: 1rem;
          color: #0f8c52;
          letter-spacing: -0.02em;
        }
        .lp-ui__coverage-bar {
          margin-top: 0.35rem;
          height: 8px;
          border-radius: 999px;
          background: rgba(31, 42, 68, 0.08);
          overflow: hidden;
        }
        .lp-ui__coverage-fill {
          height: 100%;
          width: 84%;
          background: linear-gradient(90deg, #17b26a, #7ad99f);
        }
        .lp-ui__legend {
          display: flex;
          align-items: center;
          gap: 0.9rem;
          flex-wrap: wrap;
          margin: -0.15rem 0 0.75rem;
          font-size: 0.68rem;
          color: var(--text-muted);
          font-weight: 680;
        }
        .lp-ui__legend span {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
        }
        .lp-dot {
          width: 9px;
          height: 9px;
          border-radius: 999px;
          display: inline-block;
        }
        .lp-dot--shift { background: #7ea0ff; }
        .lp-dot--lunch { background: #6ac79a; }
        .lp-dot--break { background: #22b8cf; }
        .lp-ui__warning-badge {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          margin-bottom: 0.7rem;
          border: 1px solid #fecdca;
          background: #fff6ed;
          color: #b54708;
          border-radius: 999px;
          padding: 0.35rem 0.6rem;
          font-size: 0.69rem;
          font-weight: 760;
        }
        .lp-timeline {
          border: 1px solid rgba(31, 42, 68, 0.08);
          border-radius: 14px;
          overflow: hidden;
          background: #fff;
        }
        .lp-timeline__head {
          display: grid;
          grid-template-columns: repeat(6, 1fr);
          padding: 0.56rem 0.8rem 0.52rem 7rem;
          font-size: 0.66rem;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          font-weight: 700;
          color: var(--text-muted);
          border-bottom: 1px solid rgba(31, 42, 68, 0.08);
          background: rgba(249, 251, 255, 0.9);
        }
        .lp-lane {
          display: grid;
          grid-template-columns: 6.5rem 1fr;
          border-bottom: 1px solid rgba(31, 42, 68, 0.06);
        }
        .lp-lane:last-child { border-bottom: none; }
        .lp-lane__name {
          padding: 0.85rem 0.8rem;
          font-size: 0.76rem;
          font-weight: 720;
          color: var(--text-primary);
        }
        .lp-lane__grid {
          position: relative;
          min-height: 86px;
          background-image: linear-gradient(to right, rgba(31, 42, 68, 0.06) 1px, transparent 1px);
          background-size: calc(100% / 6) 100%;
          padding: 0.6rem 0.8rem;
        }
        .lp-shift-block {
          position: absolute;
          top: 0.9rem;
          left: 0.9rem;
          right: 0.9rem;
          height: 22px;
          border-radius: 8px;
          background: linear-gradient(90deg, rgba(47, 99, 255, 0.16), rgba(47, 99, 255, 0.08));
          color: #2452d1;
          font-size: 0.66rem;
          font-weight: 700;
          display: flex;
          align-items: center;
          padding-left: 0.5rem;
        }
        .lp-break-block {
          position: absolute;
          top: 1.05rem;
          left: 52%;
          transform: translateX(-50%);
          height: 24px;
          border-radius: 8px;
          border: 1px solid #cfdcff;
          background: #eef3ff;
          color: #1d49be;
          font-size: 0.65rem;
          font-weight: 760;
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          padding: 0 0.52rem;
          box-shadow: 0 5px 14px rgba(47, 99, 255, 0.18);
        }
        .lp-break-block--lunch {
          border-color: #b9ebcf;
          background: #ecfdf3;
          color: #11715f;
          box-shadow: 0 5px 14px rgba(23, 178, 106, 0.16);
        }
        .lp-break-block--break {
          top: 2.65rem;
          border-color: #b8e6ec;
          background: #ebfcff;
          color: #12708a;
          box-shadow: 0 5px 14px rgba(34, 184, 207, 0.16);
        }
        .lp-break-block--drag {
          cursor: grab;
          animation: drag-hint 2.6s ease-in-out infinite;
        }
        .lp-break-block--rest {
          left: 72%;
          transform: translateX(-50%);
        }
        .lp-break-block--rest-2 {
          left: 62%;
          transform: translateX(-50%);
        }
        .lp-break-block--rest-3 {
          left: 76%;
          transform: translateX(-50%);
        }
        .lp-break-block--warn {
          left: 68%;
          border-color: #fecdca;
          background: #fff6ed;
          color: #b54708;
          box-shadow: 0 5px 14px rgba(243, 124, 32, 0.18);
          animation: none;
        }
        .lp-ui__alerts {
          margin-top: 0.85rem;
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 0.55rem;
        }
        .lp-alert {
          border-radius: 10px;
          border: 1px solid rgba(31, 42, 68, 0.08);
          background: rgba(248, 250, 255, 0.85);
          padding: 0.55rem 0.65rem;
          font-size: 0.72rem;
          color: var(--text-secondary);
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          font-weight: 680;
        }
        .lp-alert--warn {
          border-color: #fecdca;
          background: #fff6ed;
          color: #b54708;
        }
        @keyframes drag-hint {
          0%, 100% { transform: translateX(-50%); }
          50% { transform: translateX(-40%); }
        }

        /* ── Pain statement ── */
        .lp-pain {
          max-width: 680px;
          margin: 0 auto;
          background: rgba(255, 255, 255, 0.68);
          border: 1px solid rgba(31, 42, 68, 0.07);
          border-radius: 24px;
          padding: 2.8rem 3rem;
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          box-shadow: 0 18px 44px rgba(31, 42, 68, 0.06);
        }
        .lp-pain__list {
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }
        .lp-pain__intro {
          font-size: 0.96rem;
          color: var(--text-secondary);
          line-height: 1.55;
          margin-bottom: 1.25rem;
        }
        .lp-pain__item {
          display: flex;
          align-items: center;
          gap: 0.85rem;
          font-size: 0.95rem;
          color: var(--text-secondary);
          font-weight: 550;
        }
        .lp-pain__icon {
          width: 36px;
          height: 36px;
          border-radius: 10px;
          background: rgba(231, 72, 103, 0.08);
          color: #e74867;
          display: grid;
          place-items: center;
          flex-shrink: 0;
        }
        .lp-pain__divider {
          display: flex;
          align-items: center;
          gap: 1rem;
          margin: 2rem 0;
        }
        .lp-pain__line {
          flex: 1;
          height: 1px;
          background: linear-gradient(90deg, transparent, rgba(31, 42, 68, 0.1), transparent);
        }
        .lp-pain__vs {
          font-size: 0.72rem;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          font-weight: 760;
          color: var(--text-muted);
        }
        .lp-pain__solution {
          display: flex;
          align-items: flex-start;
          gap: 0.85rem;
          padding: 1.2rem 1.4rem;
          background: rgba(23, 178, 106, 0.06);
          border: 1px solid rgba(23, 178, 106, 0.15);
          border-radius: 14px;
        }
        .lp-pain__check {
          color: #17b26a;
          flex-shrink: 0;
          margin-top: 1px;
        }
        .lp-pain__solution p {
          font-size: 0.92rem;
          line-height: 1.55;
          color: var(--text-secondary);
        }
        .lp-pain__solution strong {
          color: var(--text-primary);
          font-weight: 720;
        }

        /* ── How it works ── */
        .lp-steps {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 1.5rem;
          max-width: 960px;
          margin: 0 auto;
          position: relative;
        }
        .lp-step {
          position: relative;
          background: rgba(255, 255, 255, 0.68);
          border: 1px solid rgba(31, 42, 68, 0.07);
          border-radius: 20px;
          padding: 2rem 1.8rem 2.2rem;
          text-align: center;
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          transition: all 0.38s cubic-bezier(0.16, 1, 0.3, 1);
          cursor: default;
        }
        .lp-step:hover {
          border-color: rgba(47, 99, 255, 0.18);
          box-shadow: 0 22px 52px rgba(31, 42, 68, 0.1);
          transform: translateY(-4px);
        }
        .lp-step__number {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          border-radius: 999px;
          background: linear-gradient(135deg, #4171ff, #2f63ff);
          color: #fff;
          font-size: 0.82rem;
          font-weight: 800;
          margin-bottom: 1rem;
        }
        .lp-step__icon {
          width: 52px;
          height: 52px;
          border-radius: 14px;
          background: rgba(47, 99, 255, 0.08);
          color: var(--brand);
          display: grid;
          place-items: center;
          margin: 0 auto 1rem;
        }
        .lp-step__title {
          font-size: 1.08rem;
          font-weight: 780;
          letter-spacing: -0.02em;
          color: var(--text-primary);
          margin-bottom: 0.4rem;
        }
        .lp-step__body {
          font-size: 0.88rem;
          color: var(--text-secondary);
          line-height: 1.55;
        }
        .lp-step__connector {
          display: none;
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

        /* ── Social proof: Logos ── */
        .lp-logos {
          display: flex;
          justify-content: center;
          align-items: center;
          gap: 2.5rem;
          flex-wrap: wrap;
          margin-bottom: 3.5rem;
          padding: 1.8rem 2rem;
          background: rgba(255, 255, 255, 0.5);
          border: 1px solid rgba(31, 42, 68, 0.06);
          border-radius: 16px;
          max-width: 780px;
          margin-left: auto;
          margin-right: auto;
        }
        .lp-logos__item {
          font-size: 0.92rem;
          font-weight: 780;
          letter-spacing: -0.01em;
          color: var(--text-muted);
          opacity: 0.6;
          transition: opacity 0.3s;
          cursor: default;
        }
        .lp-logos__item:hover { opacity: 1; }

        /* ── Social proof: Testimonials ── */
        .lp-testimonials {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 1.3rem;
        }
        .lp-testimonial {
          position: relative;
          background: rgba(255, 255, 255, 0.68);
          border: 1px solid rgba(31, 42, 68, 0.07);
          border-radius: 20px;
          padding: 2rem 2rem 1.8rem;
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          box-shadow: 0 12px 32px rgba(31, 42, 68, 0.05);
          overflow: hidden;
          transition: all 0.38s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .lp-testimonial:hover {
          transform: translateY(-3px);
          box-shadow: 0 20px 48px rgba(31, 42, 68, 0.09);
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
          font-size: 0.95rem;
          line-height: 1.5;
          letter-spacing: -0.005em;
          color: var(--text-primary);
          font-weight: 500;
          font-style: italic;
        }
        .lp-testimonial__attr {
          display: flex;
          align-items: center;
          gap: 0.7rem;
          margin-top: 1.2rem;
        }
        .lp-testimonial__avatar {
          width: 38px;
          height: 38px;
          border-radius: 50%;
          background: linear-gradient(135deg, #4171ff, #22b8cf);
          color: #fff;
          display: grid;
          place-items: center;
          font-size: 0.72rem;
          font-weight: 760;
          flex-shrink: 0;
        }
        .lp-testimonial__name {
          font-size: 0.84rem;
          font-weight: 730;
          color: var(--text-primary);
        }
        .lp-testimonial__role {
          font-size: 0.72rem;
          color: var(--text-muted);
        }
        .lp-testimonial__company {
          font-size: 0.72rem;
          color: var(--text-secondary);
          font-weight: 690;
        }
        .lp-testimonial__scale {
          font-size: 0.7rem;
          color: var(--text-muted);
        }

        /* ── Use cases ── */
        .lp-usecases-layout {
          display: grid;
          grid-template-columns: 0.9fr 1.1fr;
          gap: 1.2rem;
          align-items: start;
        }
        .lp-usecases-copy {
          background: rgba(255, 255, 255, 0.65);
          border: 1px solid rgba(31, 42, 68, 0.08);
          border-radius: 20px;
          padding: 1.6rem 1.5rem;
          box-shadow: 0 14px 32px rgba(31, 42, 68, 0.06);
        }
        .lp-usecases-copy h3 {
          font-size: 1.2rem;
          font-weight: 790;
          letter-spacing: -0.02em;
          color: var(--text-primary);
          margin-bottom: 0.45rem;
        }
        .lp-usecases-copy p {
          font-size: 0.9rem;
          color: var(--text-secondary);
          line-height: 1.6;
        }
        .lp-usecases {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 1.3rem;
        }
        .lp-usecase {
          background: rgba(255, 255, 255, 0.68);
          border: 1px solid rgba(31, 42, 68, 0.07);
          border-radius: 20px;
          padding: 2rem 1.8rem 2.2rem;
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          transition: all 0.38s cubic-bezier(0.16, 1, 0.3, 1);
          cursor: default;
        }
        .lp-usecase:hover {
          border-color: rgba(47, 99, 255, 0.18);
          box-shadow: 0 22px 52px rgba(31, 42, 68, 0.1);
          transform: translateY(-4px);
        }
        .lp-usecases > div:nth-child(2) .lp-usecase { transform: translateY(14px); }
        .lp-usecases > div:nth-child(2) .lp-usecase:hover { transform: translateY(8px); }
        .lp-usecase__icon {
          width: 50px;
          height: 50px;
          border-radius: 14px;
          background: rgba(47, 99, 255, 0.08);
          color: var(--brand);
          display: grid;
          place-items: center;
          margin-bottom: 1.1rem;
          transition: transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        @keyframes stat-float {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-3px); }
        }
        .lp-usecase:hover .lp-usecase__icon {
          transform: scale(1.1) rotate(-2deg);
        }
        .lp-usecase__title {
          font-size: 1.08rem;
          font-weight: 780;
          letter-spacing: -0.02em;
          color: var(--text-primary);
          margin-bottom: 0.4rem;
        }
        .lp-usecase__body {
          font-size: 0.88rem;
          color: var(--text-secondary);
          line-height: 1.55;
        }

        /* ── FAQ ── */
        .lp-faq {
          max-width: 720px;
          margin: 0 auto;
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
        }
        .lp-faq__item {
          background: rgba(255, 255, 255, 0.68);
          border: 1px solid rgba(31, 42, 68, 0.07);
          border-radius: 16px;
          overflow: hidden;
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          transition: border-color 0.3s, box-shadow 0.3s;
        }
        .lp-faq__item:hover {
          border-color: rgba(47, 99, 255, 0.14);
        }
        .lp-faq__item--open {
          border-color: rgba(47, 99, 255, 0.18);
          box-shadow: 0 8px 24px rgba(31, 42, 68, 0.06);
        }
        .lp-faq__trigger {
          display: flex;
          align-items: center;
          justify-content: space-between;
          width: 100%;
          padding: 1.15rem 1.5rem;
          background: none;
          border: none;
          cursor: pointer;
          font-size: 0.95rem;
          font-weight: 700;
          color: var(--text-primary);
          text-align: left;
          gap: 1rem;
        }
        .lp-faq__trigger:hover {
          color: var(--brand);
        }
        .lp-faq__chevron {
          color: var(--text-muted);
          transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
          flex-shrink: 0;
        }
        .lp-faq__item--open .lp-faq__chevron {
          transform: rotate(180deg);
        }
        .lp-faq__answer {
          max-height: 0;
          overflow: hidden;
          transition: max-height 0.4s cubic-bezier(0.16, 1, 0.3, 1),
                      padding 0.4s cubic-bezier(0.16, 1, 0.3, 1);
          padding: 0 1.5rem;
        }
        .lp-faq__item--open .lp-faq__answer {
          max-height: 300px;
          padding: 0 1.5rem 1.25rem;
        }
        .lp-faq__answer p {
          font-size: 0.9rem;
          color: var(--text-secondary);
          line-height: 1.6;
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
          .lp-stats__grid { grid-template-columns: repeat(2, 1fr); }
          .lp-features { grid-template-columns: 1fr; }
          .lp-steps { grid-template-columns: 1fr; max-width: 480px; }
          .lp-testimonials { grid-template-columns: 1fr; }
          .lp-usecases-layout { grid-template-columns: 1fr; }
          .lp-usecases { grid-template-columns: 1fr; }
          .lp-usecases > div:nth-child(2) .lp-usecase,
          .lp-usecases > div:nth-child(2) .lp-usecase:hover { transform: none; }
          .lp-ui {
            grid-template-columns: 1fr;
          }
          .lp-ui__rail {
            border-right: none;
            border-bottom: 1px solid rgba(31, 42, 68, 0.08);
            flex-direction: row;
            overflow-x: auto;
          }
          .lp-lane {
            grid-template-columns: 1fr;
          }
          .lp-lane__name {
            padding-bottom: 0.2rem;
          }
          .lp-timeline__head {
            padding-left: 0.8rem;
          }
          .lp-ui__alerts {
            grid-template-columns: 1fr;
          }
          .lp-pain { padding: 2.2rem 2rem; }
          .lp-cta { padding: 3.5rem 1.5rem; }
          .lp-section { padding-bottom: 5rem; }
        }

        @media (max-width: 640px) {
          .lp-hero__title {
            font-size: clamp(2.2rem, 10vw, 3.4rem);
          }
          .lp-stats__grid { grid-template-columns: 1fr 1fr; }
          .lp-hero__actions {
            flex-direction: column;
            width: 100%;
          }
          .lp-hero__actions .btn {
            width: 100%;
            justify-content: center;
          }
          .lp-ui__toolbar {
            flex-direction: column;
          }
          .lp-pain { padding: 1.8rem 1.4rem; }
          .lp-logos { gap: 1.5rem; padding: 1.4rem 1.2rem; }
          .lp-footer__inner {
            flex-direction: column;
            gap: 0.8rem;
            text-align: center;
          }
        }

        @media (max-width: 420px) {
          .lp-stats__grid { grid-template-columns: 1fr; }
        }
      `}</style>
    </div>
  );
}
