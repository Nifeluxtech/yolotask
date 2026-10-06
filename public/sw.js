// /public/sw.js
const CACHE = 'yolotask-v1';
const CORE = [
  '/offline.html',
  '/icons/icon.svg',
  '/css/global.css',
  '/js/api.js',
  '/js/auth.js',
  '/js/ui.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(CORE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first with cache fallback: always fresh when online, works when offline
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // never intercept Paystack/Resend/OneSignal

  event.respondWith(
    fetch(req)
      .then((response) => {
        // Cache successful same-origin GETs for offline fallback
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(req, copy));
        }
        return response;
      })
      .catch(() => {
        return caches.match(req).then((cached) => {
          if (cached) return cached;
          if (req.mode === 'navigate') return caches.match('/offline.html');
          return Response.error();
        });
      })
  );
});
