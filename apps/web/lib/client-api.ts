const API = process.env.NEXT_PUBLIC_API_URL ?? '/api/v1';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
let refreshPromise: Promise<Response> | null = null;

export type IdempotentRequestAttempt = {
    key: string;
    payloadFingerprint: string;
};

export function idempotentRequestAttempt(
    payload: unknown,
    current?: IdempotentRequestAttempt | null,
    keyFactory: () => string = () => globalThis.crypto.randomUUID(),
): IdempotentRequestAttempt {
    const payloadFingerprint = JSON.stringify(sortJsonValue(payload));
    if (current?.payloadFingerprint === payloadFingerprint) return current;
    return { key: keyFactory(), payloadFingerprint };
}

export function withIdempotencyKey(init: RequestInit, key: string): RequestInit {
    const normalizedKey = key.trim();
    if (!normalizedKey) throw new Error('Idempotency-Key cannot be blank.');
    const headers = new Headers(init.headers);
    headers.set('Idempotency-Key', normalizedKey);
    return { ...init, headers };
}

function sortJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((entry) => sortJsonValue(entry));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .filter(([, entry]) => entry !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => [key, sortJsonValue(entry)]),
    );
}

function toApiPath(path: string): string {
    if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith('//') || path.includes('\\')) {
        throw new Error('fetchWithSession only accepts same-origin API paths.');
    }
    const normalized = path.startsWith('/') ? path : `/${path}`;
    return `${API}${normalized}`;
}

export function apiPath(path: string): string {
    return toApiPath(path);
}

function getCsrfTokenFromCookie(): string {
    if (typeof document === 'undefined') return '';
    const pair = document.cookie.split('; ').find((entry) => entry.startsWith('csrf_token='));
    return pair ? decodeURIComponent(pair.split('=')[1] ?? '') : '';
}

function withSessionDefaults(init: RequestInit = {}): RequestInit {
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const csrfToken = getCsrfTokenFromCookie();

    if (UNSAFE_METHODS.has(method)) {
        if (csrfToken) {
            headers.set('x-csrf-token', csrfToken);
        } else {
            headers.delete('x-csrf-token');
        }
    }

    return {
        ...init,
        method,
        credentials: 'include',
        headers,
    };
}

function refreshSession(): Promise<Response> {
    if (refreshPromise) return refreshPromise;

    refreshPromise = fetch(toApiPath('/auth/refresh'), withSessionDefaults({ method: 'POST' }))
        .finally(() => {
            refreshPromise = null;
        });
    return refreshPromise;
}

function loginRedirectPath(): string {
    if (typeof window === 'undefined') return '/auth/login';
    const next = `${window.location.pathname}${window.location.search}`;
    return `/auth/login?next=${encodeURIComponent(next)}`;
}

export async function fetchWithSession(path: string, init: RequestInit = {}): Promise<Response> {
    const requestInit = withSessionDefaults(init);
    const endpoint = toApiPath(path);
    let response = await fetch(endpoint, requestInit);
    if (response.status !== 401) return response;

    const refresh = await refreshSession();

    if (!refresh.ok) {
        if (typeof window !== 'undefined') {
            window.location.assign(loginRedirectPath());
        }
        return response;
    }

    response = await fetch(endpoint, withSessionDefaults(init));
    if (response.status === 401 && typeof window !== 'undefined') {
        window.location.assign(loginRedirectPath());
    }
    return response;
}

export async function fetchJsonWithSession<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetchWithSession(path, init);
    if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const message = (payload as any)?.message;
        throw new Error(typeof message === 'string' ? message : `Request failed (${response.status})`);
    }
    return response.json() as Promise<T>;
}
