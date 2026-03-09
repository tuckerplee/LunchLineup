'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CalendarDays, Clock3, MapPin, Users } from 'lucide-react';
import { LunchLineupMark } from '@/components/branding/LunchLineupMark';

const STAT_CARDS = [
  {
    label: 'Active staff',
    value: '42',
    delta: '+12% vs last week',
    tone: '#2f63ff',
    bg: 'linear-gradient(145deg, #edf3ff, #f7f9ff)',
    icon: Users,
  },
  {
    label: "This week's coverage",
    value: '92%',
    delta: '6 uncovered hours remaining',
    tone: '#17b26a',
    bg: 'linear-gradient(145deg, #e9fbf1, #f7fffb)',
    icon: CalendarDays,
  },
  {
    label: 'Break compliance',
    value: '98%',
    delta: '2 meal windows at risk',
    tone: '#f59e0b',
    bg: 'linear-gradient(145deg, #fff6e7, #fffaf1)',
    icon: Clock3,
  },
  {
    label: 'Locations online',
    value: '2',
    delta: 'All systems healthy',
    tone: '#22b8cf',
    bg: 'linear-gradient(145deg, #e9fafe, #f6fdff)',
    icon: MapPin,
  },
];

const ACTIVITY_ITEMS = [
  {
    category: 'Staffing',
    title: 'Shift accepted',
    detail: 'Alice J. accepted Monday manager shift',
    time: '2m ago',
    tone: 'var(--emerald)',
  },
  {
    category: 'Publish',
    title: 'Schedule published',
    detail: 'Week of Mar 9 published',
    time: '14m ago',
    tone: 'var(--brand)',
  },
  {
    category: 'Swap',
    title: 'Swap requested',
    detail: 'Bob T. requested Friday 9am-5pm swap',
    time: '1h ago',
    tone: 'var(--amber)',
  },
  {
    category: 'Breaks',
    title: 'Lunch plan generated',
    detail: 'Dinner team stagger created',
    time: '3h ago',
    tone: 'var(--cyan)',
  },
  {
    category: 'Coverage',
    title: 'Coverage updated',
    detail: 'Auto-scheduler reached 98% coverage',
    time: 'Yesterday',
    tone: 'var(--emerald)',
  },
];

const QUICK_ACTIONS = [
  {
    label: 'Build Weekly Schedule',
    desc: 'Assign and optimize shifts in one workspace',
    icon: '📅',
    href: '/dashboard/scheduling',
    tier: 'primary' as const,
  },
  {
    label: 'Generate Lunch Plan',
    desc: 'Auto-stagger breaks with policy controls',
    icon: <LunchLineupMark size={20} />,
    href: '/dashboard/lunch-breaks',
    tier: 'primary' as const,
  },
  {
    label: 'Invite a Team Member',
    desc: 'Add staff and assign roles instantly',
    icon: '👋',
    href: '/dashboard/staff',
    tier: 'secondary' as const,
  },
  {
    label: 'Add New Location',
    desc: 'Extend scheduling to another storefront',
    icon: '🏢',
    href: '/dashboard/locations',
    tier: 'secondary' as const,
  },
];

const COVERAGE_RISK_DAYS = [
  { day: 'Mon', status: 'Fully covered', tone: 'healthy' as const },
  { day: 'Tue', status: 'Fully covered', tone: 'healthy' as const },
  { day: 'Wed', status: 'Lunch coverage risk', tone: 'risk' as const },
  { day: 'Thu', status: 'Fully covered', tone: 'healthy' as const },
  { day: 'Fri', status: '1 open shift', tone: 'risk' as const },
  { day: 'Sat', status: 'Dinner understaffed', tone: 'attention' as const },
  { day: 'Sun', status: 'Low coverage', tone: 'attention' as const },
];

