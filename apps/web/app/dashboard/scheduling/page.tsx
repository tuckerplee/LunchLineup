'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { Button } from '@/components/ui/button';
import { CalendarDays, Download, Plus, RefreshCw, Settings2, Sparkles, Upload, WandSparkles } from 'lucide-react';
import { fetchJsonWithSession, fetchWithSession } from '@/lib/client-api';
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

type StaffRole = 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF';
type StaffRosterItem = { id: string; name: string; role: StaffRole };
type LocationItem = { id: string; name: string };
type BreakItem = { startTime: string; endTime: string; paid: boolean };
type ShiftRecord = {
  id: string;
  userId: string | null;
  locationId: string;
  startTime: string;
  endTime: string;
  role: string | null;
  user?: { id: string; name: string; role: StaffRole } | null;
  breaks?: BreakItem[];
};
type GeneratedAssignment = {
  shiftId: string;
  staffName: string;
  role: string;
  lunch: string;
  breaks: string[];
  risk: 'healthy' | 'watch';
};

const UNASSIGNED_RESOURCE_ID = 'unassigned';
const TODAY = new Date();

function getCsrfTokenFromCookie(): string {
  if (typeof document === 'undefined') return '';
  const pair = document.cookie.split('; ').find((entry) => entry.startsWith('csrf_token='));
  return pair ? decodeURIComponent(pair.split('=')[1] ?? '') : '';
}

function jsonWriteInit(method: 'POST' | 'PUT', payload: unknown): RequestInit {
  const csrfToken = getCsrfTokenFromCookie();
  return {
    method,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
    },
    body: JSON.stringify(payload),
  };
}

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

