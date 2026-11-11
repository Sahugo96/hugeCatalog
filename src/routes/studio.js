'use strict';

const express = require('express');
const { q, transaction } = require('../db');
const W = require('../services/works');
const V = require('../services/versions');
const N = require('../services/notify');
const C = require('../constants');
const { requireAuth, verifyCsrf, isStaff, canEditWork, teamRole } = require('../auth');
const { coverUpload, pagesUpload, storeImage, copyPublic, removePublic, removeDir, cleanupTmp, naturalCompare, detectImageExt } = require('../upload');
const { toInt, searchNormalize, escapeLike } = require('../util');

const router = express.Router();
router.use(requireAuth);

/** Редирект; для XHR-загрузки с прогрессом отдаём адрес в JSON (чтобы не потерять flash). */
function finish(req, res, url) {
  if (req.xhr) return res.json({ redirect: url });
  return res.redirect(url);
}

/** Команды, от имени которых пользователь может загружать. */
function uploadTeams(user) {
  if (isStaff(user)) return q(`SELECT id, name, slug FROM teams WHERE status = 'approved' ORDER BY name`).all();
  return q(`SELECT t.id, t.name, t.slug FROM team_members tm JOIN teams t ON t.id = tm.team_id
    WHERE tm.user_id = ? AND t.status = 'approved' ORDER BY t.name`).all(user.id);
}

function canUpload(user) {
  return isStaff(user) || uploadTeams(user).length > 0;
}

function loadEditableWork(req, res, next) {
  const work = W.getWorkById(toInt(req.params.id));
  if (!work || !canEditWork(req.user, work)) {
    cleanupTmp(req);
    return next('route');
  }
  req.work = work;
  next();
}

function formOptions(req) {
  return { genres: W.allGenres(), tagGroups: W.tagsByGroup(), teams: uploadTeams(req.user) };
}

/* ---------- Панель ---------- */

router.get('/', (req, res) => {
  const teams = uploadTeams(req.user);
  const teamIds = teams.map((t) => t.id);
  const works = isStaff(req.user)
    ? q(`SELECT ${W.CARD}, w.moderation, w.reject_reason, t.name AS team_name FROM works w LEFT JOIN teams t ON t.id = w.team_id
         WHERE w.uploader_id = ? OR w.team_id IN (SELECT team_id FROM team_members WHERE user_id = ?)
         ORDER BY w.created_at DESC`).all(req.user.id, req.user.id)
    : teamIds.length
      ? q(`SELECT ${W.CARD}, w.moderation, w.reject_reason, t.name AS team_name FROM works w LEFT JOIN teams t ON t.id = w.team_id
           WHERE w.team_id IN (SELECT tm.team_id FROM team_members tm JOIN teams tt ON tt.id = tm.team_id
                               WHERE tm.user_id = ? AND tt.status = 'approved')
           ORDER BY w.created_at DESC`).all(req.user.id)
      : [];
  const pendingTeam = q(`SELECT name, slug, status, reject_reason FROM teams WHERE owner_id = ? AND status != 'approved' ORDER BY created_at DESC LIMIT 1`).get(req.user.id);
  res.render('studio/index', { title: 'Студия', works, teams, canUpload: canUpload(req.user), pendingTeam });
});

/* ---------- Создание произведения ---------- */

router.get('/works/new', (req, res) => {
  if (!canUpload(req.user)) {
    req.flash('info', 'Чтобы загружать произведения, создайте команду и дождитесь её одобрения.');
    return res.redirect('/teams/new');
  }
  const opts = formOptions(req);
  const source = sourceWork(req, req.query.from);
  let form = { team_id: req.query.team || (opts.teams[0] && opts.teams[0].id), genres: [], tags: [], language: 'ja', type: 'manga', status: 'ongoing', age_rating: '12+' };
  if (source) form = { ...form, ...versionPrefill(source) };
  res.render('studio/work-form', { title: source ? `Новая версия: ${source.title}` : 'Новое произведение', work: null, errors: [], form, source, ...opts });
});

