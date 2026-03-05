'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';

const FEATURES = [
  {
    icon: '⚡',
    title: 'AI-Powered Scheduling',
    desc: 'Constraint-based optimization fills your roster automatically, respecting availability, labor law, and shift preferences.',
  },
  {
    icon: '🖱️',
    title: 'Drag & Drop Editor',
    desc: 'Real-time collaborative grid. Move shifts between days and staff with instant sync across your entire team.',
  },
  {
    icon: '⚖️',
    title: 'Compliance & Breaks',
    desc: 'Automatic break rules, overtime tracking, and labor law enforcement — configured once, applied everywhere.',
  },
  {
    icon: '🔔',
    title: 'Live Notifications',
    desc: 'Staff gets notified the moment their schedule changes. No more refresh cycles or missed shift updates.',
  },
  {
    icon: '📊',
    title: 'Insights & Reporting',
    desc: 'Track labor costs, coverage gaps, and fairness scores. Export to payroll in one click.',
  },
  {
    icon: '🏢',
    title: 'Multi-Location',
    desc: 'Manage unlimited locations from a single dashboard. Tenant-isolated data with enterprise-grade security.',
  },
];

const STATS = [
  { value: '98%', label: 'Schedule accuracy', sub: 'on first publish' },
  { value: '4×', label: 'Faster to build', sub: 'vs. spreadsheets' },
  { value: '< 30s', label: 'Auto-schedule', sub: 'for a full week' },
  { value: '100%', label: 'Coverage guaranteed', sub: 'via solver engine' },
];

const SOCIAL_PROOF = [
  {
    quote: 'We reduced scheduling time from 3 hours to 10 minutes. Our managers actually look forward to Monday mornings now.',
    author: 'Sarah K.',
    role: 'Ops Director, QuickBite Group',
    initials: 'SK',
  },
  {
    quote: 'The compliance engine alone saved us from three potential labor violations. It paid for itself in the first week.',
    author: 'Marcus T.',
    role: 'GM, Harbor View Restaurants',
    initials: 'MT',
  },
  {
    quote: 'Finally a tool that speaks our language — shift managers, not HR consultants. Incredibly intuitive.',
    author: 'Priya N.',
    role: 'Team Lead, FreshCo Markets',
    initials: 'PN',
  },
];

