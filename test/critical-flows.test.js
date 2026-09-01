// Kritik akışlar için küçük bir entegrasyon testi seti: Giriş, Görev Atama ve Proje Aşaması
// Tamamlanması. Node'un yerleşik test çalıştırıcısını kullanır (harici bağımlılık gerekmez).
//
// ÇALIŞTIRMADAN ÖNCE: sunucu ayrı bir terminalde açık olmalı, ör:
//   set -a && source intern-tasks-site.env && set +a && node server.js
//
// Çalıştırma:
//   npm test
// veya doğrudan:
//   node --test test/critical-flows.test.js
//
// Testler gerçek (Turso) veritabanına yazar — bu yüzden oluşturdukları her şeyi (kullanıcı,
// proje, görev) sonunda kendileri siler. Bir test ortasında çökerse elde "TEST_" önekli
// kayıtlar kalabilir; bu durumda elle silinebilir.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:5000';

async function api(method, path, body, extraHeaders) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* boş gövde olabilir */ }
  return { status: res.status, ok: res.ok, data };
}

before(async () => {
  try {
    await fetch(BASE_URL);
  } catch (e) {
    throw new Error(
      `Test sunucusu (${BASE_URL}) çalışmıyor görünüyor — önce "node server.js" ile başlatın. (${e.message})`
    );
  }
});

test('Giriş: doğru bilgilerle başarılı, yanlış şifre/kullanıcı adıyla reddedilir', async (t) => {
  const suffix = Date.now();
  const username = `test_login_${suffix}`;
  const password = 'TestSifre!2026';

  const created = await api('POST', '/api/admin/users', {
    name: 'Test Otomasyon Kullanıcısı',
    username,
    password,
    role: 'ENGINEER',
    department: 'ELEKTRONIK',
    adminRole: 'ADMIN'
  });
  assert.equal(created.status, 200, `test kullanıcısı oluşturulamadı: ${JSON.stringify(created.data)}`);

  t.after(async () => {
    const list = await api('GET', '/api/users');
    const u = (list.data || []).find(x => x.username === username);
    if (u) await api('DELETE', `/api/admin/users/${u.id}`, { adminRole: 'ADMIN' });
  });

  await t.test('doğru kullanıcı adı/şifre → 200 ve kullanıcı bilgisi', async () => {
    const res = await api('POST', '/api/login', { username, password });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.username, username);
    assert.equal(res.data.role, 'ENGINEER');
    assert.equal(res.data.status, 'APPROVED');
    assert.ok(res.data.id, 'kullanıcı id dönmeli');
  });

  await t.test('yanlış şifre → başarısız', async () => {
    const res = await api('POST', '/api/login', { username, password: 'yanlisSifre123' });
    assert.notEqual(res.status, 200);
  });

  await t.test('var olmayan kullanıcı adı → başarısız', async () => {
    const res = await api('POST', '/api/login', { username: `yok_${suffix}`, password });
    assert.notEqual(res.status, 200);
  });
});

test('Görev Atama + Proje Aşaması Tamamlanması: bir aşamaya atanan görev tamamlanınca aşama otomatik tamamlanır', async (t) => {
  const suffix = Date.now();
  const username = `test_task_${suffix}`;
  const password = 'TestSifre!2026';
  let assigneeId;
  let projectId;
  let taskId;

  t.after(async () => {
    // /api/tasks/:id DELETE, rolü body yerine "user-role" header'ından okur.
    if (taskId) await api('DELETE', `/api/tasks/${taskId}`, undefined, { 'user-role': 'ADMIN' }).catch(() => {});
    if (projectId) await api('DELETE', `/api/projects/${projectId}`, { userRole: 'ADMIN', userId: 1 }).catch(() => {});
    if (assigneeId) await api('DELETE', `/api/admin/users/${assigneeId}`, { adminRole: 'ADMIN' }).catch(() => {});
  });

  await t.test('hazırlık: test kullanıcısı ve ASELSAN şablonlu test projesi oluştur', async () => {
    const createdUser = await api('POST', '/api/admin/users', {
      name: 'Test Görev Kullanıcısı', username, password,
      role: 'ENGINEER', department: 'ELEKTRONIK', adminRole: 'ADMIN'
    });
    assert.equal(createdUser.status, 200, JSON.stringify(createdUser.data));
    const loggedIn = await api('POST', '/api/login', { username, password });
    assert.equal(loggedIn.status, 200);
    assigneeId = loggedIn.data.id;

    const companies = await api('GET', '/api/companies');
    const aselsan = (companies.data || []).find(c => (c.name || '').trim().toUpperCase() === 'ASELSAN');
    assert.ok(aselsan, 'ASELSAN firması bulunamadı (şablon testi için gerekli)');

    const startDate = new Date().toISOString().slice(0, 10);
    const endDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const createdProject = await api('POST', '/api/projects', {
      company_id: aselsan.id, name: `TEST_CRITICAL_FLOW_${suffix}`, department: 'ELEKTRONIK',
      start_date: startDate, end_date: endDate, userRole: 'ADMIN', userId: 1, createdBy: 'Test Otomasyon'
    });
    assert.equal(createdProject.status, 200, JSON.stringify(createdProject.data));
    projectId = createdProject.data.id;
  });

  let stageId;
  await t.test('projenin aşama checklist\'i (ASELSAN şablonu) otomatik uygulanmış olmalı', async () => {
    const stages = await api('GET', `/api/projects/${projectId}/stages`);
    assert.equal(stages.status, 200);
    const mainWithSub = (stages.data.stages || []).find(m => m.subItems && m.subItems.length > 0);
    assert.ok(mainWithSub, 'alt aşaması olan bir ana aşama bulunamadı');
    stageId = mainWithSub.subItems[0].id;
    assert.ok(stageId, 'alt aşama id bulunamadı');
  });

  await t.test('aşamaya doğrudan bir görev atanabilir', async () => {
    const created = await api('POST', '/api/tasks', {
      title: 'Test Görevi', description: 'Otomatik test görevi',
      assignedTo: assigneeId, category: 'Donanım', endDate: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
      workDays: 3, projectId, stageId, createdBy: 'Test Otomasyon', userRole: 'ADMIN', userId: 1,
      batchId: `test-batch-${suffix}`
    });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    taskId = created.data.id;
  });

  await t.test('görev tamamlanınca bağlı proje aşaması otomatik tamamlanır', async () => {
    const completed = await api('PUT', `/api/tasks/${taskId}/complete`);
    assert.equal(completed.status, 200, JSON.stringify(completed.data));

    const stages = await api('GET', `/api/projects/${projectId}/stages`);
    const mainWithSub = (stages.data.stages || []).find(m => m.subItems && m.subItems.some(s => s.id === stageId));
    const sub = mainWithSub.subItems.find(s => s.id === stageId);
    assert.equal(sub.isDone, true, 'aşama otomatik tamamlanmadı');
    assert.equal(sub.completedBy, 'Test Görev Kullanıcısı', 'tamamlayan kişi adı eşleşmiyor');
    assert.ok(stages.data.percentage > 0, 'proje ilerleme yüzdesi güncellenmedi');
  });
});
