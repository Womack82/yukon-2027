/* Yukon 2027 – service worker
   - Cache-first pour la coquille de l'app (HTML, manifest, icônes)
   - Stale-while-revalidate pour Google Fonts
   - Repli sur index.html hors-ligne pour les navigations */

const CACHE = 'yukon2027-v2';
const FONT_CACHE = 'yukon2027-fonts-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/yukon-icone-192.png',
  './icons/yukon-icone-512.png',
  './icons/apple-touch-icon-180.png',
  './icons/favicon-32.png',
  './icons/favicon.ico'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // Chaque fichier séparément : une icône manquante ne bloque pas l'installation
      Promise.all(SHELL.map((url) => cache.add(url).catch(() => null)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  const keep = [CACHE, FONT_CACHE];
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Google Fonts : stale-while-revalidate
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.open(FONT_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const network = fetch(req)
          .then((res) => { if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()); return res; })
          .catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Coquille de l'app : cache d'abord, puis réseau, puis repli sur index.html
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => (req.mode === 'navigate' ? caches.match('./index.html') : undefined));
    })
  );
});
