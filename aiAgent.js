// aiAgent.js
// ============================================================
// AI AJAN KATMANI — Function Calling (Özellik 1) + Dinamik System Prompt (Özellik 6)
//
// ai.js'i BOZMADAN yanına eklenir. Mevcut /chatbot ve /asistan aynen kalır; bu modül
// "eylem yapabilen" yeni bir sohbet uçları ekler:
//
//   POST /api/agent/chat      -> Kullanıcı mesajını alır. AI okuma araçlarını (görev
//                                listele, iş yükü) kendisi çalıştırır. Bir YAZMA işlemi
//                                (atama / tarih değiştirme / durum / iş planı uzatma)
//                                gerekiyorsa VERİTABANINA DOKUNMADAN "onay kartı" döner.
//   POST /api/agent/execute   -> Kullanıcı onay kartında "Onayla" derse burası çağrılır.
//                                Sunucu YETKİYİ TEKRAR KONTROL EDİP işlemi uygular.
//
// GÜVENLİK İLKESİ: AI hiçbir yazma işlemini kendi başına yapmaz. Yazma daima
// kullanıcı onayı + sunucu tarafı yetki kontrolü ile /execute üzerinden gerçekleşir.
//
// Kullanım (server.js içinde, mevcut satırın hemen ALTINA):
//   const aiAgent = require('./aiAgent');
//   app.use('/api', aiAgent.createAgentRouter(db, { isAdmin }));
//
// Not: MISTRAL_API_KEY yoksa uçlar 503 döner (ai.js ile aynı davranış).
// ============================================================

const express = require('express');
const aiRag = require('./aiRag');       // Özellik 4: semantik geçmiş görev araması
const aiReport = require('./aiReport'); // Özellik 5: yönetici özeti
const aiInsights = require('./aiInsights'); // Özellik 2+3: risk taraması + atama önerisi

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const MISTRAL_MODEL = process.env.MISTRAL_MODEL || 'mistral-large-latest';

// ai.js'teki aşama tanımlarıyla AYNI olmalı (iş planı yeniden hesaplama için)
const IS_ADIMLARI = [
  { ad: 'Şematik İnceleme', yuzde: 10 },
  { ad: 'KTTD',            yuzde: 20 },
  { ad: 'BDK',             yuzde: 15 },
  { ad: 'Visio',           yuzde: 25 },
  { ad: 'Sequence',        yuzde: 20 },
  { ad: 'Entegrasyon',     yuzde: 10 }
];

// Göreve atanabilecek roller (server.js /api/tasks ile aynı)
const ATANABILIR_ROLLER = ['INTERN', 'TECHNICIAN', 'ENGINEER', 'LEADER'];
// Görevde yazma (atama/tarih/durum) yapabilen roller (server.js PUT /tasks ile aynı)
const GOREV_YAZMA_ROLLERI = ['ADMIN', 'HR', 'MANAGER', 'LEADER', 'ENGINEER'];
// İş planı uzatabilen roller (ai.js IS_PLANI_YETKILI ile aynı)
const IS_PLANI_YETKILI = ['ADMIN', 'MANAGER', 'LEADER', 'ENGINEER'];

const DURUM_TR = {
  IN_PROGRESS: 'Devam ediyor',
  COMPLETED: 'Tamamlandı (onay bekliyor)',
  APPROVED: 'Onaylandı',
  REVISION_REQUESTED: 'Revize istendi'
};
const GECERLI_DURUMLAR = Object.keys(DURUM_TR);

// ---- yardımcılar ----------------------------------------------------------

function tarihFormatlaTR(d) {
  const g = String(d.getDate()).padStart(2, '0');
  const a = String(d.getMonth() + 1).padStart(2, '0');
  return `${g}.${a}.${d.getFullYear()}`;
}
function parseTR(s) {
  const [g, a, y] = String(s).split('.').map(Number);
  return new Date(y, a - 1, g);
}

