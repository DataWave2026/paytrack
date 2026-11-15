// Offline shell: NETWORK-FIRST for app files (so updates appear on the next
// load), cache fallback when offline. Google APIs are never cached.
const CACHE = 'paytrack-v116';
const SHELL = [
  '.', 'index.html', 'css/app.css', 'manifest.webmanifest',
  'js/app.js', 'js/auth.js', 'js/config.js', 'js/google.js', 'js/match.js',
  'js/parse.js', 'js/store.js', 'js/sync.js', 'js/log.js', 'js/money.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;   // Google APIs etc: network only
  if (e.request.method !== 'GET') return;
  // cache:'no-cache' revalidates with the server every time (cheap 304s).
  // A plain fetch() honours GitHub Pages' 10-minute max-age, so a fresh
  // deploy could keep serving the previous app version for minutes.
  e.respondWith((async () => {
    const cached = await caches.match(e.request, { ignoreSearch: true });
    const network = fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }).then(resp => {
      if (resp.ok) {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return resp;
      }
      // Server error (5xx/404 from the host): prefer the cached copy.
      return cached || resp;
    });
    if (!cached) return network.catch(() => caches.match(e.request, { ignoreSearch: true }));
    // A slow or captive network must not mean a white screen: after 3 s the
    // cached shell is served while the fetch finishes and refreshes the cache
    // for the next load (new versions still arrive through the SW update).
    const slow = new Promise(res => setTimeout(() => res(cached), 3000));
    return Promise.race([network.catch(() => cached), slow]);
  })());
});
