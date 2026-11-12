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
 *   "group": "ключ",        // записи с одинаковым ключом в одном импорте связываются как языковые версии
 *   "link_to": "slug",      // связать с уже существующим произведением
 *   "team": "slug-команды"
 * }
 * Тип, статус и язык можно указывать кодом ("manhwa", "ko") или названием ("Манхва", "Корейский").
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { q, db } = require('../db');
const C = require('../constants');
const W = require('./works');
const V = require('./versions');
const { storeImage, detectImageExt } = require('../upload');
const { UPLOAD_DIR } = require('../db');
const { searchNormalize, uniqueSlug, slugify } = require('../util');

const MAX_COVER = 8 * 1024 * 1024;

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

/** Список жанров/тегов: строки и объекты { name, name_en, group } сохраняются как есть. */
function itemList(v) {
  if (v === undefined || v === null || v === '') return [];
  if (!Array.isArray(v)) return asList(v);
  return v.filter((x) => x !== null && x !== undefined && x !== '');
}

/** Скачивает обложку по ссылке и сохраняет как загруженный файл. */
async function downloadCover(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error('некорректная ссылка на обложку');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('ссылка на обложку должна быть http(s)');
  const res = await fetch(u, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'HugeCatalog-import/1.0' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`обложка не скачалась (HTTP ${res.status})`);
  if (Number(res.headers.get('content-length')) > MAX_COVER) throw new Error('обложка больше 8 МБ');
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_COVER) throw new Error('обложка больше 8 МБ');
    chunks.push(chunk);
  }
  const tmp = path.join(UPLOAD_DIR, '.tmp', crypto.randomBytes(16).toString('hex'));
  fs.writeFileSync(tmp, Buffer.concat(chunks));
  if (!detectImageExt(tmp)) {
    fs.rmSync(tmp, { force: true });
    throw new Error('по ссылке не изображение');
  }
  return storeImage({ path: tmp, originalname: u.pathname }, 'covers', null);
}

/**
 * Импортирует записи. Возвращает отчёт: [{ title, status: 'created'|'skipped'|'error', slug, messages }]
 * options: { uploaderId, createMissing, skipCovers }
 */
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
    if (team) teamId = team.id; else entry.messages.push(`команда перевода «${translator}» не найдена на сайте`);
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
 * options: { uploaderId, createMissing, skipCovers }
 *
 * Если у записи есть series, выпуски одной серии на одном языке собираются в одно произведение:
 * первая запись создаёт его, следующие добавляют главы (chapter).
 */
async function importWorks(input, options = {}) {
  const items = Array.isArray(input) ? input : [input];
  // Поиск существующих жанров/тегов и по русскому названию, и по английскому (поле «English» в админке).
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
  const groups = new Map(); // ключ group -> id первого произведения
  const report = [];

  for (const raw of items) {
    const entry = { title: String((raw && raw.title) || '(без названия)'), status: 'error', slug: null, messages: [] };
    report.push(entry);
    try {
      if (!raw || typeof raw !== 'object') throw new Error('запись должна быть объектом');

      const language = pick(C.LANGUAGES, raw.language);
      const seriesKey = raw.series ? slugify(raw.series) : null;
      // Похоже на сингл, но серия уже ведётся по главам (например, другая языковая версия) — значит, это глава.
      const seriesHasChapters = seriesKey && q('SELECT 1 FROM works WHERE import_key = ? AND is_single = 0').get(seriesKey);
      const single = raw.format === 'single' && !seriesHasChapters;
      const chapter = single ? null : chapterOf(raw); // у сингла нет глав
      const getCover = async () => {
        if (!raw.cover_url || options.skipCovers) return null;
        try {
          return await downloadCover(String(raw.cover_url));
        } catch (err) {
          entry.messages.push(`обложка: ${err.message} — загрузите вручную`);
          return null;
        }
      };

      // Серия на этом языке уже есть — добавляем главу.
      if (seriesKey && language) {
        const existing = q('SELECT id, slug, title, cover FROM works WHERE import_key = ? AND language = ?').get(seriesKey, language);
        if (existing) {
          entry.slug = existing.slug;
          entry.title = existing.title;
          const added = chapter ? addChapterSkeleton(existing.id, chapter, raw.translator, options.uploaderId, entry) : false;
          if (added) entry.messages.unshift(`Глава ${chapter.number} добавлена в «${existing.title}»`);
          else if (!chapter) entry.messages.push(single ? 'сингл уже есть в базе' : 'уже есть в базе');
          if (!existing.cover) {
            const cover = await getCover();
            if (cover) q('UPDATE works SET cover = ? WHERE id = ?').run(cover, existing.id);
          }
          linkSeries(seriesKey, existing.id, entry);
          entry.status = added ? 'updated' : 'skipped';
          continue;
        }
      }

      const dup = !seriesKey && q('SELECT slug FROM works WHERE title = ? AND language = ?').get(String(raw.title || '').trim(), language || '');
      if (dup) {
        entry.status = 'skipped';
        entry.slug = dup.slug;
        entry.messages.push('уже есть в базе');
        if (raw.group && !groups.has(raw.group)) groups.set(raw.group, q('SELECT id FROM works WHERE slug = ?').get(dup.slug).id);
        continue;
      }

      /*
       * Жанр/тег — строка («Милфы») или объект { name, name_en, group }:
       * name — русское название (может отсутствовать), name_en — оригинал с сайта-источника.
       * Ищем по name, затем по name_en; если не нашли — создаём (с name_en и группой).
       */
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
        if (team) teamId = team.id; else entry.messages.push(`команда «${raw.team}» не найдена`);
      }

      const cover = await getCover();
      const id = W.saveWork(data, { teamId, uploaderId: options.uploaderId || null, moderation: 'approved', cover });
      if (seriesKey) q('UPDATE works SET import_key = ? WHERE id = ?').run(seriesKey, id);
      entry.slug = q('SELECT slug FROM works WHERE id = ?').get(id).slug;
      entry.status = 'created';
      if (chapter && addChapterSkeleton(id, chapter, raw.translator, options.uploaderId, entry)) {
        entry.messages.unshift(`Глава ${chapter.number} добавлена в «${data.title}»`);
      }

      if (seriesKey) linkSeries(seriesKey, id, entry);
      const linkTargets = [];
      if (raw.group) {
        if (groups.has(raw.group)) linkTargets.push(groups.get(raw.group));
        else groups.set(raw.group, id);
      }
      if (raw.link_to) {
        const target = q('SELECT id FROM works WHERE slug = ?').get(String(raw.link_to));
        if (target) linkTargets.push(target.id); else entry.messages.push(`link_to: «${raw.link_to}» не найден`);
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
  // Новые жанры/теги из импорта: подхватываем переводы из словаря, если они там есть.
  if (options.createMissing) require('./taxonomy-i18n').init();
  return report;
}

module.exports = { importWorks };
