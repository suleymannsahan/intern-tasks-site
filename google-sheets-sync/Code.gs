// ============================================================
// Intern Panel — Google E-Tablolar Canlı Senkronizasyon
// ============================================================
// Bu dosya Google Apps Script'e yapıştırılır (bir .js dosyası olarak proje içinde
// çalıştırılmaz — kurulum adımları için KURULUM.md'ye bakın).
//
// Ne yapar:
//   - "Şimdi Güncelle" / 5 dakikada bir otomatik: siteden tüm tabloları çeker, her tabloyu
//     ayrı bir sayfaya yazar (Site -> Tablo).
//   - Yeşil arka planlı (düzenlenebilir) bir hücre değiştirildiğinde anında sunucuya yazar
//     (Tablo -> Site). Gri hücreler salt okunurdur; değiştirilirse sunucu reddeder ve hücre
//     eski değerine geri alınır.
// ============================================================

// TODO: Kendi sitenizin adresini yazın (sonunda / OLMASIN). Örn: 'https://intern-panel.onrender.com'
const SERVER_URL = 'https://SITENIZIN-ADRESI.com';

// Script Properties'e (Proje Ayarları > Script Özellikleri) SHEET_SYNC_SECRET adıyla eklenen
// değer buradan okunur — kodun içine secret'ı yazmayın.
const SECRET = PropertiesService.getScriptProperties().getProperty('SHEET_SYNC_SECRET');

const ID_COLUMN_NAME = 'id';
const HEADER_BG = '#e2e8f0';
const EDITABLE_BG = '#d1fae5';  // açık yeşil — bu sütuna yazdığınız değişiklik siteye anında yansır
const READONLY_BG = '#f1f5f9'; // gri — salt okunur, değiştirilirse sunucu reddedip eski haline döner

// ---- Menü: sayfa açılınca üstte "🔄 Canlı Senkron" menüsü belirir ----
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🔄 Canlı Senkron')
    .addItem('Şimdi Güncelle (Site → Tablo)', 'pullAllTables')
    .addItem('İlk Kurulumu Tamamla (sadece 1 kere çalıştırın)', 'kurulumuTamamla')
    .addToUi();
}

// ---- Kurulum: tetikleyicileri kurar, yetki ister — Apps Script editöründen ELLE bir kez
// çalıştırılmalı (menüden çalıştırırsanız yetki isteme penceresi açılmayabilir, editörden
// "kurulumuTamamla" fonksiyonunu seçip Çalıştır'a basın). ----
function kurulumuTamamla() {
  if (!SECRET) {
    throw new Error('Script Properties içinde SHEET_SYNC_SECRET tanımlı değil. Proje Ayarları > Script Özellikleri bölümünden ekleyin.');
  }

  // Varsa eski tetikleyicileri temizle (birden fazla kez çalıştırılırsa çift tetikleyici oluşmasın)
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });

  // Bir hücre elle değiştirildiğinde anında sunucuya yazsın
  ScriptApp.newTrigger('onEditInstallable')
    .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet())
    .onEdit()
    .create();

  // Her 5 dakikada bir sitedeki güncel veriyi çekip tabloyu tazelesin
  ScriptApp.newTrigger('pullAllTables')
    .timeBased()
    .everyMinutes(5)
    .create();

  pullAllTables();

  SpreadsheetApp.getUi().alert(
    'Kurulum tamamlandı!\n\n' +
    '- Tablo her 5 dakikada bir otomatik güncellenecek.\n' +
    '- Yeşil hücrelere yaptığınız değişiklikler anında siteye yazılacak.\n' +
    '- Gri hücreler salt okunurdur; değiştirilirse sunucu reddedip eski haline geri alacak.'
  );
}

// ---- Site -> Tablo: tüm tabloları çek, her tabloyu kendi sayfasına yaz ----
function pullAllTables() {
  if (!SECRET) return;

  var res = UrlFetchApp.fetch(
    SERVER_URL + '/api/sheet-sync/pull?secret=' + encodeURIComponent(SECRET),
    { muteHttpExceptions: true }
  );

  if (res.getResponseCode() !== 200) {
    SpreadsheetApp.getActiveSpreadsheet().toast('Çekme hatası: ' + res.getContentText(), 'Senkron Hatası', 10);
    return;
  }

  var data = JSON.parse(res.getContentText());
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  Object.keys(data.tables).forEach(function (tableName) {
    var t = data.tables[tableName];
    var sheet = ss.getSheetByName(tableName);
    if (!sheet) sheet = ss.insertSheet(tableName);

    sheet.clear();
    if (t.columns.length === 0) return;

    sheet.getRange(1, 1, 1, t.columns.length).setValues([t.columns]);
    sheet.getRange(1, 1, 1, t.columns.length).setFontWeight('bold').setBackground(HEADER_BG);
    sheet.setFrozenRows(1);

    if (t.rows.length > 0) {
      var values = t.rows.map(function (r) {
        return t.columns.map(function (c) {
          return (r[c] === null || r[c] === undefined) ? '' : r[c];
        });
      });
      sheet.getRange(2, 1, values.length, t.columns.length).setValues(values);
    }

    // Sütunları renklendir: düzenlenebilir yeşil, salt okunur gri (başlık satırı hariç)
    var lastRow = Math.max(t.rows.length + 1, 1);
    t.columns.forEach(function (col, idx) {
      var bodyRange = sheet.getRange(2, idx + 1, Math.max(lastRow - 1, 1), 1);
      bodyRange.setBackground(t.editable.indexOf(col) !== -1 ? EDITABLE_BG : READONLY_BG);
    });
  });
}

// ---- Tablo -> Site: bir hücre elle değiştirildiğinde anında sunucuya yaz ----
// NOT: pullAllTables() gibi script'in kendi yaptığı yazımlar (setValues vb.) bu tetikleyiciyi
// TETİKLEMEZ — Apps Script sadece kullanıcının elle yaptığı düzenlemelerde onEdit çalıştırır,
// bu yüzden döngüye girme riski yoktur.
function onEditInstallable(e) {
  if (!SECRET) return;

  var sheet = e.range.getSheet();
  var tableName = sheet.getName();
  var row = e.range.getRow();
  var col = e.range.getColumn();

  // Başlık satırı elle değiştirilmiş olabilir — geri al, sunucuya gönderme
  if (row === 1) {
    e.range.setValue(e.oldValue !== undefined ? e.oldValue : '');
    return;
  }

  var headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var idColIdx = headerRow.indexOf(ID_COLUMN_NAME);
  var columnName = headerRow[col - 1];
  if (idColIdx === -1) return;

  var id = sheet.getRange(row, idColIdx + 1).getValue();
  if (!id) return;

  var payload = {
    secret: SECRET,
    table: tableName,
    id: id,
    column: columnName,
    value: e.range.getValue()
  };

  var res = UrlFetchApp.fetch(SERVER_URL + '/api/sheet-sync/push', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    var err;
    try { err = JSON.parse(res.getContentText()).error; } catch (parseErr) { err = res.getContentText(); }
    // Reddedildi (ör. salt okunur sütun, geçersiz secret) — hücreyi eski değerine geri al
    e.range.setValue(e.oldValue !== undefined ? e.oldValue : '');
    SpreadsheetApp.getActiveSpreadsheet().toast('Kaydedilemedi: ' + err, '❌ Senkron Hatası', 8);
  } else {
    SpreadsheetApp.getActiveSpreadsheet().toast('Kaydedildi ✓', tableName, 3);
  }
}
