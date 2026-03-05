import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

/**
 * Correlation ID Middleware — Architecture Part X
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
        // Accept an upstream-provided ID or generate a fresh one
        const correlationId =
            (req.headers['x-correlation-id'] as string) ||
            (req.headers['x-request-id'] as string) ||
            randomUUID();

        // Attach to request object for services to read
        (req as any).correlationId = correlationId;

        // Echo back in the response
        res.setHeader('X-Correlation-ID', correlationId);

        const { method, originalUrl, ip } = req;
        const startMs = Date.now();

        this.logger.log(
            `→ [${correlationId}] ${method} ${originalUrl} from ${ip}`
        );

        res.on('finish', () => {
            const { statusCode } = res;
            const durationMs = Date.now() - startMs;
            const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'log';

            this.logger[level](
                `← [${correlationId}] ${method} ${originalUrl} ${statusCode} — ${durationMs}ms`
            );
        });

        next();
    }
}
