'use strict';

/**
 * Меняет пароль администратора (если база уже создана и пароль забыт/сгенерирован).
 *   npm run admin:password -- новый-пароль [логин]
 * Без аргументов берёт пароль из ADMIN_PASSWORD (.env).
 */

const { q } = require('../src/db');
const { ensureBootstrap } = require('../src/bootstrap');
const { hashPassword } = require('../src/auth');

const password = process.argv[2] || process.env.ADMIN_PASSWORD;
const username = process.argv[3] || process.env.ADMIN_USERNAME || 'admin';
if (!password || password.length < 8) {
  console.error('Укажите пароль не короче 8 символов: npm run admin:password -- новый-пароль [логин]');
  process.exit(1);
}

ensureBootstrap();
const user = q('SELECT id FROM users WHERE username = ?').get(username);
if (!user) {
  console.error(`Пользователь «${username}» не найден.`);
  process.exit(1);
}
q(`UPDATE users SET password_hash = ?, role = 'admin', is_banned = 0 WHERE id = ?`).run(hashPassword(password), user.id);
q(`DELETE FROM sessions WHERE json_extract(data, '$.userId') = ?`).run(user.id);
console.log(`Пароль пользователя «${username}» обновлён, роль — администратор.`);
