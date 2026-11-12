'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'hugecatalog.db');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

/* ---------- Миграции для баз, созданных старой версией ---------- */
function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}
if (!hasColumn('works', 'group_id')) db.exec('ALTER TABLE works ADD COLUMN group_id INTEGER');
db.exec('CREATE INDEX IF NOT EXISTS idx_works_group ON works(group_id)');
// Запрет писать в чат до указанного времени (UTC, формат SQLite).
// Английские названия жанров и тегов (редактируются в админке).
if (!hasColumn('genres', 'name_en')) db.exec('ALTER TABLE genres ADD COLUMN name_en TEXT');
if (!hasColumn('tags', 'name_en')) db.exec('ALTER TABLE tags ADD COLUMN name_en TEXT');
// Формат «Сингл» (ваншот): у произведения нет глав, страницы — одна галерея.
if (!hasColumn('works', 'is_single')) db.exec('ALTER TABLE works ADD COLUMN is_single INTEGER NOT NULL DEFAULT 0');
// Ключ серии из импорта: выпуски одной серии на одном языке собираются в одно произведение.
if (!hasColumn('works', 'import_key')) db.exec('ALTER TABLE works ADD COLUMN import_key TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_works_import_key ON works(import_key, language)');
if (!hasColumn('users', 'chat_muted_until')) db.exec('ALTER TABLE users ADD COLUMN chat_muted_until TEXT');

/** Выполнить функцию в транзакции. Поддерживает вложенные вызовы. */
let depth = 0;
function transaction(fn) {
  if (depth > 0) return fn();
  depth++;
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth--;
  }
}

// Кэш подготовленных выражений: db.q(sql).all(...)
const cache = new Map();
function q(sql) {
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}

module.exports = { db, q, transaction, DATA_DIR, UPLOAD_DIR, DB_PATH };
