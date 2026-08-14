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

// ---- TOPLANTI: server.js POST /api/meetings ile BİREBİR aynı yetki kuralları ----
// Toplantı talebi oluşturabilen roller
const TOPLANTI_YAZMA_ROLLERI = ['ENGINEER', 'LEADER', 'MANAGER', 'ADMIN', 'HR'];
// Hangi rol, hangi rolleri toplantıya çağırabilir (server.js ALLOWED_TARGETS ile aynı)
const TOPLANTI_HEDEF_ROLLERI = {
  LEADER:   ['INTERN', 'TECHNICIAN', 'ENGINEER', 'LEADER'],
  MANAGER:  ['INTERN', 'TECHNICIAN', 'ENGINEER', 'LEADER'],
  ADMIN:    ['MANAGER', 'LEADER', 'ENGINEER'],
  HR:       ['MANAGER', 'LEADER', 'ENGINEER'],
  ENGINEER: ['INTERN']
};
// Birim seçmek zorunda olan (başka birime de toplantı açabilen) roller
const TOPLANTI_CROSS_DEPT_ROLLERI = ['ADMIN', 'HR', 'MANAGER', 'LEADER', 'ENGINEER'];

// ---- GÖREV: server.js ile birebir aynı yetki kuralları ----
// Yeni görev oluşturabilen roller (server.js POST /api/tasks ile aynı)
const GOREV_OLUSTURMA_ROLLERI = ['ADMIN', 'HR', 'MANAGER', 'LEADER', 'ENGINEER', 'INTERN'];
// Görevi inceleyebilen (onay/revize) roller (server.js PUT /tasks/:id/review ile aynı)
const GOREV_INCELEME_ROLLERI = ['ADMIN', 'HR', 'MANAGER', 'LEADER', 'ENGINEER'];

// ---- TOPLANTI ONAYI + GÜNLÜK NOT: server.js ile aynı kurallar ----
// Toplantı talebini onaylayabilen/reddedebilen roller (server.js PUT /meetings/:id/review)
const TOPLANTI_INCELEME_ROLLERI = ['MANAGER', 'LEADER', 'ADMIN', 'HR'];
// Rol hiyerarşisi (server.js ROLE_HIERARCHY ile aynı; ADMIN/HR bu listenin DIŞINDA, hiyerarşi üstü)
const ROL_HIYERARSISI = ['MANAGER', 'LEADER', 'ENGINEER', 'TECHNICIAN', 'INTERN'];

// ---- PROJE MODÜLÜ: server.js ile aynı kurallar ----
// Firma/proje oluşturabilen roller (Admin/İK her birim; Müdür/Ekip Lideri kendi birimi)
const PROJE_YAZMA_ROLLERI = ['ADMIN', 'HR', 'MANAGER', 'LEADER'];
// Birim-kilitli roller: kendi biriminden başka birim seçemez (server.js isDeptLockedRole)
function birimKilitliMi(role) { return role === 'MANAGER' || role === 'LEADER'; }
// server.js todayISO ile aynı (YYYY-MM-DD)
function agentTodayISO() { return new Date().toISOString().substring(0, 10); }

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

// server.js'teki nowTurkeyLocal ile birebir aynı biçim (UTC+3, "YYYY-MM-DD HH:MM:SS")
function agentNowTurkeyLocal() {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);
}

