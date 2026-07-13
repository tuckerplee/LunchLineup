import {
    CallHandler,
    ExecutionContext,
    Injectable,
    NestInterceptor,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { throwError } from 'rxjs';
import { catchError, finalize } from 'rxjs/operators';
import { MetricsService } from './metrics.service';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
    constructor(private readonly metricsService: MetricsService) { }

    intercept(context: ExecutionContext, next: CallHandler): any {
        if (context.getType() !== 'http') {
            return next.handle();
        }

        const http = context.switchToHttp();
        const req = http.getRequest<Request>();
        const res = http.getResponse<Response>();
        const start = process.hrtime.bigint();
        let recorded = false;

        const record = (status: number) => {
            if (recorded) return;
            recorded = true;
            const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
            this.metricsService.recordHttpRequest(
                (req.method || 'UNKNOWN').toUpperCase(),
                this.routeLabel(req),
                status,
                durationMs,
            );
        };

        return (next.handle() as any).pipe(
            catchError((error) => {
                record(this.errorStatus(error, res.statusCode));
                return throwError(() => error);
            }),
            finalize(() => record(res.statusCode || 200)),
        );
    }

    private errorStatus(error: unknown, fallback: number): number {
        if (error && typeof error === 'object' && 'getStatus' in error && typeof error.getStatus === 'function') {
            return error.getStatus();
        }
        return fallback >= 400 ? fallback : 500;
    }

    private routeLabel(req: Request): string {
        const routePath = this.routePath(req);
        const baseUrl = typeof req.baseUrl === 'string' ? req.baseUrl : '';
        const raw = routePath ? `${baseUrl}${routePath}` : req.path || req.url || 'unknown';
        const path = raw.split('?')[0] || 'unknown';
        return this.normalizePath(path);
    }

    private routePath(req: Request): string | null {
        const routePath = req.route?.path;
        if (typeof routePath === 'string') return routePath;
        return null;
    }

    private normalizePath(path: string): string {
        const clean = path.startsWith('/') ? path : `/${path}`;
        return clean
            .split('/')
            .map((segment) => {
                if (!segment) return segment;
                if (segment.startsWith(':')) return segment;
                if (/^\d+$/.test(segment)) return ':id';
                if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(segment)) return ':id';
                if (/^[0-9a-f]{16,}$/i.test(segment)) return ':id';
                return segment;
            })
            .join('/');
    }
}
