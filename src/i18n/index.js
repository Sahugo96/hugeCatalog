'use strict';

/**
 * Локализация интерфейса: русский (исходный) и английский.
 *
 * Ключ перевода — сама русская строка: __('Каталог') → 'Catalog'.
 * Строки с подстановками описываются шаблонами: 'Глава {n} уже существует.' → 'Chapter {n} already exists.'
 * Такой шаблон срабатывает и для уже собранной строки («Глава 5 уже существует.»), поэтому серверный код
 * может по-прежнему формировать сообщения на русском, а перевод выполняется при выводе.
 * Подставленные значения тоже переводятся, если для них есть точный перевод (например, названия жанров).
 * Непереведённая строка выводится как есть (по-русски).
 */

const util = require('../util');
const { EN, PLURALS } = require('./en');

const LANGS = ['ru', 'en'];
const DEFAULT_LANG = 'ru';

// Шаблоны с плейсхолдерами {name} компилируются в регулярные выражения.
const PATTERNS = Object.keys(EN)
  .filter((k) => /\{\w+\}/.test(k))
  .map((k) => {
    const names = [];
    const source = k.split(/(\{\w+\})/).map((part) => {
      const m = part.match(/^\{(\w+)\}$/);
      if (m) {
        names.push(m[1]);
        return '([\\s\\S]+?)';
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('');
    return { re: new RegExp(`^${source}$`), names, en: EN[k] };
  })
  // Более длинные (конкретные) шаблоны проверяем первыми.
  .sort((a, b) => b.re.source.length - a.re.source.length);

function interpolate(str, vars) {
  if (!vars) return str;
  return str.replace(/\{(\w+)\}/g, (m, name) => (vars[name] !== undefined && vars[name] !== null ? String(vars[name]) : m));
}

const cache = new Map();

/**
 * Переводы из базы (английские названия жанров и тегов из админки).
 * Имеют приоритет над словарём и обновляются без перезапуска сервера.
 */
let overrides = new Map();
function setOverrides(map) {
  overrides = map;
  cache.clear();
}

/** Точный перевод: база → словарь → undefined. */
function lookup(str) {
  if (overrides.has(str)) return overrides.get(str);
  if (Object.prototype.hasOwnProperty.call(EN, str)) return EN[str];
  return undefined;
}

/** Перевод строки на английский (без подстановки vars). */
function toEnglish(str) {
  const exact = lookup(str);
  if (exact !== undefined) return exact;
  if (cache.has(str)) return cache.get(str);
  let result = str;
  for (const p of PATTERNS) {
    const m = p.re.exec(str);
    if (!m) continue;
    const values = {};
    p.names.forEach((name, i) => {
      const v = m[i + 1];
      const t = lookup(v);
      values[name] = t !== undefined ? t : v;
    });
    result = interpolate(p.en, values);
    break;
  }
  if (cache.size > 5000) cache.clear();
  cache.set(str, result);
  return result;
}

function translate(lang, str, vars) {
  if (str === undefined || str === null) return '';
  str = String(str);
  if (lang !== 'en') return interpolate(str, vars);
  if (vars) {
    // Сначала переводим шаблон целиком, потом подставляем значения (тоже переведённые, если есть перевод).
    const tpl = lookup(str) !== undefined ? lookup(str) : str;
    const translatedVars = {};
    Object.keys(vars).forEach((k) => {
      const v = vars[k];
      const t = typeof v === 'string' ? lookup(v) : undefined;
      translatedVars[k] = t !== undefined ? t : v;
    });
    return interpolate(tpl, translatedVars);
  }
  return toEnglish(str);
}

/** Множественное число: __n(5, 'глава', 'главы', 'глав'). */
function plural(lang, n, one, few, many) {
  if (lang === 'en') {
    const forms = PLURALS[one];
    if (forms) return Math.abs(n) === 1 ? forms[0] : forms[1];
  }
  return util.plural(n, one, few, many);
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

/** Язык: cookie «lang» → заголовок Accept-Language → русский. */
function detect(req) {
  const fromCookie = parseCookies(req.headers.cookie).lang;
  if (LANGS.includes(fromCookie)) return fromCookie;
  const best = req.acceptsLanguages(...LANGS);
  return LANGS.includes(best) ? best : DEFAULT_LANG;
}

/** Строки клиентских скриптов: английский словарь только для ключей, используемых в public/js. */
let clientDict = null;
function clientDictionary() {
  if (clientDict) return clientDict;
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', '..', 'public', 'js');
  const keys = new Set();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const m of src.matchAll(/\bT\('((?:[^'\\]|\\.)*)'/g)) keys.add(m[1].replace(/\\'/g, "'"));
  }
  clientDict = {};
  keys.forEach((k) => { clientDict[k] = translate('en', k); });
  return clientDict;
}

/** Middleware: req.lang, req.__ и помощники для шаблонов. */
function middleware(req, res, next) {
  const lang = detect(req);
  req.lang = lang;
  req.__ = (str, vars) => translate(lang, str, vars);
  res.locals.lang = lang;
  res.locals.__ = req.__;
  res.locals.__n = (n, one, few, many) => plural(lang, n, one, few, many);
  res.locals.clientI18n = lang === 'en' ? clientDictionary() : null;
  next();
}

module.exports = { LANGS, DEFAULT_LANG, translate, plural, detect, middleware, parseCookies, setOverrides, dictionaryEN: EN };