// ============================================================
// ÖZELLİK 6 — DİNAMİK SYSTEM PROMPT: role göre AI'nın dili ve odağı değişir
// ============================================================
function sistemPromptu({ name, role, department, bugunStr }) {
  const ortak = `Sen "BEYES Asistan" adlı Görev & Takip Paneli yardımcısısın. Bugün: ${bugunStr}.
Kullanıcı: ${name || 'bilinmiyor'} (rol: ${role || 'bilinmiyor'}${department ? ', birim: ' + department : ''}).

GENEL KURALLAR:
- SADECE Türkçe yaz. Markdown/işaret (*, #, **) KULLANMA.
- "sa", "selam", "merhaba", "nasılsın" gibi kısa selam/sohbet mesajlarında HİÇBİR araç (function) çağırma; doğrudan kısa ve samimi cevap ver.
- Araçları YALNIZCA kullanıcı gerçekten görev listeleme, atama, tarih/durum değiştirme, risk, atama önerisi, özet veya geçmiş görev araması istediğinde çağır.
- Bir işlem yapman istendiğinde uygun aracı çağır; veriyi UYDURMA.
- Bir görevi güncellemeden/atamadan önce doğru görevi bulduğundan emin ol; şüphedeysen kullanıcıya sor.`;

  if (role === 'ENGINEER' || role === 'TECHNICIAN') {
    return `${ortak}

ÜSLUP (Mühendis): Teknik ve pragmatik ol. Aşama girdilerine, teslim sürelerine ve
takvimdeki sıkışıklığa odaklan. Kısa, uygulanabilir öneriler ver.`;
  }
  if (role === 'INTERN') {
    return `${ortak}

ÜSLUP (Stajyer): Sade ve yönlendirici ol. Yalnızca kendi görevlerini görebildiğini
unutma; başkasına görev atama gibi yetkin yok, bu tür istekleri kibarca reddet.`;
  }
  // ADMIN / HR / MANAGER / LEADER
  return `${ortak}

ÜSLUP (Yönetici): Makro ve özet odaklı ol. Zaman/teslim riskleri, iş yükü dağılımı ve
ekip ilerlemesi gibi karar destekleyici bilgiyi öne çıkar. Gereksiz teknik ayrıntıya girme.`;
}

