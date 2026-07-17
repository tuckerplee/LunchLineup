import type { MetadataRoute } from 'next';

const appOrigin = process.env.NEXT_PUBLIC_APP_ORIGIN?.trim() || 'https://lunchlineup.com';

export default function robots(): MetadataRoute.Robots {
    return {
        rules: {
            userAgent: '*',
            allow: '/',
            disallow: [
                '/admin/',
                '/api/',
                '/auth/',
                '/dashboard/',
                '/mfa/',
                '/onboarding/',
            ],
        },
        sitemap: new URL('/sitemap.xml', appOrigin).toString(),
        host: appOrigin,
    };
}