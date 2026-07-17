export type OperationalErrorCategory =
    | 'authentication'
    | 'connectivity'
    | 'rate_limit'
    | 'timeout'
    | 'unavailable'
    | 'unknown';

export type OperationalErrorDiagnostics = {
    event: string;
    errorClass: string;
    category: OperationalErrorCategory;
    code?: string;
    correlationId?: string;
};

const SAFE_ERROR_CLASSES = new Set([
    'AbortError',
    'Error',
    'MaxRetriesPerRequestError',
    'RangeError',
    'ReferenceError',
    'ReplyError',
    'SyntaxError',
    'TimeoutError',
    'TypeError',
]);

const CODE_CATEGORIES: Readonly<Record<string, OperationalErrorCategory>> = {
    ABORT_ERR: 'timeout',
    BUSY: 'rate_limit',
    EAI_AGAIN: 'connectivity',
    ECONNREFUSED: 'connectivity',
    ECONNRESET: 'connectivity',
    ENETDOWN: 'connectivity',
    ENETUNREACH: 'connectivity',
    ENOTFOUND: 'connectivity',
    EPIPE: 'connectivity',
    ESOCKETTIMEDOUT: 'timeout',
    ETIMEDOUT: 'timeout',
    LOADING: 'unavailable',
    NOAUTH: 'authentication',
    NOPERM: 'authentication',
    TRYAGAIN: 'unavailable',
    WRONGPASS: 'authentication',
};

function safeErrorCode(error: unknown): string | undefined {
    if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
    const code = typeof error.code === 'string' ? error.code.toUpperCase() : '';
    return Object.prototype.hasOwnProperty.call(CODE_CATEGORIES, code) ? code : undefined;
}

function safeErrorClass(error: unknown): string {
    if (!(error instanceof Error)) return 'NonErrorThrow';
    const constructorName = error.constructor?.name;
    return typeof constructorName === 'string' && SAFE_ERROR_CLASSES.has(constructorName)
        ? constructorName
        : 'Error';
}

function safeCorrelationId(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim();
    return /^[A-Za-z0-9._:-]{1,128}$/.test(normalized) ? normalized : undefined;
}

export function operationalErrorDiagnostics(
    event: string,
    error: unknown,
    correlationId?: unknown,
): OperationalErrorDiagnostics {
    const code = safeErrorCode(error);
    const errorClass = safeErrorClass(error);
    const category = code
        ? CODE_CATEGORIES[code]
        : errorClass === 'AbortError' || errorClass === 'TimeoutError' || errorClass === 'MaxRetriesPerRequestError'
            ? 'timeout'
            : 'unknown';
    const safeEvent = /^[a-z0-9_.-]{1,80}$/.test(event) ? event : 'operational_error';
    const safeCorrelation = safeCorrelationId(correlationId);
    return {
        event: safeEvent,
        errorClass,
        category,
        ...(code ? { code } : {}),
        ...(safeCorrelation ? { correlationId: safeCorrelation } : {}),
    };
}

export function operationalErrorLog(event: string, error: unknown, correlationId?: unknown): string {
    return JSON.stringify(operationalErrorDiagnostics(event, error, correlationId));
}