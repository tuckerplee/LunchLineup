import { Injectable, NestMiddleware, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

/**
 * Host Header Validation Middleware.
 * Rejects requests with unrecognized Host headers (DNS rebinding defense).
 * Architecture Part VII-A.1
 */
@Injectable()
export class HostValidationMiddleware implements NestMiddleware {
    private readonly allowedHosts: string[];

    constructor() {
        const domain = process.env.DOMAIN || 'localhost';
        const configuredHosts = (process.env.ALLOWED_HOSTS || '')
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean);

        this.allowedHosts = Array.from(new Set([
            domain,
            `www.${domain}`,
            'localhost',
            'localhost:3000',
            '127.0.0.1',
            '127.0.0.1:3000',
            // Allow Docker-internal service-to-service calls.
            'api',
            'api:3000',
            'web',
            'web:3000',
            'proxy',
            'proxy:80',
            ...configuredHosts,
        ])).map((v) => v.toLowerCase());
    }

    use = (req: Request, res: Response, next: NextFunction) => {
        const host = req.headers.host?.toLowerCase();

        if (!host || !this.allowedHosts.includes(host)) {
            throw new HttpException('Misdirected Request', HttpStatus.MISDIRECTED);
        }

        next();
    }
}
