// ai.js
// ============================================================
// YAPAY ZEKA (Mistral) ÖZELLİKLERİ — server.js'ten ayrı tutulur ki ana dosya şişmesin
// ve bu bölüm izole/kolayca kapatılabilir olsun. Üç özelliği barındırır:
//   1) Akıllı İş Planı üretici: kategori + tarihe göre 6 aşamalı iş planı üretir,
//      geçmiş gerçek sürelere göre ağırlıkları otomatik ayarlar, her aşamaya AI ile
//      kısa açıklama yazar.
//   2) Görev Asistanı (chatbot): kullanıcının görebildiği görevleri bağlam alan sohbet.
//   3) Genel Asistan: kullanıcıya atanan + kendi verdiği görevleri bağlam alan sohbet.
//
// Kullanım (server.js içinde):
//   const ai = require('./ai');
//   ai.initAiSchema(db);                              // tablo/sütun migrasyonları
//   app.use('/api', ai.createAiRouter(db, { isAdmin })); // endpoint'leri bağla
//
// Gerekli ortam değişkeni: MISTRAL_API_KEY (https://console.mistral.ai). Key tanımlı
// değilse AI endpoint'leri 503 döner, uygulamanın geri kalanı bundan etkilenmez.
// ============================================================

const express = require('express');

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const MISTRAL_MODEL = process.env.MISTRAL_MODEL || 'mistral-large-latest';

function nowTurkeyLocal() {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);
}

function yabanciKarakterVar(metin) {
  // Türkçe dışı yazı sistemleri (Çince/Japonca/Korece/Kiril/Arapça) tespiti.
  // Not: İngilizce de Latin harf kullandığından karakterle ayırt edilemez.
  return /[぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯가-힯ᄀ-ᇿЀ-ӿ؀-ۿ]/.test(String(metin || ''));
}

// İş planı oluşturma/düzenleme yetkisi olan roller
const IS_PLANI_YETKILI = ['ADMIN', 'MANAGER', 'LEADER', 'ENGINEER'];

const IS_ADIMLARI = [
  { ad: 'Şematik İnceleme', yuzde: 10 },
  { ad: 'KTTD',            yuzde: 20 },
  { ad: 'BDK',             yuzde: 15 },
  { ad: 'Visio',           yuzde: 25 },
  { ad: 'Sequence',        yuzde: 20 },
  { ad: 'Entegrasyon',     yuzde: 10 }
];

function tarihFormatla(tarih) {
  const g = String(tarih.getDate()).padStart(2, '0');
  const a = String(tarih.getMonth() + 1).padStart(2, '0');
  const y = tarih.getFullYear();
  return `${g}.${a}.${y}`;
}

// Kategori + döküman + bitiş tarihine göre 6 adımı böler (opsiyonel akıllı ağırlıklarla)
function isPlaniHesapla(kategori, dokumanTarihiStr, bitisTarihiStr, agirliklar) {
  const baslangic = new Date(dokumanTarihiStr);
  const bitis = new Date(bitisTarihiStr);

  const toplamGun = Math.max(1, Math.round((bitis - baslangic) / (1000 * 60 * 60 * 24)));

  const kullanilacak = (agirliklar && agirliklar.length === IS_ADIMLARI.length)
    ? agirliklar
    : IS_ADIMLARI.map(a => ({ ad: a.ad, yuzde: a.yuzde }));

  let imlecTarih = new Date(baslangic);
  const adimlar = [];

  kullanilacak.forEach((adim) => {
    const adimGun = Math.round(toplamGun * adim.yuzde / 100);
    const adimBaslangic = new Date(imlecTarih);
    const adimBitis = new Date(imlecTarih);
    adimBitis.setDate(adimBitis.getDate() + adimGun);

    adimlar.push({
      ad: adim.ad,
      baslangic: tarihFormatla(adimBaslangic),
      bitis: tarihFormatla(adimBitis),
      gun: adimGun,
      kaynak: adim.kaynak || 'varsayilan',
      gecmisAdet: adim.gecmisAdet || 0
    });

    imlecTarih = new Date(adimBitis);
  });

  return {
    baslangic: tarihFormatla(baslangic),
    bitis: tarihFormatla(bitis),
    toplamGun,
    adimlar
  };
}