export default function DashboardPage() {
  const [todayLabel, setTodayLabel] = useState('Today');

  useEffect(() => {
    setTodayLabel(
      new Date().toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      }),
    );
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: 1420 }}>
      <section
        className="surface-card animate-fade-up"
        style={{
          padding: '1.6rem',
          background:
            'radial-gradient(35rem 18rem at 0% 0%, rgba(79,121,255,0.16), transparent 60%), radial-gradient(28rem 14rem at 100% 100%, rgba(34,184,207,0.14), transparent 60%), #ffffff',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
          <div style={{ maxWidth: 720, display: 'grid', gap: '0.32rem' }}>
            <h1 className="workspace-title" style={{ marginBottom: '0.35rem' }}>
              Welcome back, Alex
            </h1>
            <p className="workspace-subtitle">
              {todayLabel} · Downtown Bistro
            </p>
            <p style={{ color: 'var(--text-primary)', fontSize: '0.95rem', fontWeight: 650 }}>
              3 open shifts need assignment. Lunch coverage is healthy today.
            </p>
          </div>

          <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
            <Link href="/dashboard/scheduling?focus=open" className="btn btn-primary">
              Assign Open Shifts
            </Link>
            <Link href="/dashboard/scheduling" className="btn btn-secondary">
              Build Weekly Schedule
            </Link>
          </div>
        </div>
      </section>

      <section>
        <article
          className="surface-card animate-slide-up"
          style={{
            padding: '1rem 1.1rem',
            border: '1px solid #ffd0da',
            background: 'linear-gradient(145deg, #fff1f4, #fff8fa)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ display: 'grid', gap: '0.2rem' }}>
              <h2 style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--text-primary)' }}>Open shift coverage</h2>
              <p style={{ fontSize: '0.88rem', color: '#b8324a', fontWeight: 700 }}>3 shifts need assignment before Monday</p>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>2 are dinner coverage · 1 is manager coverage</p>
            </div>
            <div style={{ display: 'flex', gap: '0.55rem', flexWrap: 'wrap' }}>
              <Link href="/dashboard/scheduling?focus=open" className="btn btn-primary">
                Assign now
              </Link>
              <Link href="/dashboard/scheduling" className="btn btn-secondary">
                View schedule
              </Link>
            </div>
          </div>
        </article>
      </section>

      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '0.9rem',
        }}
      >
        {STAT_CARDS.map((card) => {
          const Icon = card.icon;
          return (
            <article key={card.label} className="surface-card animate-slide-up" style={{ padding: '1rem', background: card.bg }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.55rem' }}>
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', fontWeight: 600 }}>{card.label}</span>
                <span
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 12,
                    display: 'grid',
                    placeItems: 'center',
                    color: card.tone,
                    background: '#ffffff',
                    border: '1px solid rgba(0,0,0,0.05)',
                  }}
                >
                  <Icon size={16} />
                </span>
              </div>
              <div style={{ fontSize: '1.85rem', fontWeight: 800, letterSpacing: '-0.03em', color: 'var(--text-primary)' }}>
                {card.value}
              </div>
              <div style={{ fontSize: '0.78rem', color: card.tone, fontWeight: 700 }}>{card.delta}</div>
            </article>
          );
        })}
      </section>

      <section>
        <article
          className="surface-card"
          style={{
            padding: '1rem 1.1rem',
            background:
              'radial-gradient(22rem 11rem at 0% 0%, rgba(106, 199, 154, 0.14), transparent 70%), radial-gradient(20rem 10rem at 100% 100%, rgba(34, 184, 207, 0.1), transparent 70%), #ffffff',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ display: 'grid', gap: '0.2rem' }}>
              <h2 style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--text-primary)' }}>Today&apos;s break status</h2>
              <div style={{ display: 'grid', gap: '0.15rem', fontSize: '0.82rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                <p>14 lunches scheduled</p>
                <p>9 breaks staggered</p>
                <p style={{ color: '#b55f00' }}>1 meal window risk</p>
                <p style={{ color: '#148f56' }}>Coverage remains above minimum</p>
              </div>
            </div>
            <Link href="/dashboard/lunch-breaks" className="btn btn-secondary">
              Open Lunch Plan
            </Link>
          </div>
        </article>
      </section>

      <section>
        <article className="surface-card" style={{ padding: '1.2rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h2 style={{ fontSize: '1rem', fontWeight: 750, color: 'var(--text-primary)' }}>Coverage this week</h2>
            <Link href="/dashboard/scheduling" className="text-sm text-brand" style={{ fontWeight: 700 }}>
              Open scheduler
            </Link>
          </div>

          <div style={{ display: 'grid', gap: '0.52rem' }}>
            {COVERAGE_RISK_DAYS.map((d) => {
              const tone =
                d.tone === 'healthy'
                  ? { chip: '#e9fbf1', dot: '#17b26a', text: '#148f56' }
                  : d.tone === 'risk'
                    ? { chip: '#fff6e7', dot: '#f59e0b', text: '#9a6400' }
                    : { chip: '#ffeef2', dot: '#e74867', text: '#b8334d' };

              return (
                <div key={d.day} className="surface-muted" style={{ padding: '0.58rem 0.68rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
                    <span style={{ fontSize: '0.8rem', fontWeight: 800, color: 'var(--text-primary)', minWidth: 32 }}>{d.day}</span>
                    <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {d.status}
                    </span>
                  </div>
                  <span
                    style={{
                      background: tone.chip,
                      color: tone.text,
                      borderRadius: 999,
                      padding: '0.2rem 0.48rem',
                      fontSize: '0.68rem',
                      fontWeight: 800,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.28rem',
                      flexShrink: 0,
                    }}
                  >
                    <span style={{ width: 7, height: 7, borderRadius: 999, background: tone.dot, display: 'inline-block' }} />
                    {d.tone === 'healthy' ? 'Healthy' : d.tone === 'risk' ? 'At risk' : 'Needs attention'}
                  </span>
                </div>
              );
            })}
          </div>
        </article>
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.85rem' }}>
        <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '0.85rem' }}>
          {QUICK_ACTIONS.filter((action) => action.tier === 'primary').map((action) => (
            <Link
              key={action.label}
              href={action.href}
              className="surface-card"
              style={{
                padding: '1.15rem',
                display: 'flex',
                gap: '0.85rem',
                background:
                  'radial-gradient(16rem 10rem at 0% 0%, rgba(79,121,255,0.12), transparent 70%), #ffffff',
              }}
            >
              <span
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 13,
                  border: '1px solid #cfe0ff',
                  background: '#edf3ff',
                  display: 'grid',
                  placeItems: 'center',
                  fontSize: '1.2rem',
                  flexShrink: 0,
                }}
              >
                {action.icon}
              </span>
              <div>
                <div style={{ fontSize: '0.98rem', fontWeight: 750, color: 'var(--text-primary)' }}>{action.label}</div>
                <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{action.desc}</div>
              </div>
            </Link>
          ))}
        </div>

        <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem' }}>
          {QUICK_ACTIONS.filter((action) => action.tier === 'secondary').map((action) => (
            <Link key={action.label} href={action.href} className="surface-card" style={{ padding: '0.85rem', display: 'flex', gap: '0.68rem' }}>
              <span
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 11,
                  border: '1px solid var(--border)',
                  background: 'var(--bg-soft)',
                  display: 'grid',
                  placeItems: 'center',
                  fontSize: '1rem',
                  flexShrink: 0,
                }}
              >
                {action.icon}
              </span>
              <div>
                <div style={{ fontSize: '0.86rem', fontWeight: 700, color: 'var(--text-primary)' }}>{action.label}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{action.desc}</div>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section>
        <article className="surface-card" style={{ padding: '1.2rem' }}>
          <h2 style={{ fontSize: '1rem', fontWeight: 750, color: 'var(--text-primary)', marginBottom: '1rem' }}>
            Recent changes
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
            {ACTIVITY_ITEMS.map((item) => (
              <div key={`${item.title}-${item.time}`} style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start' }}>
                <span className="status-dot" style={{ marginTop: 7, background: item.tone }} />
                <div>
                  <div style={{ display: 'flex', gap: '0.42rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: 2 }}>
                    <span
                      style={{
                        borderRadius: 999,
                        padding: '0.08rem 0.4rem',
                        fontSize: '0.65rem',
                        fontWeight: 700,
                        color: item.tone,
                        background: 'rgba(47, 99, 255, 0.09)',
                        border: '1px solid var(--border)',
                      }}
                    >
                      {item.category}
                    </span>
                    <p style={{ fontSize: '0.81rem', color: 'var(--text-primary)', fontWeight: 700, lineHeight: 1.35 }}>
                      {item.title}
                    </p>
                  </div>
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>{item.detail}</p>
                  <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>{item.time}</span>
                </div>
              </div>
            ))}
          </div>
        </article>
      </section>
    </div>
  );
}
