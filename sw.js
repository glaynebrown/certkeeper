/* Offline support.

   - App files (this site): network first, so an update you upload shows up
     right away; the saved copy is used when there's no connection.
   - Firebase SDK (gstatic): saved copy first -- those URLs are versioned and
     never change.
   - Uploaded files (cards, PDFs, and the lookups that find them): network
     first, saved copy offline -- so anything opened once can be shown with
     no signal. Cleared on sign-out (see store.js).
   - Everything else (database, login) goes straight to the network.
     Firestore keeps its own offline copy of cert info. */
const APP_CACHE = 'ck-app-v1';
const FILE_CACHE = 'ck-files-v1';
const APP_FILES = [
  './', 'index.html', 'styles.css', 'app.js', 'store.js', 'dates.js', 'templates.js', 'scan.js',
  'firebase-config.js', 'manifest.json', 'icon-192.png', 'apple-touch-icon.png',
];
const SDK = ['app', 'auth', 'firestore', 'storage']
  .map(name => `https://www.gstatic.com/firebasejs/10.14.1/firebase-${name}-compat.js`);
const HOME = new URL('./', self.location).href;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(APP_CACHE)
      // One missing file shouldn't stop the rest from being saved.
      .then(cache => Promise.allSettled([...APP_FILES, ...SDK].map(url => cache.add(url))))
      .then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== APP_CACHE && k !== FILE_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()));
});

async function networkFirst(request, cacheName, key = request) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    // Opaque = an <img> from another site; it can't be inspected but can be saved.
    if (response.ok || response.type === 'opaque') cache.put(key, response.clone());
    return response;
  } catch (err) {
    const saved = await cache.match(key);
    if (saved) return saved;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(APP_CACHE);
  const saved = await cache.match(request);
  if (saved) return saved;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    // Any page load (including invite links with ?invite=...) is the same one page.
    event.respondWith(request.mode === 'navigate'
      ? networkFirst(request, APP_CACHE, HOME)
      : networkFirst(request, APP_CACHE));
  } else if (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    event.respondWith(cacheFirst(request));
  } else if (url.hostname === 'firebasestorage.googleapis.com') {
    event.respondWith(networkFirst(request, FILE_CACHE));
  }
});
