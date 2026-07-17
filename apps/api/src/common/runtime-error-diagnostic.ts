export type RuntimeErrorCategory =
    | 'authentication'
    | 'connectivity'
    | 'provider_rejected'
    | 'rate_limit'
    | 'timeout'
    | 'unavailable'
    | 'unknown';

export type RuntimeErrorDiagnostic = {
    category: RuntimeErrorCategory;
    errorClass: string;
    code?: string;
    httpStatus?: number;
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

const CODE_CATEGORIES: Readonly<Record<string, RuntimeErrorCategory>> = {
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
    if (!error || typeof error !== 'object') return undefined;
    try {
        const code = 'code' in error && typeof error.code === 'string' ? error.code.toUpperCase() : '';
        return Object.prototype.hasOwnProperty.call(CODE_CATEGORIES, code) ? code : undefined;
    } catch {
        return undefined;
    }
}

function safeErrorClass(error: unknown): string {
    if (!(error instanceof Error)) return 'NonErrorThrow';
    try {
        const constructorName = error.constructor?.name;
        return typeof constructorName === 'string' && SAFE_ERROR_CLASSES.has(constructorName)
            ? constructorName
            : 'Error';
    } catch {
        return 'Error';
    }
}

function safeHttpStatus(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') return undefined;
    try {
        const status = 'status' in error ? error.status : undefined;
        return Number.isInteger(status) && Number(status) >= 400 && Number(status) <= 599
            ? Number(status)
            : undefined;
    } catch {
        return undefined;
    }
}

export function runtimeErrorDiagnostic(error: unknown): RuntimeErrorDiagnostic {
    const code = safeErrorCode(error);
    const errorClass = safeErrorClass(error);
    const httpStatus = safeHttpStatus(error);
    const category = code
        ? CODE_CATEGORIES[code]
        : httpStatus === 429
            ? 'rate_limit'
            : httpStatus !== undefined && httpStatus >= 500
                ? 'unavailable'
                : httpStatus !== undefined
                    ? 'provider_rejected'
                    : errorClass === 'AbortError' || errorClass === 'TimeoutError' || errorClass === 'MaxRetriesPerRequestError'
                        ? 'timeout'
                        : 'unknown';

    return {
        category,
        errorClass,
        ...(code ? { code } : {}),
        ...(httpStatus ? { httpStatus } : {}),
    };
}

export function runtimeErrorText(error: unknown): string {
    const diagnostic = runtimeErrorDiagnostic(error);
    return [
        `category=${diagnostic.category}`,
        `class=${diagnostic.errorClass}`,
        ...(diagnostic.code ? [`code=${diagnostic.code}`] : []),
        ...(diagnostic.httpStatus ? [`http_status=${diagnostic.httpStatus}`] : []),
    ].join(' ');
}

export function safeCorrelationId(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim();
    return /^[A-Za-z0-9._:-]{1,128}$/.test(normalized) ? normalized : undefined;
}