/** Исходное произведение для «добавить версию на другом языке»: опубликованное или своё. */
function sourceWork(req, id) {
  const work = id ? W.getWorkById(toInt(id)) : null;
  if (!work || (work.moderation !== 'approved' && !canEditWork(req.user, work))) return null;
  return work;
}

/** Копирует общие данные: авторов, жанры, теги, тип, год… Название и язык — новые. */
function versionPrefill(source) {
  const taken = new Set([source.language, ...V.getVersions(source.id, { onlyApproved: false }).map((v) => v.language)]);
  const language = C.values(C.LANGUAGES).find((l) => !taken.has(l) && l !== 'other') || 'other';
  return {
    title: '',
    alt_titles: [source.title, source.alt_titles].filter(Boolean).join('\n'),
    description: source.description,
    type: source.type, status: source.status, year: source.year, age_rating: source.age_rating, language,
    story_authors: source.storyAuthors.map((a) => a.name).join(', '),
    artists: source.artists.map((a) => a.name).join(', '),
    genres: source.genres.map((g) => g.id),
    tags: source.tags.map((t) => t.id),
    link_to: source.id,
  };
}

function resolveTeam(req, rawTeamId, errors) {
  const teamId = toInt(rawTeamId);
  if (!teamId) {
    if (isStaff(req.user)) return null;
    errors.push('Выберите команду.');
    return null;
  }
  const allowed = uploadTeams(req.user).some((t) => t.id === teamId);
  if (!allowed) errors.push('Вы не можете загружать от имени этой команды.');
  return teamId;
}

router.post('/works/new', coverUpload.single('cover'), verifyCsrf, (req, res) => {
  if (!canUpload(req.user)) {
    cleanupTmp(req);
    return res.redirect('/teams/new');
  }
  const { data, errors } = W.validateWorkInput(req.body);
  const teamId = resolveTeam(req, req.body.team_id, errors);
  const source = sourceWork(req, req.body.link_to);
  if (source && V.getVersions(source.id, { onlyApproved: false }).concat([source]).some((v) => v.language === data.language)) {
    errors.push(`Версия на языке «${C.labelOf(C.LANGUAGES, data.language)}» уже есть. Выберите другой язык.`);
  }
  const reuseCover = !req.file && source && req.body.reuse_cover && source.cover;
  if (!req.file && !reuseCover) errors.push('Загрузите обложку.');
  else if (req.file) errors.push(...invalidImages([req.file]));
  if (errors.length) {
    cleanupTmp(req);
    return res.status(400).render('studio/work-form', { title: 'Новое произведение', work: null, errors, source, form: { ...req.body, ...data, team_id: teamId }, ...formOptions(req) });
  }
  const cover = req.file ? storeImage(req.file, 'covers', null) : copyPublic(source.cover, 'covers');
  const moderation = isStaff(req.user) ? 'approved' : 'pending';
  const id = W.saveWork(data, { teamId, uploaderId: req.user.id, moderation, cover });
  if (moderation === 'pending') {
    N.notifyStaff({ type: 'work_pending', title: 'Новое произведение на модерации', body: `«${data.title}» от ${req.user.username}`, link: '/admin/works' });
  }
  if (source) {
    try {
      V.linkWorks(source.id, id);
    } catch (err) {
      req.flash('error', `Произведение создано, но не связано: ${err.message}`);
    }
  }
  req.flash('success', moderation === 'approved'
    ? 'Произведение опубликовано. Теперь добавьте главы.'
    : 'Произведение отправлено на модерацию. Пока оно на проверке, вы уже можете загружать главы.');
  res.redirect(`/studio/works/${id}`);
});

/* ---------- Управление произведением ---------- */

router.get('/works/:id', loadEditableWork, (req, res) => {
  const work = req.work;
  res.render('studio/work', {
    title: work.title, work, chapters: W.getChapters(work.id, 'DESC'),
    versions: V.getVersions(work.id, { onlyApproved: false }),
  });
});

/* ---------- Языковые версии ---------- */

