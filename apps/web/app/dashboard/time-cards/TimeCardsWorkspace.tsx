'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchWithSession } from '@/lib/client-api';
import { createLatestRequestGate } from '@/lib/latest-request';
import { formatTimeCardDuration } from './time-card-format';
import { ClockInRequestKey, isTimeCardForEmployee } from './time-card-request';

type TimeCardsWorkspaceProps = {
    canManageTeam: boolean;
    canReadLocations: boolean;
    canWriteTimeCards: boolean;
    currentUserId: string;
};

type StaffMember = {
    id: string;
    name: string;
    role: string;
};

type Location = {
    id: string;
    name: string;
};

type TimeCard = {
    id: string;
    userId: string;
    locationId?: string | null;
    clockInAt: string;
    clockOutAt?: string | null;
    breakMinutes: number;
    status: 'OPEN' | 'CLOSED' | 'VOID';
    grossMinutes: number;
    workedMinutes: number;
    notes?: string | null;
    user?: { id: string; name: string; username?: string | null; role: string };
    location?: { id: string; name: string } | null;
};

function getCsrfToken(): string {
    if (typeof document === 'undefined') return '';
    const pair = document.cookie.split('; ').find((entry) => entry.startsWith('csrf_token='));
    return pair ? decodeURIComponent(pair.split('=')[1] ?? '') : '';
}

function jsonWriteInit(method: 'POST' | 'PUT', payload: unknown, extraHeaders: Record<string, string> = {}): RequestInit {
    const csrf = getCsrfToken();
    return {
        method,
        credentials: 'include',
        headers: {
            'Content-Type': 'application/json',
            ...(csrf ? { 'x-csrf-token': csrf } : {}),
            ...extraHeaders,
        },
        body: JSON.stringify(payload),
    };
}

function formatTime(value?: string | null): string {
    if (!value) return 'Open';
    return new Date(value).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });
}

