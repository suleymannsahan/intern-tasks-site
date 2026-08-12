// sw.js — PWA kurulabilirliği için minimal servis çalışanı.
// Bu uygulama canlı/işbirlikçi bir iş aracı (görevler, bildirimler, onaylar sürekli değişiyor);
// bu yüzden BİLİNÇLİ olarak agresif önbellekleme yapılmıyor. Tek amaç: "Ana Ekrana Ekle" ile
// gerçek bir uygulama gibi açılabilmek ve internet anlık kesilirse boş tarayıcı hatası yerine
// son yüklenen kabuğu göstermek. /api/ istekleri HİÇBİR ZAMAN önbellekten dönmez.
const CACHE_ADI = 'gorev-panel-kabuk-v1';
const KABUK_DOSYALARI = ['/', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_ADI).then((cache) => cache.addAll(KABUK_DOSYALARI)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((isimler) =>
      Promise.all(isimler.filter((isim) => isim !== CACHE_ADI).map((isim) => caches.delete(isim)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API istekleri: her zaman ağdan — asla önbellekten (veri gerçek zamanlı olmalı).
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Kabuk/varlıklar: önce ağ, ağ başarısız olursa (çevrimdışı) önbelleğe düş.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200 && event.request.method === 'GET') {
          const kopya = response.clone();
          caches.open(CACHE_ADI).then((cache) => cache.put(event.request, kopya)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
