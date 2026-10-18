import {
    ArgumentsHost,
    Catch,
    ExceptionFilter,
    HttpException,
    HttpStatus,
    Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { runtimeErrorText, safeCorrelationId } from './runtime-error-diagnostic';
import { redactSensitiveText, redactUrlForLog } from './sensitive-redaction';

const SAFE_MESSAGES: Record<number, string> = {
    [HttpStatus.BAD_REQUEST]: 'Bad request',
    [HttpStatus.UNAUTHORIZED]: 'Authentication required',
    [HttpStatus.FORBIDDEN]: 'Forbidden',
    [HttpStatus.NOT_FOUND]: 'Not found',
    [HttpStatus.CONFLICT]: 'Conflict',
    [HttpStatus.PAYLOAD_TOO_LARGE]: 'Payload too large',
    [HttpStatus.TOO_MANY_REQUESTS]: 'Too many requests',
    [HttpStatus.INTERNAL_SERVER_ERROR]: 'Internal server error',
};

const STATUS_LABELS: Record<number, string> = {
    [HttpStatus.BAD_REQUEST]: 'Bad Request',
    [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
    [HttpStatus.FORBIDDEN]: 'Forbidden',
    [HttpStatus.NOT_FOUND]: 'Not Found',
    [HttpStatus.CONFLICT]: 'Conflict',
    [HttpStatus.PAYLOAD_TOO_LARGE]: 'Payload Too Large',
    [HttpStatus.SERVICE_UNAVAILABLE]: 'Service Unavailable',
    [HttpStatus.TOO_MANY_REQUESTS]: 'Too Many Requests',
    [HttpStatus.INTERNAL_SERVER_ERROR]: 'Internal Server Error',
};

const PUBLIC_ERROR_DETAILS = {
    billing_disabled: {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        message: 'Billing is disabled for this environment.',
        remediation: 'No action is needed; this environment is not billed.',
    },
    CREDIT_WALLET_CAPACITY_EXCEEDED: {
        status: HttpStatus.BAD_REQUEST,
        message: 'Credit amount exceeds the available wallet capacity. Refresh balances and enter a smaller amount.',
        remediation: 'Refresh balances and enter a smaller amount. Outstanding debt is repaid before adding spendable credits.',
    },
    SETUP_SHIFTS_ENTITLEMENT_REQUIRED: {
        status: HttpStatus.FORBIDDEN,
        message: 'Setup shifts require an active paid subscription and enough usage credits.',
        remediation: 'Activate a paid subscription or add usage credits, then retry the unchanged setup.',
    },
    SETUP_SHIFTS_CONFLICT: {
        status: HttpStatus.CONFLICT,
        message: 'Setup shifts conflict with current schedule data.',
        remediation: 'Refresh the selected date, resolve schedule, overlap, or dependent-break conflicts, then retry.',
    },
    SHIFT_BREAKS_ENTITLEMENT_REQUIRED: {
        status: HttpStatus.FORBIDDEN,
        message: 'Manual lunch/break changes require an active paid subscription and enough usage credits.',
        remediation: 'Activate a paid subscription or add usage credits, then retry the unchanged break edit.',
    },
    SHIFT_BREAKS_CONFLICT: {
        status: HttpStatus.CONFLICT,
        message: 'Shift lunch/breaks conflict with current schedule data.',
        remediation: 'Refresh the selected date, review the shift and breaks, then retry.',
    },
} as const;

type PublicErrorCode = keyof typeof PUBLIC_ERROR_DETAILS;

@Catch()
export class ProductionExceptionFilter implements ExceptionFilter {
    private readonly logger = new Logger(ProductionExceptionFilter.name);

    catch(exception: unknown, host: ArgumentsHost): void {
        const ctx = host.switchToHttp();
        const req = ctx.getRequest<Request & { correlationId?: string }>();
        const res = ctx.getResponse<Response>();
        const status = exception instanceof HttpException
            ? exception.getStatus()
            : HttpStatus.INTERNAL_SERVER_ERROR;
        const publicError = publicErrorDetail(exception, status);
        const requestPath = redactUrlForLog(req.originalUrl ?? req.url ?? '');
        const requestMethod = /^[A-Z]{1,16}$/.test(req.method) ? req.method : 'UNKNOWN';
        const correlationId = safeCorrelationId(req.correlationId);
        const reason = publicError ? null : clientSafeReason(exception, status);

        if (status >= 500 && !publicError) {
            this.logger.error(
                `Unhandled request failure method=${requestMethod} ${runtimeErrorText(exception)}`,
            );
        }

        if (status >= 400 && status < 500) {
            const logged = publicError?.message ?? reason?.message ?? SAFE_MESSAGES[status] ?? 'Request failed';
            const fields = reason?.fields?.length ? ` fields=${reason.fields.join(',')}` : '';
            this.logger.warn(
                `request_rejected method=${requestMethod} path=${requestPath} status=${status} correlationId=${correlationId} reason=${JSON.stringify(logged)}${fields}`,
            );
        }

        res.status(status).json({
            statusCode: status,
            error: statusLabel(status),
            message: publicError?.message ?? reason?.message ?? SAFE_MESSAGES[status] ?? 'Request failed',
            ...(reason?.fields?.length ? { fields: reason.fields } : {}),
            ...(publicError ? { code: publicError.code, remediation: publicError.remediation } : {}),
            path: requestPath,
            correlationId,
            timestamp: new Date().toISOString(),
        });
    }
}

function statusLabel(status: number): string {
    return STATUS_LABELS[status] ?? 'Error';
}

function publicErrorDetail(exception: unknown, status: number) {
    if (!(exception instanceof HttpException)) return null;
    const response = exception.getResponse();
    if (!response || typeof response !== 'object' || Array.isArray(response)) return null;
    const code = (response as Record<string, unknown>).code;
    if (typeof code !== 'string' || !(code in PUBLIC_ERROR_DETAILS)) return null;
    const detail = PUBLIC_ERROR_DETAILS[code as PublicErrorCode];
    if (detail.status !== status) return null;
    return { code: code as PublicErrorCode, ...detail };
}

const REASON_PASSTHROUGH_STATUSES: ReadonlySet<number> = new Set([
    HttpStatus.BAD_REQUEST,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
]);
const MAX_REASON_LENGTH = 300;
const MAX_REASON_FIELDS = 20;
const VALIDATION_FAILED_MESSAGE = 'Request validation failed';

/**
 * Normalizes a developer-authored message: strips control characters, collapses
 * whitespace, trims and caps the length. Returns null when nothing is left.
 */
export function normalizeReasonText(value: string): string | null {
    const cleaned = redactSensitiveText(value)
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!cleaned) return null;
    return cleaned.length > MAX_REASON_LENGTH
        ? `${cleaned.slice(0, MAX_REASON_LENGTH - 1).trimEnd()}\u2026`
        : cleaned;
}

/**
 * Only HttpExceptions with status 400/409/422 carry a developer-authored string
 * (`new BadRequestException('...')` or `{ message: '...' }`). class-validator
 * array messages are never echoed; only the offending field names are.
 * Non-HttpExceptions (Prisma, DB, third-party) and every other status keep the
 * generic message.
 */
function clientSafeReason(exception: unknown, status: number): { message: string; fields?: string[] } | null {
    if (!(exception instanceof HttpException) || !REASON_PASSTHROUGH_STATUSES.has(status)) return null;
    const response = exception.getResponse();
    const raw = typeof response === 'string'
        ? response
        : response && typeof response === 'object' && !Array.isArray(response)
            ? (response as Record<string, unknown>).message
            : undefined;
    if (typeof raw === 'string') {
        const message = normalizeReasonText(raw);
        return message ? { message } : null;
    }
    if (Array.isArray(raw)) {
        const fields = validationFieldNames(raw);
        return { message: VALIDATION_FAILED_MESSAGE, ...(fields.length ? { fields } : {}) };
    }
    return null;
}

function validationFieldNames(messages: unknown[]): string[] {
    const names = new Set<string>();
    for (const entry of messages) {
        if (typeof entry !== 'string') continue;
        // class-validator messages start with the property path ("email must be an email",
        // "items.0.name should not be empty"); keep only a plain identifier-like path.
        const text = entry.replace(/^each value in\s+/i, '');
        const match = /^([A-Za-z_][A-Za-z0-9_]*(?:(?:\.|\[)[A-Za-z0-9_\]]+)*)\s/.exec(text);
        if (match && match[1].length <= 80) names.add(match[1]);
        if (names.size >= MAX_REASON_FIELDS) break;
    }
    return [...names];
}
