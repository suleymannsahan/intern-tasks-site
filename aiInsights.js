// aiInsights.js
// ============================================================
// ÖZELLİK 2 — RİSK & DARBOĞAZ ERKEN UYARI
// ÖZELLİK 3 — AKILLI İŞ YÜKÜ & PERSONEL ATAMA ÖNERİSİ
//
// İkisi de aynı geçmiş-performans sorgularını paylaştığı için tek modülde toplandı.
// Hesaplar DETERMİNİSTİKtir (SQL + JS); doğal dile çevirmeyi asistan (aiAgent) yapar.
// Böylece hem hızlı/ucuz hem de test edilebilir.
//
// Kaynak veriler (hazır): asama_gecmisi (tahmini vs gerçek süre), tasks.is_plani (aşama
// takvimi + durum), aktif görev sayıları. Kişi performansı için asama_gecmisi.kaydeden
// yerine task_id -> tasks.assigned_to join'i kullanılır (gerçek yapan kişi).
//
// Kullanım (server.js):
//   const aiInsights = require('./aiInsights');
//   app.use('/api', aiInsights.createInsightsRouter(db, { isAdmin }));
//   aiInsights.startRiskScheduler(db);   // arka planda risk uyarısı üretir (bildirime yazar)
//
// aiAgent.js: riskTara() ve atamaOnerisi() fonksiyonlarını okuma aracı olarak kullanır.
// ============================================================

const express = require('express');

const RISK_ESIK = Number(process.env.RISK_THRESHOLD || 0.7); // aşama süresinin %70'i
const MIN_GECMIS = Number(process.env.RISK_MIN_HISTORY || 3); // güvenilir sarkma için min kayıt

const ATANABILIR_ROLLER = ['INTERN', 'TECHNICIAN', 'ENGINEER', 'LEADER'];
const AKTIF_DURUMLAR = ['IN_PROGRESS', 'COMPLETED', 'REVISION_REQUESTED'];

function turkiyeSimdi() { return new Date(Date.now() + 3 * 60 * 60 * 1000); }
function bugunISO() { return turkiyeSimdi().toISOString().split('T')[0]; }
function parseTR(s) { const [g, a, y] = String(s).split('.').map(Number); return new Date(y, a - 1, g); }
function gunFarki(a, b) { return Math.round((b - a) / 86400000); }

// ============================================================
// ORTAK: kişi bazında aşama performansı (gerçek/tahmini oranı = sarkma katsayısı)
// oran > 1 -> genelde sarkıyor, < 1 -> tahminden hızlı.
// ============================================================
async function kisiAsamaSarkmasi(db, assignedTo, asamaAdi) {
  const r = await db.execute({
    sql: `SELECT AVG(ag.gercek_gun) AS gercek, AVG(ag.tahmini_gun) AS tahmini, COUNT(*) AS adet
          FROM asama_gecmisi ag JOIN tasks t ON t.id = ag.task_id
          WHERE t.assigned_to = ? AND ag.asama_adi = ? AND ag.tahmini_gun > 0`,
    args: [assignedTo, asamaAdi]
  });
  const row = r.rows[0] || {};
  const adet = Number(row.adet || 0);
  if (!adet || !row.tahmini) return { oran: null, adet, ortGercek: null, ortTahmini: null };
  const oran = Number(row.gercek) / Number(row.tahmini);
  return { oran, adet, ortGercek: Number(row.gercek), ortTahmini: Number(row.tahmini) };
}

// Kategori bazında kişi performansı (Özellik 3 için) — istenirse belirli aşamaya daraltılır
async function kategoriPerformansi(db, kategori, asamaAdi) {
  let sql = `SELECT t.assigned_to AS uid,
                    AVG(ag.gercek_gun) AS gercek, AVG(ag.tahmini_gun) AS tahmini, COUNT(*) AS adet
             FROM asama_gecmisi ag JOIN tasks t ON t.id = ag.task_id
             WHERE ag.tahmini_gun > 0`;
  const args = [];
  if (kategori != null && kategori !== '') { sql += ` AND ag.kategori = ?`; args.push(kategori); }
  if (asamaAdi) { sql += ` AND ag.asama_adi = ?`; args.push(asamaAdi); }
  sql += ` GROUP BY t.assigned_to`;
  const r = await db.execute({ sql, args });
  const map = {};
  r.rows.forEach(row => {
    const oran = (row.tahmini > 0) ? Number(row.gercek) / Number(row.tahmini) : null;
    map[row.uid] = { oran, adet: Number(row.adet || 0) };
  });
  return map;
}

