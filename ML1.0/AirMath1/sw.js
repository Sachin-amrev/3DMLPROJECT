const CACHE_NAME = 'airmath-v1';
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './style.css',
    './script.js',
    './manifest.json',
    // We can list external CDNs here, but dynamic caching is often safer for versioned CDNs
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS_TO_CACHE);
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    // Cache First Strategy for everything
    // This allows CDNs to be cached dynamically
    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            if (cachedResponse) {
                return cachedResponse;
            }

            return fetch(event.request).then((response) => {
                // Check if valid response
                if (!response || response.status !== 200 || response.type === 'error') {
                    return response;
                }

                // Clone response to put in cache
                const responseToCache = response.clone();

                caches.open(CACHE_NAME).then((cache) => {
                    // Cache external resources (CDNs) too
                    // Note: Opaque responses (mode: 'no-cors') are cached but size is unknown
                    try {
                        cache.put(event.request, responseToCache);
                    } catch (e) {
                        // Some requests (POST, etc) cannot be cached
                    }
                });

                return response;
            }).catch(() => {
                // Offline fallback if needed
                // For now, if not in cache and no net, it fails.
            });
        })
    );
});
