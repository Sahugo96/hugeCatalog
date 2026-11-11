'use strict';

const express = require('express');
const { q, db } = require('../db');
const W = require('../services/works');
const { importWorks } = require('../services/import');
const C = require('../constants');
const { requireStaff, requireAdmin, isAdmin } = require('../auth');
const Chat = require('../services/chat');
const N = require('../services/notify');
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
    (SELECT COALESCE(SUM(reads), 0) FROM daily_views WHERE day = date('now')) AS views_today,
    (SELECT COUNT(*) FROM chat_reports WHERE resolved_at IS NULL) AS open_reports`).get();
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
  const teamId = toInt(req.params.id);
  q(`UPDATE teams SET status = 'approved', reject_reason = NULL, reviewed_at = ? WHERE id = ?`).run(now(), teamId);
  const team = q('SELECT name, slug, owner_id FROM teams WHERE id = ?').get(teamId);
  if (team) N.notify([team.owner_id], { type: 'team_approved', title: `Команда «${team.name}» одобрена`, body: 'Теперь вы можете добавлять участников и загружать произведения.', link: `/team/${team.slug}` });
  req.flash('success', 'Команда одобрена.');
  res.redirect('/admin/teams');
});

router.post('/teams/:id/reject', (req, res) => {
  const reason = String(req.body.reason || '').trim().slice(0, 500) || 'Без указания причины';
  q(`UPDATE teams SET status = 'rejected', reject_reason = ?, reviewed_at = ? WHERE id = ?`).run(reason, now(), toInt(req.params.id));
  const team = q('SELECT name, slug, owner_id FROM teams WHERE id = ?').get(toInt(req.params.id));
  if (team) N.notify([team.owner_id], { type: 'team_rejected', title: `Заявка команды «${team.name}» отклонена`, body: `Причина: ${reason}`, link: `/team/${team.slug}` });
  req.flash('success', 'Заявка отклонена.');
  res.redirect('/admin/teams');
});

/* ---------- Модерация произведений ---------- */

/** Уведомить загрузившего и участников команды произведения. */
function notifyWorkTeam(workId, actorId, build) {
  const w = q('SELECT id, slug, title, uploader_id, team_id FROM works WHERE id = ?').get(workId);
  if (!w) return;
  N.notify([w.uploader_id, ...N.teamMemberIds(w.team_id)].filter(Boolean), build(w), { exclude: [actorId] });
}

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
  notifyWorkTeam(id, req.user.id, (w) => ({ type: 'work_approved', title: `«${w.title}» опубликовано`, body: 'Произведение прошло модерацию и появилось в каталоге.', link: `/title/${w.slug}` }));
  W.bumpTextIndex();
  req.flash('success', 'Произведение опубликовано.');
  res.redirect(String(req.body.back || '').startsWith('/') && !String(req.body.back).startsWith('//') ? req.body.back : '/admin/works');
});

/** Причина «admin» у администратора — команда полного удаления произведения из базы. */
const DELETE_COMMAND = 'admin';

router.post('/works/:id/reject', (req, res) => {
  const reason = String(req.body.reason || '').trim().slice(0, 1000) || 'Без указания причины';
  if (reason.toLowerCase() === DELETE_COMMAND && isAdmin(req.user)) {
    const work = q('SELECT id, title, cover, group_id, uploader_id, team_id FROM works WHERE id = ?').get(toInt(req.params.id));
    if (work) {
      const recipients = [work.uploader_id, ...N.teamMemberIds(work.team_id)].filter(Boolean);
      W.deleteWork(work);
      Chat.log(req.user.id, 'delete_work', `work:${work.id}`, work.title);
      N.notify(recipients, { type: 'work_rejected', title: `«${work.title}» удалено администрацией`, body: '', link: '/studio' }, { exclude: [req.user.id] });
      req.flash('success', `«${work.title}» полностью удалено из базы.`);
    }
    return res.redirect('/admin/works' + (req.body.status ? `?status=${encodeURIComponent(req.body.status)}` : ''));
  }
  q(`UPDATE works SET moderation = 'rejected', reject_reason = ? WHERE id = ?`).run(reason, toInt(req.params.id));
  notifyWorkTeam(toInt(req.params.id), req.user.id, (w) => ({ type: 'work_rejected', title: `«${w.title}» отклонено`, body: `Причина: ${reason}`, link: `/studio/works/${w.id}` }));
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

/* ---------- Модерация чата ---------- */

const CHAT_TABS = ['reports', 'global', 'dms', 'search', 'log'];

router.get('/chat', (req, res) => {
  let tab = CHAT_TABS.includes(req.query.tab) ? req.query.tab : 'reports';
  if (['dms', 'search', 'log'].includes(tab) && !isAdmin(req.user)) tab = 'reports';
  const data = { tab, search: String(req.query.q || '').trim(), userFilter: String(req.query.user || '').trim() };

  if (tab === 'reports') {
    data.reports = q(`SELECT r.id, r.reason, r.created_at, r.message_id, ru.username AS reporter,
        m.body, m.conversation_id, m.deleted_at, m.created_at AS message_at, su.id AS sender_id, su.username AS sender, su.chat_muted_until,
        (SELECT COUNT(*) FROM chat_reports r2 WHERE r2.message_id = r.message_id AND r2.resolved_at IS NULL) AS reports_count
      FROM chat_reports r JOIN chat_messages m ON m.id = r.message_id
      JOIN users ru ON ru.id = r.reporter_id JOIN users su ON su.id = m.sender_id
      WHERE r.resolved_at IS NULL ORDER BY r.id DESC LIMIT 200`).all();
  } else if (tab === 'global') {
    data.messages = q(`${Chat.SELECT_MSG} WHERE m.conversation_id IS NULL ORDER BY m.id DESC LIMIT 200`).all();
  } else if (tab === 'dms') {
    const params = [];
    let where = 'c.last_message_at IS NOT NULL';
    if (data.userFilter) {
      where += ' AND (ua.username = ? OR ub.username = ?)';
      params.push(data.userFilter, data.userFilter);
    }
    data.conversations = q(`SELECT c.id, c.last_message_at, ua.username AS a_name, ub.username AS b_name,
        (SELECT COUNT(*) FROM chat_messages WHERE conversation_id = c.id) AS n
      FROM conversations c JOIN users ua ON ua.id = c.user_a JOIN users ub ON ub.id = c.user_b
      WHERE ${where} ORDER BY c.last_message_at DESC LIMIT 300`).all(...params);
  } else if (tab === 'search') {
    const params = [];
    const where = [];
    if (data.search) { where.push(`m.body LIKE ? ESCAPE '\\'`); params.push(`%${escapeLike(data.search)}%`); }
    if (data.userFilter) { where.push('u.username = ?'); params.push(data.userFilter); }
    data.messages = where.length
      ? q(`${Chat.SELECT_MSG} WHERE ${where.join(' AND ')} ORDER BY m.id DESC LIMIT 300`).all(...params)
      : [];
    if (where.length) Chat.log(req.user.id, 'search_messages', data.userFilter ? `user:${data.userFilter}` : '', data.search);
  } else if (tab === 'log') {
    data.log = q(`SELECT l.*, u.username AS actor FROM moderation_log l LEFT JOIN users u ON u.id = l.actor_id ORDER BY l.id DESC LIMIT 300`).all();
  }
  data.openReports = q('SELECT COUNT(*) AS n FROM chat_reports WHERE resolved_at IS NULL').get().n;
  res.render('admin/chat', { title: 'Модерация чата', ...data });
});

router.get('/chat/conversations/:id', requireAdmin, (req, res, next) => {
  const conv = Chat.getConversation(toInt(req.params.id));
  if (!conv) return next();
  Chat.log(req.user.id, 'view_conversation', `conversation:${conv.id}`, `${conv.a_name} ↔ ${conv.b_name}`);
  const messages = q(`${Chat.SELECT_MSG} WHERE m.conversation_id = ? ORDER BY m.id ASC LIMIT 2000`).all(conv.id);
  res.render('admin/conversation', { title: `Переписка ${conv.a_name} ↔ ${conv.b_name}`, conv, messages });
});

function backTo(req, fallback) {
  const back = String(req.body.back || '');
  return back.startsWith('/admin/') ? back : fallback;
}

router.post('/chat/messages/:id/delete', (req, res) => {
  const id = toInt(req.params.id);
  const m = q('SELECT conversation_id FROM chat_messages WHERE id = ?').get(id);
  const reported = q('SELECT 1 FROM chat_reports WHERE message_id = ?').get(id);
  // Модератор удаляет сообщения общего чата и те, на которые пожаловались; админ — любые.
  if (m && (isAdmin(req.user) || !m.conversation_id || reported)) {
    try {
      Chat.deleteMessage(req.user, id, { asStaff: true });
      q(`UPDATE chat_reports SET resolved_at = datetime('now'), resolved_by = ? WHERE message_id = ? AND resolved_at IS NULL`).run(req.user.id, id);
      req.flash('success', 'Сообщение удалено.');
    } catch (err) {
      req.flash('error', err.message);
    }
  }
  res.redirect(backTo(req, '/admin/chat'));
});

router.post('/chat/reports/:id/resolve', (req, res) => {
  const r = q('SELECT message_id FROM chat_reports WHERE id = ?').get(toInt(req.params.id));
  if (r) {
    q(`UPDATE chat_reports SET resolved_at = datetime('now'), resolved_by = ? WHERE message_id = ? AND resolved_at IS NULL`).run(req.user.id, r.message_id);
    Chat.log(req.user.id, 'dismiss_report', `message:${r.message_id}`);
    req.flash('success', 'Жалоба отклонена.');
  }
  res.redirect('/admin/chat?tab=reports');
});

router.post('/chat/mute/:userId', (req, res) => {
  const uid = toInt(req.params.userId);
  const target = q('SELECT id, username, role FROM users WHERE id = ?').get(uid);
  if (!target || target.id === req.user.id || (target.role !== 'user' && !isAdmin(req.user))) {
    req.flash('error', 'Нельзя ограничить этого пользователя.');
  } else {
    const hours = Math.max(0, toInt(req.body.hours, 0));
    Chat.muteUser(req.user, uid, hours);
    if (hours) {
      N.notify([uid], { type: 'mute', title: 'Ограничение в чате', body: `Вам запрещено писать в чат на ${hours >= 24 ? Math.round(hours / 24) + ' дн.' : hours + ' ч'} за нарушение правил.`, link: '/about#rules' });
    }
    req.flash('success', hours ? `${target.username}: запрет писать на ${hours} ч.` : `${target.username}: ограничение снято.`);
  }
  res.redirect(backTo(req, '/admin/chat'));
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