export function TimeCardsWorkspace({ canManageTeam, canReadLocations, canWriteTimeCards, currentUserId }: TimeCardsWorkspaceProps) {
    const [staff, setStaff] = useState<StaffMember[]>([]);
    const [locations, setLocations] = useState<Location[]>([]);
    const [selectedUserId, setSelectedUserId] = useState(currentUserId);
    const [selectedLocationId, setSelectedLocationId] = useState('');
    const [activeCard, setActiveCard] = useState<TimeCard | null>(null);
    const [cards, setCards] = useState<TimeCard[]>([]);
    const [breakMinutes, setBreakMinutes] = useState('30');
    const [notes, setNotes] = useState('');
    const [isReferenceLoading, setIsReferenceLoading] = useState(true);
    const [isCardsLoading, setIsCardsLoading] = useState(true);
    const [loadedUserId, setLoadedUserId] = useState<string | null>(null);
    const [canStartNewTimeCard, setCanStartNewTimeCard] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const cardsRequestGate = useRef(createLatestRequestGate<string>());
    const clockInRequestKey = useRef(new ClockInRequestKey());

    const isLoading = isReferenceLoading || isCardsLoading;
    const activeCardForSelectedUser = isTimeCardForEmployee(activeCard, selectedUserId) ? activeCard : null;
    const hasCurrentCards = loadedUserId === selectedUserId && !isCardsLoading;

    const selectedStaffName = useMemo(() => {
        return staff.find((person) => person.id === selectedUserId)?.name ?? 'Current user';
    }, [selectedUserId, staff]);

    const loadReferenceData = useCallback(async () => {
        const [staffRes, locationRes] = await Promise.all([
            canManageTeam ? fetchWithSession('/shifts/staff-roster') : Promise.resolve(null),
            canReadLocations ? fetchWithSession('/locations') : Promise.resolve(null),
        ]);

        if (staffRes && !staffRes.ok) throw new Error('Unable to load staff.');
        if (locationRes && !locationRes.ok) throw new Error('Unable to load locations.');

        const staffPayload = staffRes ? (await staffRes.json()) as { data?: StaffMember[] } : { data: [] };
        const locationPayload = locationRes ? (await locationRes.json()) as { data?: Location[] } : { data: [] };
        const nextStaff = Array.isArray(staffPayload.data) ? staffPayload.data : [];
        const nextLocations = Array.isArray(locationPayload.data) ? locationPayload.data : [];

        setStaff(nextStaff);
        setLocations(nextLocations);
        setSelectedLocationId((prev) => prev || nextLocations[0]?.id || '');
        if (canManageTeam && nextStaff[0]?.id) {
            setSelectedUserId((previousUserId) => previousUserId === currentUserId ? nextStaff[0].id : previousUserId);
        }
    }, [canManageTeam, canReadLocations, currentUserId]);

    const loadCards = useCallback(async (userId: string) => {
        const ticket = cardsRequestGate.current.begin(userId);
        setIsCardsLoading(true);
        setLoadedUserId(null);
        setCanStartNewTimeCard(false);
        setActiveCard(null);
        setCards([]);
        setError(null);
        const query = new URLSearchParams();
        if (canManageTeam && userId) query.set('userId', userId);

        try {
            const [activeRes, cardsRes] = await Promise.all([
                fetchWithSession(`/time-cards/active${query.toString() ? `?${query}` : ''}`),
                fetchWithSession(`/time-cards${query.toString() ? `?${query}` : ''}`),
            ]);

            if (!activeRes.ok) throw new Error('Unable to load active time card.');

            const activePayload = (await activeRes.json()) as { data?: TimeCard | null };
            if (!cardsRequestGate.current.isLatest(ticket)) return;

            const nextActiveCard = activePayload.data ?? null;
            setActiveCard(isTimeCardForEmployee(nextActiveCard, userId) ? nextActiveCard : null);
            setLoadedUserId(userId);
            setCanStartNewTimeCard(cardsRes.ok);
            if (cardsRes.ok) {
                const cardsPayload = (await cardsRes.json()) as { data?: TimeCard[] };
                if (!cardsRequestGate.current.isLatest(ticket)) return;
                setCards(Array.isArray(cardsPayload.data) ? cardsPayload.data.filter((card) => card.userId === userId) : []);
            } else {
                setCards([]);
                setError('Time card history and new clock-ins are unavailable. You can still clock out an open card.');
            }
        } catch (err) {
            if (cardsRequestGate.current.isLatest(ticket)) {
                setError(err instanceof Error ? err.message : 'Unable to load time cards.');
            }
        } finally {
            if (cardsRequestGate.current.isLatest(ticket)) setIsCardsLoading(false);
        }
    }, [canManageTeam]);

    useEffect(() => {
        let cancelled = false;

        async function load() {
            setIsReferenceLoading(true);
            setError(null);
            try {
                await loadReferenceData();
            } catch (err) {
                if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to load time cards.');
            } finally {
                if (!cancelled) setIsReferenceLoading(false);
            }
        }

        void load();
        return () => {
            cancelled = true;
        };
    }, [loadReferenceData]);

    useEffect(() => {
        setError(null);
        void loadCards(selectedUserId);
        return () => cardsRequestGate.current.invalidate();
    }, [loadCards, selectedUserId]);

    const selectEmployee = useCallback((userId: string) => {
        if (userId === selectedUserId) return;
        cardsRequestGate.current.invalidate();
        clockInRequestKey.current.reset();
        setSelectedUserId(userId);
        setActiveCard(null);
        setCards([]);
        setLoadedUserId(null);
        setCanStartNewTimeCard(false);
        setIsCardsLoading(true);
        setError(null);
        setNotice(null);
    }, [selectedUserId]);

    const clockIn = useCallback(async () => {
        if (!canWriteTimeCards) {
            setError('You have read-only time card access.');
            return;
        }
        if (!hasCurrentCards || !canStartNewTimeCard) return;
        setIsSaving(true);
        setError(null);
        setNotice(null);
        try {
            const payload = {
                ...(canManageTeam ? { userId: selectedUserId } : {}),
                ...(selectedLocationId ? { locationId: selectedLocationId } : {}),
                notes: notes.trim() || undefined,
            };
            const requestKey = clockInRequestKey.current.current();
            const res = await fetchWithSession('/time-cards/clock-in', jsonWriteInit('POST', payload, {
                'Idempotency-Key': requestKey,
            }));
            const body = (await res.json().catch(() => ({}))) as { message?: string };
            if (!res.ok) throw new Error(body.message ?? 'Unable to clock in.');
            clockInRequestKey.current.reset();
            setNotice('Clocked in.');
            setNotes('');
            await loadCards(selectedUserId);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unable to clock in.');
        } finally {
            setIsSaving(false);
        }
    }, [canManageTeam, canStartNewTimeCard, canWriteTimeCards, hasCurrentCards, loadCards, notes, selectedLocationId, selectedUserId]);

    const clockOut = useCallback(async () => {
        if (!activeCardForSelectedUser || !hasCurrentCards) return;
        if (!canWriteTimeCards) {
            setError('You have read-only time card access.');
            return;
        }
        setIsSaving(true);
        setError(null);
        setNotice(null);
        try {
            const parsedBreakMinutes = Number.parseInt(breakMinutes, 10);
            const res = await fetchWithSession(`/time-cards/${activeCardForSelectedUser.id}/clock-out`, jsonWriteInit('POST', {
                breakMinutes: Number.isFinite(parsedBreakMinutes) ? parsedBreakMinutes : 0,
                notes: notes.trim() || undefined,
            }));
            const body = (await res.json().catch(() => ({}))) as { message?: string };
            if (!res.ok) throw new Error(body.message ?? 'Unable to clock out.');
            setNotice('Clocked out.');
            setNotes('');
            await loadCards(selectedUserId);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unable to clock out.');
        } finally {
            setIsSaving(false);
        }
    }, [activeCardForSelectedUser, breakMinutes, canWriteTimeCards, hasCurrentCards, loadCards, notes, selectedUserId]);

    return (
        <div style={{ display: 'grid', gap: '1rem', maxWidth: 1280 }}>
            <section className="surface-card" style={{ padding: '1rem', display: 'grid', gap: '0.85rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.8rem', flexWrap: 'wrap' }}>
                    <div>
                        <div className="workspace-kicker">Time clock</div>
                        <h1 className="workspace-title" style={{ fontSize: '1.55rem', marginBottom: 2 }}>Time Cards</h1>
                        <p className="workspace-subtitle">{isLoading ? 'Loading time cards...' : `${cards.length} card${cards.length === 1 ? '' : 's'} for ${selectedStaffName}`}</p>
                    </div>
                    <button className="btn btn-secondary" onClick={() => void loadCards(selectedUserId)} disabled={isLoading || isSaving}>
                        Refresh
                    </button>
                </div>

                {error ? <div style={{ fontSize: '0.83rem', color: '#cb3653' }}>{error}</div> : null}
                {notice ? <div style={{ fontSize: '0.83rem', color: '#0f8c52' }}>{notice}</div> : null}
                {!canWriteTimeCards ? (
                    <div className="surface-muted" style={{ padding: '0.7rem 0.8rem', color: 'var(--text-secondary)', fontSize: '0.83rem', fontWeight: 650 }}>
                        Read-only time card access. Clock-in and clock-out actions are hidden for this role.
                    </div>
                ) : null}

                <div className="surface-muted" style={{ padding: '0.85rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '0.65rem', alignItems: 'end' }}>
                    {canManageTeam ? (
                        <label style={{ display: 'grid', gap: 5, fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                            Employee
                            <select
                                value={selectedUserId}
                                onChange={(event) => selectEmployee(event.target.value)}
                                disabled={isSaving}
                                style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.45rem 0.5rem', background: '#fff', color: 'var(--text-primary)' }}
                            >
                                {staff.map((person) => (
                                    <option key={person.id} value={person.id}>{person.name}</option>
                                ))}
                            </select>
                        </label>
                    ) : null}

                    {canReadLocations ? <label style={{ display: 'grid', gap: 5, fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                        Location
                        <select
                            value={selectedLocationId}
                            onChange={(event) => { clockInRequestKey.current.reset(); setSelectedLocationId(event.target.value); }}
                            disabled={isSaving || Boolean(activeCardForSelectedUser) || !canWriteTimeCards || !hasCurrentCards || !canStartNewTimeCard}
                            style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.45rem 0.5rem', background: '#fff', color: 'var(--text-primary)' }}
                        >
                            <option value="">No location</option>
                            {locations.map((location) => (
                                <option key={location.id} value={location.id}>{location.name}</option>
                            ))}
                        </select>
                    </label> : null}

                    <label style={{ display: 'grid', gap: 5, fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                        Break minutes
                        <input
                            type="number"
                            min="0"
                            step="1"
                            value={breakMinutes}
                            onChange={(event) => setBreakMinutes(event.target.value)}
                            disabled={!activeCardForSelectedUser || !canWriteTimeCards || !hasCurrentCards}
                            style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.45rem 0.5rem', background: '#fff', color: 'var(--text-primary)' }}
                        />
                    </label>

                    <label style={{ display: 'grid', gap: 5, fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                        Notes
                        <input
                            value={notes}
                            onChange={(event) => { clockInRequestKey.current.reset(); setNotes(event.target.value); }}
                            placeholder="Optional"
                            disabled={isSaving || !canWriteTimeCards}
                            style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.45rem 0.5rem', background: '#fff', color: 'var(--text-primary)' }}
                        />
                    </label>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '0.8rem', alignItems: 'center' }}>
                    <div className="surface-muted" style={{ padding: '0.8rem' }}>
                        <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 800 }}>Current status</div>
                        <div style={{ marginTop: 4, fontSize: '1rem', fontWeight: 800, color: activeCardForSelectedUser ? '#166534' : 'var(--text-primary)' }}>
                            {!hasCurrentCards ? 'Loading status...' : activeCardForSelectedUser ? `Clocked in at ${formatTime(activeCardForSelectedUser.clockInAt)}` : 'Not clocked in'}
                        </div>
                        {activeCardForSelectedUser?.location ? (
                            <div style={{ marginTop: 2, fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{activeCardForSelectedUser.location.name}</div>
                        ) : null}
                    </div>

                    {canWriteTimeCards ? (
                        activeCardForSelectedUser ? (
                            <button className="btn btn-primary" onClick={() => void clockOut()} disabled={isSaving || !hasCurrentCards}>
                                {isSaving ? 'Saving...' : 'Clock out'}
                            </button>
                        ) : (
                            <button className="btn btn-primary" onClick={() => void clockIn()} disabled={isSaving || !hasCurrentCards || !canStartNewTimeCard}>
                                {isSaving ? 'Saving...' : 'Clock in'}
                            </button>
                        )
                    ) : null}
                </div>
            </section>

            <section className="surface-card" style={{ padding: '1rem', overflowX: 'auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.8rem', alignItems: 'center', marginBottom: '0.75rem' }}>
                    <div>
                        <div className="workspace-kicker">History</div>
                        <h2 style={{ margin: 0, color: 'var(--text-primary)', fontSize: '1rem' }}>Time card records</h2>
                    </div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{cards.filter((card) => card.status === 'OPEN').length} open</div>
                </div>

                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
                    <thead>
                        <tr style={{ borderBottom: '1px solid var(--border)' }}>
                            <th style={{ textAlign: 'left', padding: '0.55rem', fontSize: '0.72rem', color: 'var(--text-muted)' }}>Employee</th>
                            <th style={{ textAlign: 'left', padding: '0.55rem', fontSize: '0.72rem', color: 'var(--text-muted)' }}>Location</th>
                            <th style={{ textAlign: 'left', padding: '0.55rem', fontSize: '0.72rem', color: 'var(--text-muted)' }}>Clock in</th>
                            <th style={{ textAlign: 'left', padding: '0.55rem', fontSize: '0.72rem', color: 'var(--text-muted)' }}>Clock out</th>
                            <th style={{ textAlign: 'left', padding: '0.55rem', fontSize: '0.72rem', color: 'var(--text-muted)' }}>Break</th>
                            <th style={{ textAlign: 'left', padding: '0.55rem', fontSize: '0.72rem', color: 'var(--text-muted)' }}>Worked</th>
                            <th style={{ textAlign: 'left', padding: '0.55rem', fontSize: '0.72rem', color: 'var(--text-muted)' }}>Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        {cards.length === 0 ? (
                            <tr>
                                <td colSpan={7} style={{ padding: '0.85rem 0.55rem', color: 'var(--text-secondary)', fontSize: '0.86rem' }}>
                                    No time cards yet.
                                </td>
                            </tr>
                        ) : null}
                        {cards.map((card) => (
                            <tr key={card.id} style={{ borderBottom: '1px solid var(--border)' }}>
                                <td style={{ padding: '0.55rem', color: 'var(--text-primary)', fontWeight: 700 }}>{card.user?.name ?? selectedStaffName}</td>
                                <td style={{ padding: '0.55rem', color: 'var(--text-secondary)' }}>{card.location?.name ?? 'No location'}</td>
                                <td style={{ padding: '0.55rem', color: 'var(--text-secondary)' }}>{formatTime(card.clockInAt)}</td>
                                <td style={{ padding: '0.55rem', color: 'var(--text-secondary)' }}>{formatTime(card.clockOutAt)}</td>
                                <td style={{ padding: '0.55rem', color: 'var(--text-secondary)' }}>{formatTimeCardDuration(card.breakMinutes)}</td>
                                <td style={{ padding: '0.55rem', color: 'var(--text-primary)', fontWeight: 800 }}>{formatTimeCardDuration(card.workedMinutes)}</td>
                                <td style={{ padding: '0.55rem', color: card.status === 'OPEN' ? '#166534' : 'var(--text-secondary)', fontWeight: 800 }}>{card.status}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </section>
        </div>
    );
}