// Поиск произведений для связывания: опубликованные + свои.
router.get('/api/works', (req, res) => {
  const text = searchNormalize(req.query.q).slice(0, 100);
  if (text.length < 2) return res.json({ items: [] });
  const items = q(`SELECT w.id, w.slug, w.title, w.cover, w.language, w.type, w.year, w.moderation, w.team_id
    FROM works w WHERE w.search_text LIKE ? ESCAPE '\\' ORDER BY w.views DESC LIMIT 30`).all(`%${escapeLike(text)}%`)
    .filter((w) => w.moderation === 'approved' || canEditWork(req.user, w))
    .slice(0, 10)
    .map(({ team_id, ...w }) => ({ ...w, language_label: C.labelOf(C.LANGUAGES, w.language) }));
  res.json({ items });
});

router.post('/works/:id/versions', loadEditableWork, (req, res) => {
  const work = req.work;
  const target = q('SELECT id, moderation, team_id FROM works WHERE id = ?').get(toInt(req.body.target_id));
  if (!target || (target.moderation !== 'approved' && !canEditWork(req.user, target))) {
    req.flash('error', 'Выберите произведение из списка.');
  } else {
    try {
      V.linkWorks(work.id, target.id);
      req.flash('success', 'Версии связаны.');
    } catch (err) {
      if (!err.expose) throw err;
      req.flash('error', err.message);
    }
  }
  res.redirect(`/studio/works/${work.id}#versions`);
});

router.post('/works/:id/versions/:vid/unlink', loadEditableWork, (req, res) => {
  const work = req.work;
  const vid = toInt(req.params.vid);
  const sameGroup = V.getVersions(work.id, { onlyApproved: false }).some((v) => v.id === vid);
  if (sameGroup) {
    V.unlinkWork(vid);
    req.flash('success', 'Версия отвязана.');
  }
  res.redirect(`/studio/works/${work.id}#versions`);
});

router.get('/works/:id/edit', loadEditableWork, (req, res) => {
  const work = req.work;
  const form = {
    ...work,
    story_authors: work.storyAuthors.map((a) => a.name).join(', '),
    artists: work.artists.map((a) => a.name).join(', '),
    genres: work.genres.map((g) => g.id),
    tags: work.tags.map((t) => t.id),
  };
  res.render('studio/work-form', { title: `Редактирование: ${work.title}`, work, errors: [], form, ...formOptions(req) });
});

router.post('/works/:id/edit', coverUpload.single('cover'), verifyCsrf, loadEditableWork, (req, res) => {
  const work = req.work;
  const { data, errors } = W.validateWorkInput(req.body);
  let teamId = work.team_id;
  if (isStaff(req.user) || (req.body.team_id && toInt(req.body.team_id) !== work.team_id)) {
    teamId = resolveTeam(req, req.body.team_id, errors);
  }
  if (req.file) errors.push(...invalidImages([req.file]));
  if (V.getVersions(work.id, { onlyApproved: false }).some((v) => v.id !== work.id && v.language === data.language)) {
    errors.push(`У этого произведения уже есть связанная версия на языке «${C.labelOf(C.LANGUAGES, data.language)}».`);
  }
  if (errors.length) {
    cleanupTmp(req);
    return res.status(400).render('studio/work-form', { title: `Редактирование: ${work.title}`, work, errors, form: { ...req.body, ...data, team_id: teamId }, ...formOptions(req) });
  }
  let cover = null;
  if (req.file) cover = storeImage(req.file, 'covers', null);
  W.saveWork(data, { id: work.id, cover });
  if (cover) removePublic(work.cover);
  q('UPDATE works SET team_id = ? WHERE id = ?').run(teamId, work.id);
  if (work.moderation === 'rejected') {
    q(`UPDATE works SET moderation = 'pending', reject_reason = NULL WHERE id = ?`).run(work.id);
    N.notifyStaff({ type: 'work_pending', title: 'Произведение повторно на модерации', body: `«${data.title}» исправлено после отказа`, link: '/admin/works' });
    req.flash('success', 'Изменения сохранены, произведение повторно отправлено на модерацию.');
  } else {
    req.flash('success', 'Изменения сохранены.');
  }
  res.redirect(`/studio/works/${work.id}`);
});