// server.js'teki createNotification/notifyUsers ile aynı tabloya yazar. Hatayı yutar ki
// asıl işlem (toplantı oluşturma) bildirim yüzünden bozulmasın. db, dış kapsamdan gelir.
function makeAgentNotifyUsers(db) {
  return async function agentNotifyUsers(userIds, type, box, title, message, refId) {
    const uniqueIds = [...new Set((userIds || []).filter(Boolean).map(Number))];
    for (const uid of uniqueIds) {
      if (!uid) continue;
      try {
        await db.execute({
          sql: `INSERT INTO notifications (user_id, type, box, title, message, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [uid, type, box, title, message || null, refId != null ? refId : null, agentNowTurkeyLocal()]
        });
      } catch (e) {
        console.error('Ajan bildirimi oluşturulamadı:', e.message);
      }
    }
  };
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
- Araçları YALNIZCA kullanıcı gerçekten görev listeleme, atama, tarih/durum değiştirme, risk, atama önerisi, özet, geçmiş görev araması veya TOPLANTI oluşturma istediğinde çağır.
- Bir işlem yapman istendiğinde uygun aracı çağır; veriyi UYDURMA.
- Bir görevi güncellemeden/atamadan önce doğru görevi bulduğundan emin ol; şüphedeysen kullanıcıya sor.
- TOPLANTI: Kullanıcı "toplantı oluştur / X ile toplantı ayarla / şunları toplantıya çağır" derse toplanti_olustur aracını kullan. Belirli bir kişiyi (ör. "Ayberk") çağırman istenirse ÖNCE is_yuku_ozeti aracını çağırıp o ismin kullaniciId değerini bul, sonra toplanti_olustur'u hedefKullaniciIds ile çağır. Konu belirtilmemişse kullanıcıya kısaca konuyu sor. Kişinin ismi listede yoksa uydurma; bulunamadığını söyle. Toplantı oluşturma bir onay kartıyla kullanıcıya doğrulatılır, sen sadece aracı çağır.
- GÖREV OLUŞTURMA: "yeni görev aç / X kişisine görev ver" denince gorev_olustur aracını kullan. Kişi ID'sini bilmiyorsan önce is_yuku_ozeti ile bul. İsim listede yoksa uydurma.
- GÖREV TAMAMLAMA: "şu görevi tamamladım/bitirdim" denince gorev_tamamla aracını kullan. Hangi görev olduğu belirsizse önce gorevleri_listele ile doğru görevi bul.
- GÖREV İNCELEME: "şu görevi onayla" ya da "revize iste/geri gönder" denince gorev_incele aracını (islem: ONAYLA veya REVIZE) kullan. Revize isteniyorsa mutlaka bir açıklama iste; açıklama yoksa kullanıcıya sor.
- TOPLANTI ONAYI: "şu toplantı talebini onayla/reddet" denince toplanti_incele aracını (islem: ONAYLA veya REDDET) kullan. Hangi talep olduğu belirsizse önce toplantilari_listele ile bekleyen talepleri göster ve doğru toplantiId'yi bul.
- GÜNLÜK NOT: "bugün şunu yaptım", "şu göreve günlük not ekle" denince gunluk_not_ekle aracını kullan. Hangi göreve ekleneceği belirsizse önce gorevleri_listele ile kullanıcının görevlerini göster.
- FİRMA/PROJE: "yeni firma ekle" denince firma_olustur; "yeni proje aç" denince proje_olustur aracını kullan. Proje için firmaId gerekir; bilinmiyorsa önce firmalari_listele ile bul. Proje başlangıç ve bitiş tarihi zorunludur, yoksa kullanıcıya sor.
- İLERLEME: "projeye ilerleme kaydı gir" denince ilerleme_ekle aracını kullan. projeId bilinmiyorsa önce projeleri_listele ile bul. İlerlemeyi yalnızca Admin/İK veya projenin sorumlusu ekleyebilir.`;

  if (role === 'ENGINEER' || role === 'TECHNICIAN') {
    return `${ortak}

ÜSLUP (Mühendis): Teknik ve pragmatik ol. Aşama girdilerine, teslim sürelerine ve
takvimdeki sıkışıklığa odaklan. Kısa, uygulanabilir öneriler ver.`;
  }
  if (role === 'INTERN') {
    return `${ortak}

ÜSLUP (Stajyer): Sade ve yönlendirici ol. Yalnızca kendi görevlerini görebildiğini
unutma; başkasına görev atama veya toplantı oluşturma gibi yetkin yok, bu tür
istekleri kibarca reddet.`;
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
  },
  toplanti_olustur: {
    yazma: true,
    yetki: TOPLANTI_YAZMA_ROLLERI,
    tanim: {
      type: 'function',
      function: {
        name: 'toplanti_olustur',
        description: 'Yeni bir toplantı talebi oluşturur ve seçilen kişileri/rolleri toplantıya çağırır (onlara bildirim düşer). Kullanıcı "toplantı oluştur", "X ile toplantı ayarla", "şu kişileri toplantıya çağır" dediğinde kullan. Belirli kişileri çağırmak için önce is_yuku_ozeti aracıyla o kişilerin kullaniciId değerlerini öğren, sonra hedefKullaniciIds içine koy. Kişi yerine tüm bir rolü çağırmak istenirse hedefRoller kullan.',
        parameters: {
          type: 'object',
          properties: {
            konu: { type: 'string', description: 'Toplantının konusu/başlığı (zorunlu).' },
            tarih: { type: 'string', description: 'YYYY-MM-DD biçiminde tercih edilen tarih (isteğe bağlı).' },
            aciklama: { type: 'string', description: 'Toplantı açıklaması / gündem (isteğe bağlı).' },
            birim: { type: 'string', description: 'Toplantının hedef birimi (department key). Belirtilmezse kullanıcının kendi birimi kullanılır.' },
            hedefKullaniciIds: {
              type: 'array',
              items: { type: 'integer' },
              description: 'Toplantıya çağrılacak belirli kişilerin kullaniciId listesi. Tek tek kişi çağırmak için bunu kullan.'
            },
            hedefRoller: {
              type: 'array',
              items: { type: 'string' },
              description: 'Kişi yerine bütün bir rolü çağırmak için rol listesi (ör. ["INTERN"]).'
            }
          },
          required: ['konu']
        }
      }
    }
  },
  gorev_olustur: {
    yazma: true,
    yetki: GOREV_OLUSTURMA_ROLLERI,
    tanim: {
      type: 'function',
      function: {
        name: 'gorev_olustur',
        description: 'Sıfırdan yeni bir görev oluşturur ve bir kişiye atar. Kullanıcı "yeni görev aç", "X kişisine görev ver", "şu işi ata" dediğinde kullan. Kime atanacağını bilmiyorsan önce is_yuku_ozeti aracıyla kişilerin kullaniciId değerlerini öğren. Stajyer (INTERN) yalnızca kendine görev ekleyebilir.',
        parameters: {
          type: 'object',
          properties: {
            baslik: { type: 'string', description: 'Görev başlığı (zorunlu).' },
            atananKullaniciId: { type: 'integer', description: 'Görevin atanacağı kullanıcının kimliği (zorunlu).' },
            aciklama: { type: 'string', description: 'Görev açıklaması (isteğe bağlı).' },
            kategori: { type: 'string', description: 'Görev kategorisi (isteğe bağlı).' },
            bitisTarihi: { type: 'string', description: 'YYYY-MM-DD biçiminde son teslim tarihi (isteğe bağlı).' },
            calismaGunu: { type: 'integer', description: 'Tahmini iş günü sayısı (isteğe bağlı).' }
          },
          required: ['baslik', 'atananKullaniciId']
        }
      }
    }
  },
  gorev_tamamla: {
    yazma: true,
    // Görevi tamamlandı işaretlemek: server.js /complete ucunda ayrı bir rol listesi yok;
    // pratikte görevi olan herkes kendi görevini tamamlar. Yazma aracı olarak yetkiyi
    // görev sahipliğiyle (execute içinde) sınırlıyoruz; burada geniş tutup execute'ta daraltıyoruz.
    yetki: ['ADMIN', 'HR', 'MANAGER', 'LEADER', 'ENGINEER', 'TECHNICIAN', 'INTERN'],
    tanim: {
      type: 'function',
      function: {
        name: 'gorev_tamamla',
        description: 'Bir görevi "tamamlandı (onay bekliyor)" olarak işaretler. Kullanıcı "şu görevi tamamladım", "bitirdim" dediğinde kullan. Sadece kendi görevini tamamlayabilir (yönetici olmayanlar için).',
        parameters: {
          type: 'object',
          properties: { gorevId: { type: 'integer', description: 'Tamamlanacak görevin kimliği.' } },
          required: ['gorevId']
        }
      }
    }
  },
  gorev_incele: {
    yazma: true,
    yetki: GOREV_INCELEME_ROLLERI,
    tanim: {
      type: 'function',
      function: {
        name: 'gorev_incele',
        description: 'Tamamlanmış bir görevi onaylar veya revize ister. Kullanıcı "şu görevi onayla" ya da "revize iste / geri gönder" dediğinde kullan. Revize istemek için mutlaka bir not (aciklama) iste.',
        parameters: {
          type: 'object',
          properties: {
            gorevId: { type: 'integer', description: 'İncelenecek görevin kimliği.' },
            islem: { type: 'string', enum: ['ONAYLA', 'REVIZE'], description: 'ONAYLA = onayla, REVIZE = revize iste.' },
            aciklama: { type: 'string', description: 'Revize istenirken zorunlu olan açıklama/not.' }
          },
          required: ['gorevId', 'islem']
        }
      }
    }
  },
  toplanti_incele: {
    yazma: true,
    yetki: TOPLANTI_INCELEME_ROLLERI,
    tanim: {
      type: 'function',
      function: {
        name: 'toplanti_incele',
        description: 'Bekleyen bir toplantı talebini onaylar veya reddeder. Kullanıcı "şu toplantı talebini onayla / reddet" dediğinde kullan. Hangi talep olduğu belirsizse önce toplantilari_listele ile bekleyen talepleri göster.',
        parameters: {
          type: 'object',
          properties: {
            toplantiId: { type: 'integer', description: 'İncelenecek toplantı talebinin kimliği.' },
            islem: { type: 'string', enum: ['ONAYLA', 'REDDET'], description: 'ONAYLA = onayla, REDDET = reddet.' },
            aciklama: { type: 'string', description: 'İsteğe bağlı inceleme notu.' }
          },
          required: ['toplantiId', 'islem']
        }
      }
    }
  },
  toplantilari_listele: {
    yazma: false,
    yetki: TOPLANTI_INCELEME_ROLLERI,
    tanim: {
      type: 'function',
      function: {
        name: 'toplantilari_listele',
        description: 'İncelenebilecek (özellikle bekleyen) toplantı taleplerini listeler. Kullanıcı toplantı onaylamak/reddetmek istediğinde doğru talebi bulmak için kullan.',
        parameters: {
          type: 'object',
          properties: {
            durum: { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED'], description: 'İsteğe bağlı durum filtresi; varsayılan bekleyenler (PENDING).' }
          }
        }
      }
    }
  },
  gunluk_not_ekle: {
    yazma: true,
    // Günlük not: görevi olan herkes kendi görevine not düşebilir. Yetkiyi execute'ta
    // görev sahipliği/birim ile daraltıyoruz; burada geniş tutuyoruz.
    yetki: ['ADMIN', 'HR', 'MANAGER', 'LEADER', 'ENGINEER', 'TECHNICIAN', 'INTERN'],
    tanim: {
      type: 'function',
      function: {
        name: 'gunluk_not_ekle',
        description: 'Bir göreve bugünkü günlük bilgilendirme/çalışma notunu ekler. Kullanıcı "bugün şunu yaptım", "şu göreve not düş", "günlük notumu gir" dediğinde kullan. Hangi göreve ekleneceği belirsizse önce gorevleri_listele ile kullanıcının görevlerini göster.',
        parameters: {
          type: 'object',
          properties: {
            gorevId: { type: 'integer', description: 'Notun ekleneceği görevin kimliği.' },
            not: { type: 'string', description: 'Not metni (zorunlu).' }
          },
          required: ['gorevId', 'not']
        }
      }
    }
  },
  firmalari_listele: {
    yazma: false,
    yetki: PROJE_YAZMA_ROLLERI,
    tanim: {
      type: 'function',
      function: {
        name: 'firmalari_listele',
        description: 'Kayıtlı firmaları listeler. Proje oluştururken doğru firmaId değerini bulmak için kullan.',
        parameters: { type: 'object', properties: {} }
      }
    }
  },
  projeleri_listele: {
    yazma: false,
    yetki: PROJE_YAZMA_ROLLERI,
    tanim: {
      type: 'function',
      function: {
        name: 'projeleri_listele',
        description: 'Projeleri listeler. İlerleme kaydı eklerken doğru projeId değerini bulmak için kullan.',
        parameters: { type: 'object', properties: {} }
      }
    }
  },
  firma_olustur: {
    yazma: true,
    yetki: PROJE_YAZMA_ROLLERI,
    tanim: {
      type: 'function',
      function: {
        name: 'firma_olustur',
        description: 'Yeni bir firma (müşteri) kaydı oluşturur. Kullanıcı "yeni firma ekle" dediğinde kullan. Admin/İK birim seçebilir; Müdür/Ekip Lideri kendi birimine ekler.',
        parameters: {
          type: 'object',
          properties: {
            ad: { type: 'string', description: 'Firma adı (zorunlu).' },
            birim: { type: 'string', description: 'Birim (department key). Sadece Admin/İK için anlamlı; belirtilmezse uygun varsayılan kullanılır.' }
          },
          required: ['ad']
        }
      }
    }
  },
  proje_olustur: {
    yazma: true,
    yetki: PROJE_YAZMA_ROLLERI,
    tanim: {
      type: 'function',
      function: {
        name: 'proje_olustur',
        description: 'Bir firmaya bağlı yeni proje oluşturur. Kullanıcı "yeni proje aç" dediğinde kullan. firmaId bilinmiyorsa önce firmalari_listele ile bul. Başlangıç ve bitiş tarihi zorunludur.',
        parameters: {
          type: 'object',
          properties: {
            firmaId: { type: 'integer', description: 'Projenin bağlı olduğu firmanın kimliği (zorunlu).' },
            ad: { type: 'string', description: 'Proje adı (zorunlu).' },
            baslangicTarihi: { type: 'string', description: 'YYYY-MM-DD başlangıç tarihi (zorunlu).' },
            bitisTarihi: { type: 'string', description: 'YYYY-MM-DD bitiş tarihi (zorunlu).' },
            birim: { type: 'string', description: 'Birim (department key). Sadece Admin/İK için; Müdür/Lider kendi birimine açar.' },
            sorumluId: { type: 'integer', description: 'Projeden sorumlu kişinin kullaniciId değeri (isteğe bağlı).' },
            oncelik: { type: 'string', description: 'Öncelik (ör. NORMAL, YUKSEK). İsteğe bağlı, varsayılan NORMAL.' },
            not: { type: 'string', description: 'İsteğe bağlı proje notu.' }
          },
          required: ['firmaId', 'ad', 'baslangicTarihi', 'bitisTarihi']
        }
      }
    }
  },
  ilerleme_ekle: {
    yazma: true,
    // Admin/İK VEYA projenin sahibi ekleyebilir. Yetki execute'ta sahiplik ile daraltılır;
    // burada geniş tutuyoruz ki proje sahibi bir mühendis de kullanabilsin.
    yetki: ['ADMIN', 'HR', 'MANAGER', 'LEADER', 'ENGINEER', 'TECHNICIAN', 'INTERN'],
    tanim: {
      type: 'function',
      function: {
        name: 'ilerleme_ekle',
        description: 'Bir projeye ilerleme (gidişat) noktası ekler. Kullanıcı "projeye ilerleme kaydı gir", "planlanan/gerçekleşen değerleri ekle" dediğinde kullan. Yalnızca Admin/İK veya projenin sorumlusu ekleyebilir. projeId bilinmiyorsa önce projeleri_listele ile bul.',
        parameters: {
          type: 'object',
          properties: {
            projeId: { type: 'integer', description: 'İlerleme eklenecek projenin kimliği (zorunlu).' },
            tarih: { type: 'string', description: 'YYYY-MM-DD ilerleme tarihi (zorunlu).' },
            planlanan: { type: 'integer', description: 'Planlanan yüzde/değer (isteğe bağlı, varsayılan 0).' },
            gerceklesen: { type: 'integer', description: 'Gerçekleşen yüzde/değer (isteğe bağlı, varsayılan 0).' },
            not: { type: 'string', description: 'İsteğe bağlı not.' }
          },
          required: ['projeId', 'tarih']
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

  // Toplantı bildirimlerini server.js ile aynı tabloya yazan yardımcı (db'ye bağlı)
  const agentNotifyUsers = makeAgentNotifyUsers(db);

  // Sohbet geçmişini ai_sohbet_gecmisi tablosuna yazar (ai.js initAiSchema tabloyu oluşturur).
  // Hatayı yutar ki geçmiş kaydedilemese bile kullanıcı yanıtı almaya devam etsin.
  async function sohbetKaydet(userId, role, content) {
    if (!userId || !content) return;
    try {
      await db.execute({
        sql: `INSERT INTO ai_sohbet_gecmisi (user_id, role, content, created_at) VALUES (?, ?, ?, ?)`,
        args: [userId, role, String(content).slice(0, 4000), agentNowTurkeyLocal()]
      });
    } catch (e) { console.error('Sohbet geçmişi kaydedilemedi:', e.message); }
  }

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
    if (name === 'toplantilari_listele') {
      try {
        const durum = ['PENDING', 'APPROVED', 'REJECTED'].includes(args.durum) ? args.durum : 'PENDING';
        let sql = `SELECT meeting_requests.id, meeting_requests.subject, meeting_requests.department,
                          meeting_requests.preferred_date, meeting_requests.status,
                          u.name AS requester_name, u.role AS requester_role
                   FROM meeting_requests LEFT JOIN users u ON u.id = meeting_requests.requested_by`;
        const conditions = [`meeting_requests.status = ?`];
        const sqlArgs = [durum];
        // Müdür/Ekip Lideri yalnızca kendi biriminin taleplerini; Admin/İK hepsini görür
        if (!isAdmin(user.role) && user.department) {
          conditions.push(`meeting_requests.department = ?`);
          sqlArgs.push(user.department);
        }
        sql += ` WHERE ` + conditions.join(' AND ') + ` ORDER BY meeting_requests.id DESC LIMIT 40`;
        const r = await db.execute({ sql, args: sqlArgs });
        return r.rows.map(m => ({
          toplantiId: m.id, konu: m.subject, birim: m.department, tarih: m.preferred_date,
          durum: m.status, talepEden: m.requester_name || '?', talepEdenRol: m.requester_role
        }));
      } catch (e) { return { hata: 'Toplantılar listelenemedi: ' + e.message }; }
    }
    if (name === 'firmalari_listele') {
      try {
        let sql = `SELECT id, name, department FROM companies`;
        const sqlArgs = [];
        // Müdür/Ekip Lideri yalnızca kendi biriminin (veya birimsiz/genel) firmalarını görür
        if (birimKilitliMi(user.role) && user.department) {
          sql += ` WHERE department = ? OR department IS NULL`;
          sqlArgs.push(user.department);
        }
        sql += ` ORDER BY name ASC LIMIT 100`;
        const r = await db.execute({ sql, args: sqlArgs });
        return r.rows.map(c => ({ firmaId: c.id, ad: c.name, birim: c.department }));
      } catch (e) { return { hata: 'Firmalar listelenemedi: ' + e.message }; }
    }
    if (name === 'projeleri_listele') {
      try {
        let sql = `SELECT projects.id, projects.name, projects.department, projects.status,
                          projects.owner_id, u.name AS owner_name, c.name AS company_name
                   FROM projects
                   LEFT JOIN users u ON u.id = projects.owner_id
                   LEFT JOIN companies c ON c.id = projects.company_id`;
        const sqlArgs = [];
        if (birimKilitliMi(user.role) && user.department) {
          sql += ` WHERE projects.department = ?`;
          sqlArgs.push(user.department);
        }
        sql += ` ORDER BY projects.id DESC LIMIT 100`;
        const r = await db.execute({ sql, args: sqlArgs });
        return r.rows.map(p => ({
          projeId: p.id, ad: p.name, firma: p.company_name, birim: p.department,
          durum: p.status, sorumluId: p.owner_id, sorumlu: p.owner_name || '—'
        }));
      } catch (e) { return { hata: 'Projeler listelenemedi: ' + e.message }; }
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
    if (name === 'toplanti_olustur') {
      const parcalar = [`"${args.konu || '(konu yok)'}" konulu bir toplantı talebi oluşturulacak`];
      if (args.tarih) parcalar.push(`tarih: ${args.tarih}`);
      // Çağrılacak kişilerin isimlerini kart için çöz
      const ids = Array.isArray(args.hedefKullaniciIds) ? args.hedefKullaniciIds.map(Number).filter(Number.isInteger) : [];
      if (ids.length) {
        const ph = ids.map(() => '?').join(',');
        const u = await db.execute({ sql: `SELECT name FROM users WHERE id IN (${ph})`, args: ids });
        const isimler = u.rows.map(r => r.name).filter(Boolean);
        if (isimler.length) parcalar.push(`çağrılacak kişiler: ${isimler.join(', ')}`);
      }
      const roller = Array.isArray(args.hedefRoller) ? args.hedefRoller.filter(Boolean) : [];
      if (roller.length) parcalar.push(`çağrılacak roller: ${roller.join(', ')}`);
      return parcalar.join('; ') + '. Çağrılan kişilere bildirim gidecek. Onaylıyor musunuz?';
    }
    if (name === 'gorev_olustur') {
      const u = await db.execute({ sql: `SELECT name FROM users WHERE id = ?`, args: [args.atananKullaniciId] });
      const kisi = u.rows[0] ? u.rows[0].name : ('#' + args.atananKullaniciId);
      const parca = [`"${args.baslik || '(başlık yok)'}" başlıklı yeni görev ${kisi} kişisine atanacak`];
      if (args.bitisTarihi) parca.push(`son teslim: ${args.bitisTarihi}`);
      if (args.kategori) parca.push(`kategori: ${args.kategori}`);
      return parca.join('; ') + '. Onaylıyor musunuz?';
    }
    if (name === 'gorev_tamamla') {
      const t = await db.execute({ sql: `SELECT title FROM tasks WHERE id = ?`, args: [args.gorevId] });
      const baslik = t.rows[0] ? t.rows[0].title : ('#' + args.gorevId);
      return `"${baslik}" görevi "tamamlandı (onay bekliyor)" olarak işaretlenecek. Onaylıyor musunuz?`;
    }
    if (name === 'gorev_incele') {
      const t = await db.execute({ sql: `SELECT title FROM tasks WHERE id = ?`, args: [args.gorevId] });
      const baslik = t.rows[0] ? t.rows[0].title : ('#' + args.gorevId);
      if (args.islem === 'REVIZE') {
        return `"${baslik}" görevi için revize istenecek. Not: ${args.aciklama || '(not girilmedi)'}. Onaylıyor musunuz?`;
      }
      return `"${baslik}" görevi ONAYLANACAK. Onaylıyor musunuz?`;
    }
    if (name === 'toplanti_incele') {
      const m = await db.execute({ sql: `SELECT subject FROM meeting_requests WHERE id = ?`, args: [args.toplantiId] });
      const konu = m.rows[0] ? m.rows[0].subject : ('#' + args.toplantiId);
      const fiil = args.islem === 'REDDET' ? 'REDDEDİLECEK' : 'ONAYLANACAK';
      const notk = args.aciklama ? ` Not: ${args.aciklama}.` : '';
      return `"${konu}" toplantı talebi ${fiil}.${notk} Talep edene bildirim gidecek. Onaylıyor musunuz?`;
    }
    if (name === 'gunluk_not_ekle') {
      const t = await db.execute({ sql: `SELECT title FROM tasks WHERE id = ?`, args: [args.gorevId] });
      const baslik = t.rows[0] ? t.rows[0].title : ('#' + args.gorevId);
      const kisa = String(args.not || '').slice(0, 80);
      return `"${baslik}" görevine bugünkü not eklenecek: "${kisa}${String(args.not||'').length > 80 ? '…' : ''}". Onaylıyor musunuz?`;
    }
    if (name === 'firma_olustur') {
      return `"${String(args.ad || '').trim()}" adlı yeni firma kaydı oluşturulacak. Onaylıyor musunuz?`;
    }
    if (name === 'proje_olustur') {
      const c = await db.execute({ sql: `SELECT name FROM companies WHERE id = ?`, args: [args.firmaId] });
      const firma = c.rows[0] ? c.rows[0].name : ('#' + args.firmaId);
      const parca = [`"${String(args.ad || '').trim()}" projesi ${firma} firmasına bağlı olarak oluşturulacak`];
      if (args.baslangicTarihi && args.bitisTarihi) parca.push(`süre: ${args.baslangicTarihi} → ${args.bitisTarihi}`);
      if (args.sorumluId) {
        const u = await db.execute({ sql: `SELECT name FROM users WHERE id = ?`, args: [args.sorumluId] });
        if (u.rows[0]) parca.push(`sorumlu: ${u.rows[0].name}`);
      }
      return parca.join('; ') + '. Onaylıyor musunuz?';
    }
    if (name === 'ilerleme_ekle') {
      const p = await db.execute({ sql: `SELECT name FROM projects WHERE id = ?`, args: [args.projeId] });
      const proje = p.rows[0] ? p.rows[0].name : ('#' + args.projeId);
      const pl = Number.isInteger(Number(args.planlanan)) ? Number(args.planlanan) : 0;
      const ge = Number.isInteger(Number(args.gerceklesen)) ? Number(args.gerceklesen) : 0;
      return `"${proje}" projesine ${args.tarih} tarihli ilerleme eklenecek (planlanan: ${pl}, gerçekleşen: ${ge}). Onaylıyor musunuz?`;
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
      sohbetKaydet(userId, 'user', message);

      // Araç döngüsü: okuma araçlarını çalıştır, yazma gelirse dur ve onay iste.
      // Herhangi bir aşamada Mistral tool isteği patlarsa, kullanıcıyı boş bırakmamak için
      // araçsız düz sohbete düşüp yine de bir cevap döndürürüz.
      try {
        const MAX_TUR = 4;
        for (let tur = 0; tur < MAX_TUR; tur++) {
          const ai = await mistralWithTools(messages, tools);
          const toolCalls = ai.tool_calls || [];

          if (!toolCalls.length) {
            const cevap = (ai.content || 'Bir yanıt üretemedim.').trim();
            sohbetKaydet(userId, 'assistant', cevap);
            return res.json({ reply: cevap });
          }

          // Model asistan mesajını (tool_calls ile) geçmişe ekle
          messages.push({ role: 'assistant', content: ai.content || '', tool_calls: toolCalls });

          // YAZMA aracı var mı? İlkini onaya çıkar (birden fazla yazmayı tek turda yapmayız)
          const yazma = toolCalls.find(tc => aracYazmaMi(tc.function.name));
          if (yazma) {
            if (!aracYetkiliMi(yazma.function.name, role)) {
              const cevap = 'Bu işlem için yetkiniz bulunmuyor.';
              sohbetKaydet(userId, 'assistant', cevap);
              return res.json({ reply: cevap });
            }
            let args = {};
            try { args = JSON.parse(yazma.function.arguments || '{}'); } catch (e) {}
            const ozet = await yazmaOzeti(yazma.function.name, args);
            sohbetKaydet(userId, 'assistant', ozet);
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
        const zamanAsimi = 'İşlem uzadı, lütfen isteğinizi biraz daha netleştirin.';
        sohbetKaydet(userId, 'assistant', zamanAsimi);
        return res.json({ reply: zamanAsimi });
      } catch (toolHata) {
        // Tool yolu başarısız (ör. Mistral araç formatı/servis hatası) → araçsız düz cevaba düş
        console.error('Ajan tool yolu hatası, düz sohbete düşülüyor:', toolHata.message);
        const duzMesajlar = messages.filter(m => m.role === 'system' || m.role === 'user' || (m.role === 'assistant' && !m.tool_calls));
        const cevap = await duzSohbet(duzMesajlar);
        const nihaiCevap = cevap || 'Şu an araç tabanlı işlemlerde bir sorun var, ama buradayım. Sorunuzu tekrar yazar mısınız?';
        sohbetKaydet(userId, 'assistant', nihaiCevap);
        return res.json({ reply: nihaiCevap });
      }
    } catch (error) {
      console.error('Ajan genel hatası:', error.message);
      res.status(500).json({ error: 'Ajan hatası: ' + error.message });
    }
  });

  // ============================================================
  // GET /api/agent/chat/history?userId=... — kayıtlı sohbet geçmişini getirir (son 40 mesaj)
  // DELETE /api/agent/chat/history — kullanıcının sohbet geçmişini temizler (yeni sohbet)
  // ============================================================
  router.get('/agent/chat/history', async (req, res) => {
    try {
      const userId = req.query.userId;
      if (!userId) return res.status(400).json({ error: 'userId gerekli.' });
      const r = await db.execute({
        sql: `SELECT role, content, created_at FROM ai_sohbet_gecmisi WHERE user_id = ? ORDER BY id DESC LIMIT 40`,
        args: [userId]
      });
      res.json({ history: r.rows.reverse() });
    } catch (error) {
      res.status(500).json({ error: 'Sohbet geçmişi alınamadı: ' + error.message });
    }
  });

  router.delete('/agent/chat/history', async (req, res) => {
    try {
      const userId = req.body ? req.body.userId : null;
      if (!userId) return res.status(400).json({ error: 'userId gerekli.' });
      await db.execute({ sql: `DELETE FROM ai_sohbet_gecmisi WHERE user_id = ?`, args: [userId] });
      res.json({ message: 'Sohbet geçmişi temizlendi.' });
    } catch (error) {
      res.status(500).json({ error: 'Sohbet geçmişi temizlenemedi: ' + error.message });
    }
  });

  // ============================================================
  // POST /api/agent/execute — Onaylanan YAZMA işlemini uygular (yetki TEKRAR kontrol edilir)
  // Body: { userId, name, role, department, action: { name, args } }
  // ============================================================
  router.post('/agent/execute', async (req, res) => {
    // Bu uçtaki her dönüş noktası ayrı ayrı düzenlenmeden, oluşan "reply" alanını
    // otomatik olarak sohbet geçmişine yazmak için res.json sarmalanır.
    const executeUserId = req.body ? req.body.userId : null;
    const cevapDonduMu = res.json.bind(res);
    res.json = (payload) => {
      if (payload && payload.reply) sohbetKaydet(executeUserId, 'assistant', payload.reply);
      return cevapDonduMu(payload);
    };
    try {
      const { userId, name, role, department, action } = req.body;
      if (!action || !action.name) return res.status(400).json({ error: 'İşlem bilgisi eksik.' });
      if (!aracYazmaMi(action.name)) return res.status(400).json({ error: 'Bu uç yalnızca yazma işlemleri içindir.' });
      if (!aracYetkiliMi(action.name, role)) return res.status(403).json({ error: 'Bu işlem için yetkiniz yok.' });

      const args = action.args || {};

      // --- toplanti_olustur ---------------------------------------------------
      // Görevle ilgisi yok; kendi doğrulamasını yapıp erken döner (aşağıdaki görev
      // sorgusuna DÜŞMEZ). Yetki/hedef kuralları server.js POST /api/meetings ile aynı.
      if (action.name === 'toplanti_olustur') {
        if (!args.konu || !String(args.konu).trim()) {
          return res.status(400).json({ error: 'Toplantı konusu zorunludur.' });
        }
        if (args.tarih && !/^\d{4}-\d{2}-\d{2}$/.test(String(args.tarih))) {
          return res.status(400).json({ error: 'Tarih YYYY-AA-GG biçiminde olmalı.' });
        }

        // Birimi belirle: cross-dept roller birim seçebilir; seçmezse kendi birimi.
        let hedefBirim = null;
        if (TOPLANTI_CROSS_DEPT_ROLLERI.includes(role)) {
          hedefBirim = args.birim || department || null;
          if (!hedefBirim) return res.status(400).json({ error: 'Lütfen bir birim belirtin.' });
        } else {
          const ur = await db.execute({ sql: `SELECT department FROM users WHERE id = ?`, args: [userId] });
          if (!ur.rows[0]) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
          hedefBirim = ur.rows[0].department;
        }

        // Hedef rolleri yetkiye göre filtrele (server.js ile aynı)
        const izinliRoller = TOPLANTI_HEDEF_ROLLERI[role] || [];
        let rolesArr = Array.isArray(args.hedefRoller) ? args.hedefRoller.map(r => String(r).trim()).filter(Boolean) : [];
        rolesArr = rolesArr.filter(r => izinliRoller.includes(r));

        // Belirli kişiler: yalnızca izinli rollerden VE bu birimden olanlar (sunucu doğrulaması)
        let idsArr = Array.isArray(args.hedefKullaniciIds) ? args.hedefKullaniciIds.map(Number).filter(Number.isInteger) : [];
        if (idsArr.length > 0 && izinliRoller.length > 0) {
          const ph = idsArr.map(() => '?').join(',');
          const rolePh = izinliRoller.map(() => '?').join(',');
          const vr = await db.execute({
            sql: `SELECT id FROM users WHERE id IN (${ph}) AND department = ? AND role IN (${rolePh}) AND status = 'APPROVED'`,
            args: [...idsArr, hedefBirim, ...izinliRoller]
          });
          const gecerli = new Set(vr.rows.map(r => Number(r.id)));
          idsArr = idsArr.filter(id => gecerli.has(id));
        } else {
          idsArr = [];
        }

        if (rolesArr.length === 0 && idsArr.length === 0) {
          return res.status(400).json({ error: 'Toplantıya çağrılacak geçerli kişi/rol bulunamadı. Yetkiniz dahilinde bir kişi veya rol seçin.' });
        }

        const targetRolesStr = rolesArr.length ? rolesArr.join(',') : null;
        const targetUserIdsStr = idsArr.length ? `,${idsArr.join(',')},` : null;
        const now = agentNowTurkeyLocal();

        const ins = await db.execute({
          sql: `INSERT INTO meeting_requests (requested_by, department, subject, description, preferred_date, status, created_at, target_roles, target_user_ids)
                VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
          args: [userId, hedefBirim || null, String(args.konu).trim(), args.aciklama || null, args.tarih || null, now, targetRolesStr, targetUserIdsStr]
        });
        const yeniId = Number(ins.lastInsertRowid);

        // Çağrılanlara bildirim düş (rol bazlı + tekil seçilenler), talep edeni hariç tut
        try {
          const alicilar = new Set(idsArr);
          if (rolesArr.length) {
            const rolePh = rolesArr.map(() => '?').join(',');
            const ru = await db.execute({
              sql: `SELECT id FROM users WHERE department = ? AND role IN (${rolePh}) AND status = 'APPROVED'`,
              args: [hedefBirim, ...rolesArr]
            });
            ru.rows.forEach(r => alicilar.add(Number(r.id)));
          }
          alicilar.delete(Number(userId));
          await agentNotifyUsers([...alicilar], 'MEETING_REQUEST', 'MEETINGS', 'Yeni Toplantı Talebi', String(args.konu).trim(), yeniId);
        } catch (bildirimHata) {
          console.error('Ajan toplantı bildirimi hatası:', bildirimHata.message);
        }

        return res.json({ reply: `"${String(args.konu).trim()}" konulu toplantı talebi oluşturuldu ve ilgili kişilere iletildi.` });
      }

      // --- gorev_olustur ------------------------------------------------------
      // gorevId yok; kendi doğrulamasını yapıp erken döner. Kurallar server.js POST /api/tasks ile aynı.
      if (action.name === 'gorev_olustur') {
        if (!args.baslik || !String(args.baslik).trim()) {
          return res.status(400).json({ error: 'Görev başlığı zorunludur.' });
        }
        if (!Number.isInteger(Number(args.atananKullaniciId))) {
          return res.status(400).json({ error: 'Geçerli bir atanan kişi seçilmedi.' });
        }
        // Stajyer yalnızca kendine görev ekleyebilir
        if (role === 'INTERN' && Number(args.atananKullaniciId) !== Number(userId)) {
          return res.status(403).json({ error: 'Sadece kendinize görev ekleyebilirsiniz.' });
        }
        if (args.bitisTarihi && !/^\d{4}-\d{2}-\d{2}$/.test(String(args.bitisTarihi))) {
          return res.status(400).json({ error: 'Bitiş tarihi YYYY-AA-GG biçiminde olmalı.' });
        }
        // Atanan kişi: görev alabilecek rolde ve onaylı olmalı (server.js ASSIGNABLE_ROLES)
        const ac = await db.execute({ sql: `SELECT role, status, name, department FROM users WHERE id = ?`, args: [args.atananKullaniciId] });
        const hedef = ac.rows[0];
        if (!hedef || !ATANABILIR_ROLLER.includes(hedef.role) || hedef.status !== 'APPROVED') {
          return res.status(400).json({ error: 'Geçersiz görev atama hedefi.' });
        }
        // Birim güvenliği: yönetici olmayan yalnızca kendi biriminden birine atayabilir
        if (!isAdmin(role) && role !== 'INTERN' && department && hedef.department && hedef.department !== department) {
          return res.status(403).json({ error: 'Bu kişi sizin biriminizde değil.' });
        }
        const ins = await db.execute({
          sql: `INSERT INTO tasks (title, description, assigned_to, category, end_date, work_days, created_by, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'IN_PROGRESS')`,
          args: [String(args.baslik).trim(), args.aciklama || '', args.atananKullaniciId, args.kategori || null,
                 args.bitisTarihi || null, Number.isInteger(Number(args.calismaGunu)) ? Number(args.calismaGunu) : null, name || 'Asistan']
        });
        const yeniGorevId = Number(ins.lastInsertRowid);
        // Atanan kişiye bildirim
        try {
          await agentNotifyUsers([args.atananKullaniciId], 'TASK_ASSIGNED', 'TASKS', 'Yeni Görev Atandı',
            `${name || 'Bir yetkili'} size "${String(args.baslik).trim()}" görevini atadı.`, yeniGorevId);
        } catch (e) { console.error('Ajan görev bildirimi hatası:', e.message); }
        return res.json({ reply: `"${String(args.baslik).trim()}" görevi ${hedef.name} kişisine atandı.` });
      }

      // --- gorev_tamamla ------------------------------------------------------
      // Görevi "COMPLETED" yapar. Yönetici olmayan YALNIZCA kendi görevini tamamlayabilir.
      if (action.name === 'gorev_tamamla') {
        const gr = await db.execute({
          sql: `SELECT tasks.*, u.department AS assignee_dep FROM tasks tasks
                LEFT JOIN users u ON u.id = tasks.assigned_to WHERE tasks.id = ?`,
          args: [args.gorevId]
        });
        const g = gr.rows[0];
        if (!g) return res.status(404).json({ error: 'Görev bulunamadı.' });
        const yonetici = ['ADMIN', 'HR', 'MANAGER', 'LEADER', 'ENGINEER'].includes(role);
        const sahibiMi = Number(g.assigned_to) === Number(userId);
        // Yönetici değilse ve görev kendisinin değilse: yasak. Yönetici ise kendi birimiyle sınırlı.
        if (!yonetici && !sahibiMi) {
          return res.status(403).json({ error: 'Yalnızca kendi görevinizi tamamlandı olarak işaretleyebilirsiniz.' });
        }
        if (yonetici && !isAdmin(role) && department && g.assignee_dep && g.assignee_dep !== department && !sahibiMi) {
          return res.status(403).json({ error: 'Bu görev sizin biriminizde değil.' });
        }
        await db.execute({ sql: `UPDATE tasks SET status = 'COMPLETED' WHERE id = ?`, args: [args.gorevId] });
        return res.json({ reply: `"${g.title}" görevi tamamlandı olarak işaretlendi, onay bekliyor.` });
      }

      // --- gorev_incele (onayla / revize iste) --------------------------------
      if (action.name === 'gorev_incele') {
        if (!['ONAYLA', 'REVIZE'].includes(args.islem)) {
          return res.status(400).json({ error: 'Geçersiz işlem (ONAYLA veya REVIZE olmalı).' });
        }
        const revize = args.islem === 'REVIZE';
        if (revize && (!args.aciklama || !String(args.aciklama).trim())) {
          return res.status(400).json({ error: 'Revize istemek için bir açıklama/not gerekli.' });
        }
        const gr = await db.execute({
          sql: `SELECT tasks.*, u.department AS assignee_dep, u.name AS assignee_name
                FROM tasks tasks LEFT JOIN users u ON u.id = tasks.assigned_to WHERE tasks.id = ?`,
          args: [args.gorevId]
        });
        const g = gr.rows[0];
        if (!g) return res.status(404).json({ error: 'Görev bulunamadı.' });
        // Birim güvenliği: yönetici olmayan (ör. Mühendis) yalnızca kendi birimindeki görevi inceler
        if (!isAdmin(role) && department && g.assignee_dep && g.assignee_dep !== department) {
          return res.status(403).json({ error: 'Bu görev sizin biriminizde değil.' });
        }
        const yeniDurum = revize ? 'REVISION_REQUESTED' : 'APPROVED';
        if (revize) {
          const now = agentNowTurkeyLocal();
          await db.execute({
            sql: `INSERT INTO task_revisions (task_id, revised_by, comment, created_at) VALUES (?, ?, ?, ?)`,
            args: [args.gorevId, name || 'Yetkili', String(args.aciklama).trim(), now]
          });
        }
        await db.execute({
          sql: `UPDATE tasks SET status = ?, review_comment = ? WHERE id = ?`,
          args: [yeniDurum, revize ? String(args.aciklama).trim() : '', args.gorevId]
        });
        // Görev sahibine sonucu bildir
        try {
          if (revize) {
            await agentNotifyUsers([g.assigned_to], 'TASK_REVISION', 'TASKS', 'Revize İstendi',
              `"${g.title}" göreviniz için revize istendi: ${String(args.aciklama).trim()}`, Number(args.gorevId));
          } else {
            await agentNotifyUsers([g.assigned_to], 'TASK_APPROVED', 'TASKS', 'Görev Onaylandı',
              `"${g.title}" göreviniz onaylandı.`, Number(args.gorevId));
          }
        } catch (e) { console.error('Ajan inceleme bildirimi hatası:', e.message); }
        return res.json({ reply: revize ? `"${g.title}" görevi için revize istendi.` : `"${g.title}" görevi onaylandı.` });
      }

      // --- toplanti_incele (toplantı talebini onayla/reddet) ------------------
      // Kurallar server.js PUT /api/meetings/:id/review ile aynı: rol seviyesi + birim.
      if (action.name === 'toplanti_incele') {
        if (!['ONAYLA', 'REDDET'].includes(args.islem)) {
          return res.status(400).json({ error: 'Geçersiz işlem (ONAYLA veya REDDET olmalı).' });
        }
        const yeniDurum = args.islem === 'REDDET' ? 'REJECTED' : 'APPROVED';

        // Talebi + talep edenin rolünü al
        const mr = await db.execute({
          sql: `SELECT meeting_requests.*, u.role AS requester_role
                FROM meeting_requests
                LEFT JOIN users u ON u.id = meeting_requests.requested_by
                WHERE meeting_requests.id = ?`,
          args: [args.toplantiId]
        });
        const m = mr.rows[0];
        if (!m) return res.status(404).json({ error: 'Toplantı talebi bulunamadı.' });

        // Rol seviyesi: inceleyen, talep edenden DAHA DÜŞÜK rolde olamaz (ADMIN/HR hiyerarşi üstü)
        if (!isAdmin(role)) {
          const reqIdx = ROL_HIYERARSISI.indexOf(m.requester_role);
          const myIdx = ROL_HIYERARSISI.indexOf(role);
          if (reqIdx === -1 || myIdx === -1 || myIdx > reqIdx) {
            return res.status(403).json({ error: 'Bu talebi onaylama/reddetme yetkiniz yok.' });
          }
          // Birim kısıtı: yönetici olmayan yalnızca kendi biriminin talebini inceler
          if (department && m.department && m.department !== department) {
            return res.status(403).json({ error: 'Bu talep sizin biriminizde değil.' });
          }
        }

        await db.execute({
          sql: `UPDATE meeting_requests SET status = ?, reviewed_by = ?, review_comment = ? WHERE id = ?`,
          args: [yeniDurum, name || null, args.aciklama || null, args.toplantiId]
        });

        // Talep edene sonucu bildir
        try {
          const onaylandi = yeniDurum === 'APPROVED';
          await agentNotifyUsers([m.requested_by], 'MEETING_REVIEWED', 'MEETINGS',
            onaylandi ? 'Toplantı Talebiniz Onaylandı' : 'Toplantı Talebiniz Reddedildi', m.subject, Number(args.toplantiId));
        } catch (e) { console.error('Ajan toplantı inceleme bildirimi hatası:', e.message); }

        return res.json({ reply: yeniDurum === 'APPROVED' ? `"${m.subject}" toplantı talebi onaylandı.` : `"${m.subject}" toplantı talebi reddedildi.` });
      }

      // --- gunluk_not_ekle ----------------------------------------------------
      // Görevi olan kişi kendi görevine not düşer; yönetici kendi birimindeki göreve.
      if (action.name === 'gunluk_not_ekle') {
        if (!args.not || !String(args.not).trim()) {
          return res.status(400).json({ error: 'Not metni boş olamaz.' });
        }
        const gr = await db.execute({
          sql: `SELECT tasks.*, u.department AS assignee_dep FROM tasks tasks
                LEFT JOIN users u ON u.id = tasks.assigned_to WHERE tasks.id = ?`,
          args: [args.gorevId]
        });
        const g = gr.rows[0];
        if (!g) return res.status(404).json({ error: 'Görev bulunamadı.' });
        const yonetici = ['ADMIN', 'HR', 'MANAGER', 'LEADER', 'ENGINEER'].includes(role);
        const sahibiMi = Number(g.assigned_to) === Number(userId);
        if (!sahibiMi && !yonetici) {
          return res.status(403).json({ error: 'Yalnızca kendi görevinize not ekleyebilirsiniz.' });
        }
        if (yonetici && !isAdmin(role) && !sahibiMi && department && g.assignee_dep && g.assignee_dep !== department) {
          return res.status(403).json({ error: 'Bu görev sizin biriminizde değil.' });
        }
        // Not, işlemi yapan kişinin adına ve bugünün tarihiyle eklenir
        const bugun = new Date().toISOString().split('T')[0];
        await db.execute({
          sql: `INSERT INTO daily_logs (task_id, intern_id, log_date, note) VALUES (?, ?, ?, ?)`,
          args: [args.gorevId, userId, bugun, String(args.not).trim()]
        });
        return res.json({ reply: `"${g.title}" görevine bugünkü not eklendi.` });
      }

      // --- firma_olustur ------------------------------------------------------
      if (action.name === 'firma_olustur') {
        if (!args.ad || !String(args.ad).trim()) {
          return res.status(400).json({ error: 'Firma adı gerekli.' });
        }
        // Birim: Admin/İK serbest seçer; Müdür/Ekip Lideri kendi birimine kilitli
        let finalBirim = args.birim || null;
        if (isAdmin(role)) {
          // finalBirim gönderileni kullanır (null = genel)
        } else if (birimKilitliMi(role)) {
          const u = await db.execute({ sql: `SELECT department FROM users WHERE id = ?`, args: [userId] });
          if (!u.rows[0]) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
          finalBirim = u.rows[0].department; // kendi biriminden başkası yok sayılır
        } else {
          return res.status(403).json({ error: 'Yetkisiz erişim.' });
        }
        const r = await db.execute({
          sql: `INSERT INTO companies (name, department, created_at) VALUES (?, ?, ?)`,
          args: [String(args.ad).trim(), finalBirim, agentTodayISO()]
        });
        return res.json({ reply: `"${String(args.ad).trim()}" firması eklendi.`, id: Number(r.lastInsertRowid) });
      }

      // --- proje_olustur ------------------------------------------------------
      if (action.name === 'proje_olustur') {
        if (!args.firmaId || !args.ad || !String(args.ad).trim() || !args.baslangicTarihi || !args.bitisTarihi) {
          return res.status(400).json({ error: 'Firma, proje adı ve tarihler zorunludur.' });
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(args.baslangicTarihi)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(args.bitisTarihi))) {
          return res.status(400).json({ error: 'Tarihler YYYY-AA-GG biçiminde olmalı.' });
        }
        // Firma gerçekten var mı?
        const fr = await db.execute({ sql: `SELECT id, department FROM companies WHERE id = ?`, args: [args.firmaId] });
        if (!fr.rows[0]) return res.status(404).json({ error: 'Firma bulunamadı.' });

        // Birim: Admin/İK seçer; Müdür/Ekip Lideri kendi birimine kilitli
        let finalBirim;
        if (isAdmin(role)) {
          finalBirim = args.birim || fr.rows[0].department || null;
          if (!finalBirim) return res.status(400).json({ error: 'Birim zorunludur.' });
        } else if (birimKilitliMi(role)) {
          const u = await db.execute({ sql: `SELECT department FROM users WHERE id = ?`, args: [userId] });
          if (!u.rows[0]) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
          finalBirim = u.rows[0].department;
        } else {
          return res.status(403).json({ error: 'Yetkisiz erişim.' });
        }

        // Sorumlu seçildiyse geçerli ve onaylı bir kullanıcı olmalı
        let sorumlu = null;
        if (args.sorumluId) {
          const sr = await db.execute({ sql: `SELECT id, name, status FROM users WHERE id = ?`, args: [args.sorumluId] });
          if (!sr.rows[0] || sr.rows[0].status !== 'APPROVED') {
            return res.status(400).json({ error: 'Geçersiz sorumlu seçimi.' });
          }
          sorumlu = sr.rows[0];
        }

        const r = await db.execute({
          sql: `INSERT INTO projects (company_id, name, department, owner_id, start_date, end_date, priority, status, note, created_by, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
          args: [args.firmaId, String(args.ad).trim(), finalBirim, args.sorumluId || null,
                 args.baslangicTarihi, args.bitisTarihi, args.oncelik || 'NORMAL', args.not || null, name || null, agentTodayISO()]
        });
        const yeniProjeId = Number(r.lastInsertRowid);
        // Sorumluya bildirim
        if (sorumlu) {
          try {
            await agentNotifyUsers([args.sorumluId], 'PROJECT_ASSIGNED', 'PROJECTS', 'Yeni Proje Atandı',
              `"${String(args.ad).trim()}" projesi size atandı.`, yeniProjeId);
          } catch (e) { console.error('Ajan proje bildirimi hatası:', e.message); }
        }
        return res.json({ reply: `"${String(args.ad).trim()}" projesi oluşturuldu.`, id: yeniProjeId });
      }

      // --- ilerleme_ekle ------------------------------------------------------
      // Admin/İK VEYA projenin sorumlusu ekleyebilir (server.js POST /projects/:id/progress).
      if (action.name === 'ilerleme_ekle') {
        if (!args.projeId) return res.status(400).json({ error: 'Proje kimliği gerekli.' });
        if (!args.tarih || !/^\d{4}-\d{2}-\d{2}$/.test(String(args.tarih))) {
          return res.status(400).json({ error: 'Tarih YYYY-AA-GG biçiminde olmalı.' });
        }
        const pr = await db.execute({ sql: `SELECT owner_id, name FROM projects WHERE id = ?`, args: [args.projeId] });
        const proje = pr.rows[0];
        if (!proje) return res.status(404).json({ error: 'Proje bulunamadı.' });
        const sahibiMi = Number(proje.owner_id) === Number(userId);
        if (!isAdmin(role) && !sahibiMi) {
          return res.status(403).json({ error: 'İlerleme yalnızca Admin/İK veya projenin sorumlusu tarafından eklenebilir.' });
        }
        await db.execute({
          sql: `INSERT INTO project_progress (project_id, log_date, planned, actual, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          args: [args.projeId, args.tarih, Number(args.planlanan) || 0, Number(args.gerceklesen) || 0, args.not || null, agentTodayISO()]
        });
        // Admin eklediyse sorumluya, sorumlu eklediyse adminlere bildirim
        try {
          const mesaj = `"${proje.name}" projesine yeni ilerleme noktası eklendi.`;
          if (isAdmin(role)) {
            if (proje.owner_id && Number(proje.owner_id) !== Number(userId)) {
              await agentNotifyUsers([proje.owner_id], 'PROJECT_PROGRESS', 'PROJECTS', 'Proje İlerlemesi Güncellendi', mesaj, Number(args.projeId));
            }
          } else {
            const ar = await db.execute(`SELECT id FROM users WHERE role IN ('ADMIN', 'HR')`);
            await agentNotifyUsers(ar.rows.map(x => x.id), 'PROJECT_PROGRESS', 'PROJECTS', 'Proje İlerlemesi Güncellendi', mesaj, Number(args.projeId));
          }
        } catch (e) { console.error('Ajan ilerleme bildirimi hatası:', e.message); }
        return res.json({ reply: `"${proje.name}" projesine ilerleme kaydedildi.` });
      }

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