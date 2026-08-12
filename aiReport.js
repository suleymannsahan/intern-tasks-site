// aiReport.js
// ============================================================
// ÖZELLİK 5 — OTOMATİK GÜNLÜK/HAFTALIK ÖZET (Executive Summary)
//
// İki yol sağlar:
//   1) Anlık: aiAgent.js içinden "yonetici_ozeti" aracıyla veya /api/rapor/olustur
//      ucuyla, yönetici istediğinde özet üretir.
//   2) Otomatik: startReportScheduler() ile her iş günü sabahı özet üretip
//      yöneticilere bildirim (+ opsiyonel e-posta) gönderir.
//
// node-cron GEREKMEZ: bağımsız setInterval tabanlı hafif zamanlayıcı kullanılır.
//
// Kullanım (server.js):
//   const aiReport = require('./aiReport');
//   app.use('/api', aiReport.createReportRouter(db, { isAdmin }));
//   aiReport.startReportScheduler(db, { isAdmin, sendDetailsEmail, createNotification });
// ============================================================

const express = require('express');

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const MISTRAL_MODEL = process.env.MISTRAL_MODEL || 'mistral-large-latest';
const RAPOR_SAATI = Number(process.env.REPORT_HOUR || 8);   // iş günü sabahı (TR saati)
const RAPOR_DAKIKA = Number(process.env.REPORT_MINUTE || 0);

function turkiyeSimdi() { return new Date(Date.now() + 3 * 60 * 60 * 1000); }
function bugunISO() { return turkiyeSimdi().toISOString().split('T')[0]; }

