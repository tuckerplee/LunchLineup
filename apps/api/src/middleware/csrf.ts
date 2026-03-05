import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

/**
 * Double-Submit CSRF Protection Middleware
 * As per Architecture Part VII-A.2
 */
export function csrfProtection(req: Request, res: Response, next: NextFunction) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return next();
    }

    const csrfCookie = req.cookies['XSRF-TOKEN'];
    const csrfHeader = req.headers['x-csrf-token'];

    if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
        return res.status(403).json({ error: 'CSRF validation failed' });
    }

    next();
}

/**
 * Generate a new CSRF token and set it in a cookie
 */
export function setCsrfToken(req: Request, res: Response) {
    const token = crypto.randomBytes(32).toString('hex');
    res.cookie('XSRF-TOKEN', token, {
        httpOnly: false, // Must be readable by client JS to send back as header
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/'
    });
    return token;
}
