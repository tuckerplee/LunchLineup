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
        this.allowedHosts = [
            domain,
            `www.${domain}`,
            'localhost',
            'localhost:3000',
            '127.0.0.1:3000',
        ];
    }

    use = (req: Request, res: Response, next: NextFunction) => {
        const host = req.headers.host;

        if (!host || !this.allowedHosts.includes(host)) {
            throw new HttpException('Misdirected Request', HttpStatus.MISDIRECTED);
        }

        next();
    }
}