// ============================================================
// ÖZELLİK 1 — ARAÇ (FUNCTION) TANIMLARI (Mistral tool-use şeması)
// Roller okuma araçlarının hepsini kullanabilir; YAZMA araçları role göre filtrelenir.
// ============================================================
const ARAC_TANIMLARI = {
  gorevleri_listele: {
    yazma: false,
    tanim: {
      type: 'function',
      function: {
        name: 'gorevleri_listele',
        description: 'Kullanıcının görebildiği görevleri listeler. Duruma göre filtrelenebilir.',
        parameters: {
          type: 'object',
          properties: {
            durum: { type: 'string', enum: GECERLI_DURUMLAR, description: 'İsteğe bağlı durum filtresi.' },
            aramaMetni: { type: 'string', description: 'Başlıkta geçen isteğe bağlı arama metni.' }
          }
        }
      }
    }
  },
  gorev_detay: {
    yazma: false,
    tanim: {
      type: 'function',
      function: {
        name: 'gorev_detay',
        description: 'Tek bir görevin detayını ve varsa iş planı aşamalarının durumunu getirir.',
        parameters: {
          type: 'object',
          properties: { gorevId: { type: 'integer', description: 'Görev (kart) kimliği.' } },
          required: ['gorevId']
        }
      }
    }
  },
  is_yuku_ozeti: {
    yazma: false,
    tanim: {
      type: 'function',
      function: {
        name: 'is_yuku_ozeti',
        description: 'Kişi başına aktif görev sayısını verir. Atama önerisi/iş yükü sorularında kullan.',
        parameters: { type: 'object', properties: {} }
      }
    }
  },
  benzer_gorev_ara: {
    yazma: false,
    tanim: {
      type: 'function',
      function: {
        name: 'benzer_gorev_ara',
        description: 'Geçmiş görevlerin açıklama ve notları içinde anlamsal (semantik) arama yapar. Yeni bir kart/aşama için benzer geçmiş işleri, yaşanan blokajları hatırlamak amacıyla kullan.',
        parameters: {
          type: 'object',
          properties: {
            sorgu: { type: 'string', description: 'Aranacak konu/aşama/sorun (ör. "BDK test cihazı uyumsuzluğu").' }
          },
          required: ['sorgu']
        }
      }
    }
  },
  yonetici_ozeti: {
    yazma: false,
    yetki: ['ADMIN', 'HR', 'MANAGER', 'LEADER'],
    tanim: {
      type: 'function',
      function: {
        name: 'yonetici_ozeti',
        description: 'Güncel duruma dair kısa yönetici özeti üretir (devam eden/onay bekleyen/geciken görevler). Yönetici "özet", "durum raporu", "bugün ne durumdayız" gibi sorduğunda kullan.',
        parameters: {
          type: 'object',
          properties: {
            kapsam: { type: 'string', enum: ['gunluk', 'haftalik'], description: 'İsteğe bağlı; varsayılan günlük.' }
          }
        }
      }
    }
  },
  risk_taramasi: {
    yazma: false,
    yetki: ['ADMIN', 'HR', 'MANAGER', 'LEADER', 'ENGINEER'],
    tanim: {
      type: 'function',
      function: {
        name: 'risk_taramasi',
        description: 'Gecikme OLMADAN önce riskli/darboğaz aşamaları bulur (süresi %70+ dolmuş ama tamamlanmamış, geçmişte sarkma eğilimi olan). "Risk var mı", "hangi görevler sıkışık", "darboğaz" gibi sorularda kullan.',
        parameters: { type: 'object', properties: {} }
      }
    }
  },
  atama_onerisi: {
    yazma: false,
    yetki: ['ADMIN', 'HR', 'MANAGER', 'LEADER', 'ENGINEER'],
    tanim: {
      type: 'function',
      function: {
        name: 'atama_onerisi',
        description: 'Yeni bir görev için, adayların aktif iş yükü ve geçmiş performansına göre en uygun kişiyi önerir. "Bunu kime atayayım", "kim müsait", "en uygun mühendis" gibi sorularda kullan.',
        parameters: {
          type: 'object',
          properties: {
            kategori: { type: 'string', description: 'Görevin kategorisi (varsa).' },
            asama: { type: 'string', description: 'Ağırlıklı/kritik aşama (ör. Sequence, Visio). İsteğe bağlı.' }
          }
        }
      }
    }
  },
  gorev_ata: {
    yazma: true,
    yetki: GOREV_YAZMA_ROLLERI,
    tanim: {
      type: 'function',
      function: {
        name: 'gorev_ata',
        description: 'Bir görevi başka bir kullanıcıya atar (assigned_to değiştirir).',
        parameters: {
          type: 'object',
          properties: {
            gorevId: { type: 'integer' },
            atananKullaniciId: { type: 'integer', description: 'Görevin atanacağı kullanıcının kimliği.' }
          },
          required: ['gorevId', 'atananKullaniciId']
        }
      }
    }
  },
  gorev_bitis_guncelle: {
    yazma: true,
    yetki: GOREV_YAZMA_ROLLERI,
    tanim: {
      type: 'function',
      function: {
        name: 'gorev_bitis_guncelle',
        description: 'Görevin bitiş tarihini değiştirir. İş planı varsa kalan aşamaları yeni tarihe göre yeniden hesaplar.',
        parameters: {
          type: 'object',
          properties: {
            gorevId: { type: 'integer' },
            yeniBitis: { type: 'string', description: 'YYYY-MM-DD biçiminde yeni bitiş tarihi.' }
          },
          required: ['gorevId', 'yeniBitis']
        }
      }
    }
  },
  gorev_durum_degistir: {
    yazma: true,
    yetki: GOREV_YAZMA_ROLLERI,
    tanim: {
      type: 'function',
      function: {
        name: 'gorev_durum_degistir',
        description: 'Görevin durumunu değiştirir (IN_PROGRESS, COMPLETED, APPROVED, REVISION_REQUESTED).',
        parameters: {
          type: 'object',
          properties: {
            gorevId: { type: 'integer' },
            durum: { type: 'string', enum: GECERLI_DURUMLAR }
          },
          required: ['gorevId', 'durum']
        }
      }
    }
  }
};

