'use strict';

/**
 * Импорт произведений из JSON (админка /admin/import и `npm run import`).
 *
 * Формат — массив объектов (или один объект):
 * {
 *   "title": "Название", "alt_titles": ["Другое название"], "description": "…",
 *   "type": "manga", "status": "ongoing", "language": "ja", "age_rating": "16+", "year": 2019,
 *   "authors": ["Автор"], "artists": ["Художник"],
 *   "genres": ["Боевик"], "tags": ["Месть"],
 *   "cover_url": "https://…/cover.jpg",
 *   "scans_gallery": ["https://…/001.jpg", "https://…/002.jpg"],
 *   "group": "ключ",
 *   "link_to": "slug",
 *   "team": "slug-команды"
 * }
 *
 * Файлы сохраняются в /data/uploads/works/<slug-произведения>/…:
 *   cover.<ext>            — обложка
 *   gallery/NNN.<ext>      — сканы сингла
 *   chapter<N>/NNN.<ext>   — сканы главы
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { q, db } = require('../db');
const C = require('../constants');
const W = require('./works');
const V = require('./versions');
const { detectImageExt } = require('../upload');
const { UPLOAD_DIR } = require('../db');
const { searchNormalize, uniqueSlug, slugify } = require('../util');

const MAX_COVER = 8 * 1024 * 1024;
const MAX_SCAN = 8 * 1024 * 1024;
const MAX_SCANS_TOTAL = 768 * 1024 * 1024; // 768 МБ на всю галерею
const SCAN_CONCURRENCY = 4;

function pick(list, raw) {
  const v = searchNormalize(raw);
  if (!v) return null;
  const hit = list.find((i) => i.value === v || searchNormalize(i.label) === v);
  return hit ? hit.value : null;
}

function asList(v) {
  if (v === undefined || v === null || v === '') return [];
  return (Array.isArray(v) ? v : String(v).split(/[,;\n]/)).map((x) => String(x).trim()).filter(Boolean);
}

function itemList(v) {
  if (v === undefined || v === null || v === '') return [];
  if (!Array.isArray(v)) return asList(v);
  return v.filter((x) => x !== null && x !== undefined && x !== '');
}

/* ------------------------------------------------------------------ */
/*  Скачивание файлов в /data/uploads/works/<slug>/…                    */
/* ------------------------------------------------------------------ */

/**
 * Скачивает URL во временный файл. Бросает при любой ошибке.
 * @returns {string} путь к временному файлу
 */
async function fetchToTmp(url, label, maxSize) {
  let u;
  try { u = new URL(url); }
  catch { throw new Error(`некорректная ссылка на ${label}`); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error(`ссылка на ${label} должна быть http(s)`);

  const res = await fetch(u, {
    signal: AbortSignal.timeout(20000),
    headers: { 'User-Agent': 'HugeCatalog-import/1.0' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`${label} не скачался (HTTP ${res.status})`);
  const limitMb = Math.round(maxSize / 1024 / 1024);
  if (Number(res.headers.get('content-length')) > maxSize) throw new Error(`${label} больше ${limitMb} МБ`);

  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > maxSize) throw new Error(`${label} больше ${limitMb} МБ`);
    chunks.push(chunk);
  }

  const tmp = path.join(UPLOAD_DIR, '.tmp', crypto.randomBytes(16).toString('hex'));
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, Buffer.concat(chunks));
  return tmp;
}

/**
 * Переносит временный файл в works/<slug>/<subdir>/<filename>.<ext>.
 * Возвращает публичный путь вида /uploads/works/<slug>/<subdir>/<filename>.<ext>.
 * При любой ошибке удаляет временный файл.
 */
