const isProduction = process.env.NODE_ENV === 'production';
const turnstileOrigin = 'https://challenges.cloudflare.com';
const cloudflareAnalyticsScriptOrigin = 'https://static.cloudflareinsights.com';
const cloudflareAnalyticsConnectOrigin = 'https://cloudflareinsights.com';

function serverHttpUrl(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('INTERNAL_API_URL must be an HTTP(S) URL without credentials, query, or fragment');
    }
    return url.toString().replace(/\/$/, '');
}

function browserOrigin(value) {
    if (!value || value.startsWith('/')) return null;
    try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
            throw new Error('unsupported browser origin');
        }
        return url.origin;
    } catch {
        throw new Error('Public browser URLs must be relative or use HTTP(S)');
    }
}

function requireBrowserProtocol(origin, label, allowedProtocols) {
    if (!origin) return null;
    if (!allowedProtocols.includes(new URL(origin).protocol)) {
        throw new Error(`${label} must be relative or use ${allowedProtocols.join(' or ')}`);
    }
    return origin;
}

const internalApiUrl = serverHttpUrl(process.env.INTERNAL_API_URL || 'http://api:3000/v1');
const internalApiV2Url = serverHttpUrl(process.env.INTERNAL_API_V2_URL || 'http://api-v2:3002/v2');
const configuredConnectOrigins = [
    requireBrowserProtocol(
        browserOrigin(process.env.NEXT_PUBLIC_API_URL),
        'NEXT_PUBLIC_API_URL',
        isProduction ? ['https:'] : ['http:', 'https:'],
    ),
].filter(Boolean);
const developmentConnectOrigins = isProduction
    ? []
    : ['http://localhost:*', 'http://127.0.0.1:*'];
const connectSources = [
    "'self'",
    turnstileOrigin,
    cloudflareAnalyticsConnectOrigin,
    ...configuredConnectOrigins,
    ...developmentConnectOrigins,
];
const contentSecurityPolicy = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    `frame-src 'self' ${turnstileOrigin}`,
    "form-action 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    `script-src 'self' ${turnstileOrigin} ${cloudflareAnalyticsScriptOrigin} 'unsafe-inline'${isProduction ? '' : " 'unsafe-eval'"}`,
    "script-src-attr 'none'",
    `connect-src ${[...new Set(connectSources)].join(' ')}`,
    ...(isProduction ? ['upgrade-insecure-requests'] : []),
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
    reactStrictMode: true,
    devIndicators: false,
    poweredByHeader: false,
    productionBrowserSourceMaps: false,
    images: {
        dangerouslyAllowSVG: false,
        remotePatterns: [],
    },

    // Security Headers (Architecture Part VII-A.1)
    async headers() {
        return [
            {
                source: '/(.*)',
                headers: [
                    {
                        key: 'Content-Security-Policy',
                        value: contentSecurityPolicy,
                    },
                    {
                        key: 'X-Frame-Options',
                        value: 'DENY',
                    },
                    {
                        key: 'X-Content-Type-Options',
                        value: 'nosniff',
                    },
                    {
                        key: 'Referrer-Policy',
                        value: 'strict-origin-when-cross-origin',
                    },
                    {
                        key: 'Permissions-Policy',
                        value: 'camera=(), microphone=(), geolocation=()',
                    },
                    {
                        key: 'Cross-Origin-Opener-Policy',
                        value: 'same-origin',
                    },
                    {
                        key: 'Cross-Origin-Resource-Policy',
                        value: 'same-origin',
                    },
                    ...(isProduction
                        ? [{
                            key: 'Strict-Transport-Security',
                            value: 'max-age=31536000; includeSubDomains; preload',
                        }]
                        : []),
                ],
            },
            {
                source: '/auth/reset-password',
                headers: [
                    {
                        key: 'Cache-Control',
                        value: 'no-store',
                    },
                    {
                        key: 'Referrer-Policy',
                        value: 'no-referrer',
                    },
                ],
            },
        ];
    },

    // Proxy API requests from the Next.js server to the Docker API service.
    async rewrites() {
        return [
            {
                source: '/api/v2/:path*',
                destination: `${internalApiV2Url}/:path*`,
            },
            {
                source: '/api/v1/:path*',
                destination: `${internalApiUrl}/:path*`,
            },
        ];
    },
};

module.exports = nextConfig;
