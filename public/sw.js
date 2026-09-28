const CACHE_VERSION = 'v23-prod-secure';
const CACHE_NAME = `gastos-${CACHE_VERSION}`;
const ASSETS = [
'/',
'./index.html',
'./style.css',
'./manifest.json',
'https://cdn-icons-png.flaticon.com/512/2933/2933116.png',
'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
'https://cdn.jsdelivr.net/npm/chart.js',
'https://cdn.jsdelivr.net/npm/dompurify@3.0.6/dist/purify.min.js'
];

self.addEventListener('install', event => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return Promise.allSettled(
                ASSETS.map(asset => 
                    cache.add(asset).catch(err => console.warn(`Aviso: No se pudo precachear ${asset}:`, err))
                )
            );
        })
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(
            keys.map(key => {
                if (key !== CACHE_NAME) {
                    return caches.delete(key);
                }
            })
        )).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    
    // Ignorar POST/PUT/DELETE y extensiones
    if (event.request.method !== 'GET' || url.protocol === 'chrome-extension:') return;
    
    // Ignorar entorno de desarrollo local (Vite y WebSockets)
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return;
    
    // Ignorar Supabase para evitar datos fantasma
    if (url.origin.includes('supabase.co')) return;

    if (event.request.mode === 'navigate') {
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    const resToCache = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, resToCache));
                    return response;
                })
                .catch(() => caches.match('/index.html').then(cachedRes => cachedRes || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })))
        );
        return;
    }

    event.respondWith(
        caches.match(event.request).then(cachedResponse => {
            if (cachedResponse) {
                // Implementación estricta de Stale-While-Revalidate en 2do plano sin bloquear UI
                event.waitUntil(
                    fetch(event.request).then(networkResponse => {
                        if (networkResponse && networkResponse.ok && networkResponse.type !== 'error') {
                            caches.open(CACHE_NAME).then(cache => cache.put(event.request, networkResponse));
                        }
                    }).catch(() => {})
                );
                return cachedResponse;
            }
            return fetch(event.request).then(networkResponse => {
                if (!networkResponse || !networkResponse.ok || networkResponse.type === 'error') return networkResponse;
                const resToCache = networkResponse.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, resToCache));
                return networkResponse;
            }).catch(() => new Response('', { status: 408 }));
        })
    );
});