// googleCalendar.js
// Google Takvim OAuth2 (kullanıcı başına) + etkinlik senkronizasyonu.
// A modeli: her kullanıcı kendi Google hesabını bağlar, etkinlikler kendi takvimine yazılır.
//
// Gerekli ortam değişkenleri (.env / Render Environment):
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//   GOOGLE_REDIRECT_URI   (ör. https://intern-tasks-pannel.onrender.com/api/google/callback)
//   APP_BASE_URL          (ör. https://intern-tasks-pannel.onrender.com)  [opsiyonel, yönlendirme için]

const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

// Tek bir OAuth2 client "fabrikası". Her istekte taze client üretmek,
// aynı nesnede farklı kullanıcı token'larının karışmasını önler.
function makeOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

// Ortam değişkenleri tanımlı mı? (tanımsızsa senkron sessizce devre dışı kalır)
function isConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REDIRECT_URI
  );
}

// 1) Kullanıcıyı Google izin ekranına göndermek için URL üretir.
//    state: hangi kullanıcının bağlandığını geri callback'te bilmek için user id.
function getAuthUrl(userId) {
  const oauth2 = makeOAuthClient();
  return oauth2.generateAuthUrl({
    access_type: 'offline',        // refresh_token almak için şart
    prompt: 'consent',             // her seferinde refresh_token gelsin (yeniden bağlamada)
    scope: SCOPES,
    state: String(userId)
  });
}

// 2) Callback'te gelen "code"u refresh_token'a çevirir.
async function exchangeCodeForTokens(code) {
  const oauth2 = makeOAuthClient();
  const { tokens } = await oauth2.getToken(code);
  // tokens.refresh_token: uzun ömürlü (saklayacağımız)
  // tokens.access_token: kısa ömürlü (her işlemde yenileyeceğiz)
  return tokens;
}

// Saklanan refresh_token'dan yetkili bir client kurar.
function clientFromRefreshToken(refreshToken) {
  const oauth2 = makeOAuthClient();
  oauth2.setCredentials({ refresh_token: refreshToken });
  return oauth2;
}

// --- Etkinlik gövdesi oluşturucu ---
// Görev/toplantı verisinden Google Calendar event nesnesi üretir (tüm gün etkinliği).
function buildEventBody({ type, title, description, dateISO, extraLines }) {
  const prefix = type === 'task' ? '[Görev] ' : '[Toplantı] ';
  const start = dateISO; // YYYY-MM-DD
  // Tüm gün etkinliğinde bitiş = ertesi gün (Google kuralı)
  const endDate = new Date(dateISO + 'T00:00:00');
  endDate.setDate(endDate.getDate() + 1);
  const end = endDate.toISOString().substring(0, 10);

  const detailParts = [];
  if (description) detailParts.push(description);
  if (Array.isArray(extraLines)) detailParts.push(...extraLines.filter(Boolean));
  detailParts.push('— Görevlendirme ve Takip Paneli');

  return {
    summary: prefix + (title || ''),
    description: detailParts.join('\n'),
    start: { date: start },
    end: { date: end },
    // Son teslim/toplantı günü sabah hatırlatma
    reminders: {
      useDefault: false,
      overrides: [{ method: 'popup', minutes: 9 * 60 }] // etkinlik gününden ~15 saat önce (bir önceki akşam)
    }
  };
}

// --- CRUD: takvime yaz / güncelle / sil ---
// Hepsi refresh_token ister. Hata durumunda fırlatır; çağıran taraf yutup loglar.

async function createEvent(refreshToken, eventData) {
  const auth = clientFromRefreshToken(refreshToken);
  const calendar = google.calendar({ version: 'v3', auth });
  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: buildEventBody(eventData)
  });
  return res.data.id; // google_event_id
}

async function updateEvent(refreshToken, eventId, eventData) {
  const auth = clientFromRefreshToken(refreshToken);
  const calendar = google.calendar({ version: 'v3', auth });
  const res = await calendar.events.update({
    calendarId: 'primary',
    eventId,
    requestBody: buildEventBody(eventData)
  });
  return res.data.id;
}

async function deleteEvent(refreshToken, eventId) {
  const auth = clientFromRefreshToken(refreshToken);
  const calendar = google.calendar({ version: 'v3', auth });
  try {
    await calendar.events.delete({ calendarId: 'primary', eventId });
  } catch (err) {
    // 410 (zaten silinmiş) veya 404 hatalarını sessizce geç
    const code = err && err.code;
    if (code !== 404 && code !== 410) throw err;
  }
}

module.exports = {
  isConfigured,
  getAuthUrl,
  exchangeCodeForTokens,
  createEvent,
  updateEvent,
  deleteEvent,
  SCOPES
};