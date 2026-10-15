// WS300 Titreşim Analiz — Service Worker
// Uygulamayı ana ekrandan/PWA olarak açılabilir ve çevrimdışı da yüklenebilir
// yapmak için basit bir "stale-while-revalidate" önbellekleme uygular.
// Kendi kaynağımızdaki (GitHub Pages) dosyaları ve index.html'in yüklediği Firebase
// kütüphanelerini önbellekler. Firestore/Auth API istekleri servis worker'a hiç
// girmeden doğrudan ağa gider (çevrimdışı verileri Firestore'un kendi önbelleği tutar).
const CACHE_NAME = 'ws300-cache-v5';
const APP_SHELL = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];
// index.html'deki <script src> adresleriyle BİREBİR aynı olmalı (sürüm değişirse burası da).
// Bunlar önbellekte olmazsa internetsiz açılışta `firebase` tanımsız kalır ve uygulama
// hiç başlamaz. Sürümlü adresler değişmediği için önbellek-öncelikli sunulur.
const FIREBASE_LIBS = [
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore-compat.js',
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth-compat.js'
];

self.addEventListener('install', (event) => {
  // cache.addAll() listedeki dosyalardan biri bile alınamazsa TÜM install adımını
  // başarısız sayar ve servis çalışanı hiç etkinleşmez. Bunun yerine her dosyayı
  // ayrı ayrı denenir; biri eksik/yeniden adlandırılmış olsa bile diğerleri
  // önbelleğe alınır ve kurulum yine de tamamlanır.
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all([
        ...APP_SHELL.map((url) => cache.add(url).catch((err) => {
          console.warn('sw.js: önbelleğe alınamadı, atlanıyor:', url, err);
        })),
        // <script> etiketi bu dosyaları CORS'suz (no-cors) ister; aynı kipte alıp
        // saklıyoruz. Yanıt "opak" olur ama <script> için sorunsuz çalışır.
        ...FIREBASE_LIBS.map((url) => fetch(url, { mode: 'no-cors' })
          .then((res) => cache.put(url, res))
          .catch((err) => { console.warn('sw.js: önbelleğe alınamadı, atlanıyor:', url, err); }))
      ]))
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
  if (FIREBASE_LIBS.includes(req.url)) {
    event.respondWith(
      caches.match(req.url).then((cached) => cached || fetch(req).then((res) => {
        if (res && (res.status === 200 || res.type === 'opaque')) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req.url, clone));
        }
        return res;
      }))
    );
    return;
  }
  if (url.origin !== self.location.origin) return; // diğer dış istekleri (Firestore/Auth API vb.) dokunmadan bırak

  // index.html (ve manifest.json) için AĞ ÖNCELİKLİ strateji: her sayfa
  // açılışında önce internetten en güncel sürüm istenir. Böylece kod her
  // güncellendiğinde CACHE_NAME'i elle artırıp yeniden yüklemeye gerek
  // kalmaz — açılışta otomatik en son hâli gelir. İnternet yoksa (gerçekten
  // çevrimdışıysa) önbellekteki son bilinen sürüme düşülür, PWA'nın
  // çevrimdışı çalışma özelliği bozulmaz.
  const isAppShellDoc = req.mode === 'navigate'
    || url.pathname.endsWith('/index.html')
    || url.pathname.endsWith('/manifest.json');

  if (isAppShellDoc) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Diğer statik dosyalar (ikonlar vb.) — bunlar sık değişmediği için
  // eski "stale-while-revalidate" davranışı (hızlı açılış + arka planda
  // güncelleme) yeterli.
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
