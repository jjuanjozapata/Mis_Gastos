const CACHE_VERSION = 'v24-prod-secure';
const CACHE_NAME = `gastos-${CACHE_VERSION}`;
const ASSETS = [
  '/',
  './index.html',
  './style.css',
  './manifest.json',
  'https://flaticon.com',
  'https://jsdelivr.net',
  'https://jsdelivr.net',
  'https://jsdelivr.net'
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
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return;

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
      }).catch(() => {});
      
      return cachedResponse || networkFetch.then(res => res || new Response('', { status: 408 }));
    })
  );
});