// Aktif görev sayıları (kişi -> adet)
async function aktifIsYuku(db, department) {
  let sql = `SELECT users.id AS uid, COUNT(tasks.id) AS adet
             FROM users LEFT JOIN tasks ON tasks.assigned_to = users.id
                  AND tasks.status IN ('IN_PROGRESS','COMPLETED','REVISION_REQUESTED')
             WHERE users.status = 'APPROVED' AND users.role IN ('INTERN','TECHNICIAN','ENGINEER','LEADER')`;
  const args = [];
  if (department) { sql += ` AND users.department = ?`; args.push(department); }
  sql += ` GROUP BY users.id`;
  const r = await db.execute({ sql, args });
  const map = {};
  r.rows.forEach(row => { map[row.uid] = Number(row.adet || 0); });
  return map;
}

// ============================================================
// ÖZELLİK 2 — RİSK TARAMASI
// Aktif aşamada süre %70+ dolduysa ve kişi genelde sarkıyorsa uyarı üretir.
// ============================================================
async function riskTara(db, { department } = {}) {
  const bugun = turkiyeSimdi(); bugun.setHours(0, 0, 0, 0);

  let sql = `SELECT tasks.id, tasks.title, tasks.category, tasks.is_plani, tasks.assigned_to,
                    u.name AS atanan, u.department AS birim
             FROM tasks LEFT JOIN users u ON u.id = tasks.assigned_to
             WHERE tasks.is_plani IS NOT NULL AND tasks.status != 'APPROVED'`;
  const args = [];
  if (department) { sql += ` AND u.department = ?`; args.push(department); }
  const r = await db.execute({ sql, args });

  const riskler = [];
  for (const task of r.rows) {
    let plan; try { plan = JSON.parse(task.is_plani); } catch (e) { continue; }
    if (!plan || !Array.isArray(plan.adimlar)) continue;

    // Aktif (çalışılan) aşama: önceki bittiyse ve bu aşama bitmemiş/onay beklemiyorsa
    let aktifIndex = -1;
    for (let i = 0; i < plan.adimlar.length; i++) {
      const a = plan.adimlar[i];
      const oncekiBitti = (i === 0) || (plan.adimlar[i - 1] && plan.adimlar[i - 1].durum === 'bitti');
      if (!oncekiBitti) break;
      if (a.durum === 'bitti') continue;
      if (a.durum === 'onay_bekliyor') { aktifIndex = -1; break; } // onaya gitmiş, zaman riski yok
      aktifIndex = i; break;
    }
    if (aktifIndex === -1) continue;

    const a = plan.adimlar[aktifIndex];
    let bas, bit;
    try { bas = parseTR(a.baslangic); bit = parseTR(a.bitis); } catch (e) { continue; }
    const toplam = Math.max(1, gunFarki(bas, bit));
    const gecen = gunFarki(bas, bugun);
    const oran = gecen / toplam;
    if (oran < RISK_ESIK) continue; // henüz risk eşiğine gelmemiş

    // Kişinin bu aşamadaki geçmiş sarkması
    const gecmis = task.assigned_to ? await kisiAsamaSarkmasi(db, task.assigned_to, a.ad) : { oran: null, adet: 0 };
    const kalanGun = gunFarki(bugun, bit); // negatifse süre dolmuş

    // Önerilen uzatma: geçmiş sarkmaya göre; veri yoksa eşik/kalan duruma göre küçük tampon
    let onerilenEk = 0, gecmisNot = '';
    if (gecmis.oran && gecmis.adet >= MIN_GECMIS && gecmis.oran > 1.05) {
      onerilenEk = Math.max(1, Math.ceil((gecmis.oran - 1) * toplam));
      const sarkmaGun = Math.round((gecmis.oran - 1) * (gecmis.ortTahmini || toplam) * 10) / 10;
      gecmisNot = `Geçmiş verilerine göre "${a.ad}" adımları ortalama ${sarkmaGun} gün sarkıyor.`;
    } else if (kalanGun <= 0) {
      onerilenEk = 2; // süre dolmuş, hareket yok
    } else {
      onerilenEk = 1;
    }

    const seviye = (gecmis.oran && gecmis.oran > 1.2 && gecmis.adet >= MIN_GECMIS) || kalanGun <= 0 ? 'yuksek' : 'orta';

    const zamanNot = kalanGun <= 0
      ? `"${a.ad}" aşamasının süresi doldu ancak henüz tamamlanmadı.`
      : `"${a.ad}" aşaması ${kalanGun} gün içinde bitiyor ancak henüz tamamlanmadı (sürenin %${Math.round(oran * 100)}'i geçti).`;

    riskler.push({
      taskId: task.id, gorev: task.title, atanan: task.atanan || '?', atananId: task.assigned_to,
      birim: task.birim || null, asama: a.ad, asamaIndex: aktifIndex,
      kalanGun, gecenOran: Number(oran.toFixed(2)), seviye,
      onerilenEk,
      mesaj: `${task.atanan ? task.atanan + "'in " : ''}"${task.title}" görevinde ${zamanNot} ${gecmisNot} Bitiş tarihini ${onerilenEk} gün uzatmayı değerlendirebilirsiniz.`.replace(/\s+/g, ' ').trim()
    });
  }

  // Yüksek riskler önce
  riskler.sort((x, y) => (x.seviye === y.seviye ? y.gecenOran - x.gecenOran : (x.seviye === 'yuksek' ? -1 : 1)));
  return riskler;
}

