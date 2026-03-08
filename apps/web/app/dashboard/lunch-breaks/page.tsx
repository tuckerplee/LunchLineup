'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import type { StaffScheduleEvent } from '@/components/scheduling/StaffScheduler';
import { fetchWithSession } from '@/lib/client-api';

const StaffScheduler = dynamic(
  () => import('@/components/scheduling/StaffScheduler').then((m) => m.StaffScheduler),
  {
    ssr: false,
    loading: () => (
      <div className="surface-card" style={{ minHeight: 520, padding: '1rem' }}>
        <div className="skeleton" style={{ height: 24, width: 220, marginBottom: '1rem' }} />
        <div className="skeleton" style={{ height: 420, width: '100%' }} />
      </div>
    ),
  },
);

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

type TimelineResource = {
  id: string;
  title: string;
  role: string;
  avatarInitials: string;
  hue: number;
};

type PlanPreviewSegment = {
  id: string;
  label: string;
  tone: 'meal' | 'break';
  leftPct: number;
  widthPct: number;
};

type PlanPreviewRow = {
  id: string;
  employeeName: string;
  shiftLabel: string;
  segments: PlanPreviewSegment[];
};

const BREAK_KEYS: BreakEditorKey[] = ['break1', 'lunch', 'break2'];

const BREAK_META: Record<BreakEditorKey, { label: string; minimumDuration: number }> = {
  break1: { label: 'Break 1', minimumDuration: 5 },
  lunch: { label: 'Meal', minimumDuration: 15 },
  break2: { label: 'Break 2', minimumDuration: 5 },
};

const POLICY_FIELDS = [
  { key: 'break1OffsetMinutes', label: 'Break 1 Offset (min)' },
  { key: 'lunchOffsetMinutes', label: 'Lunch Offset (min)' },
  { key: 'break2OffsetMinutes', label: 'Break 2 Offset (min)' },
  { key: 'break1DurationMinutes', label: 'Break 1 Duration (min)' },
  { key: 'lunchDurationMinutes', label: 'Lunch Duration (min)' },
  { key: 'break2DurationMinutes', label: 'Break 2 Duration (min)' },
  { key: 'timeStepMinutes', label: 'Conflict Step (min)' },
] as const;

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

function startOfWeek(dateValue: string): string {
  const [year, month, day] = dateValue.split('-').map((part) => Number(part));
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() - date.getDay());
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

function getInitials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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

function breakStatusLabel(current: EditableBreak): string {
  if (current.skipped) return 'Skipped';
  if (!current.time) return 'Missing time';
  return `${current.time} · ${current.durationMinutes}m`;
}

