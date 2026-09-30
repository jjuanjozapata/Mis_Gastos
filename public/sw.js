const CACHE_VERSION = 'v24-prod-secure';
const CACHE_NAME = `gastos-${CACHE_VERSION}`;
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/chart.js',
  'https://cdn.jsdelivr.net/npm/dompurify@3.0.6/dist/purify.min.js'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return Promise.allSettled(
        ASSETS.map(asset => cache.add(asset).catch(err => {}))
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
  if (event.request.method !== 'GET' || url.protocol === 'chrome-extension:') return;
  // [CISO FIX] Eliminada la restricción de localhost para permitir depuración de PWA offline en entorno de desarrollo.

  // API / Transacciones Supabase -> Network First
  if (url.origin.includes('supabase.co')) {
    event.respondWith(
      fetch(event.request).catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        return await cache.match(event.request);
      })
    );
    return;
  }
  
  // Navegación PWA -> Network First fallback a index.html
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const resToCache = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            try { cache.put(event.request, resToCache); } catch(e) {}
          });
          return response;
        })
        .catch(() => caches.match('/index.html').then(cachedRes => cachedRes || new Response('Offline', { status: 503 })))
    );
    return;
  }
  
  // SWR (Stale-While-Revalidate) para núcleo estático
  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      const networkFetch = fetch(event.request).then(networkResponse => {
        if (networkResponse && networkResponse.ok) {
          caches.open(CACHE_NAME).then(cache => {
            try { cache.put(event.request, networkResponse.clone()); } catch(e) {}
          });
        }
        return networkResponse;
      }).catch(() => { return null; }); // Retorno explícito nulo para manejar la promesa correctamente
      
      return cachedResponse || networkFetch.then(res => res || new Response('Recurso no disponible offline', { status: 408, statusText: 'Offline' }));
    })
  );
});
