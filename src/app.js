'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');

const SqliteStore = require('./session-store');
const { UPLOAD_DIR } = require('./db');
const auth = require('./auth');
const C = require('./constants');
const util = require('./util');
const { cleanupTmp } = require('./upload');
const { icon } = require('./icons');
const { flag } = require('./flags');
const i18n = require('./i18n');

/** Строит URL с query-параметрами. Массивы разворачиваются в повторяющиеся ключи, пустые значения пропускаются. */
function buildUrl(base, params = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    (Array.isArray(v) ? v : [v]).forEach((x) => x !== '' && x !== null && sp.append(k, String(x)));
  }
  const s = sp.toString();
  return s ? `${base}?${s}` : base;
}

/** Ссылка на каталог с одним критерием: catalogUrl('genre', 'boevik') */
function catalogUrl(key, value) {
  return buildUrl('/catalog', { [key]: value });
}

const SITE_NAME = process.env.SITE_NAME || 'HugeCatalog';

function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('В production задайте переменную окружения SESSION_SECRET');
  }
  return 'dev-secret-' + crypto.createHash('sha256').update(__dirname).digest('hex');
}

function createApp() {
  const app = express();
  const ROOT = path.join(__dirname, '..');

  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));
  app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);
  app.disable('x-powered-by');

  // Помощники, доступные во всех шаблонах.
  Object.assign(app.locals, {
    SITE_NAME,
    C,
    util,
    labelOf: C.labelOf,
    icon,
    flag: (lang, cls) => flag(lang, C.labelOf(C.LANGUAGES, lang), cls),
    buildUrl,
    catalogUrl,
    assetVersion: Date.now().toString(36),
  });

  // Базовые заголовки безопасности.
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    next();
  });

  app.use('/static', express.static(path.join(ROOT, 'public'), { maxAge: '7d' }));
  app.use('/uploads', express.static(UPLOAD_DIR, {
    maxAge: '30d',
    dotfiles: 'deny',
    setHeaders: (res) => res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox"),
  }));
  app.get('/favicon.ico', (req, res) => res.redirect(301, '/static/img/favicon.svg'));

  app.use(express.urlencoded({ extended: true, limit: '5mb' }));
  app.use(express.json({ limit: '100kb' }));

  app.use(session({
    store: new SqliteStore(),
    secret: sessionSecret(),
    name: 'hc.sid',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === '1',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  }));

  app.use(auth.flash);
  // Язык интерфейса и помощники шаблонов, зависящие от языка.
  app.use(i18n.middleware);
  app.use((req, res, next) => {
    const lang = req.lang;
    res.locals.util = { ...util, timeAgo: (s) => util.timeAgo(s, lang), formatDate: (s) => util.formatDate(s, lang) };
    res.locals.labelOf = (list, value) => req.__(C.labelOf(list, value));
    res.locals.flag = (code, cls) => flag(code, req.__(C.labelOf(C.LANGUAGES, code)), cls);
    next();
  });
  app.use(auth.loadUser);
  app.use(auth.csrfLocals);
  app.use((req, res, next) => {
    res.locals.currentPath = req.path;
    res.locals.currentUrl = req.originalUrl;
    res.locals.title = null;
    res.locals.description = null;
    next();
  });

  // Для обычных форм проверяем CSRF сразу; multipart-формы проверяются в роутерах после multer.
  app.use((req, res, next) => {
    if ((req.get('content-type') || '').startsWith('multipart/form-data')) return next();
    return auth.verifyCsrf(req, res, next);
  });

  app.use(require('./routes/chat'));
  app.use(require('./routes/auth'));
  app.use(require('./routes/public'));
  app.use(require('./routes/user'));
  app.use(require('./routes/teams'));
  app.use('/studio', require('./routes/studio'));
  app.use('/admin', require('./routes/admin'));

  app.use((req, res) => {
    res.status(404).render('error', { title: 'Страница не найдена', message: 'Такой страницы нет. Возможно, она была удалена или ещё не прошла модерацию.', code: 404 });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    cleanupTmp(req);
    let status = err.status || err.statusCode || 500;
    let message = err.expose || status < 500 ? err.message : 'Что-то пошло не так. Попробуйте позже.';
    if (err instanceof multer.MulterError) {
      status = 400;
      message = {
        LIMIT_FILE_SIZE: 'Файл слишком большой.',
        LIMIT_FILE_COUNT: 'Слишком много файлов.',
        LIMIT_UNEXPECTED_FILE: 'Неожиданное поле с файлом.',
      }[err.code] || 'Ошибка загрузки файла.';
    }
    if (status >= 500) console.error(err);
    if (req.__) message = req.__(message);
    if (auth.wantsJson(req)) return res.status(status).json({ error: message });
    res.status(status).render('error', { title: status >= 500 ? 'Ошибка сервера' : 'Ошибка', message, code: status });
  });

  return app;
}

module.exports = { createApp };
