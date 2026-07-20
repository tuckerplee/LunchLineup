import { fetchWithSession } from '@/lib/client-api';
import { fetchAllBoundedPages, type BoundedPage } from '@/lib/bounded-pagination';
import type {
    LocationPage,
    StaffMember,
    TimeCard,
    TimeCardPage,
} from './time-card-types';

const LOCATION_PAGE_SIZE = 200;
export const TIME_CARD_PAGE_SIZE = 100;

export async function fetchStaffRoster(): Promise<StaffMember[]> {
    return fetchAllBoundedPages(
        '/shifts/staff-roster?limit=' + LOCATION_PAGE_SIZE,
        async (path) => {
            const response = await fetchWithSession(path);
            if (!response.ok) throw new Error('Unable to load staff.');
            return response.json() as Promise<BoundedPage<StaffMember>>;
        },
    );
}

export async function fetchLocationPage(cursor?: string): Promise<LocationPage> {
    const query = new URLSearchParams({ limit: String(LOCATION_PAGE_SIZE) });
    if (cursor) query.set('cursor', cursor);
    const response = await fetchWithSession('/locations?' + query.toString());
    if (!response.ok) throw new Error(cursor ? 'Unable to load more locations.' : 'Unable to load locations.');
    return response.json() as Promise<LocationPage>;
}

export function locationContinuation(page: LocationPage): string | null {
    if (page.pagination?.hasMore !== true) return null;
    const cursor = page.pagination.nextCursor;
    if (typeof cursor !== 'string' || !cursor) {
        throw new Error('Location list did not provide a continuation cursor.');
    }
    return cursor;
}

function timeCardQuery(userId: string, canManageTeam: boolean, cursor?: string): string {
    const query = new URLSearchParams({ limit: String(TIME_CARD_PAGE_SIZE) });
    if (cursor) query.set('cursor', cursor);
    if (canManageTeam && userId) query.set('userId', userId);
    return query.toString();
}

function activeTimeCardQuery(userId: string, canManageTeam: boolean): string {
    const query = new URLSearchParams();
    if (canManageTeam && userId) query.set('userId', userId);
    return query.toString();
}

export type TimeCardSnapshot = {
    activeCard: TimeCard | null;
    historyResponse: Response;
};

export async function fetchTimeCardSnapshot(userId: string, canManageTeam: boolean): Promise<TimeCardSnapshot> {
    const query = timeCardQuery(userId, canManageTeam);
    const activeQuery = activeTimeCardQuery(userId, canManageTeam);
    const [activeResponse, historyResponse] = await Promise.all([
        fetchWithSession('/time-cards/active?' + activeQuery),
        fetchWithSession('/time-cards?' + query),
    ]);
    if (!activeResponse.ok) throw new Error('Unable to load active time card.');

    const activePayload = (await activeResponse.json()) as { data?: TimeCard | null };
    return {
        activeCard: activePayload.data ?? null,
        historyResponse,
    };
}

export async function fetchEarlierTimeCards(
    userId: string,
    canManageTeam: boolean,
    cursor: string,
): Promise<TimeCardPage> {
    const response = await fetchWithSession('/time-cards?' + timeCardQuery(userId, canManageTeam, cursor));
    if (!response.ok) throw new Error('Unable to load earlier time cards.');
    return response.json() as Promise<TimeCardPage>;
}

export async function clockInTimeCard(
    payload: { userId?: string; locationId?: string; notes?: string },
    requestKey: string,
): Promise<void> {
    const response = await fetchWithSession('/time-cards/clock-in', jsonWriteInit('POST', payload, {
        'Idempotency-Key': requestKey,
    }));
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    if (!response.ok) throw new Error(body.message ?? 'Unable to clock in.');
}

export async function clockOutTimeCard(
    cardId: string,
    payload: { breakMinutes: number; notes?: string },
): Promise<void> {
    const response = await fetchWithSession('/time-cards/' + cardId + '/clock-out', jsonWriteInit('POST', payload));
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    if (!response.ok) throw new Error(body.message ?? 'Unable to clock out.');
}

export function jsonWriteInit(
    method: 'POST' | 'PUT' | 'PATCH',
    payload: unknown,
    extraHeaders: Record<string, string> = {},
): RequestInit {
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

function getCsrfToken(): string {
    if (typeof document === 'undefined') return '';
    const pair = document.cookie.split('; ').find((entry) => entry.startsWith('csrf_token='));
    return pair ? decodeURIComponent(pair.split('=')[1] ?? '') : '';
}
