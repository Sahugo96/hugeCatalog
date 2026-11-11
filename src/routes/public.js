'use strict';

const express = require('express');
const { q, db } = require('../db');
const W = require('../services/works');
const { getVersions } = require('../services/versions');
const { requireAuth, canEditWork } = require('../auth');
const { searchNormalize, escapeLike, toInt } = require('../util');

const router = express.Router();

/* ---------- Главная ---------- */

router.get('/', (req, res) => {
  let reading = W.readingToday(12);
  const readingFallback = reading.length === 0;
  if (readingFallback) reading = W.popularAllTime(12);
  let topDay = W.topForDays(1, 10);
  const topFallback = topDay.length === 0;
  if (topFallback) topDay = W.topForDays(7, 10);
  if (!topDay.length) topDay = W.popularAllTime(10);

  res.render('home', {
    title: null,
    description: 'Каталог манги, манхвы и маньхуа: свежие главы, новинки и популярное.',
    hero: W.heroWorks(5),
    updates: W.latestUpdates(14),
    newWorks: W.newWorks(12),
    reading,
    readingFallback,
    topDay,
    topFallback,
    topWeek: W.topForDays(7, 10),
    completed: W.completedWorks(12),
    continueList: req.user ? W.continueReading(req.user.id, 8) : [],
    stats: W.siteStats(),
    genres: W.allGenres(),
  });
});

/* ---------- Каталог ---------- */

router.get('/catalog', (req, res) => {
  const filters = W.parseFilters(req.query);
  const result = W.searchCatalog(filters, 30);
  const genres = W.allGenres();
  const tags = W.allTags();
  const selectedAuthors = filters.author.concat(filters.author_ex).length
    ? db.prepare(`SELECT name, slug FROM authors WHERE slug IN (${filters.author.concat(filters.author_ex).map(() => '?').join(',')})`)
      .all(...filters.author, ...filters.author_ex)
    : [];
  const selectedTeams = filters.team.length
    ? db.prepare(`SELECT name, slug FROM teams WHERE slug IN (${filters.team.map(() => '?').join(',')})`).all(...filters.team)
    : [];

  // Заголовок страницы по одному выбранному критерию — удобно для ссылок со страницы тайтла.
  let heading = 'Каталог';
  const one = (list, slug) => (list.find((x) => x.slug === slug) || {}).name;
  if (filters.q) heading = `Поиск: «${filters.q}»`;
  else if (filters.genre.length === 1 && W.countActiveFilters(filters) === 1) heading = `Жанр: ${one(genres, filters.genre[0]) || filters.genre[0]}`;
  else if (filters.tag.length === 1 && W.countActiveFilters(filters) === 1) heading = `Тег: ${one(tags, filters.tag[0]) || filters.tag[0]}`;
  else if (filters.author.length === 1 && W.countActiveFilters(filters) === 1 && selectedAuthors[0]) heading = `Автор: ${selectedAuthors[0].name}`;
  else if (filters.team.length === 1 && W.countActiveFilters(filters) === 1 && selectedTeams[0]) heading = `Команда: ${selectedTeams[0].name}`;

  const maxChapters = q('SELECT COALESCE(MAX(n), 0) AS m FROM (SELECT COUNT(*) AS n FROM chapters GROUP BY work_id)').get().m;

  res.render('catalog', {
    title: heading,
    heading,
    filters,
    activeCount: W.countActiveFilters(filters),
    result,
    genres,
    tagGroups: W.tagsByGroup(tags),
    selectedAuthors,
    selectedTeams,
    maxChapters,
    query: req.query,
  });
});

router.get('/author/:slug', (req, res) => res.redirect(`/catalog?author=${encodeURIComponent(req.params.slug)}`));

router.get('/random', (req, res) => {
  const row = q(`SELECT slug FROM works WHERE moderation = 'approved' ORDER BY RANDOM() LIMIT 1`).get();
  res.redirect(row ? `/title/${row.slug}` : '/catalog');
});

/* ---------- Страница произведения ---------- */

function loadVisibleWork(req, res) {
  const work = W.getWorkBySlug(req.params.slug);
  if (!work) return null;
  if (work.moderation !== 'approved' && !canEditWork(req.user, work)) return null;
  return work;
}

