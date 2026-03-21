'use client';

import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { Button } from '@/components/ui/button';
import {
  CalendarDays,
  Download,
  Plus,
  Settings2,
  Sparkles,
  Upload,
  WandSparkles,
} from 'lucide-react';
import type { SchedulerViewMode, StaffScheduleEvent } from '@/components/scheduling/StaffScheduler';

const StaffScheduler = dynamic(
  () => import('@/components/scheduling/StaffScheduler').then((m) => m.StaffScheduler),
  {
    ssr: false,
    loading: () => (
      <div className="surface-card" style={{ minHeight: 520, padding: '1rem' }}>
        <div className="skeleton" style={{ height: 24, width: 180, marginBottom: '1rem' }} />
        <div className="skeleton" style={{ height: 420, width: '100%' }} />
      </div>
    ),
  },
);

const TODAY = new Date();
const WEEK_START = new Date(TODAY);
WEEK_START.setDate(TODAY.getDate() - ((TODAY.getDay() + 6) % 7));

const RESOURCES = [
  { id: 'r1', title: 'Alice J.', role: 'MANAGER', avatarInitials: 'AJ', hue: 220 },
  { id: 'r2', title: 'Bob T.', role: 'CASHIER', avatarInitials: 'BT', hue: 160 },
  { id: 'r3', title: 'Casey L.', role: 'FLOOR', avatarInitials: 'CL', hue: 40 },
  { id: 'r4', title: 'Riley P.', role: 'SERVER', avatarInitials: 'RP', hue: 270 },
  { id: 'r5', title: 'Jordan M.', role: 'KITCHEN', avatarInitials: 'JM', hue: 340 },
];

