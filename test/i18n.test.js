'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hugecatalog-i18n-'));
process.env.ADMIN_PASSWORD = 'admin-test-pass';

const { translate, plural } = require('../src/i18n');
const { ensureBootstrap } = require('../src/bootstrap');
const { createApp } = require('../src/app');

ensureBootstrap();

test('перевод: точный, шаблоны, подстановки, запасной вариант', () => {
  assert.strictEqual(translate('en', 'Каталог'), 'Catalog');
  assert.strictEqual(translate('ru', 'Каталог'), 'Каталог');
  assert.strictEqual(translate('en', 'Глава 12.5 уже существует.'), 'Chapter 12.5 already exists.');
  assert.strictEqual(translate('en', 'Жанр: Боевик'), 'Genre: Action', 'подставленное значение тоже переводится');
  assert.strictEqual(translate('en', 'Слайд {n}', { n: 3 }), 'Slide 3');
  assert.strictEqual(translate('ru', 'Слайд {n}', { n: 3 }), 'Слайд 3');
  assert.strictEqual(translate('en', 'Строка без перевода'), 'Строка без перевода');
  assert.strictEqual(plural('en', 1, 'глава', 'главы', 'глав'), 'chapter');
  assert.strictEqual(plural('en', 5, 'глава', 'главы', 'глав'), 'chapters');
  assert.strictEqual(plural('ru', 3, 'глава', 'главы', 'глав'), 'главы');
});

test('язык интерфейса: Accept-Language, cookie и переключатель', async (t) => {
  const server = createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const ru = await (await fetch(`${base}/catalog`)).text();
  assert.match(ru, /<html lang="ru">/);
  assert.match(ru, />Каталог</);

  const byHeader = await (await fetch(`${base}/catalog`, { headers: { 'Accept-Language': 'en-US,en;q=0.9' } })).text();
  assert.match(byHeader, /<html lang="en">/);
  assert.match(byHeader, />Catalog</);
  assert.match(byHeader, />Action</, 'жанры переведены');

  const sw = await fetch(`${base}/lang/en?back=/about`, { redirect: 'manual' });
  assert.strictEqual(sw.status, 302);
  assert.strictEqual(sw.headers.get('location'), '/about');
  const cookie = sw.headers.get('set-cookie').split(';')[0];
  assert.strictEqual(cookie, 'lang=en');
  const about = await (await fetch(`${base}/about`, { headers: { Cookie: cookie } })).text();
  assert.match(about, /What you can do here/);

  const evil = await fetch(`${base}/lang/ru?back=//evil.example`, { redirect: 'manual' });
  assert.strictEqual(evil.headers.get('location'), '/', 'нет открытого редиректа');
});
