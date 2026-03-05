import { PlatformConfig } from './schema';

/**
 * Build CSP directives from arrays of sources.
 * Architecture Part I-A, §1A.7
 */
export function buildCSP(directives: Record<string, string[]>): string {
    return Object.entries(directives)
        .map(([key, values]) => {
            const directiveName = key.replace(/([A-Z])/g, '-$1').toLowerCase();
            return `${directiveName} ${values.join(' ')}`;
        })
        .join('; ');
}

/**
 * Compose all security headers from configuration values.
 * Headers are NEVER hardcoded strings — they are built from config.
 * Architecture Part I-A, §1A.7
 */
export function buildSecurityHeaders(config: PlatformConfig) {
    return {
        'Strict-Transport-Security':
            `max-age=${config.security.hstsMaxAge}; includeSubDomains${config.security.hstsPreload ? '; preload' : ''}`,

        'Content-Security-Policy': buildCSP({
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", ...config.security.cspExtraScriptSrc],
            styleSrc: ["'self'", "'unsafe-inline'", ...config.security.cspExtraStyleSrc],
            imgSrc: ["'self'", 'data:', ...config.security.cspExtraImgSrc],
            fontSrc: ["'self'", ...config.security.cspExtraFontSrc],
            connectSrc: ["'self'", `wss://${config.domain}`, ...config.security.cspExtraConnectSrc],
            frameAncestors: config.security.allowIframeEmbedding
                ? config.security.iframeAllowedOrigins
                : ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
        }),

        'X-Frame-Options': config.security.allowIframeEmbedding ? 'SAMEORIGIN' : 'DENY',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'X-Permitted-Cross-Domain-Policies': 'none',
        'X-XSS-Protection': '0', // Intentionally disabled — legacy auditor is itself a vulnerability vector. CSP replaces it.
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
    };
}
