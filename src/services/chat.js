'use strict';

const { q, transaction } = require('../db');
const realtime = require('../realtime');
const N = require('./notify');

const MAX_LENGTH = 1000;
const PAGE = 50;

function userError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}

function iso(s) {
  return s ? String(s).replace(' ', 'T') + 'Z' : null;
}

/** Сообщение в формате для клиента. Текст удалённых сообщений скрывается (кроме режима модератора). */
function serialize(m, { reveal = false } = {}) {
  const deleted = !!m.deleted_at;
  return {
    id: m.id,
    conversation_id: m.conversation_id || null,
    body: deleted && !reveal ? '' : m.body,
    deleted,
    created_at: iso(m.created_at),
    sender: { id: m.sender_id, username: m.username, role: m.role },
  };
}

const SELECT_MSG = `SELECT m.*, u.username, u.role FROM chat_messages m JOIN users u ON u.id = m.sender_id`;

function getMessage(id) {
  return q(`${SELECT_MSG} WHERE m.id = ?`).get(id);
}

/* ---------- Проверки перед отправкой ---------- */

const lastSent = new Map(); // userId -> [timestamps]

function checkCanSend(user, body) {
  const text = String(body || '').replace(/\r\n/g, '\n').trim();
  if (!text) throw userError('Сообщение пустое.');
  if (text.length > MAX_LENGTH) throw userError(`Сообщение длиннее ${MAX_LENGTH} символов.`);
  const row = q('SELECT chat_muted_until FROM users WHERE id = ?').get(user.id);
  if (row && row.chat_muted_until && row.chat_muted_until > q(`SELECT datetime('now') AS n`).get().n) {
    throw userError(`Вам запрещено писать в чат до ${row.chat_muted_until.slice(0, 16)} (UTC).`, 403);
  }
  // Не чаще 1 сообщения в секунду и 20 в минуту.
  const now = Date.now();
  const times = (lastSent.get(user.id) || []).filter((t) => now - t < 60000);
  if ((times.length && now - times[times.length - 1] < 1000) || times.length >= 20) {
    throw userError('Слишком часто. Подождите немного.', 429);
  }
  times.push(now);
  lastSent.set(user.id, times);
  return text;
}

/* ---------- Общий чат ---------- */

function globalMessages(before = null, limit = PAGE) {
  const rows = before
    ? q(`${SELECT_MSG} WHERE m.conversation_id IS NULL AND m.id < ? ORDER BY m.id DESC LIMIT ?`).all(before, limit)
    : q(`${SELECT_MSG} WHERE m.conversation_id IS NULL ORDER BY m.id DESC LIMIT ?`).all(limit);
  return rows.reverse().map((m) => serialize(m));
}

function sendGlobal(user, body) {
  const text = checkCanSend(user, body);
  const id = Number(q('INSERT INTO chat_messages (conversation_id, sender_id, body) VALUES (NULL, ?, ?)').run(user.id, text).lastInsertRowid);
  const msg = serialize(getMessage(id));
  realtime.toAll('global', msg);
  return msg;
}

/* ---------- Личные сообщения ---------- */

function getConversation(id) {
  return q(`SELECT c.*, ua.username AS a_name, ub.username AS b_name FROM conversations c
    JOIN users ua ON ua.id = c.user_a JOIN users ub ON ub.id = c.user_b WHERE c.id = ?`).get(id);
}

function isParticipant(conv, userId) {
  return !!conv && (conv.user_a === userId || conv.user_b === userId);
}

function otherOf(conv, userId) {
  return conv.user_a === userId ? { id: conv.user_b, username: conv.b_name } : { id: conv.user_a, username: conv.a_name };
}

function isBlocked(blockerId, blockedId) {
  return !!q('SELECT 1 FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?').get(blockerId, blockedId);
}

