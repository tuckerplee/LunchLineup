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
// Ordinary production ignores the legacy env value. The authenticated fixed
// mock lane below uses its immutable loopback value instead.
const localE2eLegacyApiUrl = !isProduction && process.env.LUNCHLINEUP_E2E_LEGACY_API_URL
    ? serverHttpUrl(process.env.LUNCHLINEUP_E2E_LEGACY_API_URL, 'LUNCHLINEUP_E2E_LEGACY_API_URL')
    : null;

// Preserve the synchronous config object used by existing consumers. The fixed
// lane pins Node 22.23.2, whose require(esm) supports this synchronous module graph.
// QA/env flags select inspection only; protected source/physical admission grants
// the alias before either compiler reads this config. Failures remain fatal.
const mock = process.env.LUNCHLINEUP_DEVELOPMENT_QA === '1'
    ? require('../../scripts/fixed-mock-ux.mjs') : null;
const fixedMockUx = mock?.mockUxConfiguration();
if (fixedMockUx && Object.entries(mock.MOCK_WEB_ENV).some(([name, value]) => process.env[name] !== value)) {
    throw new Error('Fixed mock web build/server environment mismatch.');
}

/** @type {import('next').NextConfig} */
const nextConfig = {
    reactStrictMode: true,
    agentRules: false,
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

    // API v2 owns browser traffic. Ordinary production has no v1 rewrite;
    // only explicit local E2E or the authenticated fixed mock lane admits it.
    async rewrites() {
        const legacyApiUrl = fixedMockUx ? mock.MOCK_WEB_ENV.LUNCHLINEUP_E2E_LEGACY_API_URL : localE2eLegacyApiUrl;
        return [
            {
                source: '/api/v2/:path*',
                destination: `${internalApiV2Url}/:path*`,
            },
            ...(legacyApiUrl ? [{
                source: '/api/v1/:path*',
                destination: `${legacyApiUrl}/:path*`,
            }, {
                // The local server runs without Caddy’s production health mapping.
                source: '/api/health',
                destination: `${internalApiV2Url}/ready`,
            }] : []),
        ];
    },
};

if (fixedMockUx) {
    // A literal UI choice, shared by SSR and the browser, never a public env gate.
    // This compiled mock artifact remains disposable and must not be promoted.
    nextConfig.turbopack = {
        resolveAlias: {
            '@/lib/fixed-mock-onboarding-ui': './lib/fixed-mock-onboarding-ui.mock.ts',
        },
    };
    nextConfig.webpack = (config) => {
        config.resolve.alias = {
            ...config.resolve.alias,
            '@/lib/fixed-mock-onboarding-ui$': require('node:path').resolve(__dirname, 'lib/fixed-mock-onboarding-ui.mock.ts'),
        };
        return config;
    };
}

module.exports = nextConfig;
