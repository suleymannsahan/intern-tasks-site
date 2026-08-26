const express = require('express');
const { createClient } = require('@libsql/client');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const ExcelJS = require('exceljs');
const gcal = require('./googleCalendar');
const ai = require('./ai');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { PDFParse } = require('pdf-parse');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
// Varsayılan 100kb sınırı, base64'e çevrilmiş dosya yüklemeleri için yetersiz kalıyordu.
// Geliştirmeler alanındaki 50MB'lık dosya sınırı, base64 sonrası ~67MB'a şişebiliyor —
// buna JSON gövdesinin geri kalanı için de pay bırakarak 70mb'a çıkarıldı.
app.use(express.json({ limit: '70mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Turso Bulut Veritabanı Bağlantısı
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

// ============================================================
// SİSTEM AYARLARI (Admin/İK "Ayarlar" paneli): sunucu açılışında ve her güncellemeden sonra
// system_settings tablosundan okunup bu bellek-içi önbelleğe (SETTINGS_CACHE) yüklenir; kodun
// geri kalanı DB'ye her seferinde gitmeden doğrudan bu önbellekten okur.
// ============================================================
const DEFAULT_SETTINGS = {
  // Bildirim/E-posta tercihleri: hangi olayda e-posta gönderilsin (uygulama içi bildirim bundan etkilenmez)
  email_task_assigned: true,
  email_task_completed: true,
  email_task_revision: true,
  email_task_approved: true,
  email_project_assigned: true,
  email_personal_reminder: true,
  email_new_user_credentials: true,
  email_daily_log_reminder: true,
  // Kayıt onay kuralları: bu rollerden/departmanlardan biriyle kayıt olunursa admin onayı gerekir
  approval_required_roles: ['MANAGER', 'LEADER'],
  approval_required_departments: ['INSAN_KAYNAKLARI'],
  // Site / e-posta genel bilgileri
  site_name: 'Görev & Takip Sistemi',
  email_sender_name: 'Görev & Takip Sistemi',
  email_sender_address: 'semresahann@gmail.com',
  site_logo_url: 'https://i.ibb.co/xtFPW7KP/Y-logo.png',
  dashboard_url: 'https://intern-tasks-pannel.onrender.com/',
  // İş günü hesaplaması: hafta sonuna ek olarak hariç tutulacak resmi tatil günleri (YYYY-MM-DD)
  holidays: [],
  // Google Takvim entegrasyonu sistem geneli açık/kapalı anahtarı
  google_calendar_enabled: true
};

let SETTINGS_CACHE = { ...DEFAULT_SETTINGS };

async function loadSettingsCache() {
  try {
    const rows = await db.execute('SELECT key, value FROM system_settings');
    const merged = { ...DEFAULT_SETTINGS };
    for (const row of rows.rows) {
      try { merged[row.key] = JSON.parse(row.value); } catch (e) { /* bozuk kayıt, varsayılanda kalsın */ }
    }
    SETTINGS_CACHE = merged;
  } catch (e) {
    console.error('Ayarlar yüklenemedi, varsayılanlar kullanılıyor:', e.message);
    SETTINGS_CACHE = { ...DEFAULT_SETTINGS };
  }
}

// Veritabanı sütunlarını tek tek kontrol edip yoksa ekleyen güvenli fonksiyon
async function initDbMigration() {
  const columnsToAdd = [
    { name: 'username', type: 'TEXT' },
    { name: 'department', type: 'TEXT' },
    { name: 'leader_sub_type', type: 'TEXT' },
    { name: 'status', type: "TEXT DEFAULT 'PENDING'" },
    // Ekip Gidişatı alt alanı (ör. Donanım/Gömülü, Test) ve iletişim
    { name: 'sub_area', type: 'TEXT' },
    { name: 'phone', type: 'TEXT' },
    // Google Takvim entegrasyonu: kullanıcı başına refresh token ve bağlı durumu
    { name: 'google_refresh_token', type: 'TEXT' },
    { name: 'google_calendar_connected', type: 'INTEGER DEFAULT 0' },
    // Stajyerin sorumlu olduğu mühendis (birimindeki mühendislerden seçilir)
    { name: 'engineer_id', type: 'INTEGER' },
    // Şifre sıfırlama akışı: e-postaya gönderilen doğrulama kodu ve kod doğrulandıktan
    // sonra son adımda (yeni şifre belirleme) kullanılan tek seferlik jeton
    { name: 'reset_code', type: 'TEXT' },
    { name: 'reset_code_expires', type: 'TEXT' },
    { name: 'reset_token', type: 'TEXT' },
    { name: 'reset_token_expires', type: 'TEXT' }
  ];

  for (const col of columnsToAdd) {
    try {
      // Her sütunu bağımsız try-catch bloğunda ekliyoruz.
      // Sütun zaten varsa hata verecek ve sessizce sonraki sütuna geçecek.
      await db.execute(`ALTER TABLE users ADD COLUMN ${col.name} ${col.type};`);
      console.log(`✅ ${col.name} sütunu users tablosuna başarıyla eklendi.`);
    } catch (err) {
      // "duplicate column name" hatasını yutuyoruz, bu normaldir (sütun zaten var demektir).
      console.log(`ℹ️ ${col.name} sütun kontrolü: ${err.message}`);
    }
  }

  // Giriş sonrası tanıtım videosu: kullanıcı hesabına ilk kez giriş yaptığında (kayıt sonrası) bir
  // kez oynar, sonraki girişlerde tekrar gösterilmez (bkz. POST /api/login). Sütun YENİ eklendiyse
  // (yani bu özellik ilk kez devreye giriyorsa) hâlihazırda var olan tüm kullanıcılar "zaten görmüş"
  // sayılır — aksi halde bu özellik yayınlandığı an, sitesi aylardır kullanan herkese video tekrar
  // gösterilirdi. Sütun zaten varsa (sonraki sunucu açılışları) bu backfill bir daha çalışmaz.
  try {
    await db.execute(`ALTER TABLE users ADD COLUMN intro_seen INTEGER DEFAULT 0;`);
    await db.execute(`UPDATE users SET intro_seen = 1`);
    console.log('✅ intro_seen sütunu eklendi; mevcut kullanıcılar "zaten görmüş" olarak işaretlendi.');
  } catch (err) {
    console.log(`ℹ️ intro_seen sütun kontrolü: ${err.message}`);
  }
}

// Sunucu kalkarken veya DB başlatılırken çağırın
initDbMigration();

// ASELSAN firması için varsayılan aşama şablonu: 18 ana aşama, bir kısmının alt aşamaları var.
// Bu liste sadece ilk seed için kullanılır — kaydedildikten sonra normal bir şablon gibi
// (stage_templates/stage_template_items) düzenlenebilir/silinebilir.
const ASELSAN_STAGE_TEMPLATE = [
  { title: 'Tasarım Başlatma (Dosya Tamamlama)', subItems:['Kart Schematic', 'Golden Schematic (Golden varsa)', 'Kart TBDK', 'Golden TBDK', 'Kart DGD', 'Kart Odb + Dosya alındı mı?', 'Kart Temini', 'Golden Temini'] },
  { title: 'Konnektörlerin Belirlenmesi - Sipariş Edilmesi', subItems:['Kart Konnektör Sayısı', 'SMD Konnektör Sayısı', 'Normal Konnektör Sayısı', 'Konnektör Siparişi'] },
  { title: 'Mekanik Tasarım Başlatma', subItems:[] },
  { title: 'Kart Test Tasarımı', subItems:['Kartı Test Tasarımı Öncesi Excel Oluşturma', 'Güç Hatlarının Çıkarılması', 'Açık/Kısa Devre Testleri Yazılımı', 'Konnektör Pinout Yazılımı', 'Besleme Gerilim Testleri', 'Gerilim Testleri', 'Haberleşme Testleri', 'Hat Testleri', 'Kart Test Noktalarını Belirlenmesi'] },
  { title: 'VPC Sipariş', subItems:['%95 kesinlikte VPC Sipariş Geçilmesi'] },
  { title: 'Ate Test Birim Seçimi', subItems:[] },
  { title: 'KTTD', subItems:['(Tasarım exceli sonrası) KTTD Rev 1', "KTTD'ye göre PLD Toplantısı", 'KTTD Rev 2 Olarak Aselsan Gönderilmesi'] },
  { title: 'VISIO', subItems:['TE Dökümanı Hazırlama (Visio)', 'Gerekli TE ve Seri Numaraların Temini'] },
  { title: 'BDK Tasarım - Sipariş (Varsa)', subItems:['SMD Konnektör İçin Pcb Tasarımı adet', 'Pcb için gerekli malzemelerin siparişi', 'Kart için Tutucu Pcb tasarımı'] },
  { title: 'Mekanik Üretim Başlatma', subItems:['Mekanik Kutu Tasarımı Kontrol', 'Mekanik Kutu Üretimi'] },
  { title: 'NI Teststand', subItems:['NI Teststand Yazılım Hazırlama', 'Teknik Ekibe Mekanik Kutu Teslimi', 'Teknik Ekibe TE Döküman Teslimi'] },
  { title: 'Gömülü Yazılım (Varsa)', subItems:['Beyes Gömülü Yazılım'] },
  { title: 'Kablaj', subItems:['Kablaj Kontrolü (paralel)'] },
  { title: 'XJTAG', subItems:['Jtag Test Hazırlama (entegrasyon ile birlikte)'] },
  { title: 'Entegrasyon', subItems:['Aselsan Entegrasyon'] },
  { title: 'Ön Doğrulama + Doğrulama > Üretim Teslim', subItems:['Kart Doğrulama Çalışması'] },
  { title: 'Dosya Teslimi', subItems:[] },
  { title: 'Yedek Teslimi', subItems:[] }
];

async function seedAselsanStageTemplate() {
  try {
    const existing = await db.execute({
      sql: `SELECT id FROM stage_templates WHERE name = ?`,
      args: ['ASELSAN Standart Şablon']
    });
    if (existing.rows.length > 0) return;

    const now = new Date().toISOString();
    const tRes = await db.execute({
      sql: `INSERT INTO stage_templates (name, auto_apply_company_name, created_by, created_at) VALUES (?, ?, ?, ?)`,
      args: ['ASELSAN Standart Şablon', 'ASELSAN', 'Sistem', now]
    });
    const templateId = Number(tRes.lastInsertRowid);
    await writeStageTemplateItems(templateId, ASELSAN_STAGE_TEMPLATE);
    console.log('✅ "ASELSAN Standart Şablon" aşama şablonu oluşturuldu (18 ana aşama).');
  } catch (err) {
    console.error('ASELSAN şablon seed hatası:', err.message);
  }
}

// Veritabanı Tablolarını Oluşturma
async function initDb() {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL,
        intern_start_date TEXT,
        intern_end_date TEXT
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        assigned_to INTEGER NOT NULL,
        category TEXT NOT NULL,
        end_date TEXT NOT NULL,
        work_days INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        status TEXT DEFAULT 'IN_PROGRESS',
        review_comment TEXT,
        FOREIGN KEY(assigned_to) REFERENCES users(id)
      )
    `);

    try { await db.execute(`ALTER TABLE tasks ADD COLUMN description TEXT`); } catch (e) {}
    try { await db.execute(`ALTER TABLE tasks ADD COLUMN review_comment TEXT`); } catch (e) {}
    // Google Takvim etkinlik kimliği (güncelleme/silme senkronu için)
    try { await db.execute(`ALTER TABLE tasks ADD COLUMN google_event_id TEXT`); } catch (e) {}
    // Görevi bir Projeye bağlar (opsiyonel) — ör. Proje sayfasından "Kart için Planla" ile
    // o projenin görevlerinden birini seçebilmek için.
    try { await db.execute(`ALTER TABLE tasks ADD COLUMN project_id INTEGER`); } catch (e) {}
    // AI ile üretilen bir iş planı, görevin mevcut teslim tarihinden farklı bir bitiş öneriyorsa,
    // yeni tarih burada bekler; görevi atayan kişi onaylayana kadar end_date değişmez.
    try { await db.execute(`ALTER TABLE tasks ADD COLUMN pending_end_date TEXT`); } catch (e) {}
    // Proje sayfasından "Kart için Planla" ile otomatik oluşturulan, sadece iş planını taşımak
    // için var olan görevler: normal "Görevler" listelerinde/sayımlarında hiç görünmez, sadece
    // ilgili Proje detay sayfasında (GET /api/tasks?planTaskForProject=) gösterilir.
    try { await db.execute(`ALTER TABLE tasks ADD COLUMN is_kart_plani_task INTEGER DEFAULT 0`); } catch (e) {}
    // Aynı görev, "Yeni Görev Atama" formunda işaretlenen birden fazla kişiye ayrı ayrı satır olarak
    // atanıyor (bkz. POST /api/tasks döngüsü); bu satırların aynı atama işleminden geldiğini
    // işaretlemek için paylaşılan bir kimlik — takvimde tek bir etkinlik olarak birleştirmek için
    // kullanılır (bkz. loadCalendarData). Eski (bu sütundan önce oluşturulmuş) görevlerde NULL kalır.
    try { await db.execute(`ALTER TABLE tasks ADD COLUMN assign_batch_id TEXT`); } catch (e) {}

    await db.execute(`
      CREATE TABLE IF NOT EXISTS daily_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        intern_id INTEGER NOT NULL,
        log_date TEXT NOT NULL,
        note TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id),
        FOREIGN KEY(intern_id) REFERENCES users(id)
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS task_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        revised_by TEXT NOT NULL,
        comment TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id)
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS meeting_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        requested_by INTEGER NOT NULL,
        department TEXT NOT NULL,
        subject TEXT NOT NULL,
        description TEXT,
        preferred_date TEXT,
        status TEXT DEFAULT 'PENDING',
        reviewed_by TEXT,
        review_comment TEXT,
        created_at TEXT NOT NULL,
        target_roles TEXT,
        FOREIGN KEY(requested_by) REFERENCES users(id)
      )
    `);

    // target_roles: toplantının bildirileceği/hedef rol listesi (virgülle ayrık). Eski kayıtlar için güvenli ekleme.
    try { await db.execute(`ALTER TABLE meeting_requests ADD COLUMN target_roles TEXT`); } catch (e) {}
    // target_user_ids: bir role toplu yerine belirli kişiler çağrılmak istenirse, o kişilerin id'leri
    // ",3,7,15," biçiminde (baş/son virgüllü) saklanır — LIKE ile güvenli tekil eşleşme için.
    try { await db.execute(`ALTER TABLE meeting_requests ADD COLUMN target_user_ids TEXT`); } catch (e) {}
    // Google Takvim etkinlik kimliği (talep edenin takvimindeki etkinlik)
    try { await db.execute(`ALTER TABLE meeting_requests ADD COLUMN google_event_id TEXT`); } catch (e) {}

    // Geçmiş toplantılarda konuşulanları not düşmek için: toplantıyı görebilen herkes (talep eden,
    // çağrılanlar, Admin/İK) istediği zaman not ekleyebilir — GET /api/meetings/:id/notes ile listelenir.
    await db.execute(`
      CREATE TABLE IF NOT EXISTS meeting_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        note TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(meeting_id) REFERENCES meeting_requests(id),
        FOREIGN KEY(user_id) REFERENCES users(id)
      )
    `);

    // ============================================================
    // PROJE SİSTEMİ: Firmalar → Projeler → İlerleme Kayıtları
    // ============================================================

    // Firmalar (ör. Türk Telekom, Aselsan ...)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS companies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        department TEXT,
        created_at TEXT NOT NULL
      )
    `);

    // Projeler: bir firmaya ve bir birime bağlı; sorumlu kişi, tarih aralığı ve öncelik
    await db.execute(`
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        department TEXT NOT NULL,
        owner_id INTEGER,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        priority TEXT DEFAULT 'NORMAL',
        status TEXT DEFAULT 'ACTIVE',
        note TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(company_id) REFERENCES companies(id),
        FOREIGN KEY(owner_id) REFERENCES users(id)
      )
    `);

    // İlerleme kayıtları: her tarih için planlanan % ve gerçekleşen % (gidişat grafiği için)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS project_progress (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        log_date TEXT NOT NULL,
        planned INTEGER DEFAULT 0,
        actual INTEGER DEFAULT 0,
        note TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
      )
    `);

    // Eski kayıtlar için güvenli sütun eklemeleri
    try { await db.execute(`ALTER TABLE projects ADD COLUMN note TEXT`); } catch (e) {}
    try { await db.execute(`ALTER TABLE projects ADD COLUMN priority TEXT DEFAULT 'NORMAL'`); } catch (e) {}
    try { await db.execute(`ALTER TABLE projects ADD COLUMN status TEXT DEFAULT 'ACTIVE'`); } catch (e) {}

    // ============================================================
    // AŞAMA ŞABLONLARI: bir projeye uygulanabilen, tekrar kullanılabilir "ana aşama + alt aşama"
    // checklist tanımları. Firma adı belirli bir şablona bağlıysa (auto_apply_company_name), o
    // firmaya yeni proje oluşturulunca otomatik uygulanır (bkz. POST /api/projects).
    // ============================================================
    await db.execute(`
      CREATE TABLE IF NOT EXISTS stage_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        auto_apply_company_name TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS stage_template_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id INTEGER NOT NULL,
        parent_item_id INTEGER,
        title TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        FOREIGN KEY(template_id) REFERENCES stage_templates(id),
        FOREIGN KEY(parent_item_id) REFERENCES stage_template_items(id)
      )
    `);

    // Bir projeye bir şablon uygulandığında, şablonun o anki maddeleri buraya kopyalanır — proje
    // bazında bağımsız tamamlanma durumu tutulur, sonradan projeye özel alt aşama da eklenebilir
    // (şablonun kendisi bundan etkilenmez).
    await db.execute(`
      CREATE TABLE IF NOT EXISTS project_stages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        parent_id INTEGER,
        title TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        is_done INTEGER DEFAULT 0,
        completed_at TEXT,
        completed_by TEXT,
        note TEXT,
        FOREIGN KEY(project_id) REFERENCES projects(id),
        FOREIGN KEY(parent_id) REFERENCES project_stages(id)
      )
    `);
    // Tablo daha önce (note sütunu olmadan) oluşturulmuş olabilir — güvenli ekleme
    try { await db.execute(`ALTER TABLE project_stages ADD COLUMN note TEXT`); } catch (e) {}

    await seedAselsanStageTemplate();

    // Proje birimleri (elektronik, yazılım, mekanik ... + admin ekleyebilir)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS project_departments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE NOT NULL,
        label TEXT NOT NULL,
        icon TEXT,
        created_at TEXT NOT NULL
      )
    `);
    // Varsayılan birimleri bir defalık ekle (varsa yok sayılır)
    const seedDepts = [
      { key: 'ELEKTRONIK', label: 'Elektronik', icon: 'fa-microchip' },
      { key: 'YAZILIM', label: 'Yazılım', icon: 'fa-code' },
      { key: 'MEKANIK', label: 'Mekanik', icon: 'fa-gears' }
    ];
    for (const d of seedDepts) {
      try {
        await db.execute({
          sql: `INSERT INTO project_departments (key, label, icon, created_at) VALUES (?, ?, ?, ?)`,
          args: [d.key, d.label, d.icon, new Date().toISOString().substring(0, 10)]
        });
      } catch (e) { /* zaten var */ }
    }

    // Birim alt alanları (ör. Elektronik → Donanım/Gömülü, Test)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS department_subareas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        department_key TEXT NOT NULL,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    // Elektronik için varsayılan 2 alt alan (tablo boşsa)
    try {
      const cnt = await db.execute(`SELECT COUNT(*) AS c FROM department_subareas`);
      if (Number(cnt.rows[0].c) === 0) {
        const seedSubs = [
          { dep: 'ELEKTRONIK', label: 'Donanım/Gömülü' },
          { dep: 'ELEKTRONIK', label: 'Test' }
        ];
        for (const s of seedSubs) {
          await db.execute({
            sql: `INSERT INTO department_subareas (department_key, label, created_at) VALUES (?, ?, ?)`,
            args: [s.dep, s.label, new Date().toISOString().substring(0, 10)]
          });
        }
      }
    } catch (e) {}

    // ============================================================
    // BİLDİRİMLER: her kullanıcının kendi bildirim kutusu.
    // "box": hangi kutucuğun/simgenin üstünde uyarı noktası gösterileceği
    // (TASKS, MEETINGS, PENDING_USERS, PROJECTS). Bildirim görüntülendiğinde satır silinir.
    // ============================================================
    await db.execute(`
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        box TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT,
        ref_id INTEGER,
        created_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id)
      )
    `);

    // ============================================================
    // STAJYER GİRİŞ/ÇIKIŞ TAKİBİ: her satır bir "gün içi oturum"; check_out alanları,
    // stajyer çıkış yapana kadar NULL kalır. Konum, tarayıcının Geolocation API'sinden alınır.
    // ============================================================
    await db.execute(`
      CREATE TABLE IF NOT EXISTS attendance_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        intern_id INTEGER NOT NULL,
        check_in_at TEXT NOT NULL,
        check_in_lat REAL,
        check_in_lng REAL,
        check_out_at TEXT,
        check_out_lat REAL,
        check_out_lng REAL,
        FOREIGN KEY(intern_id) REFERENCES users(id)
      )
    `);
    // session_type: 'office' (varsayılan, Geolocation ile) veya 'remote-vpn' (VPN watcher ile).
    // client_ip: uzaktan oturumlarda WireGuard tünel IP'si; kimin bağlandığını doğrulamaya yardımcı olur.
    try { await db.execute(`ALTER TABLE attendance_logs ADD COLUMN session_type TEXT DEFAULT 'office'`); } catch (e) {}
    try { await db.execute(`ALTER TABLE attendance_logs ADD COLUMN client_ip TEXT`); } catch (e) {}

    // ============================================================
    // SİSTEM AYARLARI: basit key-value deposu (Admin/İK "Ayarlar" paneli). Değerler her zaman
    // JSON.stringify edilmiş olarak saklanır (boolean/dizi/obje/string hepsi aynı yolla gider),
    // okunurken JSON.parse edilir. loadSettingsCache() sunucu açılışında ve her kayıttan sonra çağrılır.
    // ============================================================
    await db.execute(`
      CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);
    await loadSettingsCache();

    // ============================================================
    // GÖREV BELGELERİ: bir göreve atanan kişi, görevi tamamlamadan önce (ya da sırasında)
    // istediği türde belge ekleyebilir. Ayrı bir dosya sunucusu/bulut depolama olmadığından
    // (Render'ın disk alanı kalıcı değil) dosya içeriği base64 olarak doğrudan veritabanında
    // tutulur — 10MB'lık üst sınır bu yüzden var (bkz. POST /api/tasks/:id/attachments).
    // ============================================================
    await db.execute(`
      CREATE TABLE IF NOT EXISTS task_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        file_name TEXT NOT NULL,
        mime_type TEXT,
        file_size INTEGER,
        file_data TEXT NOT NULL,
        uploaded_by TEXT,
        uploaded_by_id INTEGER,
        created_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id)
      )
    `);

    // ============================================================
    // PLANLAMA NOTLARI: sağ paneldeki kişisel not/hatırlatma alanı. Herkes kendine, kendisinin
    // görebileceği bir not + tarih ekler; not eklendiğinde ve tarih yaklaştığında e-posta atılır.
    // ============================================================
    await db.execute(`
      CREATE TABLE IF NOT EXISTS personal_reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        note TEXT NOT NULL,
        remind_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        notified_upcoming INTEGER DEFAULT 0,
        FOREIGN KEY(user_id) REFERENCES users(id)
      )
    `);

    // ============================================================
    // GELİŞTİRMELER: ana ekrandaki şifreli dosya paylaşım alanı. Herkes dosya yükleyip kendi
    // belirlediği bir şifre koyabilir; dosyayı indirmek isteyen bu şifreyi girmek zorundadır.
    // Diğer base64 tablolarıyla aynı sebepten (kalıcı disk yok) içerik veritabanında tutulur.
    // ============================================================
    await db.execute(`
      CREATE TABLE IF NOT EXISTS dev_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_name TEXT NOT NULL,
        mime_type TEXT,
        file_size INTEGER,
        file_data TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        description TEXT,
        uploaded_by TEXT,
        uploaded_by_id INTEGER,
        created_at TEXT NOT NULL
      )
    `);
    // password_plain: yükleyen kişi kendi koyduğu şifreyi daha sonra tekrar görebilsin diye
    // (bcrypt hash geri döndürülemediği için) düz metin olarak da tutulur — sadece dosyanın
    // sahibine, /api/dev-files/:id/password ile döndürülür.
    try { await db.execute(`ALTER TABLE dev_files ADD COLUMN password_plain TEXT`); } catch (e) {}

    console.log('Turso bulut veritabanı tabloları hazır.');
  } catch (err) {
    console.error('Veritabanı başlatma hatası:', err.message);
  }
}

initDb();
ai.initAiSchema(db);

// ============================================================
// BİLDİRİM YARDIMCILARI
// ============================================================

// Tek bir kullanıcıya bildirim düşürür. Ana işlemi bozmasın diye hatayı yutar.
async function createNotification(userId, type, box, title, message, refId) {
  if (!userId) return;
  try {
    await db.execute({
      sql: `INSERT INTO notifications (user_id, type, box, title, message, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [userId, type, box, title, message || null, refId != null ? refId : null, nowTurkeyLocal()]
    });
  } catch (e) {
    console.error('Bildirim oluşturulamadı:', e.message);
  }
}

// Birden fazla kullanıcıya aynı bildirimi düşürür (tekrarlanan id'leri eler).
async function notifyUsers(userIds, type, box, title, message, refId) {
  const uniqueIds = [...new Set((userIds || []).filter(Boolean).map(Number))];
  for (const uid of uniqueIds) {
    await createNotification(uid, type, box, title, message, refId);
  }
}

// Bildirim zili tıklanmadan biriken satırları temizler ki panelde kalabalık oluşmasın.
// Bu tablodaki bildirimler tek seferlik olay bildirimleridir (görev atandı, toplantı onaylandı vb.);
// 24 saatten eski, görülmemiş bir bildirim artık güncel değildir — ilgili konu hâlâ güncelse
// (görev hâlâ atanmış, toplantı hâlâ bekliyor gibi) zaten görev/toplantı listesinde görünmeye
// devam eder, sadece "yeni" olay bildirimi silinmiş olur.
let _notifTemizlikBasladi = false;
function startNotificationCleanup() {
  if (_notifTemizlikBasladi) return;
  _notifTemizlikBasladi = true;
  const tick = async () => {
    try {
      const sinirTarih = new Date(Date.now() - 24 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000)
        .toISOString().replace('T', ' ').substring(0, 19);
      const r = await db.execute({ sql: `DELETE FROM notifications WHERE created_at < ?`, args: [sinirTarih] });
      if (r.rowsAffected) console.log(`🧹 ${r.rowsAffected} eski bildirim otomatik temizlendi.`);
    } catch (e) { console.error('Bildirim temizleme hatası:', e.message); }
  };
  setTimeout(tick, 20000);
  setInterval(tick, 60 * 60 * 1000); // saatlik kontrol
  console.log('🧹 Bildirim otomatik temizleme zamanlayıcısı aktif (24 saat).');
}

// ============================================================
// GOOGLE TAKVİM ENTEGRASYONU
// ============================================================

// Serbest tarih metnini YYYY-MM-DD'ye normalize eder (görev/toplantı tarihleri farklı biçimde olabilir)
function normalizeDateForGcal(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const tr = s.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})/);
  if (tr) return `${tr[3]}-${tr[2].padStart(2, '0')}-${tr[1].padStart(2, '0')}`;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().substring(0, 10);
  return null;
}

// Bir kullanıcının bağlı olup olmadığını ve refresh token'ını getirir
async function getUserGoogleToken(userId) {
  try {
    const r = await db.execute({
      sql: `SELECT google_refresh_token, google_calendar_connected FROM users WHERE id = ?`,
      args: [userId]
    });
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    if (!row.google_calendar_connected || !row.google_refresh_token) return null;
    return row.google_refresh_token;
  } catch (e) {
    console.error('Google token okunamadı:', e.message);
    return null;
  }
}

// GÖREV senkron yardımcıları -------------------------------------------------