// Veritabanı sütunları/tabloları — güvenli (var olanı bozmayan) migrasyon.
// NOT: mevcut "notifications" tablosuna DOKUNULMAZ; AI bildirimleri ayrı tabloda tutulur.
async function initAiSchema(db) {
  try { await db.execute(`ALTER TABLE tasks ADD COLUMN start_date TEXT`); } catch (e) {}
  try { await db.execute(`ALTER TABLE tasks ADD COLUMN is_plani TEXT`); } catch (e) {}
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS asama_gecmisi (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        asama_adi TEXT NOT NULL,
        kategori INTEGER,
        tahmini_gun INTEGER,
        gercek_gun INTEGER,
        baslangic TEXT,
        bitis TEXT,
        kaydeden TEXT,
        created_at TEXT NOT NULL
      )
    `);
  } catch (e) { console.log('asama_gecmisi:', e.message); }
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS asama_bildirimleri (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        task_id INTEGER,
        tip TEXT,
        mesaj TEXT NOT NULL,
        okundu INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `);
  } catch (e) { console.log('asama_bildirimleri:', e.message); }
}

function createAiRouter(db, { isAdmin }) {
  const router = express.Router();

  // Mistral API key yoksa AI endpoint'lerini açıkça 503 ile bilgilendir (sistemin geri
  // kalanını bozmadan, "neden çalışmıyor" sorusuna net cevap vermek için).
  router.use((req, res, next) => {
    if (!MISTRAL_API_KEY) {
      return res.status(503).json({ error: 'Yapay zeka özellikleri yapılandırılmamış (MISTRAL_API_KEY tanımlı değil).' });
    }
    next();
  });

  async function mistralChat(messages, temperature = 0.4) {
    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MISTRAL_API_KEY}`
      },
      body: JSON.stringify({ model: MISTRAL_MODEL, messages, temperature })
    });
    if (!response.ok) throw new Error('Yapay zekâ servisi yanıt vermedi (' + response.status + ').');
    const data = await response.json();
    return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content ? data.choices[0].message.content : '').trim();
  }

  // mistralChat'in Türkçe-güvenceli sürümü: yanıt Türkçe dışı karakter içeriyorsa
  // daha katı bir uyarıyla bir kez daha dener.
  async function mistralChatTR(messages, temperature = 0.4, maxDeneme = 2) {
    let cevap = '';
    for (let d = 0; d < maxDeneme; d++) {
      const msgs = d === 0 ? messages
        : messages.concat([{ role: 'system', content: 'ÖNEMLİ: Yanıtın TAMAMEN Türkçe olmalı. Çince, Japonca, Kiril vb. Türkçe dışı hiçbir karakter kullanma.' }]);
      cevap = await mistralChat(msgs, temperature);
      if (!yabanciKarakterVar(cevap)) return cevap;
    }
    return cevap;
  }

  // Geçmiş gerçek verilere göre akıllı ağırlık (5+ kayıt varsa gerçek ortalama)
  async function akilliAgirliklarHesapla(kategori) {
    const ESIK = 5;
    const ortalamalar = {};
    for (const adim of IS_ADIMLARI) {
      let row = { ort: null, adet: 0 };
      try {
        const r = await db.execute({
          sql: `SELECT AVG(gercek_gun) as ort, COUNT(*) as adet
                FROM asama_gecmisi WHERE asama_adi = ? AND kategori = ?`,
          args: [adim.ad, kategori]
        });
        row = r.rows[0] || row;
      } catch (e) { /* tablo henüz boş/yok olabilir */ }
      ortalamalar[adim.ad] = { ortalama: row.ort ? Number(row.ort) : null, adet: Number(row.adet || 0) };
    }

    const efektif = IS_ADIMLARI.map(adim => {
      const g = ortalamalar[adim.ad];
      if (g.ortalama !== null && g.adet >= ESIK) {
        return { ad: adim.ad, puan: g.ortalama, kaynak: 'gercek', adet: g.adet };
      }
      return { ad: adim.ad, puan: adim.yuzde, kaynak: 'varsayilan', adet: g.adet };
    });

    const toplamPuan = efektif.reduce((t, e) => t + e.puan, 0);
    return efektif.map(e => ({
      ad: e.ad,
      yuzde: (e.puan / toplamPuan) * 100,
      kaynak: e.kaynak,
      gecmisAdet: e.adet,
      gecmisOrtalama: ortalamalar[e.ad].ortalama
    }));
  }

  // 1) İş planı üret + her aşamaya AI ile tek cümlelik açıklama yaz
  router.post('/is-plani', async (req, res) => {
    try {
      const { kartIsmi, kategori, dokumanTarihi, bitisTarihi, userRole } = req.body;

      if (!IS_PLANI_YETKILI.includes(userRole)) {
        return res.status(403).json({ error: 'İş planı oluşturma yetkiniz yok.' });
      }
      if (!kartIsmi || !kategori || !dokumanTarihi || !bitisTarihi) {
        return res.status(400).json({ error: 'Kart ismi, kategori, döküman ve bitiş tarihi gereklidir.' });
      }

      const agirliklar = await akilliAgirliklarHesapla(Number(kategori));
      const plan = isPlaniHesapla(Number(kategori), dokumanTarihi, bitisTarihi, agirliklar);

      const gecmisNotlari = plan.adimlar
        .filter(a => a.kaynak === 'gercek' && a.gecmisAdet > 0)
        .map(a => `${a.ad}: geçmişte ortalama ${a.gun} gün sürmüş (${a.gecmisAdet} kayıt)`)
        .join('\n');
      const gecmisBolumu = gecmisNotlari
        ? `\nGEÇMİŞ VERİLER (dikkate al):\n${gecmisNotlari}\n` : '';

      const prompt = `Sen bir proje mühendisliği asistanısın. "${kartIsmi}" adlı iş için aşağıdaki aşamaların her birine, o aşamada ne yapılacağını anlatan TEK cümlelik kısa bir açıklama yaz.

ÇOK ÖNEMLİ KURALLAR:
- SADECE Türkçe yaz. Kesinlikle Çince, İngilizce veya başka bir dil kullanma.
- Her açıklama en fazla 15 kelime olsun.
- Markdown veya işaret kullanma.
${gecmisBolumu}
Aşamalar: ${plan.adimlar.map(a => a.ad).join(', ')}

SADECE şu formatta, her aşama için bir satır:
${plan.adimlar.map(a => `${a.ad}: <açıklama>`).join('\n')}`;

      let aciklamalar = {};
      const MAX_ACIKLAMA_DENEME = 3;
      for (let deneme = 0; deneme < MAX_ACIKLAMA_DENEME; deneme++) {
        try {
          const ekUyari = deneme === 0 ? ''
            : '\n\nUYARI: Önceki denemede Türkçe olmayan karakterler vardı. Yanıtın TAMAMEN Türkçe olsun; başka hiçbir dil/karakter kullanma.';
          const metin = await mistralChat([{ role: 'user', content: prompt + ekUyari }], 0.3);
          const parsed = {};
          metin.split('\n').forEach(satir => {
            const idx = satir.indexOf(':');
            if (idx > -1) {
              parsed[satir.slice(0, idx).trim()] = satir.slice(idx + 1).trim();
            }
          });
          aciklamalar = parsed;
          const bozukVar = Object.values(parsed).some(v => yabanciKarakterVar(v));
          if (!bozukVar) break; // hepsi Türkçe → tamam
        } catch (aiErr) {
          console.error('AI açıklama hatası:', aiErr.message);
          break; // servis hatasında tekrar deneme
        }
      }
      // Türkçe dışı kalan açıklamaları göstermektense boş bırak
      Object.keys(aciklamalar).forEach(k => {
        if (yabanciKarakterVar(aciklamalar[k])) aciklamalar[k] = '';
      });

      plan.adimlar = plan.adimlar.map(adim => ({ ...adim, aciklama: aciklamalar[adim.ad] || '' }));

      res.json({ kartIsmi, kategori: Number(kategori), ...plan });
    } catch (error) {
      res.status(500).json({ error: 'İş planı üretilemedi: ' + error.message });
    }
  });

  // 2) Planı görevin is_plani sütununa kaydet
  router.post('/tasks/:id/is-plani-kaydet', async (req, res) => {
    try {
      const { plan, userRole } = req.body;
      if (!IS_PLANI_YETKILI.includes(userRole)) {
        return res.status(403).json({ error: 'İş planı kaydetme yetkiniz yok.' });
      }
      await db.execute({
        sql: `UPDATE tasks SET is_plani = ? WHERE id = ?`,
        args: [JSON.stringify(plan), req.params.id]
      });
      res.json({ message: 'İş planı kaydedildi.' });
    } catch (error) {
      res.status(500).json({ error: 'İş planı kaydedilemedi: ' + error.message });
    }
  });

  // 3) Görevin iş planını sil (geçmiş verilere DOKUNMAZ)
  router.post('/tasks/:id/is-plani-sil', async (req, res) => {
    try {
      const { userRole } = req.body;
      if (!IS_PLANI_YETKILI.includes(userRole)) {
        return res.status(403).json({ error: 'İş planı silme yetkiniz yok.' });
      }
      await db.execute({
        sql: `UPDATE tasks SET is_plani = NULL WHERE id = ?`,
        args: [req.params.id]
      });
      res.json({ message: 'İş planı sıfırlandı.' });
    } catch (error) {
      res.status(500).json({ error: 'İş planı sıfırlanamadı: ' + error.message });
    }
  });

  // 4) Planı güncelle: biten aşamalar korunur, kalanlar yeni bitişe göre yeniden hesaplanır
  router.post('/tasks/:id/is-plani-guncelle', async (req, res) => {
    try {
      const { yeniBitis, userRole } = req.body;
      if (!IS_PLANI_YETKILI.includes(userRole)) {
        return res.status(403).json({ error: 'İş planı güncelleme yetkiniz yok.' });
      }
      if (!yeniBitis) return res.status(400).json({ error: 'Yeni bitiş tarihi gereklidir.' });

      const taskResult = await db.execute({ sql: `SELECT * FROM tasks WHERE id = ?`, args: [req.params.id] });
      const task = taskResult.rows[0];
      if (!task || !task.is_plani) return res.status(404).json({ error: 'Görev veya iş planı bulunamadı.' });

      const plan = JSON.parse(task.is_plani);

      const parseTR = (s) => { const [g, a, y] = s.split('.').map(Number); return new Date(y, a - 1, g); };
      const fmt = (d) => {
        const g = String(d.getDate()).padStart(2, '0');
        const a = String(d.getMonth() + 1).padStart(2, '0');
        return `${g}.${a}.${d.getFullYear()}`;
      };

      const bitenler = plan.adimlar.filter(a => a.durum === 'bitti');
      const kalanlar = plan.adimlar.filter(a => a.durum !== 'bitti');

      if (kalanlar.length === 0) {
        return res.status(400).json({ error: 'Tüm aşamalar tamamlanmış, güncellenecek aşama yok.' });
      }

      let baslangic;
      if (bitenler.length > 0) {
        baslangic = parseTR(bitenler[bitenler.length - 1].bitis);
      } else {
        baslangic = parseTR(plan.adimlar[0].baslangic);
      }

      const bitis = new Date(yeniBitis);
      if (bitis <= baslangic) {
        return res.status(400).json({ error: 'Yeni bitiş tarihi, tamamlanan son aşamanın bitişinden sonra olmalı.' });
      }

      const kalanToplamGun = Math.max(1, Math.round((bitis - baslangic) / (1000 * 60 * 60 * 24)));
      const kalanYuzdeToplam = kalanlar.reduce((t, a) => {
        const def = IS_ADIMLARI.find(x => x.ad === a.ad);
        return t + (def ? def.yuzde : 0);
      }, 0) || 1;

      let imlec = new Date(baslangic);
      const yeniKalanlar = kalanlar.map(a => {
        const def = IS_ADIMLARI.find(x => x.ad === a.ad);
        const oran = def ? def.yuzde : 0;
        const gun = Math.round(kalanToplamGun * oran / kalanYuzdeToplam);
        const bas = new Date(imlec);
        const bit = new Date(imlec);
        bit.setDate(bit.getDate() + gun);
        imlec = new Date(bit);
        return { ...a, baslangic: fmt(bas), bitis: fmt(bit), gun };
      });

      const yeniAdimlar = plan.adimlar.map(a => {
        if (a.durum === 'bitti') return a;
        return yeniKalanlar.find(k => k.ad === a.ad) || a;
      });

      plan.adimlar = yeniAdimlar;
      plan.bitis = fmt(bitis);
      const planBas = parseTR(plan.adimlar[0].baslangic);
      plan.toplamGun = Math.max(1, Math.round((bitis - planBas) / (1000 * 60 * 60 * 24)));

      await db.execute({ sql: `UPDATE tasks SET is_plani = ? WHERE id = ?`, args: [JSON.stringify(plan), req.params.id] });
      res.json({ message: 'İş planı güncellendi.', plan });
    } catch (error) {
      res.status(500).json({ error: 'İş planı güncellenemedi: ' + error.message });
    }
  });

  // 5) Aşama durumu: bitir (onay bekliyor) / onayla (bitti + geçmişe yaz) / reddet (devam)
  router.post('/tasks/:id/asama-durum', async (req, res) => {
    try {
      const taskId = req.params.id;
      const { asamaIndex, islem, kullanici, userId, userRole, gercekBaslangic, gercekBitis } = req.body;

      const taskResult = await db.execute({ sql: `SELECT * FROM tasks WHERE id = ?`, args: [taskId] });
      const task = taskResult.rows[0];
      if (!task || !task.is_plani) {
        return res.status(404).json({ error: 'Görev veya iş planı bulunamadı.' });
      }

      const plan = JSON.parse(task.is_plani);
      const asama = plan.adimlar[asamaIndex];
      if (!asama) return res.status(400).json({ error: 'Geçersiz aşama.' });

      const bugun = new Date().toISOString().split('T')[0];
      const yoneticiRol = ['ADMIN', 'MANAGER', 'LEADER'].includes(userRole);
      const onaylayabilir = (kullanici && task.created_by && kullanici === task.created_by) || yoneticiRol;

      if (islem === 'bitir') {
        if (Number(userId) !== Number(task.assigned_to)) {
          return res.status(403).json({ error: 'Bu aşamayı yalnızca göreve atanan kişi tamamlayabilir.' });
        }
        let bekBas = gercekBaslangic;
        if (!bekBas) { const [g, a, y] = asama.baslangic.split('.'); bekBas = `${y}-${a}-${g}`; }
        asama.durum = 'onay_bekliyor';
        asama.bekleyenBaslangic = bekBas;
        asama.bekleyenBitis = gercekBitis || bugun;
        asama.talepEden = kullanici || null;

        try {
          const hedef = await db.execute({
            sql: `SELECT id FROM users WHERE name = ? OR email = ? LIMIT 1`,
            args: [task.created_by, task.created_by]
          });
          const hedefId = hedef.rows[0] && hedef.rows[0].id;
          if (hedefId) {
            await db.execute({
              sql: `INSERT INTO asama_bildirimleri (user_id, task_id, tip, mesaj, okundu, created_at) VALUES (?, ?, ?, ?, 0, ?)`,
              args: [hedefId, taskId, 'asama_onay',
                `"${task.title}" görevinde "${asama.ad}" aşaması tamamlandı, onayınızı bekliyor.`, bugun]
            });
          }
        } catch (e) { console.error('Onay bildirimi hatası:', e.message); }

      } else if (islem === 'onayla') {
        if (!onaylayabilir) return res.status(403).json({ error: 'Bu aşamayı yalnızca görevi veren kişi onaylayabilir.' });
        if (asama.durum !== 'onay_bekliyor') return res.status(400).json({ error: 'Bu aşama onay beklemiyor.' });

        asama.durum = 'bitti';
        asama.gercekBaslangic = asama.bekleyenBaslangic;
        asama.gercekBitis = asama.bekleyenBitis;
        delete asama.bekleyenBaslangic; delete asama.bekleyenBitis; delete asama.talepEden;

        const bas = new Date(asama.gercekBaslangic);
        const bit = new Date(asama.gercekBitis);
        const gercekGun = Math.max(1, Math.round((bit - bas) / (1000 * 60 * 60 * 24)));
        try {
          await db.execute({
            sql: `INSERT INTO asama_gecmisi (task_id, asama_adi, kategori, tahmini_gun, gercek_gun, baslangic, bitis, kaydeden, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [taskId, asama.ad, plan.kategori || null, asama.gun || null, gercekGun,
                   asama.gercekBaslangic, asama.gercekBitis, kullanici || 'Bilinmiyor', bugun]
          });
        } catch (e) { console.error('Geçmiş kaydı hatası:', e.message); }

      } else if (islem === 'reddet') {
        if (!onaylayabilir) return res.status(403).json({ error: 'Bu işlemi yalnızca görevi veren kişi yapabilir.' });
        if (asama.durum !== 'onay_bekliyor') return res.status(400).json({ error: 'Bu aşama onay beklemiyor.' });

        const talepEden = asama.talepEden;
        asama.durum = 'devam';
        delete asama.bekleyenBaslangic; delete asama.bekleyenBitis; delete asama.talepEden;

        try {
          const hedef = await db.execute({
            sql: `SELECT id FROM users WHERE name = ? OR email = ? LIMIT 1`,
            args: [talepEden, talepEden]
          });
          const hedefId = hedef.rows[0] && hedef.rows[0].id;
          if (hedefId) {
            await db.execute({
              sql: `INSERT INTO asama_bildirimleri (user_id, task_id, tip, mesaj, okundu, created_at) VALUES (?, ?, ?, ?, 0, ?)`,
              args: [hedefId, taskId, 'asama_red',
                `"${task.title}" görevinde "${asama.ad}" aşaması onaylanmadı, lütfen tekrar kontrol edin.`, bugun]
            });
          }
        } catch (e) { console.error('Red bildirimi hatası:', e.message); }

      } else {
        return res.status(400).json({ error: 'Geçersiz işlem.' });
      }

      await db.execute({ sql: `UPDATE tasks SET is_plani = ? WHERE id = ?`, args: [JSON.stringify(plan), taskId] });
      res.json({ message: 'Aşama durumu güncellendi.', plan });
    } catch (error) {
      res.status(500).json({ error: 'Aşama durumu güncellenemedi: ' + error.message });
    }
  });

  // Gecikme kontrolü: panel açılınca çağrılır, geciken aşamalar için bildirim üretir (tekilleştirilmiş)
  router.post('/bildirimler/gecikme-kontrol', async (req, res) => {
    try {
      const bugun = new Date(); bugun.setHours(0, 0, 0, 0);
      const bugunStr = new Date().toISOString().split('T')[0];

      const tasksResult = await db.execute(`SELECT id, title, is_plani, created_by, assigned_to FROM tasks WHERE is_plani IS NOT NULL`);
      const parseTR = (s) => { const [g, a, y] = s.split('.').map(Number); return new Date(y, a - 1, g); };

      for (const task of tasksResult.rows) {
        let plan;
        try { plan = JSON.parse(task.is_plani); } catch (e) { continue; }
        if (!plan.adimlar) continue;

        const aliciIdSet = new Set();
        if (task.created_by) {
          const uRes = await db.execute({
            sql: `SELECT id FROM users WHERE name = ? OR email = ? LIMIT 1`,
            args: [task.created_by, task.created_by]
          });
          if (uRes.rows[0]) aliciIdSet.add(uRes.rows[0].id);
        }
        let atananBirim = null;
        if (task.assigned_to) {
          const aRes = await db.execute({
            sql: `SELECT id, department FROM users WHERE id = ? LIMIT 1`,
            args: [task.assigned_to]
          });
          if (aRes.rows[0]) { aliciIdSet.add(aRes.rows[0].id); atananBirim = aRes.rows[0].department; }
        }
        if (atananBirim) {
          const gozRes = await db.execute({
            sql: `SELECT id FROM users WHERE department = ? AND role != 'INTERN'`,
            args: [atananBirim]
          });
          for (const r of gozRes.rows) aliciIdSet.add(r.id);
        }
        if (aliciIdSet.size === 0) continue;

        for (let i = 0; i < plan.adimlar.length; i++) {
          const a = plan.adimlar[i];
          if (a.durum === 'bitti' || a.durum === 'onay_bekliyor') continue;
          const oncekiBitti = (i === 0) || (plan.adimlar[i - 1] && plan.adimlar[i - 1].durum === 'bitti');
          if (!oncekiBitti) continue;
          const bit = parseTR(a.bitis);
          if (bugun > bit) {
            const gecenGun = Math.round((bugun - bit) / (1000 * 60 * 60 * 24));
            const mesaj = `"${task.title}" görevinde "${a.ad}" aşaması gecikti (${gecenGun} gündür bekliyor).`;
            for (const uid of aliciIdSet) {
              const varMi = await db.execute({
                sql: `SELECT id FROM asama_bildirimleri WHERE task_id = ? AND tip = ? AND user_id = ? LIMIT 1`,
                args: [task.id, `gecikme_${i}`, uid]
              });
              if (varMi.rows.length === 0) {
                await db.execute({
                  sql: `INSERT INTO asama_bildirimleri (user_id, task_id, tip, mesaj, okundu, created_at) VALUES (?, ?, ?, ?, 0, ?)`,
                  args: [uid, task.id, `gecikme_${i}`, mesaj, bugunStr]
                });
              }
            }
          }
        }
      }
      res.json({ message: 'Gecikme kontrolü tamamlandı.' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // İş planı bildirimlerini getir (en yeni önce)
  router.get('/bildirimler', async (req, res) => {
    try {
      const userId = req.query.userId;
      if (!userId) return res.status(400).json({ error: 'userId gerekli.' });
      const result = await db.execute({
        sql: `SELECT * FROM asama_bildirimleri WHERE user_id = ? ORDER BY id DESC LIMIT 50`,
        args: [userId]
      });
      res.json(result.rows);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Bildirimi okundu işaretle (tek ya da hepsi)
  router.post('/bildirimler/okundu', async (req, res) => {
    try {
      const { bildirimId, userId, hepsi } = req.body;
      if (hepsi) {
        await db.execute({ sql: `UPDATE asama_bildirimleri SET okundu = 1 WHERE user_id = ?`, args: [userId] });
      } else if (bildirimId) {
        await db.execute({ sql: `UPDATE asama_bildirimleri SET okundu = 1 WHERE id = ?`, args: [bildirimId] });
      }
      res.json({ message: 'Okundu işaretlendi.' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================================
  // GÖREV ASİSTANI (chatbot): kullanıcının görebildiği görevleri bağlam alır — GET /api/tasks
  // ile AYNI görünürlük mantığı (ADMIN/HR tümünü, INTERN yalnızca kendine atananları,
  // diğer roller kendi birimini görür).
  // ============================================================
  router.post('/chatbot', async (req, res) => {
    try {
      const { userId, role, department, message, history, name } = req.body;

      if (!message || !String(message).trim()) {
        return res.status(400).json({ error: 'Mesaj boş olamaz.' });
      }

      let sql = `SELECT tasks.*, users.name AS assignee_name
                 FROM tasks LEFT JOIN users ON tasks.assigned_to = users.id`;
      const conditions = [], args = [];
      if (role === 'INTERN') {
        conditions.push(`tasks.assigned_to = ?`);
        args.push(userId);
      } else if (!isAdmin(role) && department) {
        conditions.push(`users.department = ?`);
        args.push(department);
      }
      if (conditions.length) sql += ` WHERE ` + conditions.join(' AND ');
      sql += ` ORDER BY tasks.id DESC LIMIT 100`;

      const result = await db.execute({ sql, args });
      const tasks = result.rows;

      const bugunStr = new Date().toISOString().split('T')[0];
      const durumTR = {
        IN_PROGRESS: 'Devam ediyor',
        COMPLETED: 'Tamamlandı (onay bekliyor)',
        APPROVED: 'Onaylandı',
        REVISION_REQUESTED: 'Revize istendi'
      };

      const gorevMetni = tasks.map(t => {
        return `- "${t.title}" | Atanan: ${t.assignee_name || '?'} | Görevi veren: ${t.created_by || '?'} | Kategori: ${t.category} | Bitiş: ${t.end_date} | Çalışma günü: ${t.work_days} | Durum: ${durumTR[t.status] || t.status}`;
      }).join('\n');

      const sistem = `Sen "BEYES Asistan" adlı, "Görev & Takip Paneli" uygulamasının yardımcısısın. Bugünün tarihi: ${bugunStr}.
Kullanıcı: ${name || 'bilinmiyor'} (rol: ${role || 'bilinmiyor'}).

KURALLAR:
- SADECE Türkçe yaz. Düz metin kullan; Markdown veya *, #, ** gibi işaretleri KULLANMA.
- Yanıtın soruyla ORANTILI olsun. "sa", "selam", "merhaba" gibi kısa selamlaşmalara SADECE kısa ve samimi bir karşılık ver, nasıl yardımcı olabileceğini sor; İSTENMEDİKÇE görevleri listeleme.
- Görev listesini ya da özetini yalnızca kullanıcı görevlerini açıkça sorduğunda ver.
- Görevlerle ilgili sorularda AŞAĞIDAKİ görev verilerini kullan; bu verilerde olmayan bilgiyi uydurma.
- Kullanıcının adını yalnızca yukarıda verildiyse kullan; İSİM UYDURMA, verilmemişse isimle hitap etme.
- Görev dışı genel sorulara (tanım, açıklama, sohbet, hesaplama) normal şekilde yanıtla.

GÖREV VERİLERİ (${tasks.length} görev):
${gorevMetni || 'Görev bulunmuyor.'}`;

      const messages = [{ role: 'system', content: sistem }];
      if (Array.isArray(history)) {
        history.slice(-8).forEach(h => {
          if (h && (h.role === 'user' || h.role === 'assistant') && h.content) {
            messages.push({ role: h.role, content: String(h.content).slice(0, 2000) });
          }
        });
      }
      messages.push({ role: 'user', content: String(message).slice(0, 2000) });

      const cevap = await mistralChatTR(messages, 0.4);
      res.json({ reply: cevap || 'Üzgünüm, şu an bir yanıt üretemedim.' });
    } catch (error) {
      res.status(500).json({ error: 'Asistan hatası: ' + error.message });
    }
  });

  // ============================================================
  // GENEL ASİSTAN: kullanıcının kendisine atanan + kendi verdiği görevleri bağlam alır
  // (Görev Asistanı'ndan farkı: birim geneli değil, tamamen kişiye özel bağlam).
  // ============================================================
  router.post('/asistan', async (req, res) => {
    try {
      const { userId, name, role, department, messages } = req.body;
      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'Mesaj gerekli.' });
      }

      let tasks = [];
      try {
        const r = await db.execute({
          sql: `SELECT tasks.*, users.name AS assignee_name
                FROM tasks LEFT JOIN users ON users.id = tasks.assigned_to
                WHERE tasks.assigned_to = ? OR tasks.created_by = ?
                ORDER BY tasks.id DESC LIMIT 60`,
          args: [userId, name]
        });
        tasks = r.rows;
      } catch (e) { /* veri yoksa boş geç */ }

      const durumTR = {
        IN_PROGRESS: 'Devam ediyor',
        COMPLETED: 'Tamamlandı (onay bekliyor)',
        APPROVED: 'Onaylandı',
        REVISION_REQUESTED: 'Revize istendi'
      };

      const gorevMetni = tasks.map(t => {
        return `- "${t.title}" | Atanan: ${t.assignee_name || '?'} | Durum: ${durumTR[t.status] || t.status} | Son teslim: ${t.end_date} | Çalışma günü: ${t.work_days} | Kategori: ${t.category}`;
      }).join('\n') || 'Bu kullanıcıya ait kayıtlı görev yok.';

      const bugunStr = new Date().toISOString().split('T')[0];
      const sistem = `Sen "Görev & Takip Paneli" uygulamasının Türkçe yardımcı asistanısın.
Kullanıcı: ${name || '?'} (rol: ${role || '?'}${department ? ', birim: ' + department : ''}). Bugünün tarihi: ${bugunStr}.
Aşağıda bu kullanıcıyla ilgili GÜNCEL görev verileri var. Soruları SADECE bu verilere ve genel bilgine dayanarak yanıtla.
Veride olmayan bir şeyi uydurma; bilmiyorsan "Bu bilgi elimde yok" de. Kısa, net ve Türkçe yanıt ver. Markdown/işaret kullanma.

GÖREV VERİLERİ:
${gorevMetni}`;

      const sonMesajlar = messages.slice(-10).map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content || '')
      }));

      const cevap = await mistralChatTR([{ role: 'system', content: sistem }, ...sonMesajlar], 0.4);
      res.json({ cevap: cevap || 'Üzgünüm, bir yanıt üretemedim.' });
    } catch (error) {
      res.status(500).json({ error: 'Asistan hatası: ' + error.message });
    }
  });

  return router;
}

module.exports = { createAiRouter, initAiSchema, IS_PLANI_YETKILI };
