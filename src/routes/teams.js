'use strict';

const express = require('express');
const { q, db } = require('../db');
const W = require('../services/works');
const N = require('../services/notify');
const { requireAuth, verifyCsrf, isStaff } = require('../auth');
const { coverUpload, storeImage, removePublic, cleanupTmp, detectImageExt } = require('../upload');
const { uniqueSlug, toInt } = require('../util');

const router = express.Router();
const MAX_TEAMS_PER_USER = 5;

router.get('/teams', (req, res) => {
  const teams = q(`SELECT t.*,
      (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) AS members_count,
      (SELECT COUNT(*) FROM works WHERE team_id = t.id AND moderation = 'approved') AS works_count
    FROM teams t WHERE t.status = 'approved' ORDER BY works_count DESC, t.name`).all();
  res.render('teams/list', { title: 'Команды', teams });
});

/* ---------- Заявка на создание команды ---------- */

function validateTeam(body) {
  const data = {
    name: String(body.name || '').trim().slice(0, 60),
    description: String(body.description || '').trim().slice(0, 3000),
  };
  const errors = [];
  if (data.name.length < 2) errors.push('Название команды — минимум 2 символа.');
  return { data, errors };
}

router.get('/teams/new', requireAuth, (req, res) => {
  const pending = q(`SELECT name FROM teams WHERE owner_id = ? AND status = 'pending'`).get(req.user.id);
  res.render('teams/form', { title: 'Создать команду', form: {}, errors: [], pending, team: null });
});

router.post('/teams/new', requireAuth, coverUpload.single('avatar'), verifyCsrf, (req, res) => {
  const { data, errors } = validateTeam(req.body);
  if (req.file && !detectImageExt(req.file.path)) errors.push('Аватар повреждён или не является изображением.');
  const owned = q('SELECT COUNT(*) AS n FROM teams WHERE owner_id = ?').get(req.user.id).n;
  if (owned >= MAX_TEAMS_PER_USER) errors.push(`Нельзя владеть более чем ${MAX_TEAMS_PER_USER} командами.`);
  if (q(`SELECT 1 FROM teams WHERE owner_id = ? AND status = 'pending'`).get(req.user.id)) {
    errors.push('У вас уже есть заявка на рассмотрении. Дождитесь решения модератора.');
  }
  if (q('SELECT 1 FROM teams WHERE name = ?').get(data.name)) errors.push('Команда с таким названием уже существует.');
  if (errors.length) {
    cleanupTmp(req);
    return res.status(400).render('teams/form', { title: 'Создать команду', form: data, errors, pending: null, team: null });
  }
  const slug = uniqueSlug(db, 'teams', data.name);
  const avatar = req.file ? storeImage(req.file, 'teams', slug + '-' + Date.now().toString(36)) : null;
  const res_ = q('INSERT INTO teams (name, slug, description, avatar, owner_id) VALUES (?, ?, ?, ?, ?)')
    .run(data.name, slug, data.description, avatar, req.user.id);
  q(`INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'owner')`).run(Number(res_.lastInsertRowid), req.user.id);
  N.notifyStaff({ type: 'team_pending', title: 'Новая заявка на команду', body: `«${data.name}» от ${req.user.username}`, link: '/admin/teams' });
  req.flash('success', 'Заявка отправлена! После одобрения модератором вы сможете загружать произведения.');
  res.redirect(`/team/${slug}`);
});

/* ---------- Страница команды ---------- */

function loadTeam(req) {
  const team = q(`SELECT t.*, u.username AS owner_name FROM teams t JOIN users u ON u.id = t.owner_id WHERE t.slug = ?`).get(req.params.slug);
  if (!team) return null;
  const me = req.user ? q('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?').get(team.id, req.user.id) : null;
  team.myRole = me ? me.role : null;
  team.isOwner = !!req.user && team.owner_id === req.user.id;
  if (team.status !== 'approved' && !team.myRole && !isStaff(req.user)) return null;
  return team;
}

router.get('/team/:slug', (req, res, next) => {
  const team = loadTeam(req);
  if (!team) return next();
  const members = q(`SELECT u.id, u.username, tm.role, tm.joined_at FROM team_members tm JOIN users u ON u.id = tm.user_id
    WHERE tm.team_id = ? ORDER BY tm.role = 'owner' DESC, tm.joined_at`).all(team.id);
  const works = W.attachCardGenres(q(`SELECT ${W.CARD} FROM works w WHERE w.team_id = ? AND w.moderation = 'approved'
    ORDER BY w.last_chapter_at DESC NULLS LAST`).all(team.id));
  const chaptersCount = q('SELECT COUNT(*) AS n FROM chapters WHERE team_id = ?').get(team.id).n;
  res.render('teams/show', { title: team.name, team, members, works, chaptersCount });
});

