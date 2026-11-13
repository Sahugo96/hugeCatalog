# HugeCatalog — устройство сайта, база данных и функционал

Подробное описание для разработчиков (и для Claude Code в следующих сессиях). Краткая памятка — в `CLAUDE.md`.

## 1. Стек и запуск

- **Node.js ≥ 22.13**, Express 5, шаблоны EJS (серверный рендеринг), CSS/JS без сборки.
- **SQLite** через встроенный `node:sqlite` (`DatabaseSync`), файл `data/hugecatalog.db`.
- Зависимости: `express`, `ejs`, `express-session`, `multer` (загрузка файлов), `sharp` (WebP и миниатюры).
- Все данные: `DATA_DIR` (по умолчанию `./data`) — база + `uploads/`. Папка в `.gitignore`.

| Команда | Что делает |
|---|---|
| `npm start` / `npm run dev` | сервер (порт `PORT`, по умолчанию 3000); `.env` подхватывается автоматически |
| `npm test` | тесты `node:test` из `test/*.test.js` (каждый файл — своя временная база) |
| `npm run seed:demo` | демо-данные (команда Demo Scans, тайтлы, языковые версии, пользователи `demo`, `reader1…12`, пароль `demo12345`) |
| `npm run import -- file.json [--create-missing] [--skip-covers]` | импорт произведений из JSON |
| `npm run images:webp [-- --force]` | массовое сжатие картинок в WebP |
| `npm run admin:password -- <пароль> [логин]` | смена пароля администратора |

Переменные окружения: `PORT`, `SESSION_SECRET` (обязательна в production), `ADMIN_USERNAME`/`ADMIN_PASSWORD`/`ADMIN_EMAIL` (первый админ), `DATA_DIR`, `DB_PATH`, `SITE_NAME`, `COOKIE_SECURE=1`, `TRUST_PROXY=1`, `WEBP_QUALITY`.

## 2. Структура кода

```
server.js                    точка входа: ensureBootstrap() + createApp().listen()
src/app.js                   Express: заголовки безопасности, статика, /uploads (WebP, миниатюры),
                             сессии, i18n, flash, loadUser, CSRF, роутеры, обработчик ошибок
src/db.js                    подключение SQLite, schema.sql, МИГРАЦИИ (ALTER TABLE …), transaction(), q() — кэш prepared statements
src/schema.sql               базовая схема (CREATE TABLE IF NOT EXISTS)
src/bootstrap.js             жанры/теги по умолчанию, перенос английских названий из словаря, первый админ
src/auth.js                  хеш паролей (scrypt), loadUser, requireAuth/Staff/Admin, CSRF, flash, rate limit, canEditWork
src/constants.js             TYPES, STATUSES, LANGUAGES, AGE_RATINGS, SORTS, FORMATS, TAG_GROUPS, ROLES
src/util.js                  slugify (транслит), uniqueSlug, timeAgo/formatDate (ru/en), plural, searchNormalize…
src/upload.js                multer, проверка сигнатур картинок, storeImage, removePublic/removeDir,
                             workFolder, chapterFilePaths, removeChapterFiles
src/webp.js                  WebP-копии (как WebP Express), миниатюры ?thumb=1, настройки, массовая обработка
src/realtime.js              Server-Sent Events: /api/stream, рассылка событий пользователям
src/flags.js, src/icons.js   SVG-флаги языков и иконки
src/i18n/index.js, en.js     перевод интерфейса ru/en
src/services/works.js        каталог, главная, страницы тайтла, похожие, лайки, просмотры, формат «сингл», удаление
src/services/versions.js     языковые версии (связка group_id)
src/services/import.js       импорт из JSON (серии, главы, теги-объекты, обложки) + код скачивания сканов владельца
src/services/chat.js         общий чат, личные сообщения, жалобы, блокировки, запрет писать, журнал модерации
src/services/notify.js       уведомления и счётчики непрочитанного
src/services/taxonomy-i18n.js английские названия жанров/тегов из БД → переводчик
src/routes/public.js         главная, каталог, тайтл, читалка, /lang, /api/search, /api/authors, лайки/избранное, about/privacy
src/routes/auth.js           вход, регистрация, выход
src/routes/user.js           профиль, настройки, публичный профиль
src/routes/teams.js          команды: список, заявка, страница, участники
src/routes/studio.js         студия: тайтлы, главы, страницы сингла, языковые версии, смена формата (админ)
src/routes/admin.js          админка: модерация, таксономия, пользователи, импорт, чат, изображения
src/routes/chat.js           API чата и уведомлений, /notifications
views/                       EJS: partials (header/footer/card/shelf/pagination/admin-nav), страницы, studio/, admin/, user/, teams/, auth/
public/css/style.css, chat.css; public/js/app.js (общий), chat.js (чат/уведомления), reader.js (читалка)
browser-extension/           MV3-расширение: данные галереи 3hentai → буфер обмена в формате импорта
scripts/                     seed-demo, import, webp, admin-password
test/                        тесты
```

