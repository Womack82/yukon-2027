/* Yukon 2027 – service worker
   - Réseau d'abord pour la page et le manifest (délai max 4 s), repli sur le cache hors-ligne
   - Cache d'abord pour les icônes
   - Stale-while-revalidate pour Google Fonts */

const CACHE = 'yukon2027-v4';
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

  // Page, manifest et service worker : réseau d'abord pour que les mises à jour
  // arrivent dès la 1re ouverture. Si le réseau ne répond pas en 4 s (ou pas du
  // tout, sur la rivière), on sert la copie en cache.
  const isPage = req.mode === 'navigate' || /\/(index\.html|manifest\.json)?$/.test(url.pathname);
  if (isPage) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Icônes et autres fichiers : cache d'abord, puis réseau
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
        .catch(() => undefined);
    })
  );
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const key = req.mode === 'navigate' ? './index.html' : req;
  try {
    const res = await Promise.race([
      fetch(req, { cache: 'no-cache' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
    ]);
    if (res && res.ok) {
      cache.put(key, res.clone());
      return res;
    }
    throw new Error('bad response');
  } catch (e) {
    const cached = (await cache.match(key, { ignoreSearch: true })) || (await cache.match('./index.html'));
    return cached || Response.error();
  }
}
