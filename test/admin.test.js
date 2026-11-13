'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hugecatalog-admin-'));
process.env.ADMIN_PASSWORD = 'admin-test-pass';

const { q, UPLOAD_DIR } = require('../src/db');
const { ensureBootstrap } = require('../src/bootstrap');
const { hashPassword } = require('../src/auth');
const W = require('../src/services/works');
const { createApp } = require('../src/app');

ensureBootstrap();
q(`INSERT INTO users (username, email, password_hash, role) VALUES ('moder', 'm@t.io', ?, 'moderator')`).run(hashPassword('moder-pass-1'));

function makeWork(title) {
  fs.mkdirSync(path.join(UPLOAD_DIR, 'covers'), { recursive: true });
  const coverFile = `${title}.png`;
  fs.writeFileSync(path.join(UPLOAD_DIR, 'covers', coverFile), 'x');
  const id = W.saveWork({
    title, alt_titles: '', description: '', type: 'manga', status: 'ongoing', language: 'ru', age_rating: '18+', year: 2020,
    story_authors: [`Автор ${title}`], artists: [], genres: [q('SELECT id FROM genres LIMIT 1').get().id], tags: [],
  }, { moderation: 'approved', cover: `/uploads/covers/${coverFile}` });
  const ch = Number(q('INSERT INTO chapters (work_id, number, pages_count) VALUES (?, 1, 1)').run(id).lastInsertRowid);
  fs.mkdirSync(path.join(UPLOAD_DIR, 'chapters', String(ch)), { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, 'chapters', String(ch), '0001.png'), 'x');
  q('INSERT INTO pages (chapter_id, idx, path) VALUES (?, 1, ?)').run(ch, `/uploads/chapters/${ch}/0001.png`);
  return { id, ch, cover: path.join(UPLOAD_DIR, 'covers', coverFile) };
}

/** Мини-клиент с cookie и CSRF-токеном. */
async function session(base, login, password) {
  let cookie = '';
  const req = async (url, opts = {}) => {
    const res = await fetch(base + url, { redirect: 'manual', ...opts, headers: { ...(opts.headers || {}), Cookie: cookie } });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return res;
  };
  const csrf = async (url) => (await (await req(url)).text()).match(/name="csrf-token" content="([^"]+)"/)[1];
  const post = async (url, form, from) => req(url, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...form, _csrf: await csrf(from) }).toString(),
  });
  await post('/login', { login, password }, '/login');
  return { req, post };
}

test('причина «admin»: полное удаление у администратора, обычный отказ у модератора', async (t) => {
  const server = createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const a = makeWork('Удаляемое');
  const admin = await session(base, 'admin', 'admin-test-pass');
  const res = await admin.post(`/admin/works/${a.id}/reject`, { reason: ' Admin ', status: 'approved' }, '/admin/works?status=approved');
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get('location'), '/admin/works?status=approved');
  assert.strictEqual(q('SELECT COUNT(*) AS n FROM works WHERE id = ?').get(a.id).n, 0, 'произведение удалено');
  assert.strictEqual(q('SELECT COUNT(*) AS n FROM chapters WHERE id = ?').get(a.ch).n, 0, 'главы удалены');
  assert.strictEqual(q('SELECT COUNT(*) AS n FROM pages WHERE chapter_id = ?').get(a.ch).n, 0, 'страницы удалены');
  assert.ok(!fs.existsSync(a.cover), 'файл обложки удалён');
  assert.ok(!fs.existsSync(path.join(UPLOAD_DIR, 'chapters', String(a.ch))), 'папка страниц удалена');
  assert.ok(!q(`SELECT 1 FROM authors WHERE name = 'Автор Удаляемое'`).get(), 'осиротевший автор удалён');
  assert.ok(q(`SELECT 1 FROM moderation_log WHERE action = 'delete_work'`).get(), 'удаление в журнале');

  const b = makeWork('Остаётся');
  const moder = await session(base, 'moder', 'moder-pass-1');
  await moder.post(`/admin/works/${b.id}/reject`, { reason: 'admin' }, '/admin/works?status=approved');
  const row = q('SELECT moderation, reject_reason FROM works WHERE id = ?').get(b.id);
  assert.deepStrictEqual({ ...row }, { moderation: 'rejected', reject_reason: 'admin' }, 'у модератора — обычное снятие с публикации');
});

