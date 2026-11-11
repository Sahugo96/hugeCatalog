'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Отдельная временная база для тестов.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hugecatalog-test-'));
process.env.DATA_DIR = tmp;
process.env.ADMIN_PASSWORD = 'admin-test-pass';

const { q } = require('../src/db');
const { ensureBootstrap } = require('../src/bootstrap');
const W = require('../src/services/works');
const util = require('../src/util');
const { createApp } = require('../src/app');

ensureBootstrap();

const gid = (name) => q('SELECT id FROM genres WHERE name = ?').get(name).id;
const tid = (name) => q('SELECT id FROM tags WHERE name = ?').get(name).id;

function work(title, extra = {}) {
  return W.saveWork({
    title, alt_titles: '', description: extra.description || '', type: extra.type || 'manga', status: 'ongoing',
    language: extra.language || 'ja', age_rating: extra.age || '12+', year: extra.year || 2020,
    story_authors: extra.authors || ['Автор'], artists: extra.artists || [],
    genres: (extra.genres || ['Боевик']).map(gid), tags: (extra.tags || []).map(tid),
  }, { moderation: extra.moderation || 'approved', cover: '/uploads/covers/x.png' });
}

const a = work('Альфа', { genres: ['Боевик', 'Фэнтези'], tags: ['Месть', 'Цветная'], type: 'manhwa', language: 'ko', artists: ['Художник Один'],
  description: 'Мастер меча возвращается в прошлое ради мести предателю клана' });
const b = work('Бета', { genres: ['Боевик', 'Комедия'], tags: ['Месть'], year: 2010, artists: ['Художник Один'],
  description: 'Мастер меча мстит предателю своего клана и возвращается домой' });
const c = work('Гамма', { genres: ['Романтика'], tags: ['Цветная'], type: 'manhwa', language: 'ko', age: '18+',
  description: 'История любви в офисе большого города' });
work('Скрытый', { genres: ['Боевик'], moderation: 'pending' });

test('slugify транслитерирует кириллицу', () => {
  assert.strictEqual(util.slugify('Клинок северного ветра!'), 'klinok-severnogo-vetra');
  assert.ok(!util.slugify('a '.repeat(39) + 'bb cc').endsWith('-'), 'длинный slug без дефиса на конце');
  assert.strictEqual(util.plural(21, 'глава', 'главы', 'глав'), 'глава');
  assert.strictEqual(util.plural(12, 'глава', 'главы', 'глав'), 'глав');
});

test('каталог: включение и исключение жанров', () => {
  const titles = (query) => W.searchCatalog(W.parseFilters(query)).items.map((w) => w.title).sort();
  assert.deepStrictEqual(titles({}), ['Альфа', 'Бета', 'Гамма']);
  assert.deepStrictEqual(titles({ genre: 'boevik' }), ['Альфа', 'Бета']);
  assert.deepStrictEqual(titles({ genre: ['boevik', 'fentezi'] }), ['Альфа']);
  assert.deepStrictEqual(titles({ genre: ['komediya', 'fentezi'], genre_mode: 'any' }), ['Альфа', 'Бета']);
  assert.deepStrictEqual(titles({ genre: 'boevik', genre_ex: 'komediya' }), ['Альфа']);
  assert.deepStrictEqual(titles({ tag_ex: 'tsvetnaya' }), ['Бета']);
  assert.deepStrictEqual(titles({ type: 'manhwa', age_ex: '18+' }), ['Альфа']);
  assert.deepStrictEqual(titles({ lang: 'ja' }), ['Бета']);
  assert.deepStrictEqual(titles({ year_to: '2015' }), ['Бета']);
  assert.deepStrictEqual(titles({ q: 'гам' }), ['Гамма']);
  assert.deepStrictEqual(titles({ author: 'hudozhnik-odin' }), ['Альфа', 'Бета']);
});

test('похожие: по тегам, сюжету и рисовке', () => {
  assert.strictEqual(W.similarByTaxonomy(a)[0].title, 'Бета');
  assert.strictEqual(W.similarByPlot(a)[0].title, 'Бета');
  assert.strictEqual(W.similarByArt(a)[0].title, 'Бета');
  assert.ok(!W.similarByPlot(a).some((w) => w.title === 'Скрытый'));
  assert.ok(W.similarByTaxonomy(c).length >= 1);
});

test('лайк переключается и считается', () => {
  const uid = q(`SELECT id FROM users WHERE role = 'admin'`).get().id;
  assert.deepStrictEqual(W.toggle('likes', uid, a), { active: true, count: 1 });
  assert.deepStrictEqual(W.toggle('likes', uid, a), { active: false, count: 0 });
});