router.post('/works/:id/delete', loadEditableWork, (req, res) => {
  const work = req.work;
  const ownerOfTeam = work.team_id && teamRole(req.user.id, work.team_id) === 'owner';
  if (!isStaff(req.user) && !ownerOfTeam && work.uploader_id !== req.user.id) {
    req.flash('error', 'Удалить произведение может только владелец команды или администрация.');
    return res.redirect(`/studio/works/${work.id}`);
  }
  const chapterIds = q('SELECT id FROM chapters WHERE work_id = ?').all(work.id).map((c) => c.id);
  q('DELETE FROM works WHERE id = ?').run(work.id);
  V.cleanupGroup(work.group_id);
  chapterIds.forEach((id) => removeDir(`chapters/${id}`));
  removePublic(work.cover);
  W.bumpTextIndex();
  req.flash('success', `«${work.title}» удалено.`);
  res.redirect('/studio');
});

/* ---------- Главы ---------- */

function chapterTeams(req, work) {
  // Глава загружается от имени команды тайтла, либо любой своей команды (для совместных переводов).
  const teams = uploadTeams(req.user);
  if (work.team_id && !teams.some((t) => t.id === work.team_id)) {
    teams.unshift({ id: work.team_id, name: work.team_name, slug: work.team_slug });
  }
  return teams;
}

function validateChapter(body, workId, excludeId = null) {
  const errors = [];
  const data = {
    volume: toInt(body.volume),
    number: Number(String(body.number || '').replace(',', '.')),
    title: String(body.title || '').trim().slice(0, 200),
  };
  if (!Number.isFinite(data.number) || data.number < 0 || data.number > 100000) errors.push('Укажите корректный номер главы (например, 12 или 12.5).');
  if (data.volume !== null && (data.volume < 0 || data.volume > 10000)) errors.push('Некорректный номер тома.');
  if (!errors.length) {
    const dup = q('SELECT id FROM chapters WHERE work_id = ? AND number = ? AND id != ?').get(workId, data.number, excludeId || 0);
    if (dup) errors.push(`Глава ${data.number} уже существует.`);
  }
  return { data, errors };
}

/** Проверяет сигнатуры всех файлов до сохранения главы. */
function invalidImages(files) {
  return files.filter((f) => !detectImageExt(f.path))
    .map((f) => `Файл «${f.originalname}» повреждён или не является изображением.`);
}

/** Сохраняет загруженные страницы главы, отсортированные по имени файла. */
function storePages(chapterId, files) {
  const sorted = [...files].sort((a, b) => naturalCompare(a.originalname, b.originalname));
  const stored = sorted.map((f, i) => storeImage(f, `chapters/${chapterId}`, String(i + 1).padStart(4, '0')));
  const ins = q('INSERT INTO pages (chapter_id, idx, path) VALUES (?, ?, ?)');
  stored.forEach((p, i) => ins.run(chapterId, i + 1, p));
  q('UPDATE chapters SET pages_count = ? WHERE id = ?').run(stored.length, chapterId);
}

router.get('/works/:id/chapters/new', loadEditableWork, (req, res) => {
  const work = req.work;
  const last = q('SELECT MAX(number) AS n, MAX(volume) AS v FROM chapters WHERE work_id = ?').get(work.id);
  res.render('studio/chapter-form', {
    title: `Новая глава — ${work.title}`, work, chapter: null, errors: [],
    form: { number: last.n !== null ? Math.floor(last.n) + 1 : 1, volume: last.v || '', team_id: work.team_id },
    teams: chapterTeams(req, work),
  });
});

