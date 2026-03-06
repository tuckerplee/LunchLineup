const API = process.env.NEXT_PUBLIC_API_URL ?? '/api/v1';

function toApiPath(path: string): string {
    if (path.startsWith('http://') || path.startsWith('https://')) {
        return path;
    }
    const normalized = path.startsWith('/') ? path : `/${path}`;
    return `${API}${normalized}`;
}

function loginRedirectPath(): string {
    if (typeof window === 'undefined') return '/auth/login';
    const next = `${window.location.pathname}${window.location.search}`;
    return `/auth/login?next=${encodeURIComponent(next)}`;
}

export async function fetchWithSession(path: string, init: RequestInit = {}): Promise<Response> {
    const requestInit: RequestInit = {
        ...init,
        credentials: 'include',
    };

    const endpoint = toApiPath(path);
    let response = await fetch(endpoint, requestInit);
    if (response.status !== 401) return response;

    const refresh = await fetch(toApiPath('/auth/refresh'), {
        method: 'POST',
        credentials: 'include',
    });

    if (!refresh.ok) {
        if (typeof window !== 'undefined') {
            window.location.href = loginRedirectPath();
        }
        return response;
    }

    response = await fetch(endpoint, requestInit);
    if (response.status === 401 && typeof window !== 'undefined') {
        window.location.href = loginRedirectPath();
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