function storeInWork(slug, subdir, tmpPath, filename) {
  try {
    const ext = detectImageExt(tmpPath);
    if (!ext) throw new Error('по ссылке не изображение');

    const safeSlug = String(slug || 'work').replace(/[^a-z0-9_-]/gi, '_') || 'work';
    const safeSub = String(subdir || '').replace(/[^a-z0-9_-]/gi, '');
    const dir = path.join(UPLOAD_DIR, 'works', safeSlug, safeSub);
    fs.mkdirSync(dir, { recursive: true });

    let base = String(filename || 'file').replace(/[^a-z0-9._-]/gi, '_') || 'file';
    if (!base.toLowerCase().endsWith('.' + ext.toLowerCase())) base += '.' + ext;

    let target = path.join(dir, base);
    let n = 0;
    while (fs.existsSync(target)) {
      target = path.join(dir, `${++n}_${base}`);
    }
    fs.renameSync(tmpPath, target);

    const rel = path.relative(UPLOAD_DIR, target).split(path.sep).join('/');
    return `/uploads/${rel}`;
  } catch (err) {
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* noop */ }
    throw err;
  }
}

/** Скачивает обложку в works/<slug>/cover.<ext> и возвращает публичный путь. */
async function downloadCover(url, slug) {
  const tmp = await fetchToTmp(url, 'обложка', MAX_COVER);
  return storeInWork(slug, '', tmp, 'cover');
}

/**
 * Скачивает галерею в works/<slug>/<subdir>/NNN.<ext> (001, 002, …).
 *
 * Порядок страниц сохраняется: номер в имени файла — это позиция URL в исходном массиве.
 * Ошибки отдельных ссылок не прерывают скачивание всей галереи.
 *
 * @param {string[]} urls
 * @param {string}   slug    slug произведения
 * @param {string}   subdir  'gallery' или 'chapterN'
 * @param {{concurrency?:number,maxTotal?:number,onProgress?:(done:number,total:number)=>void}} [options]
 * @returns {Promise<{ stored:string[], failed:{url:string,error:string}[], totalSize:number, truncated:boolean }>}
 */
async function downloadScans(urls, slug, subdir, options = {}) {
  const concurrency = Math.max(1, options.concurrency || SCAN_CONCURRENCY);
  const maxTotal = Number.isFinite(options.maxTotal) ? options.maxTotal : MAX_SCANS_TOTAL;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

  const unique = [...new Set((urls || []).map(String).filter(Boolean))];
  if (!unique.length) return { stored: [], failed: [], totalSize: 0, truncated: false };

  const stored = new Array(unique.length).fill(null);
  const failed = [];
  let next = 0, done = 0, totalSize = 0, truncated = false;

  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= unique.length || truncated) return;
      const url = unique[i];
      let tmp = null;
      try {
        tmp = await fetchToTmp(url, `скан ${i + 1}`, MAX_SCAN);
        const size = fs.statSync(tmp).size;
        if (totalSize + size > maxTotal) {
          truncated = true;
          failed.push({ url, error: 'превышен суммарный размер галереи' });
          return;
        }
        totalSize += size;
        const num = String(i + 1).padStart(3, '0');
        stored[i] = storeInWork(slug, subdir, tmp, num);
        tmp = null; // файл уже перенесён, чистить нечего
      } catch (err) {
        failed.push({ url, error: err.message });
      } finally {
        if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch { /* noop */ } }
        if (onProgress) onProgress(++done, unique.length);
      }
    }
  };

  const n = Math.min(concurrency, unique.length);
  await Promise.all(Array.from({ length: n }, worker));

  return { stored: stored.filter(Boolean), failed, totalSize, truncated };
}

/* ------------------------------------------------------------------ */
/*  Импорт                                                              */
/* ------------------------------------------------------------------ */

function chapterOf(raw) {
  const c = raw.chapter;
  if (c === undefined || c === null || c === '') return null;
  const obj = typeof c === 'object' ? c : { number: c };
  const number = Number(String(obj.number ?? '').replace(',', '.'));
  if (!Number.isFinite(number) || number < 0) return null;
  const volume = Number.parseInt(obj.volume, 10);
  return { number, volume: Number.isFinite(volume) ? volume : null, title: String(obj.title || '').trim().slice(0, 200) };
}

