// 1) Load OneSignal's push notification handler FIRST
importScripts('https://cdn.onesignal.com/sdks/OneSignalSDKWorker.js');

// 2) Our own offline caching logic (same behavior as the old sw.js)
const CACHE = 'yolotask-v2';
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

// Network-first with cache fallback
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // never touch Paystack/Resend/OneSignal CDNs

  event.respondWith(
    fetch(req)
      .then((response) => {
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
