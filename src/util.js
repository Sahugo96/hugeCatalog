'use strict';

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  і: 'i', ї: 'yi', є: 'ye', ґ: 'g',
};

function slugify(input) {
  const s = String(input || '')
    .toLowerCase()
    .split('')
    .map((ch) => (TRANSLIT[ch] !== undefined ? TRANSLIT[ch] : ch))
    .join('')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return s || 'item';
}

/** Уникальный slug для таблицы: добавляет -2, -3, ... при коллизии. */
function uniqueSlug(db, table, base, excludeId = null) {
  const root = slugify(base);
  let slug = root;
  let n = 2;
  const stmt = db.prepare(`SELECT id FROM ${table} WHERE slug = ?`);
  for (;;) {
    const row = stmt.get(slug);
    if (!row || (excludeId && row.id === excludeId)) return slug;
    slug = `${root}-${n++}`;
  }
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

/** SQLite хранит datetime('now') в UTC без зоны — приводим к Date. */
function parseDbDate(s) {
  if (!s) return null;
  if (s instanceof Date) return s;
  return new Date(String(s).replace(' ', 'T') + (String(s).endsWith('Z') ? '' : 'Z'));
}

function timeAgo(s) {
  const d = parseDbDate(s);
  if (!d) return '';
  const sec = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (sec < 60) return 'только что';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} ${plural(min, 'минуту', 'минуты', 'минут')} назад`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ${plural(h, 'час', 'часа', 'часов')} назад`;
  const days = Math.round(h / 24);
  if (days === 1) return 'вчера';
  if (days < 7) return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`;
  return formatDate(s);
}

function formatDate(s) {
  const d = parseDbDate(s);
  if (!d) return '';
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Moscow' });
}

function compactNumber(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace('.0', '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace('.0', '') + 'K';
  return String(n);
}

function formatChapterNumber(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/** Текущий день в формате YYYY-MM-DD (UTC) — ключ для daily_views. */
function today(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

/** Нормализует значение из query/body в массив непустых строк. */
function toArray(v) {
  if (v === undefined || v === null || v === '') return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  return [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))];
}

function toInt(v, def = null) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

/** Нижний регистр с поддержкой кириллицы (SQLite LOWER работает только с ASCII). */
function searchNormalize(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (m) => '\\' + m);
}

module.exports = {
  slugify,
  uniqueSlug,
  plural,
  parseDbDate,
  timeAgo,
  formatDate,
  compactNumber,
  formatChapterNumber,
  today,
  toArray,
  toInt,
  searchNormalize,
  escapeLike,
};