/** Глава-каркас без страниц: появится у читателей, когда команда загрузит страницы в студии. */
function addChapterSkeleton(workId, ch, translator, uploaderId, entry) {
  if (q('SELECT 1 FROM chapters WHERE work_id = ? AND number = ?').get(workId, ch.number)) {
    entry.messages.push(`глава ${ch.number} уже есть`);
    return false;
  }
  let teamId = null;
  if (translator) {
    const team = q(`SELECT id FROM teams WHERE name = ? AND status = 'approved'`).get(String(translator));
    if (team) teamId = team.id;
    else entry.messages.push(`команда перевода «${translator}» не найдена на сайте`);
  }
  q('INSERT INTO chapters (work_id, volume, number, title, team_id, uploader_id, pages_count) VALUES (?, ?, ?, ?, ?, ?, 0)')
    .run(workId, ch.volume, ch.number, ch.title, teamId, uploaderId || null);
  return true;
}

/** Связывает произведение с версиями той же серии на других языках. */
function linkSeries(key, workId, entry) {
  const others = q('SELECT id FROM works WHERE import_key = ? AND id != ?').all(key, workId);
  let linked = false;
  for (const o of others) {
    try {
      V.linkWorks(o.id, workId);
      linked = true;
    } catch (err) {
      if (!/уже связаны/.test(err.message)) entry.messages.push(`не связано: ${err.message}`);
    }
  }
  if (linked) entry.messages.push('связано с другими языковыми версиями');
}

/**
 * Импортирует записи. Возвращает отчёт: [{ title, status: 'created'|'updated'|'skipped'|'error', slug, messages }]
 * options: { uploaderId, createMissing, skipCovers, skipScans, onScans }
 *
 * Если у записи есть series, выпуски одной серии на одном языке собираются в одно произведение:
 * первая запись создаёт его, следующие добавляют главы (chapter).
 *
 * options.onScans — необязательный колбэк (ctx) => void, вызывается после скачивания сканов:
 *   ctx = { workId, slug, chapter, scans: string[] }
 * Через него можно сохранить пути в БД (например, в таблицу pages), если читалка
 * не умеет читать прямо из works/<slug>/chapter<N>/.
 */