test('HTTP: основные страницы и доступ', async (t) => {
  const server = createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const slug = q('SELECT slug FROM works WHERE id = ?').get(a).slug;
  const hidden = q(`SELECT slug FROM works WHERE title = 'Скрытый'`).get().slug;
  for (const url of ['/', '/catalog', '/catalog?genre=boevik&genre_ex=komediya', `/title/${slug}`, '/about', '/privacy', '/teams', '/login', '/register']) {
    const res = await fetch(base + url);
    assert.strictEqual(res.status, 200, url);
  }
  assert.strictEqual((await fetch(`${base}/title/${hidden}`)).status, 404, 'не одобренный тайтл скрыт');
  assert.strictEqual((await fetch(`${base}/admin`, { redirect: 'manual' })).status, 302, 'админка требует входа');
  const csrf = await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ login: 'admin', password: 'x' }) });
  assert.strictEqual(csrf.status, 403, 'POST без CSRF-токена отклоняется');
  const page = await (await fetch(`${base}/title/${slug}`)).text();
  assert.ok(page.includes('href="/catalog?genre=boevik"'), 'жанр — ссылка на каталог');
  assert.ok(page.includes('href="/catalog?lang=ko"'), 'язык — ссылка на каталог');
  assert.ok(page.includes('href="/catalog?age=12%2B"'), 'возраст — ссылка на каталог');
});

test('языковые версии: связь, запрет дублей языка, отвязка', () => {
  const V = require('../src/services/versions');
  const en = work('Alpha', { language: 'en', genres: ['Боевик', 'Фэнтези'], tags: ['Месть', 'Цветная'], description: 'Мастер меча возвращается ради мести предателю клана' });
  const ko = work('알파', { language: 'ko', genres: ['Боевик'] });
  V.linkWorks(a, en);
  // «Альфа» создана с языком ko, поэтому корейскую версию к ней не добавить.
  assert.deepStrictEqual(V.getVersions(a).map((v) => v.language).sort(), ['en', 'ko']);
  assert.throws(() => V.linkWorks(en, ko), /уже есть/);
  // Другие версии не попадают в «похожие».
  assert.ok(!W.similarByPlot(a).some((w) => w.id === en));
  assert.ok(!W.similarByTaxonomy(a).some((w) => w.id === en));
  assert.ok(W.similarByTaxonomy(a).some((w) => w.id === ko), 'несвязанное произведение остаётся в похожих');
  V.unlinkWork(en);
  assert.strictEqual(V.getVersions(a).length, 0, 'группа из одной версии распускается');
  V.linkWorks(a, en);
});

test('импорт из JSON: создание, связь по group, пропуск дублей', async () => {
  const { importWorks } = require('../src/services/import');
  const V = require('../src/services/versions');
  const items = [
    { title: 'Импорт RU', language: 'Русский', type: 'Манхва', status: 'ongoing', age_rating: '16+', year: 2021,
      authors: ['Импортный Автор'], genres: ['Боевик', 'Несуществующий'], tags: ['Месть'], group: 'g1' },
    { title: 'Import EN', language: 'en', type: 'manhwa', authors: ['Импортный Автор'], genres: ['Боевик'], group: 'g1' },
    { title: 'Битый', language: 'xx', type: 'manga', authors: ['X'], genres: ['Боевик'] },
  ];
  const report = await importWorks(items, { skipCovers: true });
  assert.deepStrictEqual(report.map((r) => r.status), ['created', 'created', 'error']);
  assert.ok(report[0].messages.some((m) => m.includes('Несуществующий')));
  const ru = q(`SELECT id, type, language FROM works WHERE title = 'Импорт RU'`).get();
  assert.strictEqual(ru.type, 'manhwa');
  assert.deepStrictEqual(V.getVersions(ru.id).map((v) => v.language).sort(), ['en', 'ru']);
  const again = await importWorks(items.slice(0, 1), { skipCovers: true });
  assert.strictEqual(again[0].status, 'skipped');
});

test('просмотры: только прочтение главы вошедшим пользователем, один раз на главу', async (t) => {
  const ch = Number(q('INSERT INTO chapters (work_id, number) VALUES (?, 1)').run(b).lastInsertRowid);
  const slug = q('SELECT slug FROM works WHERE id = ?').get(b).slug;
  const views = () => q('SELECT views FROM works WHERE id = ?').get(b).views;
  const before = views();

  const server = createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.strictEqual((await fetch(`${base}/title/${slug}`)).status, 200);
  assert.strictEqual((await fetch(`${base}/title/${slug}/chapter/${ch}`)).status, 200);
  assert.strictEqual(views(), before, 'гость и открытие карточки не засчитываются');

  const uid = q(`SELECT id FROM users WHERE role = 'admin'`).get().id;
  assert.strictEqual(W.recordChapterRead(uid, b, ch), true);
  assert.strictEqual(W.recordChapterRead(uid, b, ch), false, 'повторное открытие той же главы не засчитывается');
  assert.strictEqual(views(), before + 1);
  assert.strictEqual(q('SELECT views FROM chapters WHERE id = ?').get(ch).views, 1);
});
