'use client';

import { Suspense, useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { CalendarDays, Download, Printer, RefreshCw, Settings2, Upload, WandSparkles } from 'lucide-react';
import { fetchJsonWithSession } from '@/lib/client-api';
import type { SchedulerViewMode, StaffScheduleEvent, StaffScheduleSlotSelection } from '@/components/scheduling/StaffScheduler';

const StaffScheduler = dynamic(
  () => import('@/components/scheduling/StaffScheduler').then((m) => m.StaffScheduler),
  {
    ssr: false,
    loading: () => (
      <div style={{ minHeight: 520, padding: '1rem', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', background: 'var(--surface-soft)' }}>
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
type ShiftDraft = {
  userId: string;
  locationId: string;
  role: string;
  shiftDate: string;
  startTime: string;
  endTime: string;
};
const UNASSIGNED_RESOURCE_ID = 'unassigned';
const TODAY = new Date();
const DEFAULT_SHIFT_DRAFT: ShiftDraft = {
  userId: '',
  locationId: '',
  role: 'STAFF',
  shiftDate: toDateInputValue(TODAY),
  startTime: '09:00',
  endTime: '17:00',
};

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

function toDateInputValue(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function dayCountForView(mode: SchedulerViewMode): number {
  return mode === 'day' ? 1 : mode === 'threeDay' ? 3 : 7;
}

function viewRange(dateValue: string, mode: SchedulerViewMode) {
  const start = new Date(`${dateValue}T00:00:00`);
  const end = new Date(start);
  end.setDate(start.getDate() + dayCountForView(mode));
  return { start: start.toISOString(), end: end.toISOString() };
}

function visibleDateValues(dateValue: string, mode: SchedulerViewMode): string[] {
  const start = new Date(`${dateValue}T00:00:00`);
  return Array.from({ length: dayCountForView(mode) }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return toDateInputValue(date);
  });
}

function shortDateLabel(dateValue: string): string {
  return new Date(`${dateValue}T00:00:00`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function timeOnDate(dateValue: string, timeValue: string): string {
  const [hours = 0, minutes = 0] = timeValue.split(':').map((part) => Number.parseInt(part, 10));
  const date = new Date(`${dateValue}T00:00:00`);
  date.setHours(hours, minutes, 0, 0);
  return date.toISOString();
}

function shiftRange(dateValue: string, startTime: string, endTime: string) {
  return {
    startTime: timeOnDate(dateValue, startTime),
    endTime: timeOnDate(dateValue, endTime),
  };
}

function isValidShiftWindow(dateValue: string, startTime: string, endTime: string): boolean {
  const start = new Date(timeOnDate(dateValue, startTime)).getTime();
  const end = new Date(timeOnDate(dateValue, endTime)).getTime();
  return Number.isFinite(start) && Number.isFinite(end) && end > start;
}

function timeValueFromIso(dateIso: string): string {
  return new Date(dateIso).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function applyStaffToShift(shift: ShiftRecord, person: StaffRosterItem | null): ShiftRecord {
  return {
    ...shift,
    userId: person?.id ?? null,
    user: person ? { id: person.id, name: person.name, role: person.role } : null,
  };
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

function SchedulingContent() {
  const searchParams = useSearchParams();
  const initialDate = searchParams.get('date');
  const initialDateValue = initialDate && /^\d{4}-\d{2}-\d{2}$/.test(initialDate) ? initialDate : toDateInputValue(TODAY);
  const openFocus = searchParams.get('focus') === 'open';
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showTimeline, setShowTimeline] = useState(true);
  const [viewMode, setViewMode] = useState<SchedulerViewMode>('threeDay');
  const [selectedDate, setSelectedDate] = useState(initialDateValue);
  const [staff, setStaff] = useState<StaffRosterItem[]>([]);
  const [locations, setLocations] = useState<LocationItem[]>([]);
  const [shifts, setShifts] = useState<ShiftRecord[]>([]);
  const [showShiftForm, setShowShiftForm] = useState(false);
  const [editingShiftId, setEditingShiftId] = useState<string | null>(null);
  const [shiftDraft, setShiftDraft] = useState<ShiftDraft>({ ...DEFAULT_SHIFT_DRAFT, shiftDate: initialDateValue });
  const [error, setError] = useState<string | null>(null);

  const loadSchedule = useCallback(async (dateValue: string, mode: SchedulerViewMode) => {
    setIsLoading(true);
    setError(null);
    try {
      const range = viewRange(dateValue, mode);
      const [staffPayload, locationsPayload, shiftsPayload] = await Promise.all([
        fetchJsonWithSession<{ data: StaffRosterItem[] }>('/shifts/staff-roster'),
        fetchJsonWithSession<{ data: LocationItem[] }>('/locations'),
        fetchJsonWithSession<{ data: ShiftRecord[] }>(`/shifts?startDate=${encodeURIComponent(range.start)}&endDate=${encodeURIComponent(range.end)}`),
      ]);
      setStaff(staffPayload.data ?? []);
      setLocations(locationsPayload.data ?? []);
      setShifts(shiftsPayload.data ?? []);
    } catch (err) {
      setError((err as Error).message);
      setStaff([]);
      setLocations([]);
      setShifts([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSchedule(selectedDate, viewMode);
  }, [loadSchedule, selectedDate, viewMode]);

  useEffect(() => {
    setShiftDraft((current) => {
      const visibleDates = visibleDateValues(selectedDate, viewMode);
      if (visibleDates.includes(current.shiftDate)) return current;
      return { ...current, shiftDate: selectedDate };
    });
  }, [selectedDate, viewMode]);

  useEffect(() => {
    setShiftDraft((current) => {
      if (!locations[0]?.id) return current.locationId ? { ...current, locationId: '' } : current;
      if (locations.some((location) => location.id === current.locationId)) return current;
      return { ...current, locationId: locations[0].id };
    });
  }, [locations]);

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

  const openShifts = useMemo(() => shifts.filter((shift) => !shift.userId), [shifts]);
  const visibleShifts = openFocus ? openShifts : shifts;
  const visibleResources = useMemo(() => {
    if (!openFocus) return resources;
    return resources.filter((resource) => resource.id === UNASSIGNED_RESOURCE_ID);
  }, [openFocus, resources]);

  const scheduleEvents = useMemo(() => shiftsToEvents(visibleShifts), [visibleShifts]);

  const dateLabel = useMemo(
    () => {
      const dates = visibleDateValues(selectedDate, viewMode);
      if (dates.length === 1) return shortDateLabel(dates[0]);
      return `${shortDateLabel(dates[0])} - ${shortDateLabel(dates[dates.length - 1])}`;
    },
    [selectedDate, viewMode],
  );

  const handleDraftStaffChange = (value: string) => {
    const selectedStaff = staff.find((person) => person.id === value);
    setShiftDraft((current) => ({
      ...current,
      userId: value,
      role: selectedStaff?.role ?? current.role,
    }));
  };

  const addShift = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    setIsSaved(false);
    setError(null);
    const locationId = shiftDraft.locationId || locations[0]?.id;
    if (!locationId) {
      setError('Add a location before creating schedule shifts.');
      return;
    }
    if (!isValidShiftWindow(shiftDraft.shiftDate, shiftDraft.startTime, shiftDraft.endTime)) {
      setError('Shift end time must be after start time.');
      return;
    }

    const selectedStaff = staff.find((person) => person.id === shiftDraft.userId);
    if (!selectedStaff) {
      setError('Select a staff member before creating a shift.');
      return;
    }
    const range = shiftRange(shiftDraft.shiftDate, shiftDraft.startTime, shiftDraft.endTime);
    try {
      if (editingShiftId) {
        const updated = await fetchJsonWithSession<ShiftRecord>(`/shifts/${editingShiftId}`, {
          ...jsonWriteInit('PUT', {
            startTime: range.startTime,
            endTime: range.endTime,
            userId: selectedStaff.id,
          }),
        });
        setShifts((current) => current.map((shift) => (shift.id === editingShiftId ? updated : shift)));
      } else {
        const created = await fetchJsonWithSession<ShiftRecord>('/shifts', {
          ...jsonWriteInit('POST', {
            locationId,
            userId: selectedStaff.id,
            role: normalizeRole(shiftDraft.role || selectedStaff.role),
            ...range,
          }),
        });
        setShifts((current) => [...current, created]);
      }
      setShowShiftForm(false);
      setEditingShiftId(null);
      setShiftDraft((current) => ({
        ...current,
        userId: '',
        role: 'STAFF',
      }));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const prepareShiftForStaff = (person: StaffRosterItem, shiftDate: string, startTime = '09:00', endTime = '17:00') => {
    setError(null);
    setEditingShiftId(null);
    setShiftDraft((current) => ({
      ...current,
      userId: person.id,
      locationId: current.locationId || locations[0]?.id || '',
      role: person.role,
      shiftDate,
      startTime,
      endTime,
    }));
    setShowShiftForm(true);
  };

  const prepareShiftFromBoardSlot = (slot: StaffScheduleSlotSelection) => {
    const person = staff.find((item) => item.id === slot.resourceId);
    if (!person) return;
    prepareShiftForStaff(person, toDateInputValue(new Date(slot.start)), timeValueFromIso(slot.start), timeValueFromIso(slot.end));
  };

  const editShiftFromBoard = (event: StaffScheduleEvent) => {
    const shift = shifts.find((item) => item.id === event.id);
    if (!shift) return;
    const person = shift.userId ? staff.find((item) => item.id === shift.userId) : null;
    setError(null);
    setEditingShiftId(shift.id);
    setShiftDraft({
      userId: person?.id ?? '',
      locationId: shift.locationId,
      role: normalizeRole(shift.role ?? person?.role),
      shiftDate: toDateInputValue(new Date(shift.startTime)),
      startTime: timeValueFromIso(shift.startTime),
      endTime: timeValueFromIso(shift.endTime),
    });
    setShowShiftForm(true);
  };

  const runGenerate = async () => {
    setIsSaved(false);
    setIsGenerating(true);
    setError(null);
    try {
      const shiftIds = shifts.map((shift) => shift.id);
      if (shiftIds.length === 0) {
        return;
      }
      await fetchJsonWithSession('/lunch-breaks/generate', {
        ...jsonWriteInit('POST', { shiftIds, persist: true }),
      });
      const range = viewRange(selectedDate, viewMode);
      const refreshed = await fetchJsonWithSession<{ data: ShiftRecord[] }>(
        `/shifts?startDate=${encodeURIComponent(range.start)}&endDate=${encodeURIComponent(range.end)}`,
      );
      setShifts(refreshed.data ?? []);
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
      await loadSchedule(selectedDate, viewMode);
      setIsSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSaving(false);
    }
  };

  const openPrintSchedule = () => {
    const params = new URLSearchParams({ date: selectedDate, autoprint: '1' });
    window.open(`/dashboard/scheduling/print?${params.toString()}`, '_blank', 'noopener,noreferrer');
  };

  const updateShift = async (id: string, start: string, end: string, userId: string) => {
    setIsSaved(false);
    const nextUserId = userId === UNASSIGNED_RESOURCE_ID ? null : userId;
    const selectedStaff = nextUserId ? staff.find((person) => person.id === nextUserId) ?? null : null;
    setShifts((previous) =>
      previous.map((shift) => (shift.id === id ? applyStaffToShift({ ...shift, startTime: start, endTime: end }, selectedStaff) : shift)),
    );
    try {
      const updated = await fetchJsonWithSession<ShiftRecord>(`/shifts/${id}`, {
        ...jsonWriteInit('PUT', {
          startTime: start,
          endTime: end,
          userId: nextUserId,
        }),
      });
      setShifts((previous) => previous.map((shift) => (shift.id === id ? updated : shift)));
      setIsSaved(true);
    } catch (err) {
      setError((err as Error).message);
      void loadSchedule(selectedDate, viewMode);
    }
  };

  return (
    <>
      <div className="scheduler-page">
        <section className="surface-card scheduler-workspace">
        <section className="scheduler-topbar">
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

            <Button variant="secondary" onClick={handleSave} disabled={isSaving}>
              {isSaving ? 'Refreshing...' : isSaved ? 'Synced' : 'Refresh'}
            </Button>

            <Button variant="ghost" size="icon" aria-label="Advanced settings" onClick={() => setShowAdvanced((value) => !value)}>
              <Settings2 size={16} />
            </Button>
          </div>
        </section>

        {error ? <div className="scheduler-error">{error}</div> : null}

        {openFocus ? (
          <section className="scheduler-focus-banner" aria-label="Open shift focus">
            <div>
              <strong>Open shifts focus</strong>
              <span>{openShifts.length} open shift{openShifts.length === 1 ? '' : 's'} shown. Assigned shifts are hidden in this view.</span>
            </div>
            <a className="btn btn-secondary btn-sm" href="/dashboard/scheduling">Show all shifts</a>
          </section>
        ) : null}

        {showAdvanced ? (
          <section className="scheduler-advanced" aria-label="Advanced settings panel">
            <p><strong>Advanced</strong> actions use tenant-scoped schedule data and do not cross company boundaries.</p>
            <div className="scheduler-advanced__actions">
              <Button variant="outline" size="sm" onClick={() => void loadSchedule(selectedDate, viewMode)}><RefreshCw size={14} /> Reload</Button>
              <Button variant="outline" size="sm" onClick={runGenerate} disabled={isGenerating || shifts.length === 0}><WandSparkles size={14} /> Generate breaks</Button>
              <Button variant="outline" size="sm" onClick={openPrintSchedule} disabled={isLoading || shifts.length === 0}><Printer size={14} /> Print</Button>
              <Button variant="outline" size="sm" disabled><Upload size={14} /> Import shifts</Button>
              <Button variant="outline" size="sm" disabled><Download size={14} /> Export policy</Button>
            </div>
          </section>
        ) : null}

        <section className="scheduler-calendar-panel" aria-label="Schedule calendar board">
          <header>
            <div>
              <h2>Schedule board</h2>
              <p>{scheduleEvents.length} event{scheduleEvents.length === 1 ? '' : 's'} across {dateLabel}. Drag shifts on the board to adjust coverage.</p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => setShowTimeline((value) => !value)}>
              {showTimeline ? 'Hide board' : 'Show board'}
            </Button>
          </header>
          {showTimeline ? (
            <div className="scheduler-calendar-shell">
              <StaffScheduler
                resources={visibleResources}
                events={scheduleEvents}
                viewMode={viewMode}
                initialDate={selectedDate}
                onEventChange={(id, start, end, resourceId) => void updateShift(id, start, end, resourceId)}
                onEventSelect={editShiftFromBoard}
                onSlotSelect={prepareShiftFromBoardSlot}
              />
            </div>
          ) : (
            <div className="timeline-summary">
              <CalendarDays size={18} />
              <strong>{dateLabel}</strong>
              <span>{visibleShifts.length} shift{visibleShifts.length === 1 ? '' : 's'} ready for review.</span>
            </div>
          )}
        </section>

        {showShiftForm && !openFocus ? (
          <section className="scheduler-editor-panel" aria-label={editingShiftId ? 'Edit shift' : 'Create shift'}>
            <form className="shift-form" onSubmit={addShift}>
              <label>
                <span>Staff</span>
                <select value={shiftDraft.userId} onChange={(event) => handleDraftStaffChange(event.target.value)}>
                  <option value="">Select staff</option>
                  {staff.map((person) => (
                    <option key={person.id} value={person.id}>{person.name}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Location</span>
                <select value={shiftDraft.locationId} onChange={(event) => setShiftDraft((current) => ({ ...current, locationId: event.target.value }))}>
                  <option value="">Select location</option>
                  {locations.map((location) => (
                    <option key={location.id} value={location.id}>{location.name}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Role</span>
                <select value={shiftDraft.role} onChange={(event) => setShiftDraft((current) => ({ ...current, role: event.target.value }))}>
                  <option value="STAFF">Staff</option>
                  <option value="MANAGER">Manager</option>
                  <option value="ADMIN">Admin</option>
                  <option value="SUPER_ADMIN">Super admin</option>
                </select>
              </label>
              <label>
                <span>Date</span>
                <input
                  type="date"
                  value={shiftDraft.shiftDate}
                  onChange={(event) => setShiftDraft((current) => ({ ...current, shiftDate: event.target.value }))}
                />
              </label>
              <label>
                <span>Start</span>
                <input
                  type="time"
                  value={shiftDraft.startTime}
                  onChange={(event) => setShiftDraft((current) => ({ ...current, startTime: event.target.value }))}
                />
              </label>
              <label>
                <span>End</span>
                <input
                  type="time"
                  value={shiftDraft.endTime}
                  onChange={(event) => setShiftDraft((current) => ({ ...current, endTime: event.target.value }))}
                />
              </label>
              <div className="shift-form__actions">
                <Button
                  size="sm"
                  type="submit"
                  disabled={!locations.length || !shiftDraft.userId || !isValidShiftWindow(shiftDraft.shiftDate, shiftDraft.startTime, shiftDraft.endTime)}
                >
                  {editingShiftId ? 'Save shift' : 'Create shift'}
                </Button>
                <Button size="sm" type="button" variant="ghost" onClick={() => { setShowShiftForm(false); setEditingShiftId(null); }}>
                  Cancel
                </Button>
              </div>
            </form>
          </section>
        ) : null}

        </section>
      </div>

      <style jsx>{`
        .scheduler-page {
          min-height: 100%;
          display: grid;
          gap: 16px;
        }

        .scheduler-workspace {
          overflow: hidden;
          display: grid;
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

        .scheduler-focus-banner {
          padding: 0.8rem 0.95rem;
          border: 1px solid #bfdbfe;
          border-radius: var(--r-md);
          background: #eff6ff;
          color: var(--text);
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.75rem;
          flex-wrap: wrap;
        }

        .scheduler-focus-banner div {
          display: grid;
          gap: 2px;
        }

        .scheduler-focus-banner strong {
          font-size: 0.86rem;
        }

        .scheduler-focus-banner span {
          color: var(--text-muted);
          font-size: 0.8rem;
        }

        .scheduler-topbar {
          padding: 16px 20px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          flex-wrap: wrap;
          border-bottom: 1px solid var(--border);
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
          padding: 14px 20px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          flex-wrap: wrap;
          border-bottom: 1px solid var(--border);
          background: var(--surface-soft);
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

        .scheduler-calendar-panel {
          padding: 18px 20px 20px;
          border-bottom: 1px solid var(--border);
          background: #fbfdff;
        }

        .scheduler-calendar-panel header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
          flex-wrap: wrap;
        }

        .scheduler-calendar-panel header h2 {
          margin: 0;
          font-size: 22px;
          line-height: 1.25;
        }

        .scheduler-calendar-panel header p {
          margin: 6px 0 0;
          color: var(--text-muted);
          font-size: 14px;
        }

        .scheduler-calendar-shell {
          margin-top: 14px;
          height: clamp(480px, 58vh, 650px);
          min-height: 480px;
        }

        .scheduler-editor-panel {
          padding: 0 20px 20px;
          border-bottom: 1px solid var(--border);
          background: #fbfdff;
        }

        .shift-form {
          margin-top: 0;
          padding: 12px;
          border: 1px solid var(--border);
          border-radius: var(--r-md);
          background: var(--surface-soft);
          display: grid;
          grid-template-columns: minmax(160px, 1.2fr) minmax(160px, 1fr) minmax(130px, 0.8fr) repeat(3, minmax(96px, 0.55fr));
          gap: 10px;
          align-items: end;
        }

        .shift-form label {
          display: grid;
          gap: 5px;
          min-width: 0;
        }

        .shift-form span {
          font-size: 12px;
          font-weight: 800;
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }

        .shift-form select,
        .shift-form input,
        .scheduler-inline-select {
          width: 100%;
          height: 36px;
          border: 1px solid var(--border);
          border-radius: var(--r-sm);
          background: var(--surface);
          color: var(--text);
          font-size: 13px;
          padding: 0 10px;
        }

        .shift-form__actions {
          grid-column: 1 / -1;
          display: flex;
          gap: 8px;
          justify-content: flex-end;
        }

        .timeline-summary {
          margin-top: 16px;
          min-height: 58px;
          border: 1px solid var(--border);
          border-radius: var(--r-sm);
          background: var(--surface-soft);
          padding: 10px 12px;
          display: flex;
          align-items: center;
          gap: 12px;
          flex-wrap: wrap;
        }

        .timeline-summary svg {
          color: var(--brand-700);
        }

        .timeline-summary strong {
          font-size: 14px;
        }

        .timeline-summary span {
          color: var(--text-muted);
          font-size: 13px;
        }

        .scheduler-timeline-panel {
          padding: 18px 20px;
        }

        .scheduler-timeline-shell {
          margin-top: 16px;
          min-height: 520px;
        }

        @media (max-width: 1200px) {
          .shift-form {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
        }

        @media (max-width: 768px) {
          .scheduler-editor-panel,
          .scheduler-calendar-panel,
          .scheduler-timeline-panel,
          .scheduler-topbar {
            padding: 16px;
          }

          .scheduler-calendar-shell {
            height: 480px;
          }

          .scheduler-day-picker {
            width: 100%;
          }

          .scheduler-topbar__controls {
            width: 100%;
            justify-content: flex-start;
          }

          .shift-form {
            grid-template-columns: 1fr;
          }

          .shift-form__actions {
            justify-content: flex-start;
            flex-wrap: wrap;
          }
        }
      `}</style>
    </>
  );
}

export default function SchedulingPage() {
  return (
    <Suspense fallback={<div className="surface-card" style={{ minHeight: 520, padding: '1rem' }} />}>
      <SchedulingContent />
    </Suspense>
  );
}