// Görevi ilgili kullanıcının takvimine yazar/günceller; event id'yi tasks tablosuna kaydeder.
async function syncTaskToGoogle(taskId) {
  if (!gcal.isConfigured() || !SETTINGS_CACHE.google_calendar_enabled) return;
  try {
    const r = await db.execute({
      sql: `SELECT tasks.*, users.name AS assignee_name
            FROM tasks LEFT JOIN users ON tasks.assigned_to = users.id
            WHERE tasks.id = ?`,
      args: [taskId]
    });
    if (r.rows.length === 0) return;
    const task = r.rows[0];

    const refreshToken = await getUserGoogleToken(task.assigned_to);
    if (!refreshToken) return; // kullanıcı takvimini bağlamamış

    const dateISO = normalizeDateForGcal(task.end_date);
    if (!dateISO) return;

    const eventData = {
      type: 'task',
      title: task.title,
      description: task.description || '',
      dateISO,
      extraLines: [
        task.category ? `Kategori: ${task.category}` : null,
        task.created_by ? `Atayan: ${task.created_by}` : null
      ]
    };

    if (task.google_event_id) {
      await gcal.updateEvent(refreshToken, task.google_event_id, eventData);
    } else {
      const eventId = await gcal.createEvent(refreshToken, eventData);
      await db.execute({
        sql: `UPDATE tasks SET google_event_id = ? WHERE id = ?`,
        args: [eventId, taskId]
      });
    }
  } catch (err) {
    console.error(`Görev #${taskId} Google Takvim senkron hatası:`, err.message);
  }
}

// Görev silinmeden ÖNCE çağrılır: takvimden etkinliği kaldırır.
async function removeTaskFromGoogle(taskId) {
  if (!gcal.isConfigured() || !SETTINGS_CACHE.google_calendar_enabled) return;
  try {
    const r = await db.execute({
      sql: `SELECT assigned_to, google_event_id FROM tasks WHERE id = ?`,
      args: [taskId]
    });
    if (r.rows.length === 0) return;
    const { assigned_to, google_event_id } = r.rows[0];
    if (!google_event_id) return;
    const refreshToken = await getUserGoogleToken(assigned_to);
    if (!refreshToken) return;
    await gcal.deleteEvent(refreshToken, google_event_id);
  } catch (err) {
    console.error(`Görev #${taskId} Google Takvim silme hatası:`, err.message);
  }
}

// TOPLANTI senkron yardımcısı ------------------------------------------------

async function syncMeetingToGoogle(meetingId) {
  if (!gcal.isConfigured() || !SETTINGS_CACHE.google_calendar_enabled) return;
  try {
    const r = await db.execute({
      sql: `SELECT meeting_requests.*, users.name AS requester_name
            FROM meeting_requests LEFT JOIN users ON meeting_requests.requested_by = users.id
            WHERE meeting_requests.id = ?`,
      args: [meetingId]
    });
    if (r.rows.length === 0) return;
    const m = r.rows[0];

    const refreshToken = await getUserGoogleToken(m.requested_by);
    if (!refreshToken) return;

    const dateISO = normalizeDateForGcal(m.preferred_date);
    if (!dateISO) return; // tarihi olmayan toplantı takvime yazılmaz

    const eventData = {
      type: 'meeting',
      title: m.subject,
      description: m.description || '',
      dateISO,
      extraLines: [
        m.department ? `Birim: ${m.department}` : null,
        m.status ? `Durum: ${m.status}` : null
      ]
    };

    if (m.google_event_id) {
      await gcal.updateEvent(refreshToken, m.google_event_id, eventData);
    } else {
      const eventId = await gcal.createEvent(refreshToken, eventData);
      await db.execute({
        sql: `UPDATE meeting_requests SET google_event_id = ? WHERE id = ?`,
        args: [eventId, meetingId]
      });
    }
  } catch (err) {
    console.error(`Toplantı #${meetingId} Google Takvim senkron hatası:`, err.message);
  }
}

// --- Google OAuth Endpoint'leri ---

// 1) Bağlanmayı başlat: kullanıcıyı Google izin ekranına yönlendirir.
//    Kullanım: tarayıcıda GET /api/google/auth?userId=123
app.get('/api/google/auth', (req, res) => {
  if (!gcal.isConfigured()) {
    return res.status(503).send('Google Takvim entegrasyonu sunucuda yapılandırılmamış.');
  }
  if (!SETTINGS_CACHE.google_calendar_enabled) {
    return res.status(503).send('Google Takvim entegrasyonu Ayarlar panelinden kapatılmış.');
  }
  const { userId } = req.query;
  if (!userId) return res.status(400).send('userId gerekli.');
  const url = gcal.getAuthUrl(userId);
  res.redirect(url);
});

// 2) Google geri dönüş (callback): code'u refresh_token'a çevirir ve saklar.
app.get('/api/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const appBase = process.env.APP_BASE_URL || '/';

  if (error) {
    return res.redirect(`${appBase}?gcal=denied`);
  }
  if (!code || !state) {
    return res.status(400).send('Eksik parametre.');
  }

  try {
    const tokens = await gcal.exchangeCodeForTokens(code);
    const userId = state;

    if (!tokens.refresh_token) {
      // refresh_token gelmediyse (kullanıcı daha önce izin vermiş olabilir) yine de bağlı say,
      // ama ideal olan prompt:'consent' ile her seferinde almak. Mevcut token'ı koru.
      await db.execute({
        sql: `UPDATE users SET google_calendar_connected = 1 WHERE id = ?`,
        args: [userId]
      });
    } else {
      await db.execute({
        sql: `UPDATE users SET google_refresh_token = ?, google_calendar_connected = 1 WHERE id = ?`,
        args: [tokens.refresh_token, userId]
      });
    }

    // Bağlandıktan sonra, kullanıcının mevcut açık görevlerini geriye dönük takvime ekle
    try {
      const openTasks = await db.execute({
        sql: `SELECT id FROM tasks WHERE assigned_to = ? AND status != 'APPROVED'`,
        args: [userId]
      });
      for (const t of openTasks.rows) {
        await syncTaskToGoogle(t.id);
      }
    } catch (backfillErr) {
      console.error('Geriye dönük görev senkronu hatası:', backfillErr.message);
    }

    res.redirect(`${appBase}?gcal=connected`);
  } catch (err) {
    console.error('Google callback hatası:', err.message);
    res.redirect(`${appBase}?gcal=error`);
  }
});

