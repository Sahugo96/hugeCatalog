'use strict';

const express = require('express');
const { q } = require('../db');
const W = require('../services/works');
const { requireAuth, hashPassword, verifyPassword } = require('../auth');

const router = express.Router();

const TABS = {
  favorites: { label: 'Избранное', sql: `SELECT ${W.CARD} FROM favorites x JOIN works w ON w.id = x.work_id WHERE x.user_id = ? AND w.moderation = 'approved' ORDER BY x.created_at DESC` },
  likes: { label: 'Понравилось', sql: `SELECT ${W.CARD} FROM likes x JOIN works w ON w.id = x.work_id WHERE x.user_id = ? AND w.moderation = 'approved' ORDER BY x.created_at DESC` },
  history: { label: 'История чтения', sql: null },
};

router.get('/profile', requireAuth, (req, res) => {
  const tab = TABS[req.query.tab] ? req.query.tab : 'favorites';
  const items = tab === 'history'
    ? W.continueReading(req.user.id, 100)
    : W.attachCardGenres(q(TABS[tab].sql).all(req.user.id));
  const counts = q(`SELECT
    (SELECT COUNT(*) FROM favorites WHERE user_id = ?) AS favorites,
    (SELECT COUNT(*) FROM likes WHERE user_id = ?) AS likes,
    (SELECT COUNT(*) FROM reading_history WHERE user_id = ?) AS history`).get(req.user.id, req.user.id, req.user.id);
  const teams = q(`SELECT t.*, tm.role AS my_role FROM team_members tm JOIN teams t ON t.id = tm.team_id
    WHERE tm.user_id = ? ORDER BY t.created_at DESC`).all(req.user.id);
  res.render('user/profile', { title: 'Мой профиль', tab, tabs: TABS, items, counts, teams });
});

router.get('/settings', requireAuth, (req, res) => {
  res.render('user/settings', { title: 'Настройки', errors: [] });
});

router.post('/settings/profile', requireAuth, (req, res) => {
  const about = String(req.body.about || '').trim().slice(0, 1000);
  q('UPDATE users SET about = ? WHERE id = ?').run(about, req.user.id);
  req.flash('success', 'Профиль сохранён.');
  res.redirect('/settings');
});

router.post('/settings/password', requireAuth, (req, res) => {
  const row = q('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  const errors = [];
  if (!verifyPassword(String(req.body.current || ''), row.password_hash)) errors.push('Текущий пароль указан неверно.');
  if (String(req.body.password || '').length < 8) errors.push('Новый пароль должен быть не короче 8 символов.');
  if (req.body.password !== req.body.password2) errors.push('Пароли не совпадают.');
  if (errors.length) return res.status(400).render('user/settings', { title: 'Настройки', errors });
  q('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.password), req.user.id);
  q(`DELETE FROM sessions WHERE sid != ? AND json_extract(data, '$.userId') = ?`).run(req.sessionID, req.user.id);
  req.flash('success', 'Пароль изменён. Остальные сессии завершены.');
  res.redirect('/settings');
});

router.get('/user/:username', (req, res, next) => {
  const profile = q('SELECT id, username, role, about, created_at FROM users WHERE username = ?').get(req.params.username);
  if (!profile) return next();
  const teams = q(`SELECT t.name, t.slug, tm.role FROM team_members tm JOIN teams t ON t.id = tm.team_id
    WHERE tm.user_id = ? AND t.status = 'approved' ORDER BY t.name`).all(profile.id);
  const favorites = W.attachCardGenres(q(TABS.favorites.sql + ' LIMIT 18').all(profile.id));
  res.render('user/public', { title: profile.username, profile, teams, favorites });
});

module.exports = router;
