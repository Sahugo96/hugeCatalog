'use strict';

const express = require('express');
const { q, db } = require('../db');
const W = require('../services/works');
const { importWorks } = require('../services/import');
const C = require('../constants');
const { requireStaff, requireAdmin } = require('../auth');
const { uniqueSlug, toInt, searchNormalize, escapeLike } = require('../util');

const router = express.Router();
router.use(requireStaff);

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const MOD_STATUSES = ['pending', 'approved', 'rejected'];

router.get('/', (req, res) => {
  const counts = q(`SELECT
    (SELECT COUNT(*) FROM works WHERE moderation = 'pending') AS pending_works,
    (SELECT COUNT(*) FROM teams WHERE status = 'pending') AS pending_teams,
    (SELECT COUNT(*) FROM users) AS users,
    (SELECT COUNT(*) FROM users WHERE created_at >= datetime('now', '-1 day')) AS new_users,
    (SELECT COUNT(*) FROM works WHERE moderation = 'approved') AS works,
    (SELECT COUNT(*) FROM chapters) AS chapters,
    (SELECT COUNT(*) FROM chapters WHERE created_at >= datetime('now', '-1 day')) AS new_chapters,
    (SELECT COALESCE(SUM(views + reads), 0) FROM daily_views WHERE day = date('now')) AS views_today`).get();
  res.render('admin/index', { title: 'Админ-панель', counts, stats: W.siteStats() });
});

/* ---------- Модерация команд ---------- */

router.get('/teams', (req, res) => {
  const status = MOD_STATUSES.includes(req.query.status) ? req.query.status : 'pending';
  const teams = q(`SELECT t.*, u.username AS owner_name,
      (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) AS members_count,
      (SELECT COUNT(*) FROM works WHERE team_id = t.id) AS works_count
    FROM teams t JOIN users u ON u.id = t.owner_id WHERE t.status = ? ORDER BY t.created_at ${status === 'pending' ? 'ASC' : 'DESC'}`).all(status);
  res.render('admin/teams', { title: 'Модерация команд', teams, status });
});

router.post('/teams/:id/approve', (req, res) => {
  q(`UPDATE teams SET status = 'approved', reject_reason = NULL, reviewed_at = ? WHERE id = ?`).run(now(), toInt(req.params.id));
  req.flash('success', 'Команда одобрена.');
  res.redirect('/admin/teams');
});

router.post('/teams/:id/reject', (req, res) => {
  const reason = String(req.body.reason || '').trim().slice(0, 500) || 'Без указания причины';
  q(`UPDATE teams SET status = 'rejected', reject_reason = ?, reviewed_at = ? WHERE id = ?`).run(reason, now(), toInt(req.params.id));
  req.flash('success', 'Заявка отклонена.');
  res.redirect('/admin/teams');
});

/* ---------- Модерация произведений ---------- */

router.get('/works', (req, res) => {
  const status = MOD_STATUSES.includes(req.query.status) ? req.query.status : 'pending';
  const search = String(req.query.q || '').trim();
  const params = [status];
  let extra = '';
  if (search) {
    extra = `AND w.search_text LIKE ? ESCAPE '\\'`;
    params.push(`%${escapeLike(searchNormalize(search))}%`);
  }
  const works = W.attachCardGenres(q(`SELECT ${W.CARD}, w.moderation, w.reject_reason, w.created_at, w.description,
      t.name AS team_name, t.slug AS team_slug, u.username AS uploader_name
    FROM works w LEFT JOIN teams t ON t.id = w.team_id LEFT JOIN users u ON u.id = w.uploader_id
    WHERE w.moderation = ? ${extra} ORDER BY w.created_at ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT 200`).all(...params));
  res.render('admin/works', { title: 'Модерация произведений', works, status, search });
});

router.post('/works/:id/approve', (req, res) => {
  const id = toInt(req.params.id);
  q(`UPDATE works SET moderation = 'approved', reject_reason = NULL, published_at = COALESCE(published_at, ?) WHERE id = ?`).run(now(), id);
  W.bumpTextIndex();
  req.flash('success', 'Произведение опубликовано.');
  res.redirect(String(req.body.back || '').startsWith('/') && !String(req.body.back).startsWith('//') ? req.body.back : '/admin/works');
});

router.post('/works/:id/reject', (req, res) => {
  const reason = String(req.body.reason || '').trim().slice(0, 1000) || 'Без указания причины';
  q(`UPDATE works SET moderation = 'rejected', reject_reason = ? WHERE id = ?`).run(reason, toInt(req.params.id));
  W.bumpTextIndex();
  req.flash('success', 'Произведение отклонено, команда увидит причину в студии.');
  res.redirect('/admin/works');
});

/* ---------- Импорт произведений из JSON ---------- */

router.get('/import', (req, res) => {
  res.render('admin/import', { title: 'Импорт произведений', json: '', report: null, error: null, options: {} });
});

router.post('/import', async (req, res) => {
  const json = String(req.body.json || '');
  const options = { createMissing: !!req.body.create_missing, skipCovers: !!req.body.skip_covers };
  let data;
  try {
    data = JSON.parse(json);
  } catch (err) {
    return res.status(400).render('admin/import', { title: 'Импорт произведений', json, report: null, options, error: `Ошибка в JSON: ${err.message}` });
  }
  const report = await importWorks(data, { ...options, uploaderId: req.user.id });
  res.render('admin/import', { title: 'Импорт произведений', json: '', report, error: null, options });
});

