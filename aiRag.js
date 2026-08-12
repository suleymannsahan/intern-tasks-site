// aiRag.js
// ============================================================
// ÖZELLİK 4 — SEMANTIC SEARCH / RAG (Geçmiş Görev & Not Hafızası)
//
// Amaç: Yeni bir kart/görev üzerinde çalışırken, GEÇMİŞTEKİ benzer görevlerin
// açıklamalarını, teknik notlarını ve yaşanan blokajları bağlama getirmek.
// Örn: "Daha önce X projesinde benzer BDK aşamasında test cihazı uyumsuzluğu
// nedeniyle 3 gün kaybedilmişti; başlamadan önce test düzeneğini kontrol edin."
//
// Neden pgvector/Chroma DEĞİL: Bu ölçekte (birkaç bin görev) ayrı bir vektör
// veritabanı fazladan altyapı olur. Bunun yerine embedding'leri Mistral'ın
// "mistral-embed" modeliyle üretip mevcut SQLite/libsql'de saklıyoruz; arama
// anında kosinüs benzerliğini JS içinde hesaplıyoruz. Ek servis/anahtar YOK.
//
// Kullanım (server.js):
//   const aiRag = require('./aiRag');
//   await aiRag.initRagSchema(db);
//   app.use('/api', aiRag.createRagRouter(db, { isAdmin }));
//   aiRag.startRagIndexer(db);   // arka planda yeni/değişen görevleri indeksler
//
// aiAgent.js bu modülün benzerGorevAra() fonksiyonunu bir okuma aracı olarak kullanır.
// ============================================================

const express = require('express');
const crypto = require('crypto');

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const EMBED_MODEL = process.env.MISTRAL_EMBED_MODEL || 'mistral-embed';

function nowStr() {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);
}

// ---- Şema -----------------------------------------------------------------
async function initRagSchema(db) {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS gorev_hafiza (
        task_id INTEGER PRIMARY KEY,
        baslik TEXT,
        birim TEXT,
        icerik TEXT,
        icerik_hash TEXT,
        embedding TEXT,
        guncelleme TEXT
      )
    `);
  } catch (e) { console.log('gorev_hafiza:', e.message); }
}

// ---- Embedding (Mistral) --------------------------------------------------
async function embedTexts(texts) {
  const r = await fetch('https://api.mistral.ai/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${MISTRAL_API_KEY}` },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts })
  });
  if (!r.ok) throw new Error('Embedding servisi yanıt vermedi (' + r.status + ').');
  const data = await r.json();
  return (data.data || []).map(d => d.embedding);
}
async function embedText(text) {
  const [v] = await embedTexts([String(text || '').slice(0, 8000)]);
  return v;
}

