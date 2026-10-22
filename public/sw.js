const SHELL_CACHE = 'cliptext-shell-v1';
const ASSET_CACHE = 'cliptext-assets-v1';
const APP_CACHES = [SHELL_CACHE, ASSET_CACHE];
const SHELL_FILES = [
  '/',
  '/manifest.webmanifest',
  '/cliptext.svg',
  '/icons/cliptext-192.png',
  '/icons/cliptext-512.png',
  '/icons/cliptext-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith('cliptext-') && !APP_CACHES.includes(key))
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname === '/api' || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then((response) => {
        if (response.ok) caches.open(SHELL_CACHE).then((cache) => cache.put('/', response.clone()));
        return response;
      }).catch(async () => (await caches.match(request)) || (await caches.match('/')) || Response.error())
    );
    return;
  }

  if (!url.pathname.startsWith('/assets/') && !SHELL_FILES.includes(url.pathname)) return;
  event.respondWith(
    fetch(request).then((response) => {
      if (response.ok) caches.open(ASSET_CACHE).then((cache) => cache.put(request, response.clone()));
      return response;
    }).catch(async () => (await caches.match(request)) || Response.error())
  );
});
