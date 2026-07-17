import type { MetadataRoute } from 'next';

const appOrigin = process.env.NEXT_PUBLIC_APP_ORIGIN?.trim() || 'https://lunchlineup.com';
const publicRoutes = ['/', '/privacy', '/security', '/status', '/subprocessors', '/terms'] as const;

export default function sitemap(): MetadataRoute.Sitemap {
    const now = new Date();
    return publicRoutes.map((path) => ({
        url: new URL(path, appOrigin).toString(),
        lastModified: now,
        changeFrequency: path === '/' ? 'weekly' : 'monthly',
        priority: path === '/' ? 1 : 0.6,
    }));
}