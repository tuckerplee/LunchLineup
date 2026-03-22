'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { fetchWithSession } from '@/lib/client-api';

type LocationsWorkspaceProps = {
    canAdd: boolean;
};

type ApiLocation = {
    id: string;
    name: string;
    address?: string | null;
    timezone?: string | null;
};

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

export function LocationsWorkspace({ canAdd }: LocationsWorkspaceProps) {
    const [locations, setLocations] = useState<ApiLocation[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isCreating, setIsCreating] = useState(false);
    const [showCreate, setShowCreate] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    const [name, setName] = useState('');
    const [address, setAddress] = useState('');
    const [timezone, setTimezone] = useState('');

    const loadLocations = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const res = await fetchWithSession('/locations');
            if (!res.ok) {
                const payload = (await res.json().catch(() => ({}))) as { message?: unknown };
                const message = typeof payload.message === 'string' ? payload.message : 'Unable to load locations.';
                throw new Error(message);
            }
            const payload = (await res.json()) as { data?: ApiLocation[] };
            setLocations(Array.isArray(payload.data) ? payload.data : []);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unable to load locations.');
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadLocations();
    }, [loadLocations]);

    const submitCreate = useCallback(async () => {
        if (!canAdd) return;
        const trimmedName = name.trim();
        if (!trimmedName) {
            setError('Location name is required.');
            return;
        }

        setIsCreating(true);
        setError(null);
        setNotice(null);
        try {
            const res = await fetchWithSession('/locations', createJsonWriteInit({
                name: trimmedName,
                address: address.trim() || undefined,
                timezone: timezone.trim() || undefined,
            }));

            if (!res.ok) {
                const payload = (await res.json().catch(() => ({}))) as { message?: unknown };
                const message = typeof payload.message === 'string' ? payload.message : 'Unable to add location.';
                throw new Error(message);
            }

            const created = (await res.json()) as ApiLocation;
            setLocations((prev) => [created, ...prev]);
            setNotice('Location added.');
            setShowCreate(false);
            setName('');
            setAddress('');
            setTimezone('');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unable to add location.');
        } finally {
            setIsCreating(false);
        }
    }, [address, canAdd, name, timezone]);

    const total = useMemo(() => locations.length, [locations.length]);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 1280 }}>
            <section className="surface-card" style={{ padding: '1rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.8rem', flexWrap: 'wrap' }}>
                    <div>
                        <div className="workspace-kicker">Location workspace</div>
                        <h1 className="workspace-title" style={{ fontSize: '1.55rem', marginBottom: 2 }}>
                            Locations
                        </h1>
                        <p className="workspace-subtitle">{isLoading ? 'Loading locations...' : `${total} active location${total === 1 ? '' : 's'}`}</p>
                    </div>

                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <button className="btn btn-secondary" onClick={() => void loadLocations()} disabled={isLoading || isCreating}>
                            Refresh
                        </button>
                        {canAdd ? (
                            <button
                                className="btn btn-primary"
                                onClick={() => {
                                    setError(null);
                                    setNotice(null);
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
                    <div style={{ marginTop: '0.8rem', fontSize: '0.83rem', color: '#cb3653' }}>
                        {error}
                    </div>
                ) : null}
                {notice ? (
                    <div style={{ marginTop: '0.8rem', fontSize: '0.83rem', color: '#0f8c52' }}>
                        {notice}
                    </div>
                ) : null}

                {showCreate ? (
                    <div className="surface-muted" style={{ marginTop: '0.8rem', padding: '0.8rem', display: 'grid', gap: '0.6rem' }}>
                        <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-primary)' }}>Create location</div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 1fr) minmax(220px, 1fr) minmax(190px, 1fr) auto', gap: '0.5rem' }}>
                            <input
                                value={name}
                                onChange={(event) => setName(event.target.value)}
                                placeholder="Location name"
                                style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.45rem 0.5rem', background: '#fff', color: 'var(--text-primary)' }}
                            />
                            <input
                                value={address}
                                onChange={(event) => setAddress(event.target.value)}
                                placeholder="Address (optional)"
                                style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.45rem 0.5rem', background: '#fff', color: 'var(--text-primary)' }}
                            />
                            <input
                                value={timezone}
                                onChange={(event) => setTimezone(event.target.value)}
                                placeholder="Timezone (optional)"
                                style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.45rem 0.5rem', background: '#fff', color: 'var(--text-primary)' }}
                            />
                            <button className="btn btn-primary" onClick={() => void submitCreate()} disabled={isCreating}>
                                {isCreating ? 'Saving...' : 'Save'}
                            </button>
                        </div>
                    </div>
                ) : null}
            </section>

            <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '0.8rem' }}>
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

                        <div style={{ display: 'flex', gap: '0.5rem', paddingTop: '0.2rem' }}>
                            <Link href={`/dashboard/scheduling?location=${location.id}`} className="btn btn-secondary" style={{ flex: 1 }}>
                                View Schedule
                            </Link>
                        </div>
                    </article>
                ))}
            </section>
        </div>
    );
}
