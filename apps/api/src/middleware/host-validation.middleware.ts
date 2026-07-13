import { Injectable, NestMiddleware, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { isProduction, normalizeAllowedHost, readCsv } from '../common/bootstrap-security';

/**
 * Host Header Validation Middleware.
 * Rejects requests with unrecognized Host headers (DNS rebinding defense).
 * Architecture Part VII-A.1
 */
@Injectable()
export class HostValidationMiddleware implements NestMiddleware {
    private readonly allowedHosts: Set<string>;

    constructor(env: NodeJS.ProcessEnv = process.env) {
        const domain = safeNormalizeHost(env.DOMAIN || 'localhost');
        const apiHostPort = env.API_HOST_PORT?.trim() || '4000';
        const servicePort = env.PORT?.trim() || '3000';
        const configuredHosts = readCsv(env.ALLOWED_HOSTS)
            .map(safeNormalizeHost)
            .filter((host): host is string => Boolean(host));
        const internalServiceHosts = readCsv(env.API_INTERNAL_HOSTS)
            .map(safeNormalizeHost)
            .filter((host): host is string => Boolean(host));
        const loopbackHealthHosts = [
            `127.0.0.1:${servicePort}`,
            `[::1]:${servicePort}`,
        ];
        const developmentHosts = [
            domain,
            domain && `www.${domain}`,
            'localhost',
            'localhost:3000',
            `localhost:${apiHostPort}`,
            '127.0.0.1',
            '127.0.0.1:3000',
            `127.0.0.1:${apiHostPort}`,
            '[::1]',
            '[::1]:3000',
            `[::1]:${apiHostPort}`,
            // Allow Docker-internal service-to-service calls in non-production stacks.
            'api',
            'api:3000',
            'web',
            'web:3000',
            'proxy',
            'proxy:80',
        ];

        const baseHosts = isProduction(env)
            ? [domain, ...loopbackHealthHosts, ...configuredHosts, ...internalServiceHosts]
            : [...developmentHosts, ...configuredHosts];

        this.allowedHosts = new Set(baseHosts.filter((host): host is string => Boolean(host)));
    }

    use = (req: Request, res: Response, next: NextFunction) => {
        const host = safeNormalizeHost(req.headers.host);

        if (!host || !this.allowedHosts.has(host)) {
            throw new HttpException('Misdirected Request', HttpStatus.MISDIRECTED);
        }

        next();
    }
}

function safeNormalizeHost(value: string | undefined): string | null {
    if (!value) return null;

    try {
        return normalizeAllowedHost(value);
    } catch {
        return null;
    }
}
