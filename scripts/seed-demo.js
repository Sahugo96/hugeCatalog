'use strict';

/**
 * Наполняет базу демонстрационными данными: команда, тайтлы со сгенерированными
 * SVG-обложками и страницами, главы, просмотры и лайки.
 *   npm run seed:demo
 * Повторный запуск ничего не дублирует (тайтлы с тем же названием пропускаются).
 */

const fs = require('node:fs');
const path = require('node:path');
const { q, transaction, UPLOAD_DIR } = require('../src/db');
const { ensureBootstrap } = require('../src/bootstrap');
const { hashPassword } = require('../src/auth');
const W = require('../src/services/works');
const { today } = require('../src/util');

ensureBootstrap();

const PALETTES = [
  ['#2b1d6b', '#e0479e'], ['#0f3443', '#34e89e'], ['#3a1c71', '#ffaf7b'], ['#141e30', '#4ca1af'],
  ['#42275a', '#f2994a'], ['#1f4037', '#99f2c8'], ['#8e2de2', '#4a00e0'], ['#b92b27', '#1565c0'],
  ['#232526', '#f7797d'], ['#000046', '#1cb5e0'], ['#5a3f37', '#e8cbc0'], ['#0b486b', '#f56217'],
];

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function wrap(text, max) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > max) { lines.push(line.trim()); line = w; } else line += ' ' + w;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.slice(0, 4);
}

