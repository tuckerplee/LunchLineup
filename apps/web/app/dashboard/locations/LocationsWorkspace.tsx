'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { fetchWithSession, idempotentRequestAttempt, withIdempotencyKey, type IdempotentRequestAttempt } from '@/lib/client-api';
import { LocationLifecycleActions } from './LocationLifecycleActions';
import { LocationTimeZoneInput } from './LocationTimeZoneInput';
import { buildLocationCreatePayload, resolveBrowserIanaTimeZone } from './location-form';

type LocationsWorkspaceProps = {
    canWrite: boolean;
    canDelete: boolean;
};

type ApiLocation = {
    id: string;
    name: string;
    address?: string | null;
    timezone?: string | null;
};

type LocationListResponse = {
    data?: ApiLocation[];
    pagination?: {
        hasMore?: boolean;
        nextCursor?: string | null;
    };
};

const LOCATION_PAGE_SIZE = 100;

function mergeLocationRows(current: ApiLocation[], incoming: ApiLocation[]): ApiLocation[] {
    const byId = new Map(current.map((location) => [location.id, location]));
    for (const location of incoming) byId.set(location.id, location);
    return [...byId.values()].sort((left, right) => (
        left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
    ));
}

function getCsrfTokenFromCookie(): string {
    if (typeof document === 'undefined') return '';
    const pair = document.cookie
        .split('; ')
        .find((entry) => entry.startsWith('csrf_token='));
    return pair ? decodeURIComponent(pair.split('=')[1] ?? '') : '';
}

function createJsonWriteInit(payload: unknown): RequestInit {
    const csrfToken = getCsrfTokenFromCookie();
    return {
        method: 'POST',
        credentials: 'include',
        headers: {
            'Content-Type': 'application/json',
            ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
        },
        body: JSON.stringify(payload),
    };
}

