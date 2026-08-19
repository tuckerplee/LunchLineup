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
import {
    ClockInRequestKey,
    isClockInTargetExplicit,
    isTimeCardForEmployee,
    selectedTimeCardUserId,
    timeCardMutationLabel,
    type TimeCardView,
} from './time-card-request';
import { TimeCardCorrectionPanel } from './TimeCardCorrectionPanel';
import { TimeCardHistory } from './TimeCardHistory';
import type { StaffMember, TimeCard, TimeCardLocation, TimeCardPage, TimeCardsWorkspaceProps } from './time-card-types';


export function TimeCardsWorkspace({ canManageTeam, canReadLocations, canWriteTimeCards, currentUserId }: TimeCardsWorkspaceProps) {
    const [staff, setStaff] = useState<StaffMember[]>([]);
    const [locations, setLocations] = useState<TimeCardLocation[]>([]);
    const [nextLocationCursor, setNextLocationCursor] = useState<string | null>(null);
    const [isLoadingMoreLocations, setIsLoadingMoreLocations] = useState(false);
    const [view, setView] = useState<TimeCardView>('mine');
    const [selectedTeamUserId, setSelectedTeamUserId] = useState('');
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
    const [loadedTargetKey, setLoadedTargetKey] = useState<string | null>(null);
    const [canStartNewTimeCard, setCanStartNewTimeCard] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const cardsRequestGate = useRef(createLatestRequestGate<string>());
    const clockInRequestKey = useRef(new ClockInRequestKey());

    const isTeamTime = view === 'team';
    const selectedUserId = selectedTimeCardUserId({ view, currentUserId, selectedTeamUserId });
    const selectedTargetKey = selectedUserId ? `${view}:${selectedUserId}` : '';
    const isLoading = isReferenceLoading || isCardsLoading;
    const activeCardForSelectedUser = activeCard && (!isTeamTime || isTimeCardForEmployee(activeCard, selectedUserId))
        ? activeCard
        : null;
    const hasCurrentCards = Boolean(selectedTargetKey) && loadedTargetKey === selectedTargetKey && !isCardsLoading;

    const selectedStaffName = useMemo(() => {
        if (!isTeamTime) return 'yourself';
        return staff.find((person) => person.id === selectedTeamUserId)?.name ?? '';
    }, [isTeamTime, selectedTeamUserId, staff]);

    const selectedLocationName = useMemo(() => (
        locations.find((location) => location.id === selectedLocationId)?.name ?? ''
    ), [locations, selectedLocationId]);

    const clockInTargetIsExplicit = isClockInTargetExplicit({
        view,
        currentUserId,
        selectedTeamUserId,
        selectedLocationId,
        canReadLocations,
    });
    const activeLocationId = activeCardForSelectedUser?.locationId ?? activeCardForSelectedUser?.location?.id ?? '';
    const teamClockOutTargetIsExplicit = !isTeamTime
        || !canReadLocations
        || Boolean(selectedLocationId && activeLocationId && selectedLocationId === activeLocationId);

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
    }, [canManageTeam, canReadLocations]);

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
    const loadCards = useCallback(async (userId: string, targetView: TimeCardView) => {
        const targetKey = `${targetView}:${userId}`;
        const ticket = cardsRequestGate.current.begin(targetKey);
        setIsCardsLoading(true);
        setLoadedTargetKey(null);
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

            setActiveCard(targetView === 'mine' || isTimeCardForEmployee(snapshot.activeCard, userId) ? snapshot.activeCard : null);
            setLoadedTargetKey(targetKey);
            setCanStartNewTimeCard(snapshot.historyResponse.ok);
            if (snapshot.historyResponse.ok) {
                const page = (await snapshot.historyResponse.json()) as TimeCardPage;
                if (!cardsRequestGate.current.isLatest(ticket)) return;
                const rows = Array.isArray(page.data) ? page.data : [];
                setCards(targetView === 'team' ? rows.filter((card) => card.userId === userId) : rows);
                setNextCardsCursor(page.pagination?.nextCursor ?? null);
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

        const ticket = cardsRequestGate.current.begin(selectedTargetKey);
        setIsMoreCardsLoading(true);
        setError(null);
        try {
            const page = await fetchEarlierTimeCards(userId, canManageTeam, cursor);
            if (!cardsRequestGate.current.isLatest(ticket)) return;

            const rows = Array.isArray(page.data) ? page.data : [];
            const additionalCards = isTeamTime ? rows.filter((card) => card.userId === userId) : rows;
            setCards((current) => {
                const knownIds = new Set(current.map((card) => card.id));
                return [...current, ...additionalCards.filter((card) => !knownIds.has(card.id))];
            });
            setNextCardsCursor(page.pagination?.nextCursor ?? null);
        } catch (loadError) {
            if (cardsRequestGate.current.isLatest(ticket)) {
                setError(loadError instanceof Error ? loadError.message : 'Unable to load earlier time cards.');
            }
        } finally {
            if (cardsRequestGate.current.isLatest(ticket)) setIsMoreCardsLoading(false);
        }
    }, [canManageTeam, isMoreCardsLoading, isTeamTime, nextCardsCursor, selectedTargetKey, selectedUserId]);

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
        if (!selectedUserId) {
            cardsRequestGate.current.invalidate();
            setIsCardsLoading(false);
            setLoadedTargetKey(null);
            setCanStartNewTimeCard(false);
            setActiveCard(null);
            setCards([]);
            setNextCardsCursor(null);
            setCorrectingCard(null);
            setError(null);
            return;
        }

        setError(null);
        void loadCards(selectedUserId, view);
        return () => cardsRequestGate.current.invalidate();
    }, [loadCards, selectedUserId, view]);

    const resetPersonDraft = useCallback(() => {
        clockInRequestKey.current.reset();
        setSelectedLocationId('');
        setBreakMinutes('30');
        setNotes('');
        setCorrectingCard(null);
        setError(null);
        setNotice(null);
    }, []);

    const clearLoadedPerson = useCallback(() => {
        cardsRequestGate.current.invalidate();
        setActiveCard(null);
        setCards([]);
        setNextCardsCursor(null);
        setLoadedTargetKey(null);
        setCanStartNewTimeCard(false);
    }, []);

    const selectView = useCallback((nextView: TimeCardView) => {
        if (nextView === view || (nextView === 'team' && !canManageTeam)) return;
        clearLoadedPerson();
        resetPersonDraft();
        setSelectedTeamUserId('');
        setView(nextView);
        setIsCardsLoading(nextView === 'mine');
    }, [canManageTeam, clearLoadedPerson, resetPersonDraft, view]);

    const selectEmployee = useCallback((userId: string) => {
        if (userId === selectedTeamUserId) return;
        clearLoadedPerson();
        resetPersonDraft();
        setSelectedTeamUserId(userId);
        setIsCardsLoading(Boolean(userId));
    }, [clearLoadedPerson, resetPersonDraft, selectedTeamUserId]);

    const selectLocation = useCallback((locationId: string) => {
        if (locationId === selectedLocationId) return;
        clockInRequestKey.current.reset();
        setSelectedLocationId(locationId);
        setBreakMinutes('30');
        setNotes('');
        setCorrectingCard(null);
        setError(null);
        setNotice(null);
    }, [selectedLocationId]);

    const clockIn = useCallback(async () => {
        if (!canWriteTimeCards) {
            setError('You have read-only time card access.');
            return;
        }
        if (!clockInTargetIsExplicit) {
            setError(isTeamTime
                ? 'Choose a team member and location before clocking in.'
                : 'Choose a location before clocking in.');
            return;
        }
        if (!hasCurrentCards || !canStartNewTimeCard || !selectedUserId) return;
        const targetName = selectedStaffName;
        const targetLocationName = selectedLocationName;
        setIsSaving(true);
        setError(null);
        setNotice(null);
        try {
            const payload = {
                ...(isTeamTime ? { userId: selectedUserId } : {}),
                ...(selectedLocationId ? { locationId: selectedLocationId } : {}),
                notes: notes.trim() || undefined,
            };
            await clockInTimeCard(payload, clockInRequestKey.current.current());
            clockInRequestKey.current.reset();
            setNotice(isTeamTime
                ? `${targetName} was clocked in${targetLocationName ? ` at ${targetLocationName}` : ''}.`
                : `Your clock-in was recorded${targetLocationName ? ` at ${targetLocationName}` : ''}.`);
            setNotes('');
            await loadCards(selectedUserId, view);
        } catch (saveError) {
            setError(saveError instanceof Error ? saveError.message : 'Unable to clock in.');
        } finally {
            setIsSaving(false);
        }
    }, [canStartNewTimeCard, canWriteTimeCards, clockInTargetIsExplicit, hasCurrentCards, isTeamTime, loadCards, notes, selectedLocationId, selectedLocationName, selectedStaffName, selectedUserId, view]);

    const clockOut = useCallback(async () => {
        if (!activeCardForSelectedUser || !hasCurrentCards) return;
        if (!canWriteTimeCards) {
            setError('You have read-only time card access.');
            return;
        }
        if (!teamClockOutTargetIsExplicit) {
            setError(`Choose ${activeCardForSelectedUser.location?.name ?? 'the active card location'} before clocking out ${selectedStaffName}.`);
            return;
        }
        const targetName = selectedStaffName;
        const targetLocationName = activeCardForSelectedUser.location?.name ?? selectedLocationName;
        setIsSaving(true);
        setError(null);
        setNotice(null);
        try {
            const parsedBreakMinutes = Number.parseInt(breakMinutes, 10);
            await clockOutTimeCard(activeCardForSelectedUser.id, {
                breakMinutes: Number.isFinite(parsedBreakMinutes) ? parsedBreakMinutes : 0,
                notes: notes.trim() || undefined,
            });
            setNotice(isTeamTime
                ? `${targetName} was clocked out${targetLocationName ? ` from ${targetLocationName}` : ''}.`
                : `Your clock-out was recorded${targetLocationName ? ` from ${targetLocationName}` : ''}.`);
            setBreakMinutes('30');
            setNotes('');
            await loadCards(selectedUserId, view);
        } catch (saveError) {
            setError(saveError instanceof Error ? saveError.message : 'Unable to clock out.');
        } finally {
            setIsSaving(false);
        }
    }, [activeCardForSelectedUser, breakMinutes, canWriteTimeCards, hasCurrentCards, isTeamTime, loadCards, notes, selectedLocationName, selectedStaffName, selectedUserId, teamClockOutTargetIsExplicit, view]);

    const activeLocationName = activeCardForSelectedUser?.location?.name ?? selectedLocationName;
    const clockInLabel = !selectedUserId
        ? 'Select a team member and location'
        : !clockInTargetIsExplicit
            ? `Select a location for ${selectedStaffName}`
            : timeCardMutationLabel('clock-in', selectedStaffName, selectedLocationName || undefined);
    const clockOutLabel = timeCardMutationLabel(
        'clock-out',
        selectedStaffName,
        activeLocationName || undefined,
    );
    const canClockIn = clockInTargetIsExplicit && hasCurrentCards && canStartNewTimeCard;
    const canClockOut = Boolean(activeCardForSelectedUser && hasCurrentCards && teamClockOutTargetIsExplicit);

    return (
        <div style={{ display: 'grid', gap: '1rem', maxWidth: 1280 }}>
            <section className="surface-card" style={{ padding: '1rem', display: 'grid', gap: '0.85rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.8rem', flexWrap: 'wrap' }}>
                    <div>
                        <div className="workspace-kicker">Time clock</div>
                        <h1 className="workspace-title" style={{ fontSize: '1.55rem', marginBottom: 2 }}>Time Cards</h1>
                        <p className="workspace-subtitle">
                            {isTeamTime && !selectedUserId
                                ? 'Choose a person and location before any Team Time action.'
                                : isLoading
                                    ? 'Loading time cards...'
                                    : `${cards.length} card${cards.length === 1 ? '' : 's'} for ${selectedStaffName}`}
                        </p>
                    </div>
                    <button className="btn btn-secondary" onClick={() => void loadCards(selectedUserId, view)} disabled={!selectedUserId || isLoading || isSaving}>
                        Refresh
                    </button>
                </div>

                {canManageTeam ? (
                    <div role="group" aria-label="Time card view" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <button
                            type="button"
                            className={view === 'mine' ? 'btn btn-primary' : 'btn btn-secondary'}
                            aria-pressed={view === 'mine'}
                            onClick={() => selectView('mine')}
                            disabled={isSaving}
                        >
                            My Time
                        </button>
                        <button
                            type="button"
                            className={view === 'team' ? 'btn btn-primary' : 'btn btn-secondary'}
                            aria-pressed={view === 'team'}
                            onClick={() => selectView('team')}
                            disabled={isSaving}
                        >
                            Team Time
                        </button>
                    </div>
                ) : null}

                <div
                    className="surface-muted"
                    data-testid="time-card-selected-person"
                    style={{ padding: '0.75rem 0.85rem', display: 'flex', justifyContent: 'space-between', gap: '0.8rem', alignItems: 'center', flexWrap: 'wrap' }}
                >
                    <div>
                        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 800 }}>
                            {isTeamTime ? 'Team Time selected person' : 'My Time selected person'}
                        </div>
                        <div style={{ marginTop: 3, fontSize: '1rem', color: 'var(--text-primary)', fontWeight: 850 }}>
                            {isTeamTime ? selectedStaffName || 'No team member selected' : 'You - signed-in account'}
                        </div>
                    </div>
                    {selectedLocationName ? (
                        <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', fontWeight: 750 }}>{selectedLocationName}</div>
                    ) : null}
                </div>

                <div
                    role="note"
                    className="surface-muted"
                    style={{ padding: '0.7rem 0.8rem', color: 'var(--text-secondary)', fontSize: '0.83rem', fontWeight: 650 }}
                >
                    Operational time records only. Your payroll system remains the source of truth for wages, taxes, and filings.
                </div>

                {!canWriteTimeCards ? (
                    <div className="surface-muted" style={{ padding: '0.7rem 0.8rem', color: 'var(--text-secondary)', fontSize: '0.83rem', fontWeight: 650 }}>
                        Read-only time card access. Clock-in and clock-out actions are hidden for this role.
                    </div>
                ) : null}

                <div className="surface-muted" style={{ padding: '0.85rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '0.65rem', alignItems: 'end' }}>
                    {isTeamTime ? (
                        <label style={{ display: 'grid', gap: 5, fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                            Team member
                            <select
                                value={selectedTeamUserId}
                                onChange={(event) => selectEmployee(event.target.value)}
                                disabled={isSaving}
                                style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.45rem 0.5rem', background: '#fff', color: 'var(--text-primary)' }}
                            >
                                <option value="">Choose a team member</option>
                                {staff.map((person) => (
                                    <option key={person.id} value={person.id}>{person.name}</option>
                                ))}
                            </select>
                        </label>
                    ) : null}

                    {canReadLocations ? <label style={{ display: 'grid', gap: 5, fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                        {isTeamTime ? 'Team location' : 'My location'}
                        <select
                            value={selectedLocationId}
                            onChange={(event) => selectLocation(event.target.value)}
                            disabled={isSaving || !canWriteTimeCards || (isTeamTime && !selectedTeamUserId)}
                            style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.45rem 0.5rem', background: '#fff', color: 'var(--text-primary)' }}
                        >
                            <option value="">Choose a location</option>
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
                    {isTeamTime && !canReadLocations ? (
                        <div role="note" style={{ fontSize: '0.78rem', color: '#8a4b0f', fontWeight: 700 }}>
                            Team Time clock-ins require location access.
                        </div>
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
                            disabled={isSaving || !canWriteTimeCards || !selectedUserId}
                            style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.45rem 0.5rem', background: '#fff', color: 'var(--text-primary)' }}
                        />
                    </label>
                </div>

                {error ? <div role="alert" style={{ fontSize: '0.83rem', color: '#cb3653' }}>{error}</div> : null}
                {notice ? <div role="status" style={{ fontSize: '0.83rem', color: '#0f8c52' }}>{notice}</div> : null}

                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '0.8rem', alignItems: 'center' }}>
                    <div className="surface-muted" style={{ padding: '0.8rem' }}>
                        <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 800 }}>Current status</div>
                        <div style={{ marginTop: 4, fontSize: '1rem', fontWeight: 800, color: activeCardForSelectedUser ? '#166534' : 'var(--text-primary)' }}>
                            {!selectedUserId ? 'Choose a team member to load status.' : !hasCurrentCards ? 'Loading status...' : activeCardForSelectedUser
                                ? `Clocked in at ${formatTimeCardTimestamp(activeCardForSelectedUser.clockInAt, activeCardForSelectedUser.displayTimeZone)}`
                                : 'Not clocked in'}
                        </div>
                        {activeCardForSelectedUser?.location ? (
                            <div style={{ marginTop: 2, fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{activeCardForSelectedUser.location.name}</div>
                        ) : null}
                        {activeCardForSelectedUser && !teamClockOutTargetIsExplicit ? (
                            <div style={{ marginTop: 4, fontSize: '0.76rem', color: '#8a4b0f', fontWeight: 700 }}>
                                Choose {activeCardForSelectedUser.location?.name ?? 'the recorded work location'} to enable this Team Time clock-out.
                            </div>
                        ) : null}
                    </div>

                    {canWriteTimeCards ? (
                        activeCardForSelectedUser ? (
                            <button className="btn btn-primary" onClick={() => void clockOut()} disabled={isSaving || !canClockOut}>
                                {isSaving ? `Clocking out ${selectedStaffName}...` : clockOutLabel}
                            </button>
                        ) : (
                            <button className="btn btn-primary" onClick={() => void clockIn()} disabled={isSaving || !canClockIn}>
                                {isSaving ? `Clocking in ${selectedStaffName || 'team member'}...` : clockInLabel}
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
                        await loadCards(selectedUserId, view);
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
