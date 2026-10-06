'use client';

import { FormEvent, useState } from 'react';
import { fetchWithSession } from '@/lib/client-api';
import { jsonWriteInit } from './time-card-api';
import {
    formatTimeCardDuration,
    formatTimeCardTimestamp,
    timeCardInstantToLocalInput,
    timeCardLocalInputCandidates,
} from './time-card-format';
import { TimeCard } from './time-card-types';

type TimeCardCorrectionPanelProps = {
    card: TimeCard;
    onCancel: () => void;
    onSaved: () => Promise<void>;
};

type BreakDraft = {
    key: string;
    startAt: string;
    endAt: string;
    originalStartAt?: string;
    originalEndAt?: string;
    startTouched: boolean;
    endTouched: boolean;
};

export function TimeCardCorrectionPanel({ card, onCancel, onSaved }: TimeCardCorrectionPanelProps) {
    const timeZone = card.displayTimeZone || card.location?.timezone || 'UTC';
    const [clockInAt, setClockInAt] = useState(() => timeCardInstantToLocalInput(card.clockInAt, timeZone));
    const [clockOutAt, setClockOutAt] = useState(() => (
        card.clockOutAt ? timeCardInstantToLocalInput(card.clockOutAt, timeZone) : ''
    ));
    const [clockInTouched, setClockInTouched] = useState(false);
    const [clockOutTouched, setClockOutTouched] = useState(false);
    const [breaks, setBreaks] = useState<BreakDraft[]>(() => (card.breaks ?? []).map((interval) => ({
        key: interval.id,
        startAt: timeCardInstantToLocalInput(interval.startAt, timeZone),
        endAt: timeCardInstantToLocalInput(interval.endAt, timeZone),
        originalStartAt: interval.startAt,
        originalEndAt: interval.endAt,
        startTouched: false,
        endTouched: false,
    })));
    const [breaksTouched, setBreaksTouched] = useState(Boolean(card.breaks?.length));
    const [reason, setReason] = useState('');
    const [ambiguities, setAmbiguities] = useState<Record<string, string[]>>({});
    const [ambiguitySelections, setAmbiguitySelections] = useState<Record<string, string>>({});
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    function updateDateTime(fieldKey: string, value: string, setter: (next: string) => void) {
        setter(value);
        if (fieldKey === 'clock-in') setClockInTouched(true);
        if (fieldKey === 'clock-out') setClockOutTouched(true);
        setAmbiguities((current) => withoutKey(current, fieldKey));
        setAmbiguitySelections((current) => withoutKey(current, fieldKey));
    }

    function untouchedOriginal(fieldKey: string): string | undefined {
        if (fieldKey === 'clock-in' && !clockInTouched) return card.clockInAt;
        if (fieldKey === 'clock-out' && !clockOutTouched) return card.clockOutAt || undefined;
        for (const interval of breaks) {
            if (fieldKey === breakFieldKey(interval.key, 'startAt') && !interval.startTouched) return interval.originalStartAt;
            if (fieldKey === breakFieldKey(interval.key, 'endAt') && !interval.endTouched) return interval.originalEndAt;
        }
        return undefined;
    }

    function inspectDateTime(fieldKey: string, value: string) {
        if (!value) return;
        if (untouchedOriginal(fieldKey)) {
            setAmbiguities((current) => withoutKey(current, fieldKey));
            return;
        }
        try {
            const candidates = timeCardLocalInputCandidates(value, timeZone);
            setAmbiguities((current) => ({ ...current, [fieldKey]: candidates }));
            // Keep the alert in place while focus moves to Save. Removing it
            // on blur can move the button between pointer down and pointer up.
            // The next submission clears the error before validating again.
        } catch (candidateError) {
            setError(candidateError instanceof Error ? candidateError.message : 'Invalid local date/time.');
        }
    }

    function addBreak() {
        const key = crypto.randomUUID();
        setBreaks((current) => [...current, { key, startAt: '', endAt: '', startTouched: true, endTouched: true }]);
        setBreaksTouched(true);
    }

    function updateBreak(key: string, field: 'startAt' | 'endAt', value: string) {
        setBreaks((current) => current.map((interval) => (
            interval.key === key ? { ...interval, [field]: value,
                ...(field === 'startAt' ? { startTouched: true } : { endTouched: true }) } : interval
        )));
        setBreaksTouched(true);
        const fieldKey = breakFieldKey(key, field);
        setAmbiguities((current) => withoutKey(current, fieldKey));
        setAmbiguitySelections((current) => withoutKey(current, fieldKey));
    }

    function removeBreak(key: string) {
        setBreaks((current) => current.filter((interval) => interval.key !== key));
        setBreaksTouched(true);
        for (const field of ['startAt', 'endAt'] as const) {
            const fieldKey = breakFieldKey(key, field);
            setAmbiguities((current) => withoutKey(current, fieldKey));
            setAmbiguitySelections((current) => withoutKey(current, fieldKey));
        }
    }

    function resolveInstant(fieldKey: string, value: string, label: string): string {
        // Minute-only display values must not replace precise saved instants.
        // A deliberate edit, including respecifying the same wall time, uses
        // the current local-time validation and occurrence selection instead.
        const original = untouchedOriginal(fieldKey);
        if (original) return original;
        if (!value) throw new Error(label + ' is required.');
        const candidates = timeCardLocalInputCandidates(value, timeZone);
        setAmbiguities((current) => ({ ...current, [fieldKey]: candidates }));
        if (candidates.length === 0) throw new Error(label + ' does not exist in ' + timeZone + '.');
        if (candidates.length === 1) return candidates[0];
        const selection = ambiguitySelections[fieldKey];
        if (!selection || !candidates.includes(selection)) {
            throw new Error(label + ' occurs twice because of daylight saving time. Select the correct occurrence.');
        }
        return selection;
    }

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setIsSaving(true);
        setError(null);
        try {
            const payload = {
                clockInAt: resolveInstant('clock-in', clockInAt, 'Clock in'),
                clockOutAt: clockOutAt ? resolveInstant('clock-out', clockOutAt, 'Clock out') : null,
                expectedUpdatedAt: card.updatedAt,
                reason,
                ...(breaksTouched ? {
                    breakIntervals: breaks.map((interval, index) => ({
                        startAt: resolveInstant(
                            breakFieldKey(interval.key, 'startAt'),
                            interval.startAt,
                            'Break ' + (index + 1) + ' start',
                        ),
                        endAt: resolveInstant(
                            breakFieldKey(interval.key, 'endAt'),
                            interval.endAt,
                            'Break ' + (index + 1) + ' end',
                        ),
                    })),
                } : {}),
            };
            const response = await fetchWithSession(
                '/time-cards/' + card.id + '/correction',
                jsonWriteInit('PATCH', payload),
            );
            const responseBody = (await response.json().catch(() => ({}))) as { message?: string };
            if (!response.ok) throw new Error(responseBody.message ?? 'Unable to correct the time card.');
            await onSaved();
        } catch (submitError) {
            setError(submitError instanceof Error ? submitError.message : 'Unable to correct the time card.');
        } finally {
            setIsSaving(false);
        }
    }

    function renderAmbiguity(fieldKey: string) {
        if (untouchedOriginal(fieldKey)) return null;
        const candidates = ambiguities[fieldKey] ?? [];
        if (candidates.length < 2) return null;
        return (
            <label style={fieldLabelStyle}>
                Repeated time occurrence
                <select
                    aria-label="Repeated time occurrence"
                    value={ambiguitySelections[fieldKey] ?? ''}
                    onChange={(event) => setAmbiguitySelections((current) => ({
                        ...current,
                        [fieldKey]: event.target.value,
                    }))}
                    style={fieldStyle}
                    required
                >
                    <option value="">Select occurrence</option>
                    {candidates.map((candidate) => (
                        <option key={candidate} value={candidate}>
                            {formatTimeCardTimestamp(candidate, timeZone)}
                        </option>
                    ))}
                </select>
            </label>
        );
    }

    const hasLegacyAggregateBreak = card.breakMinutes > 0 && (card.breaks?.length ?? 0) === 0;

    return (
        <section className="surface-card" aria-labelledby="time-card-correction-title" style={{ padding: '1rem' }}>
            <form onSubmit={(event) => void submit(event)} style={{ display: 'grid', gap: '0.9rem' }}>
                <div>
                    <div className="workspace-kicker">Manager correction</div>
                    <h2 id="time-card-correction-title" style={{ margin: 0, fontSize: '1.05rem', color: 'var(--text-primary)' }}>
                        Correct {card.user?.name ?? 'employee'} time card
                    </h2>
                    <p style={{ margin: '0.3rem 0 0', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                        Times use {timeZone}. Every correction requires a reason and is retained in the audit log.
                    </p>
                </div>

                {error ? <div role="alert" style={{ fontSize: '0.83rem', color: '#cb3653' }}>{error}</div> : null}

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem' }}>
                    <div style={{ display: 'grid', gap: '0.45rem' }}>
                        <label style={fieldLabelStyle}>
                            Clock in
                            <input
                                type="datetime-local"
                                value={clockInAt}
                                onChange={(event) => updateDateTime('clock-in', event.target.value, setClockInAt)}
                                onBlur={() => inspectDateTime('clock-in', clockInAt)}
                                style={fieldStyle}
                                required
                            />
                        </label>
                        {renderAmbiguity('clock-in')}
                    </div>
                    <div style={{ display: 'grid', gap: '0.45rem' }}>
                        <label style={fieldLabelStyle}>
                            Clock out
                            <input
                                type="datetime-local"
                                value={clockOutAt}
                                onChange={(event) => updateDateTime('clock-out', event.target.value, setClockOutAt)}
                                onBlur={() => inspectDateTime('clock-out', clockOutAt)}
                                style={fieldStyle}
                            />
                        </label>
                        {renderAmbiguity('clock-out')}
                        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Leave blank only when the card should remain open.</span>
                    </div>
                </div>

                <div className="surface-muted" style={{ padding: '0.8rem', display: 'grid', gap: '0.7rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.7rem', alignItems: 'center', flexWrap: 'wrap' }}>
                        <div>
                            <div style={{ fontSize: '0.82rem', fontWeight: 800, color: 'var(--text-primary)' }}>Unpaid break intervals</div>
                            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{formatTimeCardDuration(card.breakMinutes)} currently recorded</div>
                        </div>
                        <button type="button" className="btn btn-secondary" onClick={addBreak}>Add break</button>
                    </div>
                    {hasLegacyAggregateBreak && !breaksTouched ? (
                        <div role="note" style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                            This legacy card stores only an aggregate break. Timestamp-only corrections preserve it.
                            Add intervals to replace it, or{' '}
                            <button type="button" className="btn btn-link" onClick={() => setBreaksTouched(true)}>clear the aggregate break</button>.
                        </div>
                    ) : null}
                    {breaks.map((interval, index) => (
                        <div key={interval.key} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '0.6rem', alignItems: 'start' }}>
                            <div style={{ display: 'grid', gap: '0.4rem' }}>
                                <label style={fieldLabelStyle}>
                                    Break {index + 1} start
                                    <input
                                        type="datetime-local"
                                        value={interval.startAt}
                                        onChange={(event) => updateBreak(interval.key, 'startAt', event.target.value)}
                                        onBlur={() => inspectDateTime(breakFieldKey(interval.key, 'startAt'), interval.startAt)}
                                        style={fieldStyle}
                                        required
                                    />
                                </label>
                                {renderAmbiguity(breakFieldKey(interval.key, 'startAt'))}
                            </div>
                            <div style={{ display: 'grid', gap: '0.4rem' }}>
                                <label style={fieldLabelStyle}>
                                    Break {index + 1} end
                                    <input
                                        type="datetime-local"
                                        value={interval.endAt}
                                        onChange={(event) => updateBreak(interval.key, 'endAt', event.target.value)}
                                        onBlur={() => inspectDateTime(breakFieldKey(interval.key, 'endAt'), interval.endAt)}
                                        style={fieldStyle}
                                        required
                                    />
                                </label>
                                {renderAmbiguity(breakFieldKey(interval.key, 'endAt'))}
                            </div>
                            <button type="button" className="btn btn-secondary" onClick={() => removeBreak(interval.key)} aria-label={'Remove break ' + (index + 1)}>
                                Remove
                            </button>
                        </div>
                    ))}
                </div>

                <label style={fieldLabelStyle}>
                    Correction reason
                    <textarea
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                        minLength={5}
                        maxLength={500}
                        rows={3}
                        style={{ ...fieldStyle, resize: 'vertical' }}
                        required
                    />
                </label>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.6rem' }}>
                    <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={isSaving}>Cancel</button>
                    <button type="submit" className="btn btn-primary" disabled={isSaving}>
                        {isSaving ? 'Saving...' : 'Save correction'}
                    </button>
                </div>
            </form>
        </section>
    );
}

const fieldLabelStyle = {
    display: 'grid',
    gap: 5,
    fontSize: '0.78rem',
    fontWeight: 700,
    color: 'var(--text-primary)',
} as const;

const fieldStyle = {
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '0.45rem 0.5rem',
    background: '#fff',
    color: 'var(--text-primary)',
    minWidth: 0,
    width: '100%',
    boxSizing: 'border-box',
} as const;

function breakFieldKey(key: string, field: 'startAt' | 'endAt'): string {
    return 'break-' + key + '-' + field;
}

function withoutKey<T>(value: Record<string, T>, key: string): Record<string, T> {
    const next = { ...value };
    delete next[key];
    return next;
}
