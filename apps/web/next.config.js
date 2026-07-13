const internalApiUrl = (process.env.INTERNAL_API_URL || 'http://api:3000/v1').replace(/\/$/, '');
const isProduction = process.env.NODE_ENV === 'production';
const turnstileOrigin = 'https://challenges.cloudflare.com';
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
    `script-src 'self' ${turnstileOrigin} 'unsafe-inline'${isProduction ? '' : " 'unsafe-eval'"}`,
    `connect-src 'self' ${turnstileOrigin} https: wss: http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*`,
    ...(isProduction ? ['upgrade-insecure-requests'] : []),
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
    reactStrictMode: true,

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
                ],
            },
        ];
    },

    // Proxy API requests from the Next.js server to the Docker API service.
    async rewrites() {
        return [
            {
                source: '/api/v1/:path*',
                destination: `${internalApiUrl}/:path*`,
            },
        ];
    },
};

module.exports = nextConfig;