export default function HomePage() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', onScroll);
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div style={{ minHeight: '100vh', overflowX: 'hidden' }}>
      {/* ── Nav ── */}
      <nav style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 100,
        padding: '0 2rem',
        height: '64px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: scrolled ? 'rgba(10, 15, 30, 0.9)' : 'transparent',
        backdropFilter: scrolled ? 'blur(20px)' : 'none',
        borderBottom: scrolled ? '1px solid rgba(255,255,255,0.06)' : '1px solid transparent',
        transition: 'all 350ms cubic-bezier(0.16, 1, 0.3, 1)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8,
            background: 'linear-gradient(135deg, #5c7cfa, #748ffc)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '1rem',
          }}>🍱</div>
          <span style={{ fontWeight: 700, fontSize: '1.125rem', color: '#f1f5f9', letterSpacing: '-0.01em' }}>
            LunchLineup
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Link href="/api/v1/auth/login" className="btn btn-ghost btn-sm">
            Sign In
          </Link>
          <Link href="/onboarding" className="btn btn-primary btn-sm">
            Get Started Free
          </Link>
        </div>
      </nav>

      {/* ── Hero Section ── */}
      <section style={{
        position: 'relative',
        minHeight: '100vh',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        padding: '6rem 2rem 4rem',
        textAlign: 'center',
        overflow: 'hidden',
      }}>
        {/* Background orbs */}
        <div style={{
          position: 'absolute', top: '10%', left: '15%',
          width: 500, height: 500, borderRadius: '50%',
          background: 'radial-gradient(circle at center, rgba(92, 124, 250, 0.15), transparent 70%)',
          animation: 'float-slow 12s ease-in-out infinite',
          pointerEvents: 'none',
        }} />
        <div style={{
          position: 'absolute', bottom: '15%', right: '10%',
          width: 400, height: 400, borderRadius: '50%',
          background: 'radial-gradient(circle at center, rgba(16, 185, 129, 0.1), transparent 70%)',
          animation: 'float-med 10s ease-in-out infinite',
          pointerEvents: 'none',
        }} />
        <div style={{
          position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
          width: 800, height: 800, borderRadius: '50%',
          background: 'radial-gradient(circle at center, rgba(92, 124, 250, 0.05), transparent 65%)',
          pointerEvents: 'none',
        }} />

        {/* Badge */}
        <div className="animate-fade-up badge badge-brand" style={{ marginBottom: '1.5rem', fontSize: '0.8125rem' }}>
          <span>✨</span> Now in open beta — free for your first team
        </div>

        {/* Headline */}
        <h1 className="animate-fade-up delay-100" style={{
          fontSize: 'clamp(2.5rem, 6vw, 4.5rem)',
          fontWeight: 900,
          lineHeight: 1.05,
          letterSpacing: '-0.03em',
          maxWidth: 800,
          marginBottom: '1.5rem',
        }}>
          <span className="gradient-text">Scheduling software</span>
          <br />
          <span style={{ color: 'var(--text-primary)' }}>your entire team will</span>
          <br />
          <span style={{
            background: 'linear-gradient(135deg, var(--emerald), #6ee7b7)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}>actually love.</span>
        </h1>

        {/* Subheading */}
        <p className="animate-fade-up delay-200" style={{
          fontSize: 'clamp(1rem, 2vw, 1.25rem)',
          color: 'var(--text-secondary)',
          maxWidth: 580,
          lineHeight: 1.65,
          marginBottom: '2.5rem',
        }}>
          AI-powered shift optimization, real-time collaboration, and automated compliance —
          all in one platform built for modern food & hospitality teams.
        </p>

        {/* CTAs */}
        <div className="animate-fade-up delay-300" style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', justifyContent: 'center', marginBottom: '1.5rem' }}>
          <Link href="/onboarding" className="btn btn-primary btn-lg">
            Start scheduling free
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </Link>
          <Link href="/api/v1/auth/login" className="btn btn-secondary btn-lg">
            Sign in to your account
          </Link>
        </div>

        {/* Social proof micro-line */}
        <p className="animate-fade-up delay-400" style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
          Join 200+ teams publishing smarter schedules. No credit card required.
        </p>

        {/* Fake UI preview card */}
        <div className="animate-scale-in delay-500" style={{ marginTop: '4rem', width: '100%', maxWidth: 900 }}>
          <div style={{
            background: 'linear-gradient(180deg, rgba(15,22,41,0.9) 0%, rgba(10,15,30,0.6) 100%)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 20,
            overflow: 'hidden',
            boxShadow: '0 32px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(92,124,250,0.1)',
          }}>
            {/* Window chrome */}
            <div style={{
              padding: '12px 16px',
              background: 'rgba(255,255,255,0.03)',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              {['#ff5f57', '#ffbb2c', '#28c840'].map((c, i) => (
                <div key={i} style={{ width: 12, height: 12, borderRadius: '50%', background: c }} />
              ))}
              <div style={{
                flex: 1, textAlign: 'center',
                fontFamily: 'var(--font-mono)', fontSize: '0.75rem',
                color: 'var(--text-muted)',
              }}>lunchlineup.app/dashboard/scheduling</div>
            </div>
            {/* Mini scheduling grid preview */}
            <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: 8, minHeight: 200 }}>
              {/* Header row */}
              <div style={{ display: 'grid', gridTemplateColumns: '100px repeat(7, 1fr)', gap: 6 }}>
                <div />
                {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => (
                  <div key={d} style={{ textAlign: 'center', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', padding: '4px 0' }}>{d}</div>
                ))}
              </div>
              {/* Staff rows */}
              {[
                { name: 'Alex R.', shifts: [1, 1, 0, 1, 1, 0, 0], color: '#5c7cfa' },
                { name: 'Jordan M.', shifts: [0, 1, 1, 1, 0, 1, 0], color: '#10b981' },
                { name: 'Casey L.', shifts: [1, 0, 1, 0, 1, 1, 0], color: '#f59e0b' },
                { name: 'Riley P.', shifts: [0, 0, 1, 1, 1, 0, 1], color: '#8b5cf6' },
              ].map((row, ri) => (
                <div key={ri} style={{ display: 'grid', gridTemplateColumns: '100px repeat(7, 1fr)', gap: 6, alignItems: 'center' }}>
                  <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', fontWeight: 500 }}>{row.name}</div>
                  {row.shifts.map((s, di) => (
                    <div key={di} style={{
                      height: 32, borderRadius: 6,
                      background: s ? `${row.color}22` : 'rgba(255,255,255,0.03)',
                      border: s ? `1px solid ${row.color}44` : '1px solid rgba(255,255,255,0.05)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '0.6875rem', color: s ? row.color : 'transparent',
                      fontWeight: 600,
                      transition: 'all 200ms',
                    }}>
                      {s ? '9–5' : ''}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── Stats ── */}
      <section style={{ padding: '4rem 2rem', borderTop: '1px solid rgba(255,255,255,0.04)' }}>
        <div style={{ maxWidth: 900, margin: '0 auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '2rem', textAlign: 'center' }}>
          {STATS.map((s, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontSize: 'clamp(2rem, 4vw, 3rem)', fontWeight: 900, letterSpacing: '-0.03em', color: 'var(--brand-bright)' }}>{s.value}</div>
              <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.9375rem' }}>{s.label}</div>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.8125rem' }}>{s.sub}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Features ── */}
      <section style={{ padding: '6rem 2rem' }}>
        <div style={{ maxWidth: 1000, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: '4rem' }}>
            <div className="badge badge-brand" style={{ marginBottom: '1rem' }}>Features</div>
            <h2 style={{ fontSize: 'clamp(1.75rem, 4vw, 2.75rem)', fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--text-primary)', marginBottom: '1rem' }}>
              Everything your team needs to<br /><span className="gradient-text-brand">schedule with confidence.</span>
            </h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '1.0625rem', maxWidth: 520, margin: '0 auto' }}>
              One platform. No spreadsheets. No confusion. Just clean, compliant schedules your whole team trusts.
            </p>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem' }}>
            {FEATURES.map((f, i) => (
              <div key={i} className="glass-card" style={{ cursor: 'default' }}>
                <div style={{
                  width: 48, height: 48, borderRadius: 12,
                  background: 'rgba(92, 124, 250, 0.12)',
                  border: '1px solid rgba(92, 124, 250, 0.2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '1.5rem', marginBottom: '1.25rem',
                }}>{f.icon}</div>
                <h3 style={{ fontWeight: 700, fontSize: '1.0625rem', color: 'var(--text-primary)', marginBottom: '0.5rem' }}>{f.title}</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.6 }}>{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Social Proof ── */}
      <section style={{ padding: '6rem 2rem', background: 'rgba(255,255,255,0.01)', borderTop: '1px solid rgba(255,255,255,0.04)', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
        <div style={{ maxWidth: 1000, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: '3rem' }}>
            <div className="badge badge-emerald" style={{ marginBottom: '1rem' }}>Customer stories</div>
            <h2 style={{ fontSize: 'clamp(1.5rem, 3vw, 2.25rem)', fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
              Teams that switched, never looked back.
            </h2>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem' }}>
            {SOCIAL_PROOF.map((t, i) => (
              <div key={i} style={{
                background: 'var(--bg-glass)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius-xl)', padding: '1.75rem',
                transition: 'all 250ms var(--ease-out)',
                cursor: 'default',
              }}>
                <div style={{ fontSize: '1.375rem', color: 'var(--brand-bright)', marginBottom: '1rem', lineHeight: 1 }}>❝</div>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.9375rem', lineHeight: 1.65, marginBottom: '1.25rem' }}>
                  {t.quote}
                </p>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: '50%',
                    background: 'linear-gradient(135deg, var(--brand), var(--emerald))',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '0.75rem', fontWeight: 700, color: 'white', flexShrink: 0,
                  }}>{t.initials}</div>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--text-primary)' }}>{t.author}</div>
                    <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>{t.role}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA Banner ── */}
      <section style={{ padding: '6rem 2rem', textAlign: 'center' }}>
        <div style={{ maxWidth: 600, margin: '0 auto' }}>
          <div style={{
            background: 'linear-gradient(135deg, rgba(92, 124, 250, 0.1), rgba(16, 185, 129, 0.05))',
            border: '1px solid rgba(92, 124, 250, 0.2)',
            borderRadius: 24, padding: '3.5rem 2.5rem',
            position: 'relative', overflow: 'hidden',
          }}>
            <div style={{
              position: 'absolute', top: -60, right: -60,
              width: 240, height: 240, borderRadius: '50%',
              background: 'radial-gradient(circle, rgba(92,124,250,0.15), transparent 70%)',
            }} />
            <h2 style={{ fontSize: 'clamp(1.75rem, 4vw, 2.25rem)', fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--text-primary)', marginBottom: '1rem' }}>
              Ready to simplify scheduling?
            </h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '1.0625rem', marginBottom: '2rem', lineHeight: 1.6 }}>
              Set up your workspace in under 2 minutes. Free forever for small teams.
            </p>
            <Link href="/onboarding" className="btn btn-primary btn-lg">
              Create free account
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </Link>
            <p style={{ marginTop: '1rem', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
              No credit card · No setup fees · Cancel anytime
            </p>
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer style={{
        padding: '2rem',
        borderTop: '1px solid rgba(255,255,255,0.04)',
        display: 'flex', flexWrap: 'wrap',
        justifyContent: 'space-between', alignItems: 'center', gap: '1rem',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <div style={{ width: 24, height: 24, borderRadius: 6, background: 'linear-gradient(135deg, #5c7cfa, #748ffc)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem' }}>🍱</div>
          <span style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text-secondary)' }}>LunchLineup</span>
        </div>
        <nav style={{ display: 'flex', gap: '1.5rem' }}>
          {[['Privacy', '/privacy'], ['Docs', '/docs'], ['Status', '/status']].map(([label, href]) => (
            <Link key={href} href={href} style={{ color: 'var(--text-muted)', fontSize: '0.875rem', transition: 'color 150ms' }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text-secondary)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
            >{label}</Link>
          ))}
        </nav>
        <span style={{ color: 'var(--text-muted)', fontSize: '0.8125rem' }}>
          © {new Date().getFullYear()} LunchLineup, Inc.
        </span>
      </footer>
    </div>
  );
}
