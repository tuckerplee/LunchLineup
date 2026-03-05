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
                    }
                ],
            },
        ];
    },

    // Proxy API requests to testing backend (Architecture Part IV)
    async rewrites() {
        return [
            {
                source: '/api/v1/:path*',
                destination: 'http://localhost/api/v1/:path*',
            },
        ];
    },
};

module.exports = nextConfig;
