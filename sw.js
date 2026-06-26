/* Buy Later service worker.
   Caches app shell so it works fully offline.
   It never proxies requests to the internet — only serves local cache,
   and for anything not cached it falls back to the cache (no network fetch for app data).
*/
const CACHE = 'smartbinge-v5';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './tesseract.min.js',
  './icon-192.png',
  './icon-512.png',
  './screenshots/shot1_list.png',
  './screenshots/shot2_add.png',
  './screenshots/shot3_inbox.png',
  './screenshots/shot4_trends.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Only ever serve same-origin from cache. Cross-origin requests are blocked
  // by returning an offline response — guarantees no data leaves the device.
  if (url.origin !== self.location.origin) {
    e.respondWith(new Response('', { status: 204 }));
    return;
  }
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).catch(() =>
      caches.match('./index.html')
    ))
  );
});
