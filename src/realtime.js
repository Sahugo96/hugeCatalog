'use strict';

/**
 * Мгновенная доставка событий в браузер через Server-Sent Events.
 * Работает в пределах одного процесса Node.js (для нескольких процессов нужен брокер, напр. Redis).
 *
 * События: global (сообщение общего чата), dm (личное сообщение), deleted (сообщение удалено),
 *          counters (счётчики непрочитанного), notification (новое уведомление).
 */

const clients = new Map(); // userId (или 0 для гостей) -> Set<res>

function connect(req, res) {
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // nginx: не буферизовать
  });
  res.flushHeaders();
  res.write('retry: 5000\n\n');

  const uid = req.user ? req.user.id : 0;
  res.lang = req.lang || 'ru';
  if (!clients.has(uid)) clients.set(uid, new Set());
  clients.get(uid).add(res);

  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  // Ответ закрывается, когда браузер разрывает соединение (закрыл вкладку, ушёл со страницы).
  res.on('close', () => {
    clearInterval(ping);
    const set = clients.get(uid);
    if (set) {
      set.delete(res);
      if (!set.size) clients.delete(uid);
    }
  });
}

function send(res, event, data) {
  // data может быть функцией (lang) => payload — для перевода под язык конкретного подключения.
  if (typeof data === 'function') data = data(res.lang);
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* соединение закрыто — уберётся по 'close' */
  }
}

/** Отправить событие конкретным пользователям. */
function toUsers(userIds, event, data) {
  for (const id of new Set(userIds)) {
    const set = clients.get(id);
    if (set) set.forEach((res) => send(res, event, data));
  }
}

/** Отправить событие всем подключённым (включая гостей). */
function toAll(event, data) {
  clients.forEach((set) => set.forEach((res) => send(res, event, data)));
}

function onlineCount() {
  let n = 0;
  clients.forEach((set, uid) => { if (uid) n++; });
  return n;
}

function isOnline(userId) {
  return clients.has(userId);
}

module.exports = { connect, toUsers, toAll, onlineCount, isOnline };
