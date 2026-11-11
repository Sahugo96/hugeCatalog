'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hugecatalog-import-'));
process.env.ADMIN_PASSWORD = 'admin-test-pass';

const { q } = require('../src/db');
const { ensureBootstrap } = require('../src/bootstrap');
const { importWorks } = require('../src/services/import');
const V = require('../src/services/versions');
const W = require('../src/services/works');

ensureBootstrap();

const base = { series: 'Test Series', type: 'doujinshi', age_rating: '18+', authors: ['Author'], genres: ['Драма'] };

test('импорт серии: главы одного языка — одно произведение, языки связываются', async () => {
  const opts = { skipCovers: true };
  // Как из расширения: по одной галерее за раз.
  let r = await importWorks({ ...base, title: 'Тестовая серия', language: 'ru', chapter: { number: 1 } }, opts);
  assert.strictEqual(r[0].status, 'created');
  r = await importWorks({ ...base, title: 'Тестовая серия', language: 'ru', chapter: { number: 2, title: 'Вторая' } }, opts);
  assert.strictEqual(r[0].status, 'updated', 'вторая глава добавлена в существующее произведение');
  r = await importWorks({ ...base, title: 'Тестовая серия', language: 'ru', chapter: { number: 2 } }, opts);
  assert.strictEqual(r[0].status, 'skipped', 'повтор главы не дублируется');
  r = await importWorks([
    { ...base, title: 'Test Series', language: 'en', chapter: { number: 1 } },
    { ...base, title: 'Test Series', language: 'ja', chapter: 3 },
  ], opts);
  assert.deepStrictEqual(r.map((x) => x.status), ['created', 'created']);

  const ru = q(`SELECT id FROM works WHERE import_key = 'test-series' AND language = 'ru'`).get();
  assert.deepStrictEqual(q('SELECT number FROM chapters WHERE work_id = ? ORDER BY number').all(ru.id).map((c) => c.number), [1, 2]);
  assert.deepStrictEqual(V.getVersions(ru.id).map((v) => v.language).sort(), ['en', 'ja', 'ru']);

  // Главы-каркасы без страниц скрыты от читателей, но видны в студии.
  assert.strictEqual(W.getChapters(ru.id).length, 0);
  assert.strictEqual(W.getChapters(ru.id, 'ASC', { includeEmpty: true }).length, 2);
  assert.strictEqual(W.getWorkById(ru.id).chapters_count, 0);
});

test('теги-объекты: совпадение по английскому названию, новые создаются с полем English и группой', async () => {
  const r = await importWorks({
    ...base, series: 'Tag Series', title: 'Tag Series', language: 'en', chapter: 1,
    tags: [
      { name: 'Full color', name_en: 'Full color', group: 'Прочее' }, // уже есть «Цветная» с English = Full color
      { name: 'Gyaru-oh', name_en: 'Gyaru-oh', group: 'Прочее' }, // новый
      { name: 'Asuka', name_en: 'Asuka', group: 'Персонажи' }, // новый персонаж
    ],
  }, { skipCovers: true, createMissing: true });
  assert.strictEqual(r[0].status, 'created');
  const w = W.getWorkBySlug(r[0].slug);
  assert.deepStrictEqual(w.tags.map((t) => t.name).sort(), ['Asuka', 'Gyaru-oh', 'Цветная']);
  const gyaru = q(`SELECT name_en, tag_group FROM tags WHERE name = 'Gyaru-oh'`).get();
  assert.deepStrictEqual({ ...gyaru }, { name_en: 'Gyaru-oh', tag_group: 'Прочее' });
  assert.strictEqual(q(`SELECT tag_group FROM tags WHERE name = 'Asuka'`).get().tag_group, 'Персонажи');
});