function ownerOnly(req, res, next) {
  const team = loadTeam(req);
  if (!team) return next('route');
  if (!team.isOwner && !isStaff(req.user)) {
    req.flash('error', 'Это действие доступно только владельцу команды.');
    return res.redirect(`/team/${team.slug}`);
  }
  req.team = team;
  next();
}

router.get('/team/:slug/edit', requireAuth, ownerOnly, (req, res) => {
  res.render('teams/form', { title: 'Редактирование команды', form: req.team, errors: [], pending: null, team: req.team });
});

router.post('/team/:slug/edit', requireAuth, coverUpload.single('avatar'), verifyCsrf, ownerOnly, (req, res) => {
  const team = req.team;
  const { data, errors } = validateTeam(req.body);
  if (req.file && !detectImageExt(req.file.path)) errors.push('Аватар повреждён или не является изображением.');
  const clash = q('SELECT id FROM teams WHERE name = ? AND id != ?').get(data.name, team.id);
  if (clash) errors.push('Команда с таким названием уже существует.');
  if (errors.length) cleanupTmp(req);
  if (errors.length) return res.status(400).render('teams/form', { title: 'Редактирование команды', form: { ...team, ...data }, errors, pending: null, team });
  let avatar = team.avatar;
  if (req.file) {
    avatar = storeImage(req.file, 'teams', team.slug + '-' + Date.now().toString(36));
    removePublic(team.avatar);
  }
  // Отклонённая заявка после правки снова уходит на модерацию. Переименование одобренной — тоже.
  const resubmit = team.status === 'rejected' || (team.status === 'approved' && data.name !== team.name && !isStaff(req.user));
  q(`UPDATE teams SET name = ?, description = ?, avatar = ?, status = CASE WHEN ? THEN 'pending' ELSE status END,
     reject_reason = CASE WHEN ? THEN NULL ELSE reject_reason END WHERE id = ?`)
    .run(data.name, data.description, avatar, resubmit ? 1 : 0, resubmit ? 1 : 0, team.id);
  req.flash('success', resubmit ? 'Изменения сохранены и отправлены на модерацию.' : 'Изменения сохранены.');
  res.redirect(`/team/${team.slug}`);
});

router.post('/team/:slug/members', requireAuth, ownerOnly, (req, res) => {
  const team = req.team;
  const username = String(req.body.username || '').trim();
  const user = q('SELECT id, username FROM users WHERE username = ?').get(username);
  if (!user) req.flash('error', `Пользователь «${username}» не найден.`);
  else if (q('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?').get(team.id, user.id)) req.flash('info', `${user.username} уже в команде.`);
  else {
    q(`INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'member')`).run(team.id, user.id);
    N.notify([user.id], { type: 'team_member', title: `Вас добавили в команду «${team.name}»`, body: `Добавил(а): ${req.user.username}`, link: `/team/${team.slug}` });
    req.flash('success', `${user.username} добавлен(а) в команду.`);
  }
  res.redirect(`/team/${team.slug}#members`);
});

router.post('/team/:slug/members/:uid/remove', requireAuth, ownerOnly, (req, res) => {
  const uid = toInt(req.params.uid);
  if (uid === req.team.owner_id) req.flash('error', 'Нельзя исключить владельца команды.');
  else {
    q('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(req.team.id, uid);
    req.flash('success', 'Участник исключён.');
  }
  res.redirect(`/team/${req.team.slug}#members`);
});

router.post('/team/:slug/leave', requireAuth, (req, res, next) => {
  const team = loadTeam(req);
  if (!team) return next();
  if (team.isOwner) {
    req.flash('error', 'Владелец не может покинуть команду. Передайте права через администратора или удалите заявку.');
  } else {
    q('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(team.id, req.user.id);
    req.flash('success', `Вы покинули команду «${team.name}».`);
  }
  res.redirect('/profile');
});

router.post('/team/:slug/delete', requireAuth, ownerOnly, (req, res) => {
  const team = req.team;
  if (team.status === 'approved' && !isStaff(req.user)) {
    req.flash('error', 'Одобренную команду может удалить только администрация.');
    return res.redirect(`/team/${team.slug}`);
  }
  q('DELETE FROM teams WHERE id = ?').run(team.id);
  removePublic(team.avatar);
  req.flash('success', 'Команда удалена.');
  res.redirect(isStaff(req.user) ? '/admin/teams' : '/profile');
});

module.exports = router;
