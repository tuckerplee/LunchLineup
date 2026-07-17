'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchWithSession, withIdempotencyKey } from '@/lib/client-api';
import {
    invitationDeliveryView,
    parseInvitationDeliveryResponse,
    stableInvitationRetryKey,
    type InvitationDelivery,
    type InvitationDeliveryUiState,
} from './invitation-delivery';

type InvitationDirectoryUser = {
    id: string;
    email: string;
};

type UseInvitationDeliveryOptions = {
    canAdminister: boolean;
    users: InvitationDirectoryUser[];
};

async function fetchInvitationDelivery(userId: string): Promise<InvitationDelivery> {
    const response = await fetchWithSession(`/users/${encodeURIComponent(userId)}/invitation`);
    if (!response.ok) throw new Error('Invitation delivery status is unavailable.');
    const delivery = parseInvitationDeliveryResponse(await response.json().catch(() => null));
    if (!delivery) throw new Error('Invitation delivery status is unavailable.');
    return delivery;
}

function retryStorageKey(userId: string): string {
    return `lunchlineup:staff-invitation-retry:${userId}`;
}

function readStoredRetryKey(userId: string): string | null {
    if (typeof window === 'undefined') return null;
    try {
        return sessionStorage.getItem(retryStorageKey(userId));
    } catch {
        return null;
    }
}

function storeRetryKey(userId: string, key: string): void {
    if (typeof window === 'undefined') return;
    try {
        sessionStorage.setItem(retryStorageKey(userId), key);
    } catch {
        // The in-memory key still preserves retries for this page session.
    }
}

function clearStoredRetryKey(userId: string): void {
    if (typeof window === 'undefined') return;
    try {
        sessionStorage.removeItem(retryStorageKey(userId));
    } catch {
        // Storage can be unavailable in hardened browser contexts.
    }
}

