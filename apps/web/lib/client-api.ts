import {
    applicationApiOperation,
    type ApplicationApiMethod,
} from '@lunchlineup/api-contract';
import { safeSameOriginReturnPath } from './safe-navigation';
import {
    DEFAULT_JSON_RESPONSE_LIMIT_BYTES,
    ResponseBodyLimitError,
    readBoundedResponseBytes,
    withRequestTimeout,
} from './http-safety';

const API_V2 = '/api/v2';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
let refreshPromise: Promise<Response> | null = null;
const SAFE_JSON_CONTENT_TYPE = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i;
const CLIENT_REQUEST_TIMEOUT_MS = 15_000;

export class ApiRequestError extends Error {
    readonly status: number | null;

    constructor(message: string, status: number | null = null) {
        super(message);
        this.name = 'ApiRequestError';
        this.status = status;
    }
}

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

export function withIdempotencyKey<T extends RequestInit>(
    init: T,
    key: string,
): Omit<T, 'headers'> & { headers: Headers } {
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

function applicationMethod(init: RequestInit = {}): ApplicationApiMethod {
    const method = (init.method ?? 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        throw new Error('The API v2 application client does not support this HTTP method.');
    }
    return method as ApplicationApiMethod;
}

function toApiPath(path: string, method: ApplicationApiMethod): string {
    if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith('//') || path.includes('\\')) {
        throw new Error('fetchWithSession only accepts same-origin API paths.');
    }
    const normalized = path.startsWith('/') ? path : `/${path}`;
    if (!applicationApiOperation(normalized, method)) {
        throw new Error('The requested operation is not part of the API v2 application contract.');
    }
    return `${API_V2}${normalized}`;
}

function toApiV2Path(input: RequestInfo | URL): string {
    if (typeof input !== 'string') {
        throw new Error('API v2 session fetch accepts only same-origin string paths.');
    }
    if (
        !input.startsWith(`${API_V2}/`)
        || input.startsWith('//')
        || input.includes('\\')
        || /^[a-z][a-z\d+.-]*:/i.test(input)
    ) {
        throw new Error('API v2 session fetch accepts only /api/v2 same-origin paths.');
    }
    return input;
}

export function apiPath(path: string, method: ApplicationApiMethod = 'GET'): string {
    return toApiPath(path, method);
}

function getCsrfTokenFromCookie(): string {
    if (typeof document === 'undefined') return '';
    const pair = document.cookie.split('; ').find((entry) => entry.startsWith('csrf_token='));
    if (!pair) return '';
    try {
        return decodeURIComponent(pair.slice(pair.indexOf('=') + 1));
    } catch {
        return '';
    }
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
        redirect: 'error',
        headers,
    };
}

function refreshSession(): Promise<Response> {
    if (refreshPromise) return refreshPromise;

    refreshPromise = safeFetch(
        toApiPath('/auth/refresh', 'POST'),
        withSessionDefaults({ method: 'POST' }),
        true,
    )
        .finally(() => {
            refreshPromise = null;
        });
    return refreshPromise;
}

function loginRedirectPath(): string {
    if (typeof window === 'undefined') return '/auth/login';
    const next = safeSameOriginReturnPath(window.location.pathname, window.location.search);
    return `/auth/login?next=${encodeURIComponent(next)}`;
}

function publicErrorMessage(status: number): string {
    if (status === 401) return 'Your session has expired. Please sign in again.';
    if (status === 403) return 'You do not have permission to perform this action.';
    if (status === 404) return 'The requested resource was not found.';
    if (status === 429) return 'Too many requests. Please wait and try again.';
    if (status >= 500) return 'The service is temporarily unavailable. Please try again.';
    return `Request failed (${status}).`;
}

function isJsonResponse(response: Response): boolean {
    const contentType = response.headers.get('content-type')?.trim() ?? '';
    return SAFE_JSON_CONTENT_TYPE.test(contentType);
}

function jsonResponse(status: number, message: string, retryAfterSeconds?: number): Response {
    return new Response(JSON.stringify({
        message,
        error: message,
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    }), {
        status,
        headers: {
            'Cache-Control': 'no-store',
            'Content-Type': 'application/json',
        },
    });
}