// Role göre kullanılabilir araç listesi.
// Kural: bir araçta "yetki" listesi varsa yalnızca o roller kullanabilir (okuma/yazma fark etmez).
// "yetki" yoksa ve okuma aracıysa herkes kullanabilir.
function rolIcinAraclar(role) {
  const list = [];
  for (const key of Object.keys(ARAC_TANIMLARI)) {
    const a = ARAC_TANIMLARI[key];
    if (a.yetki) { if (a.yetki.includes(role)) list.push(a.tanim); continue; }
    if (!a.yazma) list.push(a.tanim); // yetki tanımsız okuma aracı → serbest
  }
  return list;
}
function aracYazmaMi(name) { return !!(ARAC_TANIMLARI[name] && ARAC_TANIMLARI[name].yazma); }
function aracYetkiliMi(name, role) {
  const a = ARAC_TANIMLARI[name];
  if (!a) return false;
  if (a.yetki) return a.yetki.includes(role);
  return !a.yazma; // yetki yoksa yalnızca okuma serbest
}

// ============================================================
function createAgentRouter(db, { isAdmin }) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!MISTRAL_API_KEY) {
      return res.status(503).json({ error: 'Yapay zeka özellikleri yapılandırılmamış (MISTRAL_API_KEY tanımlı değil).' });
    }
    next();
  });

  // Mistral'a araçlarla birlikte istek atar; ham "message" nesnesini döner (tool_calls dahil).
  // Zaman aşımı (askıda kalmayı önler) + gerçek hata gövdesini loglar.
  async function mistralWithTools(messages, tools) {
    const body = { model: MISTRAL_MODEL, messages, temperature: 0.2 };
    if (tools && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000); // 30 sn'de iptal et
    let r;
    try {
      r = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${MISTRAL_API_KEY}` },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error('Yapay zekâ servisi zaman aşımına uğradı (30 sn).');
      throw e;
    }
    clearTimeout(timer);

    if (!r.ok) {
      let govde = '';
      try { govde = await r.text(); } catch (e) {}
      console.error('MISTRAL HATASI', r.status, govde.slice(0, 800)); // terminalde gerçek sebep
      throw new Error('Yapay zekâ servisi yanıt vermedi (' + r.status + ').');
    }
    const data = await r.json();
    return (data.choices && data.choices[0] && data.choices[0].message) || { content: '' };
  }

  // Araçsız düz sohbet (yedek): tool yolu patlarsa ya da basit mesajlarda hızlı cevap için.
  async function duzSohbet(messages) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${MISTRAL_API_KEY}` },
        body: JSON.stringify({ model: MISTRAL_MODEL, messages, temperature: 0.4 }),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!r.ok) return '';
      const data = await r.json();
      return ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
    } catch (e) { clearTimeout(timer); return ''; }
  }

  // ---- OKUMA aracı yürütücüleri (kullanıcı görünürlüğüne saygılı) ---------

  // /chatbot ile aynı görünürlük mantığı
  function gorunurlukKosulu(role, department, userId) {
    const conditions = [], args = [];
    if (role === 'INTERN') { conditions.push(`tasks.assigned_to = ?`); args.push(userId); }
    else if (!isAdmin(role) && department) { conditions.push(`users.department = ?`); args.push(department); }
    return { conditions, args };
  }

  async function calistir_gorevleri_listele(a, user) {
    let sql = `SELECT tasks.*, users.name AS assignee_name
               FROM tasks LEFT JOIN users ON tasks.assigned_to = users.id`;
    const { conditions, args } = gorunurlukKosulu(user.role, user.department, user.userId);
    if (a.durum && GECERLI_DURUMLAR.includes(a.durum)) { conditions.push(`tasks.status = ?`); args.push(a.durum); }
    if (a.aramaMetni) { conditions.push(`tasks.title LIKE ?`); args.push('%' + a.aramaMetni + '%'); }
    if (conditions.length) sql += ` WHERE ` + conditions.join(' AND ');
    sql += ` ORDER BY tasks.id DESC LIMIT 60`;
    const r = await db.execute({ sql, args });
    return r.rows.map(t => ({
      id: t.id, baslik: t.title, atanan: t.assignee_name || '?', atananId: t.assigned_to,
      verenIsim: t.created_by || '?', kategori: t.category, bitis: t.end_date,
      calismaGunu: t.work_days, durum: DURUM_TR[t.status] || t.status
    }));
  }

  async function calistir_gorev_detay(a, user) {
    const r = await db.execute({
      sql: `SELECT tasks.*, users.name AS assignee_name, users.department AS assignee_dep
            FROM tasks LEFT JOIN users ON tasks.assigned_to = users.id WHERE tasks.id = ?`,
      args: [a.gorevId]
    });
    const t = r.rows[0];
    if (!t) return { hata: 'Görev bulunamadı.' };
    // görünürlük kontrolü
    if (user.role === 'INTERN' && Number(t.assigned_to) !== Number(user.userId)) return { hata: 'Bu görevi görme yetkiniz yok.' };
    if (!isAdmin(user.role) && user.role !== 'INTERN' && user.department && t.assignee_dep && t.assignee_dep !== user.department) {
      return { hata: 'Bu görev sizin biriminizde değil.' };
    }
    let asamalar = null;
    if (t.is_plani) {
      try {
        const p = JSON.parse(t.is_plani);
        asamalar = (p.adimlar || []).map(x => ({ ad: x.ad, bitis: x.bitis, durum: x.durum || 'devam' }));
      } catch (e) {}
    }
    return {
      id: t.id, baslik: t.title, aciklama: t.description || '', atanan: t.assignee_name || '?',
      atananId: t.assigned_to, kategori: t.category, bitis: t.end_date, calismaGunu: t.work_days,
      durum: DURUM_TR[t.status] || t.status, asamalar
    };
  }

  // Kişi başına aktif (devam eden / onay bekleyen) görev sayısı — Özellik 3'ün temeli
  async function calistir_is_yuku_ozeti(a, user) {
    let sql = `SELECT users.id, users.name, users.role, users.department,
                      COUNT(tasks.id) AS aktif_gorev
               FROM users
               LEFT JOIN tasks ON tasks.assigned_to = users.id
                    AND tasks.status IN ('IN_PROGRESS','COMPLETED','REVISION_REQUESTED')
               WHERE users.status = 'APPROVED' AND users.role IN ('INTERN','TECHNICIAN','ENGINEER','LEADER')`;
    const args = [];
    if (!isAdmin(user.role) && user.department) { sql += ` AND users.department = ?`; args.push(user.department); }
    sql += ` GROUP BY users.id ORDER BY aktif_gorev ASC`;
    const r = await db.execute({ sql, args });
    return r.rows.map(x => ({
      kullaniciId: x.id, isim: x.name, rol: x.role, birim: x.department, aktifGorev: Number(x.aktif_gorev || 0)
    }));
  }

  async function okumaAraciCalistir(name, args, user) {
    if (name === 'gorevleri_listele') return calistir_gorevleri_listele(args, user);
    if (name === 'gorev_detay') return calistir_gorev_detay(args, user);
    if (name === 'is_yuku_ozeti') return calistir_is_yuku_ozeti(args, user);
    if (name === 'benzer_gorev_ara') {
      try {
        const sonuc = await aiRag.benzerGorevAra(db, args.sorgu, 3, { role: user.role, department: user.department });
        return sonuc.length ? { benzerGorevler: sonuc } : { benzerGorevler: [], not: 'Benzer geçmiş görev bulunamadı.' };
      } catch (e) { return { hata: 'Arama yapılamadı: ' + e.message }; }
    }
    if (name === 'yonetici_ozeti') {
      try {
        // Admin/İK genel; Müdür/Lider kendi birimi
        const dep = (user.role === 'MANAGER' || user.role === 'LEADER') ? user.department : null;
        const { ozet, veriler } = await aiReport.ozetUret(db, { department: dep, kapsam: args.kapsam || 'gunluk' });
        return { ozet, metrikler: veriler };
      } catch (e) { return { hata: 'Özet üretilemedi: ' + e.message }; }
    }
    if (name === 'risk_taramasi') {
      try {
        const dep = (user.role === 'MANAGER' || user.role === 'LEADER' || user.role === 'ENGINEER') ? user.department : null;
        const riskler = await aiInsights.riskTara(db, { department: dep });
        return riskler.length ? { riskler: riskler.slice(0, 10) } : { riskler: [], not: 'Şu an belirgin bir risk/darboğaz görünmüyor.' };
      } catch (e) { return { hata: 'Risk taraması yapılamadı: ' + e.message }; }
    }
    if (name === 'atama_onerisi') {
      try {
        const dep = isAdmin(user.role) ? null : (user.department || null);
        const sonuc = await aiInsights.atamaOnerisi(db, { kategori: args.kategori, department: dep, asama: args.asama });
        return sonuc;
      } catch (e) { return { hata: 'Atama önerisi üretilemedi: ' + e.message }; }
    }
    return { hata: 'Bilinmeyen araç.' };
  }

  // ---- YAZMA işlemi: onay kartı için okunabilir özet üretir --------------
  async function yazmaOzeti(name, args) {
    if (name === 'gorev_ata') {
      const t = await db.execute({ sql: `SELECT title FROM tasks WHERE id = ?`, args: [args.gorevId] });
      const u = await db.execute({ sql: `SELECT name FROM users WHERE id = ?`, args: [args.atananKullaniciId] });
      const baslik = t.rows[0] ? t.rows[0].title : ('#' + args.gorevId);
      const kisi = u.rows[0] ? u.rows[0].name : ('#' + args.atananKullaniciId);
      return `"${baslik}" görevi ${kisi} kişisine atanacak.`;
    }
    if (name === 'gorev_bitis_guncelle') {
      const t = await db.execute({ sql: `SELECT title, is_plani FROM tasks WHERE id = ?`, args: [args.gorevId] });
      const baslik = t.rows[0] ? t.rows[0].title : ('#' + args.gorevId);
      const planNotu = (t.rows[0] && t.rows[0].is_plani) ? ' ve iş planı yeniden hesaplanacak' : '';
      return `"${baslik}" görevinin bitiş tarihi ${args.yeniBitis} olarak güncellenecek${planNotu}.`;
    }
    if (name === 'gorev_durum_degistir') {
      const t = await db.execute({ sql: `SELECT title FROM tasks WHERE id = ?`, args: [args.gorevId] });
      const baslik = t.rows[0] ? t.rows[0].title : ('#' + args.gorevId);
      return `"${baslik}" görevinin durumu "${DURUM_TR[args.durum] || args.durum}" olarak değiştirilecek.`;
    }
    return 'Bu işlem uygulanacak.';
  }

  // ============================================================
  // POST /api/agent/chat  — AI okuma araçlarını çalıştırır; yazma gerekirse onay kartı döner
  // Body: { userId, name, role, department, message, history }
  // ============================================================
  router.post('/agent/chat', async (req, res) => {
    try {
      const { userId, name, role, department, message, history } = req.body;
      if (!message || !String(message).trim()) return res.status(400).json({ error: 'Mesaj boş olamaz.' });

      const user = { userId, name, role, department };
      const bugunStr = new Date().toISOString().split('T')[0];
      const tools = rolIcinAraclar(role);

      const messages = [{ role: 'system', content: sistemPromptu({ name, role, department, bugunStr }) }];
      if (Array.isArray(history)) {
        history.slice(-8).forEach(h => {
          if (h && (h.role === 'user' || h.role === 'assistant') && h.content) {
            messages.push({ role: h.role, content: String(h.content).slice(0, 2000) });
          }
        });
      }
      messages.push({ role: 'user', content: String(message).slice(0, 2000) });

      // Araç döngüsü: okuma araçlarını çalıştır, yazma gelirse dur ve onay iste.
      // Herhangi bir aşamada Mistral tool isteği patlarsa, kullanıcıyı boş bırakmamak için
      // araçsız düz sohbete düşüp yine de bir cevap döndürürüz.
      try {
        const MAX_TUR = 4;
        for (let tur = 0; tur < MAX_TUR; tur++) {
          const ai = await mistralWithTools(messages, tools);
          const toolCalls = ai.tool_calls || [];

          if (!toolCalls.length) {
            return res.json({ reply: (ai.content || 'Bir yanıt üretemedim.').trim() });
          }

          // Model asistan mesajını (tool_calls ile) geçmişe ekle
          messages.push({ role: 'assistant', content: ai.content || '', tool_calls: toolCalls });

          // YAZMA aracı var mı? İlkini onaya çıkar (birden fazla yazmayı tek turda yapmayız)
          const yazma = toolCalls.find(tc => aracYazmaMi(tc.function.name));
          if (yazma) {
            if (!aracYetkiliMi(yazma.function.name, role)) {
              return res.json({ reply: 'Bu işlem için yetkiniz bulunmuyor.' });
            }
            let args = {};
            try { args = JSON.parse(yazma.function.arguments || '{}'); } catch (e) {}
            const ozet = await yazmaOzeti(yazma.function.name, args);
            return res.json({
              requiresConfirmation: true,
              pendingAction: { name: yazma.function.name, args },
              summary: ozet
            });
          }

          // Sadece okuma araçları: hepsini çalıştır, sonucu modele geri ver, döngü devam
          for (const tc of toolCalls) {
            let args = {};
            try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
            const sonuc = await okumaAraciCalistir(tc.function.name, args, user);
            messages.push({
              role: 'tool', name: tc.function.name, tool_call_id: tc.id,
              content: JSON.stringify(sonuc).slice(0, 6000)
            });
          }
        }
        return res.json({ reply: 'İşlem uzadı, lütfen isteğinizi biraz daha netleştirin.' });
      } catch (toolHata) {
        // Tool yolu başarısız (ör. Mistral araç formatı/servis hatası) → araçsız düz cevaba düş
        console.error('Ajan tool yolu hatası, düz sohbete düşülüyor:', toolHata.message);
        const duzMesajlar = messages.filter(m => m.role === 'system' || m.role === 'user' || (m.role === 'assistant' && !m.tool_calls));
        const cevap = await duzSohbet(duzMesajlar);
        return res.json({ reply: cevap || 'Şu an araç tabanlı işlemlerde bir sorun var, ama buradayım. Sorunuzu tekrar yazar mısınız?' });
      }
    } catch (error) {
      console.error('Ajan genel hatası:', error.message);
      res.status(500).json({ error: 'Ajan hatası: ' + error.message });
    }
  });

  // ============================================================
  // POST /api/agent/execute — Onaylanan YAZMA işlemini uygular (yetki TEKRAR kontrol edilir)
  // Body: { userId, name, role, department, action: { name, args } }
  // ============================================================
  router.post('/agent/execute', async (req, res) => {
    try {
      const { userId, name, role, department, action } = req.body;
      if (!action || !action.name) return res.status(400).json({ error: 'İşlem bilgisi eksik.' });
      if (!aracYazmaMi(action.name)) return res.status(400).json({ error: 'Bu uç yalnızca yazma işlemleri içindir.' });
      if (!aracYetkiliMi(action.name, role)) return res.status(403).json({ error: 'Bu işlem için yetkiniz yok.' });

      const args = action.args || {};

      // Hedef görevi al + birim bazlı güvenlik: yönetici olmayan yalnızca kendi birimine dokunur
      const tr = await db.execute({
        sql: `SELECT tasks.*, u.department AS assignee_dep FROM tasks tasks
              LEFT JOIN users u ON u.id = tasks.assigned_to WHERE tasks.id = ?`,
        args: [args.gorevId]
      });
      const task = tr.rows[0];
      if (!task) return res.status(404).json({ error: 'Görev bulunamadı.' });
      if (!isAdmin(role) && department && task.assignee_dep && task.assignee_dep !== department) {
        return res.status(403).json({ error: 'Bu görev sizin biriminizde değil.' });
      }

      // --- gorev_ata ---
      if (action.name === 'gorev_ata') {
        const ac = await db.execute({ sql: `SELECT role, status, name FROM users WHERE id = ?`, args: [args.atananKullaniciId] });
        const hedef = ac.rows[0];
        if (!hedef || !ATANABILIR_ROLLER.includes(hedef.role) || hedef.status !== 'APPROVED') {
          return res.status(400).json({ error: 'Geçersiz atama hedefi.' });
        }
        await db.execute({ sql: `UPDATE tasks SET assigned_to = ? WHERE id = ?`, args: [args.atananKullaniciId, args.gorevId] });
        return res.json({ reply: `"${task.title}" görevi ${hedef.name} kişisine atandı.` });
      }

      // --- gorev_bitis_guncelle (+ iş planı yeniden hesapla) ---
      if (action.name === 'gorev_bitis_guncelle') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(args.yeniBitis || ''))) {
          return res.status(400).json({ error: 'Tarih YYYY-AA-GG biçiminde olmalı.' });
        }
        await db.execute({ sql: `UPDATE tasks SET end_date = ? WHERE id = ?`, args: [args.yeniBitis, args.gorevId] });

        let planNot = '';
        if (task.is_plani) {
          try {
            const guncel = isPlaniYenidenHesapla(JSON.parse(task.is_plani), args.yeniBitis);
            if (guncel) {
              await db.execute({ sql: `UPDATE tasks SET is_plani = ? WHERE id = ?`, args: [JSON.stringify(guncel), args.gorevId] });
              planNot = ' İş planı kalan aşamalara göre yeniden hesaplandı.';
            }
          } catch (e) { /* plan bozuksa sessizce sadece tarih güncellenir */ }
        }
        return res.json({ reply: `"${task.title}" görevinin bitiş tarihi ${args.yeniBitis} olarak güncellendi.${planNot}` });
      }

      // --- gorev_durum_degistir ---
      if (action.name === 'gorev_durum_degistir') {
        if (!GECERLI_DURUMLAR.includes(args.durum)) return res.status(400).json({ error: 'Geçersiz durum.' });
        await db.execute({ sql: `UPDATE tasks SET status = ? WHERE id = ?`, args: [args.durum, args.gorevId] });
        return res.json({ reply: `"${task.title}" görevinin durumu "${DURUM_TR[args.durum]}" olarak değiştirildi.` });
      }

      return res.status(400).json({ error: 'Bilinmeyen işlem.' });
    } catch (error) {
      res.status(500).json({ error: 'İşlem uygulanamadı: ' + error.message });
    }
  });

  return router;
}

