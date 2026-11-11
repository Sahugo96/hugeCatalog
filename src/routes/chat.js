'use strict';

const express = require('express');
const { q } = require('../db');
const realtime = require('../realtime');
const Chat = require('../services/chat');
const N = require('../services/notify');
const { requireAuth, isStaff, isAdmin } = require('../auth');
const { toInt } = require('../util');

const router = express.Router();

/* ---------- Поток событий ---------- */

router.get('/api/stream', (req, res) => realtime.connect(req, res));

router.get('/api/me/counters', requireAuth, (req, res) => res.json(N.counters(req.user.id)));

/* ---------- Общий чат ---------- */

router.get('/api/chat/global', (req, res) => {
  res.json({ messages: Chat.globalMessages(toInt(req.query.before)), online: realtime.onlineCount() });
});

router.post('/api/chat/global', requireAuth, (req, res) => {
  res.json({ message: Chat.sendGlobal(req.user, req.body.body) });
});

/* ---------- Личные сообщения ---------- */

router.get('/api/chat/conversations', requireAuth, (req, res) => {
  res.json({ conversations: Chat.conversationsOf(req.user.id) });
});

router.post('/api/chat/conversations', requireAuth, (req, res) => {
  const id = Chat.openConversation(req.user, req.body.username);
  const conv = Chat.getConversation(id);
  const other = Chat.otherOf(conv, req.user.id);
  res.json({ id, other: { ...other, online: realtime.isOnline(other.id) }, blocked: Chat.isBlocked(req.user.id, other.id) });
});

function loadConversation(req, res, next) {
  const conv = Chat.getConversation(toInt(req.params.id));
  if (!Chat.isParticipant(conv, req.user.id)) return res.status(404).json({ error: 'Переписка не найдена' });
  req.conv = conv;
  next();
}

router.get('/api/chat/conversations/:id/messages', requireAuth, loadConversation, (req, res) => {
  const other = Chat.otherOf(req.conv, req.user.id);
  res.json({
    messages: Chat.conversationMessages(req.conv.id, toInt(req.query.before)),
    other: { ...other, online: realtime.isOnline(other.id) },
    blocked: Chat.isBlocked(req.user.id, other.id),
  });
});

router.post('/api/chat/conversations/:id/messages', requireAuth, loadConversation, (req, res) => {
  res.json({ message: Chat.sendDirect(req.user, req.conv.id, req.body.body) });
});

router.post('/api/chat/conversations/:id/read', requireAuth, loadConversation, (req, res) => {
  Chat.markRead(req.user, req.conv.id, toInt(req.body.last_id));
  res.json({ ok: true });
});

router.post('/api/chat/block', requireAuth, (req, res) => {
  res.json(Chat.toggleBlock(req.user, req.body.username));
});

router.post('/api/chat/messages/:id/delete', requireAuth, (req, res) => {
  const id = toInt(req.params.id);
  const m = q('SELECT conversation_id FROM chat_messages WHERE id = ?').get(id);
  // Модераторы удаляют сообщения общего чата прямо из окна чата.
  const asStaff = !!m && ((isStaff(req.user) && !m.conversation_id) || isAdmin(req.user));
  Chat.deleteMessage(req.user, id, { asStaff });
  res.json({ ok: true });
});

router.post('/api/chat/messages/:id/report', requireAuth, (req, res) => {
  Chat.report(req.user, toInt(req.params.id), req.body.reason);
  res.json({ ok: true });
});

/* ---------- Уведомления ---------- */

router.get('/api/notifications', requireAuth, (req, res) => {
  const items = q('SELECT id, type, title, body, link, is_read, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 15').all(req.user.id);
  res.json({
    items: items.map((n) => ({ ...n, title: req.__(n.title), body: req.__(n.body), created_at: n.created_at.replace(' ', 'T') + 'Z' })),
    counters: N.counters(req.user.id),
  });
});

router.post('/api/notifications/read', requireAuth, (req, res) => {
  const id = toInt(req.body.id);
  if (id) q('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(id, req.user.id);
  else q('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
  N.pushCounters([req.user.id]);
  if (req.xhr || (req.get('accept') || '').includes('json')) return res.json(N.counters(req.user.id));
  res.redirect('/notifications');
});

router.get('/notifications', requireAuth, (req, res) => {
  const page = Math.max(1, toInt(req.query.page, 1));
  const total = q('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?').get(req.user.id).n;
  const items = q('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30 OFFSET ?').all(req.user.id, (page - 1) * 30);
  res.render('user/notifications', { title: 'Уведомления', items, page, pages: Math.max(1, Math.ceil(total / 30)) });
});

/** Переход по уведомлению: отмечаем прочитанным и ведём по ссылке. */
router.get('/notifications/:id/go', requireAuth, (req, res) => {
  const n = q('SELECT id, link FROM notifications WHERE id = ? AND user_id = ?').get(toInt(req.params.id), req.user.id);
  if (!n) return res.redirect('/notifications');
  q('UPDATE notifications SET is_read = 1 WHERE id = ?').run(n.id);
  N.pushCounters([req.user.id]);
  const link = n.link && n.link.startsWith('/') && !n.link.startsWith('//') ? n.link : '/notifications';
  res.redirect(link);
});

module.exports = router;
