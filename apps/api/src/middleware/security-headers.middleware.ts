import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

/**
 * Security Headers Middleware.
 * Dynamically builds Content-Security-Policy and sets other security headers.
 * Architecture Part VII-A.2
 */
@Injectable()
export class SecurityHeadersMiddleware implements NestMiddleware {
    use = (req: Request, res: Response, next: NextFunction) => {
        // Content Security Policy
        const csp = [
            "default-src 'self'",
            "base-uri 'self'",
            "font-src 'self' https: data:",
            "form-action 'self'",
            "frame-ancestors 'none'",
            "img-src 'self' data:",
            "object-src 'none'",
            "script-src 'self'",
            "script-src-attr 'none'",
            "style-src 'self' 'unsafe-inline'",
            "upgrade-insecure-requests"
        ].join('; ');

        res.setHeader('Content-Security-Policy', csp);
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        res.setHeader('Origin-Agent-Cluster', '?1');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-DNS-Prefetch-Control', 'off');
        res.setHeader('X-Download-Options', 'noopen');
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
        res.setHeader('X-XSS-Protection', '0');

        next();
    }
}
