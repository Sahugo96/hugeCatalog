'use strict';

const { q, transaction } = require('../db');
const realtime = require('../realtime');
const { translate } = require('../i18n');

function unreadNotifications(userId) {
  return q('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0').get(userId).n;
}

function unreadMessages(userId) {
  return q(`SELECT COUNT(*) AS n FROM chat_messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.sender_id != ? AND m.deleted_at IS NULL
      AND ((c.user_a = ? AND m.id > c.a_last_read) OR (c.user_b = ? AND m.id > c.b_last_read))
      AND m.sender_id NOT IN (SELECT blocked_id FROM user_blocks WHERE blocker_id = ?)`).get(userId, userId, userId, userId).n;
}

function counters(userId) {
  return { notifications: unreadNotifications(userId), messages: unreadMessages(userId) };
}

/** Разослать актуальные счётчики пользователям (после прочтения, нового сообщения и т.п.). */
function pushCounters(userIds) {
  for (const id of new Set(userIds)) realtime.toUsers([id], 'counters', counters(id));
}

/**
 * Создать уведомление одному или нескольким пользователям.
 * n: { type, title, body?, link? }; exclude — id, которым не отправлять (например, автору действия).
 */
function notify(userIds, n, { exclude = [] } = {}) {
  const ids = [...new Set(userIds.map(Number))].filter((id) => id && !exclude.includes(id));
  if (!ids.length) return;
  const ins = q('INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, ?, ?, ?, ?)');
  transaction(() => ids.forEach((id) => ins.run(id, n.type, n.title.slice(0, 200), (n.body || '').slice(0, 500), n.link || null)));
  for (const id of ids) {
    realtime.toUsers([id], 'notification', (lang) => ({ title: translate(lang, n.title), body: translate(lang, n.body || ''), link: n.link || null }));
    realtime.toUsers([id], 'counters', counters(id));
  }
}

function staffIds() {
  return q(`SELECT id FROM users WHERE role IN ('admin', 'moderator') AND is_banned = 0`).all().map((r) => r.id);
}

function notifyStaff(n, opts) {
  notify(staffIds(), n, opts);
}

/** Владелец и участники команды. */
function teamMemberIds(teamId) {
  if (!teamId) return [];
  return q('SELECT user_id FROM team_members WHERE team_id = ?').all(teamId).map((r) => r.user_id);
}

/** Подписчики произведения: добавившие его в избранное. */
function favoriteUserIds(workId) {
  return q('SELECT user_id FROM favorites WHERE work_id = ?').all(workId).map((r) => r.user_id);
}

module.exports = { notify, notifyStaff, counters, pushCounters, unreadNotifications, unreadMessages, teamMemberIds, favoriteUserIds, staffIds };
