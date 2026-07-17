'use client';

import { Pencil, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { fetchWithSession } from '@/lib/client-api';
import { LocationTimeZoneInput } from './LocationTimeZoneInput';
import { buildLocationUpdatePayload, persistedLocationFormValues } from './location-form';

export type LocationSummary = {
    id: string;
    name: string;
    address?: string | null;
    timezone?: string | null;
};

type LocationLifecycleActionsProps = {
    location: LocationSummary;
    canWrite: boolean;
    canDelete: boolean;
    onUpdated: (location: LocationSummary) => void;
    onDeactivated: (locationId: string) => void;
    onError: (message: string) => void;
    onNotice: (message: string) => void;
};

async function readMessage(response: Response, fallback: string): Promise<string> {
    const payload = (await response.json().catch(() => ({}))) as { message?: unknown };
    return typeof payload.message === 'string' && payload.message.trim() ? payload.message : fallback;
}

function jsonWrite(method: 'PUT' | 'DELETE', payload?: unknown): RequestInit {
    return {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    };
}

export function LocationLifecycleActions({
    location,
    canWrite,
    canDelete,
    onUpdated,
    onDeactivated,
    onError,
    onNotice,
}: LocationLifecycleActionsProps) {
    const initialDrafts = persistedLocationFormValues(location);
    const [mode, setMode] = useState<'idle' | 'edit' | 'delete'>('idle');
    const [name, setName] = useState(initialDrafts.name);
    const [address, setAddress] = useState(initialDrafts.address);
    const [timezone, setTimezone] = useState(initialDrafts.timezone);
    const [confirmation, setConfirmation] = useState('');
    const [isSaving, setIsSaving] = useState(false);
    const deactivateTriggerRef = useRef<HTMLButtonElement>(null);
    const deactivateDialogRef = useRef<HTMLDivElement>(null);
    const restoreDeactivateFocusRef = useRef(false);

    const resetEditDrafts = (persisted: LocationSummary = location) => {
        const drafts = persistedLocationFormValues(persisted);
        setName(drafts.name);
        setAddress(drafts.address);
        setTimezone(drafts.timezone);
    };

    const closeDeactivateDialog = () => {
        restoreDeactivateFocusRef.current = true;
        setMode('idle');
    };

    useEffect(() => {
        if (mode !== 'delete') {
            if (restoreDeactivateFocusRef.current) {
                restoreDeactivateFocusRef.current = false;
                deactivateTriggerRef.current?.focus();
            }
            return;
        }

        const dialog = deactivateDialogRef.current;
        if (!dialog) return;

        const focusableSelector = [
            'a[href]',
            'button:not([disabled])',
            'input:not([disabled])',
            'select:not([disabled])',
            'textarea:not([disabled])',
            '[tabindex]:not([tabindex="-1"])',
        ].join(',');
        const focusableElements = () => Array.from(
            dialog.querySelectorAll<HTMLElement>(focusableSelector),
        ).filter((element) => element.getClientRects().length > 0);

        focusableElements()[0]?.focus();

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                restoreDeactivateFocusRef.current = true;
                setMode('idle');
                return;
            }
            if (event.key !== 'Tab') return;

            const focusable = focusableElements();
            if (focusable.length === 0) {
                event.preventDefault();
                dialog.focus();
                return;
            }

            const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
            const leavingStart = event.shiftKey && activeIndex <= 0;
            const leavingEnd = !event.shiftKey && (activeIndex === -1 || activeIndex === focusable.length - 1);
            if (!leavingStart && !leavingEnd) return;

            event.preventDefault();
            focusable[event.shiftKey ? focusable.length - 1 : 0]?.focus();
        };

        document.addEventListener('keydown', handleKeyDown, true);
        return () => document.removeEventListener('keydown', handleKeyDown, true);
    }, [mode]);

    const save = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        let payload;
        try {
            payload = buildLocationUpdatePayload({ name, address, timezone });
        } catch (error) {
            onError(error instanceof Error ? error.message : 'Enter valid location details.');
            return;
        }

        setIsSaving(true);
        onError('');
        try {
            const response = await fetchWithSession(
                '/locations/' + encodeURIComponent(location.id),
                jsonWrite('PUT', payload),
            );
            if (!response.ok) throw new Error(await readMessage(response, 'Unable to update location.'));
            const updated = (await response.json()) as LocationSummary;
            resetEditDrafts(updated);
            onUpdated(updated);
            onNotice('Location updated.');
            setMode('idle');
        } catch (error) {
            onError(error instanceof Error ? error.message : 'Unable to update location.');
        } finally {
            setIsSaving(false);
        }
    };

    const deactivate = async () => {
        if (confirmation.trim() !== location.name) {
            onError('Confirmation must exactly match the location name.');
            return;
        }

        setIsSaving(true);
        onError('');
        try {
            const response = await fetchWithSession(
                '/locations/' + encodeURIComponent(location.id),
                jsonWrite('DELETE'),
            );
            if (!response.ok && response.status !== 204) {
                throw new Error(await readMessage(response, 'Unable to deactivate location.'));
            }
            onDeactivated(location.id);
            onNotice(location.name + ' deactivated.');
            setMode('idle');
        } catch (error) {
            onError(error instanceof Error ? error.message : 'Unable to deactivate location.');
        } finally {
            setIsSaving(false);
        }
    };

    if (mode === 'edit') {
        return (
            <form onSubmit={save} style={{ display: 'grid', gap: '0.6rem' }} aria-label={'Edit ' + location.name}>
                <label className="form-group">
                    <span className="form-label">Location name</span>
                    <input className="form-input" value={name} onChange={(event) => setName(event.target.value)} required disabled={isSaving} />
                </label>
                <label className="form-group">
                    <span className="form-label">Address</span>
                    <input className="form-input" value={address} onChange={(event) => setAddress(event.target.value)} disabled={isSaving} />
                </label>
                <label className="form-group">
                    <span className="form-label">IANA timezone</span>
                    <LocationTimeZoneInput
                        id={'location-timezone-' + location.id}
                        value={timezone}
                        onChange={setTimezone}
                        disabled={isSaving}
                    />
                </label>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <button type="submit" className="btn btn-primary" disabled={isSaving}>
                        {isSaving ? 'Saving...' : 'Save changes'}
                    </button>
                    <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => {
                            resetEditDrafts();
                            setMode('idle');
                        }}
                        disabled={isSaving}
                    >
                        Cancel
                    </button>
                </div>
            </form>
        );
    }

    return (
        <>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {canWrite ? (
                    <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => {
                            resetEditDrafts();
                            setMode('edit');
                        }}
                    >
                        <Pencil size={15} aria-hidden="true" />
                        Edit
                    </button>
                ) : null}
                {canDelete ? (
                    <button
                        type="button"
                        ref={deactivateTriggerRef}
                        className="btn btn-secondary"
                        style={{ borderColor: '#ffd0da', color: '#b4233f' }}
                        aria-haspopup="dialog"
                        onClick={() => {
                            restoreDeactivateFocusRef.current = false;
                            setConfirmation('');
                            setMode('delete');
                        }}
                    >
                        <Trash2 size={15} aria-hidden="true" />
                        Deactivate
                    </button>
                ) : null}
            </div>

            {mode === 'delete' ? (
                <div className="staff-confirmation-backdrop" role="presentation">
                    <div
                        ref={deactivateDialogRef}
                        className="staff-confirmation-dialog"
                        role="alertdialog"
                        tabIndex={-1}
                        aria-modal="true"
                        aria-labelledby={'location-deactivation-title-' + location.id}
                        aria-describedby={'location-deactivation-description-' + location.id}
                    >
                        <div>
                            <h2 id={'location-deactivation-title-' + location.id}>Deactivate {location.name}?</h2>
                            <p id={'location-deactivation-description-' + location.id}>
                                This removes the location from active scheduling and invalidates its draft schedule work. Published history is retained.
                            </p>
                        </div>
                        <label className="form-group">
                            <span className="form-label">Type the location name to confirm</span>
                            <input
                                className="form-input"
                                value={confirmation}
                                onChange={(event) => setConfirmation(event.target.value)}
                                autoFocus
                                disabled={isSaving}
                            />
                        </label>
                        <div className="staff-confirmation-actions">
                            <button type="button" className="btn btn-secondary" onClick={closeDeactivateDialog} disabled={isSaving}>
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="btn btn-primary"
                                style={{ background: '#b4233f', borderColor: '#b4233f' }}
                                onClick={() => void deactivate()}
                                disabled={confirmation.trim() !== location.name || isSaving}
                            >
                                <Trash2 size={16} aria-hidden="true" />
                                {isSaving ? 'Deactivating...' : 'Deactivate location'}
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}
        </>
    );
}
