# Google E-Tablolar Canlı Senkronizasyon — Kurulum

Bu kurulum, bir Google E-Tablo'yu sitenin veritabanıyla iki yönlü canlı bağlar:
- **Site → Tablo**: her 5 dakikada bir (veya menüden elle) sitedeki güncel veri tabloya yazılır.
- **Tablo → Site**: yeşil arka planlı hücrelerden birini değiştirdiğinizde, değişiklik anında
  veritabanına yazılır.

Gri hücreler **salt okunurdur** — `id`, `role`, `status` gibi alanlar kasıtlı olarak dışarıda
bırakıldı çünkü bunlar sitenin kendi ekranlarından, ilgili bildirim/onay mantığı çalışarak
değiştirilmeli. Hangi tablo/sütunların düzenlenebilir olduğu `server.js` içindeki
`SHEET_EDITABLE_COLUMNS` listesinde tanımlı.

## 1) Sunucu tarafında secret'ı tanımlayın

Bu proje bir `SHEET_SYNC_SECRET` ortam değişkeni bekliyor (Apps Script'in kimliğini doğrulamak
için — bir tür API anahtarı). Aşağıdaki değeri:

```
SHEET_SYNC_SECRET=fef5d3d842a312950215bad74e81837ab6b984f9d9ad6e20
```

- **Yerelde**: `intern-tasks-site.env` dosyanıza ekleyin.
- **Canlı sunucuda** (Render/Railway vb. neredeyse barındırıyorsanız): o platformun "Environment
  Variables" bölümüne aynı isim ve değerle ekleyin, sonra sunucuyu yeniden başlatın (redeploy).

> İsterseniz farklı bir secret üretip kullanabilirsiniz — `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"` ile yeni bir tane üretilebilir. Önemli olan, sunucudaki değer ile Apps Script'e (adım 3) gireceğiniz değerin birebir aynı olması.

## 2) Google E-Tablo oluşturun

1. [sheets.google.com](https://sheets.google.com) → **Boş elektronik tablo**.
2. Üstteki **Uzantılar (Extensions) → Apps Script** menüsüne girin.

## 3) Script kodunu ve secret'ı ekleyin

1. Apps Script editöründe açılan varsayılan `Code.gs` içeriğini tamamen silin.
2. Bu klasördeki **`Code.gs`** dosyasının tüm içeriğini kopyalayıp yapıştırın.
3. Dosyanın en üstündeki şu satırı kendi site adresinizle değiştirin (sonunda `/` **olmasın**):
   ```js
   const SERVER_URL = 'https://SITENIZIN-ADRESI.com';
   ```
4. Sol menüden **Proje Ayarları** (dişli ikonu) → **Script Özellikleri** → **Özellik ekle**:
   - Özellik: `SHEET_SYNC_SECRET`
   - Değer: adım 1'deki secret (`fef5d3d842a312950215bad74e81837ab6b984f9d9ad6e20`)
5. Kaydedin (disket ikonu / Ctrl+S).

## 4) İlk kurulumu çalıştırın (yetki vermeniz gerekecek)

1. Apps Script editöründe üstteki fonksiyon açılır listesinden **`kurulumuTamamla`**'yı seçin.
2. **Çalıştır (Run)** butonuna basın.
3. Google "Yetkilendirme gerekli" penceresi açacak → hesabınızı seçin → "Bu uygulama
   doğrulanmadı" uyarısı çıkarsa **Gelişmiş (Advanced) → (proje adı) sayfasına git (güvenli
   değil)** → **İzin ver**. (Bu uyarı normal — script'i siz yazdığınız/yapıştırdığınız için Google
   onu henüz "incelemedi", kendi hesabınızla kendi script'inize izin veriyorsunuz.)
4. Çalışma bitince bir onay penceresi çıkar: "Kurulum tamamlandı!" — bu, tetikleyicilerin
   kurulduğu ve ilk verinin çekildiği anlamına gelir.

## 5) Kontrol edin

1. E-Tablo'ya geri dönün (sayfayı yenilemeniz gerekebilir).
2. Üstte **🔄 Canlı Senkron** menüsü görünmeli.
3. Her tablo için ayrı bir sekme (users, tasks, projects, meeting_requests, ...) oluşmuş olmalı.
4. Yeşil hücrelerden birini (ör. `tasks` sekmesinde `description`) değiştirip birkaç saniye
   bekleyin — sağ altta "Kaydedildi ✓" bildirimi çıkmalı. Siteyi yenilediğinizde değişikliği
   orada da görürsünüz.
5. Gri bir hücreyi (ör. `id`) değiştirmeyi deneyin — "Kaydedilemedi" bildirimi çıkıp hücre eski
   haline dönmeli. Bu beklenen davranıştır.

## Güvenlik notları

- **Bu E-Tablo'yu sadece güvendiğiniz kişilerle paylaşın** — düzenleme (edit) erişimi olan
  herkes, yeşil hücreler üzerinden doğrudan üretim veritabanına yazabilir.
- `SHEET_SYNC_SECRET`'ı e-posta/Slack gibi kanallarda paylaşmayın; sızarsa sunucudaki (adım 1)
  ve Script Özellikleri'ndeki (adım 3) değeri birlikte değiştirip güncelleyin.
- Düzenlemeye açık tablo/sütunları genişletmek isterseniz `server.js` içindeki
  `SHEET_EDITABLE_COLUMNS` listesini güncelleyin — yalnızca iş akışı/bildirim mantığına bağlı
  OLMAYAN (durum/status, ID, ilişkisel alanlar hariç) serbest metin alanları eklemeniz önerilir.

## Sorun giderme

- **"SHEET_SYNC_SECRET ortam değişkeni tanımlı değil" hatası**: sunucuda env var eksik veya
  sunucu yeniden başlatılmadı.
- **"Geçersiz secret" hatası**: Script Özellikleri'ndeki değer ile sunucudaki değer birebir
  aynı değil (boşluk/harf farkı olabilir).
- **Sekmeler hiç oluşmuyor**: `SERVER_URL`'in doğru yazıldığından ve sonunda `/` olmadığından
  emin olun; ayrıca sitenin canlıda erişilebilir (Apps Script dışarıdan istek atacağı için
  `localhost` ÇALIŞMAZ) olması gerekir.