function safeProblemPayload(
    status: number,
    payload: Record<string, unknown> | null,
): Record<string, unknown> | null {
    if (
        !payload
        || payload.status !== status
        || typeof payload.code !== 'string'
        || !/^[a-z0-9_]{1,128}$/.test(payload.code)
        || typeof payload.title !== 'string'
        || !isSafePublicMessage(payload.title)
        || typeof payload.detail !== 'string'
        || !isSafePublicMessage(payload.detail)
        || typeof payload.type !== 'string'
        || !/^https:\/\/lunchlineup\.com\/problems\/[a-z0-9-]{1,160}$/.test(payload.type)
    ) {
        return null;
    }
    const safe: Record<string, unknown> = {
        type: payload.type,
        title: payload.title,
        status,
        detail: payload.detail,
        message: payload.detail,
        code: payload.code,
    };
    if (typeof payload.legacyCode === 'string' && /^[A-Z0-9_]{1,128}$/.test(payload.legacyCode)) {
        safe.legacyCode = payload.legacyCode;
    }
    if (typeof payload.remediation === 'string' && isSafePublicMessage(payload.remediation)) {
        safe.remediation = payload.remediation;
    }
    if (
        typeof payload.retryAfterSeconds === 'number'
        && Number.isInteger(payload.retryAfterSeconds)
        && payload.retryAfterSeconds >= 0
        && payload.retryAfterSeconds <= 86_400
    ) {
        safe.retryAfterSeconds = payload.retryAfterSeconds;
    }
    if (typeof payload.instance === 'string' && /^\/[^\r\n\\]{0,511}$/.test(payload.instance)) {
        safe.instance = payload.instance;
    }
    if (typeof payload.requestId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(payload.requestId)) {
        safe.requestId = payload.requestId;
    }
    if (
        typeof payload.currentEtag === 'string'
        && /^"schedule:[0-9a-f-]{36}:\d+"$/.test(payload.currentEtag)
    ) {
        safe.currentEtag = payload.currentEtag;
    }
    if (Array.isArray(payload.violations)) {
        const violations = payload.violations.slice(0, 100).flatMap((entry) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
            const value = entry as Record<string, unknown>;
            if (
                typeof value.pointer !== 'string'
                || !/^\/[^\r\n\\]{0,511}$/.test(value.pointer)
                || typeof value.code !== 'string'
                || !/^[a-z0-9_]{1,128}$/.test(value.code)
                || typeof value.message !== 'string'
                || !isSafePublicMessage(value.message)
            ) {
                return [];
            }
            return [{
                pointer: value.pointer,
                code: value.code,
                message: value.message,
            }];
        });
        if (violations.length > 0) safe.violations = violations;
    }
    return safe;
}

async function normalizedResponse(
    response: Response,
    preserveProblemDetails = false,
): Promise<Response> {
    if (!isJsonResponse(response)) {
        if (response.ok) return response;
        await response.body?.cancel().catch(() => undefined);
        return jsonResponse(response.status, publicErrorMessage(response.status));
    }
    if (response.status >= 500) {
        await response.body?.cancel().catch(() => undefined);
        return jsonResponse(response.status, publicErrorMessage(response.status));
    }

    let bytes: Uint8Array;
    try {
        bytes = await readBoundedResponseBytes(response, DEFAULT_JSON_RESPONSE_LIMIT_BYTES);
    } catch (error) {
        if (error instanceof ResponseBodyLimitError) {
            return jsonResponse(502, 'The service returned an invalid response.');
        }
        throw error;
    }

    const headers = new Headers(response.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    headers.delete('transfer-encoding');
    headers.set('Cache-Control', 'no-store');
    if (response.ok) {
        return new Response(bytes.byteLength === 0 ? null : new TextDecoder().decode(bytes), {
            status: response.status,
            statusText: response.statusText,
            headers,
        });
    }

    let payload: Record<string, unknown> | null = null;
    try {
        const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            payload = parsed as Record<string, unknown>;
        }
    } catch {
        // Invalid error bodies are replaced with the status-derived public message.
    }
    if (preserveProblemDetails) {
        const problem = safeProblemPayload(response.status, payload);
        if (problem) {
            headers.set('Content-Type', 'application/problem+json');
            return new Response(JSON.stringify(problem), {
                status: response.status,
                statusText: response.statusText,
                headers,
            });
        }
    }
    const candidate = typeof payload?.message === 'string'
        ? payload.message
        : typeof payload?.error === 'string'
            ? payload.error
            : '';
    const message = isSafePublicMessage(candidate) ? candidate : publicErrorMessage(response.status);
    const retryAfterSeconds = typeof payload?.retryAfterSeconds === 'number'
        && Number.isInteger(payload.retryAfterSeconds)
        && payload.retryAfterSeconds >= 0
        && payload.retryAfterSeconds <= 86_400
        ? payload.retryAfterSeconds
        : undefined;
    return jsonResponse(response.status, message, retryAfterSeconds);
}

