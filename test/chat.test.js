'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hugecatalog-chat-'));
process.env.ADMIN_PASSWORD = 'admin-test-pass';

const { q } = require('../src/db');
const { ensureBootstrap } = require('../src/bootstrap');
const { hashPassword } = require('../src/auth');
const Chat = require('../src/services/chat');
const N = require('../src/services/notify');

ensureBootstrap();
const mk = (name) => {
  q('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)').run(name, `${name}@t.io`, hashPassword('password1'));
  return q('SELECT * FROM users WHERE username = ?').get(name);
};
const alice = mk('alice');
const bob = mk('bob');
const carol = mk('carol');
const admin = q(`SELECT * FROM users WHERE role = 'admin'`).get();
const wait = () => new Promise((r) => setTimeout(r, 1100)); // ограничение: 1 сообщение в секунду

test('общий чат: отправка, валидация, история', async () => {
  const m = Chat.sendGlobal(alice, '  Привет всем!  ');
  assert.strictEqual(m.body, 'Привет всем!');
  assert.throws(() => Chat.sendGlobal(bob, '   '), /пустое/);
  assert.throws(() => Chat.sendGlobal(bob, 'x'.repeat(1001)), /длиннее/);
  assert.throws(() => Chat.sendGlobal(alice, 'флуд'), /Слишком часто/);
  assert.strictEqual(Chat.globalMessages().length, 1);
});

test('личные сообщения, непрочитанные и блокировка', async () => {
  await wait();
  const conv = Chat.openConversation(alice, 'bob');
  assert.strictEqual(Chat.openConversation(bob, 'alice'), conv, 'одна переписка на пару');
  assert.throws(() => Chat.openConversation(alice, 'alice'), /самому себе/);
  const m = Chat.sendDirect(alice, conv, 'Привет, Боб');
  assert.strictEqual(N.counters(bob.id).messages, 1);
  assert.strictEqual(N.counters(alice.id).messages, 0, 'своё сообщение не считается непрочитанным');
  Chat.markRead(bob, conv, m.id);
  assert.strictEqual(N.counters(bob.id).messages, 0);
  assert.throws(() => Chat.sendDirect(carol, conv, 'чужая переписка'), /не найдена/);
  assert.deepStrictEqual(Chat.toggleBlock(bob, 'alice'), { blocked: true });
  await wait();
  assert.throws(() => Chat.sendDirect(alice, conv, 'ещё'), /ограничил/);
  Chat.toggleBlock(bob, 'alice');
  assert.strictEqual(Chat.conversationsOf(bob.id)[0].other.username, 'alice');
});

test('жалобы, удаление, запрет писать', async () => {
  await wait();
  const m = Chat.sendGlobal(carol, 'спам-ссылка');
  Chat.report(alice, m.id, 'спам');
  assert.ok(N.counters(admin.id).notifications >= 1, 'админ получил уведомление о жалобе');
  assert.throws(() => Chat.report(carol, m.id, ''), /своё/);
  assert.throws(() => Chat.deleteMessage(alice, m.id), /чужое/);
  Chat.deleteMessage(admin, m.id, { asStaff: true });
  const after = Chat.globalMessages().find((x) => x.id === m.id);
  assert.ok(after.deleted && after.body === '', 'текст удалённого скрыт от пользователей');
  assert.ok(q(`SELECT 1 FROM moderation_log WHERE action = 'delete_message'`).get(), 'удаление записано в журнал');
  Chat.muteUser(admin, carol.id, 24);
  await wait();
  assert.throws(() => Chat.sendGlobal(carol, 'снова'), /запрещено/);
  Chat.muteUser(admin, carol.id, 0);
  assert.ok(Chat.sendGlobal(carol, 'исправлюсь').id);
});

test('уведомления', () => {
  N.notify([alice.id, bob.id], { type: 'new_chapter', title: 'Новая глава', link: '/x' }, { exclude: [bob.id] });
  assert.strictEqual(N.counters(alice.id).notifications, 1);
  assert.strictEqual(N.counters(bob.id).notifications, 0);
});
