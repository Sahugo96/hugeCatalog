'use strict';

const crypto = require('node:crypto');
const { q } = require('./db');

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, SCRYPT_PARAMS);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [algo, saltB64, hashB64] = String(stored || '').split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, SCRYPT_PARAMS);
  return crypto.timingSafeEqual(expected, actual);
}

const isStaff = (user) => !!user && (user.role === 'admin' || user.role === 'moderator');
const isAdmin = (user) => !!user && user.role === 'admin';

/** Загружает текущего пользователя и его одобренные команды. */
function loadUser(req, res, next) {
  res.locals.user = null;
  res.locals.myTeams = [];
  const uid = req.session && req.session.userId;
  if (uid) {
    const user = q('SELECT id, username, email, role, is_banned, avatar, about, created_at FROM users WHERE id = ?').get(uid);
    if (!user || user.is_banned) {
      delete req.session.userId;
    } else {
      req.user = user;
      res.locals.user = user;
      res.locals.myTeams = q(
        `SELECT t.id, t.name, t.slug, tm.role FROM team_members tm
         JOIN teams t ON t.id = tm.team_id
         WHERE tm.user_id = ? AND t.status = 'approved' ORDER BY t.name`
      ).all(uid);
    }
  }
  res.locals.isStaff = isStaff(req.user);
  res.locals.isAdmin = isAdmin(req.user);
  next();
}

function wantsJson(req) {
  return req.xhr || (req.get('accept') || '').includes('application/json');
}

function requireAuth(req, res, next) {
  if (req.user) return next();
  if (wantsJson(req)) return res.status(401).json({ error: 'Нужно войти в аккаунт' });
  req.session.returnTo = req.originalUrl;
  req.flash('info', 'Войдите или зарегистрируйтесь, чтобы продолжить.');
  return res.redirect('/login');
}

function requireStaff(req, res, next) {
  if (isStaff(req.user)) return next();
  if (!req.user) return requireAuth(req, res, next);
  res.status(403);
  return res.render('error', { title: 'Доступ запрещён', message: 'Эта страница доступна только модераторам и администраторам.' });
}

function requireAdmin(req, res, next) {
  if (isAdmin(req.user)) return next();
  if (!req.user) return requireAuth(req, res, next);
  res.status(403);
  return res.render('error', { title: 'Доступ запрещён', message: 'Эта страница доступна только администраторам.' });
}

/* ---------- CSRF ---------- */

function csrfToken(req) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  return req.session.csrf;
}

function csrfLocals(req, res, next) {
  res.locals.csrfToken = csrfToken(req);
  next();
}

/** Проверка токена для небезопасных методов. Для multipart-форм вызывается после multer. */
function verifyCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token') || '';
  const expected = req.session.csrf || '';
  const ok = sent.length === expected.length && expected.length > 0 &&
    crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
  if (ok) return next();
  require('./upload').cleanupTmp(req);
  if (wantsJson(req)) return res.status(403).json({ error: 'Сессия устарела, обновите страницу' });
  res.status(403);
  return res.render('error', { title: 'Ошибка безопасности', message: 'Сессия устарела. Обновите страницу и попробуйте снова.' });
}

/* ---------- Flash-сообщения ---------- */

function flash(req, res, next) {
  req.flash = (type, message) => {
    req.session.flash = req.session.flash || [];
    req.session.flash.push({ type, message });
  };
  res.locals.flash = req.session.flash || [];
  if (req.session.flash) delete req.session.flash;
  next();
}

/* ---------- Простое ограничение частоты (для входа/регистрации) ---------- */

function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    if (req.method !== 'POST') return next();
    const key = req.ip;
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.reset < now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    if (entry.count > max) {
      res.status(429);
      return res.render('error', { title: 'Слишком много попыток', message: 'Подождите несколько минут и попробуйте снова.' });
    }
    next();
  };
}

/* ---------- Права на команды и произведения ---------- */

function teamRole(userId, teamId) {
  if (!userId || !teamId) return null;
  const row = q(
    `SELECT tm.role FROM team_members tm JOIN teams t ON t.id = tm.team_id
     WHERE tm.user_id = ? AND tm.team_id = ? AND t.status = 'approved'`
  ).get(userId, teamId);
  return row ? row.role : null;
}

/** Может ли пользователь редактировать произведение и загружать главы. */
function canEditWork(user, work) {
  if (!user || !work) return false;
  if (isStaff(user)) return true;
  if (work.team_id && teamRole(user.id, work.team_id)) return true;
  return false;
}

module.exports = {
  hashPassword,
  verifyPassword,
  loadUser,
  requireAuth,
  requireStaff,
  requireAdmin,
  csrfLocals,
  verifyCsrf,
  flash,
  rateLimit,
  isStaff,
  isAdmin,
  teamRole,
  canEditWork,
  wantsJson,
};