/** Найти или создать переписку с пользователем по имени. */
function openConversation(user, username) {
  const other = q('SELECT id, username, is_banned FROM users WHERE username = ?').get(String(username || '').trim());
  if (!other || other.is_banned) throw userError('Пользователь не найден.', 404);
  if (other.id === user.id) throw userError('Нельзя написать самому себе.');
  const [a, b] = user.id < other.id ? [user.id, other.id] : [other.id, user.id];
  q('INSERT OR IGNORE INTO conversations (user_a, user_b) VALUES (?, ?)').run(a, b);
  return q('SELECT id FROM conversations WHERE user_a = ? AND user_b = ?').get(a, b).id;
}

function conversationsOf(userId) {
  return q(`SELECT c.id, c.last_message_at,
      CASE WHEN c.user_a = ? THEN c.user_b ELSE c.user_a END AS other_id,
      CASE WHEN c.user_a = ? THEN ub.username ELSE ua.username END AS other_name,
      CASE WHEN c.user_a = ? THEN c.a_last_read ELSE c.b_last_read END AS my_last_read,
      (SELECT body FROM chat_messages WHERE conversation_id = c.id AND deleted_at IS NULL ORDER BY id DESC LIMIT 1) AS last_body,
      (SELECT sender_id FROM chat_messages WHERE conversation_id = c.id AND deleted_at IS NULL ORDER BY id DESC LIMIT 1) AS last_sender
    FROM conversations c JOIN users ua ON ua.id = c.user_a JOIN users ub ON ub.id = c.user_b
    WHERE (c.user_a = ? OR c.user_b = ?) AND c.last_message_at IS NOT NULL
    ORDER BY c.last_message_at DESC LIMIT 100`).all(userId, userId, userId, userId, userId)
    .map((c) => ({
      id: c.id,
      other: { id: c.other_id, username: c.other_name, online: realtime.isOnline(c.other_id) },
      last_body: c.last_body ? c.last_body.slice(0, 120) : '',
      last_mine: c.last_sender === userId,
      last_message_at: iso(c.last_message_at),
      unread: q(`SELECT COUNT(*) AS n FROM chat_messages WHERE conversation_id = ? AND id > ? AND sender_id != ? AND deleted_at IS NULL`)
        .get(c.id, c.my_last_read, userId).n,
      blocked: isBlocked(userId, c.other_id),
    }));
}

function conversationMessages(convId, before = null, limit = PAGE, opts = {}) {
  const rows = before
    ? q(`${SELECT_MSG} WHERE m.conversation_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`).all(convId, before, limit)
    : q(`${SELECT_MSG} WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT ?`).all(convId, limit);
  return rows.reverse().map((m) => serialize(m, opts));
}

function sendDirect(user, convId, body) {
  const conv = getConversation(convId);
  if (!isParticipant(conv, user.id)) throw userError('Переписка не найдена.', 404);
  const other = otherOf(conv, user.id);
  if (isBlocked(other.id, user.id)) throw userError('Пользователь ограничил получение сообщений от вас.', 403);
  if (isBlocked(user.id, other.id)) throw userError('Вы заблокировали этого пользователя. Разблокируйте, чтобы написать.', 403);
  const text = checkCanSend(user, body);
  const id = transaction(() => {
    const newId = Number(q('INSERT INTO chat_messages (conversation_id, sender_id, body) VALUES (?, ?, ?)').run(conv.id, user.id, text).lastInsertRowid);
    const readCol = conv.user_a === user.id ? 'a_last_read' : 'b_last_read';
    q(`UPDATE conversations SET last_message_at = datetime('now'), ${readCol} = ? WHERE id = ?`).run(newId, conv.id);
    return newId;
  });
  const msg = serialize(getMessage(id));
  realtime.toUsers([user.id, other.id], 'dm', msg);
  N.pushCounters([other.id]);
  return msg;
}

