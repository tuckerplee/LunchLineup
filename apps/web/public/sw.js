// apps/web/public/sw.js
const CACHE_NAME = 'lunchlineup-v2';

// Only cache the shell — Next.js handles its own JS/CSS chunking
const ASSETS_TO_CACHE = ['/'];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
    );
    // Take over immediately without waiting for old SW to unload
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    // Delete any old caches from previous SW versions
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys
                    .filter((key) => key !== CACHE_NAME)
                    .map((key) => caches.delete(key))
            )
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    // Only cache-first for same-origin GET requests; pass everything else through
    if (event.request.method !== 'GET' || !event.request.url.startsWith(self.location.origin)) {
        return;
    }
    event.respondWith(
        caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
});
