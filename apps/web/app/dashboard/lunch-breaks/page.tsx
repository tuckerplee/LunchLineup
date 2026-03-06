'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { fetchWithSession } from '@/lib/client-api';

type FeatureResolution = {
  enabled: boolean;
  source: 'plan' | 'stripe' | 'credits' | 'manual' | 'disabled';
  reason: string;
  creditCost: number | null;
};

type FeatureMatrixResponse = {
  usageCredits: number;
  features: {
    scheduling: FeatureResolution;
    lunch_breaks: FeatureResolution;
  };
};

type GeneratedBreak = {
  type: 'break1' | 'lunch' | 'break2';
  startTime: string;
  endTime: string;
  durationMinutes: number;
  paid: boolean;
};

type GeneratedShiftBreaks = {
  shiftId: string | null;
  userId: string | null;
  employeeName: string | null;
  startTime: string;
  endTime: string;
  breaks: GeneratedBreak[];
};

type GenerateResponse = {
  source: 'shared_schedule' | 'standalone';
  persisted: boolean;
  policy: LunchBreakPolicy;
  creditConsumption: { consumedCredits: number; newBalance: number | null };
  data: GeneratedShiftBreaks[];
};

type LunchBreakPolicy = {
  break1OffsetMinutes: number;
  lunchOffsetMinutes: number;
  break2OffsetMinutes: number;
  break1DurationMinutes: number;
  lunchDurationMinutes: number;
  break2DurationMinutes: number;
  timeStepMinutes: number;
};

type BreakEditorKey = 'break1' | 'lunch' | 'break2';

type EditableBreak = {
  time: string;
  durationMinutes: number;
  skipped: boolean;
};

type DayShiftRow = {
  shiftId: string;
  userId: string | null;
  employeeName: string;
  startTime: string;
  endTime: string;
  break1: EditableBreak;
  lunch: EditableBreak;
  break2: EditableBreak;
  dirty: boolean;
  saving: boolean;
};

type ManualShiftRow = {
  id: string;
  employeeName: string;
  startTime: string;
  endTime: string;
};

const BREAK_KEYS: BreakEditorKey[] = ['break1', 'lunch', 'break2'];

const DEFAULT_POLICY: LunchBreakPolicy = {
  break1OffsetMinutes: 120,
  lunchOffsetMinutes: 240,
  break2OffsetMinutes: 120,
  break1DurationMinutes: 10,
  lunchDurationMinutes: 30,
  break2DurationMinutes: 10,
  timeStepMinutes: 5,
};

function toDateInputValue(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function shiftDate(dateValue: string, days: number): string {
  const [year, month, day] = dateValue.split('-').map((part) => Number(part));
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + days);
  return toDateInputValue(date);
}

