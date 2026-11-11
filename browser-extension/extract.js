/**
 * Извлечение данных галереи 3hentai для импорта в HugeCatalog.
 * Функция самодостаточна: её код целиком передаётся в страницу через chrome.scripting.executeScript,
 * поэтому все вспомогательные функции и словари объявлены внутри неё.
 *
 * Возвращает { item } — запись для «Админка → Импорт», или { error }.
 */
function extractGallery(pageUrl) {
  var url = pageUrl || location.href;
  var text = function (el) { return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; };

  var h1 = document.querySelector('h1');
  if (!h1 || !/\/d\/\d+/.test(url)) {
    return { error: 'Откройте страницу галереи вида https://ru.3hentai.net/d/123456 (не страницу чтения).' };
  }

  /* ---------- Словари ---------- */

  var LANGS = {
    japanese: 'ja', english: 'en', russian: 'ru', chinese: 'zh', korean: 'ko', spanish: 'es',
    french: 'fr', german: 'de', ukrainian: 'uk', italian: 'other', portuguese: 'other', thai: 'other', vietnamese: 'other',
    eng: 'en', en: 'en', rus: 'ru', ru: 'ru', jp: 'ja', jpn: 'ja', chi: 'zh', cn: 'zh', kor: 'ko', kr: 'ko', ukr: 'uk',
  };
  var TYPES = {
    doujinshi: 'doujinshi', manga: 'manga', 'artist cg': 'other', 'game cg': 'other', western: 'comic',
    'image set': 'other', 'non-h': 'other', cosplay: 'other', misc: 'other', 'asian porn': 'other',
  };
  // Теги сайта (на английском, без пометок (female)/(male)) → теги каталога.
  var TAGS = {
    'milf': 'Милфы', 'big breasts': 'Большая грудь', 'huge breasts': 'Огромная грудь', 'prostitution': 'Проституция',
    'mouth mask': 'Медицинская маска', 'blackmail': 'Шантаж', 'cheating': 'Измена', 'netorare': 'Нетораре',
    'filming': 'Съёмка', 'old man': 'Старик', 'mosaic censorship': 'Цензура мозаикой', 'uncensored': 'Без цензуры',
    'ahegao': 'Ахегао', 'anal': 'Анал', 'bondage': 'Бондаж', 'gyaru': 'Гяру', 'group': 'Групповой секс',
    'double penetration': 'Двойное проникновение', 'rape': 'Изнасилование', 'incest': 'Инцест', 'swimsuit': 'Купальник',
    'masturbation': 'Мастурбация', 'blowjob': 'Минет', 'nun': 'Монахиня', 'nurse': 'Медсестра', 'glasses': 'Очки',
    'paizuri': 'Пайзури', 'pregnant': 'Беременность', 'impregnation': 'Беременность', 'tentacles': 'Тентакли',
    'schoolgirl uniform': 'Студентка', 'teacher': 'Учительница', 'femdom': 'Фемдом', 'futanari': 'Футанари',
    'stockings': 'Чулки', 'full color': 'Цветная', 'kissing': 'Поцелуи', 'wife': 'Жена', 'mother': 'Мать',
    'office lady': 'Офис', 'hypnosis': 'Гипноз', 'dark skin': 'Тёмная кожа', 'tanlines': 'Загар', 'monster': 'Монстры',
    'elf': 'Эльфы', 'demon girl': 'Демоны', 'vampire': 'Вампиры', 'magical girl': 'Махо-сёдзё', 'harem': 'Гарем',
    'yuri': 'Юри', 'yaoi': 'Яой', 'dilf': 'Старик', 'mind control': 'Гипноз', 'uniform': 'Униформа',
  };
  // Служебные теги, которые в каталог не переносим.
  var SKIP_TAGS = ['multi-work series', 'story arc', 'sole female', 'sole male', 'rough translation', 'translated',
    'rewrite', 'digital', 'incomplete', 'variant set', 'tankoubon', 'anthology', 'artbook', 'full censorship', 'english', 'russian', 'japanese'];

  /* ---------- Блоки метаданных ---------- */

  var fields = {};
  var links = [];
  document.querySelectorAll('.tag-container').forEach(function (block) {
    var labelEl = block.querySelector('.font-weight-bold');
    var label = labelEl ? text(labelEl).replace(/:$/, '').toLowerCase() : '';
    var names = [];
    block.querySelectorAll('a').forEach(function (a) {
      var name = text(a.querySelector('.name') || a);
      var href = a.getAttribute('href') || '';
      names.push(name);
      links.push({ name: name, href: href, label: label });
    });
    if (label) fields[label] = names;
    var pagesMatch = text(block).match(/(?:Количество страниц|Pages)\s*:?\s*(\d+)/i);
    if (pagesMatch) fields.pages = Number(pagesMatch[1]);
  });
  var byPath = function (part) {
    return links.filter(function (l) { return l.href.indexOf('/' + part + '/') !== -1; }).map(function (l) { return l.name; });
  };

  /* ---------- Разбор названия ---------- */

  var full = text(h1);
  var s = full;
  var circle = '';
  var artist = '';
  var m = s.match(/^\(([^)]*)\)\s*/); // событие, напр. (C102)
  if (m) s = s.slice(m[0].length);
  m = s.match(/^\[([^\]]*)\]\s*/); // [Кружок (Автор)] или [Автор]
  if (m) {
    var inner = m[1].match(/^(.*?)\s*\((.*)\)\s*$/);
    if (inner) { circle = inner[1].trim(); artist = inner[2].trim(); } else artist = m[1].trim();
    s = s.slice(m[0].length);
  }
  // Хвостовые [..] и (..): язык, команда перевода, пометки, пародия.
  var squareTail = [];
  var parody = '';
  while ((m = s.match(/\s*([\[(])([^\[\]()]*)[\])]\s*$/))) {
    if (m[1] === '[') squareTail.unshift(m[2].trim()); else if (!parody) parody = m[2].trim();
    s = s.slice(0, m.index);
  }
  var titleLang = '';
  var translator = '';
  squareTail.forEach(function (t) {
    var low = t.toLowerCase();
    if (LANGS[low]) titleLang = LANGS[low];
    else if (!translator && !/decensor|uncensor|digital|colou?ri[sz]ed|full color|english|russian|japanese|chinese|korean|translated|textless/i.test(t)) translator = t;
  });

  var parts = s.split(/\s+\/\s+/);
  var original = parts[0].trim();
  var translated = (parts[1] || '').trim();

  function splitNumber(t) {
    var sub = '';
    var mm = t.match(/\s*~([^~]+)~\s*$/);
    if (mm) { sub = mm[1].trim(); t = t.slice(0, mm.index); }
    mm = t.match(/^(.*?)[\s:,\-–]*(?:№|#|vol\.?|volume|part|ch\.?|chapter|глава|том|часть)\s*(\d+(?:\.\d+)?)\s*(.*)$/i);
    if (mm) return { name: mm[1].trim(), number: Number(mm[2]), sub: sub || mm[3].replace(/^[\s:~\-–]+|[\s~]+$/g, '') };
    mm = t.match(/^(.*\D)\s+(\d{1,3}(?:\.\d+)?)$/);
    if (mm) return { name: mm[1].trim(), number: Number(mm[2]), sub: sub };
    return { name: t.trim(), number: null, sub: sub };
  }
  // «Одинокая Мать Ищет Папика» → «Одинокая мать ищет папика» (если каждое слово с заглавной).
  function sentenceCase(t) {
    var words = t.split(' ');
    var cyr = /[А-Яа-яЁё]/.test(t);
    var allCaps = words.length > 1 && words.every(function (w) { return !/^[a-zа-яё]/.test(w); });
    if (!cyr || !allCaps) return t;
    return words.map(function (w, i) { return i === 0 ? w : w.toLowerCase(); }).join(' ');
  }

  var orig = splitNumber(original);
  var tr = translated ? splitNumber(translated) : null;

  /* ---------- Язык, тип, теги ---------- */

  var language = '';
  byPath('language').forEach(function (l) { var code = LANGS[l.toLowerCase()]; if (code && !language) language = code; });
  if (!language) language = titleLang || 'ja';

  var category = (byPath('category')[0] || 'doujinshi').toLowerCase();
  var type = TYPES[category] || 'other';

  var tags = [];
  var other = [];
  byPath('tags').forEach(function (raw) {
    var key = raw.toLowerCase().replace(/\s*\((?:female|male|mixed|other)\)\s*$/, '').trim();
    if (SKIP_TAGS.indexOf(key) !== -1) return;
    var mapped = TAGS[key];
    if (mapped) { if (tags.indexOf(mapped) === -1) tags.push(mapped); } else if (other.indexOf(key) === -1) other.push(key);
  });

  var artists = byPath('artists');
  if (!artists.length && artist) artists = [artist];
  var groups = byPath('groups');
  if (!circle && groups.length) circle = groups[0];
  var parodies = byPath('series').concat(byPath('parodies')).filter(function (p) { return p.toLowerCase() !== 'original'; });
  if (!parodies.length && parody && parody.toLowerCase() !== 'original') parodies = [parody];
  var characters = byPath('characters');

  /* ---------- Обложка ---------- */

  var cover = '';
  var thumb = document.querySelector('#thumbnail-gallery img, .single-thumb img');
  if (thumb) {
    var src = thumb.getAttribute('data-src') || thumb.getAttribute('src') || '';
    cover = src.replace(/\/(\d+)t\.(\w+)(\?.*)?$/, '/$1.$2');
  }

  /* ---------- Запись для импорта ---------- */

  var seriesName = orig.name || original;
  var number = (tr && tr.number !== null ? tr.number : orig.number);
  var chapterTitle = (tr && tr.sub) || orig.sub || '';
  var title = language === 'ru' || language === 'uk' ? sentenceCase((tr && tr.name) || seriesName) : seriesName;
  var alt = [];
  [seriesName, tr && tr.name ? sentenceCase(tr.name) : ''].forEach(function (a) { if (a && a !== title && alt.indexOf(a) === -1) alt.push(a); });

  var timeEl = document.querySelector('time[datetime]');
  var item = {
    title: title,
    alt_titles: alt,
    series: seriesName,
    chapter: { number: number === null ? 1 : number, title: chapterTitle },
    description: '',
    type: type,
    status: number !== null || other.indexOf('multi-work series') !== -1 ? 'ongoing' : 'completed',
    language: language,
    age_rating: '18+',
    authors: artists.length ? artists : (circle ? [circle] : []),
    artists: artists,
    genres: ['Хентай'],
    tags: tags,
    cover_url: cover,
    translator: translator,
    circle: circle,
    parodies: parodies,
    characters: characters,
    tags_unmapped: other,
    pages: fields.pages || null,
    uploaded_at: timeEl ? timeEl.getAttribute('datetime') : null,
    source_url: url.replace(/(\/d\/\d+).*$/, '$1'),
    source_title: full,
  };
  return { item: item };
}

if (typeof module !== 'undefined') module.exports = { extractGallery: extractGallery };
