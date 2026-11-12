'use strict';

const { q, db, transaction } = require('../db');
const C = require('../constants');
const { uniqueSlug, searchNormalize, escapeLike, today, toArray, toInt } = require('../util');
const { sameGroupIds } = require('./versions');

/** Поля для карточек произведений. */
const CARD = `w.id, w.slug, w.title, w.cover, w.type, w.status, w.year, w.language, w.age_rating,
  w.views, w.likes_count, w.favs_count, w.published_at, w.last_chapter_at, w.is_single,
  (SELECT COALESCE(SUM(c.pages_count), 0) FROM chapters c WHERE c.work_id = w.id) AS pages_total,
  (SELECT COUNT(*) FROM chapters c WHERE c.work_id = w.id AND c.pages_count > 0) AS chapters_count`;

const APPROVED = `w.moderation = 'approved'`;

/* ======================= Справочники ======================= */

function allGenres() {
  return q('SELECT id, name, slug FROM genres ORDER BY name').all();
}

function allTags() {
  return q('SELECT id, name, slug, tag_group FROM tags ORDER BY tag_group, name').all();
}

function tagsByGroup(tags = allTags()) {
  const groups = new Map(C.TAG_GROUPS.map((g) => [g, []]));
  for (const t of tags) {
    if (!groups.has(t.tag_group)) groups.set(t.tag_group, []);
    groups.get(t.tag_group).push(t);
  }
  return [...groups].filter(([, list]) => list.length).map(([group, list]) => ({ group, tags: list }));
}

/* ======================= Произведение ======================= */

function getTaxonomy(workId) {
  return {
    genres: q('SELECT g.id, g.name, g.slug FROM work_genres wg JOIN genres g ON g.id = wg.genre_id WHERE wg.work_id = ? ORDER BY g.name').all(workId),
    tags: q('SELECT t.id, t.name, t.slug, t.tag_group FROM work_tags wt JOIN tags t ON t.id = wt.tag_id WHERE wt.work_id = ? ORDER BY t.name').all(workId),
    authors: q(`SELECT a.id, a.name, a.slug, wa.role FROM work_authors wa JOIN authors a ON a.id = wa.author_id
                WHERE wa.work_id = ? ORDER BY wa.rowid`).all(workId),
  };
}

function getWork(where, value) {
  const work = q(`SELECT w.*, t.name AS team_name, t.slug AS team_slug, u.username AS uploader_name,
      (SELECT COUNT(*) FROM chapters c WHERE c.work_id = w.id AND c.pages_count > 0) AS chapters_count,
      (SELECT COALESCE(SUM(c.pages_count), 0) FROM chapters c WHERE c.work_id = w.id) AS pages_total
    FROM works w
    LEFT JOIN teams t ON t.id = w.team_id
    LEFT JOIN users u ON u.id = w.uploader_id
    WHERE w.${where} = ?`).get(value);
  if (!work) return null;
  Object.assign(work, getTaxonomy(work.id));
  work.storyAuthors = work.authors.filter((a) => a.role === 'story');
  work.artists = work.authors.filter((a) => a.role === 'art');
  return work;
}

const getWorkBySlug = (slug) => getWork('slug', slug);
const getWorkById = (id) => getWork('id', id);

/**
 * Главы произведения. По умолчанию — только со страницами: главы-каркасы из импорта
 * (pages_count = 0) видны лишь в студии, пока команда не загрузит страницы.
 */
function getChapters(workId, order = 'DESC', { includeEmpty = false } = {}) {
  const dir = order === 'ASC' ? 'ASC' : 'DESC';
  return q(`SELECT c.id, c.volume, c.number, c.title, c.created_at, c.views, c.pages_count,
      t.name AS team_name, t.slug AS team_slug
    FROM chapters c LEFT JOIN teams t ON t.id = c.team_id
    WHERE c.work_id = ? ${includeEmpty ? '' : 'AND c.pages_count > 0'} ORDER BY c.number ${dir}, c.id ${dir}`).all(workId);
}