async function importWorks(input, options = {}) {
  const items = Array.isArray(input) ? input : [input];
  const index = (table) => {
    const byName = new Map();
    const byEn = new Map();
    q(`SELECT id, name, name_en FROM ${table}`).all().forEach((r) => {
      byName.set(searchNormalize(r.name), r.id);
      if (r.name_en) byEn.set(searchNormalize(r.name_en), r.id);
    });
    return { byName, byEn };
  };
  const genres = index('genres');
  const tags = index('tags');
  const groups = new Map();
  const report = [];

  for (const raw of items) {
    const entry = { title: String((raw && raw.title) || '(без названия)'), status: 'error', slug: null, messages: [] };
    report.push(entry);
    try {
      if (!raw || typeof raw !== 'object') throw new Error('запись должна быть объектом');

      const language = pick(C.LANGUAGES, raw.language);
      const seriesKey = raw.series ? slugify(raw.series) : null;
      const seriesHasChapters = seriesKey && q('SELECT 1 FROM works WHERE import_key = ? AND is_single = 0').get(seriesKey);
      const single = raw.format === 'single' && !seriesHasChapters;
      const chapter = single ? null : chapterOf(raw);

      const scansInput = Array.isArray(raw.scans_gallery) ? raw.scans_gallery : [];
      const wantsScans = !options.skipScans && scansInput.length > 0;

      /* ---------- Серия на этом языке уже есть — добавляем главу ---------- */
      if (seriesKey && language) {
        const existing = q('SELECT id, slug, title, cover FROM works WHERE import_key = ? AND language = ?').get(seriesKey, language);
        if (existing) {
          entry.slug = existing.slug;
          entry.title = existing.title;
          const added = chapter ? addChapterSkeleton(existing.id, chapter, raw.translator, options.uploaderId, entry) : false;
          if (added) entry.messages.unshift(`Глава ${chapter.number} добавлена в «${existing.title}»`);
          else if (!chapter) entry.messages.push(single ? 'сингл уже есть в базе' : 'уже есть в базе');

          // Обложка — только если её нет.
          if (!existing.cover && raw.cover_url && !options.skipCovers) {
            try {
              const cover = await downloadCover(String(raw.cover_url), existing.slug);
              q('UPDATE works SET cover = ? WHERE id = ?').run(cover, existing.id);
            } catch (err) {
              entry.messages.push(`обложка: ${err.message} — загрузите вручную`);
            }
          }

          // Сканы — только для только что добавленной главы, иначе перекачаем существующее.
          if (added && wantsScans) {
            const subdir = `chapter${chapter.number}`;
            try {
              const res = await downloadScans(scansInput, existing.slug, subdir);
              entry.messages.push(scanReportMessage(res));
              if (options.onScans) options.onScans({ workId: existing.id, slug: existing.slug, chapter, scans: res.stored });
            } catch (err) {
              entry.messages.push(`сканы: ${err.message}`);
            }
          }

          linkSeries(seriesKey, existing.id, entry);
          entry.status = added ? 'updated' : 'skipped';
          continue;
        }
      }

      /* ---------- Дубль по названию+языку ---------- */
      const dup = !seriesKey && q('SELECT slug FROM works WHERE title = ? AND language = ?').get(String(raw.title || '').trim(), language || '');
      if (dup) {
        entry.status = 'skipped';
        entry.slug = dup.slug;
        entry.messages.push('уже есть в базе');
        if (raw.group && !groups.has(raw.group)) groups.set(raw.group, q('SELECT id FROM works WHERE slug = ?').get(dup.slug).id);
        continue;
      }

      /* ---------- Жанры и теги ---------- */
      const resolve = (items, idx, kind, table) => [...new Set(items.map((item) => {
        const obj = item && typeof item === 'object' ? item : { name: item };
        const ru = String(obj.name || '').trim().slice(0, 60);
        const en = String(obj.name_en || '').trim().slice(0, 60);
        const label = ru || en;
        if (!label) return null;
        const found = (ru && (idx.byName.get(searchNormalize(ru)) || idx.byEn.get(searchNormalize(ru))))
          || (en && (idx.byEn.get(searchNormalize(en)) || idx.byName.get(searchNormalize(en))));
        if (found) return found;
        if (!options.createMissing) {
          entry.messages.push(`${kind} «${label}» не найден — пропущен`);
          return null;
        }
        const group = C.TAG_GROUPS.includes(obj.group) ? obj.group : 'Прочее';
        const id = Number((table === 'tags'
          ? q('INSERT INTO tags (name, slug, tag_group, name_en) VALUES (?, ?, ?, ?)').run(label, uniqueSlug(db, 'tags', label), group, en || null)
          : q('INSERT INTO genres (name, slug, name_en) VALUES (?, ?, ?)').run(label, uniqueSlug(db, 'genres', label), en || null)).lastInsertRowid);
        idx.byName.set(searchNormalize(label), id);
        if (en) idx.byEn.set(searchNormalize(en), id);
        entry.messages.push(`${kind} «${label}» создан`);
        return id;
      }).filter(Boolean))];

      const body = {
        title: raw.title,
        alt_titles: asList(raw.alt_titles).join('\n'),
        description: raw.description || '',
        type: pick(C.TYPES, raw.type) || '',
        status: pick(C.STATUSES, raw.status || 'ongoing') || '',
        language: language || '',
        age_rating: C.values(C.AGE_RATINGS).includes(String(raw.age_rating)) ? String(raw.age_rating) : (raw.age_rating ? '' : '0+'),
        year: raw.year,
        story_authors: asList(raw.authors).join(', '),
        artists: asList(raw.artists).join(', '),
        genres: resolve(itemList(raw.genres), genres, 'Жанр', 'genres'),
        tags: resolve(itemList(raw.tags), tags, 'Тег', 'tags'),
        format: single ? 'single' : 'chapters',
      };
      if (raw.format === 'single' && !single) entry.messages.push('серия уже ведётся по главам — добавлено как глава');
      const { data, errors } = W.validateWorkInput(body);
      if (errors.length) throw new Error(errors.join(' '));

      let teamId = null;
      if (raw.team) {
        const team = q(`SELECT id FROM teams WHERE slug = ? AND status = 'approved'`).get(String(raw.team));
        if (team) teamId = team.id;
        else entry.messages.push(`команда «${raw.team}» не найдена`);
      }

      /* ---------- Создаём произведение без обложки, чтобы знать slug ---------- */
      const id = W.saveWork(data, { teamId, uploaderId: options.uploaderId || null, moderation: 'approved', cover: null });
      if (seriesKey) q('UPDATE works SET import_key = ? WHERE id = ?').run(seriesKey, id);
      entry.slug = q('SELECT slug FROM works WHERE id = ?').get(id).slug;
      entry.status = 'created';

      /* ---------- Обложка → works/<slug>/cover.<ext> ---------- */
      if (raw.cover_url && !options.skipCovers) {
        try {
          const cover = await downloadCover(String(raw.cover_url), entry.slug);
          q('UPDATE works SET cover = ? WHERE id = ?').run(cover, id);
        } catch (err) {
          entry.messages.push(`обложка: ${err.message} — загрузите вручную`);
        }
      }

      /* ---------- Глава ---------- */
      if (chapter && addChapterSkeleton(id, chapter, raw.translator, options.uploaderId, entry)) {
        entry.messages.unshift(`Глава ${chapter.number} добавлена в «${data.title}»`);
      }

      /* ---------- Сканы → works/<slug>/gallery|chapter<N> ---------- */
      if (wantsScans) {
        const subdir = chapter ? `chapter${chapter.number}` : 'gallery';
        try {
          const res = await downloadScans(scansInput, entry.slug, subdir);
          entry.messages.push(scanReportMessage(res));
          if (options.onScans) options.onScans({ workId: id, slug: entry.slug, chapter, scans: res.stored });
        } catch (err) {
          entry.messages.push(`сканы: ${err.message}`);
        }
      }

      /* ---------- Связи ---------- */
      if (seriesKey) linkSeries(seriesKey, id, entry);
      const linkTargets = [];
      if (raw.group) {
        if (groups.has(raw.group)) linkTargets.push(groups.get(raw.group));
        else groups.set(raw.group, id);
      }
      if (raw.link_to) {
        const target = q('SELECT id FROM works WHERE slug = ?').get(String(raw.link_to));
        if (target) linkTargets.push(target.id);
        else entry.messages.push(`link_to: «${raw.link_to}» не найден`);
      }
      for (const t of linkTargets) {
        try {
          V.linkWorks(t, id);
          entry.messages.push('связано с другими языковыми версиями');
        } catch (err) {
          if (!/уже связаны/.test(err.message)) entry.messages.push(`не связано: ${err.message}`);
        }
      }
    } catch (err) {
      entry.status = 'error';
      entry.messages.push(err.message);
    }
  }
  if (options.createMissing) require('./taxonomy-i18n').init();
  return report;
}

function scanReportMessage({ stored, failed, truncated }) {
  const parts = [`сканов: ${stored.length}`];
  if (failed.length) parts.push(`ошибок: ${failed.length}`);
  if (truncated) parts.push('превышен лимит размера — скачано частично');
  return parts.join(', ');
}

module.exports = { importWorks };