router.get('/title/:slug', (req, res, next) => {
  const work = loadVisibleWork(req, res);
  if (!work) return next();
  const order = req.query.order === 'asc' ? 'ASC' : 'DESC';
  const chapters = W.getChapters(work.id, order);
  const firstChapter = q('SELECT id FROM chapters WHERE work_id = ? ORDER BY number ASC, id ASC LIMIT 1').get(work.id);
  const lastRead = req.user
    ? q(`SELECT c.id, c.number FROM reading_history rh JOIN chapters c ON c.id = rh.chapter_id
         WHERE rh.user_id = ? AND rh.work_id = ?`).get(req.user.id, work.id)
    : null;

  const versions = getVersions(work.id, { onlyApproved: !canEditWork(req.user, work) });
  res.render('title', {
    versions,
    title: work.title,
    description: work.description.slice(0, 200),
    ogImage: work.cover,
    work,
    chapters,
    order,
    firstChapter,
    lastRead,
    state: W.userWorkState(req.user && req.user.id, work.id),
    canEdit: canEditWork(req.user, work),
    similar: {
      taxonomy: W.similarByTaxonomy(work.id, 12),
      plot: W.similarByPlot(work.id, 12),
      art: W.similarByArt(work.id, 12),
    },
  });
});

/* ---------- Читалка ---------- */

router.get('/title/:slug/chapter/:id', (req, res, next) => {
  const work = loadVisibleWork(req, res);
  if (!work) return next();
  const chapterId = toInt(req.params.id);
  const chapter = q(`SELECT c.*, t.name AS team_name, t.slug AS team_slug FROM chapters c
    LEFT JOIN teams t ON t.id = c.team_id WHERE c.id = ? AND c.work_id = ?`).get(chapterId, work.id);
  if (!chapter) return next();
  const pages = q('SELECT idx, path FROM pages WHERE chapter_id = ? ORDER BY idx').all(chapter.id);
  const chapters = W.getChapters(work.id, 'ASC');
  const pos = chapters.findIndex((c) => c.id === chapter.id);
  const prev = pos > 0 ? chapters[pos - 1] : null;
  const next_ = pos >= 0 && pos < chapters.length - 1 ? chapters[pos + 1] : null;

  // Просмотр = прочтение главы вошедшим пользователем (один раз на главу).
  if (work.moderation === 'approved' && req.user) W.recordChapterRead(req.user.id, work.id, chapter.id);
  if (req.user) {
    q(`INSERT INTO reading_history (user_id, work_id, chapter_id, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, work_id) DO UPDATE SET chapter_id = excluded.chapter_id, updated_at = excluded.updated_at`)
      .run(req.user.id, work.id, chapter.id);
  }

  res.render('reader', {
    title: `${work.title} — глава ${chapter.number}`,
    work,
    chapter,
    pages,
    chapters,
    prev,
    next: next_,
    bodyClass: 'reader-page',
  });
});

/* ---------- Лайки и избранное (JSON) ---------- */

function toggleHandler(table) {
  return (req, res) => {
    const work = q(`SELECT id, slug FROM works WHERE id = ? AND moderation = 'approved'`).get(toInt(req.params.id));
    if (!work) return res.status(404).json({ error: 'Произведение не найдено' });
    const result = W.toggle(table, req.user.id, work.id);
    if (req.accepts(['json', 'html']) === 'html' && !req.xhr) return res.redirect(`/title/${work.slug}`);
    res.json(result);
  };
}

router.post('/api/works/:id/like', requireAuth, toggleHandler('likes'));
router.post('/api/works/:id/favorite', requireAuth, toggleHandler('favorites'));

/* ---------- Быстрый поиск в шапке ---------- */

router.get('/api/search', (req, res) => {
  const text = searchNormalize(req.query.q).slice(0, 100);
  if (text.length < 2) return res.json({ items: [] });
  const items = q(`SELECT slug, title, cover, type, year FROM works
    WHERE moderation = 'approved' AND search_text LIKE ? ESCAPE '\\' ORDER BY views DESC LIMIT 8`)
    .all(`%${escapeLike(text)}%`);
  res.json({ items });
});

router.get('/api/authors', (req, res) => {
  const text = String(req.query.q || '').trim().slice(0, 60);
  if (text.length < 1) return res.json({ items: [] });
  const items = q(`SELECT name, slug FROM authors WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 10`).all(`%${escapeLike(text)}%`);
  res.json({ items });
});

/* ---------- Статические страницы ---------- */

router.get('/about', (req, res) => {
  res.render('about', { title: 'О сайте', stats: W.siteStats() });
});

router.get('/privacy', (req, res) => {
  res.render('privacy', { title: 'Политика конфиденциальности' });
});

module.exports = router;
