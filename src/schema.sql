-- Схема базы данных HugeCatalog (SQLite)

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'moderator', 'admin')),
  is_banned     INTEGER NOT NULL DEFAULT 0,
  avatar        TEXT,
  about         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  sid     TEXT PRIMARY KEY,
  data    TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);

-- Команды (переводчики / сканлейтеры). Создаются после одобрения модератором.
CREATE TABLE IF NOT EXISTS teams (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  slug          TEXT NOT NULL UNIQUE,
  description   TEXT NOT NULL DEFAULT '',
  avatar        TEXT,
  owner_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reject_reason TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at   TEXT
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id   INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS authors (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  slug TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS genres (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  slug TEXT NOT NULL UNIQUE
);

-- Теги разбиты на группы ("Сюжет", "Рисовка", "Персонажи", "Сеттинг", ...).
-- Группа "Рисовка" используется для поиска похожих по рисовке, "Сюжет" — по сюжету.
CREATE TABLE IF NOT EXISTS tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  slug       TEXT NOT NULL UNIQUE,
  tag_group  TEXT NOT NULL DEFAULT 'Прочее'
);

CREATE TABLE IF NOT EXISTS works (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  alt_titles    TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  cover         TEXT,
  type          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'ongoing',
  year          INTEGER,
  language      TEXT NOT NULL,
  age_rating    TEXT NOT NULL DEFAULT '0+',
  team_id       INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  uploader_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  moderation    TEXT NOT NULL DEFAULT 'pending' CHECK (moderation IN ('pending', 'approved', 'rejected')),
  reject_reason TEXT,
  views         INTEGER NOT NULL DEFAULT 0,
  likes_count   INTEGER NOT NULL DEFAULT 0,
  favs_count    INTEGER NOT NULL DEFAULT 0,
  search_text   TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  published_at  TEXT,
  last_chapter_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_works_moderation ON works(moderation);
CREATE INDEX IF NOT EXISTS idx_works_published ON works(published_at);
CREATE INDEX IF NOT EXISTS idx_works_last_chapter ON works(last_chapter_at);

CREATE TABLE IF NOT EXISTS work_authors (
  work_id   INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'story' CHECK (role IN ('story', 'art')),
  PRIMARY KEY (work_id, author_id, role)
);

CREATE TABLE IF NOT EXISTS work_genres (
  work_id  INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  genre_id INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
  PRIMARY KEY (work_id, genre_id)
);

CREATE TABLE IF NOT EXISTS work_tags (
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (work_id, tag_id)
);

CREATE TABLE IF NOT EXISTS chapters (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id     INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  volume      INTEGER,
  number      REAL NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  team_id     INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  uploader_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  pages_count INTEGER NOT NULL DEFAULT 0,
  views       INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chapters_work ON chapters(work_id, number);
CREATE INDEX IF NOT EXISTS idx_chapters_created ON chapters(created_at);

CREATE TABLE IF NOT EXISTS pages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  path       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pages_chapter ON pages(chapter_id, idx);

CREATE TABLE IF NOT EXISTS likes (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_id    INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, work_id)
);
CREATE INDEX IF NOT EXISTS idx_likes_created ON likes(created_at);

CREATE TABLE IF NOT EXISTS favorites (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_id    INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, work_id)
);

-- Просмотры по дням: для блоков "Читаемые сегодня" и "Топ за сегодня".
CREATE TABLE IF NOT EXISTS daily_views (
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  day     TEXT NOT NULL,
  views   INTEGER NOT NULL DEFAULT 0,
  reads   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (work_id, day)
);
CREATE INDEX IF NOT EXISTS idx_daily_views_day ON daily_views(day);

-- Последняя прочитанная глава (для "Продолжить чтение").
CREATE TABLE IF NOT EXISTS reading_history (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_id    INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, work_id)
);
