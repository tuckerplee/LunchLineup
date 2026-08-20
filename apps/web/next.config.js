const isProduction = process.env.NODE_ENV === 'production';

function serverHttpUrl(value, label) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error(`${label} must be an HTTP(S) URL without credentials, query, or fragment`);
    }
    return url.toString().replace(/\/$/, '');
}

function validatePublicBrowserUrl(value) {
    if (!value || value.startsWith('/')) return;
    try {
        const url = new URL(value);
        const allowedProtocols = isProduction ? ['https:'] : ['http:', 'https:'];
        if (!allowedProtocols.includes(url.protocol) || url.username || url.password) {
            throw new Error('unsupported public browser URL');
        }
    } catch {
        throw new Error('NEXT_PUBLIC_API_URL must be relative or use an approved HTTP(S) origin');
    }
}

const internalApiV2Url = serverHttpUrl(
    process.env.INTERNAL_API_V2_URL || 'http://api-v2:3002/v2',
    'INTERNAL_API_V2_URL',
);
validatePublicBrowserUrl(process.env.NEXT_PUBLIC_API_URL);
// Legacy rewrites exist only in the explicit local E2E fixture. Production
// never reads this value, so a public v1 route cannot be re-enabled by env.
const localE2eLegacyApiUrl = !isProduction && process.env.LUNCHLINEUP_E2E_LEGACY_API_URL
    ? serverHttpUrl(process.env.LUNCHLINEUP_E2E_LEGACY_API_URL, 'LUNCHLINEUP_E2E_LEGACY_API_URL')
    : null;
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

    // API v2 owns browser traffic. v1 is reachable only inside an explicitly
    // configured local E2E fixture; no production server rewrite exists.
    async rewrites() {
        return [
            {
                source: '/api/v2/:path*',
                destination: `${internalApiV2Url}/:path*`,
            },
            ...(localE2eLegacyApiUrl ? [{
                source: '/api/v1/:path*',
                destination: `${localE2eLegacyApiUrl}/:path*`,
            }] : []),
        ];
    },
};

module.exports = nextConfig;