export function useInvitationDelivery({ canAdminister, users }: UseInvitationDeliveryOptions) {
    const [states, setStates] = useState<Record<string, InvitationDeliveryUiState>>({});
    const [retryingUserIds, setRetryingUserIds] = useState<Set<string>>(() => new Set());
    const refreshGenerationRef = useRef(0);
    const retryAttemptKeysRef = useRef<Record<string, string>>({});
    const retryInFlightRef = useRef<Set<string>>(new Set());

    const clearRetryAttempt = useCallback((userId: string) => {
        delete retryAttemptKeysRef.current[userId];
        clearStoredRetryKey(userId);
    }, []);

    const refreshStatus = useCallback(async (userId: string, generation?: number) => {
        setStates((current) => ({
            ...current,
            [userId]: {
                delivery: current[userId]?.delivery ?? null,
                isLoading: true,
                error: null,
            },
        }));
        try {
            const delivery = await fetchInvitationDelivery(userId);
            if (generation !== undefined && generation !== refreshGenerationRef.current) return delivery;
            if (delivery.status !== 'FAILED' || !delivery.canRetry) clearRetryAttempt(userId);
            setStates((current) => ({
                ...current,
                [userId]: { delivery, isLoading: false, error: null },
            }));
            return delivery;
        } catch {
            if (generation !== undefined && generation !== refreshGenerationRef.current) return null;
            setStates((current) => ({
                ...current,
                [userId]: {
                    delivery: current[userId]?.delivery ?? null,
                    isLoading: false,
                    error: 'Unable to refresh invitation delivery. Try again.',
                },
            }));
            return null;
        }
    }, [clearRetryAttempt]);

    const refreshStatuses = useCallback(async (staffUsers: InvitationDirectoryUser[]) => {
        if (!canAdminister) return;
        const generation = refreshGenerationRef.current + 1;
        refreshGenerationRef.current = generation;
        const emailUsers = staffUsers.filter((user) => Boolean(user.email));

        setStates((current) => ({
            ...current,
            ...Object.fromEntries(staffUsers.map((user): [string, InvitationDeliveryUiState] => [
                user.id,
                user.email
                    ? { delivery: current[user.id]?.delivery ?? null, isLoading: true, error: null }
                    : {
                        delivery: {
                            status: 'NOT_APPLICABLE',
                            attempts: 0,
                            canRetry: false,
                            canReissue: false,
                        },
                        isLoading: false,
                        error: null,
                    },
            ])),
        }));

        for (let index = 0; index < emailUsers.length; index += 6) {
            if (generation !== refreshGenerationRef.current) return;
            await Promise.all(
                emailUsers.slice(index, index + 6).map((user) => refreshStatus(user.id, generation)),
            );
        }
    }, [canAdminister, refreshStatus]);

    const recordResponse = useCallback((userId: string, payload: unknown) => {
        const delivery = parseInvitationDeliveryResponse(payload);
        setStates((current) => ({
            ...current,
            [userId]: {
                delivery,
                isLoading: false,
                error: delivery ? null : 'Staff member created, but invitation delivery status is unavailable.',
            },
        }));
    }, []);

    const finishRetry = useCallback((userId: string) => {
        retryInFlightRef.current.delete(userId);
        setRetryingUserIds((current) => {
            const next = new Set(current);
            next.delete(userId);
            return next;
        });
    }, []);

    const retry = useCallback(async (userId: string) => {
        if (retryInFlightRef.current.has(userId)) return;
        retryInFlightRef.current.add(userId);
        setRetryingUserIds((current) => new Set(current).add(userId));
        setStates((current) => ({
            ...current,
            [userId]: {
                delivery: current[userId]?.delivery ?? null,
                isLoading: false,
                error: null,
            },
        }));

        const isReissue = states[userId]?.delivery?.status === 'DEAD_LETTERED'
            && states[userId]?.delivery?.canReissue === true;
        let key: string;
        try {
            key = stableInvitationRetryKey(
                retryAttemptKeysRef.current[userId] ?? readStoredRetryKey(userId),
                () => globalThis.crypto.randomUUID(),
            );
        } catch {
            finishRetry(userId);
            setStates((current) => ({
                ...current,
                [userId]: {
                    delivery: current[userId]?.delivery ?? null,
                    isLoading: false,
                    error: 'Unable to prepare the invitation retry. Try again.',
                },
            }));
            return;
        }
        retryAttemptKeysRef.current[userId] = key;
        storeRetryKey(userId, key);

        try {
            const response = await fetchWithSession(
                `/users/${encodeURIComponent(userId)}/invitation/${isReissue ? 'reissue' : 'retry'}`,
                withIdempotencyKey({ method: 'POST' }, key),
            );
            const delivery = parseInvitationDeliveryResponse(await response.json().catch(() => null));
            if (!response.ok || !delivery) throw new Error('Invitation recovery was not confirmed.');

            clearRetryAttempt(userId);
            setStates((current) => ({
                ...current,
                [userId]: { delivery, isLoading: false, error: null },
            }));
        } catch {
            let authoritative: InvitationDelivery | null = null;
            try {
                authoritative = await fetchInvitationDelivery(userId);
            } catch {
                // Keep the last known state and the same key after ambiguous request loss.
            }
            if (authoritative && !(
                (authoritative.status === 'FAILED' && authoritative.canRetry)
                || (authoritative.status === 'DEAD_LETTERED' && authoritative.canReissue)
            )) {
                clearRetryAttempt(userId);
            }
            setStates((current) => ({
                ...current,
                [userId]: {
                    delivery: authoritative ?? current[userId]?.delivery ?? null,
                    isLoading: false,
                    error: authoritative
                        ? 'The retry result could not be confirmed. The latest delivery status is shown.'
                        : `Unable to ${isReissue ? 'reissue' : 'retry'} invitation delivery. Try again with the same request.`,
                },
            }));
        } finally {
            finishRetry(userId);
        }
    }, [clearRetryAttempt, finishRetry, states]);

    useEffect(() => {
        if (!canAdminister) return;
        const activeUserIds = users
            .map((user) => ({ user, state: states[user.id] }))
            .filter(({ user, state }) => (
                Boolean(user.email)
                && Boolean(state?.delivery && invitationDeliveryView(state.delivery).shouldRefresh)
                && !state?.isLoading
                && !state?.error
                && !retryingUserIds.has(user.id)
            ))
            .map(({ user }) => user.id);
        if (activeUserIds.length === 0) return;

        const timer = window.setTimeout(() => {
            for (const userId of activeUserIds) void refreshStatus(userId);
        }, 6_000);
        return () => window.clearTimeout(timer);
    }, [canAdminister, refreshStatus, retryingUserIds, states, users]);

    return {
        states,
        retryingUserIds,
        recordResponse,
        refreshStatus,
        refreshStatuses,
        retry,
    };
}
