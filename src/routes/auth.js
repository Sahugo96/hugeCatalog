'use strict';

const express = require('express');
const { q } = require('../db');
const { hashPassword, verifyPassword, rateLimit } = require('../auth');

const router = express.Router();
const limiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 20 });

function safeReturnTo(url) {
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') ? url : '/';
}

function login(req, userId, cb) {
  const returnTo = req.session.returnTo;
  req.session.regenerate((err) => {
    if (err) return cb(err);
    req.session.userId = userId;
    cb(null, safeReturnTo(returnTo));
  });
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('auth/login', { title: 'Вход', form: {}, error: null });
});

router.post('/login', limiter, (req, res, next) => {
  const login_ = String(req.body.login || '').trim();
  const password = String(req.body.password || '');
  const user = q('SELECT id, password_hash, is_banned FROM users WHERE username = ? OR email = ?').get(login_, login_);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(400).render('auth/login', { title: 'Вход', form: { login: login_ }, error: 'Неверный логин или пароль.' });
  }
  if (user.is_banned) {
    return res.status(403).render('auth/login', { title: 'Вход', form: { login: login_ }, error: 'Аккаунт заблокирован администрацией.' });
  }
  login(req, user.id, (err, to) => {
    if (err) return next(err);
    res.redirect(to);
  });
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('auth/register', { title: 'Регистрация', form: {}, errors: [] });
});

router.post('/register', limiter, (req, res, next) => {
  const form = {
    username: String(req.body.username || '').trim(),
    email: String(req.body.email || '').trim(),
  };
  const password = String(req.body.password || '');
  const password2 = String(req.body.password2 || '');
  const errors = [];
  if (!/^[A-Za-zА-Яа-яЁё0-9_.-]{3,24}$/.test(form.username)) {
    errors.push('Имя пользователя: 3–24 символа, буквы, цифры, «_», «.», «-».');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email) || form.email.length > 200) errors.push('Укажите корректный e-mail.');
  if (password.length < 8) errors.push('Пароль должен быть не короче 8 символов.');
  if (password !== password2) errors.push('Пароли не совпадают.');
  if (!req.body.agree) errors.push('Необходимо согласиться с политикой конфиденциальности.');
  if (!errors.length) {
    if (q('SELECT 1 FROM users WHERE username = ?').get(form.username)) errors.push('Это имя пользователя уже занято.');
    if (q('SELECT 1 FROM users WHERE email = ?').get(form.email)) errors.push('Этот e-mail уже зарегистрирован.');
  }
  if (errors.length) return res.status(400).render('auth/register', { title: 'Регистрация', form, errors });

  const result = q('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)')
    .run(form.username, form.email, hashPassword(password));
  login(req, Number(result.lastInsertRowid), (err, to) => {
    if (err) return next(err);
    req.flash('success', `Добро пожаловать, ${form.username}! Теперь вы можете ставить лайки, добавлять в избранное и создать свою команду.`);
    res.redirect(to);
  });
});

router.post('/logout', (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('hc.sid');
    res.redirect('/');
  });
});

module.exports = router;