// ---- Kosinüs benzerliği ---------------------------------------------------
function kosinus(a, b) {
  if (!a || !b || a.length !== b.length) return -1;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return -1;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Görevden aranabilir metin üretir (başlık + açıklama + kategori + aşama notları/blokajları)
function gorevIcerigiKur(task) {
  const parcalar = [];
  if (task.title) parcalar.push('Başlık: ' + task.title);
  if (task.category) parcalar.push('Kategori: ' + task.category);
  if (task.description) parcalar.push('Açıklama: ' + task.description);
  if (task.review_comment) parcalar.push('Değerlendirme notu: ' + task.review_comment);
  if (task.is_plani) {
    try {
      const p = JSON.parse(task.is_plani);
      (p.adimlar || []).forEach(a => {
        const not = a.aciklama ? ` (${a.aciklama})` : '';
        parcalar.push(`Aşama ${a.ad}${not}${a.durum ? ' - ' + a.durum : ''}`);
      });
    } catch (e) {}
  }
  return parcalar.join('\n');
}
function hashla(s) { return crypto.createHash('sha1').update(String(s || '')).digest('hex'); }

// ---- Tek görevi indeksle (upsert) ----------------------------------------
async function gorevIndexle(db, task) {
  if (!MISTRAL_API_KEY) return false;
  const icerik = gorevIcerigiKur(task);
  if (!icerik.trim()) return false;
  const h = hashla(icerik);

  // Aynı içerik zaten indeksliyse embedding'i tekrar üretme (maliyet + rate limit)
  const mevcut = await db.execute({ sql: `SELECT icerik_hash FROM gorev_hafiza WHERE task_id = ?`, args: [task.id] });
  if (mevcut.rows[0] && mevcut.rows[0].icerik_hash === h) return false;

  const emb = await embedText(icerik);
  await db.execute({
    sql: `INSERT INTO gorev_hafiza (task_id, baslik, birim, icerik, icerik_hash, embedding, guncelleme)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(task_id) DO UPDATE SET
            baslik=excluded.baslik, birim=excluded.birim, icerik=excluded.icerik,
            icerik_hash=excluded.icerik_hash, embedding=excluded.embedding, guncelleme=excluded.guncelleme`,
    args: [task.id, task.title || null, task.birim || null, icerik, h, JSON.stringify(emb), nowStr()]
  });
  return true;
}

// ---- Semantik arama (asistan bu fonksiyonu kullanır) ----------------------
// opt: { role, department } -> yönetici olmayan yalnızca kendi birimini görür
async function benzerGorevAra(db, sorgu, k = 3, opt = {}) {
  if (!MISTRAL_API_KEY) return [];
  if (!sorgu || !String(sorgu).trim()) return [];

  const qEmb = await embedText(sorgu);

  let sql = `SELECT task_id, baslik, birim, icerik, embedding FROM gorev_hafiza`;
  const args = [];
  const adminRoller = ['ADMIN', 'HR'];
  if (opt.role && !adminRoller.includes(opt.role) && opt.department) {
    sql += ` WHERE birim = ? OR birim IS NULL`; args.push(opt.department);
  }
  const r = await db.execute({ sql, args });

  const skorlu = [];
  for (const row of r.rows) {
    let emb; try { emb = JSON.parse(row.embedding); } catch (e) { continue; }
    const skor = kosinus(qEmb, emb);
    skorlu.push({ taskId: row.task_id, baslik: row.baslik, birim: row.birim, icerik: row.icerik, skor });
  }
  skorlu.sort((a, b) => b.skor - a.skor);
  // Çok alakasızları ele (eşik), en iyi k tanesini döndür
  return skorlu.filter(x => x.skor > 0.35).slice(0, k)
    .map(x => ({ taskId: x.taskId, baslik: x.baslik, ozet: x.icerik.slice(0, 600), benzerlik: Number(x.skor.toFixed(3)) }));
}

// ---- Arka plan indeksleyici (yeni/değişen görevleri periyodik indeksler) --
let _indexerBasladi = false;
function startRagIndexer(db, { aralikMs = 5 * 60 * 1000, partiBoyutu = 8 } = {}) {
  if (_indexerBasladi || !MISTRAL_API_KEY) return;
  _indexerBasladi = true;

  const tick = async () => {
    try {
      // Görevleri + atanan birimini al; indekssiz veya içeriği değişmiş olanları güncelle
      const r = await db.execute(`
        SELECT tasks.id, tasks.title, tasks.description, tasks.category, tasks.review_comment,
               tasks.is_plani, u.department AS birim,
               gm.icerik_hash AS mevcut_hash
        FROM tasks
        LEFT JOIN users u ON u.id = tasks.assigned_to
        LEFT JOIN gorev_hafiza gm ON gm.task_id = tasks.id
        ORDER BY tasks.id DESC
        LIMIT 300
      `);
      let islenen = 0;
      for (const t of r.rows) {
        if (islenen >= partiBoyutu) break; // her turda sınırlı sayıda (rate limit dostu)
        const icerik = gorevIcerigiKur(t);
        if (!icerik.trim()) continue;
        if (t.mevcut_hash && t.mevcut_hash === hashla(icerik)) continue; // değişmemiş
        try { await gorevIndexle(db, t); islenen++; }
        catch (e) { console.error('RAG indeks hatası (task ' + t.id + '):', e.message); }
      }
      if (islenen) console.log(`🧠 RAG: ${islenen} görev indekslendi/güncellendi.`);
    } catch (e) {
      console.error('RAG indexer tick hatası:', e.message);
    }
  };

  setTimeout(tick, 15000);          // sunucu kalktıktan 15 sn sonra ilk tur
  setInterval(tick, aralikMs);      // sonra periyodik
}

// ---- Router (manuel yeniden indeksleme + hata ayıklama araması) -----------
function createRagRouter(db, { isAdmin }) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!MISTRAL_API_KEY) return res.status(503).json({ error: 'Embedding servisi yapılandırılmamış (MISTRAL_API_KEY yok).' });
    next();
  });

  // Tüm görevleri (yeniden) indeksle — yalnızca admin/İK
  router.post('/rag/yeniden-indexle', async (req, res) => {
    try {
      const { userRole } = req.body;
      if (!isAdmin(userRole)) return res.status(403).json({ error: 'Yetkiniz yok.' });

      const r = await db.execute(`
        SELECT tasks.*, u.department AS birim
        FROM tasks LEFT JOIN users u ON u.id = tasks.assigned_to
        ORDER BY tasks.id DESC LIMIT 500
      `);
      let sayac = 0;
      for (const t of r.rows) {
        try { if (await gorevIndexle(db, t)) sayac++; }
        catch (e) { console.error('yeniden-indexle:', e.message); }
      }
      res.json({ message: `${sayac} görev indekslendi.`, toplam: r.rows.length });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Manuel semantik arama (test/hata ayıklama)
  router.post('/rag/ara', async (req, res) => {
    try {
      const { sorgu, role, department, k } = req.body;
      const sonuc = await benzerGorevAra(db, sorgu, Number(k) || 3, { role, department });
      res.json({ sonuc });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}

module.exports = {
  initRagSchema, createRagRouter, startRagIndexer,
  benzerGorevAra, gorevIndexle, embedText
};
