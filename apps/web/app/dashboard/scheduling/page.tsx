'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { Button } from '@/components/ui/button';

// FullCalendar must be dynamically imported (no SSR) due to DOM dependencies
const StaffScheduler = dynamic(
  () => import('@/components/scheduling/StaffScheduler').then(m => m.StaffScheduler),
  {
    ssr: false, loading: () => (
      <div style={{
        height: 500, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--bg-glass)', borderRadius: 14, border: '1px solid var(--border)',
        color: 'var(--text-muted)', fontSize: '0.875rem', gap: '0.5rem',
      }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1s linear infinite' }}>
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
        Loading calendar…
      </div>
    )
  }
);

// ── Demo data ─────────────────────────────────────────────────────────────────

const TODAY = new Date();
const WEEK_START = new Date(TODAY);
WEEK_START.setDate(TODAY.getDate() - ((TODAY.getDay() + 6) % 7)); // Monday

const wd = (offsetDays: number, h: number, m = 0) => {
  const d = new Date(WEEK_START);
  d.setDate(d.getDate() + offsetDays);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

const RESOURCES = [
  { id: 'r1', title: 'Alice J.', role: 'MANAGER', avatarInitials: 'AJ', hue: 220 },
  { id: 'r2', title: 'Bob T.', role: 'CASHIER', avatarInitials: 'BT', hue: 160 },
  { id: 'r3', title: 'Casey L.', role: 'FLOOR', avatarInitials: 'CL', hue: 40 },
  { id: 'r4', title: 'Riley P.', role: 'SERVER', avatarInitials: 'RP', hue: 270 },
  { id: 'r5', title: 'Jordan M.', role: 'KITCHEN', avatarInitials: 'JM', hue: 340 },
];

const EVENTS = [
  // Alice – Manager
  { id: 'e1', resourceId: 'r1', title: 'Manager', start: wd(0, 9), end: wd(0, 17), extendedProps: { role: 'MANAGER' } },
  { id: 'e2', resourceId: 'r1', title: 'Manager', start: wd(1, 9), end: wd(1, 17), extendedProps: { role: 'MANAGER' } },
  { id: 'e3', resourceId: 'r1', title: 'Manager', start: wd(3, 9), end: wd(3, 17), extendedProps: { role: 'MANAGER' } },
  { id: 'e4', resourceId: 'r1', title: 'Manager', start: wd(4, 9), end: wd(4, 17), extendedProps: { role: 'MANAGER' } },
  // Bob – Cashier
  { id: 'e5', resourceId: 'r2', title: 'Cashier', start: wd(0, 10), end: wd(0, 18), extendedProps: { role: 'CASHIER' } },
  { id: 'e6', resourceId: 'r2', title: 'Cashier', start: wd(2, 10), end: wd(2, 18), extendedProps: { role: 'CASHIER' } },
  { id: 'e7', resourceId: 'r2', title: 'Cashier', start: wd(4, 10), end: wd(4, 15), extendedProps: { role: 'CASHIER' } },
  // Casey – Floor
  { id: 'e8', resourceId: 'r3', title: 'Floor', start: wd(0, 12), end: wd(0, 20), extendedProps: { role: 'FLOOR' } },
  { id: 'e9', resourceId: 'r3', title: 'Floor', start: wd(1, 12), end: wd(1, 20), extendedProps: { role: 'FLOOR' } },
  { id: 'e10', resourceId: 'r3', title: 'Floor', start: wd(5, 11), end: wd(5, 19), extendedProps: { role: 'FLOOR' } },
  // Riley – Server
  { id: 'e11', resourceId: 'r4', title: 'Server', start: wd(2, 9), end: wd(2, 17), extendedProps: { role: 'SERVER' } },
  { id: 'e12', resourceId: 'r4', title: 'Server', start: wd(4, 9), end: wd(4, 17), extendedProps: { role: 'SERVER' } },
  { id: 'e13', resourceId: 'r4', title: 'Server', start: wd(6, 10), end: wd(6, 16), extendedProps: { role: 'SERVER' } },
  // Jordan – Kitchen
  { id: 'e14', resourceId: 'r5', title: 'Kitchen', start: wd(0, 14), end: wd(0, 22), extendedProps: { role: 'KITCHEN' } },
  { id: 'e15', resourceId: 'r5', title: 'Kitchen', start: wd(2, 14), end: wd(2, 22), extendedProps: { role: 'KITCHEN' } },
  { id: 'e16', resourceId: 'r5', title: 'Kitchen', start: wd(5, 14), end: wd(5, 22), extendedProps: { role: 'KITCHEN' } },
];

const ROLE_COLORS: Record<string, string> = {
  MANAGER: '#5c7cfa', CASHIER: '#10b981', FLOOR: '#f59e0b',
  SERVER: '#8b5cf6', KITCHEN: '#f43f5e',
};

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SchedulingPage() {
  const [isAutoScheduling, setIsAutoScheduling] = useState(false);
  const [published, setPublished] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [activeFilter, setActiveFilter] = useState<string | null>(null);

  const handleAutoSchedule = async () => {
    setIsAutoScheduling(true);
    await new Promise(r => setTimeout(r, 2000));
    setIsAutoScheduling(false);
  };

  const handlePublish = async () => {
    setIsPublishing(true);
    await new Promise(r => setTimeout(r, 1200));
    setIsPublishing(false);
    setPublished(true);
  };

  const weekLabel = WEEK_START.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const weekEnd = new Date(WEEK_START);
  weekEnd.setDate(WEEK_START.getDate() + 6);
  const weekEndLabel = weekEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className="flex flex-col gap-4 h-full">
      {/* ── Header row ── */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-[var(--text-primary)]">
            Schedule Builder
          </h1>
          <p className="text-sm text-[var(--text-muted)] mt-0.5">
            Downtown Bistro · {weekLabel} — {weekEndLabel}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Role filter chips */}
          <div className="flex items-center gap-1.5 mr-2">
            {Object.entries(ROLE_COLORS).map(([role, color]) => (
              <button
                key={role}
                onClick={() => setActiveFilter(f => f === role ? null : role)}
                className="flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[0.6875rem] font-semibold transition-all duration-150 border"
                style={{
                  background: activeFilter === role ? `${color}25` : 'rgba(255,255,255,0.04)',
                  borderColor: activeFilter === role ? `${color}60` : 'rgba(255,255,255,0.08)',
                  color: activeFilter === role ? color : 'var(--text-muted)',
                }}
              >
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, display: 'inline-block' }} />
                {role}
              </button>
            ))}
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={handleAutoSchedule}
            disabled={isAutoScheduling}
            className="gap-1.5"
          >
            {isAutoScheduling ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1s linear infinite' }}>
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            ) : '🤖'}
            {isAutoScheduling ? 'Optimizing…' : 'Auto-Schedule'}
          </Button>

          <Button
            variant={published ? 'success' : 'default'}
            size="sm"
            onClick={handlePublish}
            disabled={isPublishing || published}
            className="gap-1.5"
          >
            {isPublishing ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1s linear infinite' }}>
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            ) : published ? '✓' : '📢'}
            {isPublishing ? 'Publishing…' : published ? 'Published' : 'Publish'}
          </Button>
        </div>
      </div>

      {/* ── FullCalendar ── */}
      <div className="rounded-xl border border-[var(--border)] overflow-hidden flex-1" style={{ minHeight: 500, background: 'var(--bg-elevated)' }}>
        <StaffScheduler
          resources={RESOURCES}
          events={EVENTS}
          initialDate={WEEK_START.toISOString().split('T')[0]}
          onEventChange={(id, start, end, resourceId) => {
            console.log('Shift moved:', { id, start, end, resourceId });
            // TODO: optimistic UI update + debounced API call
          }}
        />
      </div>

      <style>{`
                @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
            `}</style>
    </div>
  );
}