## 3. База данных

### 3.1. Произведение и всё, что к нему привязано

```
works (произведение; одна запись = одна языковая версия)
├── id               INTEGER PK AUTOINCREMENT
├── slug             TEXT UNIQUE          адрес /title/<slug> (транслит названия, -2, -3 при совпадении)
├── title            TEXT NOT NULL
├── alt_titles       TEXT                 альтернативные названия, по одному на строку
├── description      TEXT
├── cover            TEXT                 импорт: /uploads/works/<slug>/cover.<ext>; студия: /uploads/covers/<hex>.<ext>
├── type             TEXT                 manga | manhwa | manhua | webtoon | comic | oel | russian | doujinshi | other
├── status           TEXT                 announced | ongoing | completed | hiatus | cancelled
├── year             INTEGER              год начала (может быть NULL)
├── language         TEXT                 ja | ko | zh | en | ru | uk | fr | es | de | other — язык ЭТОЙ версии
├── age_rating       TEXT                 0+ | 6+ | 12+ | 16+ | 18+
├── team_id          FK → teams.id        ON DELETE SET NULL
├── uploader_id      FK → users.id        ON DELETE SET NULL
├── group_id         INTEGER              связка языковых версий (одинаковый у всех версий; id одной из них)
├── is_single        INTEGER 0/1          формат: 0 — по главам, 1 — сингл (ваншот)
├── import_key       TEXT                 slug серии из импорта (series) — сборка глав и версий
├── moderation       TEXT                 pending | approved | rejected
├── reject_reason    TEXT
├── views            INTEGER              прочтения глав (уникальные пары пользователь+глава)
├── likes_count      INTEGER              денормализованные счётчики
├── favs_count       INTEGER
├── search_text      TEXT                 нижний регистр: название + альт. названия + авторы (поиск LIKE)
├── created_at, published_at, last_chapter_at  TEXT (UTC, формат SQLite)
│
├── work_authors   (work_id FK CASCADE, author_id FK → authors CASCADE, role 'story'|'art')  PK(work_id, author_id, role)
├── work_genres    (work_id FK CASCADE, genre_id FK → genres CASCADE)                       PK(work_id, genre_id)
├── work_tags      (work_id FK CASCADE, tag_id FK → tags CASCADE)                           PK(work_id, tag_id)
│
├── chapters       (главы; у сингла — одна служебная глава №1 = галерея)
│   ├── id PK, work_id FK CASCADE, volume INTEGER NULL, number REAL (12.5 допустим), title
│   ├── team_id FK SET NULL, uploader_id FK SET NULL
│   ├── pages_count INTEGER       0 → глава-«каркас», скрыта от читателей
│   ├── views INTEGER, created_at
│   │
│   ├── pages      (id PK, chapter_id FK CASCADE, idx 1…N — порядок, path '/uploads/…')
│   ├── chapter_reads   (user_id, chapter_id) PK — учёт прочтений (один раз на пользователя и главу)
│   └── reading_history (user_id, work_id) PK, chapter_id — «продолжить чтение»
│
├── likes          (user_id, work_id) PK, created_at
├── favorites      (user_id, work_id) PK, created_at
└── daily_views    (work_id, day 'YYYY-MM-DD') PK, views, reads — для «Читаемые сегодня», топов
```

Справочники:
```
authors (id, name UNIQUE NOCASE, slug UNIQUE)          — создаются автоматически при сохранении тайтла, сироты удаляются
genres  (id, name UNIQUE, slug UNIQUE, name_en)         — name_en редактируется в админке
tags    (id, name UNIQUE, slug UNIQUE, tag_group, name_en)
        tag_group ∈ Сюжет | Рисовка | Персонажи | Сеттинг | Пародия | Прочее
```

### 3.2. Пользователи, команды, общение, служебное

