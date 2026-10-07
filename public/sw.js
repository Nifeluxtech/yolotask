// /public/sw.js
// LEGACY WORKER — SELF-DESTRUCT ONLY.
// OneSignal now owns the service worker scope (see /OneSignalSDK.sw.js).
// This file exists only to clean up old devices that cached the previous worker.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    self.registration.unregister().then(() => self.clients.matchAll({ type: 'window' }))
      .then((clients) => {
        clients.forEach((client) => client.navigate(client.url));
      })
  );
});
