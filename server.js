const express = require('express');
const { createClient } = require('@libsql/client');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const gcal = require('./googleCalendar');
const ai = require('./ai');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
// Varsayılan 100kb sınırı, base64'e çevrilmiş görev belgesi yüklemeleri (10MB'a kadar dosya,
// base64 sonrası ~13-14MB JSON gövdesi) için yetersiz kalıyordu — 15mb'a çıkarıldı.
app.use(express.json({ limit: '15mb' }));
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
}

// Sunucu kalkarken veya DB başlatılırken çağırın
initDbMigration();

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
      engineer_id: user.engineer_id
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
    const { title, description, assignedTo, category, endDate, workDays, createdBy, userRole, userId } = req.body;

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
      sql: `INSERT INTO tasks (title, description, assigned_to, category, end_date, work_days, created_by, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'IN_PROGRESS')`,
      args: [title, description || '', assignedTo, category, endDate, workDays, createdBy]
    });

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

    const newTaskId = Number(result.lastInsertRowid);

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

// Admin Yetki Kontrolü Fonksiyonu (İK, admin ile birebir aynı yetkilere sahiptir)
const isAdmin = (role) => role === 'ADMIN' || role === 'HR';
// Firma/Proje yönetiminde kendi biriminle sınırlı erişimi olan roller (Müdür, Ekip Lideri)
const isDeptLockedRole = (role) => role === 'MANAGER' || role === 'LEADER';

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
    const { userId, role, department } = req.query;

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

    // ADMIN tüm görevleri görebilir; INTERN sadece kendisine atananları görür;
    // diğer roller (Müdür, Ekip Lideri, Mühendis, Teknisyen) sadece kendi biriminin görevlerini görür.
    if (role === 'INTERN') {
      conditions.push(`tasks.assigned_to = ?`);
      args.push(userId);
    } else if (!isAdmin(role) && department) {
      conditions.push(`users.department = ?`);
      args.push(department);
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
        owner: p.owner_name || '-', planned: latest ? latest.planned : 0, actual: latest ? latest.actual : 0,
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

// Stajyer Silme
app.delete('/api/users/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    const userRole = (req.headers['user-role'] || '').toUpperCase();

    if (!['ADMIN', 'HR', 'MANAGER', 'LEADER', 'ENGINEER'].includes(userRole)) {
      return res.status(403).json({ error: 'Bu işlemi yapmaya yetkiniz yok!' });
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
    const { title, description, assignedTo, category, endDate, workDays, userRole } = req.body;

    if (!['ADMIN', 'HR', 'MANAGER', 'LEADER', 'ENGINEER'].includes(userRole)) {
      return res.status(403).json({ error: 'Bu işlemi yapmaya yetkiniz yok!' });
    }

    const result = await db.execute({
      sql: `UPDATE tasks SET title = ?, description = ?, assigned_to = ?, category = ?, end_date = ?, work_days = ? WHERE id = ?`,
      args: [title, description || '', assignedTo, category, endDate, workDays, taskId]
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
    const { name, email, role, startDate, endDate } = req.body;
    const userRole = (req.headers['user-role'] || '').toUpperCase();

    if (!['ADMIN', 'HR', 'MANAGER', 'LEADER', 'ENGINEER'].includes(userRole)) {
      return res.status(403).json({ error: 'Bu işlemi yapmaya yetkiniz yok!' });
    }

    if (!name || !email || !role) {
      return res.status(400).json({ error: 'Ad, e-posta ve rol alanları zorunludur.' });
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

// Reddedilen bir toplantı talebini kalıcı olarak siler (Admin/İK, Reddedilen Talepler listesinden)
app.delete('/api/meetings/:id', async (req, res) => {
  try {
    const meetingId = req.params.id;
    const { userRole } = req.body;

    if (!isAdmin(userRole)) {
      return res.status(403).json({ error: 'Bu işlemi yapmaya yetkiniz yok!' });
    }

    const result = await db.execute({
      sql: `DELETE FROM meeting_requests WHERE id = ? AND status = 'REJECTED'`,
      args: [meetingId]
    });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: 'Talep bulunamadı veya yalnızca reddedilen talepler silinebilir.' });
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
        sql: `SELECT planned, actual, log_date FROM project_progress WHERE project_id = ? ORDER BY log_date ASC`,
        args: [p.id]
      });
      const rows = prog.rows;
      const last = rows.length ? rows[rows.length - 1] : null;
      const actual = last ? Number(last.actual) : 0;
      const planned = last ? Number(last.planned) : 0;
      const daysLeft = daysBetween(today, p.end_date);
      const isOverdue = (p.status !== 'COMPLETED') && (daysLeft < 0 || (daysLeft <= 3 && actual < 90 && actual < planned - 5));
      enriched.push({
        ...p,
        actual, planned,
        days_left: daysLeft,
        is_overdue: isOverdue,
        behind: actual < planned - 5
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
      sql: `SELECT id, log_date, planned, actual, note FROM project_progress WHERE project_id = ? ORDER BY log_date ASC`,
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

    res.json({ message: 'Proje oluşturuldu.', id: newProjectId });
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
    const { log_date, planned, actual, note, userRole, userId } = req.body;
    const pid = req.params.id;
    const cur = await db.execute({ sql: `SELECT owner_id, name FROM projects WHERE id = ?`, args: [pid] });
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Proje bulunamadı.' });
    const project = cur.rows[0];
    const isOwner = userId && Number(project.owner_id) === Number(userId);
    if (!isAdmin(userRole) && !isOwner) return res.status(403).json({ error: 'Yetkisiz erişim.' });
    if (!log_date) return res.status(400).json({ error: 'Tarih gerekli.' });
    await db.execute({
      sql: `INSERT INTO project_progress (project_id, log_date, planned, actual, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [pid, log_date, Number(planned) || 0, Number(actual) || 0, note || null, todayISO()]
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
        sql: `SELECT planned, actual FROM project_progress WHERE project_id = ? ORDER BY log_date DESC LIMIT 1`,
        args: [p.id]
      });
      const last = prog.rows[0];
      const actual = last ? Number(last.actual) : 0;
      const planned = last ? Number(last.planned) : 0;
      const daysLeft = daysBetween(today, p.end_date);
      projects.push({
        id: p.id, name: p.name, company_name: p.company_name, department: p.department,
        end_date: p.end_date, priority: p.priority, status: p.status, note: p.note,
        actual, planned, days_left: daysLeft, behind: actual < planned - 5
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
        sql: `SELECT planned, actual FROM project_progress WHERE project_id = ? ORDER BY log_date DESC LIMIT 1`,
        args: [p.id]
      });
      const last = prog.rows[0];
      const actual = last ? Number(last.actual) : 0;
      const planned = last ? Number(last.planned) : 0;
      const daysLeft = daysBetween(today, p.end_date);
      const behind = actual < planned - 5;
      const overdue = (p.status !== 'COMPLETED') && (daysLeft < 0 || (daysLeft <= 3 && actual < 90 && behind));
      // Aciliyet skoru: az gün kalması + geri kalması artırır
      const urgency = (behind ? 40 : 0) + (daysLeft < 0 ? 60 : Math.max(0, 30 - daysLeft * 2)) +
        (p.priority === 'YÜKSEK' || p.priority === 'HIGH' ? 20 : (p.priority === 'DÜŞÜK' || p.priority === 'LOW' ? -10 : 0));
      all.push({
        id: p.id, name: p.name, company_name: p.company_name, department: p.department,
        owner_name: p.owner_name, end_date: p.end_date, priority: p.priority, status: p.status,
        note: p.note, actual, planned, days_left: daysLeft, behind, is_overdue: overdue,
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