export default function LunchBreaksPage() {
  const [features, setFeatures] = useState<FeatureMatrixResponse | null>(null);
  const [policy, setPolicy] = useState<LunchBreakPolicy>(DEFAULT_POLICY);
  const [policyLoaded, setPolicyLoaded] = useState<LunchBreakPolicy>(DEFAULT_POLICY);
  const [selectedDate, setSelectedDate] = useState<string>(toDateInputValue(new Date()));
  const [dayRows, setDayRows] = useState<DayShiftRow[]>([]);
  const [baselines, setBaselines] = useState<Record<string, DayShiftRow>>({});
  const [lastRun, setLastRun] = useState<GenerateResponse | null>(null);
  const [selectedShiftId, setSelectedShiftId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isDayLoading, setIsDayLoading] = useState(false);
  const [isSavingPolicy, setIsSavingPolicy] = useState(false);
  const [isGeneratingDay, setIsGeneratingDay] = useState(false);
  const [isGeneratingManual, setIsGeneratingManual] = useState(false);
  const [manualShifts, setManualShifts] = useState<ManualShiftRow[]>(defaultManualShifts());
  const [plannerMode, setPlannerMode] = useState<'auto' | 'manual' | null>(null);
  const [autoGuideStep, setAutoGuideStep] = useState<1 | 2 | 3 | 4>(1);
  const [error, setError] = useState<string | null>(null);
  const initialSelectedDateRef = useRef(selectedDate);

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

  const loadDayRows = useCallback(async (dateValue: string, policyValue: LunchBreakPolicy): Promise<DayShiftRow[]> => {
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
      return rows;
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
        await loadDayRows(initialSelectedDateRef.current, policyData);
      } else {
        setDayRows([]);
        setBaselines({});
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  }, [loadFeatures, loadPolicy, loadDayRows]);

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
      if (!ok) break;
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

  useEffect(() => {
    setSelectedShiftId((current) => {
      if (dayRows.length === 0) return null;
      if (current && dayRows.some((row) => row.shiftId === current)) return current;
      return dayRows[0].shiftId;
    });
  }, [dayRows]);

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
  const mealRiskCount = dayRows.filter((row) => row.lunch.skipped || !row.lunch.time).length;
  const breakRiskCount = dayRows.filter(
    (row) =>
      (!row.break1.skipped && !row.break1.time) ||
      (!row.break2.skipped && !row.break2.time),
  ).length;
  const mealsAssignedCount = dayRows.filter((row) => !row.lunch.skipped && Boolean(row.lunch.time)).length;
  const breaksAssignedCount = dayRows.reduce((count, row) => {
    const break1Assigned = !row.break1.skipped && Boolean(row.break1.time) ? 1 : 0;
    const break2Assigned = !row.break2.skipped && Boolean(row.break2.time) ? 1 : 0;
    return count + break1Assigned + break2Assigned;
  }, 0);
  const complianceRiskCount = dayRows.filter(
    (row) =>
      row.lunch.skipped ||
      !row.lunch.time ||
      (!row.break1.skipped && !row.break1.time) ||
      (!row.break2.skipped && !row.break2.time),
  ).length;

  const runPrimaryGeneration = useCallback(() => {
    if (plannerMode === 'auto') {
      void generateForSelectedDay();
      return;
    }
    if (plannerMode === 'manual') {
      void generateFromManualShifts();
      return;
    }
  }, [generateForSelectedDay, generateFromManualShifts, plannerMode]);

  const timelineResources = useMemo<TimelineResource[]>(
    () =>
      dayRows.map((row) => ({
        id: row.shiftId,
        title: row.employeeName,
        role: row.userId ? 'Assigned' : 'Open shift',
        avatarInitials: getInitials(row.employeeName),
        hue: hueForName(row.employeeName),
      })),
    [dayRows],
  );

  const timelineEvents = useMemo<StaffScheduleEvent[]>(() => {
    return dayRows.flatMap((row) => {
      const events: StaffScheduleEvent[] = [
        {
          id: row.shiftId,
          resourceId: row.shiftId,
          title: row.userId ? 'Assigned shift' : 'Open shift',
          start: row.startTime,
          end: row.endTime,
          extendedProps: { role: row.userId ? 'MANAGER' : 'DEFAULT' },
        },
      ];

      for (const key of BREAK_KEYS) {
        const current = row[key];
        if (current.skipped || !current.time) continue;
        const resolvedStart = resolveShiftIsoForTime(row.startTime, row.endTime, current.time);
        if (!resolvedStart) continue;
        const end = new Date(resolvedStart);
        end.setMinutes(end.getMinutes() + Math.max(1, current.durationMinutes || 0));
        events.push({
          id: `${row.shiftId}-${key}`,
          resourceId: row.shiftId,
          title: BREAK_META[key].label,
          start: resolvedStart,
          end: end.toISOString(),
          extendedProps: {
            role: row.userId ? 'MANAGER' : 'DEFAULT',
            kind: key === 'lunch' ? 'lunch' : 'break',
          },
        });
      }

      return events;
    });
  }, [dayRows]);

  const selectedRow = useMemo(() => {
    if (!selectedShiftId) return null;
    return dayRows.find((row) => row.shiftId === selectedShiftId) ?? null;
  }, [dayRows, selectedShiftId]);

  const standalonePreview = useMemo(
    () => (lastRun?.source === 'standalone' ? lastRun.data : []),
    [lastRun],
  );

  const previewRows = useMemo<PlanPreviewRow[]>(() => {
    if (plannerMode === 'auto') {
      return dayRows.map((row) => {
        const shiftStartMs = new Date(row.startTime).getTime();
        const shiftEndMs = new Date(row.endTime).getTime();
        const shiftDurationMs = Math.max(1, shiftEndMs - shiftStartMs);

        const segments: PlanPreviewSegment[] = BREAK_KEYS.flatMap((key) => {
          const current = row[key];
          if (current.skipped || !current.time) return [];
          const startIso = resolveShiftIsoForTime(row.startTime, row.endTime, current.time);
          if (!startIso) return [];
          const startMs = new Date(startIso).getTime();
          const endMs = startMs + Math.max(1, current.durationMinutes) * 60 * 1000;
          const leftPct = ((startMs - shiftStartMs) / shiftDurationMs) * 100;
          const widthPct = ((endMs - startMs) / shiftDurationMs) * 100;

          return [{
            id: `${row.shiftId}-${key}`,
            label: BREAK_META[key].label,
            tone: key === 'lunch' ? 'meal' : 'break',
            leftPct: clamp(leftPct, 0, 96),
            widthPct: clamp(widthPct, 4, 100),
          }];
        });

        return {
          id: row.shiftId,
          employeeName: row.employeeName,
          shiftLabel: toDisplayShift(row.startTime, row.endTime),
          segments,
        };
      });
    }

    return standalonePreview.map((row, index) => {
      const shiftStartMs = new Date(row.startTime).getTime();
      const shiftEndMs = new Date(row.endTime).getTime();
      const shiftDurationMs = Math.max(1, shiftEndMs - shiftStartMs);

      const segments: PlanPreviewSegment[] = row.breaks.map((item, breakIndex) => {
        const startMs = new Date(item.startTime).getTime();
        const endMs = new Date(item.endTime).getTime();
        const leftPct = ((startMs - shiftStartMs) / shiftDurationMs) * 100;
        const widthPct = ((endMs - startMs) / shiftDurationMs) * 100;

        return {
          id: `${index}-${breakIndex}-${item.type}`,
          label: item.type === 'lunch' ? 'Meal' : 'Break',
          tone: item.type === 'lunch' ? 'meal' : 'break',
          leftPct: clamp(leftPct, 0, 96),
          widthPct: clamp(widthPct, 4, 100),
        };
      });

      return {
        id: row.shiftId ?? `preview-${index}`,
        employeeName: row.employeeName ?? 'Unassigned',
        shiftLabel: toDisplayShift(row.startTime, row.endTime),
        segments,
      };
    });
  }, [dayRows, plannerMode, standalonePreview]);

  const isAutoMode = plannerMode === 'auto';
  const isManualMode = plannerMode === 'manual';
  const isGeneratingPrimary = isAutoMode ? isGeneratingDay : isManualMode ? isGeneratingManual : false;
  const statusShiftsCount = isAutoMode ? dayRows.length : standalonePreview.length;
  const statusMealsAssigned = isAutoMode
    ? mealsAssignedCount
    : standalonePreview.reduce((count, row) => count + row.breaks.filter((entry) => entry.type === 'lunch').length, 0);
  const statusBreaksAssigned = isAutoMode
    ? breaksAssignedCount
    : standalonePreview.reduce(
      (count, row) => count + row.breaks.filter((entry) => entry.type === 'break1' || entry.type === 'break2').length,
      0,
    );
  const statusComplianceRisk = isAutoMode
    ? complianceRiskCount
    : standalonePreview.reduce(
      (count, row) => (row.breaks.some((entry) => entry.type === 'lunch') ? count : count + 1),
      0,
    );

  const weeklyPickerDays = useMemo(() => {
    const weekStart = startOfWeek(selectedDate);
    return Array.from({ length: 7 }, (_, index) => shiftDate(weekStart, index));
  }, [selectedDate]);

  const choosePlannerMode = useCallback((mode: 'auto' | 'manual') => {
    setPlannerMode(mode);
    setAutoGuideStep(mode === 'auto' ? 2 : 4);
  }, []);

  const showGuidedWindow =
    !isLoading && Boolean(lunchBreakFeature?.enabled) && (plannerMode === null || (isAutoMode && autoGuideStep < 4));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', minHeight: '100%' }}>
      {!showGuidedWindow ? (
        <section
          className="surface-card"
          style={{ padding: '1rem' }}
        >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto',
            gap: '0.8rem',
            alignItems: 'start',
          }}
        >
          <div>
            <div className="workspace-kicker">Lunch & breaks workspace</div>
            <h1 className="workspace-title" style={{ fontSize: '1.58rem', marginBottom: 2 }}>
              Lunch & Break Planner
            </h1>
            <p className="workspace-subtitle">Generate compliant lunches and staggered breaks for the selected day.</p>
            <div style={{ marginTop: 4, fontSize: '0.78rem', color: 'var(--text-muted)', fontWeight: 700 }}>
              {selectedDateLabel} break plan
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <Button variant="outline" size="sm" onClick={() => setSelectedDate(shiftDate(selectedDate, -1))}>Prev Day</Button>
              <input
                type="date"
                value={selectedDate}
                onChange={(event) => setSelectedDate(event.target.value)}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  background: '#ffffff',
                  color: 'var(--text-primary)',
                  padding: '0.38rem 0.55rem',
                  fontSize: '0.8rem',
                }}
              />
              <Button variant="outline" size="sm" onClick={() => setSelectedDate(toDateInputValue(new Date()))}>Today</Button>
              <Button variant="outline" size="sm" onClick={() => setSelectedDate(shiftDate(selectedDate, 1))}>Next Day</Button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setPlannerMode(null);
                  setAutoGuideStep(1);
                }}
                disabled={!lunchBreakFeature?.enabled}
              >
                Switch mode
              </Button>
              <Button
                size="sm"
                variant="default"
                onClick={runPrimaryGeneration}
                disabled={
                  isGeneratingPrimary ||
                  isLoading ||
                  !lunchBreakFeature?.enabled ||
                  plannerMode === null
                }
                style={{ minWidth: 250 }}
              >
                {isGeneratingPrimary ? 'Generating plan...' : 'Generate Lunch & Break Plan'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void saveAllDirtyRows()} disabled={dirtyCount === 0}>
                {dirtyCount > 0 ? `Save ${dirtyCount} changes` : 'Save changes'}
              </Button>
            </div>
            <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
              Uses current shifts and policy to generate staggered lunches and breaks.
            </div>
          </div>
        </div>

        <div style={{ marginTop: '0.85rem', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <div className="surface-muted" style={{ padding: '0.38rem 0.58rem', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
            Shifts loaded: <strong style={{ color: 'var(--text-primary)' }}>{statusShiftsCount}</strong>
          </div>
          <div className="surface-muted" style={{ padding: '0.38rem 0.58rem', fontSize: '0.78rem', color: statusMealsAssigned > 0 ? '#166534' : '#b45309' }}>
            Meals assigned: <strong>{statusMealsAssigned}</strong>
          </div>
          <div className="surface-muted" style={{ padding: '0.38rem 0.58rem', fontSize: '0.78rem', color: statusBreaksAssigned > 0 ? '#166534' : '#b45309' }}>
            Breaks assigned: <strong>{statusBreaksAssigned}</strong>
          </div>
          <div className="surface-muted" style={{ padding: '0.38rem 0.58rem', fontSize: '0.78rem', color: statusComplianceRisk > 0 ? '#b45309' : '#166534' }}>
            Compliance risks: <strong>{statusComplianceRisk}</strong>
          </div>
          <div className="surface-muted" style={{ padding: '0.38rem 0.58rem', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
            {isDayLoading ? 'Refreshing shifts...' : `${dayRows.length} shifts in view`}
          </div>
          <div className="surface-muted" style={{ padding: '0.38rem 0.58rem', fontSize: '0.78rem', color: mealRiskCount > 0 ? '#b45309' : '#166534' }}>
            {mealRiskCount > 0 ? `${mealRiskCount} meal windows missing` : 'Meals covered'}
          </div>
          <div className="surface-muted" style={{ padding: '0.38rem 0.58rem', fontSize: '0.78rem', color: breakRiskCount > 0 ? '#b45309' : '#166534' }}>
            {breakRiskCount > 0 ? `${breakRiskCount} break timings unresolved` : 'Break timings healthy'}
          </div>
        </div>

        {lastRun ? (
          <div
            style={{
              marginTop: '0.75rem',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '0.4rem 0.62rem',
              borderRadius: 10,
              border: '1px solid #cfe0ff',
              background: '#edf3ff',
              color: '#234ed9',
              fontSize: '0.78rem',
              fontWeight: 700,
            }}
          >
            Last run: {lastRun.source} · persisted {lastRun.persisted ? 'yes' : 'no'} · credits {lastRun.creditConsumption.consumedCredits}
          </div>
        ) : null}

        {previewRows.length > 0 ? (
          <div className="surface-muted" style={{ marginTop: '0.75rem', padding: '0.65rem', display: 'grid', gap: 6 }}>
            <div style={{ fontWeight: 800, color: 'var(--text-primary)', fontSize: '0.8rem' }}>Plan preview</div>
            {previewRows.slice(0, 4).map((row) => (
              <div key={row.id} style={{ display: 'grid', gridTemplateColumns: '140px minmax(0, 1fr) auto', gap: 8, alignItems: 'center' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '0.76rem', fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {row.employeeName}
                  </div>
                </div>
                <div style={{ position: 'relative', height: 18, borderRadius: 999, background: '#eaf0fb', border: '1px solid #d6e0f3' }}>
                  {row.segments.map((segment) => (
                    <span
                      key={segment.id}
                      title={segment.label}
                      style={{
                        position: 'absolute',
                        left: `${segment.leftPct}%`,
                        width: `${segment.widthPct}%`,
                        top: 2,
                        bottom: 2,
                        borderRadius: 999,
                        background: segment.tone === 'meal' ? '#9fd6a8' : '#9ac9f4',
                        border: segment.tone === 'meal' ? '1px solid #74b782' : '1px solid #6aa8de',
                      }}
                    />
                  ))}
                </div>
                <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', fontWeight: 700 }}>{row.shiftLabel}</div>
              </div>
            ))}
          </div>
        ) : null}
        </section>
      ) : null}

      {showGuidedWindow ? (
        <section
          className="surface-card"
          style={{
            minHeight: 'calc(100vh - 250px)',
            display: 'grid',
            placeItems: 'center',
            padding: '1.25rem',
          }}
        >
          <div style={{ width: 'min(880px, 100%)', display: 'grid', gap: 14 }}>
            <AnimatePresence mode="wait">
              {plannerMode === null ? (
                <motion.div
                  key="guide-step-1"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.22 }}
                  style={{ display: 'grid', gap: 14 }}
                >
                  <div style={{ textAlign: 'center', display: 'grid', gap: 6 }}>
                    <div className="workspace-kicker">Lunch & breaks</div>
                    <h2 className="workspace-title" style={{ margin: 0, fontSize: '1.45rem' }}>
                      Choose how to start today&apos;s plan
                    </h2>
                    <p className="workspace-subtitle" style={{ margin: 0 }}>
                      Select one workflow to continue.
                    </p>
                  </div>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                      gap: 12,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => choosePlannerMode('auto')}
                      style={{
                        textAlign: 'left',
                        border: '1px solid #cfe0ff',
                        borderRadius: 14,
                        background: 'linear-gradient(180deg, #f7faff 0%, #edf4ff 100%)',
                        padding: '1rem',
                        display: 'grid',
                        gap: 8,
                        cursor: 'pointer',
                      }}
                    >
                      <div style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--text-primary)' }}>Auto Break</div>
                      <div style={{ fontSize: '0.83rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                        Pull shifts from Scheduling and auto-build lunch and break assignments for {selectedDateLabel}.
                      </div>
                      <span style={{ color: '#234ed9', fontSize: '0.78rem', fontWeight: 800 }}>Use scheduling shifts</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => choosePlannerMode('manual')}
                      style={{
                        textAlign: 'left',
                        border: '1px solid var(--border)',
                        borderRadius: 14,
                        background: '#ffffff',
                        padding: '1rem',
                        display: 'grid',
                        gap: 8,
                        cursor: 'pointer',
                      }}
                    >
                      <div style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--text-primary)' }}>Manual Entry</div>
                      <div style={{ fontSize: '0.83rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                        Enter today&apos;s shifts directly on this page, then generate a lunch and break plan from manual data.
                      </div>
                      <span style={{ color: '#234ed9', fontSize: '0.78rem', fontWeight: 800 }}>Build from manual shifts</span>
                    </button>
                  </div>
                </motion.div>
              ) : null}

              {isAutoMode && autoGuideStep === 2 ? (
                <motion.div
                  key="guide-step-2"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.22 }}
                  style={{
                    width: 'min(640px, 100%)',
                    marginInline: 'auto',
                    border: '1px solid #cfe0ff',
                    borderRadius: 14,
                    background: 'linear-gradient(180deg, #f7faff 0%, #eef4ff 100%)',
                    padding: '1rem',
                    display: 'grid',
                    gap: 12,
                  }}
                >
                  <div className="workspace-kicker">Auto break setup</div>
                  <h2 style={{ margin: 0, fontSize: '1.2rem', color: 'var(--text-primary)' }}>
                    Choose the day you&apos;re planning.
                  </h2>
                  <p style={{ margin: 0, fontSize: '0.84rem', color: 'var(--text-secondary)' }}>
                    Select one day from this week to continue.
                  </p>
                  <div className="surface-muted" style={{ borderRadius: 12, padding: '0.75rem', display: 'grid', gap: 10 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 6 }}>
                      {weeklyPickerDays.map((dateValue) => {
                        const [y, m, d] = dateValue.split('-').map((part) => Number(part));
                        const date = new Date(y, m - 1, d);
                        const weekday = date.toLocaleDateString([], { weekday: 'short' });
                        const dayOfMonth = date.getDate();
                        const isActive = dateValue === selectedDate;
                        return (
                          <button
                            key={`weekly-pick-${dateValue}`}
                            type="button"
                            onClick={() => setSelectedDate(dateValue)}
                            style={{
                              border: isActive ? '1px solid #83a8ff' : '1px solid var(--border)',
                              background: isActive ? '#edf3ff' : '#ffffff',
                              color: isActive ? '#234ed9' : 'var(--text-primary)',
                              borderRadius: 10,
                              padding: '0.5rem 0.35rem',
                              fontSize: '0.8rem',
                              display: 'grid',
                              gap: 2,
                              placeItems: 'center',
                              cursor: 'pointer',
                              fontWeight: isActive ? 800 : 600,
                            }}
                          >
                            <span style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{weekday}</span>
                            <span>{dayOfMonth}</span>
                          </button>
                        );
                      })}
                    </div>
                    <div style={{ textAlign: 'center', display: 'grid', gap: 3 }}>
                      <div style={{ fontSize: '0.9rem', fontWeight: 800, color: 'var(--text-primary)' }}>{selectedDateLabel}</div>
                      <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>Downtown Bistro</div>
                      <div style={{ fontSize: '0.75rem', color: dayRows.length > 0 ? '#166534' : '#b45309' }}>
                        {dayRows.length > 0 ? `${dayRows.length} shifts available from Scheduling` : 'No shifts found yet for this day'}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                    <Button variant="outline" size="sm" onClick={() => { setPlannerMode(null); setAutoGuideStep(1); }}>
                      Back
                    </Button>
                    <Button size="sm" onClick={() => setAutoGuideStep(3)}>
                      Continue
                    </Button>
                  </div>
                </motion.div>
              ) : null}

              {isAutoMode && autoGuideStep === 3 ? (
                <motion.div
                  key="guide-step-3"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.22 }}
                  style={{
                    width: 'min(640px, 100%)',
                    marginInline: 'auto',
                    border: '1px solid #cfe0ff',
                    borderRadius: 14,
                    background: 'linear-gradient(180deg, #f7faff 0%, #eef4ff 100%)',
                    padding: '1rem',
                    display: 'grid',
                    gap: 12,
                  }}
                >
                  <div className="workspace-kicker">Auto break setup</div>
                  <h2 style={{ margin: 0, fontSize: '1.2rem', color: 'var(--text-primary)' }}>
                    Ready to create today&apos;s schedule
                  </h2>
                  <p style={{ margin: 0, fontSize: '0.84rem', color: 'var(--text-secondary)' }}>
                    We&apos;ll load shifts for {selectedDateLabel} from Scheduling and guide break placement in the planner.
                  </p>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                    <Button variant="outline" size="sm" onClick={() => setAutoGuideStep(2)}>
                      Back
                    </Button>
                    <Button size="sm" onClick={() => setAutoGuideStep(4)}>
                      Next
                    </Button>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </section>
      ) : null}

      {isLoading ? (
        <section className="surface-card" style={{ padding: '1rem', color: 'var(--text-muted)' }}>
          Loading lunch & break workspace...
        </section>
      ) : null}

      {!isLoading && lunchBreakFeature && !lunchBreakFeature.enabled ? (
        <section
          className="surface-card"
          style={{
            padding: '1rem',
            borderColor: 'rgba(244,63,94,0.35)',
            background: 'rgba(244,63,94,0.08)',
          }}
        >
          <div style={{ fontWeight: 800, color: '#fb7185' }}>Lunch & Breaks is locked</div>
          <div style={{ marginTop: 4, fontSize: '0.86rem', color: 'var(--text-secondary)' }}>{lunchBreakFeature.reason}</div>
        </section>
      ) : null}

      {!isLoading && lunchBreakFeature?.enabled && !showGuidedWindow ? (
        <section
          style={{
            minHeight: 620,
            height: 'calc(100vh - 250px)',
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) 340px',
            gap: '0.75rem',
          }}
        >
          <div className="surface-card" style={{ padding: '0.72rem', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {isAutoMode ? (
              <>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    flexWrap: 'wrap',
                    padding: '0 0.35rem',
                    fontSize: '0.8rem',
                    color: 'var(--text-secondary)',
                  }}
                >
                  <span>Using Scheduling shifts as source of truth for {selectedDateLabel}</span>
                  <span style={{ fontWeight: 700 }}>{dirtyCount > 0 ? `${dirtyCount} unsaved edits` : 'All edits saved'}</span>
                </div>
                <div style={{ minHeight: 0, flex: 1 }}>
                  {hasSharedRows ? (
                    <StaffScheduler
                      resources={timelineResources}
                      events={timelineEvents}
                      viewMode="day"
                      initialDate={selectedDate}
                      compactWindow
                      onEventSelect={(event) => {
                        if (event.extendedProps.kind) return;
                        setSelectedShiftId(event.id);
                      }}
                    />
                  ) : (
                    <div className="surface-muted" style={{ padding: '0.75rem' }}>
                      <div style={{ fontWeight: 800, color: 'var(--text-primary)', marginBottom: 2 }}>
                        No shifts loaded for {selectedDateLabel.split(',')[0]}
                      </div>
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                        Import shifts from Scheduling to generate lunches and breaks.
                      </div>
                      <div style={{ marginTop: 8 }}>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            void loadDayRows(selectedDate, policyLoaded).catch((err) => {
                              setError((err as Error).message);
                            });
                          }}
                        >
                          Import shifts from Scheduling
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div style={{ display: 'grid', gap: '0.72rem', minHeight: 0, overflowY: 'auto', padding: '0.1rem' }}>
                <div className="surface-muted" style={{ padding: '0.75rem' }}>
                  <div style={{ fontWeight: 800, color: 'var(--text-primary)', marginBottom: 2 }}>No shifts loaded for {selectedDateLabel.split(',')[0]}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                    Import shifts from Scheduling or add a quick scenario to generate a break plan.
                  </div>
                  <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        void loadDayRows(selectedDate, policyLoaded).catch((err) => {
                          setError((err as Error).message);
                        });
                      }}
                    >
                      Import shifts from Scheduling
                    </Button>
                    <Button variant="outline" size="sm" onClick={addManualShift}>
                      Add manual shifts
                    </Button>
                  </div>
                </div>

                <div style={{ display: 'grid', gap: 8 }}>
                  {manualShifts.map((row) => (
                    <div key={row.id} className="surface-muted" style={{ padding: '0.68rem', display: 'grid', gap: 8 }}>
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
                          fontSize: '0.82rem',
                        }}
                      />
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, alignItems: 'end' }}>
                        <label style={{ display: 'grid', gap: 4 }}>
                          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Start</span>
                          <input
                            type="time"
                            value={row.startTime}
                            onChange={(event) => updateManualShift(row.id, { startTime: event.target.value })}
                            style={{
                              border: '1px solid var(--border)',
                              borderRadius: 8,
                              background: '#ffffff',
                              color: 'var(--text-primary)',
                              padding: '0.34rem 0.4rem',
                              fontSize: '0.78rem',
                            }}
                          />
                        </label>
                        <label style={{ display: 'grid', gap: 4 }}>
                          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>End</span>
                          <input
                            type="time"
                            value={row.endTime}
                            onChange={(event) => updateManualShift(row.id, { endTime: event.target.value })}
                            style={{
                              border: '1px solid var(--border)',
                              borderRadius: 8,
                              background: '#ffffff',
                              color: 'var(--text-primary)',
                              padding: '0.34rem 0.4rem',
                              fontSize: '0.78rem',
                            }}
                          />
                        </label>
                        <Button variant="outline" size="sm" onClick={() => removeManualShift(row.id)} disabled={manualShifts.length <= 1}>
                          Remove shift
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Button size="sm" onClick={() => void generateFromManualShifts()} disabled={isGeneratingManual}>
                    {isGeneratingManual ? 'Generating...' : 'Generate Lunch & Break Plan'}
                  </Button>
                  <Button variant="outline" size="sm" onClick={addManualShift}>
                    Add shift
                  </Button>
                </div>

                {standalonePreview.length > 0 ? (
                  <div className="surface-muted" style={{ padding: '0.75rem', display: 'grid', gap: 6 }}>
                    <div style={{ fontWeight: 800, fontSize: '0.84rem', color: 'var(--text-primary)' }}>Standalone preview</div>
                    {standalonePreview.map((row, idx) => (
                      <div key={`preview-${row.employeeName ?? 'shift'}-${idx}`} style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                        <strong style={{ color: 'var(--text-primary)' }}>{row.employeeName ?? 'Unassigned'}</strong>
                        {' · '}
                        {toDisplayShift(row.startTime, row.endTime)}
                        {' · '}
                        {row.breaks.length} planned break(s)
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <aside className="surface-card" style={{ padding: '0.85rem', display: 'flex', flexDirection: 'column', gap: '0.72rem', overflowY: 'auto' }}>
            <h3 style={{ margin: 0, fontSize: '0.92rem', fontWeight: 800 }}>Assignment inspector</h3>

            {isAutoMode && hasSharedRows ? (
              selectedRow ? (
                <>
                  <div className="surface-muted" style={{ padding: '0.72rem', display: 'grid', gap: 4 }}>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      {selectedRow.employeeName}
                    </div>
                    <div style={{ fontSize: '0.86rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                      {toDisplayShift(selectedRow.startTime, selectedRow.endTime)}
                    </div>
                    <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>
                      {selectedRow.userId ? 'Linked from scheduling shift' : 'Open shift assignment'}
                    </div>
                  </div>

                  <div style={{ display: 'grid', gap: 8 }}>
                    {BREAK_KEYS.map((key) => {
                      const current = selectedRow[key];
                      const info = BREAK_META[key];
                      return (
                        <div key={`${selectedRow.shiftId}-${key}`} className="surface-muted" style={{ padding: '0.62rem', display: 'grid', gap: 6 }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                            <strong style={{ fontSize: '0.8rem', color: 'var(--text-primary)' }}>{info.label}</strong>
                            <span style={{ fontSize: '0.72rem', color: current.skipped || !current.time ? '#b45309' : '#166534' }}>
                              {breakStatusLabel(current)}
                            </span>
                          </div>
                          <label style={{ fontSize: '0.74rem', color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <input
                              type="checkbox"
                              checked={current.skipped}
                              disabled={selectedRow.saving}
                              onChange={(event) => updateBreak(selectedRow.shiftId, key, { skipped: event.target.checked })}
                            />
                            Skip {info.label.toLowerCase()}
                          </label>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px', gap: 6 }}>
                            <input
                              type="time"
                              value={current.time}
                              disabled={current.skipped || selectedRow.saving}
                              onChange={(event) => updateBreak(selectedRow.shiftId, key, { time: event.target.value })}
                              style={{
                                border: '1px solid var(--border)',
                                borderRadius: 8,
                                background: '#ffffff',
                                color: 'var(--text-primary)',
                                padding: '0.34rem 0.42rem',
                                fontSize: '0.78rem',
                              }}
                            />
                            <input
                              type="number"
                              min={info.minimumDuration}
                              value={current.durationMinutes}
                              disabled={current.skipped || selectedRow.saving}
                              onChange={(event) =>
                                updateBreak(selectedRow.shiftId, key, {
                                  durationMinutes: Number(event.target.value),
                                })
                              }
                              style={{
                                border: '1px solid var(--border)',
                                borderRadius: 8,
                                background: '#ffffff',
                                color: 'var(--text-primary)',
                                padding: '0.34rem 0.42rem',
                                fontSize: '0.78rem',
                              }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div style={{ display: 'flex', gap: 6 }}>
                    <Button size="sm" onClick={() => void saveRow(selectedRow.shiftId)} disabled={!selectedRow.dirty || selectedRow.saving}>
                      {selectedRow.saving ? 'Saving...' : 'Save shift'}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => resetRow(selectedRow.shiftId)} disabled={!selectedRow.dirty || selectedRow.saving}>
                      Reset
                    </Button>
                  </div>
                </>
              ) : (
                <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  Select a shift in the timeline to edit meal and break placement.
                </p>
              )
            ) : (
              <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                Generate from manual shifts to preview assignments, or sync Scheduling shifts to unlock direct editing.
              </p>
            )}

            <details style={{ borderTop: '1px solid var(--border)', paddingTop: '0.72rem' }}>
              <summary style={{ cursor: 'pointer', fontSize: '0.84rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                Planning settings
              </summary>
              <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  {POLICY_FIELDS.map((field) => (
                    <label key={field.key} style={{ display: 'grid', gap: 4 }}>
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{field.label}</span>
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
                          padding: '0.36rem 0.48rem',
                          fontSize: '0.78rem',
                        }}
                      />
                    </label>
                  ))}
                </div>
                <Button variant="secondary" size="sm" onClick={handleSavePolicy} disabled={isSavingPolicy}>
                  {isSavingPolicy ? 'Saving...' : 'Save policy'}
                </Button>

                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8, fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                  <div>Access source: <strong style={{ textTransform: 'capitalize' }}>{lunchBreakFeature.source}</strong></div>
                  <div>Usage credits: <strong>{features?.usageCredits ?? 0}</strong></div>
                  <div>Credit cost/run: <strong>{lunchBreakFeature.creditCost ?? 0}</strong></div>
                  <div>Scheduling link: <strong>{hasSharedScheduleData ? `${dayRows.length} linked shifts` : 'No linked shifts'}</strong></div>
                </div>
              </div>
            </details>
          </aside>
        </section>
      ) : null}

      {error ? (
        <div
          style={{
            padding: '0.8rem 0.9rem',
            borderRadius: 10,
            border: '1px solid rgba(244,63,94,0.35)',
            color: '#fda4af',
            background: 'rgba(244,63,94,0.06)',
          }}
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
