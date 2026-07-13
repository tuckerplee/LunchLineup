import {
    ArgumentsHost,
    Catch,
    ExceptionFilter,
    HttpException,
    HttpStatus,
    Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
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
    [HttpStatus.TOO_MANY_REQUESTS]: 'Too Many Requests',
    [HttpStatus.INTERNAL_SERVER_ERROR]: 'Internal Server Error',
};

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
        const requestPath = redactUrlForLog(req.originalUrl ?? req.url ?? '');

        if (status >= 500) {
            this.logger.error(
                `Unhandled request failure ${req.method} ${requestPath}`,
                exception instanceof Error ? redactSensitiveText(exception.stack ?? exception.message) : undefined,
            );
        }

        res.status(status).json({
            statusCode: status,
            error: statusLabel(status),
            message: SAFE_MESSAGES[status] ?? 'Request failed',
            path: requestPath,
            correlationId: req.correlationId,
            timestamp: new Date().toISOString(),
        });
    }
}

function statusLabel(status: number): string {
    return STATUS_LABELS[status] ?? 'Error';
}