async function mistralChat(messages, temperature = 0.3) {
  const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${MISTRAL_API_KEY}` },
    body: JSON.stringify({ model: MISTRAL_MODEL, messages, temperature })
  });
  if (!r.ok) throw new Error('Yapay zekâ servisi yanıt vermedi (' + r.status + ').');
  const data = await r.json();
  return ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
}

// ============================================================
// Panonun anlık görüntüsünü (metrikleri) toplar. department verilirse o birime daraltır.
// ============================================================
async function panoVerisiTopla(db, { department } = {}) {
  const bugun = bugunISO();
  const args = [];
  let birimKosulu = '';
  if (department) { birimKosulu = ` AND u.department = ?`; }

  // Durum dağılımı
  const durumSql = `
    SELECT tasks.status AS durum, COUNT(*) AS adet
    FROM tasks LEFT JOIN users u ON u.id = tasks.assigned_to
    WHERE 1=1 ${birimKosulu}
    GROUP BY tasks.status`;
  const durumRes = await db.execute({ sql: durumSql, args: department ? [department] : [] });
  const durumlar = {};
  durumRes.rows.forEach(r => { durumlar[r.durum] = Number(r.adet); });

  // Onay bekleyenler (COMPLETED)
  const onaySql = `
    SELECT tasks.title, u.name AS atanan
    FROM tasks LEFT JOIN users u ON u.id = tasks.assigned_to
    WHERE tasks.status = 'COMPLETED' ${birimKosulu}
    ORDER BY tasks.id DESC LIMIT 20`;
  const onayRes = await db.execute({ sql: onaySql, args: department ? [department] : [] });

  // Gecikenler (bitiş < bugün ve onaylanmamış)
  const gecikSql = `
    SELECT tasks.title, tasks.end_date, u.name AS atanan
    FROM tasks LEFT JOIN users u ON u.id = tasks.assigned_to
    WHERE tasks.status != 'APPROVED' AND tasks.end_date < ? ${birimKosulu}
    ORDER BY tasks.end_date ASC LIMIT 20`;
  const gecikRes = await db.execute({ sql: gecikSql, args: department ? [bugun, department] : [bugun] });

  return {
    bugun,
    birim: department || 'Tümü',
    devamEden: durumlar['IN_PROGRESS'] || 0,
    onayBekleyen: durumlar['COMPLETED'] || 0,
    onaylanan: durumlar['APPROVED'] || 0,
    revizeIstenen: durumlar['REVISION_REQUESTED'] || 0,
    onayListesi: onayRes.rows.map(r => `${r.title} (${r.atanan || '?'})`),
    gecikmeListesi: gecikRes.rows.map(r => `${r.title} — ${r.atanan || '?'}, son teslim ${r.end_date}`)
  };
}

// ============================================================
// Metrikleri yöneticiye uygun kısa Türkçe özete çevirir.
// ============================================================
async function ozetUret(db, { department, kapsam = 'gunluk' } = {}) {
  const v = await panoVerisiTopla(db, { department });

  const kapsamTR = kapsam === 'haftalik' ? 'haftalık' : 'günlük';
  const veriMetni =
`Birim: ${v.birim}
Devam eden görev: ${v.devamEden}
Onay bekleyen: ${v.onayBekleyen}
Onaylanan: ${v.onaylanan}
Revize istenen: ${v.revizeIstenen}
Onay bekleyen görevler: ${v.onayListesi.length ? v.onayListesi.join('; ') : 'yok'}
Geciken görevler: ${v.gecikmeListesi.length ? v.gecikmeListesi.join('; ') : 'yok'}`;

  const sistem = `Sen bir proje yönetimi asistanısın. Aşağıdaki ${kapsamTR} panodan yöneticiye
KISA bir yönetici özeti yaz. Kurallar:
- SADECE Türkçe. Markdown/işaret (*, #, **) KULLANMA.
- En fazla 4-5 cümle. Önce genel durum, sonra dikkat gerektiren noktalar (gecikme/onay).
- Sayıları uydurma; yalnızca verilenleri kullan. Abartma, sakin ve net bir dil kullan.`;

  const icerik = await mistralChat(
    [{ role: 'system', content: sistem }, { role: 'user', content: veriMetni }], 0.3
  );
  return { ozet: icerik || 'Özet üretilemedi.', veriler: v };
}

// ============================================================
// Router: anlık rapor üretimi (yönetici butonundan da çağrılabilir)
// ============================================================
function createReportRouter(db, { isAdmin }) {
  const router = express.Router();
  const YONETICI = (role) => isAdmin(role) || role === 'MANAGER' || role === 'LEADER';

  router.use((req, res, next) => {
    if (!MISTRAL_API_KEY) return res.status(503).json({ error: 'Yapay zeka yapılandırılmamış (MISTRAL_API_KEY yok).' });
    next();
  });

  // POST /api/rapor/olustur  { userRole, department?, kapsam? }
  router.post('/rapor/olustur', async (req, res) => {
    try {
      const { userRole, department, kapsam } = req.body;
      if (!YONETICI(userRole)) return res.status(403).json({ error: 'Rapor oluşturma yetkiniz yok.' });
      // Admin/İK tümünü görür; Müdür/Lider yalnızca kendi birimini
      const kapsamBirim = isAdmin(userRole) ? (department || null) : (department || null);
      const sonuc = await ozetUret(db, { department: kapsamBirim, kapsam });
      res.json(sonuc);
    } catch (error) {
      res.status(500).json({ error: 'Rapor üretilemedi: ' + error.message });
    }
  });

  return router;
}

// ============================================================
// Otomatik zamanlayıcı: her iş günü RAPOR_SAATI'nde bir kez çalışır.
// Bağımlılık gerektirmez; dakikada bir kontrol eder.
// ============================================================
let _schedulerBasladi = false;
function startReportScheduler(db, { isAdmin, sendDetailsEmail, createNotification } = {}) {
  if (_schedulerBasladi || !MISTRAL_API_KEY) return;
  _schedulerBasladi = true;

  let sonCalismaGunu = null; // aynı gün ikinci kez çalışmasın (bellekte)

  const tick = async () => {
    try {
      const now = turkiyeSimdi();
      const gun = now.getUTCDay();          // 0=Paz, 6=Cmt
      const saat = now.getUTCHours();
      const dakika = now.getUTCMinutes();
      const gunISO = now.toISOString().split('T')[0];

      if (gun === 0 || gun === 6) return;                       // hafta sonu atla
      if (saat !== RAPOR_SAATI || dakika < RAPOR_DAKIKA || dakika > RAPOR_DAKIKA + 4) return;
      if (sonCalismaGunu === gunISO) return;                    // bugün zaten çalıştı
      sonCalismaGunu = gunISO;

      // Alıcılar: onaylı yöneticiler
      const alicilar = await db.execute(`
        SELECT id, name, email, role, department FROM users
        WHERE status = 'APPROVED' AND role IN ('ADMIN','HR','MANAGER','LEADER')`);

      for (const y of alicilar.rows) {
        // Admin/İK genel; Müdür/Lider kendi birimi
        const dep = (y.role === 'MANAGER' || y.role === 'LEADER') ? y.department : null;
        let sonuc;
        try { sonuc = await ozetUret(db, { department: dep, kapsam: 'gunluk' }); }
        catch (e) { console.error('Otomatik özet üretilemedi:', e.message); continue; }

        // Panele bildirim
        if (typeof createNotification === 'function') {
          await createNotification(y.id, 'AI_REPORT', 'TASKS', 'Günlük Özet', sonuc.ozet, null)
            .catch(e => console.error('Rapor bildirimi:', e.message));
        }
        // E-posta (opsiyonel)
        if (typeof sendDetailsEmail === 'function' && y.email) {
          const v = sonuc.veriler;
          await sendDetailsEmail(
            y.email, y.name, 'Günlük Özet', 'Günlük Yönetici Özeti',
            sonuc.ozet,
            [
              ['Devam Eden', String(v.devamEden)],
              ['Onay Bekleyen', String(v.onayBekleyen)],
              ['Geciken', String(v.gecikmeListesi.length)],
              ['Birim', v.birim]
            ],
            'Panele Git'
          ).catch(e => console.error('Rapor e-postası:', e.message));
        }
      }
      console.log(`📊 Otomatik günlük özet gönderildi (${gunISO}, ${alicilar.rows.length} yönetici).`);
    } catch (e) {
      console.error('Rapor zamanlayıcı hatası:', e.message);
    }
  };

  setInterval(tick, 60 * 1000); // dakikada bir kontrol
  console.log(`⏰ Rapor zamanlayıcı aktif (her iş günü ${String(RAPOR_SAATI).padStart(2,'0')}:${String(RAPOR_DAKIKA).padStart(2,'0')} TR).`);
}

module.exports = { createReportRouter, startReportScheduler, ozetUret, panoVerisiTopla };