function markRead(user, convId, lastId) {
  const conv = getConversation(convId);
  if (!isParticipant(conv, user.id)) throw userError('Переписка не найдена.', 404);
  const col = conv.user_a === user.id ? 'a_last_read' : 'b_last_read';
  const maxId = q('SELECT COALESCE(MAX(id), 0) AS m FROM chat_messages WHERE conversation_id = ?').get(conv.id).m;
  const value = Math.min(Number(lastId) || maxId, maxId);
  q(`UPDATE conversations SET ${col} = MAX(${col}, ?) WHERE id = ?`).run(value, conv.id);
  N.pushCounters([user.id]);
}

function toggleBlock(user, username) {
  const other = q('SELECT id FROM users WHERE username = ?').get(String(username || ''));
  if (!other || other.id === user.id) throw userError('Пользователь не найден.', 404);
  if (isBlocked(user.id, other.id)) {
    q('DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?').run(user.id, other.id);
    N.pushCounters([user.id]);
    return { blocked: false };
  }
  q('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?)').run(user.id, other.id);
  N.pushCounters([user.id]);
  return { blocked: true };
}

/* ---------- Удаление и жалобы ---------- */

/** Удалить сообщение: автор — своё, модератор — любое из общего чата и жалоб, админ — любое. */
function deleteMessage(user, id, { asStaff = false } = {}) {
  const m = getMessage(id);
  if (!m || m.deleted_at) throw userError('Сообщение не найдено.', 404);
  const own = m.sender_id === user.id;
  if (!own && !asStaff) throw userError('Нельзя удалить чужое сообщение.', 403);
  q(`UPDATE chat_messages SET deleted_at = datetime('now'), deleted_by = ? WHERE id = ?`).run(user.id, id);
  const payload = { id, conversation_id: m.conversation_id || null };
  if (m.conversation_id) {
    const conv = getConversation(m.conversation_id);
    realtime.toUsers([conv.user_a, conv.user_b], 'deleted', payload);
    N.pushCounters([conv.user_a, conv.user_b]);
  } else {
    realtime.toAll('deleted', payload);
  }
  if (!own) log(user.id, 'delete_message', `message:${id}`, m.body.slice(0, 200));
}

function report(user, id, reason) {
  const m = getMessage(id);
  if (!m || m.deleted_at) throw userError('Сообщение не найдено.', 404);
  if (m.conversation_id && !isParticipant(getConversation(m.conversation_id), user.id)) throw userError('Сообщение не найдено.', 404);
  if (m.sender_id === user.id) throw userError('Нельзя пожаловаться на своё сообщение.');
  const res = q('INSERT OR IGNORE INTO chat_reports (message_id, reporter_id, reason) VALUES (?, ?, ?)')
    .run(id, user.id, String(reason || '').trim().slice(0, 500));
  if (res.changes) {
    N.notifyStaff({ type: 'report', title: 'Жалоба на сообщение в чате', body: `${user.username} → ${m.username}: «${m.body.slice(0, 80)}»`, link: '/admin/chat?tab=reports' });
  }
}

/* ---------- Модерация ---------- */

function log(actorId, action, target, details = '') {
  q('INSERT INTO moderation_log (actor_id, action, target, details) VALUES (?, ?, ?, ?)').run(actorId, action, target, details);
}

function muteUser(actor, userId, hours) {
  if (hours > 0) {
    q(`UPDATE users SET chat_muted_until = datetime('now', ?) WHERE id = ?`).run(`+${Math.min(hours, 24 * 3650)} hours`, userId);
    log(actor.id, 'mute', `user:${userId}`, `${hours} ч`);
  } else {
    q('UPDATE users SET chat_muted_until = NULL WHERE id = ?').run(userId);
    log(actor.id, 'unmute', `user:${userId}`);
  }
}

module.exports = {
  MAX_LENGTH,
  serialize,
  SELECT_MSG,
  globalMessages,
  sendGlobal,
  openConversation,
  getConversation,
  isParticipant,
  otherOf,
  isBlocked,
  conversationsOf,
  conversationMessages,
  sendDirect,
  markRead,
  toggleBlock,
  deleteMessage,
  report,
  log,
  muteUser,
};
