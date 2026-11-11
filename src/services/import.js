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
const { searchNormalize, uniqueSlug } = require('../util');

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
async function importWorks(input, options = {}) {
  const items = Array.isArray(input) ? input : [input];
  const genres = new Map(q('SELECT id, name FROM genres').all().map((g) => [searchNormalize(g.name), g.id]));
  const tags = new Map(q('SELECT id, name FROM tags').all().map((t) => [searchNormalize(t.name), t.id]));
  const groups = new Map(); // ключ group -> id первого произведения
  const report = [];

  for (const raw of items) {
    const entry = { title: String((raw && raw.title) || '(без названия)'), status: 'error', slug: null, messages: [] };
    report.push(entry);
    try {
      if (!raw || typeof raw !== 'object') throw new Error('запись должна быть объектом');

      const language = pick(C.LANGUAGES, raw.language);
      const dup = q('SELECT slug FROM works WHERE title = ? AND language = ?').get(String(raw.title || '').trim(), language || '');
      if (dup) {
        entry.status = 'skipped';
        entry.slug = dup.slug;
        entry.messages.push('уже есть в базе');
        if (raw.group && !groups.has(raw.group)) groups.set(raw.group, q('SELECT id FROM works WHERE slug = ?').get(dup.slug).id);
        continue;
      }

      const resolve = (names, map, kind, table) => names.map((name) => {
        const key = searchNormalize(name);
        if (map.has(key)) return map.get(key);
        if (!options.createMissing) {
          entry.messages.push(`${kind} «${name}» не найден — пропущен`);
          return null;
        }
        const id = Number((table === 'tags'
          ? q('INSERT INTO tags (name, slug, tag_group) VALUES (?, ?, ?)').run(name, uniqueSlug(db, 'tags', name), 'Прочее')
          : q('INSERT INTO genres (name, slug) VALUES (?, ?)').run(name, uniqueSlug(db, 'genres', name))).lastInsertRowid);
        map.set(key, id);
        entry.messages.push(`${kind} «${name}» создан`);
        return id;
      }).filter(Boolean);

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
        genres: resolve(asList(raw.genres), genres, 'Жанр', 'genres'),
        tags: resolve(asList(raw.tags), tags, 'Тег', 'tags'),
      };
      const { data, errors } = W.validateWorkInput(body);
      if (errors.length) throw new Error(errors.join(' '));

      let teamId = null;
      if (raw.team) {
        const team = q(`SELECT id FROM teams WHERE slug = ? AND status = 'approved'`).get(String(raw.team));
        if (team) teamId = team.id; else entry.messages.push(`команда «${raw.team}» не найдена`);
      }

      let cover = null;
      if (raw.cover_url && !options.skipCovers) {
        try {
          cover = await downloadCover(String(raw.cover_url));
        } catch (err) {
          entry.messages.push(`обложка: ${err.message} — загрузите вручную`);
        }
      }

      const id = W.saveWork(data, { teamId, uploaderId: options.uploaderId || null, moderation: 'approved', cover });
      entry.slug = q('SELECT slug FROM works WHERE id = ?').get(id).slug;
      entry.status = 'created';

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
  return report;
}

module.exports = { importWorks };
