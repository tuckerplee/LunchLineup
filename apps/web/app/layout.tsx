import type { Metadata } from 'next';
import '../styles/globals.css';

const appOrigin = process.env.NEXT_PUBLIC_APP_ORIGIN?.trim() || 'https://lunchlineup.com';

export const metadata: Metadata = {
    metadataBase: new URL(appOrigin),
    title: {
        default: 'LunchLineup | Workforce Scheduling',
        template: '%s | LunchLineup',
    },
    description: 'Workforce scheduling with constraint-based optimization, real-time sync, and automated compliance.',
    keywords: ['workforce scheduling', 'shift management', 'employee scheduling', 'team management'],
    alternates: {
        canonical: '/',
    },
    openGraph: {
        title: 'LunchLineup | Workforce Scheduling',
        description: 'Build and manage reliable team schedules from one operational workspace.',
        type: 'website',
        url: '/',
        siteName: 'LunchLineup',
        locale: 'en_US',
        images: [{ url: '/opengraph-image', width: 1200, height: 630, alt: 'LunchLineup workforce scheduling' }],
    },
    twitter: {
        card: 'summary_large_image',
        title: 'LunchLineup | Workforce Scheduling',
        description: 'Build and manage reliable team schedules from one operational workspace.',
        images: ['/opengraph-image'],
    },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en" suppressHydrationWarning>
            <head>
                <meta name="viewport" content="width=device-width, initial-scale=1" />
                <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
            </head>
            <body>
                {children}
            </body>
        </html>
    );
}