```
users          id, username UNIQUE NOCASE, email UNIQUE NOCASE, password_hash (scrypt$соль$хеш),
               role user|moderator|admin, is_banned, avatar, about, chat_muted_until, created_at
sessions       sid PK, data JSON, expires (мс) — хранилище express-session
teams          id, name UNIQUE, slug UNIQUE, description, avatar, owner_id FK, status pending|approved|rejected, reject_reason, …
team_members   (team_id, user_id) PK, role owner|member
notifications  id, user_id FK, type, title, body, link, is_read, created_at   (текст хранится по-русски, переводится при выводе)
conversations  id, user_a < user_b UNIQUE, a_last_read, b_last_read, last_message_at
chat_messages  id, conversation_id (NULL = общий чат), sender_id, body, created_at, deleted_at, deleted_by
chat_reports   id, message_id, reporter_id UNIQUE(message_id, reporter_id), reason, resolved_by, resolved_at
user_blocks    (blocker_id, blocked_id) PK
moderation_log id, actor_id, action, target, details, created_at
               action: view_conversation, search_messages, delete_message, dismiss_report, mute, unmute,
                       delete_work, set_single, set_chapters
settings       key PK, value — настройки WebP (webp_enabled, webp_on_upload, webp_quality, webp_png)
```

### 3.3. Миграции

Новые колонки добавляются в `src/db.js` проверкой `hasColumn(...)` + `ALTER TABLE` (база пользователя уже существует, `schema.sql` выполняется только как `CREATE TABLE IF NOT EXISTS`). Добавленные так: `works.group_id`, `works.is_single`, `works.import_key`, `genres.name_en`, `tags.name_en`, `users.chat_muted_until`. Новые таблицы — в `schema.sql` (кроме `settings`, она создаётся в `webp.js`).

### 3.4. Файлы

```
data/uploads/covers/<hex>.<ext>               обложки, загруженные в студии (и копии для новой языковой версии)
data/uploads/chapters/<chapter_id>/0001.<ext>  страницы, загруженные через студию (storePages)
data/uploads/teams/…                          аватары команд
data/uploads/works/<slug>/cover.<ext>         обложка из импорта (downloadCover → storeInWork)
data/uploads/works/<slug>/gallery|chapterN/NNN.<ext>  сканы из импорта (код владельца; в таблицу pages не пишутся)
                                              вся папка works/<slug> удаляется вместе с произведением
<файл>.webp, <файл>.thumb.webp                WebP-копия и миниатюра 320px рядом с оригиналом
data/uploads/.tmp/                            временные файлы загрузок
```

Удаление (`W.deleteWork`): строки удаляются каскадом, затем стираются файлы всех страниц по путям из `pages` (с WebP и миниатюрами), папки `chapters/<id>`, опустевшие папки, обложка и вся папка `works/<slug>`. Удаление главы и перевод в сингл чистят файлы так же.

## 4. Ключевая логика

