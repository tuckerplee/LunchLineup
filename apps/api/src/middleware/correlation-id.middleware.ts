import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { redactUrlForLog } from '../common/sensitive-redaction';

const SAFE_CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MAX_LOG_PATH_LENGTH = 512;

function safeCorrelationId(value: string | string[] | undefined): string | null {
    return typeof value === 'string' && SAFE_CORRELATION_ID.test(value) ? value : null;
}

function safeLogPath(value: string): string {
    return (redactUrlForLog(value).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, MAX_LOG_PATH_LENGTH) || '/');
}

/**
 * Correlation ID Middleware - Architecture Part X
 *
 * Attaches a unique trace/correlation ID to every incoming HTTP request.
 * The ID is:
 *  - Taken from the incoming X-Correlation-ID or X-Request-ID header if present (forward proxy/gateway set it)
 *  - Otherwise generated as a new UUIDv4
 *
 * The ID is:
 *  - Attached to req.correlationId for downstream use in services
 *  - Echoed back in the X-Correlation-ID response header
 *  - Logged at the start (incoming) and end (outgoing) of every request
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
    private readonly logger = new Logger('HTTP');

    use(req: Request, res: Response, next: NextFunction): void {
        const correlationId =
            safeCorrelationId(req.headers['x-correlation-id']) ||
            safeCorrelationId(req.headers['x-request-id']) ||
            randomUUID();

        (req as any).correlationId = correlationId;
        res.setHeader('X-Correlation-ID', correlationId);

        const { method, originalUrl } = req;
        const safeUrl = safeLogPath(originalUrl ?? req.url ?? '');
        const startMs = Date.now();

        this.logger.log(`-> [${correlationId}] ${method} ${safeUrl}`);

        res.on('finish', () => {
            const { statusCode } = res;
            const durationMs = Date.now() - startMs;
            const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'log';

            this.logger[level](`<- [${correlationId}] ${method} ${safeUrl} ${statusCode} - ${durationMs}ms`);
        });

        next();
    }
}