const wd = (offsetDays: number, h: number, m = 0) => {
  const d = new Date(WEEK_START);
  d.setDate(d.getDate() + offsetDays);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

const EVENTS: StaffScheduleEvent[] = [
  { id: 'e1', resourceId: 'r1', title: 'Manager', start: wd(0, 9), end: wd(0, 17), extendedProps: { role: 'MANAGER' } },
  { id: 'e2', resourceId: 'r1', title: 'Manager', start: wd(1, 9), end: wd(1, 17), extendedProps: { role: 'MANAGER' } },
  { id: 'e3', resourceId: 'r2', title: 'Cashier', start: wd(0, 10), end: wd(0, 18), extendedProps: { role: 'CASHIER' } },
  { id: 'e4', resourceId: 'r2', title: 'Cashier', start: wd(2, 10), end: wd(2, 18), extendedProps: { role: 'CASHIER' } },
  { id: 'e5', resourceId: 'r3', title: 'Floor', start: wd(0, 12), end: wd(0, 20), extendedProps: { role: 'FLOOR' } },
  { id: 'e6', resourceId: 'r3', title: 'Floor', start: wd(1, 12), end: wd(1, 20), extendedProps: { role: 'FLOOR' } },
  { id: 'e7', resourceId: 'r4', title: 'Server', start: wd(2, 9), end: wd(2, 17), extendedProps: { role: 'SERVER' } },
  { id: 'e8', resourceId: 'r4', title: 'Server', start: wd(4, 9), end: wd(4, 17), extendedProps: { role: 'SERVER' } },
  { id: 'e9', resourceId: 'r5', title: 'Kitchen', start: wd(0, 14), end: wd(0, 22), extendedProps: { role: 'KITCHEN' } },
  { id: 'e10', resourceId: 'r5', title: 'Kitchen', start: wd(2, 14), end: wd(2, 22), extendedProps: { role: 'KITCHEN' } },
];

type GeneratedAssignment = {
  shiftId: string;
  staffName: string;
  role: string;
  lunch: string;
  breaks: string[];
  risk: 'healthy' | 'watch';
};

function fmtTime(dateIso: string) {
  return new Date(dateIso).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function toDateInputValue(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function generateAssignments(events: StaffScheduleEvent[]): GeneratedAssignment[] {
  return events
    .filter((event) => !event.extendedProps.kind)
    .map((event) => {
      const start = new Date(event.start);
      const end = new Date(event.end);
      const durationMins = Math.max(60, Math.floor((end.getTime() - start.getTime()) / 60000));

      const lunchStart = new Date(start.getTime() + Math.floor(durationMins * 0.5) * 60000);
      const breakOne = new Date(start.getTime() + Math.floor(durationMins * 0.3) * 60000);
      const breakTwo = new Date(start.getTime() + Math.floor(durationMins * 0.74) * 60000);

      const staff = RESOURCES.find((resource) => resource.id === event.resourceId);
      const risk = durationMins > 480 && lunchStart.getHours() >= 16 ? 'watch' : 'healthy';

      return {
        shiftId: event.id,
        staffName: staff?.title ?? 'Unknown',
        role: event.extendedProps.role,
        lunch: `${fmtTime(lunchStart.toISOString())}-${fmtTime(new Date(lunchStart.getTime() + 30 * 60000).toISOString())}`,
        breaks: [
          `${fmtTime(breakOne.toISOString())}-${fmtTime(new Date(breakOne.getTime() + 15 * 60000).toISOString())}`,
          `${fmtTime(breakTwo.toISOString())}-${fmtTime(new Date(breakTwo.getTime() + 15 * 60000).toISOString())}`,
        ],
        risk,
      };
    });
}

export default function SchedulingPage() {
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [viewMode, setViewMode] = useState<SchedulerViewMode>('threeDay');
  const [selectedDate, setSelectedDate] = useState(toDateInputValue(TODAY));
  const [scheduleEvents, setScheduleEvents] = useState<StaffScheduleEvent[]>(EVENTS);
  const [generated, setGenerated] = useState<GeneratedAssignment[]>([]);

  const dateLabel = useMemo(
    () => new Date(`${selectedDate}T00:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }),
    [selectedDate],
  );

  const shiftsForDate = useMemo(() => {
    return scheduleEvents.filter((event) => {
      const day = new Date(event.start).toISOString().slice(0, 10);
      return day === selectedDate && !event.extendedProps.kind;
    });
  }, [scheduleEvents, selectedDate]);

  const runGenerate = async () => {
    setIsSaved(false);
    setIsGenerating(true);
    await new Promise((resolve) => setTimeout(resolve, 700));
    setGenerated(generateAssignments(shiftsForDate));
    setIsGenerating(false);
  };

  const handleSave = async () => {
    setIsSaving(true);
    await new Promise((resolve) => setTimeout(resolve, 650));
    setIsSaving(false);
    setIsSaved(true);
  };

  return (
    <>
      <div className="scheduler-page">
        <section className="scheduler-topbar surface-card">
          <div className="scheduler-topbar__left">
            <span className="workspace-kicker">Schedule workspace</span>
            <h1 className="workspace-title">Scheduler</h1>
            <p className="workspace-subtitle">{dateLabel}</p>
          </div>

          <div className="scheduler-topbar__controls">
            <label className="scheduler-day-picker">
              <CalendarDays size={15} />
              <input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} />
            </label>

            <div className="scheduler-view-toggle" role="group" aria-label="Scheduler view">
              {(['day', 'threeDay', 'week'] as SchedulerViewMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={viewMode === mode ? 'active' : ''}
                  onClick={() => setViewMode(mode)}
                >
                  {mode === 'threeDay' ? '3-Day' : mode === 'day' ? 'Day' : 'Week'}
                </button>
              ))}
            </div>

            <Button onClick={runGenerate} disabled={isGenerating}>
              {isGenerating ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" style={{ animation: 'spin 1s linear infinite' }}>
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  Generating...
                </>
              ) : (
                <>
                  <WandSparkles size={15} />
                  Generate breaks
                </>
              )}
            </Button>

            <Button variant="secondary" onClick={handleSave} disabled={isSaving || generated.length === 0}>
              {isSaving ? 'Saving...' : isSaved ? 'Saved' : 'Save changes'}
            </Button>

            <Button variant="ghost" size="icon" aria-label="Advanced settings" onClick={() => setShowAdvanced((value) => !value)}>
              <Settings2 size={16} />
            </Button>
          </div>
        </section>

        {showAdvanced ? (
          <section className="scheduler-advanced surface-card" aria-label="Advanced settings panel">
            <p><strong>Advanced</strong> settings are hidden by default to keep the main workflow focused.</p>
            <div className="scheduler-advanced__actions">
              <Button variant="outline" size="sm"><Upload size={14} /> Import template</Button>
              <Button variant="outline" size="sm"><Download size={14} /> Export policy</Button>
            </div>
          </section>
        ) : null}

        <section className="scheduler-panels">
          <article className="surface-card scheduler-panel">
            <header>
              <h2>Shift inputs</h2>
              <p>Add, import, or edit shifts before generation.</p>
            </header>
            {shiftsForDate.length === 0 ? (
              <div className="scheduler-empty">
                <h3>No shifts yet</h3>
                <p>Add shifts for this day, then generate lunch and break coverage.</p>
                <div>
                  <Button size="sm"><Plus size={14} /> Add shift</Button>
                  <Button size="sm" variant="outline"><Upload size={14} /> Import shifts</Button>
                </div>
              </div>
            ) : (
              <div className="scheduler-table-wrap">
                <table className="scheduler-table">
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th>Role</th>
                      <th>Shift</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shiftsForDate.map((shift) => {
                      const resource = RESOURCES.find((item) => item.id === shift.resourceId);
                      return (
                        <tr key={shift.id}>
                          <td>{resource?.title ?? 'Unknown'}</td>
                          <td>{shift.extendedProps.role}</td>
                          <td>{fmtTime(shift.start)} - {fmtTime(shift.end)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </article>

          <article className="surface-card scheduler-panel">
            <header>
              <h2>Generated break assignments</h2>
              <p>Review before saving.</p>
            </header>

            {isGenerating ? (
              <div className="scheduler-loading" aria-label="Loading generated assignments">
                <div className="skeleton" style={{ height: 48 }} />
                <div className="skeleton" style={{ height: 48 }} />
                <div className="skeleton" style={{ height: 48 }} />
              </div>
            ) : generated.length === 0 ? (
              <div className="scheduler-empty">
                <h3>Ready to build breaks</h3>
                <p>Generate assignments to populate the break grid.</p>
                <div>
                  <Button size="sm" onClick={runGenerate}><Sparkles size={14} /> Generate breaks</Button>
                </div>
              </div>
            ) : (
              <ul className="assignment-list" aria-label="Generated assignments">
                {generated.map((assignment, index) => (
                  <li key={assignment.shiftId} className="assignment-item" style={{ animationDelay: `${index * 20}ms` }}>
                    <div>
                      <strong>{assignment.staffName}</strong>
                      <small>{assignment.role}</small>
                    </div>
                    <div className="assignment-chips">
                      <span className="badge badge-info">Lunch {assignment.lunch}</span>
                      <span className="badge badge-info">Break {assignment.breaks[0]}</span>
                      <span className="badge badge-info">Break {assignment.breaks[1]}</span>
                      <span className={assignment.risk === 'watch' ? 'badge badge-warn' : 'badge badge-success'}>
                        {assignment.risk === 'watch' ? 'Watch window' : 'Healthy'}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </article>
        </section>

        <section className="surface-card scheduler-timeline-panel">
          <header>
            <h2>Timeline review</h2>
            <p>Drag shifts between staff and days. Generated assignments remain suggestions until you save.</p>
          </header>
          <div className="scheduler-timeline-shell">
            <StaffScheduler
              resources={RESOURCES}
              events={scheduleEvents}
              viewMode={viewMode}
              initialDate={selectedDate}
              onEventChange={(id, start, end, resourceId) => {
                setScheduleEvents((previous) =>
                  previous.map((event) => (event.id === id ? { ...event, start, end, resourceId } : event)),
                );
              }}
            />
          </div>
        </section>
      </div>

      <style jsx>{`
        .scheduler-page {
          min-height: 100%;
          display: grid;
          gap: 16px;
        }

        .scheduler-topbar {
          padding: 20px 24px;
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 16px;
          flex-wrap: wrap;
        }

        .scheduler-topbar__left p {
          margin-top: 4px;
        }

        .scheduler-topbar__controls {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
          justify-content: flex-end;
        }

        .scheduler-day-picker {
          height: 40px;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          border-radius: var(--r-md);
          border: 1px solid var(--border);
          background: var(--surface);
          padding: 0 12px;
          color: var(--text-muted);
        }

        .scheduler-day-picker input {
          border: 0;
          background: transparent;
          color: var(--text);
        }

        .scheduler-view-toggle {
          display: inline-flex;
          border-radius: var(--r-pill);
          overflow: hidden;
          border: 1px solid var(--border);
          background: var(--surface-soft);
        }

        .scheduler-view-toggle button {
          border: 0;
          background: transparent;
          color: var(--text-muted);
          font-size: 12px;
          font-weight: 700;
          height: 32px;
          padding: 0 10px;
          cursor: pointer;
        }

        .scheduler-view-toggle button.active {
          background: #e0e7ff;
          color: var(--brand-800);
        }

        .scheduler-advanced {
          padding: 16px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          flex-wrap: wrap;
        }

        .scheduler-advanced p {
          margin: 0;
          font-size: 14px;
          color: var(--text-muted);
        }

        .scheduler-advanced__actions {
          display: inline-flex;
          gap: 8px;
        }

        .scheduler-panels {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 16px;
        }

        .scheduler-panel {
          padding: 24px;
          min-height: 360px;
        }

        .scheduler-panel header h2,
        .scheduler-timeline-panel header h2 {
          margin: 0;
          font-size: 20px;
          line-height: 1.3;
        }

        .scheduler-panel header p,
        .scheduler-timeline-panel header p {
          margin: 6px 0 0;
          font-size: 14px;
          color: var(--text-muted);
        }

        .scheduler-empty,
        .scheduler-loading {
          margin-top: 16px;
          min-height: 210px;
          border: 1px dashed var(--border-strong);
          border-radius: var(--r-md);
          background: var(--surface-soft);
          display: grid;
          place-items: center;
          padding: 20px;
          text-align: center;
          gap: 10px;
        }

        .scheduler-empty h3 {
          margin: 0;
          font-size: 20px;
        }

        .scheduler-empty p {
          margin: 0;
          color: var(--text-muted);
          font-size: 14px;
          max-width: 44ch;
        }

        .scheduler-empty div {
          display: inline-flex;
          gap: 8px;
          flex-wrap: wrap;
          justify-content: center;
        }

        .scheduler-loading {
          padding: 20px;
          display: grid;
          gap: 10px;
          place-items: stretch;
        }

        .scheduler-table-wrap {
          margin-top: 16px;
          overflow: auto;
          border: 1px solid var(--border);
          border-radius: var(--r-md);
        }

        .scheduler-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 14px;
        }

        .scheduler-table thead th {
          text-align: left;
          height: 52px;
          padding: 0 12px;
          font-weight: 700;
          color: var(--text-muted);
          background: var(--surface-soft);
          border-bottom: 1px solid var(--border);
          position: sticky;
          top: 0;
        }

        .scheduler-table tbody td {
          height: 48px;
          padding: 0 12px;
          border-top: 1px solid #f1f5f9;
        }

        .scheduler-table tbody tr:hover {
          background: rgba(79, 70, 229, 0.06);
        }

        .assignment-list {
          margin-top: 16px;
          list-style: none;
          padding: 0;
          display: grid;
          gap: 10px;
        }

        .assignment-item {
          border: 1px solid var(--border);
          background: var(--surface-soft);
          border-radius: var(--r-md);
          padding: 12px;
          display: grid;
          gap: 8px;
          opacity: 0;
          transform: scale(0.98);
          animation: assignment-in 180ms var(--ease-decelerate) forwards;
        }

        .assignment-item strong {
          display: block;
        }

        .assignment-item small {
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--text-soft);
        }

        .assignment-chips {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }

        .scheduler-timeline-panel {
          padding: 24px;
        }

        .scheduler-timeline-shell {
          margin-top: 16px;
          min-height: 520px;
        }

        @keyframes assignment-in {
          from { opacity: 0; transform: scale(0.98); }
          to { opacity: 1; transform: scale(1); }
        }

        @media (max-width: 1200px) {
          .scheduler-panels {
            grid-template-columns: 1fr;
          }
        }

        @media (max-width: 768px) {
          .scheduler-panel,
          .scheduler-timeline-panel,
          .scheduler-topbar {
            padding: 16px;
          }

          .scheduler-day-picker {
            width: 100%;
          }

          .scheduler-topbar__controls {
            width: 100%;
            justify-content: flex-start;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .assignment-item {
            animation: none;
            opacity: 1;
            transform: none;
          }
        }
      `}</style>
    </>
  );
}
