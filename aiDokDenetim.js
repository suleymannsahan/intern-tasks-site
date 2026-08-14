// aiDokDenetim.js
// ============================================================
// DOKÜMAN DENETİMİ — RAG + LLM-as-a-Judge + Dinamik Referans Hafızası
//
// Amaç: Yeni bir Word (.docx) dokümanını, önceden onaylanmış "referans" dokümanlara
// (format/içerik standardımız) göre otomatik denetlemek — uygunluk puanı, eksik/fazla
// bölümler, üslup notları ve öneriler üretmek.
//
// Mimari (aiRag.js ile AYNI felsefe — ek vektör veritabanı/servis YOK):
//   1) Referans .docx dosyaları metne çevrilip paragraf bazlı parçalara (chunk) bölünür.
//   2) Her parça Mistral'ın "mistral-embed" modeliyle vektöre çevrilip mevcut
//      SQLite/libsql'de (JSON string olarak) saklanır.
//   3) Yeni doküman geldiğinde, kendi parçaları da embed edilir; kosinüs benzerliğiyle
//      JS içinde en alakalı referans parçaları bulunur (brute-force — bu ölçekte yeterli).
//   4) Mistral'a (LLM-as-a-Judge) bulunan referans parçaları + yeni doküman verilip
//      yapılandırılmış JSON rapor (puan/eksikler/öneriler) üretilir.
//   5) Kullanıcı raporu ONAYLARSA, doküman otomatik olarak yeni bir referansa dönüşür
//      (dinamik RAG güncellemesi — fine-tuning gerektirmeden sistemi "öğretir").
//
// Kullanım (server.js):
//   const aiDokDenetim = require('./aiDokDenetim');
//   aiDokDenetim.initDokDenetimSchema(db).catch(e => console.error('Doküman Denetimi şema:', e.message));
//   app.use('/api', aiDokDenetim.createDokDenetimRouter(db, { isAdmin }));
// ============================================================

const express = require('express');
const mammoth = require('mammoth');

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const MISTRAL_MODEL = process.env.MISTRAL_MODEL || 'mistral-large-latest';
const EMBED_MODEL = process.env.MISTRAL_EMBED_MODEL || 'mistral-embed';

function nowStr() {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);
}

// ---- Şema -------------------------------------------------------------------
async function initDokDenetimSchema(db) {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS dok_referanslar (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        baslik TEXT NOT NULL,
        dosya_adi TEXT,
        tam_metin TEXT NOT NULL,
        ekleyen_id INTEGER,
        ekleyen_adi TEXT,
        created_at TEXT NOT NULL
      )
    `);
  } catch (e) { console.log('dok_referanslar:', e.message); }
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS dok_referans_parcalari (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        referans_id INTEGER NOT NULL,
        sira INTEGER NOT NULL,
        parca_metni TEXT NOT NULL,
        embedding TEXT NOT NULL
      )
    `);
  } catch (e) { console.log('dok_referans_parcalari:', e.message); }
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS dok_degerlendirmeler (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        baslik TEXT,
        dosya_adi TEXT,
        tam_metin TEXT NOT NULL,
        puan INTEGER,
        rapor TEXT NOT NULL,
        durum TEXT NOT NULL DEFAULT 'bekliyor',
        ret_notu TEXT,
        degerlendiren_id INTEGER,
        degerlendiren_adi TEXT,
        created_at TEXT NOT NULL,
        karar_at TEXT
      )
    `);
  } catch (e) { console.log('dok_degerlendirmeler:', e.message); }
}

// ---- .docx -> düz metin --------------------------------------------------
async function docxMetneCevir(base64) {
  const buffer = Buffer.from(base64, 'base64');
  const cikti = await mammoth.extractRawText({ buffer });
  return cikti.value || '';
}

// ---- Paragraf bazlı parçalama (chunking) ---------------------------------
function metniParcala(metin, hedefUzunluk = 1200) {
  const paragraflar = String(metin || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const parcalar = [];
  let mevcut = '';
  for (const p of paragraflar) {
    if (mevcut && (mevcut.length + p.length + 2) > hedefUzunluk) {
      parcalar.push(mevcut);
      mevcut = p;
    } else {
      mevcut = mevcut ? mevcut + '\n\n' + p : p;
    }
  }
  if (mevcut) parcalar.push(mevcut);
  // Nadiren tek bir paragraf çok uzun olabilir; onu da böl
  const sonuc = [];
  parcalar.forEach(pc => {
    if (pc.length <= hedefUzunluk * 1.5) { sonuc.push(pc); return; }
    for (let i = 0; i < pc.length; i += hedefUzunluk) sonuc.push(pc.slice(i, i + hedefUzunluk));
  });
  return sonuc.filter(Boolean);
}

// ---- Embedding (Mistral) — aiRag.js ile aynı desen, parti (batch) halinde ----
async function embedTexts(texts) {
  const sonuc = [];
  const PARTI = 16;
  for (let i = 0; i < texts.length; i += PARTI) {
    const grup = texts.slice(i, i + PARTI).map(t => String(t || '').slice(0, 8000));
    const r = await fetch('https://api.mistral.ai/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${MISTRAL_API_KEY}` },
      body: JSON.stringify({ model: EMBED_MODEL, input: grup })
    });
    if (!r.ok) throw new Error('Embedding servisi yanıt vermedi (' + r.status + ').');
    const data = await r.json();
    (data.data || []).forEach(d => sonuc.push(d.embedding));
  }
  return sonuc;
}