// İş planı yeniden hesaplama — ai.js'teki /is-plani-guncelle mantığının taşınmış hali.
// Biten aşamalar korunur; kalanlar yeni bitişe göre ağırlıkça yeniden dağıtılır.
function isPlaniYenidenHesapla(plan, yeniBitisISO) {
  if (!plan || !Array.isArray(plan.adimlar)) return null;
  const fmt = (d) => tarihFormatlaTR(d);
  const bitenler = plan.adimlar.filter(a => a.durum === 'bitti');
  const kalanlar = plan.adimlar.filter(a => a.durum !== 'bitti');
  if (kalanlar.length === 0) return null;

  let baslangic = bitenler.length > 0
    ? parseTR(bitenler[bitenler.length - 1].bitis)
    : parseTR(plan.adimlar[0].baslangic);
  const bitis = new Date(yeniBitisISO);
  if (bitis <= baslangic) return null;

  const kalanToplamGun = Math.max(1, Math.round((bitis - baslangic) / 86400000));
  const kalanYuzdeToplam = kalanlar.reduce((t, a) => {
    const def = IS_ADIMLARI.find(x => x.ad === a.ad); return t + (def ? def.yuzde : 0);
  }, 0) || 1;

  let imlec = new Date(baslangic);
  const yeniKalanlar = kalanlar.map(a => {
    const def = IS_ADIMLARI.find(x => x.ad === a.ad);
    const gun = Math.round(kalanToplamGun * (def ? def.yuzde : 0) / kalanYuzdeToplam);
    const bas = new Date(imlec); const bit = new Date(imlec); bit.setDate(bit.getDate() + gun);
    imlec = new Date(bit);
    return { ...a, baslangic: fmt(bas), bitis: fmt(bit), gun };
  });

  plan.adimlar = plan.adimlar.map(a => a.durum === 'bitti' ? a : (yeniKalanlar.find(k => k.ad === a.ad) || a));
  plan.bitis = fmt(bitis);
  const planBas = parseTR(plan.adimlar[0].baslangic);
  plan.toplamGun = Math.max(1, Math.round((bitis - planBas) / 86400000));
  return plan;
}

module.exports = { createAgentRouter };