function upsertAuthor(name) {
  name = String(name).trim().slice(0, 120);
  if (!name) return null;
  const found = q('SELECT id FROM authors WHERE name = ?').get(name);
  if (found) return found.id;
  const slug = uniqueSlug(db, 'authors', name);
  return Number(q('INSERT INTO authors (name, slug) VALUES (?, ?)').run(name, slug).lastInsertRowid);
}

function splitNames(s) {
  return [...new Set(String(s || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean))].slice(0, 20);
}

/**
 * Проверяет и нормализует данные формы произведения.
 * Возвращает { data, errors }.
 */
function validateWorkInput(body) {
  const errors = [];
  const data = {
    title: String(body.title || '').trim().slice(0, 200),
    alt_titles: String(body.alt_titles || '').trim().slice(0, 1000),
    description: String(body.description || '').trim().slice(0, 10000),
    type: String(body.type || ''),
    status: String(body.status || 'ongoing'),
    language: String(body.language || ''),
    age_rating: String(body.age_rating || '0+'),
    year: toInt(body.year),
    story_authors: splitNames(body.story_authors),
    artists: splitNames(body.artists),
    genres: toArray(body.genres).map(Number).filter(Number.isFinite),
    tags: toArray(body.tags).map(Number).filter(Number.isFinite),
    is_single: body.format === 'single' || body.is_single === true,
  };
  if (!data.title) errors.push('Укажите название.');
  if (!C.values(C.TYPES).includes(data.type)) errors.push('Выберите тип произведения.');
  if (!C.values(C.STATUSES).includes(data.status)) errors.push('Выберите статус.');
  if (!C.values(C.LANGUAGES).includes(data.language)) errors.push('Выберите язык произведения.');
  if (!C.values(C.AGE_RATINGS).includes(data.age_rating)) errors.push('Выберите возрастной рейтинг.');
  const maxYear = new Date().getFullYear() + 1;
  if (data.year !== null && (data.year < 1900 || data.year > maxYear)) errors.push(`Год должен быть между 1900 и ${maxYear}.`);
  if (!data.story_authors.length) errors.push('Укажите хотя бы одного автора.');
  if (!data.genres.length) errors.push('Выберите хотя бы один жанр.');
  return { data, errors };
}