function kosinus(a, b) {
  if (!a || !b || a.length !== b.length) return -1;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return -1;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---- Bir dokümanı referans hafızasına ekler (chunk + embed + kaydet) --------
async function referansEkle(db, { baslik, dosyaAdi, tamMetin, ekleyenId, ekleyenAdi }) {
  const parcalar = metniParcala(tamMetin);
  if (!parcalar.length) throw new Error('Dokümandan metin çıkarılamadı.');
  const embeddingler = await embedTexts(parcalar);

  const ins = await db.execute({
    sql: `INSERT INTO dok_referanslar (baslik, dosya_adi, tam_metin, ekleyen_id, ekleyen_adi, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [baslik, dosyaAdi || null, tamMetin, ekleyenId || null, ekleyenAdi || null, nowStr()]
  });
  const referansId = Number(ins.lastInsertRowid);
  for (let i = 0; i < parcalar.length; i++) {
    await db.execute({
      sql: `INSERT INTO dok_referans_parcalari (referans_id, sira, parca_metni, embedding) VALUES (?, ?, ?, ?)`,
      args: [referansId, i, parcalar[i], JSON.stringify(embeddingler[i])]
    });
  }
  return referansId;
}

// ---- Yeni dokümanın parçalarına en benzer referans parçalarını bulur --------
// Brute-force kosinüs benzerliği: bu ölçekte (yüzlerce parça) sorun değil.
async function enBenzerParcalariBul(db, sorguParcalari, k = 8) {
  const r = await db.execute(`
    SELECT p.id, p.parca_metni, p.embedding, ref.baslik AS referans_baslik
    FROM dok_referans_parcalari p JOIN dok_referanslar ref ON ref.id = p.referans_id
  `);
  const referansParcalari = r.rows
    .map(row => { try { return { ...row, embVec: JSON.parse(row.embedding) }; } catch (e) { return null; } })
    .filter(Boolean);
  if (!referansParcalari.length) return [];

  const sorguEmbler = await embedTexts(sorguParcalari);
  const enIyiSkor = new Map(); // parca id -> en yüksek benzerlik
  sorguEmbler.forEach(qEmb => {
    referansParcalari.forEach(rp => {
      const skor = kosinus(qEmb, rp.embVec);
      if (!enIyiSkor.has(rp.id) || skor > enIyiSkor.get(rp.id)) enIyiSkor.set(rp.id, skor);
    });
  });

  const parcaHaritasi = new Map(referansParcalari.map(rp => [rp.id, rp]));
  return [...enIyiSkor.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([id, skor]) => ({
      metin: parcaHaritasi.get(id).parca_metni,
      baslik: parcaHaritasi.get(id).referans_baslik,
      skor: Number(skor.toFixed(3))
    }));
}

// ---- LLM-as-a-Judge: yapılandırılmış JSON rapor üretir -----------------------
async function raporUret(tamMetin, benzerParcalar, referansVarMi) {
  const baglam = benzerParcalar
    .map((p, i) => `--- Referans Parça ${i + 1} (${p.baslik}, benzerlik: ${p.skor}) ---\n${p.metin}`)
    .join('\n\n');

  const sistem = `Sen bir kurumsal doküman denetçisi yapay zekasın. Görevin, YENİ DOKÜMANI ${referansVarMi
    ? 'aşağıdaki REFERANS PARÇALARI (şirketin onaylanmış standart dokümanlarından alınmıştır) ile karşılaştırarak'
    : '(henüz onaylanmış referans doküman yok, bu yüzden genel yapı/üslup/tutarlılık standartlarına göre)'} değerlendirmek.

KURALLAR:
- SADECE geçerli JSON döndür. Markdown işareti, açıklama veya başka hiçbir metin YAZMA.
- JSON şu alanları içermeli: puan (0-100 tam sayı), ozet (1-2 cümle Türkçe özet), eksikBolumler (string dizisi), fazlaBolumler (string dizisi), uslupNotlari (string dizisi), oneriler (string dizisi).
- Bilmediğin/uydurma bir şey yazma; emin değilsen ilgili diziyi boş bırak.
- Puanı SADECE somut gerekçelerle ver (format uyumu, eksik bölüm, üslup tutarlılığı, referanslarla örtüşme).
${referansVarMi ? '\nREFERANS PARÇALARI:\n' + baglam : ''}`;

  const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${MISTRAL_API_KEY}` },
    body: JSON.stringify({
      model: MISTRAL_MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: sistem },
        { role: 'user', content: `YENİ DOKÜMAN:\n${String(tamMetin).slice(0, 12000)}` }
      ],
      response_format: { type: 'json_object' }
    })
  });
  if (!r.ok) throw new Error('Değerlendirme servisi yanıt vermedi (' + r.status + ').');
  const data = await r.json();
  const ham = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '{}';

  let rapor;
  try { rapor = JSON.parse(ham); }
  catch (e) {
    const eslesme = ham.match(/\{[\s\S]*\}/);
    rapor = eslesme ? JSON.parse(eslesme[0]) : {};
  }
  const puanSayi = Number(rapor.puan);
  rapor.puan = Number.isFinite(puanSayi) ? Math.max(0, Math.min(100, Math.round(puanSayi))) : null;
  rapor.ozet = rapor.ozet ? String(rapor.ozet) : '';
  ['eksikBolumler', 'fazlaBolumler', 'uslupNotlari', 'oneriler'].forEach(k => {
    if (!Array.isArray(rapor[k])) rapor[k] = [];
  });
  rapor.referansVarMi = referansVarMi;
  rapor.kiyaslananReferansSayisi = benzerParcalar.length;
  return rapor;
}