- **Видимость.** Публично видны только `works.moderation = 'approved'`. Неодобренные видны команде тайтла и персоналу (`canEditWork`). Главы с `pages_count = 0` скрыты от читателей (списки, счётчики, «первая глава», обновления), в студии помечены «нет страниц — загрузить».
- **Сингл.** `is_single = 1`: страницы — одна служебная глава (наименьший номер). Страница тайтла: вкладка «Галерея» (миниатюры → читалка `?page=N`), без списка глав. Читалка без навигации по главам. Студия: блок «Страницы», `/studio/works/:id/pages` открывает загрузку/замену. Новые главы у сингла создать нельзя.
- **Смена формата** (только `admin`, студия → «Формат публикации»): главы → сингл через страницу подтверждения со списком удаляемого и обязательной галочкой `confirm=1` (проверяется на сервере): первая глава становится галереей (№1, без тома и названия), остальные удаляются с файлами. Сингл → главы: галерея становится «Главой 1».
- **Языковые версии.** Общий `group_id`; в связке не больше одной версии на язык (`versions.linkWorks`). На странице тайтла — флаги со ссылками. Версии не попадают в «Похожие». «Добавить версию на другом языке» копирует авторов, жанры, теги, формат, обложку.
- **Каталог.** `W.parseFilters` + `W.searchCatalog`: для каждого критерия включение и исключение (`genre`/`genre_ex`, `tag`/`tag_ex`, `type`, `lang`, `age`, `status`, `format`, `author`), режим «все/любой» для жанров и тегов, годы, число глав, команда, поиск по `search_text`, сортировки из `C.SORTS`.
- **Похожие.** По жанрам/тегам (взвешенное пересечение), по сюжету (TF-IDF описаний + общие теги группы «Сюжет», индекс в памяти, сбрасывается `bumpTextIndex()`), по рисовке (общий художник, теги группы «Рисовка», тип).
- **Просмотры.** Засчитываются только при открытии главы вошедшим пользователем, один раз на пару пользователь+глава (`W.recordChapterRead`, таблица `chapter_reads`) → `works.views`, `chapters.views`, `daily_views.reads`. Гости и открытие карточки не считаются.
- **Главная:** баннер популярного, «Продолжить чтение», «Свежие обновления» (по `last_chapter_at`), «Топ за сегодня» (лайки×10 + прочтения за день, иначе за неделю), «Читаемые сегодня» (`daily_views.reads`), «Новинки», «Топ недели», «Завершённые», жанры, статистика.
- **Импорт** (`services/import.js`, админка → Импорт или CLI): JSON-объект или массив. `series` + `chapter` → выпуски одной серии на одном языке собираются в одно произведение с главами-каркасами (`import_key`), версии на других языках связываются; `format: 'single'` → сингл без глав (но если серия уже ведётся по главам — добавляется главой). Жанры/теги — строки или объекты `{ name, name_en, group }`, поиск по `name` и `name_en`, при `createMissing` новые создаются с `name_en` и группой. `cover_url` скачивается (до 8 МБ, проверка сигнатуры) в `works/<slug>/cover.<ext>`: сначала создаётся запись (нужен slug), потом `UPDATE works SET cover`. Импортированное сразу `approved`.
- **Сканы при импорте.** Код скачивания сканов (`scans_gallery` → `uploads/works/<slug>/gallery|chapterN/`) написал владелец проекта сам. Он не записывает страницы в `pages`/`pages_count` (колбэк `options.onScans` нигде не передаётся), поэтому скачанные сканы на сайте не видны. Решение Claude: этот код не трогать и не удалять, но и не дописывать/не чинить скачивание чужих сканов и их регистрацию в базе. Если код владельца ломает остальное — сообщать, где проблема.
- **WebP** (`src/webp.js`): рядом с JPG/PNG создаётся `.webp`; браузеру с `Accept: image/webp` по тому же адресу отдаётся копия (`Vary: Accept`), если она меньше оригинала. Конвертация: в фоне после загрузки, на лету для старых файлов, массово из админки. Миниатюры галереи: `/uploads/...jpg?thumb=1` → `.thumb.webp` 320px.
- **Мгновенные события** (`realtime.js`, SSE `/api/stream`): одно соединение на браузер — его держит «ведущая» вкладка (Web Locks), остальным события раздаются через BroadcastChannel (иначе при 6+ вкладках браузер упирался в лимит соединений HTTP/1.1 и сайт «зависал»). События: `counters`, `notification`, `global`, `dm`, `deleted`. Работает в одном процессе Node.
- **Уведомления**: новая глава в избранном; команда/тайтл одобрены или отклонены; добавление в команду; персоналу — новые заявки, тайтлы на модерации, жалобы; запрет писать в чат. Колокольчик в шапке, `/notifications`.
- **Чат**: общий (читают все, пишут вошедшие) и личные; 1 сообщение/сек, 20/мин, до 1000 символов; жалобы, блокировка собеседника, удаление своих сообщений; запрет писать (`chat_muted_until`).
- **i18n** (`src/i18n`): ключ — русская строка. В шаблонах `__('…')`, `__n(n, 'глава','главы','глав')`, на сервере `req.__()`, в браузере `T('…')` (словарь клиентских строк собирается из `public/js/*.js` и вставляется в страницу). Шаблоны с `{плейсхолдерами}` срабатывают и для собранных строк. Английские названия жанров/тегов берутся из БД (`name_en`) раньше словаря. Язык: cookie `lang` → `Accept-Language` → ru; переключатель — в меню пользователя. Английские страницы `about-en.ejs`, `privacy-en.ejs`.
- **Безопасность**: CSRF-токен во всех формах (`_csrf`) и AJAX (`X-CSRF-Token`); multipart-формы проверяются после multer (`verifyCsrf` в роутере). Пароли scrypt. Загрузки проверяются по сигнатуре (jpg, png, webp, gif, avif), `/uploads` отдаётся с CSP `sandbox` и `nosniff`. Rate limit на вход и регистрацию. Тема и язык — без сторонних cookie.

## 5. Функционал по ролям