function dayRange(dateValue: string) {
  const start = new Date(`${dateValue}T00:00:00`);
  const end = new Date(start);
  end.setDate(start.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

function shiftRange(dateValue: string, startHour: number, endHour: number) {
  const start = new Date(`${dateValue}T00:00:00`);
  start.setHours(startHour, 0, 0, 0);
  const end = new Date(`${dateValue}T00:00:00`);
  end.setHours(endHour, 0, 0, 0);
  return { startTime: start.toISOString(), endTime: end.toISOString() };
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  if (parts.length === 0) return 'LL';
  return parts.map((part) => part[0]?.toUpperCase() ?? '').join('');
}

function hueForName(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 360;
}

function normalizeRole(role: string | null | undefined): string {
  if (!role) return 'STAFF';
  return role.toUpperCase();
}

function shiftToEvent(shift: ShiftRecord): StaffScheduleEvent {
  return {
    id: shift.id,
    resourceId: shift.userId ?? UNASSIGNED_RESOURCE_ID,
    title: normalizeRole(shift.role ?? shift.user?.role),
    start: shift.startTime,
    end: shift.endTime,
    extendedProps: { role: normalizeRole(shift.role ?? shift.user?.role) },
  };
}

function breakToEvents(shift: ShiftRecord): StaffScheduleEvent[] {
  return (shift.breaks ?? []).map((item, index) => ({
    id: `${shift.id}-break-${index}`,
    resourceId: shift.userId ?? UNASSIGNED_RESOURCE_ID,
    title: item.paid ? 'Break' : 'Lunch',
    start: item.startTime,
    end: item.endTime,
    extendedProps: {
      role: item.paid ? 'BREAK' : 'LUNCH',
      kind: item.paid ? 'break' : 'lunch',
    },
  }));
}

function shiftsToEvents(shifts: ShiftRecord[]): StaffScheduleEvent[] {
  return shifts.flatMap((shift) => [shiftToEvent(shift), ...breakToEvents(shift)]);
}

function assignmentFromShift(shift: ShiftRecord): GeneratedAssignment {
  const paid = (shift.breaks ?? []).filter((item) => item.paid);
  const unpaid = (shift.breaks ?? []).filter((item) => !item.paid);
  const durationMins = Math.max(60, Math.floor((new Date(shift.endTime).getTime() - new Date(shift.startTime).getTime()) / 60000));
  const lunch = unpaid[0];
  return {
    shiftId: shift.id,
    staffName: shift.user?.name ?? 'Open shift',
    role: normalizeRole(shift.role ?? shift.user?.role),
    lunch: lunch ? `${fmtTime(lunch.startTime)}-${fmtTime(lunch.endTime)}` : 'Unassigned',
    breaks: paid.map((item) => `${fmtTime(item.startTime)}-${fmtTime(item.endTime)}`),
    risk: durationMins > 480 && (!lunch || new Date(lunch.startTime).getHours() >= 16) ? 'watch' : 'healthy',
  };
}

export default function SchedulingPage() {
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [viewMode, setViewMode] = useState<SchedulerViewMode>('threeDay');
  const [selectedDate, setSelectedDate] = useState(toDateInputValue(TODAY));
  const [staff, setStaff] = useState<StaffRosterItem[]>([]);
  const [locations, setLocations] = useState<LocationItem[]>([]);
  const [shifts, setShifts] = useState<ShiftRecord[]>([]);
  const [generated, setGenerated] = useState<GeneratedAssignment[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadSchedule = useCallback(async (dateValue: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const range = dayRange(dateValue);
      const [staffPayload, locationsPayload, shiftsPayload] = await Promise.all([
        fetchJsonWithSession<{ data: StaffRosterItem[] }>('/shifts/staff-roster'),
        fetchJsonWithSession<{ data: LocationItem[] }>('/locations'),
        fetchJsonWithSession<{ data: ShiftRecord[] }>(`/shifts?startDate=${encodeURIComponent(range.start)}&endDate=${encodeURIComponent(range.end)}`),
      ]);
      setStaff(staffPayload.data ?? []);
      setLocations(locationsPayload.data ?? []);
      setShifts(shiftsPayload.data ?? []);
      setGenerated((shiftsPayload.data ?? []).filter((shift) => (shift.breaks ?? []).length > 0).map(assignmentFromShift));
    } catch (err) {
      setError((err as Error).message);
      setStaff([]);
      setLocations([]);
      setShifts([]);
      setGenerated([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSchedule(selectedDate);
  }, [loadSchedule, selectedDate]);

  const resources = useMemo(() => {
    const staffResources = staff.map((person) => ({
      id: person.id,
      title: person.name || 'Unnamed',
      role: person.role,
      avatarInitials: getInitials(person.name),
      hue: hueForName(person.id || person.name),
    }));
    return [
      ...staffResources,
      { id: UNASSIGNED_RESOURCE_ID, title: 'Open Shifts', role: 'UNASSIGNED', avatarInitials: 'OS', hue: 210 },
    ];
  }, [staff]);

  const scheduleEvents = useMemo(() => shiftsToEvents(shifts), [shifts]);

  const dateLabel = useMemo(
    () => new Date(`${selectedDate}T00:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }),
    [selectedDate],
  );

  const addShift = async () => {
    setIsSaved(false);
    setError(null);
    const locationId = locations[0]?.id;
    if (!locationId) {
      setError('Add a location before creating schedule shifts.');
      return;
    }

    const firstStaff = staff[0];
    const range = shiftRange(selectedDate, 9, 17);
    try {
      const created = await fetchJsonWithSession<ShiftRecord>('/shifts', {
        ...jsonWriteInit('POST', {
          locationId,
          userId: firstStaff?.id,
          role: firstStaff?.role ?? 'STAFF',
          ...range,
        }),
      });
      setShifts((current) => [...current, created]);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const runGenerate = async () => {
    setIsSaved(false);
    setIsGenerating(true);
    setError(null);
    try {
      const shiftIds = shifts.map((shift) => shift.id);
      if (shiftIds.length === 0) {
        setGenerated([]);
        return;
      }
      await fetchJsonWithSession('/lunch-breaks/generate', {
        ...jsonWriteInit('POST', { shiftIds, persist: true }),
      });
      const range = dayRange(selectedDate);
      const refreshed = await fetchJsonWithSession<{ data: ShiftRecord[] }>(
        `/shifts?startDate=${encodeURIComponent(range.start)}&endDate=${encodeURIComponent(range.end)}`,
      );
      setShifts(refreshed.data ?? []);
      setGenerated((refreshed.data ?? []).map(assignmentFromShift));
      setIsSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    try {
      await loadSchedule(selectedDate);
      setIsSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSaving(false);
    }
  };

  const updateShift = async (id: string, start: string, end: string, userId: string) => {
    setIsSaved(false);
    setShifts((previous) =>
      previous.map((shift) => (shift.id === id ? { ...shift, startTime: start, endTime: end, userId: userId === UNASSIGNED_RESOURCE_ID ? null : userId } : shift)),
    );
    try {
      const updated = await fetchJsonWithSession<ShiftRecord>(`/shifts/${id}`, {
        ...jsonWriteInit('PUT', {
          startTime: start,
          endTime: end,
          userId: userId === UNASSIGNED_RESOURCE_ID ? null : userId,
        }),
      });
      setShifts((previous) => previous.map((shift) => (shift.id === id ? updated : shift)));
      setIsSaved(true);
    } catch (err) {
      setError((err as Error).message);
      void loadSchedule(selectedDate);
    }
  };

  return (
    <>
      <div className="scheduler-page">
        <section className="scheduler-topbar surface-card">
          <div className="scheduler-topbar__left">
            <span className="workspace-kicker">Schedule workspace</span>
            <h1 className="workspace-title">Calendar</h1>
            <p className="workspace-subtitle">{isLoading ? 'Loading real tenant schedule...' : dateLabel}</p>
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

            <Button onClick={runGenerate} disabled={isGenerating || shifts.length === 0}>
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

            <Button variant="secondary" onClick={handleSave} disabled={isSaving}>
              {isSaving ? 'Refreshing...' : isSaved ? 'Synced' : 'Refresh'}
            </Button>

            <Button variant="ghost" size="icon" aria-label="Advanced settings" onClick={() => setShowAdvanced((value) => !value)}>
              <Settings2 size={16} />
            </Button>
          </div>
        </section>

        {error ? <div className="scheduler-error">{error}</div> : null}

        {showAdvanced ? (
          <section className="scheduler-advanced surface-card" aria-label="Advanced settings panel">
            <p><strong>Advanced</strong> actions use tenant-scoped schedule data and do not cross company boundaries.</p>
            <div className="scheduler-advanced__actions">
              <Button variant="outline" size="sm" onClick={() => void loadSchedule(selectedDate)}><RefreshCw size={14} /> Reload</Button>
              <Button variant="outline" size="sm" disabled><Upload size={14} /> Import shifts</Button>
              <Button variant="outline" size="sm" disabled><Download size={14} /> Export policy</Button>
            </div>
          </section>
        ) : null}

        <section className="scheduler-panels">
          <article className="surface-card scheduler-panel">
            <header>
              <h2>Shift inputs</h2>
              <p>{staff.length} staff and {locations.length} location{locations.length === 1 ? '' : 's'} available for this tenant.</p>
            </header>
            {shifts.length === 0 ? (
              <div className="scheduler-empty">
                <h3>No shifts yet</h3>
                <p>Add shifts for this day, then generate lunch and break coverage.</p>
                <div>
                  <Button size="sm" onClick={addShift}><Plus size={14} /> Add shift</Button>
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
                    {shifts.map((shift) => (
                      <tr key={shift.id}>
                        <td>{shift.user?.name ?? 'Open shift'}</td>
                        <td>{normalizeRole(shift.role ?? shift.user?.role)}</td>
                        <td>{fmtTime(shift.startTime)} - {fmtTime(shift.endTime)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ marginTop: 12 }}>
                  <Button size="sm" onClick={addShift}><Plus size={14} /> Add shift</Button>
                </div>
              </div>
            )}
          </article>

          <article className="surface-card scheduler-panel">
            <header>
              <h2>Lunch and break assignments</h2>
              <p>Generated records are saved to the shared lunch/break system.</p>
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
                <p>Generate assignments to populate the break grid and lunch/break workspace.</p>
                <div>
                  <Button size="sm" onClick={runGenerate} disabled={shifts.length === 0}><Sparkles size={14} /> Generate breaks</Button>
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
                      {assignment.breaks.map((item, breakIndex) => (
                        <span key={`${assignment.shiftId}-${breakIndex}`} className="badge badge-info">Break {item}</span>
                      ))}
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
            <p>Drag shifts to adjust times. Changes save immediately to the tenant schedule.</p>
          </header>
          <div className="scheduler-timeline-shell">
            <StaffScheduler
              resources={resources}
              events={scheduleEvents}
              viewMode={viewMode}
              initialDate={selectedDate}
              onEventChange={(id, start, end, resourceId) => void updateShift(id, start, end, resourceId)}
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

        .scheduler-error {
          padding: 0.8rem 0.95rem;
          border-radius: 12px;
          border: 1px solid #ffd0da;
          background: #fff1f4;
          color: #cb3653;
          font-weight: 650;
          font-size: 0.86rem;
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
          padding: 0 0 12px;
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
