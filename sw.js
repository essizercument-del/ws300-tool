// WS300 Titreşim Analiz — Service Worker
// Uygulamayı ana ekrandan/PWA olarak açılabilir ve çevrimdışı da yüklenebilir
// yapmak için basit bir "stale-while-revalidate" önbellekleme uygular.
// Sadece kendi kaynağımızdaki (GitHub Pages) dosyaları önbellekler — Firebase/
// Firestore gibi dış istekler servis worker'a hiç girmeden doğrudan ağa gider.
const CACHE_NAME = 'ws300-cache-v1';
const APP_SHELL = [
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // dış istekleri (Firebase vb.) dokunmadan bırak

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
