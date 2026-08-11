// ============================================================
// AUTH GÜVENLİK TESTİ  —  kullanım:  node test-auth.js
// Önce başka bir terminalde sunucu çalışıyor olmalı:  node server.js
// (Node 18+ gereklidir; global fetch kullanır. Ekstra paket gerekmez.)
// ============================================================
const BASE = process.env.BASE_URL || 'http://localhost:5000';
const rnd = Date.now().toString().slice(-6);

let gecen = 0, kalan = 0;
function sonuc(ad, basarili, detay = '') {
  if (basarili) { gecen++; console.log(`  ✅ ${ad}`); }
  else { kalan++; console.log(`  ❌ ${ad}  ${detay}`); }
}

async function jpost(yol, govde, token) {
  const r = await fetch(BASE + yol, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    },
    body: JSON.stringify(govde)
  });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
}
async function jget(yol, token) {
  const r = await fetch(BASE + yol, {
    headers: token ? { Authorization: 'Bearer ' + token } : {}
  });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
}
async function jdelete(yol, govde, token) {
  const r = await fetch(BASE + yol, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    },
    body: JSON.stringify(govde)
  });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

(async () => {
  console.log(`\n🔎 Test hedefi: ${BASE}\n`);

  // Sunucu ayakta mı?
  try { await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); }
  catch (e) { console.log('❌ Sunucuya ulaşılamadı. Önce "node server.js" ile başlat.\n'); process.exit(1); }

  // --- Kullanıcılar oluştur (ADMIN ve TECHNICIAN otomatik onaylanır) ---
  const admin = { name: 'Test Admin', username: 'admin_' + rnd, password: 'sifre123', email: `admin${rnd}@test.local`, phone: '5550000000', role: 'ADMIN' };
  const tekni = { name: 'Test Teknisyen', username: 'tek_' + rnd, password: 'sifre123', email: `tek${rnd}@test.local`, phone: '5551111111', role: 'TECHNICIAN' };

  console.log('1) Kayıt (register):');
  const rAdmin = await jpost('/api/register', admin);
  sonuc('Admin kaydı oluştu', rAdmin.status === 200, JSON.stringify(rAdmin.data));
  const rTek = await jpost('/api/register', tekni);
  sonuc('Teknisyen kaydı oluştu', rTek.status === 200, JSON.stringify(rTek.data));

  console.log('\n2) Giriş (login) ve token:');
  const lAdmin = await jpost('/api/login', { username: admin.username, password: admin.password });
  const adminToken = lAdmin.data && lAdmin.data.token;
  sonuc('Admin girişi token döndürdü', !!adminToken, adminToken ? '' : JSON.stringify(lAdmin.data));
  const lTek = await jpost('/api/login', { username: tekni.username, password: tekni.password });
  const tekToken = lTek.data && lTek.data.token;
  sonuc('Teknisyen girişi token döndürdü', !!tekToken);

  console.log('\n3) Korumalı endpoint token OLMADAN reddediliyor mu?');
  const noTok = await jget('/api/tasks');
  sonuc('Tokensiz /api/tasks → 401', noTok.status === 401, `(gelen: ${noTok.status})`);

  console.log('\n4) Geçerli token ile erişim çalışıyor mu?');
  const withTok = await jget('/api/tasks', adminToken);
  sonuc('Admin token ile /api/tasks → 200', withTok.status === 200, `(gelen: ${withTok.status})`);

  console.log('\n5) YETKİ YÜKSELTME denemesi engelleniyor mu? (asıl güvenlik testi)');
  // Teknisyen, gövdeye adminRole:"ADMIN" yazıp admin işlemi (kullanıcı silme) deniyor.
  const spoof = await jdelete('/api/admin/users/999999', { adminRole: 'ADMIN' }, tekToken);
  sonuc('Sahte adminRole ile silme → 403 (reddedildi)', spoof.status === 403, `(gelen: ${spoof.status})`);

  console.log('\n6) Şifre sıfırlama artık kod doğruluyor mu? (kritik açık testi)');
  // Eski saldırı: kodsuz sıfırlama denemesi → reddedilmeli
  const resetNoCode = await jpost('/api/reset-password', { email: admin.email, newPassword: 'yeniSifre123' });
  sonuc('Kodsuz şifre sıfırlama → reddedildi', resetNoCode.status === 400, `(gelen: ${resetNoCode.status})`);
  // Kod iste (dev modda sunucu konsoluna yazılır), sonra YANLIŞ kod ile dene → reddedilmeli
  const kodIste = await jpost('/api/send-verification-code', { email: admin.email });
  sonuc('Doğrulama kodu istendi', kodIste.status === 200, `(gelen: ${kodIste.status})`);
  const resetWrong = await jpost('/api/reset-password', { email: admin.email, code: '000000', newPassword: 'yeniSifre123' });
  sonuc('Yanlış kod ile sıfırlama → reddedildi', resetWrong.status === 400, `(gelen: ${resetWrong.status})`);

  console.log('\n7) (Opsiyonel) Ollama asistanı yanıt veriyor mu?');
  const chat = await jpost('/api/chatbot', { message: 'Merhaba, kaç görevim var?' }, adminToken);
  if (chat.status === 200 && chat.data && chat.data.reply) {
    sonuc('Chatbot yanıt verdi', true);
    console.log('     ↳ Yanıt:', String(chat.data.reply).slice(0, 80).replace(/\n/g, ' ') + '...');
  } else {
    console.log('  ⚠️  Chatbot yanıt vermedi (status ' + chat.status + '). Ollama çalışıyor ve "qwen2.5" modeli yüklü mü?');
  }

  console.log(`\n────────────────────────────\nSONUÇ: ${gecen} geçti, ${kalan} kaldı\n`);
  process.exit(kalan ? 1 : 0);
})();