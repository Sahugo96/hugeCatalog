'use strict';

const crypto = require('node:crypto');
const { db, q, transaction } = require('./db');
const { hashPassword } = require('./auth');
const { uniqueSlug } = require('./util');

const DEFAULT_GENRES = [
  'Боевик', 'Боевые искусства', 'Вестерн', 'Гарем', 'Детектив', 'Драма', 'Исекай', 'Исторический', 'Киберпанк',
  'Комедия', 'Криминал', 'Махо-сёдзё', 'Меха', 'Мистика', 'Научная фантастика', 'Повседневность',
  'Постапокалиптика', 'Приключения', 'Психология', 'Романтика', 'Сверхъестественное', 'Спорт', 'Супергерои',
  'Трагедия', 'Триллер', 'Ужасы', 'Фэнтези', 'Школа', 'Этти', 'Сёнэн', 'Сёдзё', 'Сэйнэн', 'Дзёсэй',
  'Сёнэн-ай', 'Сёдзё-ай', 'Яой', 'Юри', 'Кулинария', 'Музыка', 'Военный',
];

const DEFAULT_TAGS = {
  Сюжет: ['Месть', 'Перерождение', 'Путешествие во времени', 'Система', 'Регрессия', 'Выживание', 'Башня',
    'Подземелья', 'Война', 'Политические интриги', 'Любовный треугольник', 'Тайна', 'Становление героя',
    'Игровой мир', 'Культивация', 'Офисный роман', 'Фальшивые отношения', 'Медленное развитие'],
  Рисовка: ['Цветная', 'Чёрно-белая', 'Реалистичная рисовка', 'Красивая рисовка', 'Чиби', 'Детальные фоны',
    '3D-элементы', 'Минимализм', 'Акварель', 'Динамичные сражения'],
  Персонажи: ['Сильный главный герой', 'Главная героиня', 'Антигерой', 'Злодейка', 'Умный главный герой',
    'Демоны', 'Вампиры', 'Эльфы', 'Драконы', 'Магия', 'Монстры', 'Боги', 'Кицунэ'],
  Сеттинг: ['Средневековье', 'Современность', 'Будущее', 'Академия магии', 'Другой мир', 'Япония', 'Корея',
    'Китай', 'Космос', 'Мурим', 'Королевский двор'],
  Прочее: ['Веб', 'Адаптация романа', 'Экранизировано', 'Ваншот', 'Сборник'],
};

function ensureTaxonomy() {
  const genres = q('SELECT COUNT(*) AS n FROM genres').get().n;
  const tags = q('SELECT COUNT(*) AS n FROM tags').get().n;
  if (genres && tags) return;
  transaction(() => {
    if (!genres) {
      for (const name of DEFAULT_GENRES) {
        q('INSERT OR IGNORE INTO genres (name, slug) VALUES (?, ?)').run(name, uniqueSlug(db, 'genres', name));
      }
    }
    if (!tags) {
      for (const [group, list] of Object.entries(DEFAULT_TAGS)) {
        for (const name of list) {
          q('INSERT OR IGNORE INTO tags (name, slug, tag_group) VALUES (?, ?, ?)').run(name, uniqueSlug(db, 'tags', name), group);
        }
      }
    }
  });
}

/** Создаёт администратора, если в базе ещё нет ни одного. */
function ensureAdmin() {
  if (q(`SELECT 1 FROM users WHERE role = 'admin'`).get()) return null;
  const username = process.env.ADMIN_USERNAME || 'admin';
  const email = process.env.ADMIN_EMAIL || 'admin@localhost';
  const generated = !process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  const existing = q('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    q(`UPDATE users SET role = 'admin', password_hash = ? WHERE id = ?`).run(hashPassword(password), existing.id);
  } else {
    q(`INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, 'admin')`).run(username, email, hashPassword(password));
  }
  console.log('──────────────────────────────────────────────');
  console.log(' Создан администратор');
  console.log(`   логин:  ${username}`);
  console.log(`   пароль: ${generated ? password + '   (сгенерирован, смените после входа)' : '(из ADMIN_PASSWORD)'}`);
  console.log('──────────────────────────────────────────────');
  return { username, password };
}

function ensureBootstrap() {
  ensureTaxonomy();
  return ensureAdmin();
}

module.exports = { ensureBootstrap, ensureTaxonomy, ensureAdmin, DEFAULT_GENRES, DEFAULT_TAGS };