function dayWindow(dateValue: string): { startIso: string; endIso: string } {
  const [year, month, day] = dateValue.split('-').map((part) => Number(part));
  const start = new Date(year, month - 1, day, 0, 0, 0, 0);
  const end = new Date(year, month - 1, day + 1, 0, 0, 0, 0);
  return {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

function toTimeInputValue(iso: string): string {
  const date = new Date(iso);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function toDisplayTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function toDisplayShift(startIso: string, endIso: string): string {
  return `${toDisplayTime(startIso)} - ${toDisplayTime(endIso)}`;
}

function cloneRow(row: DayShiftRow): DayShiftRow {
  return {
    ...row,
    break1: { ...row.break1 },
    lunch: { ...row.lunch },
    break2: { ...row.break2 },
  };
}

function buildEditableBreak(
  generated: GeneratedShiftBreaks,
  type: BreakEditorKey,
  fallbackDuration: number,
): EditableBreak {
  const found = generated.breaks.find((entry) => entry.type === type);
  if (!found) {
    return {
      time: '',
      durationMinutes: fallbackDuration,
      skipped: true,
    };
  }
  return {
    time: toTimeInputValue(found.startTime),
    durationMinutes: found.durationMinutes > 0 ? found.durationMinutes : fallbackDuration,
    skipped: false,
  };
}

function toDayShiftRow(generated: GeneratedShiftBreaks, policy: LunchBreakPolicy): DayShiftRow | null {
  if (!generated.shiftId) return null;

  return {
    shiftId: generated.shiftId,
    userId: generated.userId,
    employeeName: generated.employeeName ?? 'Unassigned',
    startTime: generated.startTime,
    endTime: generated.endTime,
    break1: buildEditableBreak(generated, 'break1', policy.break1DurationMinutes),
    lunch: buildEditableBreak(generated, 'lunch', policy.lunchDurationMinutes),
    break2: buildEditableBreak(generated, 'break2', policy.break2DurationMinutes),
    dirty: false,
    saving: false,
  };
}

function resolveShiftIsoForTime(startIso: string, endIso: string, timeValue: string): string | null {
  const match = /^(\d{2}):(\d{2})$/.exec(timeValue);
  if (!match) return null;

  const start = new Date(startIso);
  const end = new Date(endIso);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const candidate = new Date(start);
  candidate.setHours(hours, minutes, 0, 0);

  if (candidate.getTime() < start.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }

  if (candidate.getTime() > end.getTime()) {
    const previousDay = new Date(candidate);
    previousDay.setDate(previousDay.getDate() - 1);
    if (previousDay.getTime() >= start.getTime() && previousDay.getTime() <= end.getTime()) {
      return previousDay.toISOString();
    }
    return null;
  }

  return candidate.toISOString();
}

function toIsoForDateAndTime(dateValue: string, timeValue: string): string | null {
  const match = /^(\d{2}):(\d{2})$/.exec(timeValue);
  if (!match) return null;
  const [year, month, day] = dateValue.split('-').map((part) => Number(part));
  const date = new Date(year, month - 1, day, Number(match[1]), Number(match[2]), 0, 0);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

function defaultManualShifts(): ManualShiftRow[] {
  return [
    { id: 'manual-1', employeeName: 'Alex', startTime: '09:00', endTime: '17:00' },
    { id: 'manual-2', employeeName: 'Blair', startTime: '10:00', endTime: '18:00' },
    { id: 'manual-3', employeeName: 'Casey', startTime: '11:00', endTime: '19:00' },
  ];
}

function getCsrfTokenFromCookie(): string {
  if (typeof document === 'undefined') return '';
  const pair = document.cookie
    .split('; ')
    .find((entry) => entry.startsWith('csrf_token='));
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

export default function LunchBreaksPage() {
  const [features, setFeatures] = useState<FeatureMatrixResponse | null>(null);
  const [policy, setPolicy] = useState<LunchBreakPolicy>(DEFAULT_POLICY);
  const [policyLoaded, setPolicyLoaded] = useState<LunchBreakPolicy>(DEFAULT_POLICY);
  const [selectedDate, setSelectedDate] = useState<string>(toDateInputValue(new Date()));
  const [dayRows, setDayRows] = useState<DayShiftRow[]>([]);
  const [baselines, setBaselines] = useState<Record<string, DayShiftRow>>({});
  const [lastRun, setLastRun] = useState<GenerateResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isDayLoading, setIsDayLoading] = useState(false);
  const [isSavingPolicy, setIsSavingPolicy] = useState(false);
  const [isGeneratingDay, setIsGeneratingDay] = useState(false);
  const [isGeneratingManual, setIsGeneratingManual] = useState(false);
  const [showAdvancedPolicy, setShowAdvancedPolicy] = useState(false);
  const [manualShifts, setManualShifts] = useState<ManualShiftRow[]>(defaultManualShifts());
  const [error, setError] = useState<string | null>(null);

  const loadFeatures = useCallback(async (): Promise<FeatureMatrixResponse> => {
    const res = await fetchWithSession('/billing/features');
    if (!res.ok) throw new Error('Unable to load feature status.');
    return (await res.json()) as FeatureMatrixResponse;
  }, []);

  const loadPolicy = useCallback(async (): Promise<LunchBreakPolicy> => {
    const res = await fetchWithSession('/lunch-breaks/policy');
    if (!res.ok) throw new Error('Unable to load lunch/break policy.');
    const payload = (await res.json()) as Partial<LunchBreakPolicy>;
    return { ...DEFAULT_POLICY, ...payload };
  }, []);

  const loadDayRows = useCallback(async (dateValue: string, policyValue: LunchBreakPolicy) => {
    const { startIso, endIso } = dayWindow(dateValue);
    const query = new URLSearchParams({
      startDate: startIso,
      endDate: endIso,
    });

    setIsDayLoading(true);
    try {
      const res = await fetchWithSession(`/lunch-breaks?${query.toString()}`);
      if (!res.ok) {
        throw new Error('Unable to load lunch/break grid for selected day.');
      }

      const payload = (await res.json()) as { data: GeneratedShiftBreaks[] };
      const rows = (Array.isArray(payload.data) ? payload.data : [])
        .map((entry) => toDayShiftRow(entry, policyValue))
        .filter((entry): entry is DayShiftRow => entry !== null);

      const baselineMap: Record<string, DayShiftRow> = {};
      for (const row of rows) {
        baselineMap[row.shiftId] = cloneRow(row);
      }

      setDayRows(rows);
      setBaselines(baselineMap);
    } finally {
      setIsDayLoading(false);
    }
  }, []);

  const bootstrap = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [featureData, policyData] = await Promise.all([loadFeatures(), loadPolicy()]);
      setFeatures(featureData);
      setPolicy(policyData);
      setPolicyLoaded(policyData);

      if (featureData.features.lunch_breaks.enabled) {
        await loadDayRows(selectedDate, policyData);
      } else {
        setDayRows([]);
        setBaselines({});
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  }, [loadFeatures, loadPolicy, loadDayRows, selectedDate]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const lunchBreakFeature = features?.features.lunch_breaks;
  const schedulingFeature = features?.features.scheduling;
  const hasSharedScheduleData = Boolean(schedulingFeature?.enabled && dayRows.length > 0);

  useEffect(() => {
    if (!lunchBreakFeature?.enabled) return;
    if (isLoading) return;

    void loadDayRows(selectedDate, policyLoaded).catch((err) => {
      setError((err as Error).message);
    });
  }, [isLoading, loadDayRows, lunchBreakFeature?.enabled, policyLoaded, selectedDate]);

  const policyFields = useMemo(
    () =>
      [
        { key: 'break1OffsetMinutes', label: 'Break 1 Offset (min)' },
        { key: 'lunchOffsetMinutes', label: 'Lunch Offset (min)' },
        { key: 'break2OffsetMinutes', label: 'Break 2 Offset (min)' },
        { key: 'break1DurationMinutes', label: 'Break 1 Duration (min)' },
        { key: 'lunchDurationMinutes', label: 'Lunch Duration (min)' },
        { key: 'break2DurationMinutes', label: 'Break 2 Duration (min)' },
        { key: 'timeStepMinutes', label: 'Conflict Step (min)' },
      ] as const,
    [],
  );

  const updateBreak = useCallback((shiftId: string, key: BreakEditorKey, next: Partial<EditableBreak>) => {
    setDayRows((prev) =>
      prev.map((row) =>
        row.shiftId === shiftId
          ? {
              ...row,
              [key]: { ...row[key], ...next },
              dirty: true,
            }
          : row,
      ),
    );
  }, []);

  const resetRow = useCallback((shiftId: string) => {
    const baseline = baselines[shiftId];
    if (!baseline) return;
    setDayRows((prev) => prev.map((row) => (row.shiftId === shiftId ? cloneRow(baseline) : row)));
  }, [baselines]);

  const handleSavePolicy = useCallback(async () => {
    setIsSavingPolicy(true);
    setError(null);
    try {
      const res = await fetchWithSession('/lunch-breaks/policy', {
        ...jsonWriteInit('PUT', policy),
      });
      if (!res.ok) throw new Error('Failed to save lunch/break policy.');
      const payload = (await res.json()) as Partial<LunchBreakPolicy>;
      const merged = { ...DEFAULT_POLICY, ...payload };
      setPolicy(merged);
      setPolicyLoaded(merged);
      await loadDayRows(selectedDate, merged);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSavingPolicy(false);
    }
  }, [loadDayRows, policy, selectedDate]);

  const saveRow = useCallback(
    async (shiftId: string): Promise<boolean> => {
      const row = dayRows.find((candidate) => candidate.shiftId === shiftId);
      if (!row) return false;

      setDayRows((prev) =>
        prev.map((candidate) => (candidate.shiftId === shiftId ? { ...candidate, saving: true } : candidate)),
      );

      try {
        const breaks = BREAK_KEYS.map((key) => {
          const current = row[key];
          if (current.skipped) {
            return { type: key, skip: true };
          }

          const resolvedStart = resolveShiftIsoForTime(row.startTime, row.endTime, current.time);
          if (!resolvedStart) {
            throw new Error(`${row.employeeName}: ${key} time is outside of the shift window.`);
          }

          return {
            type: key,
            startTime: resolvedStart,
            durationMinutes: Math.max(1, Math.round(current.durationMinutes || 0)),
            skip: false,
          };
        });

        const res = await fetchWithSession(`/lunch-breaks/shift/${shiftId}`, {
          ...jsonWriteInit('PUT', { breaks }),
        });
        if (!res.ok) throw new Error(`Failed to save row for ${row.employeeName}.`);

        const payload = (await res.json()) as GeneratedShiftBreaks;
        const mapped = toDayShiftRow(payload, policyLoaded);
        if (!mapped) throw new Error('Saved row did not include a shift id.');

        setDayRows((prev) =>
          prev.map((candidate) =>
            candidate.shiftId === shiftId ? { ...mapped, dirty: false, saving: false } : candidate,
          ),
        );
        setBaselines((prev) => ({
          ...prev,
          [shiftId]: { ...mapped, dirty: false, saving: false },
        }));
        return true;
      } catch (err) {
        setDayRows((prev) =>
          prev.map((candidate) => (candidate.shiftId === shiftId ? { ...candidate, saving: false } : candidate)),
        );
        setError((err as Error).message);
        return false;
      }
    },
    [dayRows, policyLoaded],
  );

  const saveAllDirtyRows = useCallback(async () => {
    const dirty = dayRows.filter((row) => row.dirty);
    if (dirty.length === 0) return;
    setError(null);

    for (const row of dirty) {
      const ok = await saveRow(row.shiftId);
      if (!ok) {
        break;
      }
    }
  }, [dayRows, saveRow]);

  const generateForSelectedDay = useCallback(async () => {
    if (dayRows.length === 0) {
      setError('No shared schedule shifts found for selected day.');
      return;
    }

    setIsGeneratingDay(true);
    setError(null);
    try {
      const res = await fetchWithSession('/lunch-breaks/generate', {
        ...jsonWriteInit('POST', {
          shiftIds: dayRows.map((row) => row.shiftId),
          persist: true,
          policy,
        }),
      });
      if (!res.ok) throw new Error('Failed to generate lunch/break assignments for this day.');

      const payload = (await res.json()) as GenerateResponse;
      setLastRun(payload);
      await loadDayRows(selectedDate, policyLoaded);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsGeneratingDay(false);
    }
  }, [dayRows, loadDayRows, policy, policyLoaded, selectedDate]);

  const addManualShift = useCallback(() => {
    const nextIndex = manualShifts.length + 1;
    setManualShifts((prev) => [
      ...prev,
      {
        id: `manual-${Date.now()}-${nextIndex}`,
        employeeName: `Employee ${nextIndex}`,
        startTime: '09:00',
        endTime: '17:00',
      },
    ]);
  }, [manualShifts.length]);

  const updateManualShift = useCallback((id: string, changes: Partial<ManualShiftRow>) => {
    setManualShifts((prev) => prev.map((row) => (row.id === id ? { ...row, ...changes } : row)));
  }, []);

  const removeManualShift = useCallback((id: string) => {
    setManualShifts((prev) => prev.filter((row) => row.id !== id));
  }, []);

  const generateFromManualShifts = useCallback(async () => {
    setIsGeneratingManual(true);
    setError(null);
    try {
      const shifts = manualShifts.map((row) => {
        const start = toIsoForDateAndTime(selectedDate, row.startTime);
        const end = toIsoForDateAndTime(selectedDate, row.endTime);
        if (!start || !end) {
          throw new Error(`Invalid shift time for ${row.employeeName || 'employee'}.`);
        }
        const startMs = new Date(start).getTime();
        let endMs = new Date(end).getTime();
        if (endMs <= startMs) {
          endMs += 24 * 60 * 60 * 1000;
        }
        return {
          employeeName: row.employeeName.trim() || 'Unassigned',
          startTime: new Date(startMs).toISOString(),
          endTime: new Date(endMs).toISOString(),
        };
      });

      if (shifts.length === 0) {
        throw new Error('Add at least one employee shift to generate a lunch/break plan.');
      }

      const res = await fetchWithSession('/lunch-breaks/generate', {
        ...jsonWriteInit('POST', {
          shifts,
          persist: false,
          policy,
        }),
      });
      if (!res.ok) throw new Error('Failed to generate lunch/breaks from manual shifts.');
      const payload = (await res.json()) as GenerateResponse;
      setLastRun(payload);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsGeneratingManual(false);
    }
  }, [manualShifts, policy, selectedDate]);

  const selectedDateLabel = useMemo(() => {
    const [year, month, day] = selectedDate.split('-').map((part) => Number(part));
    return new Date(year, month - 1, day).toLocaleDateString([], {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }, [selectedDate]);

  const dirtyCount = dayRows.filter((row) => row.dirty).length;
  const hasSharedRows = dayRows.length > 0;
  const isGeneratingPrimary = hasSharedRows ? isGeneratingDay : isGeneratingManual;

  const runPrimaryGeneration = useCallback(() => {
    if (hasSharedRows) {
      void generateForSelectedDay();
      return;
    }
    void generateFromManualShifts();
  }, [generateForSelectedDay, generateFromManualShifts, hasSharedRows]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 1600 }}>
      <div>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--text-primary)', marginBottom: 4 }}>
          Lunch/Break Scheduler
        </h1>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
          Pick a day, generate assignments, and edit directly in the grid. Use shared Scheduling shifts when available, or run this feature standalone with manual employee rows.
        </p>
      </div>

      {isLoading ? (
        <div style={{ padding: '0.9rem', borderRadius: 10, border: '1px solid var(--border)', color: 'var(--text-muted)' }}>
          Loading lunch/break feature status...
        </div>
      ) : null}

      {!isLoading && lunchBreakFeature && !lunchBreakFeature.enabled ? (
        <div style={{ padding: '1rem', borderRadius: 10, border: '1px solid rgba(244,63,94,0.35)', background: 'rgba(244,63,94,0.08)' }}>
          <div style={{ fontWeight: 700, color: '#fb7185' }}>Lunch/Breaks is currently locked</div>
          <div style={{ marginTop: 4, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            {lunchBreakFeature.reason}
          </div>
        </div>
      ) : null}

      {!isLoading && lunchBreakFeature?.enabled ? (
        <>
          <div style={{ border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg-glass)', padding: '0.9rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Selected Day</div>
                <div style={{ color: 'var(--text-primary)', fontWeight: 700 }}>{selectedDateLabel}</div>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <Button variant="outline" size="sm" onClick={() => setSelectedDate(shiftDate(selectedDate, -1))}>Prev</Button>
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(event) => setSelectedDate(event.target.value)}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    background: '#ffffff',
                    color: 'var(--text-primary)',
                    padding: '0.4rem 0.55rem',
                    fontSize: '0.82rem',
                  }}
                />
                <Button variant="outline" size="sm" onClick={() => setSelectedDate(toDateInputValue(new Date()))}>Today</Button>
                <Button variant="outline" size="sm" onClick={() => setSelectedDate(shiftDate(selectedDate, 1))}>Next</Button>
              </div>
            </div>
          </div>

          <div style={{ border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg-glass)', padding: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Primary Action</div>
                <div style={{ color: 'var(--text-primary)', fontWeight: 700 }}>
                  {hasSharedRows ? 'Generate assignments from Scheduling shifts' : 'Generate assignments from manual shifts'}
                </div>
              </div>
              <Button size="sm" onClick={runPrimaryGeneration} disabled={isGeneratingPrimary}>
                {isGeneratingPrimary ? 'Generating...' : 'Generate Assignments'}
              </Button>
            </div>
            <div style={{ marginTop: '0.55rem', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
              {hasSharedRows
                ? `${dayRows.length} shifts imported from Scheduling.`
                : 'No shifts imported from Scheduling. Add shifts manually below.'}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg-glass)', overflow: 'hidden' }}>
              <div style={{ padding: '0.85rem 1rem', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
                <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>Shift Inputs</div>
                <Button variant="outline" size="sm" onClick={addManualShift}>Add Shift</Button>
              </div>
              {hasSharedRows ? (
                <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
                  Using {dayRows.length} shifts from Scheduling for {selectedDateLabel}.
                </div>
              ) : (
                <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
                  No shared shifts found. Add employee shifts below and generate assignments.
                </div>
              )}
              <div style={{ maxHeight: 520, overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 320 }}>
                  <thead>
                    <tr>
                      {['Employee', 'Start', 'End', ''].map((label) => (
                        <th
                          key={label}
                          style={{
                            textAlign: 'left',
                            fontSize: '0.74rem',
                            color: 'var(--text-muted)',
                            padding: '0.65rem',
                            borderBottom: '1px solid var(--border)',
                            fontWeight: 700,
                            letterSpacing: '0.03em',
                          }}
                        >
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {manualShifts.map((row, idx) => (
                      <tr key={row.id} style={{ background: idx % 2 === 0 ? '#fbfcff' : 'transparent' }}>
                        <td style={{ padding: '0.6rem', borderBottom: '1px solid var(--border)' }}>
                          <input
                            type="text"
                            value={row.employeeName}
                            onChange={(event) => updateManualShift(row.id, { employeeName: event.target.value })}
                            style={{
                              width: '100%',
                              border: '1px solid var(--border)',
                              borderRadius: 8,
                              background: '#ffffff',
                              color: 'var(--text-primary)',
                              padding: '0.36rem 0.45rem',
                              fontSize: '0.8rem',
                            }}
                          />
                        </td>
                        <td style={{ padding: '0.6rem', borderBottom: '1px solid var(--border)' }}>
                          <input
                            type="time"
                            value={row.startTime}
                            onChange={(event) => updateManualShift(row.id, { startTime: event.target.value })}
                            style={{
                              border: '1px solid var(--border)',
                              borderRadius: 8,
                              background: '#ffffff',
                              color: 'var(--text-primary)',
                              padding: '0.35rem 0.4rem',
                              fontSize: '0.78rem',
                            }}
                          />
                        </td>
                        <td style={{ padding: '0.6rem', borderBottom: '1px solid var(--border)' }}>
                          <input
                            type="time"
                            value={row.endTime}
                            onChange={(event) => updateManualShift(row.id, { endTime: event.target.value })}
                            style={{
                              border: '1px solid var(--border)',
                              borderRadius: 8,
                              background: '#ffffff',
                              color: 'var(--text-primary)',
                              padding: '0.35rem 0.4rem',
                              fontSize: '0.78rem',
                            }}
                          />
                        </td>
                        <td style={{ padding: '0.6rem', borderBottom: '1px solid var(--border)' }}>
                          <Button variant="outline" size="sm" onClick={() => removeManualShift(row.id)} disabled={manualShifts.length <= 1}>
                            Remove
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div style={{ border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg-glass)', overflow: 'hidden' }}>
              <div style={{ padding: '0.85rem 1rem', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>Break Assignments</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    {isDayLoading ? 'Refreshing...' : `${dayRows.length} shift rows loaded`}
                  </div>
                </div>
              </div>
              {dayRows.length === 0 ? (
                <div style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.88rem' }}>
                  Generate assignments to populate this grid.
                </div>
              ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 980 }}>
                  <thead>
                    <tr>
                      {['Employee', 'Shift', 'Break 1', 'Lunch', 'Break 2', 'Actions'].map((label) => (
                        <th
                          key={label}
                          style={{
                            textAlign: 'left',
                            fontSize: '0.76rem',
                            color: 'var(--text-muted)',
                            padding: '0.7rem',
                            borderBottom: '1px solid var(--border)',
                            fontWeight: 700,
                            letterSpacing: '0.03em',
                          }}
                        >
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {dayRows.map((row, idx) => (
                      <tr key={row.shiftId} style={{ background: idx % 2 === 0 ? '#fbfcff' : 'transparent' }}>
                        <td style={{ padding: '0.7rem', borderBottom: '1px solid var(--border)' }}>
                          <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{row.employeeName}</div>
                          <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>{row.userId ? 'Assigned' : 'Open shift'}</div>
                        </td>
                        <td style={{ padding: '0.7rem', borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
                          {toDisplayShift(row.startTime, row.endTime)}
                        </td>
                        {BREAK_KEYS.map((key) => {
                          const current = row[key];
                          const minimumDuration = key === 'lunch' ? 15 : 5;
                          return (
                            <td key={`${row.shiftId}-${key}`} style={{ padding: '0.7rem', borderBottom: '1px solid var(--border)' }}>
                              <div style={{ display: 'grid', gap: 6 }}>
                                <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                                  <input
                                    type="checkbox"
                                    checked={current.skipped}
                                    disabled={row.saving}
                                    onChange={(event) => updateBreak(row.shiftId, key, { skipped: event.target.checked })}
                                  />
                                  Skip
                                </label>
                                <input
                                  type="time"
                                  value={current.time}
                                  disabled={current.skipped || row.saving}
                                  onChange={(event) => updateBreak(row.shiftId, key, { time: event.target.value })}
                                  style={{
                                    border: '1px solid var(--border)',
                                    borderRadius: 8,
                                    background: '#ffffff',
                                    color: 'var(--text-primary)',
                                    padding: '0.35rem 0.45rem',
                                    fontSize: '0.8rem',
                                  }}
                                />
                                <input
                                  type="number"
                                  min={minimumDuration}
                                  value={current.durationMinutes}
                                  disabled={current.skipped || row.saving}
                                  onChange={(event) =>
                                    updateBreak(row.shiftId, key, {
                                      durationMinutes: Number(event.target.value),
                                    })
                                  }
                                  style={{
                                    border: '1px solid var(--border)',
                                    borderRadius: 8,
                                    background: '#ffffff',
                                    color: 'var(--text-primary)',
                                    padding: '0.35rem 0.45rem',
                                    fontSize: '0.8rem',
                                  }}
                                />
                              </div>
                            </td>
                          );
                        })}
                        <td style={{ padding: '0.7rem', borderBottom: '1px solid var(--border)' }}>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            <Button
                              size="sm"
                              onClick={() => void saveRow(row.shiftId)}
                              disabled={!row.dirty || row.saving}
                            >
                              {row.saving ? 'Saving...' : 'Save'}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => resetRow(row.shiftId)}
                              disabled={!row.dirty || row.saving}
                            >
                              Reset
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              )}
              <div style={{ padding: '0.75rem 1rem', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end' }}>
                <Button variant="secondary" size="sm" onClick={saveAllDirtyRows} disabled={dirtyCount === 0}>
                  {dirtyCount > 0 ? `Save ${dirtyCount} Changes` : 'Save Changes'}
                </Button>
              </div>
            </div>
          </div>

          <details style={{ border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg-glass)', padding: '0.8rem 0.9rem' }}>
            <summary style={{ cursor: 'pointer', color: 'var(--text-primary)', fontWeight: 700 }}>
              Advanced
            </summary>
            <div style={{ marginTop: '0.75rem', display: 'grid', gap: '0.9rem' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' }}>
                <div style={{ padding: '0.75rem', border: '1px solid var(--border)', borderRadius: 10, background: '#f7f9ff' }}>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Access Source</div>
                  <div style={{ fontWeight: 700, color: 'var(--text-primary)', textTransform: 'capitalize' }}>{lunchBreakFeature.source}</div>
                </div>
                <div style={{ padding: '0.75rem', border: '1px solid var(--border)', borderRadius: 10, background: '#f7f9ff' }}>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Usage Credits</div>
                  <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{features?.usageCredits ?? 0}</div>
                </div>
                <div style={{ padding: '0.75rem', border: '1px solid var(--border)', borderRadius: 10, background: '#f7f9ff' }}>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Credit Cost / Run</div>
                  <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{lunchBreakFeature.creditCost ?? 0}</div>
                </div>
                <div style={{ padding: '0.75rem', border: '1px solid var(--border)', borderRadius: 10, background: '#f7f9ff' }}>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Scheduling Link</div>
                  <div style={{ fontWeight: 700, color: hasSharedScheduleData ? 'var(--emerald)' : 'var(--text-primary)' }}>
                    {hasSharedScheduleData ? `${dayRows.length} shifts linked` : 'No linked shifts'}
                  </div>
                </div>
              </div>

              <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)' }}>Policy</div>
                  <Button variant="outline" size="sm" onClick={() => setShowAdvancedPolicy((prev) => !prev)}>
                    {showAdvancedPolicy ? 'Hide Policy Fields' : 'Edit Policy'}
                  </Button>
                </div>
                {showAdvancedPolicy ? (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem', marginTop: '0.75rem' }}>
                      {policyFields.map((field) => (
                        <label key={field.key} style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{field.label}</span>
                          <input
                            type="number"
                            value={policy[field.key]}
                            min={1}
                            onChange={(event) =>
                              setPolicy((prev) => ({
                                ...prev,
                                [field.key]: Number(event.target.value),
                              }))
                            }
                            style={{
                              background: '#ffffff',
                              border: '1px solid var(--border)',
                              borderRadius: 8,
                              color: 'var(--text-primary)',
                              padding: '0.45rem 0.65rem',
                            }}
                          />
                        </label>
                      ))}
                    </div>
                    <div style={{ marginTop: '0.75rem' }}>
                      <Button variant="secondary" size="sm" onClick={handleSavePolicy} disabled={isSavingPolicy}>
                        {isSavingPolicy ? 'Saving...' : 'Save Policy'}
                      </Button>
                    </div>
                  </>
                ) : null}
              </div>
              {lastRun ? (
                <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem', color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
                  Last run: <strong>{lastRun.source}</strong>
                  {' · '}
                  Persisted: <strong>{lastRun.persisted ? 'yes' : 'no'}</strong>
                  {' · '}
                  Credits used: <strong>{lastRun.creditConsumption.consumedCredits}</strong>
                </div>
              ) : null}
            </div>
          </details>
        </>
      ) : null}

      {error ? (
        <div style={{ padding: '0.8rem 0.9rem', borderRadius: 10, border: '1px solid rgba(244,63,94,0.35)', color: '#fda4af' }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}