// ============================================================
// ÖZELLİK 3 — AKILLI ATAMA ÖNERİSİ
// kategori (+ opsiyonel ağırlıklı aşama) için adayları iş yükü + performansa göre sıralar.
// ============================================================
async function atamaOnerisi(db, { kategori, department, asama } = {}) {
  // Adaylar
  let sql = `SELECT id, name, role, department FROM users
             WHERE status = 'APPROVED' AND role IN ('INTERN','TECHNICIAN','ENGINEER','LEADER')`;
  const args = [];
  if (department) { sql += ` AND department = ?`; args.push(department); }
  const adayRes = await db.execute({ sql, args });
  if (!adayRes.rows.length) return { adaylar: [], not: 'Uygun aday bulunamadı.' };

  const isYuku = await aktifIsYuku(db, department);
  const perf = await kategoriPerformansi(db, kategori, asama);

  // Takım ortalaması (göreli ifadeler için)
  const aktifler = adayRes.rows.map(u => isYuku[u.id] || 0);
  const ortAktif = aktifler.reduce((t, x) => t + x, 0) / (aktifler.length || 1);

  const adaylar = adayRes.rows.map(u => {
    const aktif = isYuku[u.id] || 0;
    const p = perf[u.id] || { oran: null, adet: 0 };
    const hizVerisi = p.oran != null && p.adet >= 1;
    // Puan: düşük iş yükü + düşük sarkma daha iyi. Veri yoksa performans nötr (1.0).
    const perfPuan = hizVerisi ? p.oran : 1.0;
    const skor = aktif * 1.0 + (perfPuan - 1) * 2.0; // iş yükü + performans etkisi

    // Göreli ifadeler
    let isYukuNot = '';
    if (ortAktif > 0) {
      const fark = Math.round((1 - aktif / ortAktif) * 100);
      if (fark > 5) isYukuNot = `iş yükü ortalamadan %${fark} daha hafif`;
      else if (fark < -5) isYukuNot = `iş yükü ortalamadan %${-fark} daha yoğun`;
      else isYukuNot = 'iş yükü ortalama düzeyde';
    }
    let hizNot = '';
    if (hizVerisi) {
      const yuzde = Math.round((1 - p.oran) * 100);
      if (yuzde > 3) hizNot = `bu işleri geçmişte ortalama %${yuzde} daha hızlı bitirmiş`;
      else if (yuzde < -3) hizNot = `bu işlerde geçmişte ortalama %${-yuzde} daha yavaş`;
      else hizNot = 'geçmiş hızı ortalama düzeyde';
    } else {
      hizNot = 'bu kategoride yeterli geçmiş verisi yok';
    }

    return {
      kullaniciId: u.id, isim: u.name, rol: u.role, birim: u.department,
      aktifGorev: aktif, sarkmaKatsayisi: hizVerisi ? Number(p.oran.toFixed(2)) : null,
      gecmisKayit: p.adet, skor: Number(skor.toFixed(2)),
      gerekce: `${u.name}: ${isYukuNot}${hizNot ? ', ' + hizNot : ''}.`
    };
  });

  adaylar.sort((a, b) => a.skor - b.skor); // düşük skor = daha uygun
  return {
    kategori: kategori ?? null, asama: asama || null,
    onerilen: adaylar[0] || null,
    adaylar: adaylar.slice(0, 5)
  };
}

