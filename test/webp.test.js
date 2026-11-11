'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hugecatalog-webp-'));
process.env.ADMIN_PASSWORD = 'admin-test-pass';

const sharp = require('sharp');
const { UPLOAD_DIR } = require('../src/db');
const { ensureBootstrap } = require('../src/bootstrap');
const webp = require('../src/webp');
const { removePublic } = require('../src/upload');
const { createApp } = require('../src/app');

ensureBootstrap();

async function makeJpeg(rel) {
  const full = path.join(UPLOAD_DIR, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  // Шум сжимается плохо в обоих форматах, но JPEG q95 заметно тяжелее WebP q80.
  const raw = Buffer.alloc(300 * 400 * 3).map(() => Math.floor(Math.random() * 256));
  await sharp(raw, { raw: { width: 300, height: 400, channels: 3 } }).blur(2).jpeg({ quality: 95 }).toFile(full);
  return full;
}

test('WebP: конвертация, отдача по Accept, оригинал без поддержки, удаление вместе с оригиналом', async (t) => {
  const file = await makeJpeg('covers/test.jpg');
  const r = await webp.convertFile(file);
  assert.strictEqual(r.status, 'converted');
  assert.ok(r.webp < r.original, `WebP меньше оригинала (${r.webp} < ${r.original})`);
  assert.strictEqual((await webp.convertFile(file)).status, 'exists', 'повторно не конвертируется');

  const server = createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const modern = await fetch(`${base}/uploads/covers/test.jpg`, { headers: { Accept: 'image/avif,image/webp,*/*' } });
  assert.strictEqual(modern.headers.get('content-type'), 'image/webp');
  assert.match(modern.headers.get('vary'), /Accept/);
  assert.strictEqual(Number(modern.headers.get('content-length')), r.webp);

  const old = await fetch(`${base}/uploads/covers/test.jpg`, { headers: { Accept: 'image/*' } });
  assert.strictEqual(old.headers.get('content-type'), 'image/jpeg', 'без поддержки WebP — оригинал');
  assert.match(old.headers.get('vary'), /Accept/);

  webp.saveSettings({ ...webp.settings(), enabled: false });
  const off = await fetch(`${base}/uploads/covers/test.jpg`, { headers: { Accept: 'image/webp' } });
  assert.strictEqual(off.headers.get('content-type'), 'image/jpeg', 'отдача WebP выключена в настройках');
  webp.saveSettings({ ...webp.settings(), enabled: true });

  // Старый файл без копии: первый запрос — оригинал, копия готовится в фоне.
  const file2 = await makeJpeg('covers/old.jpg');
  const first = await fetch(`${base}/uploads/covers/old.jpg`, { headers: { Accept: 'image/webp' } });
  assert.strictEqual(first.headers.get('content-type'), 'image/jpeg');
  await webp.enqueue(file2);
  const second = await fetch(`${base}/uploads/covers/old.jpg`, { headers: { Accept: 'image/webp' } });
  assert.strictEqual(second.headers.get('content-type'), 'image/webp');

  const st = await webp.stats();
  assert.strictEqual(st.images, 2);
  assert.strictEqual(st.converted, 2);
  assert.ok(st.savedBytes > 0);

  removePublic('/uploads/covers/test.jpg');
  assert.ok(!fs.existsSync(file) && !fs.existsSync(`${file}.webp`), 'копия удаляется вместе с оригиналом');
  assert.strictEqual(await webp.deleteAll(), 1);
  assert.ok(fs.existsSync(file2), 'оригинал на месте после удаления всех WebP');
});