async function safeFetch(
    input: RequestInfo | URL,
    init: RequestInit,
    preserveProblemDetails = false,
): Promise<Response> {
    try {
        return await withRequestTimeout(
            async (signal) => normalizedResponse(
                await fetch(input, { ...init, signal }),
                preserveProblemDetails,
            ),
            CLIENT_REQUEST_TIMEOUT_MS,
            init.signal,
        );
    } catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') {
            throw new ApiRequestError('The request timed out. Please try again.');
        }
        if (init.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
            throw new ApiRequestError('Request canceled.');
        }
        throw new ApiRequestError('Unable to reach the service. Please try again.');
    }
}

function canReplayAfterRefresh(init: RequestInit): boolean {
    const method = (init.method ?? 'GET').toUpperCase();
    return !UNSAFE_METHODS.has(method) || new Headers(init.headers).has('Idempotency-Key');
}

export async function fetchWithSession(path: string, init: RequestInit = {}): Promise<Response> {
    const requestInit = withSessionDefaults(init);
    const endpoint = toApiPath(path, applicationMethod(requestInit));
    let response = await safeFetch(endpoint, requestInit, true);
    if (response.status !== 401) return response;

    const refresh = await refreshSession();

    if (!refresh.ok) {
        if (typeof window !== 'undefined') {
            window.location.assign(loginRedirectPath());
        }
        return response;
    }

    if (!canReplayAfterRefresh(requestInit)) return response;

    response = await safeFetch(endpoint, withSessionDefaults(init), true);
    if (response.status === 401 && typeof window !== 'undefined') {
        window.location.assign(loginRedirectPath());
    }
    return response;
}

export async function fetchApiV2WithSession(
    input: RequestInfo | URL,
    init: RequestInit = {},
): Promise<Response> {
    const endpoint = toApiV2Path(input);
    const requestInit = withSessionDefaults(init);
    let response = await safeFetch(endpoint, requestInit, true);
    if (response.status !== 401) return response;

    const refresh = await refreshSession();
    if (!refresh.ok) {
        if (typeof window !== 'undefined') {
            window.location.assign(loginRedirectPath());
        }
        return response;
    }
    if (!canReplayAfterRefresh(requestInit)) return response;

    response = await safeFetch(endpoint, withSessionDefaults(init), true);
    if (response.status === 401 && typeof window !== 'undefined') {
        window.location.assign(loginRedirectPath());
    }
    return response;
}

export async function fetchPublicApi(path: string, init: RequestInit = {}): Promise<Response> {
    const requestInit = withSessionDefaults(init);
    return safeFetch(toApiPath(path, applicationMethod(requestInit)), requestInit, true);
}

export async function fetchApiHealth(): Promise<Response> {
    return safeFetch('/api/health', withSessionDefaults());
}

export async function fetchJsonWithSession<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetchWithSession(path, init);
    if (!response.ok) {
        let message = publicErrorMessage(response.status);
        if (isJsonResponse(response)) {
            const payload = await response.json().catch(() => null) as { message?: unknown } | null;
            if (typeof payload?.message === 'string' && isSafePublicMessage(payload.message)) {
                message = payload.message;
            }
        }
        throw new ApiRequestError(message, response.status);
    }
    try {
        return await response.json() as T;
    } catch {
        throw new ApiRequestError('The service returned an invalid response.', response.status);
    }
}

function isSafePublicMessage(message: string): boolean {
    if (!message || message.length > 240 || /[\r\n\0<>]/.test(message)) return false;
    return !/(?:https?:\/\/|file:\/\/|\\\\|\b(?:bearer|authorization|cookie|set-cookie|stack|sqlstate)\b|(?:token|password|secret|key)\s*[:=]|localhost|127\.0\.0\.1|\.internal\b|\b(?:10|192\.168)\.\d{1,3}\.\d{1,3}|\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})/i.test(message);
}