function coverSvg(title, type, [a, b], seed) {
  const lines = wrap(title, 14);
  const circles = Array.from({ length: 6 }, (_, i) => {
    const x = (seed * 37 + i * 71) % 400;
    const y = (seed * 53 + i * 97) % 600;
    const r = 30 + ((seed + i * 13) % 90);
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff" opacity="${0.05 + (i % 3) * 0.04}"/>`;
  }).join('');
  const text = lines.map((l, i) => `<text x="28" y="${430 + i * 42 - lines.length * 21}" font-size="36" font-weight="800" fill="#fff" font-family="Arial, sans-serif">${esc(l)}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>
<linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset=".45" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".65"/></linearGradient></defs>
<rect width="400" height="600" fill="url(#g)"/>${circles}<rect width="400" height="600" fill="url(#s)"/>
<text x="28" y="56" font-size="18" font-weight="700" fill="#fff" opacity=".85" font-family="Arial, sans-serif" letter-spacing="3">${esc(type.toUpperCase())}</text>
${text}</svg>`;
}

function pageSvg(title, chapter, page, total, [a, b]) {
  const panels = [
    `<rect x="40" y="40" width="720" height="380" rx="8" fill="#fff" stroke="#111" stroke-width="5"/>`,
    `<rect x="40" y="450" width="345" height="420" rx="8" fill="#fff" stroke="#111" stroke-width="5"/>`,
    `<rect x="415" y="450" width="345" height="420" rx="8" fill="#fff" stroke="#111" stroke-width="5"/>`,
    `<rect x="40" y="900" width="720" height="260" rx="8" fill="#fff" stroke="#111" stroke-width="5"/>`,
  ].join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200" viewBox="0 0 800 1200">
<rect width="800" height="1200" fill="#f4f1ea"/>${panels}
<circle cx="400" cy="230" r="120" fill="${a}" opacity=".85"/><circle cx="470" cy="200" r="60" fill="${b}" opacity=".8"/>
<path d="M90 820 Q 212 560 335 820 Z" fill="${b}" opacity=".7"/><path d="M465 820 L 590 520 L 710 820 Z" fill="${a}" opacity=".7"/>
<ellipse cx="560" cy="1030" rx="160" ry="70" fill="#fff" stroke="#111" stroke-width="4"/>
<text x="560" y="1042" font-size="28" text-anchor="middle" font-family="Arial, sans-serif" fill="#111">Глава ${chapter}…</text>
<text x="80" y="1000" font-size="30" font-weight="700" font-family="Arial, sans-serif" fill="#111">${esc(title.slice(0, 26))}</text>
<text x="80" y="1110" font-size="26" font-family="Arial, sans-serif" fill="#555">Страница ${page} из ${total}</text>
</svg>`;
}

const DEMO = [
  { title: 'Клинок северного ветра', type: 'manhwa', lang: 'ko', year: 2019, age: '16+', status: 'ongoing', authors: ['Пак Чжи Хун'], artists: ['Ли Мин Со'],
    genres: ['Боевик', 'Фэнтези', 'Приключения', 'Боевые искусства'], tags: ['Месть', 'Регрессия', 'Сильный главный герой', 'Цветная', 'Динамичные сражения', 'Мурим'],
    desc: 'Последний мастер меча погибает от руки предателя, но возвращается на десять лет назад. Теперь он знает, кто разрушит его клан, и готов на всё ради мести. Холодный северный ветер ведёт его клинок через турниры, интриги и древние секты.' },
  { title: 'Башня тысячи этажей', type: 'manhwa', lang: 'ko', year: 2020, age: '12+', status: 'ongoing', authors: ['Ким Дон Хён'], artists: ['Ли Мин Со'],
    genres: ['Фэнтези', 'Приключения', 'Боевик'], tags: ['Башня', 'Система', 'Игровой мир', 'Цветная', 'Красивая рисовка', 'Становление героя'],
    desc: 'Посреди города появляется башня, и каждый, кто поднимется на вершину, получит исполнение желания. Слабый студент получает систему, которая показывает скрытые пути. Этаж за этажом он раскрывает тайну башни и её создателей.' },
  { title: 'Чайный домик у подножия гор', type: 'manga', lang: 'ja', year: 2016, age: '0+', status: 'completed', authors: ['Ёсида Хана'], artists: [],
    genres: ['Повседневность', 'Кулинария', 'Драма'], tags: ['Япония', 'Медленное развитие', 'Чёрно-белая', 'Акварель'],
    desc: 'Юная Мио наследует старый чайный домик в горной деревне. Каждый посетитель приносит свою историю, а каждая чашка чая помогает кому-то найти утешение. Тёплая история о взрослении, семье и простых радостях.' },
  { title: 'Академия звёздных магов', type: 'manga', lang: 'ja', year: 2018, age: '12+', status: 'ongoing', authors: ['Танака Рё'], artists: ['Мори Аюми'],
    genres: ['Фэнтези', 'Школа', 'Комедия', 'Сёнэн'], tags: ['Академия магии', 'Магия', 'Становление героя', 'Чёрно-белая', 'Детальные фоны'],
    desc: 'Мальчик без капли магии по ошибке попадает в элитную академию звёздных магов. Чтобы его не исключили, он должен пройти испытания, полагаясь на смекалку и друзей. Но в звёздах скрыта древняя сила, которая выбрала именно его.' },
  { title: 'Злодейка хочет спокойной жизни', type: 'manhwa', lang: 'ko', year: 2021, age: '12+', status: 'ongoing', authors: ['Со Ын Би'], artists: ['Хан Да Ён'],
    genres: ['Романтика', 'Фэнтези', 'Комедия', 'Дзёсэй'], tags: ['Злодейка', 'Перерождение', 'Королевский двор', 'Цветная', 'Красивая рисовка', 'Фальшивые отношения'],
    desc: 'Офисная работница перерождается в злодейке любовного романа, которой суждено быть казнённой. Она решает избежать всех сюжетных поворотов и тихо жить в провинции, но главный герой почему-то не отстаёт от неё.' },
  { title: 'Пепел империи', type: 'manhua', lang: 'zh', year: 2017, age: '16+', status: 'hiatus', authors: ['Лин Фэй'], artists: ['Лин Фэй'],
    genres: ['Исторический', 'Драма', 'Военный', 'Боевик'], tags: ['Война', 'Политические интриги', 'Китай', 'Цветная', 'Реалистичная рисовка'],
    desc: 'Империя рушится под натиском кочевников, а при дворе плетут заговоры евнухи и министры. Бывший генерал, изгнанный за правду, собирает армию из беглецов, чтобы защитить страну, которая его предала.' },
  { title: 'Культиватор из другого мира', type: 'manhua', lang: 'zh', year: 2022, age: '12+', status: 'ongoing', authors: ['Чжан Вэй'], artists: ['Ху Лань'],
    genres: ['Фэнтези', 'Боевые искусства', 'Исекай', 'Комедия'], tags: ['Культивация', 'Другой мир', 'Система', 'Цветная', '3D-элементы'],
    desc: 'Программист попадает в мир культивации и обнаруживает, что может видеть техники как программный код. Он оптимизирует древние методики, приводя в ужас старейшин сект, и стремительно поднимается к бессмертию.' },
  { title: 'Ночной детектив Токио', type: 'manga', lang: 'ja', year: 2014, age: '16+', status: 'completed', authors: ['Ватанабэ Кэн'], artists: [],
    genres: ['Детектив', 'Мистика', 'Сверхъестественное', 'Сэйнэн', 'Триллер'], tags: ['Тайна', 'Япония', 'Современность', 'Чёрно-белая', 'Реалистичная рисовка', 'Кицунэ'],
    desc: 'Частный детектив берётся только за дела, которые происходят после полуночи. Пропавшие люди, проклятые вещи и лисы-оборотни: в ночном Токио граница между мирами тонка, а каждая тайна ведёт к его собственному прошлому.' },
  { title: 'Последний сигнал', type: 'webtoon', lang: 'en', year: 2023, age: '16+', status: 'ongoing', authors: ['Sarah Collins'], artists: ['Mike Ortega'],
    genres: ['Научная фантастика', 'Постапокалиптика', 'Триллер'], tags: ['Космос', 'Выживание', 'Будущее', 'Цветная', 'Минимализм'],
    desc: 'Экипаж исследовательской станции принимает сигнал с Земли, которая молчит уже двадцать лет. Чтобы узнать правду, им придётся вернуться домой и выжить в мире, где сигнал оказался ловушкой.' },
  { title: 'Король подземелий в отставке', type: 'manhwa', lang: 'ko', year: 2022, age: '16+', status: 'ongoing', authors: ['Ким Дон Хён'], artists: ['Чо Сон Мин'],
    genres: ['Фэнтези', 'Боевик', 'Комедия'], tags: ['Подземелья', 'Сильный главный герой', 'Монстры', 'Цветная', 'Динамичные сражения'],
    desc: 'Сильнейший охотник уходит на пенсию и открывает кафе рядом с вратами подземелья. Но монстры, гильдии и бывшие ученики не дают ему спокойно варить кофе. Комедийный экшен о герое, который устал спасать мир.' },
  { title: 'Сад потерянных писем', type: 'manga', lang: 'ja', year: 2012, age: '6+', status: 'completed', authors: ['Ёсида Хана'], artists: [],
    genres: ['Драма', 'Повседневность', 'Сёдзё', 'Романтика'], tags: ['Медленное развитие', 'Чёрно-белая', 'Акварель', 'Современность'],
    desc: 'Почтальонша маленького городка находит в саду ящик с письмами, которые так и не дошли до адресатов. Она решает доставить каждое, и с каждым письмом меняются чьи-то судьбы — и её собственная.' },
  { title: 'Хроники драконьего всадника', type: 'oel', lang: 'en', year: 2015, age: '12+', status: 'cancelled', authors: ['Daniel Reeves'], artists: ['Anna Petrova'],
    genres: ['Фэнтези', 'Приключения'], tags: ['Драконы', 'Средневековье', 'Становление героя', 'Чёрно-белая'],
    desc: 'Сирота из горной деревни находит яйцо дракона. Королевство охотится за последними драконами, и юному всаднику придётся бежать, учиться летать и сражаться, чтобы спасти своего друга.' },
  { title: 'Ведьма с окраины Москвы', type: 'russian', lang: 'ru', year: 2021, age: '16+', status: 'ongoing', authors: ['Анна Воронцова'], artists: ['Илья Северов'],
    genres: ['Мистика', 'Сверхъестественное', 'Комедия', 'Повседневность'], tags: ['Магия', 'Современность', 'Главная героиня', 'Цветная', 'Красивая рисовка'],
    desc: 'Потомственная ведьма снимает однушку в спальном районе и пытается совмещать работу в офисе с охраной города от нечисти. Домовой ворчит, соседи подозревают, а начальник, кажется, тоже не совсем человек.' },
  { title: 'Кровавая луна над Сеулом', type: 'manhwa', lang: 'ko', year: 2018, age: '18+', status: 'completed', authors: ['Пак Чжи Хун'], artists: ['Хан Да Ён'],
    genres: ['Ужасы', 'Сверхъестественное', 'Триллер', 'Романтика'], tags: ['Вампиры', 'Корея', 'Современность', 'Цветная', 'Реалистичная рисовка', 'Тайна'],
    desc: 'Каждое полнолуние в Сеуле пропадают люди. Студентка-медик спасает раненого незнакомца и оказывается втянута в войну древних вампирских кланов, где любовь опаснее любого проклятия.' },
  { title: 'Меха-пилот поневоле', type: 'manga', lang: 'ja', year: 2024, age: '12+', status: 'ongoing', authors: ['Танака Рё'], artists: ['Мори Аюми'],
    genres: ['Меха', 'Научная фантастика', 'Боевик', 'Школа', 'Сёнэн'], tags: ['Будущее', 'Становление героя', 'Чёрно-белая', 'Детальные фоны', 'Динамичные сражения'],
    desc: 'Школьник случайно активирует экспериментального боевого робота, который признаёт только его. Теперь он единственный пилот, способный остановить вторжение, хотя до вчерашнего дня боялся даже аттракционов.' },
  { title: 'Повар императорской кухни', type: 'manhua', lang: 'zh', year: 2020, age: '6+', status: 'ongoing', authors: ['Чжан Вэй'], artists: ['Ху Лань'],
    genres: ['Кулинария', 'Исторический', 'Комедия', 'Романтика'], tags: ['Королевский двор', 'Перерождение', 'Китай', 'Цветная', 'Красивая рисовка'],
    desc: 'Шеф-повар современного ресторана просыпается в теле младшего помощника на императорской кухне. Своими блюдами он покоряет придворных, но при дворе вкусная еда может быть опаснее яда.' },
];

function ensureUser(username, role = 'user') {
  let u = q('SELECT id FROM users WHERE username = ?').get(username);
  if (!u) {
    q('INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(username, `${username}@example.com`, hashPassword('demo12345'), role);
    u = q('SELECT id FROM users WHERE username = ?').get(username);
  }
  return u.id;
}

function sqlTime(daysAgo, hoursAgo = 0) {
  const d = new Date(Date.now() - daysAgo * 86400000 - hoursAgo * 3600000);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function run() {
  const ownerId = ensureUser('demo');
  let team = q('SELECT id FROM teams WHERE slug = ?').get('demo-scans');
  if (!team) {
    q(`INSERT INTO teams (name, slug, description, owner_id, status, reviewed_at) VALUES (?, ?, ?, ?, 'approved', datetime('now'))`)
      .run('Demo Scans', 'demo-scans', 'Демонстрационная команда. Переводим манхву, мангу и маньхуа с 2015 года.', ownerId);
    team = q('SELECT id FROM teams WHERE slug = ?').get('demo-scans');
    q(`INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'owner')`).run(team.id, ownerId);
  }
  const readers = Array.from({ length: 12 }, (_, i) => ensureUser(`reader${i + 1}`));

  const genreId = new Map(q('SELECT id, name FROM genres').all().map((g) => [g.name, g.id]));
  const tagId = new Map(q('SELECT id, name FROM tags').all().map((t) => [t.name, t.id]));
  fs.mkdirSync(path.join(UPLOAD_DIR, 'covers'), { recursive: true });

  let created = 0;
  DEMO.forEach((d, idx) => {
    if (q('SELECT 1 FROM works WHERE title = ?').get(d.title)) return;
    const palette = PALETTES[idx % PALETTES.length];
    const coverName = `demo-${idx + 1}.svg`;
    fs.writeFileSync(path.join(UPLOAD_DIR, 'covers', coverName), coverSvg(d.title, d.type, palette, idx + 3));

    transaction(() => {
      const workId = W.saveWork({
        title: d.title, alt_titles: '', description: d.desc, type: d.type, status: d.status, language: d.lang,
        age_rating: d.age, year: d.year, story_authors: d.authors, artists: d.artists,
        genres: d.genres.map((g) => genreId.get(g)).filter(Boolean),
        tags: d.tags.map((t) => tagId.get(t)).filter(Boolean),
      }, { teamId: team.id, uploaderId: ownerId, moderation: 'approved', cover: `/uploads/covers/${coverName}` });

      const publishedDaysAgo = 40 - idx * 2;
      q('UPDATE works SET published_at = ?, created_at = ? WHERE id = ?').run(sqlTime(publishedDaysAgo), sqlTime(publishedDaysAgo), workId);

      const chapterCount = 3 + ((idx * 7) % 10);
      for (let c = 1; c <= chapterCount; c++) {
        const daysAgo = Math.max(0, publishedDaysAgo - c * 3);
        const r = q('INSERT INTO chapters (work_id, volume, number, title, team_id, uploader_id, created_at, views) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(workId, Math.ceil(c / 5), c, c === 1 ? 'Начало' : '', team.id, ownerId, sqlTime(daysAgo, idx + c), 20 + ((idx * 31 + c * 17) % 400));
        const chId = Number(r.lastInsertRowid);
        const dir = path.join(UPLOAD_DIR, 'chapters', String(chId));
        fs.mkdirSync(dir, { recursive: true });
        const n = 4 + ((idx + c) % 3);
        for (let p = 1; p <= n; p++) {
          const name = `${String(p).padStart(4, '0')}.svg`;
          fs.writeFileSync(path.join(dir, name), pageSvg(d.title, c, p, n, palette));
          q('INSERT INTO pages (chapter_id, idx, path) VALUES (?, ?, ?)').run(chId, p, `/uploads/chapters/${chId}/${name}`);
        }
        q('UPDATE chapters SET pages_count = ? WHERE id = ?').run(n, chId);
      }
      W.refreshLastChapter(workId);

      // Просмотры и лайки.
      const views = 500 + ((idx * 977) % 9000);
      q('UPDATE works SET views = ? WHERE id = ?').run(views, workId);
      for (let day = 0; day < 7; day++) {
        const v = (idx * 13 + day * 7) % 60;
        if (v) q('INSERT OR REPLACE INTO daily_views (work_id, day, views, reads) VALUES (?, ?, ?, ?)').run(workId, today(-day), v, Math.round(v * 1.6));
      }
      readers.forEach((uid, i) => {
        if ((idx + i) % 3 === 0) q('INSERT OR IGNORE INTO likes (user_id, work_id, created_at) VALUES (?, ?, ?)').run(uid, workId, sqlTime((idx + i) % 5));
        if ((idx + i) % 4 === 0) q('INSERT OR IGNORE INTO favorites (user_id, work_id) VALUES (?, ?)').run(uid, workId);
      });
      q('UPDATE works SET likes_count = (SELECT COUNT(*) FROM likes WHERE work_id = ?), favs_count = (SELECT COUNT(*) FROM favorites WHERE work_id = ?) WHERE id = ?')
        .run(workId, workId, workId);
    });
    created++;
  });

  console.log(`Демо-данные: добавлено тайтлов — ${created}. Пользователь команды: demo / demo12345`);
}

run();