### Гость
- Главная, каталог с фильтрами (включить/исключить, «все/любой»), поиск в шапке с подсказками, случайный тайтл (иконка кубиков).
- Страница тайтла: информация (все поля — ссылки в каталог), флаги языковых версий, жанры/теги, описание, список глав или галерея сингла, похожие (3 вкладки). Подтверждение 18+.
- Читалка: лента/по страницам, ширина, отступы, клавиши ← → A D F, свайпы, прогресс.
- Чтение общего чата (писать нельзя). Тёмная/светлая тема. Язык — по настройкам браузера.
- Просмотры гостя не засчитываются.

### Зарегистрированный пользователь (`user`)
- Всё, что у гостя, плюс: лайки, избранное, история чтения и «Продолжить чтение», засчитываемые прочтения.
- Профиль (`/profile`: избранное, понравилось, история, мои команды), настройки (о себе, пароль, тема), публичный профиль.
- Уведомления (колокольчик), общий чат и личные сообщения («Написать сообщение» в профиле), жалобы, блокировка.
- Переключатель языка сайта в меню пользователя.
- Заявка на создание команды (`/teams/new`) — до одобрения модератором.

### Публицист (участник одобренной команды)
- Студия (`/studio`, ссылка в меню пользователя): свои тайтлы со статусами модерации и причинами отказа.
- Добавление тайтла: обложка, название, альт. названия, описание, авторы и художники, тип, язык версии, год, статус, рейтинг, формат (главы/сингл), жанры, теги. Тайтл уходит на модерацию; главы можно грузить сразу.
- Главы: номер (12.5), том, название, команда, страницы (перетаскивание, порядок по именам файлов, прогресс загрузки), замена страниц, удаление. У сингла — «Страницы» одной галереей.
- Языковые версии: «Добавить версию на другом языке», связывание поиском, отвязка.
- Редактирование тайтла (отклонённый после правки снова уходит на модерацию). Удаление — владелец команды или загрузивший.
- Владелец команды: правка команды, добавление/исключение участников, удаление неодобренной команды.

### Модератор (`moderator`)
- Админ-панель: обзор; модерация тайтлов (опубликовать, отклонить, снять с публикации с причиной) и команд; жанры/теги/авторы (с английскими названиями, фильтр «без перевода»); импорт; чат — жалобы и общий чат (удаление, запрет писать).
- Может редактировать любой тайтл в студии. Его тайтлы публикуются без модерации.
- Не видит личные переписки, пользователей, «Изображения»; не меняет формат; причина `admin` для него — обычная причина.

### Администратор (`admin`)
- Всё, что у модератора, плюс:
- **Причина `admin`** при отклонении/снятии с публикации — полное удаление тайтла из базы с файлами (подтверждение в браузере, уведомление команде, запись в журнале).
- **Смена формата** главы ↔ сингл с подтверждением.
- **Пользователи**: роли, блокировка.
- **Чат**: все личные переписки (просмотр записывается в журнал), поиск по всем сообщениям, журнал модерации.
- **Изображения**: статистика WebP, «Сжать все несжатые», «Пересоздать все», «Удалить все WebP», настройки (отдача WebP, сжатие при загрузке, качество JPEG, режим PNG).
- Первый админ создаётся при старте из `ADMIN_*` в `.env`; пароль меняется `npm run admin:password`.

## 6. Расширение браузера (`browser-extension/`)

MV3 (Chrome/Edge/Яндекс/Opera; Firefox — временное дополнение). Кнопка на странице галереи `…3hentai.net/d/<id>` копирует запись для импорта. Берёт всё из блока `#main-info`: заголовок, каждое поле `.tag-container`, обложку `.main-cover img` (`cover.jpg`). Разбор названия `[Кружок (Автор)] Серия №N ~подзаголовок~ / Перевод [Язык][Команда]` → `series`, `chapter`, `format` (сингл, если нет номера и тега `multi-work series`), язык, `translator`, авторы. Теги — все, объектами `{ name, name_en, group }` (персонажи → «Персонажи», пародии → «Пародия»), сырые поля — `source_fields`. Режим «собирать несколько галерей». Поле `scans_gallery` добавил владелец (см. п. 4 про сканы).

## 7. Тесты

`npm test` — 24 теста: каталог и фильтры, похожие, лайки, HTTP и доступ, просмотры, языковые версии, импорт (серии, главы, теги-объекты, синглы), чат и уведомления, переводы и переключение языка, удаление командой `admin`, английские названия таксономии, WebP и миниатюры, синглы (смена формата с подтверждением, галерея), удаление файлов произведения. Каждый файл создаёт свою временную `DATA_DIR`.