// ---- Router -------------------------------------------------------------------
function createDokDenetimRouter(db, { isAdmin }) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!MISTRAL_API_KEY) {
      return res.status(503).json({ error: 'Yapay zeka özellikleri yapılandırılmamış (MISTRAL_API_KEY tanımlı değil).' });
    }
    next();
  });

  // -------- Referans dokümanlar --------
  router.post('/dok-denetim/referanslar', async (req, res) => {
    try {
      const { userId, userName, baslik, dosyaAdi, dosyaBase64, metin } = req.body;
      if (!baslik || !String(baslik).trim()) return res.status(400).json({ error: 'Başlık zorunludur.' });

      let tamMetin = metin;
      if (!tamMetin && dosyaBase64) tamMetin = await docxMetneCevir(dosyaBase64);
      if (!tamMetin || !tamMetin.trim()) return res.status(400).json({ error: 'Dokümandan metin okunamadı.' });

      const referansId = await referansEkle(db, {
        baslik: String(baslik).trim(), dosyaAdi, tamMetin, ekleyenId: userId, ekleyenAdi: userName
      });
      res.json({ id: referansId, message: 'Referans doküman eklendi.' });
    } catch (error) {
      res.status(500).json({ error: 'Referans eklenemedi: ' + error.message });
    }
  });

  router.get('/dok-denetim/referanslar', async (req, res) => {
    try {
      const r = await db.execute(`
        SELECT ref.id, ref.baslik, ref.dosya_adi, ref.ekleyen_adi, ref.created_at, COUNT(p.id) AS parca_sayisi
        FROM dok_referanslar ref LEFT JOIN dok_referans_parcalari p ON p.referans_id = ref.id
        GROUP BY ref.id ORDER BY ref.created_at DESC
      `);
      res.json({ referanslar: r.rows });
    } catch (error) {
      res.status(500).json({ error: 'Referans listesi alınamadı: ' + error.message });
    }
  });

  router.delete('/dok-denetim/referanslar/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      await db.execute({ sql: `DELETE FROM dok_referans_parcalari WHERE referans_id = ?`, args: [id] });
      await db.execute({ sql: `DELETE FROM dok_referanslar WHERE id = ?`, args: [id] });
      res.json({ message: 'Referans silindi.' });
    } catch (error) {
      res.status(500).json({ error: 'Referans silinemedi: ' + error.message });
    }
  });

  // -------- Değerlendirme (RAG karşılaştırma + LLM-as-a-Judge) --------
  router.post('/dok-denetim/degerlendir', async (req, res) => {
    try {
      const { userId, userName, baslik, dosyaAdi, dosyaBase64, metin } = req.body;
      let tamMetin = metin;
      if (!tamMetin && dosyaBase64) tamMetin = await docxMetneCevir(dosyaBase64);
      if (!tamMetin || !tamMetin.trim()) return res.status(400).json({ error: 'Dokümandan metin okunamadı.' });

      const parcalar = metniParcala(tamMetin);
      const sayimSonucu = await db.execute(`SELECT COUNT(*) AS c FROM dok_referans_parcalari`);
      const referansVarMi = Number(sayimSonucu.rows[0].c) > 0;

      // Çok uzun dokümanlarda maliyeti sınırlamak için ilk 20 parçayla örnekleme yapılır.
      const benzerParcalar = referansVarMi ? await enBenzerParcalariBul(db, parcalar.slice(0, 20), 8) : [];
      const rapor = await raporUret(tamMetin, benzerParcalar, referansVarMi);

      const nihaiBaslik = (baslik && String(baslik).trim()) || dosyaAdi || 'Adsız Doküman';
      const ins = await db.execute({
        sql: `INSERT INTO dok_degerlendirmeler (baslik, dosya_adi, tam_metin, puan, rapor, durum, degerlendiren_id, degerlendiren_adi, created_at)
              VALUES (?, ?, ?, ?, ?, 'bekliyor', ?, ?, ?)`,
        args: [nihaiBaslik, dosyaAdi || null, tamMetin, rapor.puan, JSON.stringify(rapor), userId || null, userName || null, nowStr()]
      });
      res.json({ id: Number(ins.lastInsertRowid), rapor });
    } catch (error) {
      res.status(500).json({ error: 'Değerlendirme yapılamadı: ' + error.message });
    }
  });

  router.get('/dok-denetim/degerlendirmeler', async (req, res) => {
    try {
      const r = await db.execute(`
        SELECT id, baslik, dosya_adi, puan, durum, degerlendiren_adi, created_at, karar_at
        FROM dok_degerlendirmeler ORDER BY id DESC LIMIT 100
      `);
      res.json({ degerlendirmeler: r.rows });
    } catch (error) {
      res.status(500).json({ error: 'Liste alınamadı: ' + error.message });
    }
  });

  router.get('/dok-denetim/degerlendirmeler/:id', async (req, res) => {
    try {
      const r = await db.execute({ sql: `SELECT * FROM dok_degerlendirmeler WHERE id = ?`, args: [Number(req.params.id)] });
      const kayit = r.rows[0];
      if (!kayit) return res.status(404).json({ error: 'Kayıt bulunamadı.' });
      let rapor = {};
      try { rapor = JSON.parse(kayit.rapor); } catch (e) {}
      res.json({ ...kayit, rapor });
    } catch (error) {
      res.status(500).json({ error: 'Kayıt alınamadı: ' + error.message });
    }
  });

  // Onay: doküman referans hafızasına eklenir (dinamik RAG güncellemesi / geri besleme döngüsü)
  router.post('/dok-denetim/degerlendirmeler/:id/onayla', async (req, res) => {
    try {
      const { userId, userName } = req.body;
      const id = Number(req.params.id);
      const r = await db.execute({ sql: `SELECT * FROM dok_degerlendirmeler WHERE id = ?`, args: [id] });
      const kayit = r.rows[0];
      if (!kayit) return res.status(404).json({ error: 'Değerlendirme bulunamadı.' });
      if (kayit.durum !== 'bekliyor') return res.status(400).json({ error: 'Bu değerlendirme zaten karara bağlanmış.' });

      const referansId = await referansEkle(db, {
        baslik: kayit.baslik, dosyaAdi: kayit.dosya_adi, tamMetin: kayit.tam_metin,
        ekleyenId: userId, ekleyenAdi: userName
      });
      await db.execute({ sql: `UPDATE dok_degerlendirmeler SET durum = 'onaylandi', karar_at = ? WHERE id = ?`, args: [nowStr(), id] });
      res.json({ message: 'Doküman onaylandı ve referans hafızasına eklendi.', referansId });
    } catch (error) {
      res.status(500).json({ error: 'Onay işlenemedi: ' + error.message });
    }
  });

  router.post('/dok-denetim/degerlendirmeler/:id/reddet', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const not = req.body ? req.body.not : null;
      const r = await db.execute({ sql: `SELECT id, durum FROM dok_degerlendirmeler WHERE id = ?`, args: [id] });
      if (!r.rows[0]) return res.status(404).json({ error: 'Değerlendirme bulunamadı.' });
      if (r.rows[0].durum !== 'bekliyor') return res.status(400).json({ error: 'Bu değerlendirme zaten karara bağlanmış.' });

      await db.execute({ sql: `UPDATE dok_degerlendirmeler SET durum = 'reddedildi', karar_at = ?, ret_notu = ? WHERE id = ?`, args: [nowStr(), not || null, id] });
      res.json({ message: 'Değerlendirme reddedildi.' });
    } catch (error) {
      res.status(500).json({ error: 'İşlem yapılamadı: ' + error.message });
    }
  });

  return router;
}

module.exports = { initDokDenetimSchema, createDokDenetimRouter };
