'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hugecatalog-single-'));
process.env.ADMIN_PASSWORD = 'admin-test-pass';

const { q, UPLOAD_DIR } = require('../src/db');
const { ensureBootstrap } = require('../src/bootstrap');
const W = require('../src/services/works');
const { importWorks } = require('../src/services/import');
const { createApp } = require('../src/app');

ensureBootstrap();
const genre = q('SELECT id FROM genres LIMIT 1').get().id;

function makeWork(title, { single = false, chapters = [] } = {}) {
  const id = W.saveWork({
    title, alt_titles: '', description: '', type: 'manga', status: 'ongoing', language: 'ru', age_rating: '18+', year: 2020,
    story_authors: ['Автор'], artists: [], genres: [genre], tags: [], is_single: single,
  }, { moderation: 'approved' });
  const ids = chapters.map((n) => {
    const ch = Number(q('INSERT INTO chapters (work_id, number, title, volume, pages_count) VALUES (?, ?, ?, 1, 2)').run(id, n, `Глава ${n}`).lastInsertRowid);
    const dir = path.join(UPLOAD_DIR, 'chapters', String(ch));
    fs.mkdirSync(dir, { recursive: true });
    [1, 2].forEach((p) => {
      fs.writeFileSync(path.join(dir, `000${p}.png`), 'x');
      q('INSERT INTO pages (chapter_id, idx, path) VALUES (?, ?, ?)').run(ch, p, `/uploads/chapters/${ch}/000${p}.png`);
    });
    return ch;
  });
  W.refreshLastChapter(id);
  return { id, chapters: ids };
}

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

test('главы → сингл: без подтверждения ничего не удаляется, с подтверждением первая глава становится галереей', async (t) => {
  const server = createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = await session(base, 'admin', 'admin-test-pass');
  const w = makeWork('Серия', { chapters: [3, 1, 2] });
  const first = w.chapters[1]; // глава с наименьшим номером (1)

  const page = await (await admin.req(`/studio/works/${w.id}/format?to=single`)).text();
  assert.match(page, /Будут удалены безвозвратно \(2 гл\., 4 стр\.\)/, 'страница подтверждения перечисляет удаляемое');

  const noConfirm = await admin.post(`/studio/works/${w.id}/format`, { to: 'single' }, `/studio/works/${w.id}/format?to=single`);
  assert.strictEqual(noConfirm.status, 400);
  assert.strictEqual(q('SELECT COUNT(*) AS n FROM chapters WHERE work_id = ?').get(w.id).n, 3, 'без галочки главы на месте');

  const ok = await admin.post(`/studio/works/${w.id}/format`, { to: 'single', confirm: '1' }, `/studio/works/${w.id}/format?to=single`);
  assert.strictEqual(ok.status, 302);
  const rest = q('SELECT id, number, title, volume FROM chapters WHERE work_id = ?').all(w.id);
  assert.deepStrictEqual(rest.map((c) => ({ ...c })), [{ id: first, number: 1, title: '', volume: null }]);
  assert.strictEqual(W.getWorkById(w.id).is_single, 1);
  w.chapters.filter((c) => c !== first).forEach((c) => {
    assert.ok(!fs.existsSync(path.join(UPLOAD_DIR, 'chapters', String(c))), 'файлы удалённых глав удалены');
  });

  // Страница произведения: «Читать» ведёт в галерею, списка глав нет.
  const slug = W.getWorkById(w.id).slug;
  const html = await (await fetch(`${base}/title/${slug}`)).text();
  assert.match(html, new RegExp(`/title/${slug}/chapter/${first}`));
  assert.doesNotMatch(html, /data-tab="chapters"/);
  // В студии новая глава для сингла недоступна — перенаправление на галерею.
  const add = await admin.req(`/studio/works/${w.id}/chapters/new`);
  assert.strictEqual(add.headers.get('location'), `/studio/chapters/${first}/edit`);

  // Обратно на главы: галерея становится главой 1, ничего не удаляется.
  await admin.post(`/studio/works/${w.id}/format`, { to: 'chapters' }, `/studio/works/${w.id}`);
  assert.strictEqual(W.getWorkById(w.id).is_single, 0);
  assert.strictEqual(q('SELECT COUNT(*) AS n FROM chapters WHERE work_id = ?').get(w.id).n, 1);

  // Каталог фильтрует по формату.
  const single = makeWork('Ваншот', { single: true, chapters: [1] });
  const onlySingles = await (await fetch(`${base}/catalog?format=single`)).text();
  assert.match(onlySingles, /Ваншот/);
  assert.doesNotMatch(onlySingles, />Серия</);
  assert.ok(single.id);
});

test('смена формата доступна только администратору', async (t) => {
  const server = createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { hashPassword } = require('../src/auth');
  q(`INSERT INTO users (username, email, password_hash, role) VALUES ('mod2', 'mod2@t.io', ?, 'moderator')`).run(hashPassword('moder-pass-2'));
  const w = makeWork('Защищённое', { chapters: [1, 2] });
  const moder = await session(base, 'mod2', 'moder-pass-2');
  const res = await moder.req(`/studio/works/${w.id}/format?to=single`);
  assert.strictEqual(res.status, 403);
});

test('импорт сингла: без глав; если серия уже идёт по главам — добавляется главой', async () => {
  const r1 = await importWorks({ title: 'Один выпуск', series: 'One Shot X', format: 'single', chapter: { number: 1 }, language: 'ru', type: 'doujinshi', authors: ['A'], genres: [q('SELECT name FROM genres LIMIT 1').get().name] }, { skipCovers: true });
  assert.strictEqual(r1[0].status, 'created');
  const w1 = W.getWorkBySlug(r1[0].slug);
  assert.strictEqual(w1.is_single, 1);
  assert.strictEqual(q('SELECT COUNT(*) AS n FROM chapters WHERE work_id = ?').get(w1.id).n, 0, 'у сингла нет глав');

  const g = q('SELECT name FROM genres LIMIT 1').get().name;
  await importWorks({ title: 'Серия X', series: 'Series X', chapter: { number: 2 }, language: 'ru', type: 'manga', authors: ['A'], genres: [g] }, { skipCovers: true });
  const r2 = await importWorks({ title: 'Series X', series: 'Series X', format: 'single', chapter: { number: 1, title: 'Sub' }, language: 'en', type: 'manga', authors: ['A'], genres: [g] }, { skipCovers: true });
  const w2 = W.getWorkBySlug(r2[0].slug);
  assert.strictEqual(w2.is_single, 0, 'серия по главам — запись стала главой');
  assert.ok(r2[0].messages.some((m) => /добавлено как глава/.test(m)));
  assert.strictEqual(q('SELECT title FROM chapters WHERE work_id = ?').get(w2.id).title, 'Sub');
});
