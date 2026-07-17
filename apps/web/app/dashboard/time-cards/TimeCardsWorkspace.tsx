'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createLatestRequestGate } from '@/lib/latest-request';
import {
    clockInTimeCard,
    clockOutTimeCard,
    fetchEarlierTimeCards,
    fetchLocationPage,
    fetchStaffRoster,
    fetchTimeCardSnapshot,
    locationContinuation,
} from './time-card-api';
import { formatTimeCardTimestamp } from './time-card-format';
import { ClockInRequestKey, isTimeCardForEmployee } from './time-card-request';
import { TimeCardCorrectionPanel } from './TimeCardCorrectionPanel';
import { TimeCardHistory } from './TimeCardHistory';
import type { StaffMember, TimeCard, TimeCardLocation, TimeCardPage, TimeCardsWorkspaceProps } from './time-card-types';


export function TimeCardsWorkspace({ canManageTeam, canReadLocations, canWriteTimeCards, currentUserId }: TimeCardsWorkspaceProps) {
    const [staff, setStaff] = useState<StaffMember[]>([]);
    const [locations, setLocations] = useState<TimeCardLocation[]>([]);
    const [nextLocationCursor, setNextLocationCursor] = useState<string | null>(null);
    const [isLoadingMoreLocations, setIsLoadingMoreLocations] = useState(false);
    const [selectedUserId, setSelectedUserId] = useState(currentUserId);
    const [selectedLocationId, setSelectedLocationId] = useState('');
    const [activeCard, setActiveCard] = useState<TimeCard | null>(null);
    const [cards, setCards] = useState<TimeCard[]>([]);
    const [nextCardsCursor, setNextCardsCursor] = useState<string | null>(null);
    const [isMoreCardsLoading, setIsMoreCardsLoading] = useState(false);
    const [correctingCard, setCorrectingCard] = useState<TimeCard | null>(null);
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
        const [staffRows, locationPage] = await Promise.all([
            canManageTeam ? fetchStaffRoster() : Promise.resolve(null),
            canReadLocations ? fetchLocationPage() : Promise.resolve(null),
        ]);
        const nextStaff = (staffRows ?? [])
            .slice()
            .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
        const nextLocations = Array.isArray(locationPage?.data) ? locationPage.data : [];

        setStaff(nextStaff);
        setLocations(nextLocations);
        setNextLocationCursor(locationPage ? locationContinuation(locationPage) : null);
        setSelectedLocationId((previous) => previous || nextLocations[0]?.id || '');
        if (canManageTeam && nextStaff[0]?.id) {
            setSelectedUserId((previousUserId) => previousUserId === currentUserId ? nextStaff[0].id : previousUserId);
        }
    }, [canManageTeam, canReadLocations, currentUserId]);

    const loadMoreLocations = useCallback(async () => {
        if (!nextLocationCursor) return;
        setIsLoadingMoreLocations(true);
        setError(null);
        try {
            const page = await fetchLocationPage(nextLocationCursor);
            const rows = Array.isArray(page.data) ? page.data : [];
            setLocations((current) => {
                const byId = new Map(current.map((location) => [location.id, location]));
                for (const location of rows) byId.set(location.id, location);
                return [...byId.values()];
            });
            setNextLocationCursor(locationContinuation(page));
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : 'Unable to load more locations.');
        } finally {
            setIsLoadingMoreLocations(false);
        }
    }, [nextLocationCursor]);
    const loadCards = useCallback(async (userId: string) => {
        const ticket = cardsRequestGate.current.begin(userId);
        setIsCardsLoading(true);
        setLoadedUserId(null);
        setCanStartNewTimeCard(false);
        setActiveCard(null);
        setCards([]);
        setNextCardsCursor(null);
        setIsMoreCardsLoading(false);
        setCorrectingCard(null);
        setError(null);

        try {
            const snapshot = await fetchTimeCardSnapshot(userId, canManageTeam);
            if (!cardsRequestGate.current.isLatest(ticket)) return;

            setActiveCard(isTimeCardForEmployee(snapshot.activeCard, userId) ? snapshot.activeCard : null);
            setLoadedUserId(userId);
            setCanStartNewTimeCard(snapshot.historyResponse.ok);
            if (snapshot.historyResponse.ok) {
                const page = (await snapshot.historyResponse.json()) as TimeCardPage;
                if (!cardsRequestGate.current.isLatest(ticket)) return;
                setCards(Array.isArray(page.data) ? page.data.filter((card) => card.userId === userId) : []);
                setNextCardsCursor(page.nextCursor ?? null);
            } else {
                setCards([]);
                setError('Time card history and new clock-ins are unavailable. You can still clock out an open card.');
            }
        } catch (loadError) {
            if (cardsRequestGate.current.isLatest(ticket)) {
                setError(loadError instanceof Error ? loadError.message : 'Unable to load time cards.');
            }
        } finally {
            if (cardsRequestGate.current.isLatest(ticket)) setIsCardsLoading(false);
        }
    }, [canManageTeam]);

    const loadEarlierCards = useCallback(async () => {
        const cursor = nextCardsCursor;
        const userId = selectedUserId;
        if (!cursor || isMoreCardsLoading) return;

        const ticket = cardsRequestGate.current.begin(userId);
        setIsMoreCardsLoading(true);
        setError(null);
        try {
            const page = await fetchEarlierTimeCards(userId, canManageTeam, cursor);
            if (!cardsRequestGate.current.isLatest(ticket)) return;

            const additionalCards = Array.isArray(page.data)
                ? page.data.filter((card) => card.userId === userId)
                : [];
            setCards((current) => {
                const knownIds = new Set(current.map((card) => card.id));
                return [...current, ...additionalCards.filter((card) => !knownIds.has(card.id))];
            });
            setNextCardsCursor(page.nextCursor ?? null);
        } catch (loadError) {
            if (cardsRequestGate.current.isLatest(ticket)) {
                setError(loadError instanceof Error ? loadError.message : 'Unable to load earlier time cards.');
            }
        } finally {
            if (cardsRequestGate.current.isLatest(ticket)) setIsMoreCardsLoading(false);
        }
    }, [canManageTeam, isMoreCardsLoading, nextCardsCursor, selectedUserId]);

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
            await clockInTimeCard(payload, clockInRequestKey.current.current());
            clockInRequestKey.current.reset();
            setNotice('Clocked in.');
            setNotes('');
            await loadCards(selectedUserId);
        } catch (saveError) {
            setError(saveError instanceof Error ? saveError.message : 'Unable to clock in.');
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
            await clockOutTimeCard(activeCardForSelectedUser.id, {
                breakMinutes: Number.isFinite(parsedBreakMinutes) ? parsedBreakMinutes : 0,
                notes: notes.trim() || undefined,
            });
            setNotice('Clocked out.');
            setNotes('');
            await loadCards(selectedUserId);
        } catch (saveError) {
            setError(saveError instanceof Error ? saveError.message : 'Unable to clock out.');
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

                <div
                    role="note"
                    className="surface-muted"
                    style={{ padding: '0.7rem 0.8rem', color: 'var(--text-secondary)', fontSize: '0.83rem', fontWeight: 650 }}
                >
                    Operational time records only. Your payroll system remains the source of truth for wages, taxes, and filings.
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
                    {canReadLocations && nextLocationCursor ? (
                        <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => void loadMoreLocations()}
                            disabled={isSaving || isLoadingMoreLocations}
                        >
                            {isLoadingMoreLocations ? 'Loading...' : 'Load more locations'}
                        </button>
                    ) : null}

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
                            {!hasCurrentCards ? 'Loading status...' : activeCardForSelectedUser
                                ? `Clocked in at ${formatTimeCardTimestamp(activeCardForSelectedUser.clockInAt, activeCardForSelectedUser.displayTimeZone)}`
                                : 'Not clocked in'}
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

            {correctingCard ? (
                <TimeCardCorrectionPanel
                    key={correctingCard.id + correctingCard.updatedAt}
                    card={correctingCard}
                    onCancel={() => setCorrectingCard(null)}
                    onSaved={async () => {
                        setNotice('Time card corrected.');
                        setCorrectingCard(null);
                        await loadCards(selectedUserId);
                    }}
                />
            ) : null}

            <TimeCardHistory
                cards={cards}
                canManageTeam={canManageTeam}
                canWriteTimeCards={canWriteTimeCards}
                isMoreCardsLoading={isMoreCardsLoading}
                nextCardsCursor={nextCardsCursor}
                selectedStaffName={selectedStaffName}
                onCorrect={(card) => {
                    setError(null);
                    setNotice(null);
                    setCorrectingCard(card);
                }}
                onLoadEarlier={() => void loadEarlierCards()}
            />
        </div>
    );
}