router.post('/works/:id/chapters/new', pagesUpload.array('pages', 500), verifyCsrf, loadEditableWork, (req, res) => {
  const work = req.work;
  const { data, errors } = validateChapter(req.body, work.id);
  const teams = chapterTeams(req, work);
  let teamId = toInt(req.body.team_id) || work.team_id || null;
  if (teamId && !teams.some((t) => t.id === teamId)) errors.push('Нельзя загрузить главу от имени этой команды.');
  if (!req.files || !req.files.length) errors.push('Добавьте страницы главы (изображения).');
  else errors.push(...invalidImages(req.files));
  if (errors.length) {
    cleanupTmp(req);
    return res.status(400).render('studio/chapter-form', { title: `Новая глава — ${work.title}`, work, chapter: null, errors, form: { ...req.body }, teams });
  }
  let chapterId;
  try {
    chapterId = transaction(() => {
      const r = q('INSERT INTO chapters (work_id, volume, number, title, team_id, uploader_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(work.id, data.volume, data.number, data.title, teamId, req.user.id);
      const id = Number(r.lastInsertRowid);
      storePages(id, req.files);
      return id;
    });
  } catch (err) {
    cleanupTmp(req);
    throw err;
  }
  W.refreshLastChapter(work.id);
  if (work.moderation === 'approved') {
    N.notify(N.favoriteUserIds(work.id), {
      type: 'new_chapter',
      title: `Новая глава: ${work.title}`,
      body: `Глава ${data.number}${data.title ? ' — ' + data.title : ''}`,
      link: `/title/${work.slug}/chapter/${chapterId}`,
    }, { exclude: [req.user.id] });
  }
  req.flash('success', `Глава ${data.number} загружена (${req.files.length} стр.).`);
  if (req.body.another) return finish(req, res, `/studio/works/${work.id}/chapters/new`);
  finish(req, res, `/studio/works/${work.id}#chapters`);
});

function loadEditableChapter(req, res, next) {
  const chapter = q('SELECT * FROM chapters WHERE id = ?').get(toInt(req.params.cid));
  const work = chapter && W.getWorkById(chapter.work_id);
  if (!chapter || !canEditWork(req.user, work)) {
    cleanupTmp(req);
    return next('route');
  }
  req.chapter = chapter;
  req.work = work;
  next();
}

router.get('/chapters/:cid/edit', loadEditableChapter, (req, res) => {
  const { work, chapter } = req;
  const pages = q('SELECT idx, path FROM pages WHERE chapter_id = ? ORDER BY idx').all(chapter.id);
  res.render('studio/chapter-form', { title: `Глава ${chapter.number} — ${work.title}`, work, chapter, pages, errors: [], form: chapter, teams: chapterTeams(req, work) });
});

router.post('/chapters/:cid/edit', pagesUpload.array('pages', 500), verifyCsrf, loadEditableChapter, (req, res) => {
  const { work, chapter } = req;
  const { data, errors } = validateChapter(req.body, work.id, chapter.id);
  const teams = chapterTeams(req, work);
  const teamId = toInt(req.body.team_id) || chapter.team_id;
  if (teamId && teamId !== chapter.team_id && !teams.some((t) => t.id === teamId)) errors.push('Нельзя назначить эту команду.');
  if (req.files && req.files.length) errors.push(...invalidImages(req.files));
  if (errors.length) {
    cleanupTmp(req);
    const pages = q('SELECT idx, path FROM pages WHERE chapter_id = ? ORDER BY idx').all(chapter.id);
    return res.status(400).render('studio/chapter-form', { title: `Глава ${chapter.number} — ${work.title}`, work, chapter, pages, errors, form: { ...chapter, ...req.body }, teams });
  }
  q('UPDATE chapters SET volume = ?, number = ?, title = ?, team_id = ? WHERE id = ?')
    .run(data.volume, data.number, data.title, teamId, chapter.id);
  if (req.files && req.files.length) {
    // Полная замена страниц.
    const old = q('SELECT path FROM pages WHERE chapter_id = ?').all(chapter.id);
    q('DELETE FROM pages WHERE chapter_id = ?').run(chapter.id);
    old.forEach((p) => removePublic(p.path));
    storePages(chapter.id, req.files);
  }
  req.flash('success', 'Глава сохранена.');
  finish(req, res, `/studio/works/${work.id}#chapters`);
});

router.post('/chapters/:cid/delete', loadEditableChapter, (req, res) => {
  const { work, chapter } = req;
  q('DELETE FROM chapters WHERE id = ?').run(chapter.id);
  removeDir(`chapters/${chapter.id}`);
  W.refreshLastChapter(work.id);
  req.flash('success', `Глава ${chapter.number} удалена.`);
  res.redirect(`/studio/works/${work.id}#chapters`);
});

module.exports = router;
