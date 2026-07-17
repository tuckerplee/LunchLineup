'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { fetchJsonWithSession } from '@/lib/client-api';

import { AvailabilityPdfImport } from './AvailabilityPdfImport';

type StaffSchedulingProfileEditorProps = {
    user: { id: string; name: string; email: string; username?: string };
    onClose: () => void;
};

type Location = { id: string; name: string };
type LocationPage = {
    data?: Location[];
    pagination?: { hasMore?: boolean; nextCursor?: string | null };
};
type AvailabilityWindow = {
    locationId: string | null;
    dayOfWeek: number;
    startTimeMinutes: number;
    endTimeMinutes: number;
};
type SchedulingProfile = {
    skills: string[];
    availability: AvailabilityWindow[];
    availabilityConfigured: boolean;
};

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function timeValue(minutes: number): string {
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function timeMinutes(value: string): number {
    const [hours, minutes] = value.split(':').map(Number);
    return hours * 60 + minutes;
}

export function StaffSchedulingProfileEditor({ user, onClose }: StaffSchedulingProfileEditorProps) {
    const [skills, setSkills] = useState<string[]>([]);
    const [skillDraft, setSkillDraft] = useState('');
    const [availability, setAvailability] = useState<AvailabilityWindow[]>([]);
    const [locations, setLocations] = useState<Location[]>([]);
    const [isProfileLoading, setIsProfileLoading] = useState(true);
    const [isProfileHydrated, setIsProfileHydrated] = useState(false);
    const [profileLoadError, setProfileLoadError] = useState<string | null>(null);
    const [isLocationsLoading, setIsLocationsLoading] = useState(true);
    const [isLoadingMoreLocations, setIsLoadingMoreLocations] = useState(false);
    const [nextLocationCursor, setNextLocationCursor] = useState<string | null>(null);
    const [locationLoadError, setLocationLoadError] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const profileLoadRequestRef = useRef(0);
    const locationLoadRequestRef = useRef(0);
    const saveInFlightRef = useRef(false);

    const loadProfile = useCallback(async () => {
        const requestId = ++profileLoadRequestRef.current;
        setIsProfileLoading(true);
        setIsProfileHydrated(false);
        setProfileLoadError(null);
        setError(null);
        setMessage(null);
        try {
            const profile = await fetchJsonWithSession<SchedulingProfile>(`/users/${user.id}/scheduling-profile`);
            if (requestId !== profileLoadRequestRef.current) return;
            setSkills(profile.skills);
            setAvailability(profile.availability);
            setSkillDraft('');
            setIsProfileHydrated(true);
        } catch (loadError) {
            if (requestId !== profileLoadRequestRef.current) return;
            setProfileLoadError((loadError as Error).message);
        } finally {
            if (requestId === profileLoadRequestRef.current) setIsProfileLoading(false);
        }
    }, [user.id]);

    const loadLocations = useCallback(async (cursor?: string) => {
        const requestId = ++locationLoadRequestRef.current;
        const append = Boolean(cursor);
        if (append) setIsLoadingMoreLocations(true);
        else setIsLocationsLoading(true);
        setLocationLoadError(null);
        try {
            const path = '/locations?limit=200' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
            const payload = await fetchJsonWithSession<LocationPage>(path);
            if (requestId !== locationLoadRequestRef.current) return;
            const rows = Array.isArray(payload.data) ? payload.data : [];
            const continuation = payload.pagination?.hasMore === true ? payload.pagination.nextCursor : null;
            if (payload.pagination?.hasMore === true && (typeof continuation !== 'string' || !continuation)) {
                throw new Error('Location list did not provide a continuation cursor.');
            }
            setLocations((current) => {
                if (!append) return rows;
                const byId = new Map(current.map((location) => [location.id, location]));
                for (const location of rows) byId.set(location.id, location);
                return [...byId.values()];
            });
            setNextLocationCursor(continuation ?? null);
        } catch (loadError) {
            if (requestId !== locationLoadRequestRef.current) return;
            setLocationLoadError((loadError as Error).message);
        } finally {
            if (requestId === locationLoadRequestRef.current) {
                if (append) setIsLoadingMoreLocations(false);
                else setIsLocationsLoading(false);
            }
        }
    }, []);

    useEffect(() => {
        void loadProfile();
        void loadLocations();
    }, [loadLocations, loadProfile]);

    const missingLocationIds = useMemo(() => {
        const loadedIds = new Set(locations.map((location) => location.id));
        return [...new Set(availability
            .map((window) => window.locationId)
            .filter((locationId): locationId is string => Boolean(locationId) && !loadedIds.has(locationId as string)))];
    }, [availability, locations]);

    const addSkill = useCallback(() => {
        if (!isProfileHydrated) return;
        const normalized = skillDraft.trim().replace(/\s+/g, ' ').toLowerCase();
        if (!normalized || skills.includes(normalized)) {
            setSkillDraft('');
            return;
        }
        if (skills.length >= 50) {
            setError('A staff profile can have at most 50 skills.');
            return;
        }
        setSkills((current) => [...current, normalized].sort());
        setSkillDraft('');
        setMessage(null);
    }, [isProfileHydrated, skillDraft, skills]);

    const addAvailability = useCallback(() => {
        if (!isProfileHydrated) return;
        if (availability.length >= 21) {
            setError('A staff profile can have at most 21 availability windows.');
            return;
        }
        setAvailability((current) => [...current, {
            locationId: null,
            dayOfWeek: 1,
            startTimeMinutes: 540,
            endTimeMinutes: 1020,
        }]);
        setMessage(null);
    }, [availability.length, isProfileHydrated]);

    const updateAvailability = useCallback((index: number, changes: Partial<AvailabilityWindow>) => {
        if (!isProfileHydrated) return;
        setAvailability((current) => current.map((window, windowIndex) => (
            windowIndex === index ? { ...window, ...changes } : window
        )));
        setMessage(null);
    }, [isProfileHydrated]);

    const save = useCallback(async (
        nextAvailability: AvailabilityWindow[] = availability,
        successMessage?: string,
    ): Promise<boolean> => {
        if (!isProfileHydrated || saveInFlightRef.current) return false;
        saveInFlightRef.current = true;
        setIsSaving(true);
        setError(null);
        setMessage(null);
        try {
            const profile = await fetchJsonWithSession<SchedulingProfile>(
                `/users/${user.id}/scheduling-profile`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ skills, availability: nextAvailability }),
                },
            );
            setSkills(profile.skills);
            setAvailability(profile.availability);
            setMessage(successMessage ?? (profile.availabilityConfigured
                ? 'Scheduling profile saved.'
                : 'Profile saved. This staff member remains unavailable to auto-scheduling.'));
            return true;
        } catch (saveError) {
            setError((saveError as Error).message);
            return false;
        } finally {
            setIsSaving(false);
            saveInFlightRef.current = false;
        }
    }, [availability, isProfileHydrated, skills, user.id]);

    const applyImportedAvailability = useCallback((importedAvailability: AvailabilityWindow[]) => (
        save(importedAvailability, 'Imported availability applied and scheduling profile saved.')
    ), [save]);

    return (
        <section className="surface-card" aria-label={`Scheduling profile for ${user.name}`} style={{ padding: '1rem', display: 'grid', gap: '1rem' }}>
            <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                <div>
                    <div className="workspace-kicker">Scheduling profile</div>
                    <h2 className="workspace-title" style={{ fontSize: '1.15rem', marginBottom: 2 }}>{user.name}</h2>
                </div>
                <Button type="button" variant="ghost" size="icon" onClick={onClose} title="Close scheduling profile" aria-label="Close scheduling profile">
                    <X aria-hidden="true" size={18} />
                </Button>
            </header>

            {isProfileLoading ? <div style={{ color: 'var(--text-muted)', fontSize: '0.84rem' }}>Loading scheduling profile...</div> : !isProfileHydrated ? (
                <div style={{ display: 'grid', gap: '0.75rem' }}>
                    <div role="alert" style={{ border: '1px solid #f0b4ae', background: '#fff5f4', color: '#8f231a', padding: '0.75rem', borderRadius: 6, fontSize: '0.82rem' }}>
                        {profileLoadError ?? 'Unable to load the scheduling profile.'} Existing profile data has not been replaced.
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
                        <Button type="button" variant="outline" onClick={() => void loadProfile()}>
                            <RefreshCw aria-hidden="true" size={15} /> Retry profile load
                        </Button>
                        <Button type="button" disabled>
                            <Save aria-hidden="true" size={16} /> Save profile
                        </Button>
                    </div>
                </div>
            ) : (
                <>
                    <div style={{ display: 'grid', gap: '0.65rem' }}>
                        <label htmlFor="staff-skill" style={{ fontSize: '0.78rem', fontWeight: 700 }}>Skills</label>
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <input
                                id="staff-skill"
                                value={skillDraft}
                                maxLength={64}
                                onChange={(event) => setSkillDraft(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter') {
                                        event.preventDefault();
                                        addSkill();
                                    }
                                }}
                                placeholder="Skill name"
                                disabled={!isProfileHydrated}
                                style={{ flex: 1, minWidth: 0, border: '1px solid var(--border)', borderRadius: 6, padding: '0.55rem 0.65rem' }}
                            />
                            <Button type="button" variant="outline" onClick={addSkill} disabled={!isProfileHydrated || !skillDraft.trim()}>
                                <Plus aria-hidden="true" size={15} /> Add skill
                            </Button>
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', minHeight: 28 }}>
                            {skills.map((skill) => (
                                <span key={skill} className="surface-muted" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', padding: '0.25rem 0.35rem 0.25rem 0.5rem', fontSize: '0.76rem', fontWeight: 700 }}>
                                    {skill}
                                    <button
                                        type="button"
                                        onClick={() => setSkills((current) => current.filter((entry) => entry !== skill))}
                                        disabled={!isProfileHydrated}
                                        title={`Remove ${skill}`}
                                        aria-label={`Remove ${skill}`}
                                        style={{ display: 'grid', placeItems: 'center', border: 0, background: 'transparent', padding: 2, cursor: 'pointer', color: 'var(--text-muted)' }}
                                    >
                                        <X aria-hidden="true" size={13} />
                                    </button>
                                </span>
                            ))}
                            {skills.length === 0 ? <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>No skills assigned.</span> : null}
                        </div>
                    </div>

                    <AvailabilityPdfImport
                        key={user.id}
                        userId={user.id}
                        suggestedStaffIdentity={user.username?.trim() || user.email.trim()}
                        disabled={isSaving || !isProfileHydrated}
                        onApply={applyImportedAvailability}
                    />

                    <div style={{ display: 'grid', gap: '0.65rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem' }}>
                            <div style={{ fontSize: '0.78rem', fontWeight: 700 }}>Weekly availability</div>
                            <Button type="button" size="sm" variant="outline" onClick={addAvailability} disabled={!isProfileHydrated}>
                                <Plus aria-hidden="true" size={14} /> Add window
                            </Button>
                        </div>
                        {availability.length === 0 ? (
                            <div role="status" style={{ border: '1px solid #e8b04d', background: '#fff8e8', color: '#6f4a00', padding: '0.75rem', borderRadius: 6, fontSize: '0.82rem' }}>
                                Availability is not configured. This staff member is unavailable to auto-scheduling.
                            </div>
                        ) : null}
                        {isLocationsLoading ? (
                            <div role="status" style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Loading location labels...</div>
                        ) : locationLoadError ? (
                            <div role="alert" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', border: '1px solid #f0b4ae', background: '#fff5f4', color: '#8f231a', padding: '0.65rem 0.75rem', borderRadius: 6, fontSize: '0.8rem' }}>
                                <span>{locationLoadError} Existing location assignments are preserved.</span>
                                <Button type="button" size="sm" variant="outline" onClick={() => void loadLocations()}>
                                    <RefreshCw aria-hidden="true" size={14} /> Retry locations
                                </Button>
                            </div>
                        ) : null}
                        {nextLocationCursor ? (
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => void loadLocations(nextLocationCursor)}
                                disabled={isLocationsLoading || isLoadingMoreLocations}
                            >
                                <RefreshCw aria-hidden="true" size={14} />
                                {isLoadingMoreLocations ? 'Loading locations...' : 'Load more locations'}
                            </Button>
                        ) : null}
                        <div style={{ display: 'grid', gap: '0.55rem' }}>
                            {availability.map((window, index) => (
                                <div key={`${index}-${window.dayOfWeek}-${window.startTimeMinutes}`} className="surface-muted staff-scheduling-window" style={{ padding: '0.7rem', display: 'grid', gap: '0.5rem', alignItems: 'end' }}>
                                    <label style={{ display: 'grid', gap: '0.25rem', fontSize: '0.7rem', fontWeight: 700 }}>
                                        Day
                                        <select value={window.dayOfWeek} onChange={(event) => updateAvailability(index, { dayOfWeek: Number(event.target.value) })} style={{ height: 36, border: '1px solid var(--border)', borderRadius: 6, padding: '0 0.45rem', background: '#fff' }}>
                                            {DAYS.map((day, dayIndex) => <option key={day} value={dayIndex}>{day}</option>)}
                                        </select>
                                    </label>
                                    <label style={{ display: 'grid', gap: '0.25rem', fontSize: '0.7rem', fontWeight: 700 }}>
                                        Location
                                        <select value={window.locationId ?? ''} disabled={isLocationsLoading || Boolean(locationLoadError)} onChange={(event) => updateAvailability(index, { locationId: event.target.value || null })} style={{ height: 36, border: '1px solid var(--border)', borderRadius: 6, padding: '0 0.45rem', background: '#fff' }}>
                                            <option value="">All locations</option>
                                            {locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
                                            {missingLocationIds.map((locationId) => <option key={locationId} value={locationId}>Location unavailable ({locationId})</option>)}
                                        </select>
                                    </label>
                                    <label style={{ display: 'grid', gap: '0.25rem', fontSize: '0.7rem', fontWeight: 700 }}>
                                        Start
                                        <input type="time" value={timeValue(window.startTimeMinutes)} onChange={(event) => updateAvailability(index, { startTimeMinutes: timeMinutes(event.target.value) })} style={{ height: 36, border: '1px solid var(--border)', borderRadius: 6, padding: '0 0.45rem' }} />
                                    </label>
                                    <label style={{ display: 'grid', gap: '0.25rem', fontSize: '0.7rem', fontWeight: 700 }}>
                                        End {window.startTimeMinutes > window.endTimeMinutes ? '(overnight)' : ''}
                                        <input type="time" value={timeValue(window.endTimeMinutes)} onChange={(event) => updateAvailability(index, { endTimeMinutes: timeMinutes(event.target.value) })} style={{ height: 36, border: '1px solid var(--border)', borderRadius: 6, padding: '0 0.45rem' }} />
                                    </label>
                                    <Button type="button" variant="ghost" size="icon" disabled={!isProfileHydrated} onClick={() => setAvailability((current) => current.filter((_, windowIndex) => windowIndex !== index))} title="Remove availability window" aria-label="Remove availability window" style={{ width: 34, height: 34 }}>
                                        <Trash2 aria-hidden="true" size={15} />
                                    </Button>
                                </div>
                            ))}
                        </div>
                    </div>

                    <footer style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                        <div aria-live="polite" style={{ fontSize: '0.8rem', color: error ? '#b42318' : 'var(--text-muted)' }}>{error ?? message}</div>
                        <Button type="button" onClick={() => void save()} disabled={isSaving || !isProfileHydrated}>
                            {isSaving ? <CalendarClock aria-hidden="true" size={16} /> : <Save aria-hidden="true" size={16} />}
                            {isSaving ? 'Saving...' : 'Save profile'}
                        </Button>
                    </footer>
                </>
            )}
        </section>
    );
}
