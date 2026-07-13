'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  demandWindowDraft,
  emptyDemandWindowDraft,
  serializeDemandWindowDrafts,
  type DemandWindowDraft,
  type DemandWindowRecord,
} from './demand-window-contract';

type Props = {
  scheduleId: string;
  timeZone: string;
  disabled?: boolean;
  loadWindows: (scheduleId: string) => Promise<DemandWindowRecord[]>;
  saveWindows: (scheduleId: string, windows: Array<Omit<DemandWindowRecord, 'id'>>) => Promise<DemandWindowRecord[]>;
};

export function DemandWindowEditor({ scheduleId, timeZone, disabled, loadWindows, saveWindows }: Props) {
  const [drafts, setDrafts] = useState<DemandWindowDraft[]>([]);
  const [status, setStatus] = useState('Loading demand...');
  const [loading, setLoading] = useState(true);
  const [hydrated, setHydrated] = useState(false);
  const [saving, setSaving] = useState(false);
  const loadRequestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    setHydrated(false);
    setStatus('Loading demand...');
    try {
      const windows = await loadWindows(scheduleId);
      if (requestId !== loadRequestRef.current) return;
      setDrafts(windows.map((window) => demandWindowDraft(window, timeZone)));
      setStatus(windows.length ? `${windows.length} demand window${windows.length === 1 ? '' : 's'} saved.` : 'Demand setup required.');
      setHydrated(true);
    } catch (error) {
      if (requestId !== loadRequestRef.current) return;
      setStatus(`${(error as Error).message} Existing demand has not been replaced.`);
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false);
    }
  }, [loadWindows, scheduleId, timeZone]);

  useEffect(() => {
    setDrafts([]);
    void load();
    return () => { loadRequestRef.current += 1; };
  }, [load]);

  const updateDraft = (key: string, field: keyof DemandWindowDraft, value: string) => {
    if (!hydrated) return;
    setDrafts((current) => current.map((draft) => draft.key === key ? { ...draft, [field]: value } : draft));
  };

  const persist = async () => {
    if (!hydrated) return;
    setSaving(true);
    try {
      const payload = serializeDemandWindowDrafts(drafts, timeZone);
      const saved = await saveWindows(scheduleId, payload);
      setDrafts(saved.map((window) => demandWindowDraft(window, timeZone)));
      setStatus(saved.length ? `${saved.length} demand window${saved.length === 1 ? '' : 's'} saved.` : 'Demand setup required.');
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const locked = Boolean(disabled) || loading || saving || !hydrated;

  return (
    <div className="demand-editor" aria-label="Schedule demand setup">
      <div className="demand-editor__header">
        <strong>Demand</strong>
        <span role="status">{status}</span>
        {!loading && !hydrated ? (
          <Button size="sm" variant="outline" onClick={() => void load()}>
            <RefreshCw size={14} /> Retry demand load
          </Button>
        ) : null}
        <Button size="sm" variant="outline" onClick={() => setDrafts((current) => [...current, emptyDemandWindowDraft(globalThis.crypto.randomUUID())])} disabled={locked}>
          <Plus size={14} /> Add window
        </Button>
      </div>
      {drafts.map((draft) => (
        <div className="demand-editor__row" key={draft.key}>
          <label><span>Date</span><input type="date" value={draft.date} onChange={(event) => updateDraft(draft.key, 'date', event.target.value)} disabled={locked} /></label>
          <label><span>Start</span><input type="time" value={draft.startTime} onChange={(event) => updateDraft(draft.key, 'startTime', event.target.value)} disabled={locked} /></label>
          <label><span>End</span><input type="time" value={draft.endTime} onChange={(event) => updateDraft(draft.key, 'endTime', event.target.value)} disabled={locked} /></label>
          <label><span>Staff</span><input type="number" min="1" max="200" value={draft.requiredStaff} onChange={(event) => updateDraft(draft.key, 'requiredStaff', event.target.value)} disabled={locked} /></label>
          <label><span>Skill</span><input type="text" maxLength={128} value={draft.skill} onChange={(event) => updateDraft(draft.key, 'skill', event.target.value)} disabled={locked} /></label>
          <Button size="icon" variant="ghost" aria-label="Remove demand window" title="Remove demand window" onClick={() => setDrafts((current) => current.filter((item) => item.key !== draft.key))} disabled={locked}><Trash2 size={15} /></Button>
        </div>
      ))}
      <div className="demand-editor__actions">
        <Button size="sm" onClick={() => void persist()} disabled={locked}><Save size={14} /> {saving ? 'Saving...' : 'Save demand'}</Button>
      </div>
      <style jsx>{`
        .demand-editor { grid-column: 1 / -1; display: grid; gap: 8px; padding-top: 10px; border-top: 1px solid var(--border); }
        .demand-editor__header, .demand-editor__actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .demand-editor__header span { color: var(--text-muted); font-size: 12px; flex: 1; }
        .demand-editor__row { display: grid; grid-template-columns: minmax(130px, 1.4fr) repeat(2, minmax(90px, 1fr)) minmax(70px, .7fr) minmax(110px, 1.2fr) 36px; gap: 8px; align-items: end; }
        label { display: grid; gap: 3px; min-width: 0; }
        label span { color: var(--text-muted); font-size: 11px; font-weight: 700; }
        input { width: 100%; min-width: 0; height: 34px; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface); color: var(--text); padding: 0 8px; }
        @media (max-width: 900px) {
          .demand-editor__header { display: grid; grid-template-columns: 1fr auto; }
          .demand-editor__header span { grid-column: 1 / -1; grid-row: 2; }
          .demand-editor__row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        }
      `}</style>
    </div>
  );
}