/** Создаёт или обновляет произведение со связями. Возвращает id. */
function saveWork(data, { id = null, teamId, uploaderId, moderation, cover } = {}) {
  return transaction(() => {
    const searchText = searchNormalize([data.title, data.alt_titles, ...data.story_authors, ...data.artists].join(' '));
    let workId = id;
    if (!workId) {
      const slug = uniqueSlug(db, 'works', data.title);
      const res = q(`INSERT INTO works (slug, title, alt_titles, description, cover, type, status, year, language, age_rating,
          team_id, uploader_id, moderation, search_text, published_at, is_single)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        slug, data.title, data.alt_titles, data.description, cover || null, data.type, data.status, data.year,
        data.language, data.age_rating, teamId || null, uploaderId || null, moderation,
        searchText, moderation === 'approved' ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null,
        data.is_single ? 1 : 0
      );
      workId = Number(res.lastInsertRowid);
    } else {
      q(`UPDATE works SET title = ?, alt_titles = ?, description = ?, type = ?, status = ?, year = ?, language = ?,
          age_rating = ?, search_text = ? WHERE id = ?`).run(
        data.title, data.alt_titles, data.description, data.type, data.status, data.year, data.language,
        data.age_rating, searchText, workId
      );
      if (cover) q('UPDATE works SET cover = ? WHERE id = ?').run(cover, workId);
    }

    q('DELETE FROM work_authors WHERE work_id = ?').run(workId);
    const insAuthor = q('INSERT OR IGNORE INTO work_authors (work_id, author_id, role) VALUES (?, ?, ?)');
    data.story_authors.forEach((n) => insAuthor.run(workId, upsertAuthor(n), 'story'));
    data.artists.forEach((n) => insAuthor.run(workId, upsertAuthor(n), 'art'));

    q('DELETE FROM work_genres WHERE work_id = ?').run(workId);
    const insGenre = q('INSERT OR IGNORE INTO work_genres (work_id, genre_id) SELECT ?, id FROM genres WHERE id = ?');
    data.genres.forEach((g) => insGenre.run(workId, g));

    q('DELETE FROM work_tags WHERE work_id = ?').run(workId);
    const insTag = q('INSERT OR IGNORE INTO work_tags (work_id, tag_id) SELECT ?, id FROM tags WHERE id = ?');
    data.tags.forEach((t) => insTag.run(workId, t));

    // Удаляем авторов, у которых не осталось произведений.
    q('DELETE FROM authors WHERE id NOT IN (SELECT author_id FROM work_authors)').run();
    bumpTextIndex();
    return workId;
  });
}

/* ======================= Просмотры, лайки, избранное ======================= */

/**
 * Засчитывает прочтение главы авторизованным пользователем.
 * Каждая глава учитывается один раз на пользователя; возвращает true, если просмотр засчитан.
 */
function recordChapterRead(userId, workId, chapterId) {
  if (!userId) return false;
  return transaction(() => {
    const res = q('INSERT OR IGNORE INTO chapter_reads (user_id, chapter_id) VALUES (?, ?)').run(userId, chapterId);
    if (!res.changes) return false;
    q('UPDATE chapters SET views = views + 1 WHERE id = ?').run(chapterId);
    q('UPDATE works SET views = views + 1 WHERE id = ?').run(workId);
    q(`INSERT INTO daily_views (work_id, day, views, reads) VALUES (?, ?, 0, 1)
       ON CONFLICT(work_id, day) DO UPDATE SET reads = reads + 1`).run(workId, today());
    return true;
  });
}

function userWorkState(userId, workId) {
  if (!userId) return { liked: false, favorited: false };
  return {
    liked: !!q('SELECT 1 FROM likes WHERE user_id = ? AND work_id = ?').get(userId, workId),
    favorited: !!q('SELECT 1 FROM favorites WHERE user_id = ? AND work_id = ?').get(userId, workId),
  };
}

/** Переключает лайк/избранное. table: 'likes' | 'favorites'. */
function toggle(table, userId, workId) {
  const counter = table === 'likes' ? 'likes_count' : 'favs_count';
  return transaction(() => {
    const exists = q(`SELECT 1 FROM ${table} WHERE user_id = ? AND work_id = ?`).get(userId, workId);
    if (exists) q(`DELETE FROM ${table} WHERE user_id = ? AND work_id = ?`).run(userId, workId);
    else q(`INSERT INTO ${table} (user_id, work_id) VALUES (?, ?)`).run(userId, workId);
    q(`UPDATE works SET ${counter} = (SELECT COUNT(*) FROM ${table} WHERE work_id = ?) WHERE id = ?`).run(workId, workId);
    const { count } = q(`SELECT ${counter} AS count FROM works WHERE id = ?`).get(workId);
    return { active: !exists, count };
  });
}

/* ======================= Каталог ======================= */

const SORT_SQL = {
  popular: 'w.views',
  updated: 'COALESCE(w.last_chapter_at, w.published_at)',
  new: 'w.published_at',
  likes: 'w.likes_count',
  year: 'w.year',
  title: 'w.title COLLATE NOCASE',
  chapters: 'chapters_count',
};

/** Разбирает query-параметры каталога в нормализованный объект фильтров. */
function parseFilters(query) {
  const f = {
    q: String(query.q || '').trim().slice(0, 100),
    genre: toArray(query.genre),
    genre_ex: toArray(query.genre_ex),
    genre_mode: query.genre_mode === 'any' ? 'any' : 'all',
    tag: toArray(query.tag),
    tag_ex: toArray(query.tag_ex),
    tag_mode: query.tag_mode === 'any' ? 'any' : 'all',
    type: toArray(query.type),
    type_ex: toArray(query.type_ex),
    lang: toArray(query.lang),
    lang_ex: toArray(query.lang_ex),
    age: toArray(query.age),
    age_ex: toArray(query.age_ex),
    status: toArray(query.status),
    format: toArray(query.format),
    format_ex: toArray(query.format_ex),
    status_ex: toArray(query.status_ex),
    author: toArray(query.author),
    author_ex: toArray(query.author_ex),
    team: toArray(query.team),
    year_from: toInt(query.year_from),
    year_to: toInt(query.year_to),
    ch_from: toInt(query.ch_from),
    ch_to: toInt(query.ch_to),
    sort: SORT_SQL[query.sort] ? query.sort : 'popular',
    dir: query.dir === 'asc' ? 'asc' : 'desc',
    page: Math.max(1, toInt(query.page, 1)),
  };
  return f;
}

function countActiveFilters(f) {
  const keys = ['genre', 'genre_ex', 'tag', 'tag_ex', 'type', 'type_ex', 'lang', 'lang_ex', 'age', 'age_ex',
    'status', 'status_ex', 'format', 'format_ex', 'author', 'author_ex', 'team'];
  let n = keys.reduce((s, k) => s + f[k].length, 0);
  ['year_from', 'year_to', 'ch_from', 'ch_to'].forEach((k) => { if (f[k] !== null) n++; });
  return n;
}

function placeholders(arr) {
  return arr.map(() => '?').join(', ');
}

function searchCatalog(f, perPage = 30) {
  const where = [APPROVED];
  const params = [];

  if (f.q) {
    where.push(`w.search_text LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(searchNormalize(f.q))}%`);
  }

  const relation = (table, refTable, refCol, include, exclude, mode) => {
    if (include.length) {
      const having = mode === 'all' ? `HAVING COUNT(DISTINCT r.id) = ${include.length}` : '';
      where.push(`w.id IN (SELECT x.work_id FROM ${table} x JOIN ${refTable} r ON r.id = x.${refCol}
        WHERE r.slug IN (${placeholders(include)}) GROUP BY x.work_id ${having})`);
      params.push(...include);
    }
    if (exclude.length) {
      where.push(`w.id NOT IN (SELECT x.work_id FROM ${table} x JOIN ${refTable} r ON r.id = x.${refCol}
        WHERE r.slug IN (${placeholders(exclude)}))`);
      params.push(...exclude);
    }
  };
  relation('work_genres', 'genres', 'genre_id', f.genre, f.genre_ex, f.genre_mode);
  relation('work_tags', 'tags', 'tag_id', f.tag, f.tag_ex, f.tag_mode);
  // Автор: достаточно совпадения с любым из выбранных (соавторы редки).
  relation('work_authors', 'authors', 'author_id', f.author, f.author_ex, 'any');

  const scalar = (col, include, exclude) => {
    if (include.length) {
      where.push(`${col} IN (${placeholders(include)})`);
      params.push(...include);
    }
    if (exclude.length) {
      where.push(`${col} NOT IN (${placeholders(exclude)})`);
      params.push(...exclude);
    }
  };
  scalar('w.type', f.type, f.type_ex);
  scalar('w.language', f.lang, f.lang_ex);
  scalar('w.age_rating', f.age, f.age_ex);
  scalar('w.status', f.status, f.status_ex);
  scalar(`CASE WHEN w.is_single = 1 THEN 'single' ELSE 'chapters' END`, f.format, f.format_ex);

  if (f.team.length) {
    where.push(`w.team_id IN (SELECT id FROM teams WHERE slug IN (${placeholders(f.team)}))`);
    params.push(...f.team);
  }
  if (f.year_from !== null) { where.push('w.year >= ?'); params.push(f.year_from); }
  if (f.year_to !== null) { where.push('w.year <= ?'); params.push(f.year_to); }
  const chCount = '(SELECT COUNT(*) FROM chapters c WHERE c.work_id = w.id AND c.pages_count > 0)';
  if (f.ch_from !== null) { where.push(`${chCount} >= ?`); params.push(f.ch_from); }
  if (f.ch_to !== null) { where.push(`${chCount} <= ?`); params.push(f.ch_to); }

  const whereSql = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM works w WHERE ${whereSql}`).get(...params).n;
  const dir = f.dir === 'asc' ? 'ASC' : 'DESC';
  const nulls = f.sort === 'year' || f.sort === 'updated' || f.sort === 'new' ? 'NULLS LAST' : '';
  const pages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(f.page, pages);
  const items = db.prepare(`SELECT ${CARD} FROM works w WHERE ${whereSql}
    ORDER BY ${SORT_SQL[f.sort]} ${dir} ${nulls}, w.id DESC LIMIT ? OFFSET ?`)
    .all(...params, perPage, (page - 1) * perPage);
  attachCardGenres(items);
  return { items, total, page, pages };
}

/** Добавляет к карточкам до 3 жанров (для подписи). */
function attachCardGenres(items) {
  if (!items.length) return items;
  const ids = items.map((i) => i.id);
  const rows = db.prepare(`SELECT wg.work_id, g.name, g.slug FROM work_genres wg JOIN genres g ON g.id = wg.genre_id
    WHERE wg.work_id IN (${placeholders(ids)}) ORDER BY g.name`).all(...ids);
  const map = new Map();
  rows.forEach((r) => {
    if (!map.has(r.work_id)) map.set(r.work_id, []);
    map.get(r.work_id).push({ name: r.name, slug: r.slug });
  });
  items.forEach((i) => { i.genres = (map.get(i.id) || []).slice(0, 3); });
  return items;
}

/* ======================= Главная ======================= */

function latestUpdates(limit = 12) {
  const works = q(`SELECT ${CARD} FROM works w WHERE ${APPROVED} AND w.last_chapter_at IS NOT NULL
    ORDER BY w.last_chapter_at DESC LIMIT ?`).all(limit);
  const chStmt = q(`SELECT c.id, c.number, c.volume, c.title, c.created_at, t.name AS team_name
    FROM chapters c LEFT JOIN teams t ON t.id = c.team_id
    WHERE c.work_id = ? AND c.pages_count > 0 ORDER BY c.created_at DESC, c.number DESC LIMIT 3`);
  works.forEach((w) => { w.recentChapters = chStmt.all(w.id); });
  return works;
}

function newWorks(limit = 12) {
  return attachCardGenres(q(`SELECT ${CARD} FROM works w WHERE ${APPROVED} ORDER BY w.published_at DESC, w.id DESC LIMIT ?`).all(limit));
}

function popularAllTime(limit = 12) {
  return attachCardGenres(q(`SELECT ${CARD} FROM works w WHERE ${APPROVED} ORDER BY w.views DESC, w.likes_count DESC LIMIT ?`).all(limit));
}

/** Читаемые сегодня: по количеству открытых глав за текущие сутки. */
function readingToday(limit = 12) {
  return attachCardGenres(q(`SELECT ${CARD}, dv.reads AS today_reads FROM daily_views dv JOIN works w ON w.id = dv.work_id
    WHERE ${APPROVED} AND dv.day = ? AND dv.reads > 0 ORDER BY dv.reads DESC LIMIT ?`).all(today(), limit));
}

/** Топ за период: лайки за период весят больше просмотров. */
function topForDays(days, limit = 10) {
  const from = today(-(days - 1));
  return attachCardGenres(q(`SELECT ${CARD},
      COALESCE((SELECT SUM(reads) FROM daily_views dv WHERE dv.work_id = w.id AND dv.day >= ?), 0) AS period_views,
      (SELECT COUNT(*) FROM likes l WHERE l.work_id = w.id AND date(l.created_at) >= ?) AS period_likes
    FROM works w WHERE ${APPROVED}
    AND (period_views > 0 OR period_likes > 0)
    ORDER BY (period_likes * 10 + period_views) DESC, w.views DESC LIMIT ?`).all(from, from, limit));
}

/** Баннер на главной: популярные тайтлы с описанием. */
function heroWorks(limit = 5) {
  return attachCardGenres(q(`SELECT ${CARD}, w.description FROM works w WHERE ${APPROVED} AND w.cover IS NOT NULL
    ORDER BY (w.views + w.likes_count * 20) DESC LIMIT ?`).all(limit));
}

function completedWorks(limit = 12) {
  return attachCardGenres(q(`SELECT ${CARD} FROM works w WHERE ${APPROVED} AND w.status = 'completed'
    ORDER BY w.views DESC LIMIT ?`).all(limit));
}

function continueReading(userId, limit = 8) {
  return q(`SELECT ${CARD}, c.id AS chapter_id, c.number AS chapter_number, rh.updated_at AS read_at
    FROM reading_history rh JOIN works w ON w.id = rh.work_id JOIN chapters c ON c.id = rh.chapter_id
    WHERE rh.user_id = ? AND ${APPROVED} ORDER BY rh.updated_at DESC LIMIT ?`).all(userId, limit);
}

function siteStats() {
  return q(`SELECT
    (SELECT COUNT(*) FROM works WHERE moderation = 'approved') AS works,
    (SELECT COUNT(*) FROM chapters c JOIN works w ON w.id = c.work_id WHERE w.moderation = 'approved' AND c.pages_count > 0) AS chapters,
    (SELECT COUNT(*) FROM users) AS users,
    (SELECT COUNT(*) FROM teams WHERE status = 'approved') AS teams`).get();
}

/* ======================= Похожие произведения ======================= */

/** Убирает из списка другие языковые версии того же произведения. */
function withoutVersions(workId, rows, limit) {
  const skip = sameGroupIds(workId);
  return rows.filter((r) => !skip.has(r.id)).slice(0, limit);
}

/** По жанрам и тегам: жанр весит 2, тег — 1, нормируется на размеры наборов. */
function similarByTaxonomy(workId, limit = 12) {
  const rows = q(`
    WITH g AS (SELECT genre_id FROM work_genres WHERE work_id = ?),
         t AS (SELECT tag_id FROM work_tags WHERE work_id = ?),
         scores AS (
           SELECT work_id, SUM(s) AS score FROM (
             SELECT work_id, 2.0 AS s FROM work_genres WHERE genre_id IN (SELECT genre_id FROM g)
             UNION ALL
             SELECT work_id, 1.0 AS s FROM work_tags WHERE tag_id IN (SELECT tag_id FROM t)
           ) GROUP BY work_id
         )
    SELECT ${CARD}, scores.score /
      (1.0 + (SELECT COUNT(*) FROM work_genres WHERE work_id = w.id) * 0.3 + (SELECT COUNT(*) FROM work_tags WHERE work_id = w.id) * 0.15) AS rank
    FROM scores JOIN works w ON w.id = scores.work_id
    WHERE w.id != ? AND ${APPROVED}
    ORDER BY rank DESC, w.views DESC LIMIT ?`).all(workId, workId, workId, limit + 10);
  return attachCardGenres(withoutVersions(workId, rows, limit));
}

/** По рисовке: общий художник, теги группы «Рисовка», совпадение типа. */
function similarByArt(workId, limit = 12) {
  const rows = q(`
    WITH a AS (SELECT author_id FROM work_authors WHERE work_id = ? AND role = 'art'),
         t AS (SELECT wt.tag_id FROM work_tags wt JOIN tags tg ON tg.id = wt.tag_id WHERE wt.work_id = ? AND tg.tag_group = 'Рисовка'),
         me AS (SELECT type FROM works WHERE id = ?),
         scores AS (
           SELECT work_id, SUM(s) AS score FROM (
             SELECT work_id, 5.0 AS s FROM work_authors WHERE role = 'art' AND author_id IN (SELECT author_id FROM a)
             UNION ALL
             SELECT work_id, 1.5 AS s FROM work_tags WHERE tag_id IN (SELECT tag_id FROM t)
           ) GROUP BY work_id
         )
    SELECT ${CARD}, scores.score + (CASE WHEN w.type = (SELECT type FROM me) THEN 0.5 ELSE 0 END) AS rank
    FROM scores JOIN works w ON w.id = scores.work_id
    WHERE w.id != ? AND ${APPROVED}
    ORDER BY rank DESC, w.views DESC LIMIT ?`).all(workId, workId, workId, workId, limit + 10);
  return attachCardGenres(withoutVersions(workId, rows, limit));
}

/* --- По сюжету: TF-IDF по описаниям + теги группы «Сюжет» --- */

const STOPWORDS = new Set(('и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее её мне было вот от меня еще ещё нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее неё сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между это эта который которая которые которого своей свой своего его её их очень также однако ' +
  'the a an and or of to in on for with is are was were be been his her their its this that from by as at it he she they them who which what when where will would can not but into one all has have had').split(/\s+/));

function stem(word) {
  if (/[а-я]/.test(word)) {
    word = word.replace(/(ами|ями|ого|его|ому|ему|ыми|ими|ешь|ете|ишь|ите|ует|уют|ают|яют|ние|ния|нию|ность|ости|ость|ая|яя|ое|ее|ые|ие|ый|ий|ой|ом|ем|ам|ям|ах|ях|ов|ев|ей|ую|юю|ть|ся|сь|а|я|о|е|ы|и|у|ю|ь)$/, '');
    return word.slice(0, 7);
  }
  return word.replace(/(ing|ed|es|s)$/, '').slice(0, 8);
}

function tokenize(text) {
  return searchNormalize(text)
    .split(/[^a-zа-я0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .map(stem)
    .filter((w) => w.length >= 3);
}

let textIndex = null;
let textIndexVersion = 0;
let textIndexBuiltFor = -1;

function bumpTextIndex() {
  textIndexVersion++;
}

function buildTextIndex() {
  if (textIndex && textIndexBuiltFor === textIndexVersion) return textIndex;
  const docs = q(`SELECT id, title, description FROM works WHERE moderation = 'approved'`).all();
  const df = new Map();
  const tfs = docs.map((d) => {
    const tf = new Map();
    tokenize(`${d.description}`).forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
    tf.forEach((_, t) => df.set(t, (df.get(t) || 0) + 1));
    return { id: d.id, tf };
  });
  const N = docs.length || 1;
  const vectors = new Map();
  for (const { id, tf } of tfs) {
    const vec = new Map();
    let norm = 0;
    tf.forEach((count, term) => {
      const idf = Math.log(1 + N / (df.get(term) || 1));
      const w = (1 + Math.log(count)) * idf;
      vec.set(term, w);
      norm += w * w;
    });
    vectors.set(id, { vec, norm: Math.sqrt(norm) || 1 });
  }
  textIndex = vectors;
  textIndexBuiltFor = textIndexVersion;
  return textIndex;
}

function similarByPlot(workId, limit = 12) {
  const index = buildTextIndex();
  const scores = new Map();
  const me = index.get(workId);
  if (me) {
    for (const [id, other] of index) {
      if (id === workId) continue;
      let dot = 0;
      const [small, big] = me.vec.size < other.vec.size ? [me.vec, other.vec] : [other.vec, me.vec];
      small.forEach((w, term) => {
        const o = big.get(term);
        if (o) dot += w * o;
      });
      if (dot > 0) scores.set(id, dot / (me.norm * other.norm));
    }
  }
  // Общие сюжетные теги усиливают сходство.
  q(`SELECT wt.work_id, COUNT(*) AS n FROM work_tags wt JOIN tags tg ON tg.id = wt.tag_id
     WHERE tg.tag_group = 'Сюжет' AND wt.work_id != ? AND wt.tag_id IN (SELECT tag_id FROM work_tags WHERE work_id = ?)
     GROUP BY wt.work_id`).all(workId, workId)
    .forEach((r) => scores.set(r.work_id, (scores.get(r.work_id) || 0) + 0.12 * r.n));

  const skip = sameGroupIds(workId);
  const top = [...scores].filter(([id, s]) => s > 0.04 && !skip.has(id)).sort((a, b) => b[1] - a[1]).slice(0, limit);
  if (!top.length) return [];
  const ids = top.map(([id]) => id);
  const rows = db.prepare(`SELECT ${CARD} FROM works w WHERE w.id IN (${placeholders(ids)}) AND ${APPROVED}`).all(...ids);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return attachCardGenres(ids.map((id) => byId.get(id)).filter(Boolean));
}

/* ======================= Главы ======================= */

/* ======================= Формат «Сингл» ======================= */

/**
 * У сингла нет глав для читателя: страницы хранятся в одной служебной главе (№1),
 * а интерфейс показывает её как галерею произведения.
 */
function galleryChapter(workId) {
  return q('SELECT * FROM chapters WHERE work_id = ? ORDER BY number ASC, id ASC LIMIT 1').get(workId);
}

/**
 * Что произойдёт при переводе в сингл: какая глава станет галереей и какие будут удалены.
 * Возвращает { keep, remove: [...], removePages }.
 */
function singlePlan(workId) {
  const chapters = q('SELECT id, number, title, volume, pages_count FROM chapters WHERE work_id = ? ORDER BY number ASC, id ASC').all(workId);
  const [keep, ...remove] = chapters;
  return { keep: keep || null, remove, removePages: remove.reduce((n, c) => n + c.pages_count, 0) };
}

/**
 * Переключает формат. В сингл: первая глава становится галереей (номер 1, без тома и названия),
 * остальные главы удаляются вместе с файлами. В главы: галерея становится «Главой 1».
 */
function setFormat(workId, single) {
  const { removeDir } = require('../upload');
  return transaction(() => {
    if (!single) {
      q('UPDATE works SET is_single = 0 WHERE id = ?').run(workId);
      return { removed: [] };
    }
    const plan = singlePlan(workId);
    plan.remove.forEach((c) => q('DELETE FROM chapters WHERE id = ?').run(c.id));
    if (plan.keep) q(`UPDATE chapters SET number = 1, volume = NULL, title = '' WHERE id = ?`).run(plan.keep.id);
    q('UPDATE works SET is_single = 1 WHERE id = ?').run(workId);
    refreshLastChapter(workId);
    plan.remove.forEach((c) => removeDir(`chapters/${c.id}`));
    return { removed: plan.remove };
  });
}

/**
 * Полностью удаляет произведение: запись, главы, страницы, лайки, избранное, историю,
 * файлы обложки и страниц; распускает связку языковых версий, если в ней остаётся одна.
 */
function deleteWork(work) {
  const { removeDir, removePublic } = require('../upload');
  const { cleanupGroup } = require('./versions');
  const chapterIds = q('SELECT id FROM chapters WHERE work_id = ?').all(work.id).map((c) => c.id);
  q('DELETE FROM works WHERE id = ?').run(work.id); // связанные строки удаляются каскадом
  cleanupGroup(work.group_id);
  chapterIds.forEach((id) => removeDir(`chapters/${id}`));
  removePublic(work.cover);
  q('DELETE FROM authors WHERE id NOT IN (SELECT author_id FROM work_authors)').run();
  bumpTextIndex();
}

function refreshLastChapter(workId) {
  q(`UPDATE works SET last_chapter_at = (SELECT MAX(created_at) FROM chapters WHERE work_id = ? AND pages_count > 0) WHERE id = ?`).run(workId, workId);
}

module.exports = {
  CARD,
  allGenres,
  allTags,
  tagsByGroup,
  getWorkBySlug,
  getWorkById,
  getTaxonomy,
  getChapters,
  validateWorkInput,
  saveWork,
  recordChapterRead,
  userWorkState,
  toggle,
  parseFilters,
  countActiveFilters,
  searchCatalog,
  attachCardGenres,
  latestUpdates,
  newWorks,
  popularAllTime,
  readingToday,
  topForDays,
  completedWorks,
  heroWorks,
  continueReading,
  siteStats,
  similarByTaxonomy,
  similarByArt,
  similarByPlot,
  bumpTextIndex,
  refreshLastChapter,
  deleteWork,
  galleryChapter,
  singlePlan,
  setFormat,
  tokenize,
};
