'use strict';

/**
 * Сжатие изображений в WebP по образцу WordPress-плагина WebP Express:
 * - оригиналы не трогаем, рядом создаём копию «имя.jpg.webp»;
 * - браузерам с поддержкой WebP (заголовок Accept: image/webp) по тому же адресу отдаём WebP,
 *   остальным — оригинал («varied image responses», заголовок Vary: Accept). Разметку менять не нужно;
 * - если WebP получился тяжелее оригинала — отдаём оригинал;
 * - конвертация: сразу после загрузки (в фоне), «на лету» для старых файлов (при первом запросе
 *   отдаётся оригинал, а WebP готовится в фоне) и массово из админки или командой npm run images:webp.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { q, UPLOAD_DIR } = require('./db');

let sharp = null;
try {
  sharp = require('sharp');
  sharp.cache(false); // не держим декодированные картинки в памяти между запросами
} catch {
  console.warn('[webp] библиотека sharp не установлена — сжатие изображений отключено');
}

const CONVERTIBLE = /\.(jpe?g|png)$/i;
const TMP_DIR = path.join(UPLOAD_DIR, '.tmp');

/* ---------- Настройки (Админка → Изображения) ---------- */

q(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`).run();

const DEFAULTS = {
  webp_enabled: '1', // отдавать WebP браузерам, которые его поддерживают
  webp_on_upload: '1', // конвертировать сразу после загрузки
  webp_quality: String(process.env.WEBP_QUALITY || 80), // качество для JPEG (и PNG с потерями)
  webp_png: 'auto', // PNG: auto — что меньше из «без потерь» и «с потерями»; lossless; lossy
};

function settings() {
  const out = { ...DEFAULTS };
  q('SELECT key, value FROM settings').all().forEach((r) => { if (r.key in DEFAULTS) out[r.key] = r.value; });
  return {
    enabled: out.webp_enabled === '1',
    onUpload: out.webp_on_upload === '1',
    quality: Math.min(100, Math.max(1, Number(out.webp_quality) || 80)),
    png: ['auto', 'lossless', 'lossy'].includes(out.webp_png) ? out.webp_png : 'auto',
  };
}

function saveSettings(input) {
  const set = q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  set.run('webp_enabled', input.enabled ? '1' : '0');
  set.run('webp_on_upload', input.onUpload ? '1' : '0');
  set.run('webp_quality', String(Math.min(100, Math.max(1, Number(input.quality) || 80))));
  set.run('webp_png', ['auto', 'lossless', 'lossy'].includes(input.png) ? input.png : 'auto');
}

/* ---------- Конвертация ---------- */

const webpPathOf = (file) => `${file}.webp`;

async function exists(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

/**
 * Конвертирует один файл. Возвращает { status: 'converted'|'exists'|'skipped'|'error', original, webp }.
 * force — пересоздать, даже если WebP уже есть и свежее оригинала.
 */
async function convertFile(file, { force = false } = {}) {
  if (!sharp || !CONVERTIBLE.test(file)) return { status: 'skipped' };
  const src = await exists(file);
  if (!src) return { status: 'skipped' };
  const out = webpPathOf(file);
  const dst = await exists(out);
  if (!force && dst && dst.mtimeMs >= src.mtimeMs) return { status: 'exists', original: src.size, webp: dst.size };

  const opts = settings();
  try {
    const input = await fsp.readFile(file);
    const base = () => sharp(input, { failOn: 'none', limitInputPixels: 268402689 }).rotate();
    let buf;
    if (/\.png$/i.test(file)) {
      const lossless = opts.png !== 'lossy' ? await base().webp({ lossless: true, effort: 4 }).toBuffer() : null;
      const lossy = opts.png !== 'lossless' ? await base().webp({ quality: opts.quality, alphaQuality: 100, effort: 4 }).toBuffer() : null;
      buf = !lossless ? lossy : !lossy ? lossless : (lossy.length < lossless.length ? lossy : lossless);
    } else {
      buf = await base().webp({ quality: opts.quality, effort: 4, smartSubsample: true }).toBuffer();
    }
    // Пишем во временный файл и переименовываем — чтобы никто не получил недописанный WebP.
    await fsp.mkdir(TMP_DIR, { recursive: true });
    const tmp = path.join(TMP_DIR, `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.webp`);
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, out);
    return { status: 'converted', original: src.size, webp: buf.length };
  } catch (err) {
    return { status: 'error', error: err.message };
  }
}

/* ---------- Очередь (ограничиваем параллельность, чтобы не занять весь процессор) ---------- */

const CONCURRENCY = Math.max(1, Math.min(4, os.cpus().length - 1));
const pending = new Map(); // файл -> Promise
const queue = [];
let active = 0;

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const job = queue.shift();
    active++;
    convertFile(job.file, job.opts)
      .then(job.resolve, (e) => job.resolve({ status: 'error', error: e.message }))
      .finally(() => {
        active--;
        pending.delete(job.file);
        pump();
      });
  }
}

/** Ставит файл в очередь конвертации (повторная постановка того же файла не дублируется). */
function enqueue(file, opts = {}) {
  if (!sharp || !CONVERTIBLE.test(file)) return Promise.resolve({ status: 'skipped' });
  if (pending.has(file)) return pending.get(file);
  const p = new Promise((resolve) => queue.push({ file, opts, resolve }));
  pending.set(file, p);
  pump();
  return p;
}

/** Вызывается после сохранения загруженного файла. */
function afterUpload(file) {
  if (settings().onUpload) enqueue(file);
}

/* ---------- Отдача: WebP по тому же адресу ---------- */

const CACHE = 'public, max-age=2592000';
const CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox";

/* ---------- Миниатюры для галереи: /uploads/...jpg?thumb=1 → «имя.jpg.thumb.webp» шириной 320px ---------- */

const THUMB_WIDTH = 320;
const thumbPending = new Map();

function thumbPathOf(file) {
  return `${file}.thumb.webp`;
}

async function makeThumb(file) {
  const out = thumbPathOf(file);
  const [src, dst] = await Promise.all([exists(file), exists(out)]);
  if (!src) return null;
  if (dst && dst.mtimeMs >= src.mtimeMs) return out;
  if (thumbPending.has(out)) return thumbPending.get(out);
  const job = (async () => {
    const buf = await sharp(await fsp.readFile(file), { failOn: 'none' }).rotate()
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 72, effort: 3 }).toBuffer();
    await fsp.mkdir(TMP_DIR, { recursive: true });
    const tmp = path.join(TMP_DIR, `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.thumb.webp`);
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, out);
    return out;
  })().finally(() => thumbPending.delete(out));
  thumbPending.set(out, job);
  return job;
}

function thumbMiddleware(req, res, next) {
  if (req.query.thumb === undefined || (req.method !== 'GET' && req.method !== 'HEAD') || !CONVERTIBLE.test(req.path)) return next();
  res.vary('Accept');
  // Без поддержки WebP (очень старые браузеры) — отдаём оригинал.
  if (!sharp || !(req.get('accept') || '').includes('image/webp')) return next();
  let rel;
  try {
    rel = decodeURIComponent(req.path);
  } catch {
    return next();
  }
  const file = path.join(UPLOAD_DIR, rel);
  if (!file.startsWith(UPLOAD_DIR + path.sep) || rel.includes('\0')) return next();
  makeThumb(file).then((thumb) => {
    if (!thumb) return next();
    res.sendFile(thumb, {
      headers: { 'Content-Type': 'image/webp', 'Cache-Control': CACHE, 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' },
    }, (err) => { if (err && !res.headersSent) next(); });
  }, () => next());
}

function middleware(req, res, next) {
  if ((req.method !== 'GET' && req.method !== 'HEAD') || !CONVERTIBLE.test(req.path)) return next();
  res.vary('Accept'); // ответ зависит от того, умеет ли браузер WebP
  if (!sharp || !(req.get('accept') || '').includes('image/webp') || !settings().enabled) return next();

  let rel;
  try {
    rel = decodeURIComponent(req.path);
  } catch {
    return next();
  }
  const file = path.join(UPLOAD_DIR, rel);
  if (!file.startsWith(UPLOAD_DIR + path.sep) || rel.includes('\0')) return next();

  Promise.all([exists(file), exists(webpPathOf(file))]).then(([src, dst]) => {
    if (!src) return next();
    if (!dst || dst.mtimeMs < src.mtimeMs) {
      enqueue(file); // старый файл: сейчас отдаём оригинал, WebP будет к следующему запросу
      return next();
    }
    if (dst.size >= src.size) return next(); // WebP не выгоднее — отдаём оригинал
    res.sendFile(webpPathOf(file), {
      headers: { 'Content-Type': 'image/webp', 'Cache-Control': CACHE, 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' },
    }, (err) => { if (err && !res.headersSent) next(); });
  }, () => next());
}

/* ---------- Статистика и массовые операции ---------- */

async function* walk(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield full;
  }
}

async function stats() {
  const s = { images: 0, converted: 0, originalBytes: 0, servedBytes: 0, webpLarger: 0 };
  for await (const file of walk(UPLOAD_DIR)) {
    if (!CONVERTIBLE.test(file)) continue;
    const src = await exists(file);
    if (!src) continue;
    s.images++;
    s.originalBytes += src.size;
    const dst = await exists(webpPathOf(file));
    if (dst && dst.mtimeMs >= src.mtimeMs) {
      s.converted++;
      if (dst.size < src.size) s.servedBytes += dst.size;
      else { s.servedBytes += src.size; s.webpLarger++; }
    } else {
      s.servedBytes += src.size;
    }
  }
  s.savedBytes = s.originalBytes - s.servedBytes;
  return s;
}

const bulk = { running: false, total: 0, done: 0, converted: 0, errors: 0, saved: 0, startedAt: null, finishedAt: null, lastError: null };

/** Массовая конвертация. force — пересоздать все WebP (например, после смены качества). */
async function startBulk({ force = false } = {}) {
  if (bulk.running || !sharp) return bulk;
  const files = [];
  for await (const file of walk(UPLOAD_DIR)) if (CONVERTIBLE.test(file)) files.push(file);
  Object.assign(bulk, { running: true, total: files.length, done: 0, converted: 0, errors: 0, saved: 0, startedAt: Date.now(), finishedAt: null, lastError: null });
  Promise.all(files.map((f) => enqueue(f, { force }).then((r) => {
    bulk.done++;
    if (r.status === 'converted') {
      bulk.converted++;
      if (r.webp < r.original) bulk.saved += r.original - r.webp;
    }
    if (r.status === 'error') { bulk.errors++; bulk.lastError = r.error; }
  }))).finally(() => {
    bulk.running = false;
    bulk.finishedAt = Date.now();
  });
  return bulk;
}

/** Удаляет все созданные WebP-копии (оригиналы остаются). */
async function deleteAll() {
  let removed = 0;
  for await (const file of walk(UPLOAD_DIR)) {
    if (file.endsWith('.webp') && CONVERTIBLE.test(file.slice(0, -5)) && fs.existsSync(file.slice(0, -5))) {
      await fsp.unlink(file).catch(() => {});
      removed++;
    }
  }
  return removed;
}

module.exports = {
  available: () => !!sharp,
  settings,
  saveSettings,
  convertFile,
  enqueue,
  afterUpload,
  middleware,
  thumbMiddleware,
  stats,
  startBulk,
  bulkState: () => ({ ...bulk }),
  deleteAll,
  webpPathOf,
  CONVERTIBLE,
};