/* ---------- Пользователи (только админ) ---------- */

router.get('/users', requireAdmin, (req, res) => {
  const search = String(req.query.q || '').trim();
  const users = search
    ? q(`SELECT * FROM users WHERE username LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 100`)
      .all(`%${escapeLike(search)}%`, `%${escapeLike(search)}%`)
    : q('SELECT * FROM users ORDER BY created_at DESC LIMIT 100').all();
  res.render('admin/users', { title: 'Пользователи', users, search });
});

router.post('/users/:id/role', requireAdmin, (req, res) => {
  const id = toInt(req.params.id);
  const role = String(req.body.role);
  if (!C.values(C.ROLES).includes(role)) return res.redirect('/admin/users');
  if (id === req.user.id && role !== 'admin') {
    req.flash('error', 'Нельзя снять права администратора с самого себя.');
  } else {
    q('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    req.flash('success', 'Роль изменена.');
  }
  res.redirect('/admin/users' + (req.body.q ? `?q=${encodeURIComponent(req.body.q)}` : ''));
});

router.post('/users/:id/ban', requireAdmin, (req, res) => {
  const id = toInt(req.params.id);
  if (id === req.user.id) {
    req.flash('error', 'Нельзя заблокировать самого себя.');
  } else {
    q('UPDATE users SET is_banned = 1 - is_banned WHERE id = ?').run(id);
    q(`DELETE FROM sessions WHERE json_extract(data, '$.userId') = ?`).run(id);
    req.flash('success', 'Статус блокировки изменён.');
  }
  res.redirect('/admin/users' + (req.body.q ? `?q=${encodeURIComponent(req.body.q)}` : ''));
});

/* ---------- Жанры, теги, авторы ---------- */

router.get('/taxonomy', (req, res) => {
  const genres = q(`SELECT g.*, (SELECT COUNT(*) FROM work_genres WHERE genre_id = g.id) AS n FROM genres g ORDER BY g.name`).all();
  const tags = q(`SELECT t.*, (SELECT COUNT(*) FROM work_tags WHERE tag_id = t.id) AS n FROM tags t ORDER BY t.tag_group, t.name`).all();
  const authors = q(`SELECT a.*, (SELECT COUNT(DISTINCT work_id) FROM work_authors WHERE author_id = a.id) AS n FROM authors a ORDER BY a.name`).all();
  res.render('admin/taxonomy', { title: 'Жанры, теги и авторы', genres, tagGroups: W.tagsByGroup(tags), authors });
});

function taxonomyRoutes(table, label, hasGroup) {
  router.post(`/${table}`, (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 60);
    const group = hasGroup && C.TAG_GROUPS.includes(req.body.tag_group) ? req.body.tag_group : 'Прочее';
    if (!name) req.flash('error', 'Укажите название.');
    else if (q(`SELECT 1 FROM ${table} WHERE name = ?`).get(name)) req.flash('error', `${label} «${name}» уже существует.`);
    else {
      if (hasGroup) q(`INSERT INTO ${table} (name, slug, tag_group) VALUES (?, ?, ?)`).run(name, uniqueSlug(db, table, name), group);
      else q(`INSERT INTO ${table} (name, slug) VALUES (?, ?)`).run(name, uniqueSlug(db, table, name));
      req.flash('success', `${label} «${name}» добавлен.`);
    }
    res.redirect(`/admin/taxonomy#${table}`);
  });

  router.post(`/${table}/:id`, (req, res) => {
    const id = toInt(req.params.id);
    const name = String(req.body.name || '').trim().slice(0, 120);
    if (!name) {
      req.flash('error', 'Название не может быть пустым.');
    } else if (q(`SELECT 1 FROM ${table} WHERE name = ? AND id != ?`).get(name, id)) {
      req.flash('error', `«${name}» уже существует.`);
    } else {
      q(`UPDATE ${table} SET name = ? WHERE id = ?`).run(name, id);
      if (hasGroup && C.TAG_GROUPS.includes(req.body.tag_group)) q(`UPDATE ${table} SET tag_group = ? WHERE id = ?`).run(req.body.tag_group, id);
      if (table === 'authors') {
        // Обновляем поисковый текст произведений этого автора.
        q(`SELECT DISTINCT work_id FROM work_authors WHERE author_id = ?`).all(id).forEach(({ work_id }) => {
          const w = W.getWorkById(work_id);
          const text = searchNormalize([w.title, w.alt_titles, ...w.authors.map((a) => a.name)].join(' '));
          q('UPDATE works SET search_text = ? WHERE id = ?').run(text, work_id);
        });
      }
      if (hasGroup) W.bumpTextIndex();
      req.flash('success', 'Сохранено.');
    }
    res.redirect(`/admin/taxonomy#${table}`);
  });

  router.post(`/${table}/:id/delete`, (req, res) => {
    q(`DELETE FROM ${table} WHERE id = ?`).run(toInt(req.params.id));
    req.flash('success', 'Удалено.');
    res.redirect(`/admin/taxonomy#${table}`);
  });
}

taxonomyRoutes('genres', 'Жанр', false);
taxonomyRoutes('tags', 'Тег', true);
taxonomyRoutes('authors', 'Автор', false);

module.exports = router;
