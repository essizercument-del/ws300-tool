// WS300 Titreşim Analiz — Service Worker
// Uygulamayı ana ekrandan/PWA olarak açılabilir ve çevrimdışı da yüklenebilir
// yapmak için basit bir "stale-while-revalidate" önbellekleme uygular.
// Sadece kendi kaynağımızdaki (GitHub Pages) dosyaları önbellekler — Firebase/
// Firestore gibi dış istekler servis worker'a hiç girmeden doğrudan ağa gider.
const CACHE_NAME = 'ws300-cache-v4';
const APP_SHELL = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  // cache.addAll() listedeki dosyalardan biri bile alınamazsa TÜM install adımını
  // başarısız sayar ve servis çalışanı hiç etkinleşmez. Bunun yerine her dosyayı
  // ayrı ayrı denenir; biri eksik/yeniden adlandırılmış olsa bile diğerleri
  // önbelleğe alınır ve kurulum yine de tamamlanır.
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(
        APP_SHELL.map((url) => cache.add(url).catch((err) => {
          console.warn('sw.js: önbelleğe alınamadı, atlanıyor:', url, err);
        }))
      ))
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
