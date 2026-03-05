import type { Metadata } from 'next';
import '../styles/globals.css';

export const metadata: Metadata = {
    title: 'LunchLineup — Smart Scheduling for Modern Teams',
    description: 'Drag-and-drop workforce scheduling with constraint-based optimization, real-time sync, and automated compliance — built for scale.',
    keywords: ['workforce scheduling', 'shift management', 'employee scheduling', 'team management'],
    openGraph: {
        title: 'LunchLineup',
        description: 'Smart scheduling for modern teams.',
        type: 'website',
    },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en" suppressHydrationWarning>
            <head>
                <meta name="viewport" content="width=device-width, initial-scale=1" />
                <link rel="icon" href="/favicon.ico" />
            </head>
            <body>
                {children}

                {/* Service Worker registration */}
                <script
                    dangerouslySetInnerHTML={{
                        __html: `
              if ('serviceWorker' in navigator) {
                navigator.serviceWorker.register('/sw.js')
                  .catch(err => console.warn('SW registration failed:', err));
              }
            `,
                    }}
                />
            </body>
        </html>
    );
}