// 3) Bağlı durumu sorgula
app.get('/api/google/status', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId gerekli.' });
  try {
    const r = await db.execute({
      sql: `SELECT google_calendar_connected FROM users WHERE id = ?`,
      args: [userId]
    });
    const connected = r.rows.length > 0 && !!r.rows[0].google_calendar_connected;
    res.json({ connected, configured: gcal.isConfigured() && SETTINGS_CACHE.google_calendar_enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4) Bağlantıyı kaldır
app.post('/api/google/disconnect', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId gerekli.' });
  try {
    await db.execute({
      sql: `UPDATE users SET google_refresh_token = NULL, google_calendar_connected = 0 WHERE id = ?`,
      args: [userId]
    });
    res.json({ message: 'Google Takvim bağlantısı kaldırıldı.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API ENDPOINT'LERİ ---

// Kayıt Ol Endpoint'i (Onay Mekanizmalı)
app.post('/api/register', async (req, res) => {
  try {
    const {
      name,
      username,
      password,
      email,
      phone,
      role,
      department,
      subArea,
      leaderType,
      startDate,
      endDate
    } = req.body;

    if (!name || !username || !password || !role) {
      return res.status(400).json({ error: 'Lütfen tüm zorunlu alanları doldurun!' });
    }
    if (!email || !email.trim()) {
      return res.status(400).json({ error: 'E-posta adresi zorunludur!' });
    }
    if (!phone || !phone.trim()) {
      return res.status(400).json({ error: 'Telefon numarası zorunludur!' });
    }

    if (role === 'INTERN' && (!startDate || !endDate)) {
      return res.status(400).json({ error: 'Stajyerler için başlangıç ve bitiş tarihleri zorunludur!' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const userEmail = email.trim();

    // 💡 ONAY MANTIĞI: Ayarlar panelinde belirlenen rol/departmanlardan biriyle kayıt olunursa
    // onay beklemeye alınır (PENDING), diğerleri direkt onaylanır (APPROVED).
    const requiresApproval = (SETTINGS_CACHE.approval_required_roles || []).includes(role) ||
      (SETTINGS_CACHE.approval_required_departments || []).includes(department);
    const initialStatus = requiresApproval ? 'PENDING' : 'APPROVED';

    const result = await db.execute({
      sql: `INSERT INTO users (
              name,
              username,
              email,
              phone,
              password,
              role,
              department,
              sub_area,
              leader_sub_type,
              intern_start_date,
              intern_end_date,
              status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        name,
        username,
        userEmail,
        phone.trim(),
        hashedPassword,
        role,
        department || null,
        department === 'ELEKTRONIK' ? (subArea || null) : null,
        leaderType || null,
        role === 'INTERN' ? startDate : null,
        role === 'INTERN' ? endDate : null,
        initialStatus
      ]
    });

    const successMessage = initialStatus === 'PENDING'
      ? 'Kayıt başarılı! Hesabınız yönetici onayından sonra aktif olacaktır.'
      : 'Kullanıcı başarıyla oluşturuldu.';

    // Onay bekleyen bir kayıt ise Admin'lere bildirim düşür
    if (initialStatus === 'PENDING') {
      try {
        const adminsRes = await db.execute(`SELECT id FROM users WHERE role IN ('ADMIN', 'HR')`);
        await notifyUsers(
          adminsRes.rows.map(r => r.id),
          'USER_PENDING',
          'PENDING_USERS',
          'Yeni Kayıt Onayı',
          `${name} (${role}) hesabı onayınızı bekliyor.`,
          Number(result.lastInsertRowid)
        );
      } catch (notifErr) { console.error('Kayıt bildirimi hatası:', notifErr.message); }
    }

    res.json({
      message: successMessage,
      userId: Number(result.lastInsertRowid),
      status: initialStatus
    });

  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) {
      if (error.message.includes('email')) {
        return res.status(400).json({ error: 'Bu e-posta adresi zaten kayıtlı!' });
      }
      return res.status(400).json({ error: 'Bu kullanıcı adı zaten alınmış!' });
    }
    console.error("Kayıt hatası:", error);
    res.status(500).json({ error: 'Veritabanı hatası: ' + error.message });
  }
});

// Giriş Yap Endpoint'i (Status Kontrollü)
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const result = await db.execute({
      sql: 'SELECT * FROM users WHERE username = ?',
      args: [username]
    });
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Kullanıcı adı veya şifre hatalı.' });
    }

    const user = result.rows[0];

    // Şifre Kontrolü
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(400).json({ error: 'Kullanıcı adı veya şifre hatalı.' });
    }

    // ONAY KONTROLÜ (status === 'PENDING' durumu)
    if (user.status === 'PENDING') {
      return res.status(403).json({ 
        error: 'Hesabınız henüz Admin tarafından onaylanmamıştır. Lütfen onay bekleyiniz.' 
      });
    }

    // Giriş sonrası tanıtım videosu: sadece hesaba ilk kez giriş yapılıyorsa gösterilir.
    // Bu istekte gösterileceği belirlenince aynı anda "görüldü" olarak işaretlenir, böylece
    // bir sonraki girişte (video sonuna kadar izlense de izlenmese de) tekrar oynamaz.
    const showIntro = !user.intro_seen;
    if (showIntro) {
      await db.execute({ sql: `UPDATE users SET intro_seen = 1 WHERE id = ?`, args: [user.id] });
    }

    // Başarılı Giriş
    res.json({
      id: user.id,
      name: user.name,
      username: user.username,
      email: user.email,
      phone: user.phone,
      sub_area: user.sub_area,
      role: user.role,
      department: user.department,
      leaderType: user.leader_sub_type,
      status: user.status,
      intern_start_date: user.intern_start_date,
      intern_end_date: user.intern_end_date,
      engineer_id: user.engineer_id,
      showIntro
    });
  } catch (err) {
    console.error('Giriş Hatası:', err);
    res.status(500).json({ error: 'Sunucu hatası oluştu.' });
  }
});

// GET /api/users/pending - Onay Bekleyen Yönetici / Liderleri Getir
app.get('/api/users/pending', async (req, res) => {
  try {
    const result = await db.execute(
      `SELECT id, name, username, department, role, leader_sub_type AS leaderType, status 
       FROM users 
       WHERE status = 'PENDING' 
       ORDER BY id DESC`
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Pending kullanıcı getirme hatası:', err);
    res.status(500).json({ error: 'Veriler alınırken bir sorun oluştu.' });
  }
});

// PATCH /api/users/:id/approve - Kullanıcıyı Onayla
app.patch('/api/users/:id/approve', async (req, res) => {
  try {
    const userId = req.params.id;

    const result = await db.execute({
      sql: `UPDATE users SET status = 'APPROVED' WHERE id = ?`,
      args: [userId]
    });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    }

    const updated = await db.execute({
      sql: `SELECT id, name, status FROM users WHERE id = ?`,
      args: [userId]
    });

    res.json({
      message: 'Kullanıcı başarıyla onaylandı.',
      user: updated.rows[0]
    });
  } catch (err) {
    console.error('Kullanıcı onaylama hatası:', err);
    res.status(500).json({ error: 'Onaylama işlemi başarısız.' });
  }
});

// Şifre Sıfırlama
// --- ŞİFRE SIFIRLAMA (3 adım: kullanıcı adı+e-posta doğrula -> e-postaya kod gönder ->
//     kodu doğrula -> yeni şifreyi kaydet) ---

// Doğrulama kodu e-postasını Brevo üzerinden gönderir; mevcut görev bildirimi e-postalarıyla
// aynı gönderici/şablon dilini kullanır.
async function sendPasswordResetCodeEmail(toEmail, toName, code) {
  const companyLogoUrl = SETTINGS_CACHE.site_logo_url;
  await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'api-key': process.env.BREVO_API_KEY,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      sender: { name: SETTINGS_CACHE.email_sender_name, email: SETTINGS_CACHE.email_sender_address },
      to: [{ email: toEmail, name: toName }],
      subject: `Şifre Sıfırlama Doğrulama Kodu: ${code}`,
      htmlContent: `
        <div style="background-color: #ffffff; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 40px 20px; color: #0f172a;">
          <div style="max-width: 480px; margin: 0 auto; background-color: #0f172a; border-radius: 16px; border: 1px solid #e2e8f0; padding: 32px; text-align: center;">
            <img src="${companyLogoUrl}" alt="Logo" style="height: 44px; width: auto; margin-bottom: 16px;" />
            <h2 style="color: #0284c7; margin: 0 0 12px; font-size: 18px; font-weight: 700;">Şifre Sıfırlama Talebi</h2>
            <p style="font-size: 14px; line-height: 1.6; color: #ffffff; margin-bottom: 20px;">
              Merhaba <strong style="color: #38bdf8;">${toName}</strong>, şifrenizi sıfırlamak için aşağıdaki doğrulama kodunu kullanın:
            </p>
            <div style="background-color: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 18px; font-size: 32px; letter-spacing: 8px; font-weight: 700; color: #38bdf8; margin-bottom: 20px;">
              ${code}
            </div>
            <p style="font-size: 12px; color: #94a3b8; margin: 0;">Bu kod 10 dakika içinde geçerliliğini yitirir. Bu talebi siz oluşturmadıysanız bu e-postayı yok sayabilirsiniz.</p>
          </div>
        </div>
      `
    })
  });
}

// Görev/proje bildirim e-postalarının ortak "detay tablolu" şablonu (görev atama/tamamlama/
// revize/onay, proje atama gibi tüm bildirimlerde aynı görsel dili kullanır). Hata durumunda
// isteği patlatmaz, sadece loglar — e-posta gönterimi asıl işlemi asla bloklamamalı.
// detailsRows: [[label, value], ...]
async function sendDetailsEmail(toEmail, toName, subject, headerTitle, introHtml, detailsRows, buttonText) {
  try {
    const companyLogoUrl = SETTINGS_CACHE.site_logo_url;
    const appDashboardUrl = SETTINGS_CACHE.dashboard_url;
    const rowsHtml = detailsRows.map(([label, value]) => `
      <tr>
        <td style="padding: 6px 0; color: #94a3b8; width: 120px;">${label}:</td>
        <td style="padding: 6px 0; color: #ffffff; font-weight: 600;">${value}</td>
      </tr>
    `).join('');

    await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': process.env.BREVO_API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: SETTINGS_CACHE.email_sender_name, email: SETTINGS_CACHE.email_sender_address },
        to: [{ email: toEmail, name: toName }],
        subject,
        htmlContent: `
          <div style="background-color: #ffffff; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 40px 20px; color: #0f172a;">
            <div style="max-width: 600px; margin: 0 auto; background-color: #0f172a; border-radius: 16px; border: 1px solid #e2e8f0; padding: 32px; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05);">
              <div style="text-align: center; margin-bottom: 28px;">
                <img src="${companyLogoUrl}" alt="Logo" style="height: 48px; width: auto; margin-bottom: 12px;" />
                <h2 style="color: #0284c7; margin: 0; font-size: 20px; font-weight: 700;">${headerTitle}</h2>
              </div>
              <p style="font-size: 15px; line-height: 1.6; color: #ffffff; margin-bottom: 24px;">${introHtml}</p>
              <div style="background-color: #1e293b; border-radius: 12px; border: 1px solid #334155; padding: 20px; margin-bottom: 28px;">
                <table style="width: 100%; border-collapse: collapse; font-size: 14px;">${rowsHtml}</table>
              </div>
              <div style="text-align: center; margin-bottom: 12px;">
                <a href="${appDashboardUrl}" style="background: linear-gradient(135deg, #0284c7 0%, #06b6d4 100%); color: #ffffff; text-decoration: none; font-weight: 700; font-size: 14px; padding: 12px 28px; border-radius: 10px; display: inline-block; box-shadow: 0 4px 12px rgba(6, 182, 212, 0.25);">${buttonText}</a>
              </div>
            </div>
            <div style="text-align: center; margin-top: 20px; font-size: 12px; color: #64748b;">
              <p style="margin: 0;">Bu e-posta ${SETTINGS_CACHE.site_name} tarafından otomatik olarak gönderilmiştir.</p>
            </div>
          </div>
        `
      })
    });
  } catch (mailErr) {
    console.error('E-posta gönderilirken hata oluştu:', mailErr.message);
  }
}

// ADIM 1: Kullanıcı adı + e-posta veritabanında eşleşiyor mu kontrol edilir; eşleşiyorsa
// e-postaya 6 haneli doğrulama kodu gönderilir.
app.post('/api/password-reset/request', async (req, res) => {
  try {
    const { username, email } = req.body;
    if (!username || !email) return res.status(400).json({ error: 'Kullanıcı adı ve e-posta gereklidir.' });

    const result = await db.execute({
      sql: `SELECT id, name, email FROM users WHERE username = ? AND email = ?`,
      args: [username.trim(), email.trim()]
    });
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Bu kullanıcı adı ve e-posta eşleşen bir hesap bulunamadı.' });
    }
    const user = result.rows[0];

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await db.execute({
      sql: `UPDATE users SET reset_code = ?, reset_code_expires = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?`,
      args: [code, expires, user.id]
    });

    try {
      await sendPasswordResetCodeEmail(user.email, user.name, code);
    } catch (mailErr) {
      console.error('Doğrulama kodu e-postası gönderilemedi:', mailErr.message);
      return res.status(500).json({ error: 'Doğrulama kodu gönderilemedi. Lütfen daha sonra tekrar deneyin.' });
    }

    res.json({ message: 'Doğrulama kodu e-posta adresinize gönderildi.' });
  } catch (error) {
    res.status(500).json({ error: 'Sunucu hatası: ' + error.message });
  }
});

// ADIM 2: E-postaya gönderilen kod doğrulanır; başarılıysa tek seferlik, kısa ömürlü bir
// jeton üretilir (kod tekrar kullanılamasın diye temizlenir) — son adımda bu jeton istenir.
app.post('/api/password-reset/verify-code', async (req, res) => {
  try {
    const { username, email, code } = req.body;
    if (!username || !email || !code) return res.status(400).json({ error: 'Kod gereklidir.' });

    const result = await db.execute({
      sql: `SELECT id, reset_code, reset_code_expires FROM users WHERE username = ? AND email = ?`,
      args: [username.trim(), email.trim()]
    });
    if (result.rows.length === 0) return res.status(400).json({ error: 'Hesap bulunamadı.' });
    const user = result.rows[0];

    if (!user.reset_code || user.reset_code !== String(code).trim()) {
      return res.status(400).json({ error: 'Doğrulama kodu hatalı.' });
    }
    if (!user.reset_code_expires || new Date(user.reset_code_expires).getTime() < Date.now()) {
      return res.status(400).json({ error: 'Doğrulama kodunun süresi doldu. Lütfen tekrar kod isteyin.' });
    }

    const token = crypto.randomBytes(24).toString('hex');
    const tokenExpires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await db.execute({
      sql: `UPDATE users SET reset_code = NULL, reset_code_expires = NULL, reset_token = ?, reset_token_expires = ? WHERE id = ?`,
      args: [token, tokenExpires, user.id]
    });

    res.json({ token });
  } catch (error) {
    res.status(500).json({ error: 'Sunucu hatası: ' + error.message });
  }
});

// ADIM 3: ADIM 2'den alınan jeton ile yeni şifre kaydedilir.
app.post('/api/password-reset/complete', async (req, res) => {
  try {
    const { username, email, token, newPassword } = req.body;
    if (!username || !email || !token || !newPassword) {
      return res.status(400).json({ error: 'Eksik bilgi.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Şifre en az 6 karakter olmalıdır.' });
    }

    const result = await db.execute({
      sql: `SELECT id, reset_token, reset_token_expires FROM users WHERE username = ? AND email = ?`,
      args: [username.trim(), email.trim()]
    });
    if (result.rows.length === 0) return res.status(400).json({ error: 'Hesap bulunamadı.' });
    const user = result.rows[0];

    if (!user.reset_token || user.reset_token !== token) {
      return res.status(400).json({ error: 'Doğrulama oturumu geçersiz. Lütfen baştan başlayın.' });
    }
    if (!user.reset_token_expires || new Date(user.reset_token_expires).getTime() < Date.now()) {
      return res.status(400).json({ error: 'Doğrulama oturumunun süresi doldu. Lütfen baştan başlayın.' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await db.execute({
      sql: `UPDATE users SET password = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?`,
      args: [hashedPassword, user.id]
    });

    res.json({ message: 'Şifreniz başarıyla güncellendi.' });
  } catch (error) {
    res.status(500).json({ error: 'Sunucu hatası: ' + error.message });
  }
});


// Kullanıcı Kendi Profil Bilgilerini Güncelleme (Tüm Kayıt Alanları Dahil)
// Profil tamamlama: kullanıcı ilk girişte eksik telefon/e-posta bilgisini tamamlar
app.put('/api/users/:id/complete-profile', async (req, res) => {
  try {
    const uid = req.params.id;
    const { email, phone } = req.body;
    if (!email || !email.trim()) return res.status(400).json({ error: 'E-posta zorunludur.' });
    if (!phone || !phone.trim()) return res.status(400).json({ error: 'Telefon zorunludur.' });
    await db.execute({
      sql: `UPDATE users SET email = ?, phone = ? WHERE id = ?`,
      args: [email.trim(), phone.trim(), uid]
    });
    res.json({ message: 'Profil tamamlandı.', email: email.trim(), phone: phone.trim() });
  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'Bu e-posta adresi başka bir kullanıcı tarafından kullanılıyor!' });
    }
    res.status(500).json({ error: 'Profil tamamlanamadı: ' + error.message });
  }
});

// Stajyerin sorumlu mühendisini kaydetme: ilk girişte zorunlu seçim adımı için kullanılır
app.put('/api/users/:id/engineer', async (req, res) => {
  try {
    const uid = req.params.id;
    const { engineerId } = req.body;
    if (!engineerId) return res.status(400).json({ error: 'Sorumlu mühendis seçimi zorunludur.' });

    const engRes = await db.execute({
      sql: `SELECT id, name FROM users WHERE id = ? AND role = 'ENGINEER'`,
      args: [engineerId]
    });
    if (engRes.rows.length === 0) return res.status(400).json({ error: 'Geçersiz mühendis seçimi.' });

    await db.execute({
      sql: `UPDATE users SET engineer_id = ? WHERE id = ?`,
      args: [engineerId, uid]
    });
    res.json({ message: 'Sorumlu mühendis kaydedildi.', engineerId: Number(engineerId), engineerName: engRes.rows[0].name });
  } catch (error) {
    res.status(500).json({ error: 'Kaydedilemedi: ' + error.message });
  }
});

app.put('/api/users/profile', async (req, res) => {
  try {
    const { userId, name, email, password, phone, username, subArea, leaderType, startDate, endDate, engineerId } = req.body;

    if (!userId || !name || !email) {
      return res.status(400).json({ error: 'Zorunlu alanlar eksik!' });
    }

    // Kullanıcı adı değiştiriliyorsa başka bir hesapla çakışmadığından emin ol
    // (users.username üzerinde DB seviyesinde UNIQUE kısıtı yok, burada uygulama seviyesinde kontrol ediyoruz).
    if (username && username.trim()) {
      const dupRes = await db.execute({
        sql: `SELECT id FROM users WHERE username = ? AND id != ?`,
        args: [username.trim(), userId]
      });
      if (dupRes.rows.length > 0) {
        return res.status(400).json({ error: 'Bu kullanıcı adı başka bir kullanıcı tarafından kullanılıyor!' });
      }
    }

    const commonArgs = [
      name, email, username || null, phone || null, subArea || null, leaderType || null,
      startDate || null, endDate || null, engineerId || null
    ];

    if (password && password.trim() !== '') {
      const hashedPassword = await bcrypt.hash(password, 10);
      await db.execute({
        sql: `UPDATE users SET name = ?, email = ?, username = ?, phone = ?, sub_area = ?, leader_sub_type = ?, intern_start_date = ?, intern_end_date = ?, engineer_id = ?, password = ? WHERE id = ?`,
        args: [...commonArgs, hashedPassword, userId]
      });
    } else {
      await db.execute({
        sql: `UPDATE users SET name = ?, email = ?, username = ?, phone = ?, sub_area = ?, leader_sub_type = ?, intern_start_date = ?, intern_end_date = ?, engineer_id = ? WHERE id = ?`,
        args: [...commonArgs, userId]
      });
    }

    res.json({ message: 'Profil başarıyla güncellendi.' });
  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'Bu e-posta adresi başka bir kullanıcı tarafından kullanılıyor!' });
    }
    res.status(500).json({ error: 'Profil güncellenirken hata oluştu: ' + error.message });
  }
});

// Kullanıcı Listesi
app.get('/api/users', async (req, res) => {
  try {
    const { department, role } = req.query;

    let sql = `SELECT id, name, email, username, department, role, status, sub_area, phone, leader_sub_type, intern_start_date, intern_end_date, engineer_id FROM users`;
    let args = [];

    // Departman bazlı görünürlük: ADMIN ve HR hariç herkes sadece kendi biriminin personelini görür
    if (role && role !== 'ADMIN' && role !== 'HR' && department) {
      sql += ` WHERE department = ?`;
      args.push(department);
    }

    const result = await db.execute({ sql, args });
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Staj Tarihlerini Güncelleme
app.put('/api/users/:id/intern-dates', async (req, res) => {
  try {
    const userId = req.params.id;
    const { startDate, endDate } = req.body;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Başlangıç ve bitiş tarihleri gereklidir.' });
    }

    await db.execute({
      sql: `UPDATE users SET intern_start_date = ?, intern_end_date = ? WHERE id = ?`,
      args: [startDate, endDate, userId]
    });

    res.json({ message: 'Staj tarihleri başarıyla güncellendi.' });
  } catch (error) {
    res.status(500).json({ error: 'Tarihler kaydedilemedi: ' + error.message });
  }
});

// Görev Oluşturma
app.post('/api/tasks', async (req, res) => {
  try {
    const { title, description, assignedTo, category, endDate, workDays, createdBy, userRole, userId, projectId, isKartPlaniTask, batchId } = req.body;

    if (!['ADMIN', 'HR', 'MANAGER', 'LEADER', 'ENGINEER', 'INTERN'].includes(userRole)) {
      return res.status(403).json({ error: 'Görev atamaya yetkiniz yok!' });
    }
    // Stajyer sadece kendi kendine (hatırlatma amaçlı) görev ekleyebilir, başkasına atayamaz.
    if (userRole === 'INTERN' && Number(assignedTo) !== Number(userId)) {
      return res.status(403).json({ error: 'Sadece kendinize görev ekleyebilirsiniz.' });
    }

    // Atanan kişi gerçekten görev alabilecek (çalışan) bir rolde ve onaylı olmalı —
    // Ekip Lideri/Müdür artık herhangi bir birimden/rolden atayabildiği için sunucu
    // tarafında da doğrulanır.
    const ASSIGNABLE_ROLES = ['INTERN', 'TECHNICIAN', 'ENGINEER', 'LEADER'];
    const assigneeCheck = await db.execute({ sql: `SELECT role, status FROM users WHERE id = ?`, args: [assignedTo] });
    const assigneeUser = assigneeCheck.rows[0];
    if (!assigneeUser || !ASSIGNABLE_ROLES.includes(assigneeUser.role) || assigneeUser.status !== 'APPROVED') {
      return res.status(400).json({ error: 'Geçersiz görev atama hedefi.' });
    }

    const result = await db.execute({
      sql: `INSERT INTO tasks (title, description, assigned_to, category, end_date, work_days, created_by, status, project_id, is_kart_plani_task, assign_batch_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'IN_PROGRESS', ?, ?, ?)`,
      args: [title, description || '', assignedTo, category, endDate, workDays, createdBy, projectId || null, isKartPlaniTask ? 1 : 0, batchId || null]
    });
    const newTaskId = Number(result.lastInsertRowid);

    // Kart Planı görevleri sadece bir Proje sayfasındaki iş planını taşımak için var — normal bir
    // görev ataması gibi e-posta/bildirim/takvim etkinliği tetiklemez (kullanıcı zaten kendi
    // tıklamasıyla oluşturdu).
    if (isKartPlaniTask) {
      return res.json({ id: newTaskId, message: 'Kart planı görevi oluşturuldu.' });
    }

    const userResult = await db.execute({
      sql: `SELECT name, email FROM users WHERE id = ?`,
      args: [assignedTo]
    });

    const intern = userResult.rows[0];

    if (intern && intern.email && SETTINGS_CACHE.email_task_assigned) {
      await sendDetailsEmail(
        intern.email, intern.name,
        `Yeni Görev Atandı: ${title}`,
        'Yeni Görev Bildirimi',
        `Merhaba <strong style="color: #38bdf8;">${intern.name}</strong>, <strong style="color: #0284c7;">${createdBy}</strong> tarafından tarafınıza yeni bir görev atandı. Detaylar aşağıda yer almaktadır:`,
        [
          ['Görev Başlığı', title],
          ['Kategori', category],
          ['Son Teslim', `${endDate} (${workDays} İş Günü)`],
          ['Atayan Lider', createdBy],
          ['Açıklama', description || 'Açıklama bulunmuyor.']
        ],
        'Görevi İncele'
      );
    }

    // Google Takvim senkronu (kullanıcı takvimini bağladıysa). Yanıtı bekletmemek için await sonrası.
    syncTaskToGoogle(newTaskId).catch(e => console.error('Task sync:', e.message));

    // Atanan kişiye bildirim düşür
    createNotification(assignedTo, 'TASK_ASSIGNED', 'TASKS', 'Yeni Görev Atandı', `${createdBy} size "${title}" görevini atadı.`, newTaskId)
      .catch(e => console.error('Görev bildirimi hatası:', e.message));

    res.json({ id: newTaskId, message: "Görev oluşturuldu ve e-posta bildirimi gönderildi." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// LioXERP ENTEGRASYONU (Uyumsoft ERP — "Talep Formu" listesi): LioXERP'in resmi/dokümante bir REST
// API'si olmadığından (eski nesil ASP.NET WebForms + DevExpress ASPxGridView arayüzü), giriş ve
// liste sayfası, tarayıcının kendisinin yaptığı istekler taklit edilerek elde edilir. Ortak bir
// servis hesabı (.env: LIOXERP_USERNAME/PASSWORD) kullanılır — bireysel kullanıcı girişleri değil.
// Oturum çerezi bir süre bellekte tutulur; düşerse otomatik olarak yeniden giriş yapılır.
// ============================================================
const LIOXERP_BASE_URL = process.env.LIOXERP_BASE_URL || 'http://154.53.161.123';
const LIOXERP_USERNAME = process.env.LIOXERP_USERNAME;
const LIOXERP_PASSWORD = process.env.LIOXERP_PASSWORD;

function lioxerpRequest(pathAndQuery, method, headers, body) {
  return new Promise((resolve, reject) => {
    const base = new URL(LIOXERP_BASE_URL);
    const mod = base.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: base.hostname,
      port: base.port || (base.protocol === 'https:' ? 443 : 80),
      path: pathAndQuery,
      method,
      headers
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// lioxerpRequest gövdeyi string olarak biriktirir (chunk += string), bu da PDF gibi ikili
// yanıtları bozar. PDF export isteği için ayrı, Buffer tabanlı bir varyant gerekir.
function lioxerpRequestBuffer(pathAndQuery, method, headers, body) {
  return new Promise((resolve, reject) => {
    const base = new URL(LIOXERP_BASE_URL);
    const mod = base.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: base.hostname,
      port: base.port || (base.protocol === 'https:' ? 443 : 80),
      path: pathAndQuery,
      method,
      headers
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => { chunks.push(chunk); });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function lioxerpCookieHeaderFrom(setCookieArray) {
  return (setCookieArray || []).map(c => c.split(';')[0]).join('; ');
}

// Bir ASP.NET WebForms sayfasındaki tüm gizli (hidden) alanları (ör. __VIEWSTATE) okur — bu sayfayı
// olduğu gibi geri göndermek (postback) için gereklidir.
// Türkçe karakterler bu sayfalarda sayısal HTML karakter referansı olarak gelir (ör. &#199; = Ç).
function lioxerpDecodeHtml(str) {
  return String(str || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .trim();
}

function lioxerpExtractHiddenFields(html) {
  const fields = {};
  const re = /<input[^>]*type="hidden"[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const nameMatch = tag.match(/name="([^"]+)"/);
    const valueMatch = tag.match(/value="([^"]*)"/);
    if (nameMatch) {
      fields[nameMatch[1]] = valueMatch ? lioxerpDecodeHtml(valueMatch[1]) : '';
    }
  }
  return fields;
}

// LioXERP'e giriş yapıp o oturuma ait çerezi döner (tarayıcıdaki gerçek giriş isteğinin birebir
// aynısı: POST /login.aspx/LogIn, JSON gövde).
async function lioxerpLogin() {
  if (!LIOXERP_USERNAME || !LIOXERP_PASSWORD) {
    throw new Error('LIOXERP_USERNAME / LIOXERP_PASSWORD tanımlı değil (.env dosyasını kontrol edin).');
  }
  const homeRes = await lioxerpRequest('/login.aspx', 'GET', {});
  const sessionCookie = lioxerpCookieHeaderFrom(homeRes.headers['set-cookie']);

  const loginPayload = JSON.stringify({ username: LIOXERP_USERNAME, password: LIOXERP_PASSWORD, captchacode: null, ldap: false });
  const loginRes = await lioxerpRequest('/login.aspx/LogIn', 'POST', {
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Length': Buffer.byteLength(loginPayload),
    'Cookie': sessionCookie
  }, loginPayload);

  let loggedIn = false;
  try { loggedIn = JSON.parse(JSON.parse(loginRes.body).d).LoggedIn === true; } catch (e) {}
  if (!loggedIn) throw new Error('LioXERP girişi başarısız oldu (kullanıcı adı/şifre veya sunucu adresini kontrol edin).');

  return sessionCookie;
}

// Aktif oturum çerezini döner; yoksa/geçersiz sayılırsa yeni bir giriş yapar. Aynı anda birden
// fazla istek gelirse tek bir girişin paylaşılması için promise önbelleğe alınır.
let lioxerpSessionCookie = null;
let lioxerpLoginPromise = null;
async function lioxerpGetSession(forceNew) {
  if (!forceNew && lioxerpSessionCookie) return lioxerpSessionCookie;
  if (!lioxerpLoginPromise) {
    lioxerpLoginPromise = lioxerpLogin().finally(() => { lioxerpLoginPromise = null; });
  }
  lioxerpSessionCookie = await lioxerpLoginPromise;
  return lioxerpSessionCookie;
}

// Bir DevExpress ASPxGridView tablosunun ham HTML'inden satırları ayrıştırır — her hücre
// "fieldname=" ile işaretlenmiş. rowIdPrefix, satırların <tr id="..."> önekidir (grid her yerde
// farklı bir id kullanır — ör. liste ekranında "myListPage_DXDataRow", kart ekranındaki satır
// detayında "TPnControl_grd_DemFormDCollection_DXDataRow").
function lioxerpParseGridRows(html, rowIdPrefix) {
  const rows = [];
  const rowRe = new RegExp(`<tr id="${rowIdPrefix}\\d+"[^>]*>([\\s\\S]*?)<\\/tr>`, 'g');
  const cellRe = /fieldname="([^"]+)"[^>]*>(?:<a[^>]*>)?([^<]*)/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(html))) {
    const rowHtml = rowMatch[1];
    const row = {};
    let cellMatch;
    cellRe.lastIndex = 0;
    while ((cellMatch = cellRe.exec(rowHtml))) {
      row[cellMatch[1]] = lioxerpDecodeHtml(cellMatch[2]);
    }
    if (Object.keys(row).length > 0) rows.push(row);
  }
  return rows;
}

// Ekrandaki normal "Ara" araması, bu hesabın oturumuna göre yalnızca eski/kısıtlı bir alt kümeyi
// döndürüyor (sebebi tam çözülemedi — muhtemelen sunucu tarafında oturuma özel bir önbellek/kapsam).
// Ancak araç çubuğundaki "Yazdır/Dışarı Aktar" menü öğesi (CustomMenu, CLICK:0i3i0) bu kısıtlamayı
// atlayıp ekrandaki filtreyle eşleşen TÜM kayıtları tek bir PDF'e basıyor — taze bir oturumdan bile.
// Bu yüzden liste verisini HTML grid yerine bu PDF export'unu ayrıştırarak elde ediyoruz.
//
// PDF, yazdırma genişliği yüzünden her kayıt grubunu 3 ardışık sayfaya bölüyor:
//   sayfa 1: Id, İşyeri Kodu, İşyeri Adı, Belge No, Belge Tarihi, Hareket Kodu
//   sayfa 2: Hareket Adı, Kar Merkezi Kodu, Talep Eden Kullanıcı, Özel Kod1, Özel Kod2
//   sayfa 3: Talep Depo Kodu, Talep Depo Adı, Onay Durumu, Icon
// ve bu 3'lü döngü sayfa sonuna kadar tekrarlanır. Aynı gruptaki 3 sayfa aynı satır sırasını
// korur, bu yüzden satırlar indekse göre eşlenip birleştirilir.
function lioxerpParsePdfGroup1(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  lines.shift(); // başlık satırı
  const rows = [];
  let buffer = '';
  for (const line of lines) {
    buffer = buffer ? `${buffer} ${line}` : line;
    if (/FRM-\w+$/.test(buffer)) {
      rows.push(buffer);
      buffer = '';
    }
  }
  const re = /^(\d+)\s+(\S+)\s+(.*?)\s+(\S+-\d+)\s+(\d{2}\.\d{2}\.\d{4})\s+(FRM-\w+)$/;
  return rows.map((row) => {
    const m = row.match(re);
    if (!m) return {};
    return { Id: m[1], BranchCode: m[2], BranchDesc: m[3], DocNo: m[4], DocDate: m[5], DocTraCode: m[6] };
  });
}
function lioxerpParsePdfGroup2(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  lines.shift();
  return lines.map((line) => {
    let l = line;
    let hareket = '';
    if (l.startsWith('ELEKTRONİK TALEP FORMU')) { hareket = 'ELEKTRONİK TALEP FORMU'; l = l.slice(hareket.length).trim(); }
    else if (l.startsWith('MEKANİK TALEP FORMU')) { hareket = 'MEKANİK TALEP FORMU'; l = l.slice(hareket.length).trim(); }
    return { DocTraDesc: hareket, RequestUserName: l };
  });
}
function lioxerpParsePdfGroup3(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  lines.shift();
  return lines.map((line) => {
    if (line === '0') return { WhouseCode: '', WhouseDesc: '' };
    const m = line.match(/^(.*?)\s+\1\s+0$/);
    if (m) return { WhouseCode: m[1], WhouseDesc: m[1] };
    return {};
  });
}

// "Talep Formu" (DemFormMCollection) listesini çeker: liste sayfası GET edilip, araç
// çubuğundaki "Yazdır/Dışarı Aktar" menü tıklamasının aynısı (__EVENTTARGET=CustomMenu,
// __EVENTARGUMENT=CLICK:0i3i0) POST edilir, dönen PDF ayrıştırılıp satırlara çevrilir.
async function lioxerpFetchTalepFormlari(retry) {
  const cookie = await lioxerpGetSession(!!retry);
  const listPath = '/MainList.aspx?CommandName=DemFormMCollection.Show&M=1&MenuId=622';

  const listRes = await lioxerpRequest(listPath, 'GET', { 'Cookie': cookie });
  if (!retry && !listRes.body.includes('myListPage_DXMainTable')) {
    return lioxerpFetchTalepFormlari(true);
  }

  const fields = lioxerpExtractHiddenFields(listRes.body);
  const formData = { ...fields };
  formData['__EVENTTARGET'] = 'CustomMenu';
  formData['__EVENTARGUMENT'] = 'CLICK:0i3i0';

  const bodyStr = Object.entries(formData).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const pdfRes = await lioxerpRequestBuffer(listPath, 'POST', {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(bodyStr),
    'Cookie': cookie
  }, bodyStr);

  if (!retry && !String(pdfRes.headers['content-type'] || '').includes('application/pdf')) {
    return lioxerpFetchTalepFormlari(true);
  }

  const parser = new PDFParse({ data: pdfRes.body });
  const parsed = await parser.getText();
  await parser.destroy();
  const pages = parsed.pages ? parsed.pages.map((p) => p.text) : [parsed.text];

  const allRows = [];
  for (let i = 0; i < pages.length; i += 3) {
    const g1 = lioxerpParsePdfGroup1(pages[i] || '');
    const g2 = lioxerpParsePdfGroup2(pages[i + 1] || '');
    const g3 = lioxerpParsePdfGroup3(pages[i + 2] || '');
    const n = Math.max(g1.length, g2.length, g3.length);
    for (let j = 0; j < n; j++) {
      allRows.push({ ...(g1[j] || {}), ...(g2[j] || {}), ...(g3[j] || {}) });
    }
  }

  return allRows.filter((r) => r.Id);
}

// Bir "Talep Formu" kaydının satır bazlı detaylarını (ürün/hizmet, miktar, birim fiyat, tutar,
// proje kodu, notlar vb.) çeker — tarayıcıda bir kayda çift tıklandığında açılan "Kart" ekranıyla
// birebir aynı sayfa: GeneralCard.aspx?CommandName=DemFormMCollection.Update&ObjectId=<id>.
async function lioxerpFetchTalepFormuDetay(id, retry) {
  const cookie = await lioxerpGetSession(!!retry);
  const cardPath = `/GeneralCard.aspx?CommandName=DemFormMCollection.Update&ObjectId=${encodeURIComponent(id)}`;

  const cardRes = await lioxerpRequest(cardPath, 'GET', { 'Cookie': cookie });
  if (!retry && !cardRes.body.includes('grd_DemFormDCollection')) {
    return lioxerpFetchTalepFormuDetay(id, true);
  }

  return lioxerpParseGridRows(cardRes.body, 'TPnControl_grd_DemFormDCollection_DXDataRow');
}

// Talep Formu satır/ürün detaylarının arama için önbelleği. Liste ekranındaki arama kutusunun
// "dosya içindeki" (ürün adı, proje kodu, notlar vb.) kısımları da tarayabilmesi için, listenin
// tamamının detayı arka planda (kullanıcı beklemeden) LioXERP'ten çekilip belleğe alınır.
const lioxerpDetailCache = new Map(); // Id -> satır dizisi
let lioxerpDetailPrefetch = { running: false, total: 0, done: 0 };

// Bir kaydın önbellekteki satırlarından, arama kutusunda eşleşebilecek metinleri tek bir
// string'e birleştirir.
function lioxerpDetailSearchText(id) {
  const lines = lioxerpDetailCache.get(id);
  if (!lines || lines.length === 0) return '';
  return lines
    .map((l) => [l.DcardName, l.ItemNameManual, l.ProjectCode, l.Note1, l.Note2, l.Note3, l.DemFormPlanningCode].filter(Boolean).join(' '))
    .join(' ');
}

// Bir kaydın satırlarında geçen tekil (boş olmayan) proje kodlarını döner — İşyeri > Birim >
// Proje Kodu şeklindeki basamaklı filtrede kullanılır.
function lioxerpDetailProjectCodes(id) {
  const lines = lioxerpDetailCache.get(id);
  if (!lines || lines.length === 0) return [];
  return [...new Set(lines.map((l) => l.ProjectCode).filter(Boolean))];
}

// Verilen id listesindeki her kaydın satır detayını (sınırlı eşzamanlılıkla) arka planda çeker.
// Aynı anda tek bir tarama çalışır; zaten çalışıyorsa yeni bir tanesi başlatılmaz.
async function lioxerpPrefetchDetailsInBackground(ids) {
  if (lioxerpDetailPrefetch.running) return;
  const pending = ids.filter((id) => !lioxerpDetailCache.has(id));
  lioxerpDetailPrefetch = { running: true, total: pending.length, done: 0 };
  if (pending.length === 0) { lioxerpDetailPrefetch.running = false; return; }

  const CONCURRENCY = 5;
  let index = 0;
  async function worker() {
    while (index < pending.length) {
      const id = pending[index++];
      try {
        const rows = await lioxerpFetchTalepFormuDetay(id);
        lioxerpDetailCache.set(id, rows);
      } catch (e) {
        lioxerpDetailCache.set(id, []); // hata alınsa da tekrar tekrar denenip sunucuyu yormasın
      }
      lioxerpDetailPrefetch.done++;
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  lioxerpDetailPrefetch.running = false;
}

// Admin Yetki Kontrolü Fonksiyonu (İK, admin ile birebir aynı yetkilere sahiptir)
const isAdmin = (role) => role === 'ADMIN' || role === 'HR';
// Firma/Proje yönetiminde kendi biriminle sınırlı erişimi olan roller (Müdür, Ekip Lideri)
const isDeptLockedRole = (role) => role === 'MANAGER' || role === 'LEADER';

// LioXERP "Talep Formu" listesini döner — Admin/İK.
app.get('/api/lioxerp/talep-formlari', async (req, res) => {
  try {
    const { userRole } = req.query;
    if (!isAdmin(userRole)) return res.status(403).json({ error: 'Bu alana erişim yetkiniz yok.' });
    const rows = await lioxerpFetchTalepFormlari();
    res.json(rows);
    // Liste yanıtı gönderildikten sonra, arama kutusunun satır/ürün detaylarını da kapsayabilmesi
    // için tüm kayıtların detayı arka planda (kullanıcıyı bekletmeden) önbelleğe alınır.
    lioxerpPrefetchDetailsInBackground(rows.map((r) => r.Id)).catch(() => {});
  } catch (error) {
    console.error('LioXERP veri çekme hatası:', error.message);
    res.status(502).json({ error: 'LioXERP verisi alınamadı: ' + error.message });
  }
});

// Arka planda önbelleğe alınan satır/ürün detaylarından oluşan arama indeksini döner — arama
// kutusu bu indeksi liste verisiyle birleştirerek "dosya içindeki" kısımları da tarar.
app.get('/api/lioxerp/talep-formlari-arama-indeksi', (req, res) => {
  const { userRole } = req.query;
  if (!isAdmin(userRole)) return res.status(403).json({ error: 'Bu alana erişim yetkiniz yok.' });
  const index = {};
  const projects = {};
  for (const id of lioxerpDetailCache.keys()) {
    const text = lioxerpDetailSearchText(id);
    if (text) index[id] = text;
    const codes = lioxerpDetailProjectCodes(id);
    if (codes.length > 0) projects[id] = codes;
  }
  res.json({ index, projects, progress: { ...lioxerpDetailPrefetch } });
});

// Tek bir Talep Formu kaydının satır detaylarını döner — Admin/İK.
app.get('/api/lioxerp/talep-formlari/:id', async (req, res) => {
  try {
    const { userRole } = req.query;
    if (!isAdmin(userRole)) return res.status(403).json({ error: 'Bu alana erişim yetkiniz yok.' });
    const cached = lioxerpDetailCache.get(req.params.id);
    const rows = cached && cached.length > 0 ? cached : await lioxerpFetchTalepFormuDetay(req.params.id);
    if (!lioxerpDetailCache.has(req.params.id)) lioxerpDetailCache.set(req.params.id, rows);
    res.json(rows);
  } catch (error) {
    console.error('LioXERP detay çekme hatası:', error.message);
    res.status(502).json({ error: 'LioXERP detayı alınamadı: ' + error.message });
  }
});

// Proje aşama checklist'ini (şablon uygulama, aşama işaretleme/ekleme/silme) kimin yönetebileceği:
// Admin/İK, Müdür/Ekip Lideri ve Mühendis her zaman; bunların dışında sadece o projenin sorumlusu (owner).
function canManageProjectStages(userRole, userId, project) {
  if (isAdmin(userRole) || isDeptLockedRole(userRole) || userRole === 'ENGINEER') return true;
  return !!(userId && project && project.owner_id != null && Number(project.owner_id) === Number(userId));
}

// Aşama checklist'inden genel ilerleme yüzdesini hesaplar: ana aşamalar eşit ağırlıklıdır (100/N);
// bir ana aşamanın alt aşamaları varsa o ağırlığı kendi aralarında eşit bölüşür, yoksa ana aşamanın
// kendisi (is_done) o ağırlığı tek başına taşır. Ağırlıklar hep anlık hesaplanır, DB'de saklanmaz —
// sonradan alt aşama eklenirse otomatik yeniden dağılır.
function computeStagePercentage(stageRows) {
  const mains = stageRows.filter(s => s.parent_id == null);
  if (mains.length === 0) return 0;
  const mainWeight = 100 / mains.length;
  let total = 0;
  for (const main of mains) {
    const children = stageRows.filter(s => s.parent_id === main.id);
    if (children.length === 0) {
      if (main.is_done) total += mainWeight;
    } else {
      const childWeight = mainWeight / children.length;
      total += children.filter(c => c.is_done).length * childWeight;
    }
  }
  return Math.round(total * 100) / 100;
}

// Bir şablon (oluşturma/düzenleme) isteğindeki {title, subItems:[...]} dizisini stage_template_items
// satırlarına yazar. PUT'ta önce eski satırlar silinip bu yeniden çağrılır (basit "diff'siz" yaklaşım).
async function writeStageTemplateItems(templateId, items) {
  let sortOrder = 0;
  for (const main of items) {
    if (!main || !main.title || !main.title.trim()) continue;
    const mRes = await db.execute({
      sql: `INSERT INTO stage_template_items (template_id, parent_item_id, title, sort_order) VALUES (?, NULL, ?, ?)`,
      args: [templateId, main.title.trim(), sortOrder++]
    });
    const mainItemId = Number(mRes.lastInsertRowid);
    let subOrder = 0;
    for (const sub of (main.subItems || [])) {
      const subTitle = typeof sub === 'string' ? sub : (sub && sub.title);
      if (!subTitle || !subTitle.trim()) continue;
      await db.execute({
        sql: `INSERT INTO stage_template_items (template_id, parent_item_id, title, sort_order) VALUES (?, ?, ?, ?)`,
        args: [templateId, mainItemId, subTitle.trim(), subOrder++]
      });
    }
  }
}

// Bir şablonun maddelerini (ana + alt aşama) bir projenin checklist'ine kopyalar. Projede zaten
// bir checklist varsa önce temizlenir (şablon değiştirme/yeniden uygulama da bunu kullanır) —
// şablonun kendisi bu işlemden etkilenmez, sadece projeye kopya oluşturulur.
async function applyStageTemplateToProject(templateId, projectId) {
  await db.execute({ sql: `DELETE FROM project_stages WHERE project_id = ?`, args: [projectId] });

  const itemsRes = await db.execute({
    sql: `SELECT id, parent_item_id, title, sort_order FROM stage_template_items WHERE template_id = ? ORDER BY sort_order ASC`,
    args: [templateId]
  });
  const items = itemsRes.rows;
  const idMap = {};
  const mains = items.filter(i => i.parent_item_id == null);
  const subs = items.filter(i => i.parent_item_id != null);

  for (const m of mains) {
    const r = await db.execute({
      sql: `INSERT INTO project_stages (project_id, parent_id, title, sort_order, is_done) VALUES (?, NULL, ?, ?, 0)`,
      args: [projectId, m.title, m.sort_order]
    });
    idMap[m.id] = Number(r.lastInsertRowid);
  }
  for (const s of subs) {
    const parentNewId = idMap[s.parent_item_id];
    if (parentNewId == null) continue;
    await db.execute({
      sql: `INSERT INTO project_stages (project_id, parent_id, title, sort_order, is_done) VALUES (?, ?, ?, ?, 0)`,
      args: [projectId, parentNewId, s.title, s.sort_order]
    });
  }
}

// Sol taraftaki "Ekip Rehberi" panelinden yapılan kullanıcı silme/düzenleme işlemleri için ortak
// yetki kontrolü: Admin/İK her yerde tam yetkili. Stajyer hiçbir zaman kimseyi silemez/düzenleyemez.
// Diğer roller SADECE kendi biriminde ve SADECE mevcut rol hiyerarşisinde (ROLE_HIERARCHY /
// getSubordinateRoles — bkz. aşağıda tanımlı) kendinden altta olan kişiler üzerinde işlem yapabilir.
async function authorizeHierarchicalUserAction(requesterId, requesterRole, targetUserId) {
  if (isAdmin(requesterRole)) return { allowed: true };
  if (requesterRole === 'INTERN') return { allowed: false, error: 'Bu işlemi yapmaya yetkiniz yok!' };

  const requesterRes = await db.execute({ sql: `SELECT department FROM users WHERE id = ?`, args: [requesterId] });
  const targetRes = await db.execute({ sql: `SELECT role, department FROM users WHERE id = ?`, args: [targetUserId] });
  if (requesterRes.rows.length === 0 || targetRes.rows.length === 0) {
    return { allowed: false, error: 'Kullanıcı bulunamadı.' };
  }

  const requesterDept = requesterRes.rows[0].department;
  const target = targetRes.rows[0];

  if (!requesterDept || target.department !== requesterDept) {
    return { allowed: false, error: 'Bu işlemi yalnızca kendi biriminizdeki kullanıcılar için yapabilirsiniz.' };
  }
  if (!getSubordinateRoles(requesterRole).includes(target.role)) {
    return { allowed: false, error: 'Bu kullanıcıyı silme/düzenleme yetkiniz yok.' };
  }
  return { allowed: true };
}

// Yapay zeka özellikleri (Akıllı İş Planı, Görev Asistanı, Genel Asistan) — ai.js içinde, izole.
app.use('/api', ai.createAiRouter(db, { isAdmin }));

// AI AJAN KATMANI (Function Calling + Dinamik System Prompt) — aiAgent.js içinde, izole.
// Onaylı yazma işlemleri: /api/agent/chat (öneri) + /api/agent/execute (uygula).
const aiAgent = require('./aiAgent');
app.use('/api', aiAgent.createAgentRouter(db, { isAdmin }));

// ÖZELLİK 5 — Otomatik Yönetici Özeti (rapor) — aiReport.js
const aiReport = require('./aiReport');
app.use('/api', aiReport.createReportRouter(db, { isAdmin }));
aiReport.startReportScheduler(db, { isAdmin, sendDetailsEmail, createNotification });

// ÖZELLİK 4 — Semantic Search / RAG (geçmiş görev hafızası) — aiRag.js
const aiRag = require('./aiRag');
aiRag.initRagSchema(db).catch(e => console.error('RAG şema:', e.message));
app.use('/api', aiRag.createRagRouter(db, { isAdmin }));
aiRag.startRagIndexer(db); // arka planda yeni/değişen görevleri indeksler

// ÖZELLİK 2+3 — Risk erken uyarı + Akıllı atama önerisi — aiInsights.js
const aiInsights = require('./aiInsights');
app.use('/api', aiInsights.createInsightsRouter(db, { isAdmin }));
aiInsights.startRiskScheduler(db); // saatlik risk taraması -> bildirim paneline yazar

// DOKÜMAN DENETİMİ — RAG + LLM-as-a-Judge: yeni .docx dokümanları onaylı referans
// dokümanlara göre denetler; onaylanan dokümanlar otomatik olarak referans hafızasına eklenir.
const aiDokDenetim = require('./aiDokDenetim');
aiDokDenetim.initDokDenetimSchema(db).catch(e => console.error('Doküman Denetimi şema:', e.message));
app.use('/api', aiDokDenetim.createDokDenetimRouter(db, { isAdmin }));

// Bildirim zili: 24 saatten eski, hiç tıklanmamış bildirimleri otomatik temizler.
startNotificationCleanup();
// İş Planı Bildirimleri: dünden kalma, hiç görüntülenmemiş satırları günlük temizler.
ai.startBildirimCleanup(db);

// --- SİSTEM AYARLARI ---

// Tüm ayarları döner (varsayılanlarla birleştirilmiş güncel değerler) — Admin/İK
app.get('/api/settings', async (req, res) => {
  try {
    const { userRole } = req.query;
    if (!isAdmin(userRole)) return res.status(403).json({ error: 'Yetkisiz erişim.' });
    res.json(SETTINGS_CACHE);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Bir veya birden fazla ayarı günceller — Admin/İK
app.put('/api/settings', async (req, res) => {
  try {
    const { userRole, updates } = req.body;
    if (!isAdmin(userRole)) return res.status(403).json({ error: 'Yetkisiz erişim.' });
    if (!updates || typeof updates !== 'object') return res.status(400).json({ error: 'Geçersiz veri.' });

    for (const [key, value] of Object.entries(updates)) {
      if (!(key in DEFAULT_SETTINGS)) continue; // bilinmeyen anahtarları yok say
      await db.execute({
        sql: `INSERT INTO system_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        args: [key, JSON.stringify(value)]
      });
    }
    await loadSettingsCache();
    res.json({ message: 'Ayarlar güncellendi.', settings: SETTINGS_CACHE });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Veritabanındaki tüm tabloları tek bir .xlsx dosyasına (her tablo ayrı sayfa) aktarır — Admin/İK.
// Böylece Admin/İK, panele girmeden istediği an tüm verileri Excel'de açıp inceleyebilir.
app.get('/api/admin/export-excel', async (req, res) => {
  try {
    const { userRole } = req.query;
    if (!isAdmin(userRole)) return res.status(403).json({ error: 'Yetkisiz erişim.' });

    const tablesRes = await db.execute(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    );

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Intern Panel';
    workbook.created = new Date();

    const MAX_CELL_LEN = 30000; // Excel hücre karakter sınırı (32767) altında güvenli pay

    for (const tableRow of tablesRes.rows) {
      const tableName = tableRow.name;
      const dataRes = await db.execute(`SELECT * FROM ${tableName}`);
      const columns = dataRes.columns || [];

      const sheet = workbook.addWorksheet(tableName.substring(0, 31));
      if (columns.length === 0) continue;

      sheet.columns = columns.map(col => ({ header: col, key: col, width: Math.min(Math.max(col.length + 4, 14), 40) }));
      sheet.getRow(1).font = { bold: true };
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
      sheet.views = [{ state: 'frozen', ySplit: 1 }];

      for (const dataRow of dataRes.rows) {
        const rowValues = {};
        for (const col of columns) {
          let val = dataRow[col];
          // task_attachments.file_data içinde base64 dosya içeriği tutulur; olduğu gibi aktarılırsa
          // hem dosya devasa büyür hem Excel'in 32767 karakterlik hücre sınırını aşabilir.
          if (col === 'file_data' && typeof val === 'string') {
            val = `[Dosya verisi - ${val.length} karakter, dışa aktarımda hariç tutuldu]`;
          } else if (typeof val === 'string' && val.length > MAX_CELL_LEN) {
            val = val.slice(0, MAX_CELL_LEN) + `… [kesildi, toplam ${val.length} karakter]`;
          }
          rowValues[col] = val === undefined ? null : val;
        }
        sheet.addRow(rowValues);
      }
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="veritabani_${dateStr}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Excel dışa aktarma hatası:', error);
    res.status(500).json({ error: 'Excel dosyası oluşturulurken hata: ' + error.message });
  }
});

// ============================================================
// GOOGLE E-TABLOLAR CANLI SENKRONİZASYONU
// Bir Google E-Tablo, Apps Script üzerinden bu iki uca istek atarak veritabanıyla iki yönlü
// senkron kalır: /pull ile tüm tabloları periyodik çeker, /push ile tek bir hücre değişikliğini
// anında veritabanına yazar. Kimlik doğrulama, kullanıcı oturumu yerine paylaşılan bir "secret"
// ile yapılır (Apps Script bir kullanıcı hesabı olarak istek atmaz, sunucudan sunucuya çağrıdır).
//
// GÜVENLİK: sadece aşağıdaki SHEET_EDITABLE_COLUMNS listesindeki tablo+sütun kombinasyonları
// tabloya yazılabilir. id, rol, şifre, durum (status) gibi iş akışı/güvenlik açısından kritik
// alanlar bilinçli olarak DIŞARIDA bırakıldı — bunlar sitenin kendi ekranlarından, ilgili bildirim/
// onay mantığı çalışarak değiştirilmeli; doğrudan tabloya yazmak o mantığı atlar.
// ============================================================
const SHEET_SYNC_SECRET = process.env.SHEET_SYNC_SECRET;

const SHEET_EDITABLE_COLUMNS = {
  tasks: ['description', 'review_comment'],
  daily_logs: ['note'],
  meeting_requests: ['description', 'review_comment'],
  companies: ['name'],
  projects: ['note'],
  project_progress: ['planned', 'actual', 'note'],
  project_stages: ['note']
};

function checkSheetSyncSecret(req, res) {
  if (!SHEET_SYNC_SECRET) {
    res.status(500).json({ error: 'SHEET_SYNC_SECRET ortam değişkeni tanımlı değil.' });
    return false;
  }
  const provided = req.method === 'GET' ? req.query.secret : req.body.secret;
  if (!provided || provided !== SHEET_SYNC_SECRET) {
    res.status(403).json({ error: 'Geçersiz secret.' });
    return false;
  }
  return true;
}

// Apps Script'in tabloyu periyodik olarak (ör. her 5 dakikada) çekip sayfayı tazelemesi için.
app.get('/api/sheet-sync/pull', async (req, res) => {
  try {
    if (!checkSheetSyncSecret(req, res)) return;

    const tablesRes = await db.execute(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    );

    const MAX_CELL_LEN = 30000;
    const tables = {};

    for (const tableRow of tablesRes.rows) {
      const tableName = tableRow.name;
      const dataRes = await db.execute(`SELECT * FROM ${tableName}`);
      const columns = dataRes.columns || [];

      const rows = dataRes.rows.map(dataRow => {
        const rowValues = {};
        for (const col of columns) {
          let val = dataRow[col];
          if (col === 'file_data' && typeof val === 'string') {
            val = `[Dosya verisi - ${val.length} karakter, senkronda hariç tutuldu]`;
          } else if (typeof val === 'string' && val.length > MAX_CELL_LEN) {
            val = val.slice(0, MAX_CELL_LEN) + `… [kesildi, toplam ${val.length} karakter]`;
          }
          rowValues[col] = val === undefined ? null : val;
        }
        return rowValues;
      });

      tables[tableName] = { columns, editable: SHEET_EDITABLE_COLUMNS[tableName] || [], rows };
    }

    res.json({ tables });
  } catch (error) {
    console.error('Sheet-sync pull hatası:', error);
    res.status(500).json({ error: 'Veri çekilirken hata: ' + error.message });
  }
});

// Apps Script'in onEdit tetikleyicisinin, E-Tablo'da değişen tek bir hücreyi anında veritabanına
// yazması için. Sadece SHEET_EDITABLE_COLUMNS'da izin verilen tablo+sütun kombinasyonlarını kabul eder.
app.post('/api/sheet-sync/push', async (req, res) => {
  try {
    if (!checkSheetSyncSecret(req, res)) return;

    const { table, id, column, value } = req.body;
    const allowedColumns = SHEET_EDITABLE_COLUMNS[table];
    if (!allowedColumns) {
      return res.status(403).json({ error: `"${table}" tablosu senkron için düzenlemeye açık değil.` });
    }
    if (!allowedColumns.includes(column)) {
      return res.status(403).json({ error: `"${table}.${column}" alanı düzenlemeye açık değil.` });
    }
    const rowId = Number(id);
    if (!Number.isInteger(rowId) || rowId <= 0) {
      return res.status(400).json({ error: 'Geçersiz id.' });
    }

    const result = await db.execute({
      sql: `UPDATE ${table} SET ${column} = ? WHERE id = ?`,
      args: [value === undefined ? null : value, rowId]
    });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: 'Kayıt bulunamadı.' });
    }

    res.json({ message: 'Güncellendi.' });
  } catch (error) {
    console.error('Sheet-sync push hatası:', error);
    res.status(500).json({ error: 'Kaydedilirken hata: ' + error.message });
  }
});

// ============================================================
// PLANLAMA NOTLARI (sağ panel): herkes kendine bir not + "ne zaman yapılacak" tarihi ekler.
// Sadece notu ekleyen kişi kendi notlarını görür/siler (userId ile filtrelenir).
// ============================================================

// remind_at ("YYYY-MM-DDTHH:MM", datetime-local formatı) değerini e-postada okunur hale getirir
function formatReminderDate(remindAt) {
  if (!remindAt) return '-';
  const [datePart, timePart] = String(remindAt).split('T');
  const [y, m, d] = (datePart || '').split('-');
  return y && m && d ? `${d}.${m}.${y}${timePart ? ' ' + timePart : ''}` : remindAt;
}

// Gerçek olmayan (sistem tarafından otomatik üretilmiş) e-postalara mail atmaz
function isRealEmail(email) {
  return !!email && !/@system\.local$/i.test(email);
}

app.post('/api/personal-reminders', async (req, res) => {
  try {
    const { userId, note, remindAt } = req.body;
    if (!userId || !note || !note.trim() || !remindAt) {
      return res.status(400).json({ error: 'Not ve tarih zorunludur.' });
    }

    const createdAt = new Date().toISOString();
    const result = await db.execute({
      sql: `INSERT INTO personal_reminders (user_id, note, remind_at, created_at) VALUES (?, ?, ?, ?)`,
      args: [userId, note.trim(), remindAt, createdAt]
    });

    // Not eklendiğinde anında bilgilendirme e-postası — asıl işlemi bloklamasın diye ayrı try/catch
    try {
      if (SETTINGS_CACHE.email_personal_reminder) {
        const uRes = await db.execute({ sql: `SELECT name, email FROM users WHERE id = ?`, args: [userId] });
        const u = uRes.rows[0];
        if (u && isRealEmail(u.email)) {
          await sendDetailsEmail(
            u.email, u.name,
            'Yeni Bir Not Eklediniz',
            'Planlama Notunuz Kaydedildi',
            'Kendinize aşağıdaki notu düştünüz. Belirttiğiniz tarih yaklaştığında tekrar hatırlatılacaktır.',
            [['Not', note.trim()], ['Tarih', formatReminderDate(remindAt)]],
            'Panele Git'
          );
        }
      }
    } catch (mailErr) { console.error('Planlama notu e-postası hatası:', mailErr.message); }

    res.json({ id: Number(result.lastInsertRowid), message: 'Not eklendi.' });
  } catch (error) {
    res.status(500).json({ error: 'Not eklenirken hata: ' + error.message });
  }
});

app.get('/api/personal-reminders', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId gerekli.' });
    const result = await db.execute({
      sql: `SELECT * FROM personal_reminders WHERE user_id = ? ORDER BY remind_at ASC`,
      args: [userId]
    });
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/personal-reminders/:id', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId gerekli.' });
    const result = await db.execute({
      sql: `DELETE FROM personal_reminders WHERE id = ? AND user_id = ?`,
      args: [req.params.id, userId]
    });
    if (result.rowsAffected === 0) return res.status(404).json({ error: 'Not bulunamadı.' });
    res.json({ message: 'Not silindi.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Notun zamanı yaklaşınca (24 saat kala) tek seferlik hatırlatma e-postası gönderir. "tick" her
// çalıştığında henüz bildirilmemiş (notified_upcoming=0) ve süresi 24 saat içine girmiş notları
// bulur, e-postayı dener, sonucu ne olursa olsun notified_upcoming=1 yaparak tekrar denemeyi önler
// (aksi halde gerçek olmayan e-postalı kullanıcılar için sonsuz döngü oluşurdu).
let _personalReminderBasladi = false;
function startPersonalReminderScheduler() {
  if (_personalReminderBasladi) return;
  _personalReminderBasladi = true;
  const tick = async () => {
    try {
      const in24h = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 16);
      const dueRes = await db.execute({
        sql: `SELECT personal_reminders.id, personal_reminders.note, personal_reminders.remind_at,
                     users.name AS user_name, users.email AS user_email
              FROM personal_reminders LEFT JOIN users ON personal_reminders.user_id = users.id
              WHERE personal_reminders.notified_upcoming = 0 AND personal_reminders.remind_at <= ?`,
        args: [in24h]
      });

      for (const r of dueRes.rows) {
        if (SETTINGS_CACHE.email_personal_reminder && isRealEmail(r.user_email)) {
          try {
            await sendDetailsEmail(
              r.user_email, r.user_name,
              'Notunuzun Zamanı Yaklaşıyor',
              'Planlama Hatırlatması',
              'Kendinize bıraktığınız bir notun zamanı yaklaşıyor, unutmayın!',
              [['Not', r.note], ['Tarih', formatReminderDate(r.remind_at)]],
              'Panele Git'
            );
          } catch (mailErr) { console.error('Hatırlatma e-postası hatası:', mailErr.message); }
        }
        await db.execute({ sql: `UPDATE personal_reminders SET notified_upcoming = 1 WHERE id = ?`, args: [r.id] });
      }
    } catch (e) { console.error('Planlama hatırlatma zamanlayıcı hatası:', e.message); }
  };
  setTimeout(tick, 30000);
  setInterval(tick, 30 * 60 * 1000); // 30 dakikada bir kontrol
  console.log('📝 Planlama notu hatırlatma zamanlayıcısı aktif.');
}
// Planlama notları: zamanı 24 saat içine giren notlar için tek seferlik hatırlatma e-postası.
startPersonalReminderScheduler();

// ============================================================
// GÜNLÜK BİLGİLENDİRME HATIRLATMASI: mesai bitiminden (TR saati 18:00) 30 dk sonra, yani 18:30'da,
// Admin/İK hariç tüm kullanıcılardan — o gün aktif (IN_PROGRESS/REVISION_REQUESTED) görevi olup
// henüz günlük ilerleme notu (daily_logs) girmemiş olanlara — hatırlatma e-postası gönderir.
// node-cron gerekmez: aiReport.js'teki zamanlayıcıyla aynı, bağımsız setInterval tabanlı desen.
// ============================================================
const DAILY_LOG_REMINDER_HOUR = 18;   // mesai bitimi TR saati
const DAILY_LOG_REMINDER_MINUTE = 30; // +30 dk

let _dailyLogReminderBasladi = false;
function startDailyLogReminderScheduler() {
  if (_dailyLogReminderBasladi) return;
  _dailyLogReminderBasladi = true;

  let sonCalismaGunu = null; // aynı gün ikinci kez çalışmasın (bellekte)

  const tick = async () => {
    try {
      if (!SETTINGS_CACHE.email_daily_log_reminder) return;

      const now = new Date(Date.now() + 3 * 60 * 60 * 1000); // Türkiye saati (sabit UTC+3)
      const gun = now.getUTCDay();          // 0=Paz, 6=Cmt
      const saat = now.getUTCHours();
      const dakika = now.getUTCMinutes();
      const gunISO = now.toISOString().split('T')[0];

      if (gun === 0 || gun === 6) return;                                  // hafta sonu atla
      if ((SETTINGS_CACHE.holidays || []).includes(gunISO)) return;         // resmi tatil atla
      if (saat !== DAILY_LOG_REMINDER_HOUR || dakika < DAILY_LOG_REMINDER_MINUTE || dakika > DAILY_LOG_REMINDER_MINUTE + 4) return;
      if (sonCalismaGunu === gunISO) return;                               // bugün zaten çalıştı
      sonCalismaGunu = gunISO;

      // Admin/İK hariç, onaylı tüm kullanıcılar arasından o gün aktif görevi olup henüz not
      // girmemiş olanları bul (bir kişiye tek e-posta yeter, görev sayısı fark etmez).
      const usersRes = await db.execute(
        `SELECT id, name, email FROM users WHERE status = 'APPROVED' AND role NOT IN ('ADMIN', 'HR')`
      );

      let gonderilen = 0;
      for (const u of usersRes.rows) {
        if (!isRealEmail(u.email)) continue;
        try {
          const activeRes = await db.execute({
            sql: `SELECT COUNT(*) as cnt FROM tasks WHERE assigned_to = ? AND status IN ('IN_PROGRESS', 'REVISION_REQUESTED')`,
            args: [u.id]
          });
          if (!activeRes.rows[0] || Number(activeRes.rows[0].cnt) === 0) continue; // bugün loglayacak aktif görevi yok

          const logRes = await db.execute({
            sql: `SELECT COUNT(*) as cnt FROM daily_logs WHERE intern_id = ? AND log_date = ?`,
            args: [u.id, gunISO]
          });
          if (logRes.rows[0] && Number(logRes.rows[0].cnt) > 0) continue; // bugün zaten not girmiş

          await sendDetailsEmail(
            u.email, u.name,
            'Günlük Bilgilendirme Girilmedi',
            'Günlük İlerleme Notu Hatırlatması',
            'Bugün için aktif göreviniz bulunuyor ancak henüz günlük ilerleme notu girmediniz. Lütfen panel üzerinden bugüne ait notunuzu ekleyin.',
            [['Tarih', gunISO]],
            'Panele Git'
          );
          gonderilen++;
        } catch (mailErr) { console.error(`Günlük bilgilendirme hatırlatma e-postası hatası (kullanıcı ${u.id}):`, mailErr.message); }
      }
      console.log(`📋 Günlük bilgilendirme hatırlatma e-postaları gönderildi (${gunISO}, ${gonderilen} kişi).`);
    } catch (e) { console.error('Günlük bilgilendirme hatırlatma zamanlayıcı hatası:', e.message); }
  };

  setInterval(tick, 60 * 1000); // dakikada bir kontrol
  console.log(`⏰ Günlük bilgilendirme hatırlatma zamanlayıcısı aktif (her iş günü ${DAILY_LOG_REMINDER_HOUR}:${String(DAILY_LOG_REMINDER_MINUTE).padStart(2, '0')} TR).`);
}
startDailyLogReminderScheduler();

// Tüm giriş yapmış kullanıcıların erişebileceği, hassas olmayan ayarlar
// (ör. iş günü hesabı için tatil günleri) — yetki kontrolü yok, kasıtlı olarak herkese açık.
app.get('/api/settings/public', async (req, res) => {
  try {
    res.json({ holidays: SETTINGS_CACHE.holidays || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Görev Getirme Endpoint'ini Admin İçin Güncelleme
app.get('/api/tasks', async (req, res) => {
  try {
    const { userId, role, department, planTaskForProject } = req.query;

    let sql = `
      SELECT tasks.*, users.name as assignee_name,
        users.department as assignee_department,
        users.sub_area as assignee_sub_area,
        users.role as assignee_role
      FROM tasks
      LEFT JOIN users ON tasks.assigned_to = users.id
    `;
    let conditions = [];
    let args = [];

    // Dar amaçlı özel sorgu: bir Projenin "Kart için Planla" ile oluşturulmuş, sadece o projeye
    // özel plan görevini getirir — normal rol/birim filtresine tabi değildir, tekil kullanım içindir.
    if (planTaskForProject) {
      conditions.push(`tasks.project_id = ? AND tasks.is_kart_plani_task = 1`);
      args.push(planTaskForProject);
    } else {
      // Kart Planı görevleri normal listelerde/sayımlarda hiç görünmez (bkz. yukarıdaki özel dal).
      conditions.push(`(tasks.is_kart_plani_task IS NULL OR tasks.is_kart_plani_task = 0)`);

      // ADMIN tüm görevleri görebilir; INTERN sadece kendisine atananları görür;
      // diğer roller (Müdür, Ekip Lideri, Mühendis, Teknisyen) sadece kendi biriminin görevlerini görür.
      if (role === 'INTERN') {
        conditions.push(`tasks.assigned_to = ?`);
        args.push(userId);
      } else if (!isAdmin(role) && department) {
        conditions.push(`users.department = ?`);
        args.push(department);
      }
    }

    if (conditions.length > 0) {
      sql += ` WHERE ` + conditions.join(' AND ');
    }

    sql += ` ORDER BY tasks.id DESC`;

    const result = await db.execute({ sql, args });
    const tasks = result.rows.map(row => ({ ...row, revisions: [] }));

    if (tasks.length === 0) return res.json([]);

    const taskIds = tasks.map(t => t.id);
    const placeholders = taskIds.map(() => '?').join(',');

    const revisionsResult = await db.execute({
      sql: `SELECT * FROM task_revisions WHERE task_id IN (${placeholders}) ORDER BY id DESC`,
      args: taskIds
    });

    const revisionsByTaskId = {};
    for (const rev of revisionsResult.rows) {
      if (!revisionsByTaskId[rev.task_id]) revisionsByTaskId[rev.task_id] = [];
      revisionsByTaskId[rev.task_id].push(rev);
    }

    const finalTasks = tasks.map(task => ({
      ...task,
      revisions: revisionsByTaskId[task.id] || []
    }));

    res.json(finalTasks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- ADMIN ÖZEL ENDPOINT'LERİ ---

// 1. Tüm Kullanıcıları Listele (Admin Paneli İçin)
app.get('/api/admin/users', async (req, res) => {
  try {
    const { userRole } = req.query;
    if (!isAdmin(userRole)) {
      return res.status(403).json({ error: 'Bu alana erişim yetkiniz yok.' });
    }

    const result = await db.execute(`SELECT id, name, username, email, phone, department, sub_area, role, leader_sub_type,
                                             intern_start_date, intern_end_date, engineer_id, status
                                      FROM users ORDER BY id DESC`);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. Yeni Kullanıcı Oluştur (Admin Paneli)
app.post('/api/admin/users', async (req, res) => {
  try {
    const { name, username, email, phone, password, role, department, subArea, leaderType, startDate, endDate, adminRole } = req.body;

    if (!isAdmin(adminRole)) {
      return res.status(403).json({ error: 'Yetkisiz işlem.' });
    }

    if (!name || !username || !password || !role) {
      return res.status(400).json({ error: 'Lütfen tüm zorunlu alanları doldurun!' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const finalEmail = email && email.trim() !== '' ? email : `${username}@system.local`;

    await db.execute({
      sql: `INSERT INTO users (name, username, email, phone, password, role, department, sub_area, leader_sub_type, intern_start_date, intern_end_date, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'APPROVED')`,
      args: [
        name, username, finalEmail, phone || null, hashedPassword, role, department || null,
        department === 'ELEKTRONIK' ? (subArea || null) : null,
        role === 'LEADER' ? (leaderType || null) : null,
        role === 'INTERN' ? (startDate || null) : null,
        role === 'INTERN' ? (endDate || null) : null
      ]
    });

    // Giriş bilgilerini e-postayla gönder (gerçek bir e-posta girildiyse) — asıl kullanıcı
    // oluşturma işlemini bloklamasın diye ayrı try/catch.
    if (SETTINGS_CACHE.email_new_user_credentials && isRealEmail(finalEmail)) {
      try {
        await sendDetailsEmail(
          finalEmail, name,
          'Hesabınız Oluşturuldu — Giriş Bilgileriniz',
          'Görevlendirme ve Takip Paneline Hoş Geldiniz',
          'Sizin için bir hesap oluşturuldu. Aşağıdaki bilgilerle panele giriş yapabilirsiniz.',
          [['Kullanıcı Adı', username], ['Şifre', password]],
          'Panele Git'
        );
      } catch (mailErr) { console.error('Yeni kullanıcı bilgilendirme e-postası hatası:', mailErr.message); }
    }

    res.json({ message: 'Kullanıcı başarıyla oluşturuldu.' });
  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'Bu kullanıcı adı veya e-posta zaten kullanılıyor!' });
    }
    res.status(500).json({ error: 'Kullanıcı eklenirken hata: ' + error.message });
  }
});

// 3. Kullanıcı Rolünü Güncelle
app.put('/api/admin/users/:id/role', async (req, res) => {
  try {
    const userId = req.params.id;
    const { newRole, department, adminRole } = req.body;

    if (!isAdmin(adminRole)) {
      return res.status(403).json({ error: 'Yetkisiz işlem.' });
    }

    if (department !== undefined) {
      await db.execute({
        sql: `UPDATE users SET role = ?, department = ? WHERE id = ?`,
        args: [newRole, department || null, userId]
      });
    } else {
      await db.execute({
        sql: `UPDATE users SET role = ? WHERE id = ?`,
        args: [newRole, userId]
      });
    }

    res.json({ message: 'Kullanıcı bilgileri güncellendi.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3b. Kullanıcının TÜM bilgilerini tek seferde günceller (Kullanıcı Yönetimi'ndeki "Düzenle" modalı)
app.put('/api/admin/users/:id/full', async (req, res) => {
  try {
    const userId = req.params.id;
    const { adminRole, name, username, email, phone, password, department, subArea, role, leaderType, startDate, endDate, engineerId } = req.body;

    if (!isAdmin(adminRole)) {
      return res.status(403).json({ error: 'Yetkisiz işlem.' });
    }
    if (!name || !username || !role) {
      return res.status(400).json({ error: 'Ad, kullanıcı adı ve rol zorunludur.' });
    }

    const dupRes = await db.execute({ sql: `SELECT id FROM users WHERE username = ? AND id != ?`, args: [username.trim(), userId] });
    if (dupRes.rows.length > 0) {
      return res.status(400).json({ error: 'Bu kullanıcı adı başka bir kullanıcı tarafından kullanılıyor!' });
    }

    const finalEmail = email && email.trim() !== '' ? email.trim() : `${username.trim()}@system.local`;
    const finalSubArea = department === 'ELEKTRONIK' ? (subArea || null) : null;
    const finalLeaderType = role === 'LEADER' ? (leaderType || null) : null;
    const finalStartDate = role === 'INTERN' ? (startDate || null) : null;
    const finalEndDate = role === 'INTERN' ? (endDate || null) : null;
    const finalEngineerId = role === 'INTERN' ? (engineerId || null) : null;

    const commonArgs = [
      name, username.trim(), finalEmail, phone || null, department || null, finalSubArea,
      role, finalLeaderType, finalStartDate, finalEndDate, finalEngineerId
    ];

    if (password && password.trim() !== '') {
      const hashedPassword = await bcrypt.hash(password, 10);
      await db.execute({
        sql: `UPDATE users SET name=?, username=?, email=?, phone=?, department=?, sub_area=?, role=?, leader_sub_type=?,
                                intern_start_date=?, intern_end_date=?, engineer_id=?, password=? WHERE id=?`,
        args: [...commonArgs, hashedPassword, userId]
      });
    } else {
      await db.execute({
        sql: `UPDATE users SET name=?, username=?, email=?, phone=?, department=?, sub_area=?, role=?, leader_sub_type=?,
                                intern_start_date=?, intern_end_date=?, engineer_id=? WHERE id=?`,
        args: [...commonArgs, userId]
      });
    }

    res.json({ message: 'Kullanıcı bilgileri güncellendi.' });
  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'Bu e-posta adresi başka bir kullanıcı tarafından kullanılıyor!' });
    }
    res.status(500).json({ error: 'Kullanıcı güncellenirken hata: ' + error.message });
  }
});

// 4. Kullanıcı Sil
app.delete('/api/admin/users/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    const { adminRole } = req.body;

    if (!isAdmin(adminRole)) {
      return res.status(403).json({ error: 'Yetkisiz işlem.' });
    }

    // Kullanıcıya ait görevlerin ID'lerini bul (revizyon kayıtlarını temizlemek için gerekli)
    const tasksResult = await db.execute({
      sql: `SELECT id FROM tasks WHERE assigned_to = ?`,
      args: [userId]
    });
    const taskIds = tasksResult.rows.map(r => r.id);

    // İlişkili tüm kayıtları sırasıyla temizle (foreign key hatası almamak için)
    for (const taskId of taskIds) {
      await removeTaskFromGoogle(taskId); // Google Takvim etkinliğini de temizle
      await db.execute({ sql: `DELETE FROM task_revisions WHERE task_id = ?`, args: [taskId] });
      await db.execute({ sql: `DELETE FROM task_attachments WHERE task_id = ?`, args: [taskId] });
    }
    await db.execute({ sql: `DELETE FROM daily_logs WHERE intern_id = ?`, args: [userId] });
    await db.execute({ sql: `DELETE FROM tasks WHERE assigned_to = ?`, args: [userId] });
    // Bu kullanıcının talep ettiği toplantılara ait notları, talepleri silmeden önce temizle
    // (meeting_notes.meeting_id -> meeting_requests.id FK hatası almamak için)
    const userMeetingsForDelete = await db.execute({ sql: `SELECT id FROM meeting_requests WHERE requested_by = ?`, args: [userId] });
    for (const mr of userMeetingsForDelete.rows) {
      await db.execute({ sql: `DELETE FROM meeting_notes WHERE meeting_id = ?`, args: [mr.id] });
    }
    // Bu kullanıcının başkasının toplantısına yazdığı notlar (meeting_notes.user_id -> users.id FK)
    await db.execute({ sql: `DELETE FROM meeting_notes WHERE user_id = ?`, args: [userId] });
    await db.execute({ sql: `DELETE FROM meeting_requests WHERE requested_by = ?`, args: [userId] });
    await db.execute({ sql: `DELETE FROM notifications WHERE user_id = ?`, args: [userId] });
    await db.execute({ sql: `DELETE FROM attendance_logs WHERE intern_id = ?`, args: [userId] });
    // Sahip olduğu projeler silinmez, sadece sorumlu kişi bağlantısı kaldırılır
    await db.execute({ sql: `UPDATE projects SET owner_id = NULL WHERE owner_id = ?`, args: [userId] });
    // Bu kişiyi sorumlu mühendis olarak gösteren stajyerlerin bağlantısı temizlenir
    await db.execute({ sql: `UPDATE users SET engineer_id = NULL WHERE engineer_id = ?`, args: [userId] });

    const result = await db.execute({
      sql: `DELETE FROM users WHERE id = ?`,
      args: [userId]
    });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: 'Silinecek kullanıcı bulunamadı.' });
    }

    res.json({ message: 'Kullanıcı ve ilişkili tüm verileri başarıyla silindi.' });
  } catch (error) {
    res.status(500).json({ error: 'Kullanıcı silinirken hata oluştu: ' + error.message });
  }
});

// 5. Sistem Genel İstatistikleri
app.get('/api/admin/stats', async (req, res) => {
  try {
    const { userRole } = req.query;
    if (!isAdmin(userRole)) {
      return res.status(403).json({ error: 'Yetkisiz erişim.' });
    }

    const userCount = await db.execute(`SELECT COUNT(*) as count FROM users`);
    const taskCount = await db.execute(`SELECT COUNT(*) as count FROM tasks`);
    const revisionCount = await db.execute(`SELECT COUNT(*) as count FROM task_revisions`);
    const pendingTasks = await db.execute(`SELECT COUNT(*) as count FROM tasks WHERE status = 'COMPLETED'`);
    const roleCountsRes = await db.execute(`SELECT role, COUNT(*) as count FROM users GROUP BY role`);
    const roleCounts = {};
    roleCountsRes.rows.forEach(r => { roleCounts[r.role] = r.count; });

    res.json({
      totalUsers: userCount.rows[0].count,
      totalTasks: taskCount.rows[0].count,
      totalRevisions: revisionCount.rows[0].count,
      pendingApprovalTasks: pendingTasks.rows[0].count,
      roleCounts
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- RAPORLAMA (Admin/İK "Raporlar" paneli) ---

// Görev raporu: kişi bazında toplam/tamamlanan/aktif/geciken görev ve revizyon sayıları
app.get('/api/reports/tasks', async (req, res) => {
  try {
    const { userRole, department, startDate, endDate } = req.query;
    if (!isAdmin(userRole)) return res.status(403).json({ error: 'Yetkisiz erişim.' });

    let sql = `SELECT tasks.*, users.name as assignee_name, users.role as assignee_role, users.department as assignee_department
               FROM tasks LEFT JOIN users ON tasks.assigned_to = users.id WHERE 1=1`;
    const args = [];
    if (department) { sql += ` AND users.department = ?`; args.push(department); }
    if (startDate) { sql += ` AND tasks.end_date >= ?`; args.push(startDate); }
    if (endDate) { sql += ` AND tasks.end_date <= ?`; args.push(endDate); }

    const tasksRes = await db.execute({ sql, args });
    const tasks = tasksRes.rows;

    const revRes = await db.execute(`SELECT task_id, COUNT(*) as cnt FROM task_revisions GROUP BY task_id`);
    const revMap = {};
    revRes.rows.forEach(r => { revMap[r.task_id] = r.cnt; });

    const today = todayISO();
    const byPerson = {};
    let totalRevisions = 0;
    tasks.forEach(t => {
      const key = t.assigned_to;
      if (!byPerson[key]) {
        byPerson[key] = { id: t.assigned_to, name: t.assignee_name || '-', role: t.assignee_role || '-', department: t.assignee_department || '-', total: 0, completed: 0, active: 0, overdue: 0, revisions: 0 };
      }
      const p = byPerson[key];
      const isDone = t.status === 'APPROVED' || t.status === 'COMPLETED';
      p.total++;
      if (isDone) p.completed++; else p.active++;
      if (!isDone && t.end_date && t.end_date < today) p.overdue++;
      const revCount = revMap[t.id] || 0;
      p.revisions += revCount;
      totalRevisions += revCount;
    });

    res.json({
      summary: {
        total: tasks.length,
        completed: tasks.filter(t => t.status === 'APPROVED' || t.status === 'COMPLETED').length,
        active: tasks.filter(t => t.status !== 'APPROVED' && t.status !== 'COMPLETED').length,
        overdue: tasks.filter(t => t.status !== 'APPROVED' && t.status !== 'COMPLETED' && t.end_date && t.end_date < today).length,
        revisions: totalRevisions
      },
      byPerson: Object.values(byPerson).sort((a, b) => b.total - a.total)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Devam/Yoklama raporu: stajyer bazında giriş sayısı, toplam süre, son giriş
app.get('/api/reports/attendance', async (req, res) => {
  try {
    const { userRole, department, startDate, endDate } = req.query;
    if (!isAdmin(userRole)) return res.status(403).json({ error: 'Yetkisiz erişim.' });

    let sql = `SELECT attendance_logs.*, users.name as intern_name, users.department as intern_department
               FROM attendance_logs LEFT JOIN users ON attendance_logs.intern_id = users.id WHERE 1=1`;
    const args = [];
    if (department) { sql += ` AND users.department = ?`; args.push(department); }
    if (startDate) { sql += ` AND substr(attendance_logs.check_in_at, 1, 10) >= ?`; args.push(startDate); }
    if (endDate) { sql += ` AND substr(attendance_logs.check_in_at, 1, 10) <= ?`; args.push(endDate); }

    const logsRes = await db.execute({ sql, args });
    const logs = logsRes.rows;

    const byPerson = {};
    logs.forEach(l => {
      const key = l.intern_id;
      if (!byPerson[key]) {
        byPerson[key] = { id: l.intern_id, name: l.intern_name || '-', department: l.intern_department || '-', sessions: 0, totalHours: 0, lastCheckIn: null };
      }
      const p = byPerson[key];
      p.sessions++;
      if (l.check_out_at) {
        const diffMs = new Date(l.check_out_at.replace(' ', 'T')) - new Date(l.check_in_at.replace(' ', 'T'));
        if (diffMs > 0) p.totalHours += diffMs / 3600000;
      }
      if (!p.lastCheckIn || l.check_in_at > p.lastCheckIn) p.lastCheckIn = l.check_in_at;
    });

    const byPersonArr = Object.values(byPerson).map(p => ({ ...p, totalHours: Math.round(p.totalHours * 10) / 10 }));

    res.json({
      summary: { totalSessions: logs.length, totalInterns: byPersonArr.length },
      byPerson: byPersonArr.sort((a, b) => b.sessions - a.sessions)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Proje ilerleme raporu: her proje için en son planlanan/gerçekleşen % ve gecikme durumu
app.get('/api/reports/projects', async (req, res) => {
  try {
    const { userRole, department } = req.query;
    if (!isAdmin(userRole)) return res.status(403).json({ error: 'Yetkisiz erişim.' });

    let sql = `SELECT projects.*, companies.name as company_name, users.name as owner_name
               FROM projects
               LEFT JOIN companies ON projects.company_id = companies.id
               LEFT JOIN users ON projects.owner_id = users.id
               WHERE 1=1`;
    const args = [];
    if (department) { sql += ` AND projects.department = ?`; args.push(department); }
    sql += ` ORDER BY projects.id DESC`;

    const projRes = await db.execute({ sql, args });
    const projects = projRes.rows;

    const progressRes = await db.execute(`SELECT * FROM project_progress ORDER BY log_date DESC`);
    const latestByProject = {};
    progressRes.rows.forEach(p => {
      if (!latestByProject[p.project_id]) latestByProject[p.project_id] = p;
    });

    const today = todayISO();
    const rows = projects.map(p => {
      const latest = latestByProject[p.id];
      const isOverdue = p.status === 'ACTIVE' && p.end_date && p.end_date < today;
      return {
        id: p.id, name: p.name, company: p.company_name || '-', department: p.department,
        owner: p.owner_name || '-', actual: latest ? latest.actual : 0,
        status: p.status, priority: p.priority, endDate: p.end_date, overdue: isOverdue
      };
    });

    res.json({
      summary: {
        total: projects.length,
        active: projects.filter(p => p.status === 'ACTIVE').length,
        overdue: rows.filter(r => r.overdue).length
      },
      projects: rows
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Personel raporu: departman x rol dağılım matrisi
app.get('/api/reports/personnel', async (req, res) => {
  try {
    const { userRole } = req.query;
    if (!isAdmin(userRole)) return res.status(403).json({ error: 'Yetkisiz erişim.' });

    const usersRes = await db.execute(`SELECT department, role, status FROM users`);
    const byDepartment = {};
    let pendingCount = 0;
    usersRes.rows.forEach(u => {
      const dept = u.department || 'Belirtilmemiş';
      if (!byDepartment[dept]) byDepartment[dept] = {};
      byDepartment[dept][u.role] = (byDepartment[dept][u.role] || 0) + 1;
      if (u.status === 'PENDING') pendingCount++;
    });

    res.json({
      summary: { totalUsers: usersRes.rows.length, pendingApprovals: pendingCount },
      byDepartment
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Geliştirme 1: Görevi Tamamlama & Brevo ile Ekip Liderine Mail Bildirimi
app.put('/api/tasks/:id/complete', async (req, res) => {
  try {
    const taskId = req.params.id;
    const result = await db.execute({
      sql: `UPDATE tasks SET status = 'COMPLETED' WHERE id = ?`,
      args: [taskId]
    });

    if (result.rowsAffected === 0) return res.status(404).json({ error: 'Görev bulunamadı.' });

    // Görevi tamamlayan kişinin (atanan kişi) bilgilerini çek
    const taskRes = await db.execute({
      sql: `SELECT tasks.*, users.name as assignee_name, users.role as assignee_role,
                   users.department as assignee_department, users.engineer_id as assignee_engineer_id
            FROM tasks JOIN users ON tasks.assigned_to = users.id WHERE tasks.id = ?`,
      args: [taskId]
    });
    const task = taskRes.rows[0];

    if (task) {
      // Kişi kendi görevini tamamladığında bildirim KENDİSİNE değil, amirine gitmeli:
      // Stajyer -> sorumlu mühendisi, Mühendis -> biriminin ekip lider(ler)i, Ekip Lideri -> biriminin müdür(ler)i.
      // Bu üçünün dışındaki roller (Teknisyen/Müdür/Admin/İK) için eski davranış korunur: görevi oluşturana bildirilir.
      let recipients = [];
      if (task.assignee_role === 'INTERN') {
        if (task.assignee_engineer_id) {
          const r = await db.execute({ sql: `SELECT id, name, email FROM users WHERE id = ?`, args: [task.assignee_engineer_id] });
          recipients = r.rows;
        }
      } else if (task.assignee_role === 'ENGINEER') {
        const r = await db.execute({ sql: `SELECT id, name, email FROM users WHERE department = ? AND role = 'LEADER' AND status = 'APPROVED'`, args: [task.assignee_department] });
        recipients = r.rows;
      } else if (task.assignee_role === 'LEADER') {
        const r = await db.execute({ sql: `SELECT id, name, email FROM users WHERE department = ? AND role = 'MANAGER' AND status = 'APPROVED'`, args: [task.assignee_department] });
        recipients = r.rows;
      } else {
        const r = await db.execute({ sql: `SELECT id, name, email FROM users WHERE name = ?`, args: [task.created_by] });
        recipients = r.rows;
      }

      for (const person of recipients) {
        createNotification(person.id, 'TASK_COMPLETED', 'TASKS', 'Görev Tamamlandı', `${task.assignee_name} "${task.title}" görevini tamamladı, onayınızı bekliyor.`, task.id)
          .catch(e => console.error('Görev tamamlama bildirimi hatası:', e.message));

        if (person.email && SETTINGS_CACHE.email_task_completed) {
          await sendDetailsEmail(
            person.email, person.name,
            `Görev Tamamlandı: ${task.title}`,
            'Görev Tamamlandı Bildirimi',
            `Merhaba <strong style="color: #38bdf8;">${person.name}</strong>, <strong style="color: #0284c7;">${task.assignee_name}</strong> kendisine atanan görevi tamamlandı olarak işaretledi. Detaylar aşağıda yer almaktadır:`,
            [
              ['Görev Başlığı', task.title],
              ['Kategori', task.category],
              ['Tamamlayan', task.assignee_name],
              ['Açıklama', task.description || 'Açıklama bulunmuyor.']
            ],
            'Görevi İncele ve Onayla'
          );
        }
      }
    }

    res.json({ message: 'Görev tamamlandı olarak işaretlendi ve bildirim e-postası gönderildi.' });
  } catch (error) {
    res.status(500).json({ error: 'Görev durumu güncellenemedi: ' + error.message });
  }
});

// Atanan kişi, kendisine gelen revize isteğini "gördüm, düzeltmeye devam ediyorum" diyerek onaylar:
// görev REVISION_REQUESTED'ten IN_PROGRESS'e döner ama revizyon geçmişi (task_revisions) SİLİNMEZ,
// kayıt olarak durur (bkz. Revizyon Geçmişi bölümü).
app.put('/api/tasks/:id/acknowledge-revision', async (req, res) => {
  try {
    const taskId = req.params.id;
    const result = await db.execute({
      sql: `UPDATE tasks SET status = 'IN_PROGRESS' WHERE id = ? AND status = 'REVISION_REQUESTED'`,
      args: [taskId]
    });
    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: 'Görev bulunamadı veya revize durumunda değil.' });
    }
    res.json({ message: 'Revize isteği onaylandı, görev tekrar devam ediyor olarak işaretlendi.' });
  } catch (error) {
    res.status(500).json({ error: 'Görev durumu güncellenemedi: ' + error.message });
  }
});

// Görev Onaylama / Revize Etme Endpoint'i
app.put('/api/tasks/:id/review', async (req, res) => {
  try {
    const taskId = req.params.id;
    const { action, comment, userRole, revisedBy } = req.body;

    // Yetki Kontrolü
    const canReview = ['ADMIN', 'HR', 'MANAGER', 'LEADER', 'ENGINEER'].includes(userRole);
    if (!canReview) {
      return res.status(403).json({ error: 'Bu işlemi yapmaya yetkiniz bulunmamaktadır.' });
    }

    let newStatus = 'APPROVED';
    const isRevision = (action === 'REVISION' || action === 'REVISION_REQUESTED');

    if (isRevision) {
      newStatus = 'REVISION_REQUESTED';

      // Zaman damgası (YYYY-MM-DD HH:mm:ss)
      const now = nowTurkeyLocal();

      // Revizyon geçmişi kaydı ekle
      await db.execute({
        sql: `INSERT INTO task_revisions (task_id, revised_by, comment, created_at) VALUES (?, ?, ?, ?)`,
        args: [taskId, revisedBy || 'Sistem / Yetkili', comment || '', now]
      });
    }

    // Görev durumunu ve son revize notunu veritabanında güncelle
    const result = await db.execute({
      sql: `UPDATE tasks SET status = ?, review_comment = ? WHERE id = ?`,
      args: [newStatus, isRevision ? (comment || '') : '', taskId]
    });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: 'Görev bulunamadı.' });
    }

    // Görevin sahibine (atanan kişiye) sonucu bildir
    try {
      const taskRes = await db.execute({
        sql: `SELECT tasks.assigned_to, tasks.title, tasks.category, users.name as assignee_name, users.email as assignee_email
              FROM tasks JOIN users ON tasks.assigned_to = users.id WHERE tasks.id = ?`,
        args: [taskId]
      });
      const t = taskRes.rows[0];
      if (t) {
        if (isRevision) {
          createNotification(t.assigned_to, 'TASK_REVISION', 'TASKS', 'Revize İstendi', `"${t.title}" göreviniz için revize istendi: ${comment || ''}`, Number(taskId));
          if (t.assignee_email && SETTINGS_CACHE.email_task_revision) {
            await sendDetailsEmail(
              t.assignee_email, t.assignee_name,
              `Revize İstendi: ${t.title}`,
              'Görev Revizyonu İstendi',
              `Merhaba <strong style="color: #38bdf8;">${t.assignee_name}</strong>, aşağıdaki göreviniz için revize istendi:`,
              [
                ['Görev Başlığı', t.title],
                ['Kategori', t.category || '-'],
                ['Revize Notu', comment || 'Not girilmedi.']
              ],
              'Görevi Görüntüle'
            );
          }
        } else {
          createNotification(t.assigned_to, 'TASK_APPROVED', 'TASKS', 'Görev Onaylandı', `"${t.title}" göreviniz onaylandı.`, Number(taskId));
          if (t.assignee_email && SETTINGS_CACHE.email_task_approved) {
            await sendDetailsEmail(
              t.assignee_email, t.assignee_name,
              `Görev Onaylandı: ${t.title}`,
              'Görev Onaylandı',
              `Merhaba <strong style="color: #38bdf8;">${t.assignee_name}</strong>, aşağıdaki göreviniz onaylandı. Tebrikler!`,
              [
                ['Görev Başlığı', t.title],
                ['Kategori', t.category || '-']
              ],
              'Panele Git'
            );
          }
        }
      }
    } catch (notifErr) { console.error('Görev inceleme bildirimi hatası:', notifErr.message); }

    res.json({ message: !isRevision ? 'Görev onaylandı.' : 'Revize talebi iletildi.' });
  } catch (error) {
    console.error('Görev inceleme hatası:', error);
    res.status(500).json({ error: 'Görev durumu güncellenirken hata oluştu: ' + error.message });
  }
});

// Günlük Not Ekleme
app.post('/api/daily-logs', async (req, res) => {
  try {
    const { taskId, internId, logDate, note } = req.body;
    const result = await db.execute({
      sql: `INSERT INTO daily_logs (task_id, intern_id, log_date, note) VALUES (?, ?, ?, ?)`,
      args: [taskId, internId, logDate, note]
    });

    res.json({ id: Number(result.lastInsertRowid) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Günlük Notları Getirme
app.get('/api/daily-logs', async (req, res) => {
  try {
    const result = await db.execute(`SELECT * FROM daily_logs`);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Görev Silme Endpoint'ii
app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const taskId = req.params.id;
    const userRole = (req.headers['user-role'] || '').toUpperCase();

    if (!['ADMIN', 'HR', 'MANAGER', 'LEADER', 'ENGINEER'].includes(userRole)) {
      return res.status(403).json({ error: 'Bu işlemi yapmaya yetkiniz yok!' });
    }

    // Silmeden ÖNCE Google Takvim etkinliğini kaldır (event id satırla birlikte kaybolmadan)
    await removeTaskFromGoogle(taskId);

    // Göreve ait logları, revizyonları ve belgeleri temizle
    await db.execute({
      sql: `DELETE FROM daily_logs WHERE task_id = ?`,
      args: [taskId]
    });
    await db.execute({
      sql: `DELETE FROM task_revisions WHERE task_id = ?`,
      args: [taskId]
    });
    await db.execute({
      sql: `DELETE FROM task_attachments WHERE task_id = ?`,
      args: [taskId]
    });

    // Görevi sil
    const result = await db.execute({
      sql: `DELETE FROM tasks WHERE id = ?`,
      args: [taskId]
    });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: 'Görev bulunamadı.' });
    }

    res.json({ message: 'Görev başarıyla silindi.' });
  } catch (error) {
    console.error('Görev silme hatası:', error);
    res.status(500).json({ error: 'Görev silinirken bir hata oluştu: ' + error.message });
  }
});

// ============================================================
// GÖREV BELGELERİ: göreve atanan kişi, görevi tamamlamadan önce (ya da sırasında) istediği
// belgeyi ekleyebilir. Ayrı bir dosya/bulut depolama servisi kurulmadığı için içerik base64
// olarak veritabanında tutulur (bkz. initDb'deki task_attachments tablosu yorumu).
// ============================================================
const TASK_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024; // 10MB

// Belge yükle — sadece göreve atanan kişi ekleyebilir
app.post('/api/tasks/:id/attachments', async (req, res) => {
  try {
    const taskId = req.params.id;
    const { fileName, mimeType, fileData, userId, userName } = req.body;

    if (!fileName || !fileData) {
      return res.status(400).json({ error: 'Dosya adı ve içeriği gereklidir.' });
    }

    const approxBytes = Math.ceil((fileData.length * 3) / 4);
    if (approxBytes > TASK_ATTACHMENT_MAX_BYTES) {
      return res.status(400).json({ error: 'Dosya boyutu 10MB sınırını aşıyor.' });
    }

    const taskRes = await db.execute({ sql: `SELECT assigned_to FROM tasks WHERE id = ?`, args: [taskId] });
    if (taskRes.rows.length === 0) return res.status(404).json({ error: 'Görev bulunamadı.' });
    if (Number(taskRes.rows[0].assigned_to) !== Number(userId)) {
      return res.status(403).json({ error: 'Sadece göreve atanan kişi belge ekleyebilir.' });
    }

    const result = await db.execute({
      sql: `INSERT INTO task_attachments (task_id, file_name, mime_type, file_size, file_data, uploaded_by, uploaded_by_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [taskId, fileName, mimeType || null, approxBytes, fileData, userName || null, userId || null, nowTurkeyLocal()]
    });

    res.json({ id: Number(result.lastInsertRowid), message: 'Belge eklendi.' });
  } catch (error) {
    res.status(500).json({ error: 'Belge eklenemedi: ' + error.message });
  }
});

// Görevin belgelerini listele (dosya içeriği hariç, sadece meta veriler) — görevi görebilen
// herkes çağırabilir, aynı /api/tasks görünürlük mantığı zaten bu endpoint'e ulaşmayı gate'ler
// (kullanıcı görev listesinde olmayan bir task_id'yi normalde bilemez/isteyemez).
app.get('/api/tasks/:id/attachments', async (req, res) => {
  try {
    const r = await db.execute({
      sql: `SELECT id, task_id, file_name, mime_type, file_size, uploaded_by, created_at FROM task_attachments WHERE task_id = ? ORDER BY id DESC`,
      args: [req.params.id]
    });
    res.json(r.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Belgeyi indir/görüntüle
app.get('/api/attachments/:id/download', async (req, res) => {
  try {
    const r = await db.execute({ sql: `SELECT * FROM task_attachments WHERE id = ?`, args: [req.params.id] });
    if (r.rows.length === 0) return res.status(404).json({ error: 'Belge bulunamadı.' });
    const att = r.rows[0];
    const buffer = Buffer.from(att.file_data, 'base64');
    res.setHeader('Content-Type', att.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(att.file_name)}"`);
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Belge sil — yükleyen kişi ya da yönetici rolleri
app.delete('/api/attachments/:id', async (req, res) => {
  try {
    const { userId, userRole } = req.body;
    const r = await db.execute({ sql: `SELECT uploaded_by_id FROM task_attachments WHERE id = ?`, args: [req.params.id] });
    if (r.rows.length === 0) return res.status(404).json({ error: 'Belge bulunamadı.' });

    const isOwner = Number(r.rows[0].uploaded_by_id) === Number(userId);
    const isManager = ['ADMIN', 'HR', 'MANAGER', 'LEADER', 'ENGINEER'].includes(userRole);
    if (!isOwner && !isManager) return res.status(403).json({ error: 'Bu belgeyi silme yetkiniz yok.' });

    await db.execute({ sql: `DELETE FROM task_attachments WHERE id = ?`, args: [req.params.id] });
    res.json({ message: 'Belge silindi.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// GELİŞTİRMELER: ana ekrandaki şifreli dosya paylaşım alanı (bkz. initDb'deki dev_files
// tablosu yorumu). Şifre bcrypt ile hashlenip tutulur, indirme öncesi karşılaştırılır.
// ============================================================
const DEV_FILE_MAX_BYTES = 50 * 1024 * 1024; // 50MB

// Dosya yükle — şifreyi yükleyen kişi kendisi belirler, dosya türünde herhangi bir kısıtlama yoktur
app.post('/api/dev-files', async (req, res) => {
  try {
    const { fileName, mimeType, fileData, password, description, userId, userName } = req.body;

    if (!fileName || !fileData) {
      return res.status(400).json({ error: 'Dosya adı ve içeriği gereklidir.' });
    }
    if (!password || String(password).length < 4) {
      return res.status(400).json({ error: 'Şifre en az 4 karakter olmalıdır.' });
    }

    const approxBytes = Math.ceil((fileData.length * 3) / 4);
    if (approxBytes > DEV_FILE_MAX_BYTES) {
      return res.status(400).json({ error: 'Dosya boyutu 50MB sınırını aşıyor.' });
    }

    const passwordHash = await bcrypt.hash(String(password), 10);

    const result = await db.execute({
      sql: `INSERT INTO dev_files (file_name, mime_type, file_size, file_data, password_hash, password_plain, description, uploaded_by, uploaded_by_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [fileName, mimeType || null, approxBytes, fileData, passwordHash, String(password), description || null, userName || null, userId || null, nowTurkeyLocal()]
    });

    res.json({ id: Number(result.lastInsertRowid), message: 'Dosya yüklendi.' });
  } catch (error) {
    res.status(500).json({ error: 'Dosya yüklenemedi: ' + error.message });
  }
});

// Dosyaları listele (şifre ve içerik hariç, sadece meta veriler). Yükleyenin birimi/alt alanı,
// arayüzdeki "önce birime, sonra kişiye göre filtrele" akışı için users tablosundan join edilir.
app.get('/api/dev-files', async (req, res) => {
  try {
    const r = await db.execute(`
      SELECT df.id, df.file_name, df.mime_type, df.file_size, df.description, df.uploaded_by,
             df.uploaded_by_id, df.created_at, u.department AS uploaded_by_department,
             u.sub_area AS uploaded_by_sub_area
      FROM dev_files df
      LEFT JOIN users u ON u.id = df.uploaded_by_id
      ORDER BY df.id DESC
    `);
    res.json(r.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Yüklediğim dosyanın şifresini geri göster — sadece dosyanın sahibi görebilir
app.get('/api/dev-files/:id/password', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: 'userId gereklidir.' });

    const r = await db.execute({ sql: `SELECT uploaded_by_id, password_plain FROM dev_files WHERE id = ?`, args: [req.params.id] });
    if (r.rows.length === 0) return res.status(404).json({ error: 'Dosya bulunamadı.' });

    const file = r.rows[0];
    if (Number(file.uploaded_by_id) !== Number(userId)) {
      return res.status(403).json({ error: 'Sadece dosyayı yükleyen kişi şifresini görebilir.' });
    }
    if (!file.password_plain) {
      return res.status(404).json({ error: 'Bu dosya için kayıtlı şifre bulunamadı.' });
    }

    res.json({ password: file.password_plain });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Dosyayı indir — doğru şifre gerekir
app.post('/api/dev-files/:id/download', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Şifre gereklidir.' });

    const r = await db.execute({ sql: `SELECT * FROM dev_files WHERE id = ?`, args: [req.params.id] });
    if (r.rows.length === 0) return res.status(404).json({ error: 'Dosya bulunamadı.' });
    const file = r.rows[0];

    const validPassword = await bcrypt.compare(String(password), file.password_hash);
    if (!validPassword) return res.status(403).json({ error: 'Şifre hatalı.' });

    const buffer = Buffer.from(file.file_data, 'base64');
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.file_name)}"`);
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Dosya sil — yükleyen kişi ya da yönetici rolleri
app.delete('/api/dev-files/:id', async (req, res) => {
  try {
    const { userId, userRole } = req.body;
    const r = await db.execute({ sql: `SELECT uploaded_by_id FROM dev_files WHERE id = ?`, args: [req.params.id] });
    if (r.rows.length === 0) return res.status(404).json({ error: 'Dosya bulunamadı.' });

    const isOwner = Number(r.rows[0].uploaded_by_id) === Number(userId);
    const isManager = ['ADMIN', 'HR', 'MANAGER', 'LEADER', 'ENGINEER'].includes(userRole);
    if (!isOwner && !isManager) return res.status(403).json({ error: 'Bu dosyayı silme yetkiniz yok.' });

    await db.execute({ sql: `DELETE FROM dev_files WHERE id = ?`, args: [req.params.id] });
    res.json({ message: 'Dosya silindi.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Stajyer Silme
app.delete('/api/users/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    const userRole = (req.headers['user-role'] || '').toUpperCase();
    const requesterId = req.body && req.body.requesterId;

    const auth = await authorizeHierarchicalUserAction(requesterId, userRole, userId);
    if (!auth.allowed) {
      return res.status(403).json({ error: auth.error });
    }

    const tasksResult = await db.execute({
      sql: `SELECT id FROM tasks WHERE assigned_to = ?`,
      args: [userId]
    });
    const taskIds = tasksResult.rows.map(r => r.id);

    for (const taskId of taskIds) {
      await removeTaskFromGoogle(taskId); // takvim etkinliğini de temizle
      await db.execute({ sql: `DELETE FROM task_revisions WHERE task_id = ?`, args: [taskId] });
      await db.execute({ sql: `DELETE FROM task_attachments WHERE task_id = ?`, args: [taskId] });
    }
    await db.execute({ sql: `DELETE FROM daily_logs WHERE intern_id = ?`, args: [userId] });
    await db.execute({ sql: `DELETE FROM tasks WHERE assigned_to = ?`, args: [userId] });
    // Bu kullanıcının talep ettiği toplantılara ait notları, talepleri silmeden önce temizle
    // (meeting_notes.meeting_id -> meeting_requests.id FK hatası almamak için)
    const userMeetingsForDelete = await db.execute({ sql: `SELECT id FROM meeting_requests WHERE requested_by = ?`, args: [userId] });
    for (const mr of userMeetingsForDelete.rows) {
      await db.execute({ sql: `DELETE FROM meeting_notes WHERE meeting_id = ?`, args: [mr.id] });
    }
    // Bu kullanıcının başkasının toplantısına yazdığı notlar (meeting_notes.user_id -> users.id FK)
    await db.execute({ sql: `DELETE FROM meeting_notes WHERE user_id = ?`, args: [userId] });
    await db.execute({ sql: `DELETE FROM meeting_requests WHERE requested_by = ?`, args: [userId] });
    await db.execute({ sql: `DELETE FROM notifications WHERE user_id = ?`, args: [userId] });
    await db.execute({ sql: `DELETE FROM attendance_logs WHERE intern_id = ?`, args: [userId] });
    // Sahip olduğu projeler silinmez, sadece sorumlu kişi bağlantısı kaldırılır
    await db.execute({ sql: `UPDATE projects SET owner_id = NULL WHERE owner_id = ?`, args: [userId] });
    // Bu kişiyi sorumlu mühendis olarak gösteren stajyerlerin bağlantısı temizlenir
    await db.execute({ sql: `UPDATE users SET engineer_id = NULL WHERE engineer_id = ?`, args: [userId] });
    const result = await db.execute({ sql: `DELETE FROM users WHERE id = ?`, args: [userId] });

    if (result.rowsAffected === 0) return res.status(404).json({ error: 'Silinecek kullanıcı bulunamadı.' });
    res.json({ message: 'Kullanıcı ve ilişkili tüm verileri başarıyla silindi.' });
  } catch (error) {
    res.status(500).json({ error: 'Kullanıcı silinirken hata oluştu: ' + error.message });
  }
});

// Görev Güncelleme Endpoint'i
app.put('/api/tasks/:id', async (req, res) => {
  try {
    const taskId = req.params.id;
    const { title, description, assignedTo, category, endDate, workDays, userRole, projectId } = req.body;

    if (!['ADMIN', 'HR', 'MANAGER', 'LEADER', 'ENGINEER'].includes(userRole)) {
      return res.status(403).json({ error: 'Bu işlemi yapmaya yetkiniz yok!' });
    }

    const result = await db.execute({
      sql: `UPDATE tasks SET title = ?, description = ?, assigned_to = ?, category = ?, end_date = ?, work_days = ?, project_id = ? WHERE id = ?`,
      args: [title, description || '', assignedTo, category, endDate, workDays, projectId || null, taskId]
    });

    if (result.rowsAffected === 0) return res.status(404).json({ error: 'Görev bulunamadı.' });

    // Güncellenen görevi takvimde de güncelle (başlık/tarih/açıklama değişmiş olabilir)
    syncTaskToGoogle(taskId).catch(e => console.error('Task update sync:', e.message));

    res.json({ message: 'Görev başarıyla güncellendi.' });
  } catch (error) {
    res.status(500).json({ error: 'Görev güncellenemedi: ' + error.message });
  }
});

// Kullanıcının Kendi Hesabını Silmesi
app.delete('/api/users/profile', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'Kullanıcı ID eksik!' });
    }

    const ownTasksResult = await db.execute({ sql: `SELECT id FROM tasks WHERE assigned_to = ?`, args: [userId] });
    for (const t of ownTasksResult.rows) {
      await removeTaskFromGoogle(t.id); // Google Takvim etkinliğini de temizle
      await db.execute({ sql: `DELETE FROM task_revisions WHERE task_id = ?`, args: [t.id] });
      await db.execute({ sql: `DELETE FROM task_attachments WHERE task_id = ?`, args: [t.id] });
    }
    await db.execute({ sql: `DELETE FROM daily_logs WHERE intern_id = ?`, args: [userId] });
    await db.execute({ sql: `DELETE FROM tasks WHERE assigned_to = ?`, args: [userId] });
    // Bu kullanıcının talep ettiği toplantılara ait notları, talepleri silmeden önce temizle
    // (meeting_notes.meeting_id -> meeting_requests.id FK hatası almamak için)
    const userMeetingsForDelete = await db.execute({ sql: `SELECT id FROM meeting_requests WHERE requested_by = ?`, args: [userId] });
    for (const mr of userMeetingsForDelete.rows) {
      await db.execute({ sql: `DELETE FROM meeting_notes WHERE meeting_id = ?`, args: [mr.id] });
    }
    // Bu kullanıcının başkasının toplantısına yazdığı notlar (meeting_notes.user_id -> users.id FK)
    await db.execute({ sql: `DELETE FROM meeting_notes WHERE user_id = ?`, args: [userId] });
    await db.execute({ sql: `DELETE FROM meeting_requests WHERE requested_by = ?`, args: [userId] });
    await db.execute({ sql: `DELETE FROM notifications WHERE user_id = ?`, args: [userId] });
    await db.execute({ sql: `DELETE FROM attendance_logs WHERE intern_id = ?`, args: [userId] });
    await db.execute({ sql: `UPDATE projects SET owner_id = NULL WHERE owner_id = ?`, args: [userId] });
    await db.execute({ sql: `UPDATE users SET engineer_id = NULL WHERE engineer_id = ?`, args: [userId] });
    const result = await db.execute({ sql: `DELETE FROM users WHERE id = ?`, args: [userId] });

    if (result.rowsAffected === 0) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    res.json({ message: 'Hesap ve ilişkili veriler başarıyla silindi.' });
  } catch (error) {
    res.status(500).json({ error: 'Hesap silinirken hata oluştu: ' + error.message });
  }
});

// Ekip Liderinin / Mühendisin Bir Kullanıcıyı Düzenlemesi
app.put('/api/users/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    const { name, email, role, startDate, endDate, requesterId } = req.body;
    const userRole = (req.headers['user-role'] || '').toUpperCase();

    const auth = await authorizeHierarchicalUserAction(requesterId, userRole, userId);
    if (!auth.allowed) {
      return res.status(403).json({ error: auth.error });
    }

    if (!name || !email || !role) {
      return res.status(400).json({ error: 'Ad, e-posta ve rol alanları zorunludur.' });
    }

    // Hedef kişiyi yönetme yetkisi olsa bile, kişiyi kendi hiyerarşisinin dışına (ör. Ekip
    // Lideri'ne, ya da kendi rolüne) terfi ettirmesin — sadece izin verilen roller arasında geçiş.
    if (!isAdmin(userRole) && !getSubordinateRoles(userRole).includes(role)) {
      return res.status(403).json({ error: 'Bu kullanıcıyı seçtiğiniz role atama yetkiniz yok.' });
    }

    await db.execute({
      sql: `UPDATE users SET name = ?, email = ?, role = ?, intern_start_date = ?, intern_end_date = ? WHERE id = ?`,
      args: [
        name, 
        email, 
        role, 
        role === 'INTERN' ? startDate : null, 
        role === 'INTERN' ? endDate : null, 
        userId
      ]
    });

    res.json({ message: 'Kullanıcı bilgileri başarıyla güncellendi.' });
  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'Bu e-posta adresi başka bir kullanıcı tarafından kullanılıyor!' });
    }
    res.status(500).json({ error: 'Kullanıcı güncellenirken hata oluştu: ' + error.message });
  }
});

// Doğrulama Kodu Gönderme Endpoint'i
app.post('/api/send-verification-code', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'E-posta adresi gereklidir.' });
  }

  try {
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': process.env.BREVO_API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: SETTINGS_CACHE.email_sender_name, email: SETTINGS_CACHE.email_sender_address },
        to: [{ email: email }],
        subject: "Ekip Lideri Doğrulama Kodu",
        htmlContent: `<p>Ekip Lideri kayıt doğrulama kodunuz: <strong>${verificationCode}</strong></p>`
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'Brevo API isteği başarısız oldu.');
    }

    return res.status(200).json({ message: 'Kod başarıyla gönderildi.', data });

  } catch (error) {
    console.error('Brevo Mail Gönderme Hatası:', error);
    return res.status(500).json({ error: 'Mail gönderilirken sunucu hatası oluştu: ' + error.message });
  }
});

// --- TOPLANTI TALEBİ ENDPOINT'LERİ ---

// Yeni Toplantı Talebi Oluşturma (Sadece Mühendis ve üstü roller: ENGINEER, LEADER, MANAGER)
app.post('/api/meetings', async (req, res) => {
  try {
    const { requestedBy, subject, description, preferredDate, userRole, targetDepartment, targetRoles, targetUserIds } = req.body;

    if (!['ENGINEER', 'LEADER', 'MANAGER', 'ADMIN', 'HR'].includes(userRole)) {
      return res.status(403).json({ error: 'Toplantı talebi oluşturmak için yetkiniz yok.' });
    }

    if (!requestedBy || !subject) {
      return res.status(400).json({ error: 'Talep eden kullanıcı ve konu alanı zorunludur.' });
    }

    // Her rolün toplantıya davet edebileceği (bildirim düşürebileceği) hedef roller.
    // Ekip Lideri ve Müdür artık herhangi bir birimdeki çalışan rollerini (Stajyer,
    // Teknisyen, Mühendis, Ekip Lideri) çağırabilir.
    const ALLOWED_TARGETS = {
      LEADER: ['INTERN', 'TECHNICIAN', 'ENGINEER', 'LEADER'],
      MANAGER: ['INTERN', 'TECHNICIAN', 'ENGINEER', 'LEADER'],
      ADMIN: ['MANAGER', 'LEADER', 'ENGINEER'],      // Admin -> müdür, ekip lideri, mühendisler
      HR: ['MANAGER', 'LEADER', 'ENGINEER'],         // İK, admin ile birebir aynı yetkiye sahip
      ENGINEER: ['INTERN']                           // Mühendis -> stajyerler
    };

    // Gelen hedef rolleri normalize et ve yetkiye göre filtrele
    let rolesArr = Array.isArray(targetRoles)
      ? targetRoles
      : (targetRoles ? String(targetRoles).split(',') : []);
    rolesArr = rolesArr.map(r => r.trim()).filter(Boolean);

    const allowedForRole = ALLOWED_TARGETS[userRole] || [];
    rolesArr = rolesArr.filter(r => allowedForRole.includes(r));

    // Toplantı talep edebilen herkes (Admin, Müdür, Ekip Lideri, Mühendis) istediği birimden
    // (varsa alt alandan) toplantı isteyebilir (birim seçimi zorunlu).
    const CROSS_DEPT_MEETING_ROLES = ['ADMIN', 'HR', 'MANAGER', 'LEADER', 'ENGINEER'];
    let department;

    if (CROSS_DEPT_MEETING_ROLES.includes(userRole)) {
      if (!targetDepartment) {
        return res.status(400).json({ error: 'Lütfen bir birim seçiniz.' });
      }
      department = targetDepartment;
    } else {
      // Diğer roller için talep edenin birimini güvenlik amacıyla veritabanından doğrula
      const userResult = await db.execute({
        sql: `SELECT department FROM users WHERE id = ?`,
        args: [requestedBy]
      });

      if (userResult.rows.length === 0) {
        return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
      }

      department = userResult.rows[0].department;
    }

    // Belirli kişiler (toplu yerine tekil çağrı) seçildiyse: sadece izin verilen rollerden VE bu birimden
    // olanlar kabul edilir (güvenlik amaçlı sunucu tarafı doğrulama).
    let userIdsArr = Array.isArray(targetUserIds) ? targetUserIds.map(Number).filter(n => Number.isInteger(n)) : [];
    if (userIdsArr.length > 0 && allowedForRole.length > 0) {
      const placeholders = userIdsArr.map(() => '?').join(',');
      const validUsersRes = await db.execute({
        sql: `SELECT id FROM users WHERE id IN (${placeholders}) AND department = ? AND role IN (${allowedForRole.map(() => '?').join(',')})`,
        args: [...userIdsArr, department, ...allowedForRole]
      });
      const validIds = new Set(validUsersRes.rows.map(r => Number(r.id)));
      userIdsArr = userIdsArr.filter(id => validIds.has(id));
    } else {
      userIdsArr = [];
    }

    const targetRolesStr = rolesArr.length > 0 ? rolesArr.join(',') : null;
    const targetUserIdsStr = userIdsArr.length > 0 ? `,${userIdsArr.join(',')},` : null;
    const now = nowTurkeyLocal();

    const result = await db.execute({
      sql: `INSERT INTO meeting_requests (requested_by, department, subject, description, preferred_date, status, created_at, target_roles, target_user_ids) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
      args: [requestedBy, department || null, subject, description || null, preferredDate || null, now, targetRolesStr, targetUserIdsStr]
    });

    const newMeetingId = Number(result.lastInsertRowid);

    // Talep edenin takvimine (tarihi varsa) toplantıyı ekle
    syncMeetingToGoogle(newMeetingId).catch(e => console.error('Meeting sync:', e.message));

    // Çağrılan kişilere (rol bazlı + tekil seçilenler) bildirim düşür
    (async () => {
      try {
        const recipientIds = new Set(userIdsArr);
        if (rolesArr.length > 0) {
          const rolePlaceholders = rolesArr.map(() => '?').join(',');
          const roleUsersRes = await db.execute({
            sql: `SELECT id FROM users WHERE department = ? AND role IN (${rolePlaceholders}) AND status = 'APPROVED'`,
            args: [department, ...rolesArr]
          });
          roleUsersRes.rows.forEach(r => recipientIds.add(Number(r.id)));
        }
        recipientIds.delete(Number(requestedBy));
        await notifyUsers([...recipientIds], 'MEETING_REQUEST', 'MEETINGS', 'Yeni Toplantı Talebi', subject, newMeetingId);
      } catch (notifErr) { console.error('Toplantı bildirimi hatası:', notifErr.message); }
    })();

    res.json({ id: newMeetingId, message: 'Toplantı talebiniz iletildi.' });
  } catch (error) {
    res.status(500).json({ error: 'Toplantı talebi oluşturulurken hata: ' + error.message });
  }
});

// Toplantı Taleplerini Listeleme
app.get('/api/meetings', async (req, res) => {
  try {
    const { userId, role, department } = req.query;

    let sql = `
      SELECT meeting_requests.*, users.name as requester_name, users.role as requester_role
      FROM meeting_requests
      LEFT JOIN users ON meeting_requests.requested_by = users.id
    `;
    let conditions = [];
    let args = [];

    if (['MANAGER', 'LEADER'].includes(role)) {
      // Müdür/Ekip Lideri: kendi biriminden gelen talepleri VEYA kendisine (rolüne/kişisel olarak) yönlendirilen talepleri görür
      conditions.push(`(meeting_requests.department = ? OR meeting_requests.requested_by = ? OR meeting_requests.target_roles LIKE ? OR meeting_requests.target_user_ids LIKE ?)`);
      args.push(department, userId, `%${role}%`, `%,${userId},%`);
    } else if (isAdmin(role)) {
      // Admin/İK tüm talepleri görebilir, ek filtre yok
    } else {
      // Diğer roller (ör. Mühendis, Stajyer): kendi oluşturdukları talepleri VEYA kendilerine
      // (rolüne toplu ya da kişisel olarak) yönlendirilen (bildirim düşen) talepleri görür
      conditions.push(`(meeting_requests.requested_by = ? OR meeting_requests.target_roles LIKE ? OR meeting_requests.target_user_ids LIKE ?)`);
      args.push(userId, `%${role}%`, `%,${userId},%`);
    }

    if (conditions.length > 0) {
      sql += ` WHERE ` + conditions.join(' AND ');
    }

    sql += ` ORDER BY meeting_requests.id DESC`;

    const result = await db.execute({ sql, args });
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- EKİP GİDİŞATI ---
// Rol hiyerarşisi (yüksekten alçağa): MANAGER > LEADER > ENGINEER > TECHNICIAN > INTERN
// Her rol yalnızca kendi altındaki rolleri görebilir. ADMIN herkesi görür.
const ROLE_HIERARCHY = ['MANAGER', 'LEADER', 'ENGINEER', 'TECHNICIAN', 'INTERN'];

// Verilen rolün görebileceği (kendisinden düşük) rollerin listesini döndürür
function getSubordinateRoles(role) {
  const idx = ROLE_HIERARCHY.indexOf(role);
  if (idx === -1) return [];
  return ROLE_HIERARCHY.slice(idx + 1);
}

// Seçilen birim(ler)/rol(ler) için kişi listesi + görev + günlük log verisi
app.get('/api/admin/team-progress', async (req, res) => {
  try {
    const { userRole, departments, roles, userId, viewerDepartment } = req.query;

    // ADMIN veya rol hiyerarşisinde yer alan (alt rolleri olan) roller erişebilir
    const canView = isAdmin(userRole) || getSubordinateRoles(userRole).length > 0;
    if (!canView) {
      return res.status(403).json({ error: 'Bu işlemi yapmaya yetkiniz yok!' });
    }

    // Tek bir kişi için sorgu (kişi detay ekranı)
    if (userId) {
      const userResult = await db.execute({
        sql: `SELECT id, name, role, department FROM users WHERE id = ?`,
        args: [userId]
      });
      const people = userResult.rows;

      if (people.length === 0) {
        return res.json({ people: [], tasks: [], logs: [] });
      }

      // ADMIN değilse: hedef kişi kendi altındaki bir rolde ve kendi biriminde olmalı
      if (!isAdmin(userRole)) {
        const target = people[0];
        const allowedRoles = getSubordinateRoles(userRole);
        const roleAllowed = allowedRoles.includes(target.role);
        const deptAllowed = !viewerDepartment || target.department === viewerDepartment;
        if (!roleAllowed || !deptAllowed) {
          return res.status(403).json({ error: 'Bu kişinin verilerine erişim yetkiniz yok.' });
        }
      }

      const tasksResult = await db.execute({
        sql: `SELECT id, title, assigned_to, category, end_date, status FROM tasks WHERE assigned_to = ?`,
        args: [userId]
      });

      const logsResult = await db.execute({
        sql: `SELECT daily_logs.id, daily_logs.intern_id, users.name as intern_name, daily_logs.task_id, tasks.title as task_title, daily_logs.log_date, daily_logs.note
              FROM daily_logs
              LEFT JOIN users ON daily_logs.intern_id = users.id
              LEFT JOIN tasks ON daily_logs.task_id = tasks.id
              WHERE daily_logs.intern_id = ?
              ORDER BY daily_logs.log_date ASC`,
        args: [userId]
      });

      return res.json({ people, tasks: tasksResult.rows, logs: logsResult.rows });
    }

    let userSql = `SELECT id, name, role, department FROM users WHERE status = 'APPROVED'`;
    const userArgs = [];
    const conditions = [];

    const deptList = (departments || '').split(',').map(d => d.trim()).filter(Boolean);
    let roleList = (roles || '').split(',').map(r => r.trim()).filter(Boolean);

    // ADMIN değilse: sadece kendi biriminden ve yalnızca kendi altındaki rolleri görebilir
    if (!isAdmin(userRole)) {
      const allowedRoles = getSubordinateRoles(userRole);

      // Talep edilen roller varsa, izin verilenlerle kesişimini al; yoksa tüm izin verilenleri kullan
      if (roleList.length > 0) {
        roleList = roleList.filter(r => allowedRoles.includes(r));
      } else {
        roleList = allowedRoles;
      }

      // Görünürlük kendi birimiyle sınırlı
      if (viewerDepartment) {
        conditions.push(`department = ?`);
        userArgs.push(viewerDepartment);
      }
    }

    if (deptList.length > 0) {
      conditions.push(`department IN (${deptList.map(() => '?').join(',')})`);
      userArgs.push(...deptList);
    }
    if (roleList.length > 0) {
      conditions.push(`role IN (${roleList.map(() => '?').join(',')})`);
      userArgs.push(...roleList);
    }

    if (conditions.length > 0) {
      userSql += ` AND ` + conditions.join(' AND ');
    }

    userSql += ` ORDER BY name ASC`;

    const usersResult = await db.execute({ sql: userSql, args: userArgs });
    const people = usersResult.rows;

    if (people.length === 0) {
      return res.json({ people: [], tasks: [], logs: [] });
    }

    const ids = people.map(p => p.id);
    const placeholders = ids.map(() => '?').join(',');

    const tasksResult = await db.execute({
      sql: `SELECT id, title, assigned_to, category, end_date, status FROM tasks WHERE assigned_to IN (${placeholders})`,
      args: ids
    });

    const logsResult = await db.execute({
      sql: `SELECT daily_logs.id, daily_logs.intern_id, users.name as intern_name, daily_logs.task_id, tasks.title as task_title, daily_logs.log_date, daily_logs.note
            FROM daily_logs
            LEFT JOIN users ON daily_logs.intern_id = users.id
            LEFT JOIN tasks ON daily_logs.task_id = tasks.id
            WHERE daily_logs.intern_id IN (${placeholders})
            ORDER BY daily_logs.log_date ASC`,
      args: ids
    });

    res.json({ people, tasks: tasksResult.rows, logs: logsResult.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Toplantı Talebini Onaylama / Reddetme (Sadece Müdür/Ekip Lideri kendi birimi, veya Admin)
app.put('/api/meetings/:id/review', async (req, res) => {
  try {
    const meetingId = req.params.id;
    const { action, reviewComment, userRole, reviewerName, department } = req.body;

    if (!['MANAGER', 'LEADER', 'ADMIN', 'HR'].includes(userRole)) {
      return res.status(403).json({ error: 'Bu işlemi yapmaya yetkiniz yok!' });
    }

    if (!['APPROVED', 'REJECTED'].includes(action)) {
      return res.status(400).json({ error: 'Geçersiz işlem.' });
    }

    // Rol seviyesi kontrolü: İnceleyen kişi, talep edenden DAHA DÜŞÜK roldeyse yetkisi yoktur.
    // (Örn. bir ekip lideri, müdürün oluşturduğu talebi onaylayamaz/reddedemez.) ADMIN hiyerarşi dışıdır.
    if (!isAdmin(userRole)) {
      const reqRes = await db.execute({
        sql: `SELECT users.role AS requester_role FROM meeting_requests
              LEFT JOIN users ON meeting_requests.requested_by = users.id
              WHERE meeting_requests.id = ?`,
        args: [meetingId]
      });

      if (reqRes.rows.length === 0) {
        return res.status(404).json({ error: 'Talep bulunamadı.' });
      }

      const requesterRole = reqRes.rows[0].requester_role;
      const reqIdx = ROLE_HIERARCHY.indexOf(requesterRole);
      const myIdx = ROLE_HIERARCHY.indexOf(userRole);

      // Index küçük = daha yüksek rol. İnceleyen (myIdx) talep edene (reqIdx) eşit veya daha yüksek
      // rolde olmalı => myIdx <= reqIdx. Aksi halde (inceleyen daha düşük rolde) yetki yok.
      if (reqIdx === -1 || myIdx === -1 || myIdx > reqIdx) {
        return res.status(403).json({ error: 'Bu talebi onaylama/reddetme yetkiniz yok.' });
      }
    }

    // Müdür/Ekip Lideri sadece kendi biriminin talebini onaylayabilir
    let sql = `UPDATE meeting_requests SET status = ?, reviewed_by = ?, review_comment = ? WHERE id = ?`;
    let args = [action, reviewerName || null, reviewComment || null, meetingId];

    if (!isAdmin(userRole)) {
      sql = `UPDATE meeting_requests SET status = ?, reviewed_by = ?, review_comment = ? WHERE id = ? AND department = ?`;
      args = [action, reviewerName || null, reviewComment || null, meetingId, department];
    }

    const result = await db.execute({ sql, args });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: 'Talep bulunamadı veya bu talebe erişim yetkiniz yok.' });
    }

    // Talep edene sonucu bildir
    try {
      const mRes = await db.execute({ sql: `SELECT requested_by, subject FROM meeting_requests WHERE id = ?`, args: [meetingId] });
      const m = mRes.rows[0];
      if (m) {
        const approved = action === 'APPROVED';
        createNotification(m.requested_by, 'MEETING_REVIEWED', 'MEETINGS', approved ? 'Toplantı Talebiniz Onaylandı' : 'Toplantı Talebiniz Reddedildi', m.subject, Number(meetingId));
      }
    } catch (notifErr) { console.error('Toplantı inceleme bildirimi hatası:', notifErr.message); }

    res.json({ message: action === 'APPROVED' ? 'Toplantı talebi onaylandı.' : 'Toplantı talebi reddedildi.' });
  } catch (error) {
    res.status(500).json({ error: 'Talep güncellenirken hata: ' + error.message });
  }
});

// Bir toplantı talebini kalıcı olarak siler.
// - Reddedilen talepler: Admin/İK tarafından her zaman silinebilir.
// - Bekleyen (PENDING) mühendis talepleri: inceleme yetkisi olan (MANAGER/LEADER/ADMIN/HR) ve
//   hiyerarşi kuralını geçen kullanıcılar tarafından da silinebilir (onayla/reddet/düzenle ile birlikte).
app.delete('/api/meetings/:id', async (req, res) => {
  try {
    const meetingId = req.params.id;
    const { userRole } = req.body;

    if (!['MANAGER', 'LEADER', 'ADMIN', 'HR'].includes(userRole)) {
      return res.status(403).json({ error: 'Bu işlemi yapmaya yetkiniz yok!' });
    }

    const reqRes = await db.execute({
      sql: `SELECT meeting_requests.status AS status, users.role AS requester_role
            FROM meeting_requests LEFT JOIN users ON meeting_requests.requested_by = users.id
            WHERE meeting_requests.id = ?`,
      args: [meetingId]
    });
    if (reqRes.rows.length === 0) {
      return res.status(404).json({ error: 'Talep bulunamadı.' });
    }
    const { status, requester_role } = reqRes.rows[0];

    const canDeleteRejected = status === 'REJECTED' && isAdmin(userRole);
    const canDeletePendingEngineer = status === 'PENDING' && requester_role === 'ENGINEER';

    if (!canDeleteRejected && !canDeletePendingEngineer) {
      return res.status(403).json({ error: 'Bu talebi silme yetkiniz yok.' });
    }

    if (canDeletePendingEngineer && !isAdmin(userRole)) {
      const reqIdx = ROLE_HIERARCHY.indexOf(requester_role);
      const myIdx = ROLE_HIERARCHY.indexOf(userRole);
      if (reqIdx === -1 || myIdx === -1 || myIdx > reqIdx) {
        return res.status(403).json({ error: 'Bu talebi silme yetkiniz yok.' });
      }
    }

    const result = await db.execute({
      sql: `DELETE FROM meeting_requests WHERE id = ?`,
      args: [meetingId]
    });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: 'Talep bulunamadı.' });
    }

    res.json({ message: 'Talep silindi.' });
  } catch (error) {
    res.status(500).json({ error: 'Talep silinirken hata: ' + error.message });
  }
});

// Toplantı talebinin içeriğini (konu / açıklama / tarih) düzenleme — onay/red akışından bağımsız
app.put('/api/meetings/:id/content', async (req, res) => {
  try {
    const meetingId = req.params.id;
    const { subject, description, preferredDate, userRole, department } = req.body;

    if (!['MANAGER', 'LEADER', 'ADMIN', 'HR'].includes(userRole)) {
      return res.status(403).json({ error: 'Bu işlemi yapmaya yetkiniz yok!' });
    }
    if (!subject || !subject.trim()) {
      return res.status(400).json({ error: 'Konu zorunludur.' });
    }

    // Aynı hiyerarşi kuralı: inceleyen, talep edenden daha düşük roldeyse düzenleyemez. ADMIN hariç.
    if (!isAdmin(userRole)) {
      const reqRes = await db.execute({
        sql: `SELECT users.role AS requester_role FROM meeting_requests
              LEFT JOIN users ON meeting_requests.requested_by = users.id
              WHERE meeting_requests.id = ?`,
        args: [meetingId]
      });
      if (reqRes.rows.length === 0) return res.status(404).json({ error: 'Talep bulunamadı.' });

      const requesterRole = reqRes.rows[0].requester_role;
      const reqIdx = ROLE_HIERARCHY.indexOf(requesterRole);
      const myIdx = ROLE_HIERARCHY.indexOf(userRole);
      if (reqIdx === -1 || myIdx === -1 || myIdx > reqIdx) {
        return res.status(403).json({ error: 'Bu talebi düzenleme yetkiniz yok.' });
      }
    }

    let sql = `UPDATE meeting_requests SET subject = ?, description = ?, preferred_date = ? WHERE id = ?`;
    let args = [subject.trim(), description || null, preferredDate || null, meetingId];
    if (!isAdmin(userRole)) {
      sql = `UPDATE meeting_requests SET subject = ?, description = ?, preferred_date = ? WHERE id = ? AND department = ?`;
      args = [subject.trim(), description || null, preferredDate || null, meetingId, department];
    }

    const result = await db.execute({ sql, args });
    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: 'Talep bulunamadı veya bu talebe erişim yetkiniz yok.' });
    }

    res.json({ message: 'Toplantı talebi güncellendi.' });
  } catch (error) {
    res.status(500).json({ error: 'Talep güncellenirken hata: ' + error.message });
  }
});

// ============================================================
// TOPLANTI NOTLARI (Geçmiş Toplantılar): bir toplantıyı görebilen herkes (talep eden, çağrılan
// roldeki/kişideki kullanıcılar, kendi biriminden Müdür/Ekip Lideri, Admin/İK) o toplantıya not
// ekleyebilir/görüntüleyebilir — GET /api/meetings ile birebir aynı görünürlük kuralı kullanılır.
// ============================================================
async function canAccessMeeting(meetingId, userId, role, department) {
  if (isAdmin(role)) return true;
  const mRes = await db.execute({
    sql: `SELECT requested_by, department, target_roles, target_user_ids FROM meeting_requests WHERE id = ?`,
    args: [meetingId]
  });
  const m = mRes.rows[0];
  if (!m) return false;
  if (String(m.requested_by) === String(userId)) return true;
  if (role && m.target_roles && m.target_roles.includes(role)) return true;
  if (userId && m.target_user_ids && m.target_user_ids.includes(`,${userId},`)) return true;
  if (['MANAGER', 'LEADER'].includes(role) && department && m.department === department) return true;
  return false;
}

app.get('/api/meetings/:id/notes', async (req, res) => {
  try {
    const { userId, role, department } = req.query;
    const meetingId = req.params.id;
    const allowed = await canAccessMeeting(meetingId, userId, role, department);
    if (!allowed) return res.status(403).json({ error: 'Bu toplantının notlarını görüntüleme yetkiniz yok.' });

    const result = await db.execute({
      sql: `SELECT meeting_notes.*, users.name AS author_name
            FROM meeting_notes LEFT JOIN users ON meeting_notes.user_id = users.id
            WHERE meeting_notes.meeting_id = ? ORDER BY meeting_notes.created_at ASC`,
      args: [meetingId]
    });
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/meetings/:id/notes', async (req, res) => {
  try {
    const { userId, role, department, note } = req.body;
    const meetingId = req.params.id;
    if (!note || !note.trim()) return res.status(400).json({ error: 'Not boş olamaz.' });

    const allowed = await canAccessMeeting(meetingId, userId, role, department);
    if (!allowed) return res.status(403).json({ error: 'Bu toplantıya not ekleme yetkiniz yok.' });

    const createdAt = new Date().toISOString();
    const result = await db.execute({
      sql: `INSERT INTO meeting_notes (meeting_id, user_id, note, created_at) VALUES (?, ?, ?, ?)`,
      args: [meetingId, userId, note.trim(), createdAt]
    });
    res.json({ id: Number(result.lastInsertRowid), message: 'Not eklendi.' });
  } catch (error) {
    res.status(500).json({ error: 'Not eklenirken hata: ' + error.message });
  }
});

// ============================================================
// PROJE SİSTEMİ API'LERİ (Firmalar / Projeler / İlerleme)
// ============================================================

// Yardımcı: bugünün YYYY-MM-DD değeri
function todayISO() {
  return new Date().toISOString().substring(0, 10);
}

// Sunucu (Render) UTC'de çalıştığı için new Date().toISOString() Türkiye saatinden 3 saat geridir.
// Türkiye DST uygulamadığından (sabit UTC+3) saati bu şekilde kaydırıp yerel saat olarak kaydediyoruz.
function nowTurkeyLocal() {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);
}

// Yardımcı: iki tarih arası tam gün farkı (b - a)
function daysBetween(a, b) {
  const da = new Date(a + 'T00:00:00');
  const db2 = new Date(b + 'T00:00:00');
  return Math.round((db2 - da) / 86400000);
}

// --- BİRİM ALT ALANLARI (department_subareas) ---

// Bir birimin alt alanlarını listele (department query ile) veya tümü
app.get('/api/subareas', async (req, res) => {
  try {
    const { department } = req.query;
    let sql = `SELECT * FROM department_subareas`;
    const args = [];
    if (department) { sql += ` WHERE department_key = ?`; args.push(department); }
    sql += ` ORDER BY id ASC`;
    const r = await db.execute({ sql, args });
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Alt alan ekle (Admin)
app.post('/api/subareas', async (req, res) => {
  try {
    const { department, label, userRole } = req.body;
    if (!isAdmin(userRole)) return res.status(403).json({ error: 'Yetkisiz erişim.' });
    if (!department || !label || !label.trim()) return res.status(400).json({ error: 'Birim ve alt alan adı gerekli.' });
    await db.execute({
      sql: `INSERT INTO department_subareas (department_key, label, created_at) VALUES (?, ?, ?)`,
      args: [department, label.trim(), todayISO()]
    });
    res.json({ message: 'Alt alan eklendi.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Alt alan sil (Admin)
app.delete('/api/subareas/:id', async (req, res) => {
  try {
    const { userRole } = req.body;
    if (!isAdmin(userRole)) return res.status(403).json({ error: 'Yetkisiz erişim.' });
    await db.execute({ sql: `DELETE FROM department_subareas WHERE id = ?`, args: [req.params.id] });
    res.json({ message: 'Alt alan silindi.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- BİLDİRİMLER ---

// Kullanıcının okunmamış (henüz görüntülenmemiş) bildirimleri
app.get('/api/notifications', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId gerekli.' });
    const r = await db.execute({
      sql: `SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100`,
      args: [userId]
    });
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Bir bildirimin içeriği görüntülendiğinde: kalıcı olarak silinir
app.delete('/api/notifications/:id', async (req, res) => {
  try {
    await db.execute({ sql: `DELETE FROM notifications WHERE id = ?`, args: [req.params.id] });
    res.json({ message: 'ok' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Bir kullanıcının bildirim panelini kapatırken tümünü görüntülenmiş saymak isterse (opsiyonel)
app.delete('/api/notifications', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId gerekli.' });
    await db.execute({ sql: `DELETE FROM notifications WHERE user_id = ?`, args: [userId] });
    res.json({ message: 'ok' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- STAJYER GİRİŞ/ÇIKIŞ TAKİBİ ---

// Stajyer "Giriş Yap" der: yeni bir oturum satırı açar (check_out_at NULL kalır).
// Konum (lat/lng) tarayıcıdan opsiyonel gelir; verilmezse null kaydedilir.
app.post('/api/attendance/checkin', async (req, res) => {
  try {
    const { internId, lat, lng } = req.body;
    if (!internId) return res.status(400).json({ error: 'internId gerekli.' });

    const openRes = await db.execute({
      sql: `SELECT id FROM attendance_logs WHERE intern_id = ? AND check_out_at IS NULL`,
      args: [internId]
    });
    if (openRes.rows.length > 0) {
      return res.status(400).json({ error: 'Zaten açık bir giriş kaydınız var. Önce çıkış yapın.' });
    }

    const now = nowTurkeyLocal();
    const result = await db.execute({
      sql: `INSERT INTO attendance_logs (intern_id, check_in_at, check_in_lat, check_in_lng) VALUES (?, ?, ?, ?)`,
      args: [internId, now, lat != null ? lat : null, lng != null ? lng : null]
    });

    // Sorumlu mühendise bildir
    try {
      const uRes = await db.execute({ sql: `SELECT name, engineer_id FROM users WHERE id = ?`, args: [internId] });
      const intern = uRes.rows[0];
      if (intern && intern.engineer_id) {
        const timeLabel = now.substring(11, 16);
        const locNote = (lat != null && lng != null) ? ' (konum alındı)' : ' (konum alınamadı)';
        await createNotification(intern.engineer_id, 'ATTENDANCE_CHECKIN', 'ATTENDANCE', 'Stajyer Giriş Yaptı', `${intern.name} ${timeLabel}'de giriş yaptı${locNote}.`, Number(result.lastInsertRowid));
      }
    } catch (notifErr) { console.error('Giriş bildirimi hatası:', notifErr.message); }

    res.json({ id: Number(result.lastInsertRowid), checkInAt: now });
  } catch (error) {
    res.status(500).json({ error: 'Giriş kaydedilemedi: ' + error.message });
  }
});

// Stajyer "Çıkış Yap" der: açık olan son oturum satırını kapatır.
app.post('/api/attendance/checkout', async (req, res) => {
  try {
    const { internId, lat, lng } = req.body;
    if (!internId) return res.status(400).json({ error: 'internId gerekli.' });

    const openRes = await db.execute({
      sql: `SELECT id FROM attendance_logs WHERE intern_id = ? AND check_out_at IS NULL ORDER BY id DESC LIMIT 1`,
      args: [internId]
    });
    if (openRes.rows.length === 0) {
      return res.status(400).json({ error: 'Açık bir giriş kaydı bulunamadı. Önce giriş yapmalısınız.' });
    }
    const logId = openRes.rows[0].id;

    const now = nowTurkeyLocal();
    await db.execute({
      sql: `UPDATE attendance_logs SET check_out_at = ?, check_out_lat = ?, check_out_lng = ? WHERE id = ?`,
      args: [now, lat != null ? lat : null, lng != null ? lng : null, logId]
    });

    try {
      const uRes = await db.execute({ sql: `SELECT name, engineer_id FROM users WHERE id = ?`, args: [internId] });
      const intern = uRes.rows[0];
      if (intern && intern.engineer_id) {
        const timeLabel = now.substring(11, 16);
        const locNote = (lat != null && lng != null) ? ' (konum alındı)' : ' (konum alınamadı)';
        await createNotification(intern.engineer_id, 'ATTENDANCE_CHECKOUT', 'ATTENDANCE', 'Stajyer Çıkış Yaptı', `${intern.name} ${timeLabel}'de çıkış yaptı${locNote}.`, logId);
      }
    } catch (notifErr) { console.error('Çıkış bildirimi hatası:', notifErr.message); }

    res.json({ id: logId, checkOutAt: now });
  } catch (error) {
    res.status(500).json({ error: 'Çıkış kaydedilemedi: ' + error.message });
  }
});

// Stajyerin şu anki durumu: açık bir oturumu var mı (giriş yapmış ama çıkış yapmamış)?
app.get('/api/attendance/status', async (req, res) => {
  try {
    const { internId } = req.query;
    if (!internId) return res.status(400).json({ error: 'internId gerekli.' });
    const r = await db.execute({
      sql: `SELECT * FROM attendance_logs WHERE intern_id = ? AND check_out_at IS NULL ORDER BY id DESC LIMIT 1`,
      args: [internId]
    });
    res.json({ open: r.rows[0] || null });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Stajyerin kendi giriş/çıkış geçmişi (en yeniden en eskiye)
app.get('/api/attendance/mine', async (req, res) => {
  try {
    const { internId } = req.query;
    if (!internId) return res.status(400).json({ error: 'internId gerekli.' });
    const r = await db.execute({
      sql: `SELECT * FROM attendance_logs WHERE intern_id = ? ORDER BY id DESC LIMIT 30`,
      args: [internId]
    });
    res.json(r.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Sorumlu mühendisin, kendisine bağlı tüm stajyerlerin giriş/çıkış geçmişini görmesi
// (bildirim panelindeki "Stajyer Giriş/Çıkış" alanı bunu kullanır — bildirimlerin aksine
// görüntülenince silinmez, kalıcı bir takip listesidir).
app.get('/api/attendance/team', async (req, res) => {
  try {
    const { engineerId } = req.query;
    if (!engineerId) return res.status(400).json({ error: 'engineerId gerekli.' });
    const r = await db.execute({
      sql: `SELECT attendance_logs.*, users.name AS intern_name
            FROM attendance_logs
            JOIN users ON users.id = attendance_logs.intern_id
            WHERE users.engineer_id = ?
            ORDER BY attendance_logs.id DESC
            LIMIT 50`,
      args: [engineerId]
    });
    res.json(r.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// UZAKTAN ÇALIŞMA (VPN) GİRİŞ/ÇIKIŞ TAKİBİ
// Ofis dışında VPN üzerinden bağlanan stajyerler için check-in/check-out, tarayıcıdan değil
// VPN sunucusundaki bir watcher script'inden (bkz. vpn/watcher.js) gelir. Bu yüzden kimlik
// doğrulama kullanıcı oturumu yerine paylaşılan bir "secret" ile yapılır — aynı SHEET_SYNC_SECRET
// deseni (bkz. yukarısı), çünkü bu da sunucudan sunucuya bir çağrı.
// ============================================================
const VPN_WATCHER_SECRET = process.env.VPN_WATCHER_SECRET;

function checkVpnWatcherSecret(req, res) {
  if (!VPN_WATCHER_SECRET) {
    res.status(500).json({ error: 'VPN_WATCHER_SECRET ortam değişkeni tanımlı değil.' });
    return false;
  }
  const provided = req.body.secret;
  if (!provided || provided !== VPN_WATCHER_SECRET) {
    res.status(403).json({ error: 'Geçersiz secret.' });
    return false;
  }
  return true;
}

// Watcher, bir stajyerin WireGuard peer'ı "bağlandı" durumuna geçtiğinde bunu çağırır.
app.post('/api/attendance/vpn-checkin', async (req, res) => {
  try {
    if (!checkVpnWatcherSecret(req, res)) return;
    const { internId, clientIp } = req.body;
    if (!internId) return res.status(400).json({ error: 'internId gerekli.' });

    const openRes = await db.execute({
      sql: `SELECT id FROM attendance_logs WHERE intern_id = ? AND check_out_at IS NULL`,
      args: [internId]
    });
    if (openRes.rows.length > 0) {
      // Zaten açık bir oturum var (ör. ofisten giriş yapılmış) — tekrar satır açma.
      return res.json({ skipped: true, reason: 'already-open' });
    }

    const now = nowTurkeyLocal();
    const result = await db.execute({
      sql: `INSERT INTO attendance_logs (intern_id, check_in_at, session_type, client_ip) VALUES (?, ?, 'remote-vpn', ?)`,
      args: [internId, now, clientIp || null]
    });

    try {
      const uRes = await db.execute({ sql: `SELECT name, engineer_id FROM users WHERE id = ?`, args: [internId] });
      const intern = uRes.rows[0];
      if (intern && intern.engineer_id) {
        const timeLabel = now.substring(11, 16);
        await createNotification(intern.engineer_id, 'ATTENDANCE_CHECKIN', 'ATTENDANCE', 'Stajyer VPN ile Giriş Yaptı', `${intern.name} ${timeLabel}'de VPN üzerinden bağlandı.`, Number(result.lastInsertRowid));
      }
    } catch (notifErr) { console.error('VPN giriş bildirimi hatası:', notifErr.message); }

    res.json({ id: Number(result.lastInsertRowid), checkInAt: now });
  } catch (error) {
    res.status(500).json({ error: 'VPN girişi kaydedilemedi: ' + error.message });
  }
});

// Watcher, peer'ın handshake'i belirli bir süre yenilenmeyip "koptu" sayıldığında bunu çağırır.
app.post('/api/attendance/vpn-checkout', async (req, res) => {
  try {
    if (!checkVpnWatcherSecret(req, res)) return;
    const { internId } = req.body;
    if (!internId) return res.status(400).json({ error: 'internId gerekli.' });

    const openRes = await db.execute({
      sql: `SELECT id FROM attendance_logs WHERE intern_id = ? AND check_out_at IS NULL AND session_type = 'remote-vpn' ORDER BY id DESC LIMIT 1`,
      args: [internId]
    });
    if (openRes.rows.length === 0) {
      return res.json({ skipped: true, reason: 'no-open-vpn-session' });
    }
    const logId = openRes.rows[0].id;

    const now = nowTurkeyLocal();
    await db.execute({
      sql: `UPDATE attendance_logs SET check_out_at = ? WHERE id = ?`,
      args: [now, logId]
    });

    try {
      const uRes = await db.execute({ sql: `SELECT name, engineer_id FROM users WHERE id = ?`, args: [internId] });
      const intern = uRes.rows[0];
      if (intern && intern.engineer_id) {
        const timeLabel = now.substring(11, 16);
        await createNotification(intern.engineer_id, 'ATTENDANCE_CHECKOUT', 'ATTENDANCE', 'Stajyer VPN Bağlantısı Sonlandı', `${intern.name} ${timeLabel}'de VPN bağlantısı kesildi.`, logId);
      }
    } catch (notifErr) { console.error('VPN çıkış bildirimi hatası:', notifErr.message); }

    res.json({ id: logId, checkOutAt: now });
  } catch (error) {
    res.status(500).json({ error: 'VPN çıkışı kaydedilemedi: ' + error.message });
  }
});

// Bir kullanıcının alt alanını / telefonunu güncelle (Admin)
app.put('/api/users/:id/sub-area', async (req, res) => {
  try {
    const { sub_area, phone, userRole } = req.body;
    if (!isAdmin(userRole)) return res.status(403).json({ error: 'Yetkisiz erişim.' });
    const cur = await db.execute({ sql: `SELECT sub_area, phone FROM users WHERE id = ?`, args: [req.params.id] });
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    await db.execute({
      sql: `UPDATE users SET sub_area = ?, phone = ? WHERE id = ?`,
      args: [
        sub_area !== undefined ? sub_area : cur.rows[0].sub_area,
        phone !== undefined ? phone : cur.rows[0].phone,
        req.params.id
      ]
    });
    res.json({ message: 'Güncellendi.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- BİRİMLER (project_departments) ---

// Birim listesi
app.get('/api/departments', async (req, res) => {
  try {
    const r = await db.execute(`SELECT * FROM project_departments ORDER BY id ASC`);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Birim ekle (Admin)
app.post('/api/departments', async (req, res) => {
  try {
    const { label, icon, userRole } = req.body;
    if (!isAdmin(userRole)) return res.status(403).json({ error: 'Yetkisiz erişim.' });
    if (!label || !label.trim()) return res.status(400).json({ error: 'Birim adı gerekli.' });
    // key: Türkçe karakterleri sadeleştirip büyük harf + alt çizgi
    const base = label.trim()
      .replace(/ı/g, 'i').replace(/İ/g, 'I')
      .replace(/ş/g, 's').replace(/Ş/g, 'S')
      .replace(/ğ/g, 'g').replace(/Ğ/g, 'G')
      .replace(/ü/g, 'u').replace(/Ü/g, 'U')
      .replace(/ö/g, 'o').replace(/Ö/g, 'O')
      .replace(/ç/g, 'c').replace(/Ç/g, 'C')
      .toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    let key = base || ('BIRIM_' + Date.now());
    // Çakışma varsa sonuna sayı ekle
    try {
      const exists = await db.execute({ sql: `SELECT id FROM project_departments WHERE key = ?`, args: [key] });
      if (exists.rows.length) key = key + '_' + Date.now().toString().slice(-4);
    } catch (e) {}
    await db.execute({
      sql: `INSERT INTO project_departments (key, label, icon, created_at) VALUES (?, ?, ?, ?)`,
      args: [key, label.trim(), icon || 'fa-layer-group', todayISO()]
    });
    res.json({ message: 'Birim eklendi.', key });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Birim sil (Admin) — bağlı firma/proje varsa engelle
app.delete('/api/departments/:id', async (req, res) => {
  try {
    const { userRole } = req.body;
    if (!isAdmin(userRole)) return res.status(403).json({ error: 'Yetkisiz erişim.' });
    const d = await db.execute({ sql: `SELECT key FROM project_departments WHERE id = ?`, args: [req.params.id] });
    if (d.rows.length === 0) return res.status(404).json({ error: 'Birim bulunamadı.' });
    const key = d.rows[0].key;
    const pc = await db.execute({ sql: `SELECT COUNT(*) AS c FROM projects WHERE department = ?`, args: [key] });
    if (Number(pc.rows[0].c) > 0) return res.status(400).json({ error: 'Bu birime bağlı projeler var, önce onları silin.' });
    await db.execute({ sql: `DELETE FROM project_departments WHERE id = ?`, args: [req.params.id] });
    res.json({ message: 'Birim silindi.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- FİRMALAR ---

// Firma listesi (opsiyonel birim filtresi)
app.get('/api/companies', async (req, res) => {
  try {
    const { department } = req.query;
    let sql = `SELECT * FROM companies`;
    const args = [];
    if (department) { sql += ` WHERE department = ?`; args.push(department); }
    sql += ` ORDER BY name ASC`;
    const r = await db.execute({ sql, args });
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Firma ekle (Admin: herhangi bir birim/genel; Müdür: yalnızca kendi birimi — sunucu tarafında sabitlenir)
app.post('/api/companies', async (req, res) => {
  try {
    const { name, department, userRole, userId } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Firma adı gerekli.' });

    let finalDepartment = department || null;
    if (isAdmin(userRole)) {
      // Admin istediği birimi (veya "genel") seçebilir
    } else if (isDeptLockedRole(userRole)) {
      const u = await db.execute({ sql: `SELECT department FROM users WHERE id = ?`, args: [userId] });
      if (u.rows.length === 0) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
      finalDepartment = u.rows[0].department; // kendi biriminden başka değer gönderilse bile yok sayılır
    } else {
      return res.status(403).json({ error: 'Yetkisiz erişim.' });
    }

    const r = await db.execute({
      sql: `INSERT INTO companies (name, department, created_at) VALUES (?, ?, ?)`,
      args: [name.trim(), finalDepartment, todayISO()]
    });
    res.json({ message: 'Firma eklendi.', id: Number(r.lastInsertRowid) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Firma sil (Admin: herhangi biri; Müdür: yalnızca kendi birimine ait firmalar) — bağlı projeler ve ilerleme kayıtları da silinir
app.delete('/api/companies/:id', async (req, res) => {
  try {
    const { userRole, userId } = req.body;
    const cid = req.params.id;

    if (!isAdmin(userRole)) {
      if (!isDeptLockedRole(userRole)) return res.status(403).json({ error: 'Yetkisiz erişim.' });
      const [uRes, cRes] = await Promise.all([
        db.execute({ sql: `SELECT department FROM users WHERE id = ?`, args: [userId] }),
        db.execute({ sql: `SELECT department FROM companies WHERE id = ?`, args: [cid] })
      ]);
      if (uRes.rows.length === 0 || cRes.rows.length === 0) return res.status(404).json({ error: 'Bulunamadı.' });
      const companyDept = cRes.rows[0].department;
      if (!companyDept || companyDept !== uRes.rows[0].department) {
        return res.status(403).json({ error: 'Bu firmayı silme yetkiniz yok.' });
      }
    }

    const projs = await db.execute({ sql: `SELECT id FROM projects WHERE company_id = ?`, args: [cid] });
    for (const p of projs.rows) {
      await db.execute({ sql: `DELETE FROM project_progress WHERE project_id = ?`, args: [p.id] });
    }
    await db.execute({ sql: `DELETE FROM projects WHERE company_id = ?`, args: [cid] });
    await db.execute({ sql: `DELETE FROM companies WHERE id = ?`, args: [cid] });
    res.json({ message: 'Firma ve bağlı projeler silindi.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- PROJELER ---

// Proje listesi (opsiyonel firma / birim filtresi). Her projeye özet ilerleme bilgisi eklenir.
app.get('/api/projects', async (req, res) => {
  try {
    const { company_id, department } = req.query;
    let sql = `
      SELECT projects.*, companies.name AS company_name, users.name AS owner_name
      FROM projects
      LEFT JOIN companies ON projects.company_id = companies.id
      LEFT JOIN users ON projects.owner_id = users.id
    `;
    const conds = [];
    const args = [];
    if (company_id) { conds.push('projects.company_id = ?'); args.push(company_id); }
    if (department) { conds.push('projects.department = ?'); args.push(department); }
    if (conds.length) sql += ` WHERE ` + conds.join(' AND ');
    sql += ` ORDER BY projects.end_date ASC`;
    const r = await db.execute({ sql, args });

    const today = todayISO();
    // Her proje için son gerçekleşen ilerlemeyi ve gecikme durumunu hesapla
    const enriched = [];
    for (const p of r.rows) {
      const prog = await db.execute({
        sql: `SELECT actual, log_date FROM project_progress WHERE project_id = ? ORDER BY log_date ASC`,
        args: [p.id]
      });
      const rows = prog.rows;
      const last = rows.length ? rows[rows.length - 1] : null;
      const actual = last ? Number(last.actual) : 0;
      const daysLeft = daysBetween(today, p.end_date);
      const isOverdue = (p.status !== 'COMPLETED') && daysLeft < 0;
      enriched.push({
        ...p,
        actual,
        days_left: daysLeft,
        is_overdue: isOverdue
      });
    }
    res.json(enriched);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Tek proje + tam ilerleme serisi (gidişat grafiği için)
app.get('/api/projects/:id', async (req, res) => {
  try {
    const pid = req.params.id;
    const pr = await db.execute({
      sql: `SELECT projects.*, companies.name AS company_name, users.name AS owner_name
            FROM projects
            LEFT JOIN companies ON projects.company_id = companies.id
            LEFT JOIN users ON projects.owner_id = users.id
            WHERE projects.id = ?`,
      args: [pid]
    });
    if (pr.rows.length === 0) return res.status(404).json({ error: 'Proje bulunamadı.' });
    const progress = await db.execute({
      sql: `SELECT id, log_date, actual, note FROM project_progress WHERE project_id = ? ORDER BY log_date ASC, id ASC`,
      args: [pid]
    });
    res.json({ project: pr.rows[0], progress: progress.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Proje oluştur (Admin: herhangi bir birim; Müdür: yalnızca kendi birimi — sunucu tarafında sabitlenir)
app.post('/api/projects', async (req, res) => {
  try {
    const { company_id, name, department, owner_id, start_date, end_date, priority, note, userRole, userId, createdBy } = req.body;
    if (!company_id || !name || !start_date || !end_date) {
      return res.status(400).json({ error: 'Firma, proje adı ve tarihler zorunludur.' });
    }

    let finalDepartment;
    if (isAdmin(userRole)) {
      if (!department) return res.status(400).json({ error: 'Birim zorunludur.' });
      finalDepartment = department;
    } else if (isDeptLockedRole(userRole)) {
      const u = await db.execute({ sql: `SELECT department FROM users WHERE id = ?`, args: [userId] });
      if (u.rows.length === 0) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
      finalDepartment = u.rows[0].department; // kendi biriminden başka değer gönderilse bile yok sayılır
    } else {
      return res.status(403).json({ error: 'Yetkisiz erişim.' });
    }

    const r = await db.execute({
      sql: `INSERT INTO projects (company_id, name, department, owner_id, start_date, end_date, priority, status, note, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
      args: [company_id, name.trim(), finalDepartment, owner_id || null, start_date, end_date, priority || 'NORMAL', note || null, createdBy || null, todayISO()]
    });
    const newProjectId = Number(r.lastInsertRowid);

    // Firma bir aşama şablonuna bağlıysa (örn. ASELSAN), checklist'i otomatik oluştur
    let stagesApplied = null;
    try {
      const companyRes = await db.execute({ sql: `SELECT name FROM companies WHERE id = ?`, args: [company_id] });
      const companyName = companyRes.rows[0] ? String(companyRes.rows[0].name || '').trim() : '';
      if (companyName) {
        const tmplRes = await db.execute({
          sql: `SELECT id, name FROM stage_templates WHERE LOWER(TRIM(auto_apply_company_name)) = LOWER(?) LIMIT 1`,
          args: [companyName]
        });
        if (tmplRes.rows.length > 0) {
          await applyStageTemplateToProject(tmplRes.rows[0].id, newProjectId);
          stagesApplied = tmplRes.rows[0].name;
        }
      }
    } catch (e) { console.error('Otomatik aşama şablonu uygulama hatası:', e.message); }

    // Sorumlu kişi atandıysa bildirim + mail gönder
    if (owner_id) {
      try {
        const ownerRes = await db.execute({ sql: `SELECT name, email FROM users WHERE id = ?`, args: [owner_id] });
        const owner = ownerRes.rows[0];
        if (owner) {
          const deptLabels = { ELEKTRONIK: 'Elektronik', YAZILIM: 'Yazılım', MEKANIK: 'Mekanik', INSAN_KAYNAKLARI: 'İnsan Kaynakları' };
          createNotification(owner_id, 'PROJECT_ASSIGNED', 'PROJECTS', 'Yeni Proje Atandı', `"${name.trim()}" projesi size atandı.`, newProjectId)
            .catch(e => console.error('Proje atama bildirimi hatası:', e.message));
          if (owner.email && SETTINGS_CACHE.email_project_assigned) {
            await sendDetailsEmail(
              owner.email, owner.name,
              `Yeni Proje Atandı: ${name.trim()}`,
              'Yeni Proje Atandı',
              `Merhaba <strong style="color: #38bdf8;">${owner.name}</strong>, size yeni bir proje atandı. Detaylar aşağıda yer almaktadır:`,
              [
                ['Proje Adı', name.trim()],
                ['Birim', deptLabels[finalDepartment] || finalDepartment],
                ['Başlangıç', start_date],
                ['Bitiş', end_date],
                ['Öncelik', priority || 'NORMAL']
              ],
              'Projeyi İncele'
            );
          }
        }
      } catch (e) { console.error('Proje sahibi bilgisi alınamadı:', e.message); }
    }

    res.json({ message: 'Proje oluşturuldu.', id: newProjectId, stagesApplied });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Proje güncelle (Admin) — durum, öncelik, not, tarihler
app.put('/api/projects/:id', async (req, res) => {
  try {
    const { name, owner_id, start_date, end_date, priority, status, note, userRole } = req.body;
    if (!isAdmin(userRole)) return res.status(403).json({ error: 'Yetkisiz erişim.' });
    const pid = req.params.id;
    const cur = await db.execute({ sql: `SELECT * FROM projects WHERE id = ?`, args: [pid] });
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Proje bulunamadı.' });
    const p = cur.rows[0];
    await db.execute({
      sql: `UPDATE projects SET name=?, owner_id=?, start_date=?, end_date=?, priority=?, status=?, note=? WHERE id=?`,
      args: [
        name ?? p.name,
        owner_id !== undefined ? owner_id : p.owner_id,
        start_date ?? p.start_date,
        end_date ?? p.end_date,
        priority ?? p.priority,
        status ?? p.status,
        note !== undefined ? note : p.note,
        pid
      ]
    });
    res.json({ message: 'Proje güncellendi.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Proje sil (Admin: herhangi biri; Müdür: yalnızca kendi birimine ait projeler)
app.delete('/api/projects/:id', async (req, res) => {
  try {
    const { userRole, userId } = req.body;
    const pid = req.params.id;

    if (!isAdmin(userRole)) {
      if (!isDeptLockedRole(userRole)) return res.status(403).json({ error: 'Yetkisiz erişim.' });
      const [uRes, pRes] = await Promise.all([
        db.execute({ sql: `SELECT department FROM users WHERE id = ?`, args: [userId] }),
        db.execute({ sql: `SELECT department FROM projects WHERE id = ?`, args: [pid] })
      ]);
      if (uRes.rows.length === 0 || pRes.rows.length === 0) return res.status(404).json({ error: 'Bulunamadı.' });
      if (pRes.rows[0].department !== uRes.rows[0].department) {
        return res.status(403).json({ error: 'Bu projeyi silme yetkiniz yok.' });
      }
    }

    await db.execute({ sql: `DELETE FROM project_progress WHERE project_id = ?`, args: [pid] });
    await db.execute({ sql: `DELETE FROM project_stages WHERE project_id = ?`, args: [pid] });
    await db.execute({ sql: `DELETE FROM projects WHERE id = ?`, args: [pid] });
    res.json({ message: 'Proje silindi.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- İLERLEME KAYITLARI (gidişat noktaları) ---

// İlerleme noktası ekle (Admin veya proje sahibi)
app.post('/api/projects/:id/progress', async (req, res) => {
  try {
    const { log_date, actual, note, userRole, userId } = req.body;
    const pid = req.params.id;
    const cur = await db.execute({ sql: `SELECT owner_id, name FROM projects WHERE id = ?`, args: [pid] });
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Proje bulunamadı.' });
    const project = cur.rows[0];
    const isOwner = userId && Number(project.owner_id) === Number(userId);
    if (!isAdmin(userRole) && !isOwner) return res.status(403).json({ error: 'Yetkisiz erişim.' });
    if (!log_date) return res.status(400).json({ error: 'Tarih gerekli.' });
    await db.execute({
      sql: `INSERT INTO project_progress (project_id, log_date, actual, note, created_at) VALUES (?, ?, ?, ?, ?)`,
      args: [pid, log_date, Number(actual) || 0, note || null, todayISO()]
    });

    // Admin eklediyse proje sahibine, sahibi eklediyse Admin'lere bildirim düşür
    (async () => {
      try {
        const message = `"${project.name}" projesine yeni ilerleme noktası eklendi.`;
        if (isAdmin(userRole)) {
          if (project.owner_id && Number(project.owner_id) !== Number(userId)) {
            await createNotification(project.owner_id, 'PROJECT_PROGRESS', 'PROJECTS', 'Proje İlerlemesi Güncellendi', message, Number(pid));
          }
        } else {
          const adminsRes = await db.execute(`SELECT id FROM users WHERE role IN ('ADMIN', 'HR')`);
          await notifyUsers(adminsRes.rows.map(r => r.id), 'PROJECT_PROGRESS', 'PROJECTS', 'Proje İlerlemesi Güncellendi', message, Number(pid));
        }
      } catch (notifErr) { console.error('Proje ilerleme bildirimi hatası:', notifErr.message); }
    })();

    res.json({ message: 'İlerleme kaydedildi.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// İlerleme noktası sil (Admin)
// İlerleme notu düzenle (Admin) — tarih/gerçekleşen/not alanları değiştirilebilir
app.put('/api/progress/:id', async (req, res) => {
  try {
    const { userRole, log_date, actual, note } = req.body;
    if (!isAdmin(userRole)) return res.status(403).json({ error: 'Yetkisiz erişim.' });
    if (!log_date) return res.status(400).json({ error: 'Tarih gerekli.' });
    const result = await db.execute({
      sql: `UPDATE project_progress SET log_date = ?, actual = ?, note = ? WHERE id = ?`,
      args: [log_date, Number(actual) || 0, note || null, req.params.id]
    });
    if (result.rowsAffected === 0) return res.status(404).json({ error: 'Kayıt bulunamadı.' });
    res.json({ message: 'Kayıt güncellendi.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/progress/:id', async (req, res) => {
  try {
    const { userRole } = req.body;
    if (!isAdmin(userRole)) return res.status(403).json({ error: 'Yetkisiz erişim.' });
    await db.execute({ sql: `DELETE FROM project_progress WHERE id = ?`, args: [req.params.id] });
    res.json({ message: 'Kayıt silindi.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- AŞAMA ŞABLONLARI (tekrar kullanılabilir ana+alt aşama checklist tanımları) ---
// Oluşturma/düzenleme/silme: Admin/İK + Müdür/Ekip Lideri.

app.get('/api/stage-templates', async (req, res) => {
  try {
    const templatesRes = await db.execute(`SELECT id, name, auto_apply_company_name, created_by, created_at FROM stage_templates ORDER BY name ASC`);
    const templates = templatesRes.rows;
    if (templates.length === 0) return res.json([]);
    const placeholders = templates.map(() => '?').join(',');
    const itemsRes = await db.execute({
      sql: `SELECT template_id, id FROM stage_template_items WHERE template_id IN (${placeholders})`,
      args: templates.map(t => t.id)
    });
    const counts = {};
    for (const it of itemsRes.rows) counts[it.template_id] = (counts[it.template_id] || 0) + 1;
    res.json(templates.map(t => ({ ...t, itemCount: counts[t.id] || 0 })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/stage-templates/:id', async (req, res) => {
  try {
    const tRes = await db.execute({ sql: `SELECT id, name, auto_apply_company_name FROM stage_templates WHERE id = ?`, args: [req.params.id] });
    if (tRes.rows.length === 0) return res.status(404).json({ error: 'Şablon bulunamadı.' });
    const itemsRes = await db.execute({
      sql: `SELECT id, parent_item_id, title, sort_order FROM stage_template_items WHERE template_id = ? ORDER BY sort_order ASC`,
      args: [req.params.id]
    });
    const items = itemsRes.rows;
    const mains = items.filter(i => i.parent_item_id == null).map(m => ({
      id: m.id,
      title: m.title,
      subItems: items.filter(s => s.parent_item_id === m.id).map(s => ({ id: s.id, title: s.title }))
    }));
    res.json({ ...tRes.rows[0], items: mains });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/stage-templates', async (req, res) => {
  try {
    const { name, autoApplyCompanyName, items, userRole, userName } = req.body;
    if (!isAdmin(userRole) && !isDeptLockedRole(userRole)) return res.status(403).json({ error: 'Yetkisiz erişim.' });
    if (!name || !name.trim()) return res.status(400).json({ error: 'Şablon adı zorunludur.' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'En az bir ana aşama ekleyin.' });

    const now = new Date().toISOString();
    const tRes = await db.execute({
      sql: `INSERT INTO stage_templates (name, auto_apply_company_name, created_by, created_at) VALUES (?, ?, ?, ?)`,
      args: [name.trim(), (autoApplyCompanyName || '').trim() || null, userName || null, now]
    });
    const templateId = Number(tRes.lastInsertRowid);
    await writeStageTemplateItems(templateId, items);

    res.json({ message: 'Şablon oluşturuldu.', id: templateId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/stage-templates/:id', async (req, res) => {
  try {
    const { name, autoApplyCompanyName, items, userRole } = req.body;
    if (!isAdmin(userRole) && !isDeptLockedRole(userRole)) return res.status(403).json({ error: 'Yetkisiz erişim.' });
    const templateId = req.params.id;
    const tRes = await db.execute({ sql: `SELECT id FROM stage_templates WHERE id = ?`, args: [templateId] });
    if (tRes.rows.length === 0) return res.status(404).json({ error: 'Şablon bulunamadı.' });
    if (!name || !name.trim()) return res.status(400).json({ error: 'Şablon adı zorunludur.' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'En az bir ana aşama ekleyin.' });

    await db.execute({
      sql: `UPDATE stage_templates SET name = ?, auto_apply_company_name = ? WHERE id = ?`,
      args: [name.trim(), (autoApplyCompanyName || '').trim() || null, templateId]
    });
    await db.execute({ sql: `DELETE FROM stage_template_items WHERE template_id = ?`, args: [templateId] });
    await writeStageTemplateItems(templateId, items);

    res.json({ message: 'Şablon güncellendi.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/stage-templates/:id', async (req, res) => {
  try {
    const { userRole } = req.body;
    if (!isAdmin(userRole) && !isDeptLockedRole(userRole)) return res.status(403).json({ error: 'Yetkisiz erişim.' });
    await db.execute({ sql: `DELETE FROM stage_template_items WHERE template_id = ?`, args: [req.params.id] });
    await db.execute({ sql: `DELETE FROM stage_templates WHERE id = ?`, args: [req.params.id] });
    res.json({ message: 'Şablon silindi.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- PROJE AŞAMA CHECKLIST'İ (bir şablondan projeye kopyalanan, projeye özel tamamlanma durumu) ---

app.get('/api/projects/:id/stages', async (req, res) => {
  try {
    const rowsRes = await db.execute({
      sql: `SELECT id, parent_id, title, sort_order, is_done, completed_at, completed_by, note FROM project_stages WHERE project_id = ? ORDER BY sort_order ASC`,
      args: [req.params.id]
    });
    const rows = rowsRes.rows;
    const mains = rows.filter(r => r.parent_id == null).map(m => ({
      id: m.id, title: m.title, isDone: !!m.is_done, completedAt: m.completed_at, completedBy: m.completed_by, note: m.note,
      subItems: rows
        .filter(s => s.parent_id === m.id)
        .map(s => ({ id: s.id, title: s.title, isDone: !!s.is_done, completedAt: s.completed_at, completedBy: s.completed_by, note: s.note }))
    }));
    res.json({ stages: mains, percentage: computeStagePercentage(rows) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:id/stages/apply-template', async (req, res) => {
  try {
    const { templateId, userRole, userId } = req.body;
    const pid = req.params.id;
    const pRes = await db.execute({ sql: `SELECT owner_id FROM projects WHERE id = ?`, args: [pid] });
    if (pRes.rows.length === 0) return res.status(404).json({ error: 'Proje bulunamadı.' });
    if (!canManageProjectStages(userRole, userId, pRes.rows[0])) return res.status(403).json({ error: 'Yetkisiz erişim.' });
    if (!templateId) return res.status(400).json({ error: 'Şablon seçiniz.' });
    const tRes = await db.execute({ sql: `SELECT id, name FROM stage_templates WHERE id = ?`, args: [templateId] });
    if (tRes.rows.length === 0) return res.status(404).json({ error: 'Şablon bulunamadı.' });

    await applyStageTemplateToProject(templateId, pid);
    res.json({ message: `"${tRes.rows[0].name}" şablonu uygulandı.` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:id/stages', async (req, res) => {
  try {
    const { parentId, title, userRole, userId } = req.body;
    const pid = req.params.id;
    const pRes = await db.execute({ sql: `SELECT owner_id FROM projects WHERE id = ?`, args: [pid] });
    if (pRes.rows.length === 0) return res.status(404).json({ error: 'Proje bulunamadı.' });
    if (!canManageProjectStages(userRole, userId, pRes.rows[0])) return res.status(403).json({ error: 'Yetkisiz erişim.' });
    if (!title || !title.trim()) return res.status(400).json({ error: 'Başlık gerekli.' });

    let parentIdVal = null;
    if (parentId) {
      const parentRes = await db.execute({ sql: `SELECT id FROM project_stages WHERE id = ? AND project_id = ?`, args: [parentId, pid] });
      if (parentRes.rows.length === 0) return res.status(404).json({ error: 'Üst aşama bulunamadı.' });
      parentIdVal = parentId;
    }
    const orderRes = await db.execute({
      sql: parentIdVal
        ? `SELECT COALESCE(MAX(sort_order), -1) AS maxOrder FROM project_stages WHERE project_id = ? AND parent_id = ?`
        : `SELECT COALESCE(MAX(sort_order), -1) AS maxOrder FROM project_stages WHERE project_id = ? AND parent_id IS NULL`,
      args: parentIdVal ? [pid, parentIdVal] : [pid]
    });
    const nextOrder = Number(orderRes.rows[0].maxOrder) + 1;

    const r = await db.execute({
      sql: `INSERT INTO project_stages (project_id, parent_id, title, sort_order, is_done) VALUES (?, ?, ?, ?, 0)`,
      args: [pid, parentIdVal, title.trim(), nextOrder]
    });
    res.json({ message: 'Aşama eklendi.', id: Number(r.lastInsertRowid) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Aşama/alt aşama yeniden adlandırma ve/veya tamamlanma durumu değiştirme. isDone değişirse:
// completed_at/completed_by güncellenir, genel % yeniden hesaplanır ve project_progress'e otomatik
// yeni bir "Gerçekleşen %" kaydı (entry) eklenir — mevcut Planlanan/Gerçekleşen grafiğini besler.
app.put('/api/projects/:id/stages/:stageId', async (req, res) => {
  try {
    const { title, isDone, note, userRole, userId, userName } = req.body;
    const pid = req.params.id;
    const stageId = req.params.stageId;

    const pRes = await db.execute({ sql: `SELECT * FROM projects WHERE id = ?`, args: [pid] });
    if (pRes.rows.length === 0) return res.status(404).json({ error: 'Proje bulunamadı.' });
    const project = pRes.rows[0];
    if (!canManageProjectStages(userRole, userId, project)) return res.status(403).json({ error: 'Yetkisiz erişim.' });

    const stageRes = await db.execute({ sql: `SELECT * FROM project_stages WHERE id = ? AND project_id = ?`, args: [stageId, pid] });
    if (stageRes.rows.length === 0) return res.status(404).json({ error: 'Aşama bulunamadı.' });
    const stage = stageRes.rows[0];

    if (isDone !== undefined && stage.parent_id == null) {
      const childCountRes = await db.execute({ sql: `SELECT COUNT(*) AS c FROM project_stages WHERE parent_id = ?`, args: [stageId] });
      if (Number(childCountRes.rows[0].c) > 0) {
        return res.status(400).json({ error: 'Bu ana aşamanın alt aşamaları var; tamamlanma durumu alt aşamalardan hesaplanır.' });
      }
    }

    const updates = [];
    const args = [];
    if (title !== undefined && title.trim()) { updates.push('title = ?'); args.push(title.trim()); }
    if (note !== undefined) { updates.push('note = ?'); args.push(note ? note.trim() || null : null); }
    if (isDone !== undefined) {
      updates.push('is_done = ?'); args.push(isDone ? 1 : 0);
      updates.push('completed_at = ?'); args.push(isDone ? new Date().toISOString() : null);
      updates.push('completed_by = ?'); args.push(isDone ? (userName || null) : null);
    }
    if (updates.length === 0) return res.status(400).json({ error: 'Güncellenecek alan yok.' });
    args.push(stageId);
    await db.execute({ sql: `UPDATE project_stages SET ${updates.join(', ')} WHERE id = ?`, args });

    if (isDone !== undefined) {
      const allRowsRes = await db.execute({ sql: `SELECT id, parent_id, is_done FROM project_stages WHERE project_id = ?`, args: [pid] });
      const percentage = computeStagePercentage(allRowsRes.rows);
      const today = todayISO();
      const noteText = `${stage.title} ${isDone ? 'tamamlandı' : 'geri alındı'}${isDone && note && note.trim() ? ' — ' + note.trim() : ''}`;
      await db.execute({
        sql: `INSERT INTO project_progress (project_id, log_date, actual, note, created_at) VALUES (?, ?, ?, ?, ?)`,
        args: [pid, today, Math.round(percentage), noteText, new Date().toISOString()]
      });
    }

    res.json({ message: 'Aşama güncellendi.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/projects/:id/stages/:stageId', async (req, res) => {
  try {
    const { userRole, userId } = req.body;
    const pid = req.params.id;
    const stageId = req.params.stageId;
    const pRes = await db.execute({ sql: `SELECT owner_id FROM projects WHERE id = ?`, args: [pid] });
    if (pRes.rows.length === 0) return res.status(404).json({ error: 'Proje bulunamadı.' });
    if (!canManageProjectStages(userRole, userId, pRes.rows[0])) return res.status(403).json({ error: 'Yetkisiz erişim.' });

    await db.execute({ sql: `DELETE FROM project_stages WHERE parent_id = ? AND project_id = ?`, args: [stageId, pid] });
    await db.execute({ sql: `DELETE FROM project_stages WHERE id = ? AND project_id = ?`, args: [stageId, pid] });
    res.json({ message: 'Aşama silindi.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- ADMIN DASHBOARD ÖZETİ (geciken projeler + aciliyet sıralaması + son toplantılar) ---
// --- KİŞİ DETAY (Ekip Gidişatı → kişi sayfası) ---
app.get('/api/person/:id/detail', async (req, res) => {
  try {
    const uid = req.params.id;
    const uRes = await db.execute({
      sql: `SELECT id, name, email, username, department, role, status, sub_area, phone, leader_sub_type, intern_start_date, intern_end_date, engineer_id FROM users WHERE id = ?`,
      args: [uid]
    });
    if (uRes.rows.length === 0) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    const user = uRes.rows[0];

    // Stajyer ise: sorumlu mühendisin adını çöz
    let supervisorEngineerName = null;
    if (user.role === 'INTERN' && user.engineer_id) {
      const engRes = await db.execute({
        sql: `SELECT name FROM users WHERE id = ?`,
        args: [user.engineer_id]
      });
      if (engRes.rows.length > 0) supervisorEngineerName = engRes.rows[0].name;
    }

    // Mühendis ise: kendisine sorumlu mühendis olarak atanmış stajyerleri getir
    let assignedInterns = [];
    if (user.role === 'ENGINEER') {
      const internsRes = await db.execute({
        sql: `SELECT id, name, status FROM users WHERE engineer_id = ? AND role = 'INTERN' ORDER BY name`,
        args: [uid]
      });
      assignedInterns = internsRes.rows;
    }

    // Kişiye atanmış görevler
    const tRes = await db.execute({
      sql: `SELECT id, title, description, category, end_date, work_days, status, created_by
            FROM tasks WHERE assigned_to = ? ORDER BY end_date ASC`,
      args: [uid]
    });

    // Kişinin sorumlu olduğu projeler + son ilerleme
    const pRes = await db.execute({
      sql: `SELECT projects.*, companies.name AS company_name
            FROM projects
            LEFT JOIN companies ON projects.company_id = companies.id
            WHERE projects.owner_id = ?
            ORDER BY projects.end_date ASC`,
      args: [uid]
    });
    const today = todayISO();
    const projects = [];
    for (const p of pRes.rows) {
      const prog = await db.execute({
        sql: `SELECT actual FROM project_progress WHERE project_id = ? ORDER BY log_date DESC LIMIT 1`,
        args: [p.id]
      });
      const last = prog.rows[0];
      const actual = last ? Number(last.actual) : 0;
      const daysLeft = daysBetween(today, p.end_date);
      projects.push({
        id: p.id, name: p.name, company_name: p.company_name, department: p.department,
        end_date: p.end_date, priority: p.priority, status: p.status, note: p.note,
        actual, days_left: daysLeft
      });
    }

    // Son günlük loglar (varsa)
    let logs = [];
    try {
      const lRes = await db.execute({
        sql: `SELECT daily_logs.log_date, daily_logs.note, tasks.title AS task_title
              FROM daily_logs LEFT JOIN tasks ON daily_logs.task_id = tasks.id
              WHERE daily_logs.intern_id = ? ORDER BY daily_logs.log_date DESC LIMIT 20`,
        args: [uid]
      });
      logs = lRes.rows;
    } catch (e) {}

    res.json({ user, tasks: tRes.rows, projects, logs, supervisorEngineerName, assignedInterns });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- KİŞİ DETAY SONU ---

app.get('/api/admin/dashboard', async (req, res) => {
  try {
    const { userRole, department } = req.query;
    // Admin tüm birimleri görür; Müdür/Ekip Lideri yalnızca kendi biriminin projelerini görebilir.
    const isMgr = isDeptLockedRole(userRole);
    if (!isAdmin(userRole) && !isMgr) return res.status(403).json({ error: 'Yetkisiz erişim.' });
    if (isMgr && !department) return res.status(400).json({ error: 'Birim gerekli.' });
    const today = todayISO();

    // Tüm projeler (Müdür ise sadece kendi birimi) + son ilerleme
    let projSql = `SELECT projects.*, companies.name AS company_name, users.name AS owner_name
            FROM projects
            LEFT JOIN companies ON projects.company_id = companies.id
            LEFT JOIN users ON projects.owner_id = users.id`;
    const projArgs = [];
    if (isMgr) { projSql += ` WHERE projects.department = ?`; projArgs.push(department); }
    const projRes = await db.execute({ sql: projSql, args: projArgs });

    const all = [];
    for (const p of projRes.rows) {
      const prog = await db.execute({
        sql: `SELECT actual FROM project_progress WHERE project_id = ? ORDER BY log_date DESC LIMIT 1`,
        args: [p.id]
      });
      const last = prog.rows[0];
      const actual = last ? Number(last.actual) : 0;
      const daysLeft = daysBetween(today, p.end_date);
      const overdue = (p.status !== 'COMPLETED') && daysLeft < 0;
      // Aciliyet skoru: son teslim tarihine az gün kalması ve öncelik artırır
      const urgency = (daysLeft < 0 ? 60 : Math.max(0, 30 - daysLeft * 2)) +
        (p.priority === 'YÜKSEK' || p.priority === 'HIGH' ? 20 : (p.priority === 'DÜŞÜK' || p.priority === 'LOW' ? -10 : 0));
      all.push({
        id: p.id, name: p.name, company_id: p.company_id, company_name: p.company_name, department: p.department,
        owner_name: p.owner_name, end_date: p.end_date, priority: p.priority, status: p.status,
        note: p.note, actual, days_left: daysLeft, is_overdue: overdue,
        urgency: Math.round(urgency)
      });
    }

    const overdue = all.filter(p => p.is_overdue)
      .sort((a, b) => a.days_left - b.days_left);
    const byUrgency = all.filter(p => p.status !== 'COMPLETED')
      .sort((a, b) => b.urgency - a.urgency);

    // Yaklaşan toplantılar ve onay bekleyen kayıtlar: yalnızca Admin'e özel bilgilendirme
    // panelleri (Müdür bu paneli kullanmıyor, gereksiz sorgudan kaçınılır).
    let upcomingMeetings = [];
    let recentUsers = [];
    if (isAdmin(userRole)) {
      // Yaklaşan toplantılar: tercih edilen tarihi bugün veya sonrası olanlar (reddedilmemiş), en yakın önce
      const meetRes = await db.execute({
        sql: `SELECT meeting_requests.*, users.name AS requester_name
              FROM meeting_requests
              LEFT JOIN users ON meeting_requests.requested_by = users.id
              ORDER BY created_at DESC LIMIT 100`,
        args: []
      });
      upcomingMeetings = meetRes.rows
        .filter(m => {
          if (m.status === 'REJECTED') return false;
          const raw = m.preferred_date || m.created_at;
          if (!raw) return false;
          const d = raw.substring(0, 10);
          // Bugün veya gelecekte olanlar
          return daysBetween(d, today) <= 0; // today - d <= 0 => d bugün ya da ileride
        })
        .sort((a, b) => {
          const da = (a.preferred_date || a.created_at || '').substring(0, 10);
          const db2 = (b.preferred_date || b.created_at || '').substring(0, 10);
          return da.localeCompare(db2); // en yakın tarih önce
        });

      // Onay bekleyen (yeni kayıt olan) kullanıcılar — bilgilendirme paneli
      try {
        const uRes = await db.execute({ sql: `SELECT id, name, email, role, department, status FROM users`, args: [] });
        recentUsers = uRes.rows.filter(u => u.status === 'PENDING');
      } catch (e) {}
    }

    res.json({
      overdueProjects: overdue,
      urgencyRanking: byUrgency,
      recentMeetings: upcomingMeetings,
      pendingUsers: recentUsers,
      totalProjects: all.length,
      activeProjects: all.filter(p => p.status !== 'COMPLETED').length
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sunucuyu Çalıştır
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Sunucu aktif! Port: ${PORT}`);
});