// ============================================================
// Router: panel açılışında/istekle çağrılabilir uçlar
// ============================================================
function createInsightsRouter(db, { isAdmin }) {
  const router = express.Router();
  const YONETICI = (role) => isAdmin(role) || role === 'MANAGER' || role === 'LEADER' || role === 'ENGINEER';

  // POST /api/risk/tara  { userRole, department? }  -> riskleri döndürür (bildirim de yazar)
  router.post('/risk/tara', async (req, res) => {
    try {
      const { userRole, department } = req.body;
      if (!YONETICI(userRole)) return res.status(403).json({ error: 'Yetkiniz yok.' });
      const dep = isAdmin(userRole) ? (department || null) : (department || null);
      const riskler = await riskTara(db, { department: dep });
      await riskBildirimleriYaz(db, riskler); // panelde görünmesi için asama_bildirimleri'ne yaz
      res.json({ riskler });
    } catch (error) {
      res.status(500).json({ error: 'Risk taraması yapılamadı: ' + error.message });
    }
  });

  // POST /api/atama/oner  { userRole, kategori, department?, asama? }
  router.post('/atama/oner', async (req, res) => {
    try {
      const { userRole, kategori, department, asama } = req.body;
      if (!['ADMIN', 'HR', 'MANAGER', 'LEADER', 'ENGINEER'].includes(userRole)) {
        return res.status(403).json({ error: 'Atama önerisi için yetkiniz yok.' });
      }
      const sonuc = await atamaOnerisi(db, { kategori, department: department || null, asama: asama || null });
      res.json(sonuc);
    } catch (error) {
      res.status(500).json({ error: 'Atama önerisi üretilemedi: ' + error.message });
    }
  });

  return router;
}

// Riskleri panel bildirimine (asama_bildirimleri) tekilleştirilmiş şekilde yazar
async function riskBildirimleriYaz(db, riskler) {
  const bugunStr = bugunISO();
  for (const r of riskler) {
    // Alıcılar: görevi veren + atanan + atananın birimindeki gözcüler (INTERN hariç) — gecikme mantığıyla aynı
    const aliciIdSet = new Set();
    if (r.atananId) {
      aliciIdSet.add(r.atananId);
      const aRes = await db.execute({ sql: `SELECT department FROM users WHERE id = ? LIMIT 1`, args: [r.atananId] });
      const birim = aRes.rows[0] && aRes.rows[0].department;
      if (birim) {
        const gozRes = await db.execute({ sql: `SELECT id FROM users WHERE department = ? AND role != 'INTERN'`, args: [birim] });
        for (const g of gozRes.rows) aliciIdSet.add(g.id);
      }
    }
    // Görevi verene de haber ver
    const tRes = await db.execute({ sql: `SELECT created_by FROM tasks WHERE id = ? LIMIT 1`, args: [r.taskId] });
    const verenAd = tRes.rows[0] && tRes.rows[0].created_by;
    if (verenAd) {
      const vRes = await db.execute({ sql: `SELECT id FROM users WHERE name = ? OR email = ? LIMIT 1`, args: [verenAd, verenAd] });
      if (vRes.rows[0]) aliciIdSet.add(vRes.rows[0].id);
    }

    const tip = `risk_${r.asamaIndex}`;
    for (const uid of aliciIdSet) {
      const varMi = await db.execute({
        sql: `SELECT id FROM asama_bildirimleri WHERE task_id = ? AND tip = ? AND user_id = ? LIMIT 1`,
        args: [r.taskId, tip, uid]
      });
      if (varMi.rows.length === 0) {
        await db.execute({
          sql: `INSERT INTO asama_bildirimleri (user_id, task_id, tip, mesaj, okundu, created_at) VALUES (?, ?, ?, ?, 0, ?)`,
          args: [uid, r.taskId, tip, '⚠️ ' + r.mesaj, bugunStr]
        });
      }
    }
  }
}

// ============================================================
// Arka plan risk zamanlayıcısı — bağımsız setInterval (node-cron gerektirmez)
// Ürettiği uyarılar mevcut bildirim panelinde otomatik görünür (asama_bildirimleri).
// ============================================================
let _riskBasladi = false;
function startRiskScheduler(db, { aralikMs = 60 * 60 * 1000 } = {}) {
  if (_riskBasladi) return;
  _riskBasladi = true;
  const tick = async () => {
    try {
      const riskler = await riskTara(db, {});          // tüm birimler
      await riskBildirimleriYaz(db, riskler);
      if (riskler.length) console.log(`⚠️ Risk taraması: ${riskler.length} olası darboğaz için uyarı yazıldı.`);
    } catch (e) { console.error('Risk zamanlayıcı hatası:', e.message); }
  };
  setTimeout(tick, 30000);      // kalkıştan 30 sn sonra ilk tarama
  setInterval(tick, aralikMs);  // sonra saatlik
  console.log('🛡️ Risk erken uyarı zamanlayıcısı aktif.');
}

module.exports = {
  createInsightsRouter, startRiskScheduler,
  riskTara, atamaOnerisi, kisiAsamaSarkmasi, kategoriPerformansi
};
