import { PlatformConfig } from './schema';
/**
 * Build CSP directives from arrays of sources.
 * Architecture Part I-A, §1A.7
 */
export declare function buildCSP(directives: Record<string, string[]>): string;
/**
 * Compose all security headers from configuration values.
 * Headers are NEVER hardcoded strings — they are built from config.
 * Architecture Part I-A, §1A.7
 */
export declare function buildSecurityHeaders(config: PlatformConfig): {
    'Strict-Transport-Security': string;
    'Content-Security-Policy': string;
    'X-Frame-Options': string;
    'X-Content-Type-Options': string;
    'Referrer-Policy': string;
    'X-Permitted-Cross-Domain-Policies': string;
    'X-XSS-Protection': string;
    'Permissions-Policy': string;
    'Cross-Origin-Opener-Policy': string;
    'Cross-Origin-Embedder-Policy': string;
    'Cross-Origin-Resource-Policy': string;
};
//# sourceMappingURL=security-headers.d.ts.map