export function LocationsWorkspace({ canWrite, canDelete }: LocationsWorkspaceProps) {
    const [locations, setLocations] = useState<ApiLocation[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [isCreating, setIsCreating] = useState(false);
    const [showCreate, setShowCreate] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const createAttemptRef = useRef<IdempotentRequestAttempt | null>(null);

    const [name, setName] = useState('');
    const [address, setAddress] = useState('');
    const [timezone, setTimezone] = useState('');

    const loadLocations = useCallback(async (cursor?: string) => {
        const append = Boolean(cursor);
        if (append) setIsLoadingMore(true);
        else setIsLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams({ limit: String(LOCATION_PAGE_SIZE) });
            if (cursor) params.set('cursor', cursor);
            const res = await fetchWithSession('/locations?' + params.toString());
            if (!res.ok) {
                const payload = (await res.json().catch(() => ({}))) as { message?: unknown };
                const message = typeof payload.message === 'string' ? payload.message : 'Unable to load locations.';
                throw new Error(message);
            }
            const payload = (await res.json()) as LocationListResponse;
            const rows = Array.isArray(payload.data) ? payload.data : [];
            const continuation = payload.pagination?.hasMore === true
                ? payload.pagination.nextCursor
                : null;
            if (payload.pagination?.hasMore === true && (typeof continuation !== 'string' || !continuation)) {
                throw new Error('Location list did not provide a continuation cursor.');
            }
            setLocations((current) => append ? mergeLocationRows(current, rows) : rows);
            setNextCursor(continuation ?? null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unable to load locations.');
        } finally {
            if (append) setIsLoadingMore(false);
            else setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadLocations();
    }, [loadLocations]);

    const submitCreate = useCallback(async () => {
        if (!canWrite) return;
        let payload;
        try {
            payload = buildLocationCreatePayload({ name, address, timezone });
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Enter valid location details.');
            return;
        }

        const attempt = idempotentRequestAttempt(payload, createAttemptRef.current);
        createAttemptRef.current = attempt;
        setIsCreating(true);
        setError(null);
        setNotice(null);
        try {
            const res = await fetchWithSession(
                '/locations',
                withIdempotencyKey(createJsonWriteInit(payload), attempt.key),
            );

            if (!res.ok) {
                const payload = (await res.json().catch(() => ({}))) as { message?: unknown };
                const message = typeof payload.message === 'string' ? payload.message : 'Unable to add location.';
                throw new Error(message);
            }

            const created = (await res.json()) as ApiLocation;
            setLocations((current) => mergeLocationRows(current, [created]));
            setNotice('Location added.');
            setShowCreate(false);
            setName('');
            setAddress('');
            setTimezone('');
            createAttemptRef.current = null;
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unable to add location.');
        } finally {
            setIsCreating(false);
        }
    }, [address, canWrite, name, timezone]);

    const total = useMemo(() => locations.length, [locations.length]);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', width: '100%', maxWidth: 1280, minWidth: 0 }}>
            <section className="surface-card" style={{ padding: '1rem', minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.8rem', flexWrap: 'wrap' }}>
                    <div>
                        <div className="workspace-kicker">Location workspace</div>
                        <h1 className="workspace-title" style={{ fontSize: '1.55rem', marginBottom: 2 }}>
                            Locations
                        </h1>
                        <p className="workspace-subtitle">{isLoading ? 'Loading locations...' : total + ' active location' + (total === 1 ? '' : 's') + (nextCursor ? ' loaded' : '')}</p>
                    </div>

                    <div style={{ display: 'flex', gap: '0.5rem', maxWidth: '100%', flexWrap: 'wrap' }}>
                        <button className="btn btn-secondary" onClick={() => void loadLocations()} disabled={isLoading || isLoadingMore || isCreating}>
                            Refresh
                        </button>
                        {canWrite ? (
                            <button
                                type="button"
                                className="btn btn-primary"
                                aria-expanded={showCreate}
                                aria-controls="create-location-form"
                                onClick={() => {
                                    setError(null);
                                    setNotice(null);
                                    if (!showCreate && !timezone) {
                                        setTimezone(resolveBrowserIanaTimeZone());
                                    }
                                    setShowCreate((prev) => !prev);
                                }}
                                disabled={isCreating}
                            >
                                + Add Location
                            </button>
                        ) : null}
                    </div>
                </div>

                {error ? (
                    <div style={{ marginTop: '0.8rem', fontSize: '0.83rem', color: '#cb3653' }} role="alert">
                        {error}
                    </div>
                ) : null}
                {notice ? (
                    <div style={{ marginTop: '0.8rem', fontSize: '0.83rem', color: '#0f8c52' }} role="status">
                        {notice}
                    </div>
                ) : null}

                {showCreate ? (
                    <form
                        id="create-location-form"
                        aria-label="Create location"
                        className="surface-muted"
                        style={{ marginTop: '0.8rem', padding: '0.8rem', display: 'grid', gap: '0.6rem', width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box' }}
                        onSubmit={(event) => {
                            event.preventDefault();
                            void submitCreate();
                        }}
                    >
                        <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-primary)' }}>Create location</div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(190px, 100%), 1fr))', gap: '0.5rem', width: '100%', minWidth: 0 }}>
                            <input
                                value={name}
                                onChange={(event) => setName(event.target.value)}
                                aria-label="Location name"
                                placeholder="Location name"
                                style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.45rem 0.5rem', background: '#fff', color: 'var(--text-primary)', width: '100%', minWidth: 0, boxSizing: 'border-box' }}
                            />
                            <input
                                value={address}
                                onChange={(event) => setAddress(event.target.value)}
                                aria-label="Address"
                                placeholder="Address (optional)"
                                style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.45rem 0.5rem', background: '#fff', color: 'var(--text-primary)', width: '100%', minWidth: 0, boxSizing: 'border-box' }}
                            />
                            <LocationTimeZoneInput
                                id="create-location-timezone"
                                value={timezone}
                                onChange={setTimezone}
                                style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.45rem 0.5rem', background: '#fff', color: 'var(--text-primary)', width: '100%', minWidth: 0, boxSizing: 'border-box' }}
                            />
                            <button type="submit" className="btn btn-primary" disabled={isCreating}>
                                {isCreating ? 'Saving...' : 'Save'}
                            </button>
                        </div>
                    </form>
                ) : null}
            </section>

            <section aria-label="Active locations" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))', gap: '0.8rem' }}>
                {!isLoading && locations.length === 0 ? (
                    <article className="surface-card" style={{ padding: '1rem' }}>
                        <div style={{ color: 'var(--text-secondary)', fontSize: '0.88rem' }}>No locations yet.</div>
                    </article>
                ) : null}

                {locations.map((location) => (
                    <article key={location.id} className="surface-card" style={{ padding: '1rem', display: 'grid', gap: '0.8rem' }}>
                        <div>
                            <h2 style={{ fontSize: '1rem', fontWeight: 750, color: 'var(--text-primary)', marginBottom: 3 }}>{location.name}</h2>
                            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{location.address || 'No address set'}</p>
                        </div>

                        <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>
                            Timezone: {location.timezone || 'Not set'}
                        </div>

                        <div style={{ display: 'flex', gap: '0.5rem', paddingTop: '0.2rem', flexWrap: 'wrap' }}>
                            <Link href={`/dashboard/scheduling?location=${location.id}`} className="btn btn-secondary">
                                View schedule
                            </Link>
                            <LocationLifecycleActions
                                location={location}
                                canWrite={canWrite}
                                canDelete={canDelete}
                                onUpdated={(updated) => setLocations((current) => current.map((candidate) => (
                                    candidate.id === updated.id ? updated : candidate
                                )))}
                                onDeactivated={(locationId) => setLocations((current) => current.filter((candidate) => candidate.id !== locationId))}
                                onError={(message) => setError(message || null)}
                                onNotice={(message) => {
                                    setError(null);
                                    setNotice(message);
                                }}
                            />
                        </div>
                    </article>
                ))}
            </section>
            {nextCursor ? (
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => void loadLocations(nextCursor)}
                        disabled={isLoading || isLoadingMore || isCreating}
                    >
                        {isLoadingMore ? 'Loading...' : 'Load more locations'}
                    </button>
                </div>
            ) : null}
        </div>
    );
}