test('английские названия жанров и тегов из админки применяются сразу', async (t) => {
  const server = createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = await session(base, 'admin', 'admin-test-pass');
  const enCatalog = async () => (await (await fetch(`${base}/catalog`, { headers: { Cookie: 'lang=en' } })).text());

  // Перевод по умолчанию перенесён из словаря в базу.
  assert.strictEqual(q(`SELECT name_en FROM genres WHERE name = 'Боевик'`).get().name_en, 'Action');

  await admin.post('/admin/genres', { name: 'Космоопера', name_en: 'Space opera' }, '/admin/taxonomy');
  assert.match(await enCatalog(), /Space opera/, 'новый жанр сразу переведён');

  const id = q(`SELECT id FROM genres WHERE name = 'Космоопера'`).get().id;
  await admin.post(`/admin/genres/${id}`, { name: 'Космическая опера', name_en: 'Space Opera' }, '/admin/taxonomy');
  const html = await enCatalog();
  assert.match(html, /Space Opera/, 'перевод сохранился после переименования');
  assert.doesNotMatch(html, /Космическая опера/);

  await admin.post('/admin/tags', { name: 'Без перевода', tag_group: 'Прочее' }, '/admin/taxonomy');
  const page = await (await admin.req('/admin/taxonomy')).text();
  assert.match(page, /без перевода: 1/, 'счётчик записей без перевода');
});

test('удаление произведения стирает всю папку works/<slug> и файлы страниц, где бы они ни лежали', () => {
  const a = makeWork('Папочное');
  const slug = W.getWorkById(a.id).slug;
  const folder = path.join(UPLOAD_DIR, 'works', slug);
  fs.mkdirSync(path.join(folder, 'gallery'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'gallery', '001.jpg'), 'x'); // файл, о котором база не знает
  fs.writeFileSync(path.join(folder, 'gallery', '001.jpg.webp'), 'x');
  // страница главы, лежащая вне uploads/chapters/<id>
  const other = path.join(UPLOAD_DIR, 'elsewhere', 'p1.jpg');
  fs.mkdirSync(path.dirname(other), { recursive: true });
  fs.writeFileSync(other, 'x');
  fs.writeFileSync(`${other}.thumb.webp`, 'x');
  q('INSERT INTO pages (chapter_id, idx, path) VALUES (?, 2, ?)').run(a.ch, '/uploads/elsewhere/p1.jpg');

  W.deleteWork({ id: a.id }); // только id — остальное функция берёт из базы
  assert.ok(!fs.existsSync(folder), 'папка works/<slug> удалена целиком');
  assert.ok(!fs.existsSync(other) && !fs.existsSync(`${other}.thumb.webp`), 'страница вне папки главы удалена вместе с миниатюрой');
  assert.ok(!fs.existsSync(path.dirname(other)), 'опустевшая папка удалена');
  assert.ok(!fs.existsSync(a.cover), 'обложка удалена');
});

test('новое произведение не занимает оставшуюся на диске папку works/<slug>', () => {
  const leftover = path.join(UPLOAD_DIR, 'works', 'sirota');
  fs.mkdirSync(path.join(leftover, 'gallery'), { recursive: true });
  fs.writeFileSync(path.join(leftover, 'gallery', '001.jpg'), 'x'); // осталось от удалённого произведения
  const a = makeWork('Sirota');
  assert.strictEqual(W.getWorkById(a.id).slug, 'sirota-2', 'slug с занятой папкой пропущен');
  const b = makeWork('Sirota');
  assert.strictEqual(W.getWorkById(b.id).slug, 'sirota-3', 'занятый в базе slug тоже пропущен');
});
