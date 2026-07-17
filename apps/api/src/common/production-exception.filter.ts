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
import { redactUrlForLog } from './sensitive-redaction';

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
    [HttpStatus.TOO_MANY_REQUESTS]: 'Too Many Requests',
    [HttpStatus.INTERNAL_SERVER_ERROR]: 'Internal Server Error',
};

const PUBLIC_ERROR_DETAILS = {
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

        if (status >= 500) {
            this.logger.error(
                `Unhandled request failure method=${requestMethod} ${runtimeErrorText(exception)}`,
            );
        }

        res.status(status).json({
            statusCode: status,
            error: statusLabel(status),
            message: publicError?.message ?? SAFE_MESSAGES[status] ?? 'Request failed',
            ...(publicError ? { code: publicError.code, remediation: publicError.remediation } : {}),
            path: requestPath,
            correlationId: safeCorrelationId(req.correlationId),
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
