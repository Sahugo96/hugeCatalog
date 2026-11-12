/**
 * Извлечение данных галереи 3hentai для импорта в HugeCatalog.
 *
 * Берёт ВСЕ данные из родительского блока галереи (#main-info): обложку, заголовок и каждое поле
 * `.tag-container` (категории, серия, персонажи, художники, группы, языки, теги и любые другие).
 * Ни одно значение не отбрасывается: все теги передаются с оригинальным названием (name_en),
 * а словарь ниже лишь подсказывает русское название для новых тегов.
 *
 * Функция самодостаточна: её код передаётся в страницу через chrome.scripting.executeScript.
 * Возвращает { item } — запись для «Админка → Импорт», или { error }.
 */
function extractGallery(pageUrl) {
  var url = pageUrl || location.href;
  var clean = function (s) { return String(s || '').replace(/\s+/g, ' ').trim(); };

  var h1 = document.querySelector('#main-info h1, h1');
  if (!h1 || !/\/d\/\d+/.test(url)) {
    return { error: 'Откройте страницу галереи вида https://ru.3hentai.net/d/123456 (не страницу чтения).' };
  }

  /* ---------- Родительский блок со всеми данными ---------- */

  var root = document.querySelector('#main-info');
  if (!root) {
    // Запасной путь: поднимаемся от заголовка, пока блок не охватит все поля .tag-container.
    var total = document.querySelectorAll('.tag-container').length;
    root = h1.parentElement;
    while (root && root.parentElement && root.querySelectorAll('.tag-container').length < total) root = root.parentElement;
  }

  /* ---------- Подсказки ---------- */

  var LANGS = {
    japanese: 'ja', english: 'en', russian: 'ru', chinese: 'zh', korean: 'ko', spanish: 'es',
    french: 'fr', german: 'de', ukrainian: 'uk', eng: 'en', en: 'en', rus: 'ru', ru: 'ru', jp: 'ja', jpn: 'ja',
    chi: 'zh', cn: 'zh', kor: 'ko', kr: 'ko', ukr: 'uk',
  };
  var TYPES = {
    doujinshi: 'doujinshi', manga: 'manga', 'artist cg': 'other', 'game cg': 'other', western: 'comic',
    'image set': 'other', 'non-h': 'other', cosplay: 'other', misc: 'other',
  };
  // Только подсказка русского названия для новых тегов; теги вне словаря тоже импортируются.
  var RU = {
    'milf': 'Милфы', 'big breasts': 'Большая грудь', 'huge breasts': 'Огромная грудь', 'prostitution': 'Проституция',
    'mouth mask': 'Медицинская маска', 'blackmail': 'Шантаж', 'cheating': 'Измена', 'netorare': 'Нетораре',
    'filming': 'Съёмка', 'old man': 'Старик', 'mosaic censorship': 'Цензура мозаикой', 'uncensored': 'Без цензуры',
    'ahegao': 'Ахегао', 'anal': 'Анал', 'bondage': 'Бондаж', 'gyaru': 'Гяру', 'group': 'Групповой секс',
    'double penetration': 'Двойное проникновение', 'incest': 'Инцест', 'swimsuit': 'Купальник',
    'masturbation': 'Мастурбация', 'blowjob': 'Минет', 'nun': 'Монахиня', 'nurse': 'Медсестра', 'glasses': 'Очки',
    'paizuri': 'Пайзури', 'pregnant': 'Беременность', 'tentacles': 'Тентакли', 'schoolgirl uniform': 'Студентка',
    'teacher': 'Учительница', 'femdom': 'Фемдом', 'futanari': 'Футанари', 'stockings': 'Чулки', 'full color': 'Цветная',
    'kissing': 'Поцелуи', 'wife': 'Жена', 'mother': 'Мать', 'office lady': 'Офис', 'hypnosis': 'Гипноз',
    'dark skin': 'Тёмная кожа', 'tanlines': 'Загар', 'monster': 'Монстры', 'elf': 'Эльфы', 'demon girl': 'Демоны',
    'vampire': 'Вампиры', 'harem': 'Гарем', 'yuri': 'Юри', 'yaoi': 'Яой', 'uniform': 'Униформа',
  };
  var capitalize = function (s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; };
  // «big breasts (female)» → «big breasts»: пометка пола не делает тег другим.
  var baseTag = function (s) { return clean(s).replace(/\s*\((?:female|male|mixed|other)\)\s*$/i, ''); };

  /* ---------- Все поля блока ---------- */

  var fields = {}; // подпись поля → все значения как есть
  var entries = []; // { label, name, kind }
  var kindOf = function (href, label) {
    var m = String(href || '').match(/\/(tags|tag|language|languages|category|categories|series|parodies|parody|characters|character|artists|artist|groups|group)\//);
    if (m) return { tag: 'tags', language: 'language', languages: 'language', category: 'category', categories: 'category',
      series: 'parody', parodies: 'parody', parody: 'parody', characters: 'character', character: 'character',
      artists: 'artist', artist: 'artist', groups: 'group', group: 'group' }[m[1]] || 'tags';
    if (/search\?q=/.test(href || '')) return 'search';
    var l = label.toLowerCase();
    if (/категор|categor/.test(l)) return 'category';
    if (/сери|пароди|parod/.test(l)) return 'parody';
    if (/персонаж|character/.test(l)) return 'character';
    if (/художник|автор|artist/.test(l)) return 'artist';
    if (/групп|кружок|group|circle/.test(l)) return 'group';
    if (/язык|language/.test(l)) return 'language';
    return 'tags';
  };

  (root || document).querySelectorAll('.tag-container').forEach(function (block) {
    var labelEl = block.querySelector('.font-weight-bold');
    var label = labelEl ? clean(labelEl.textContent).replace(/:$/, '') : '';
    var anchors = block.querySelectorAll('a');
    if (!anchors.length) {
      // Поле без ссылок, например «Количество страниц: 73».
      var whole = clean(block.textContent);
      var m = whole.match(/^([^:]+):\s*(.*)$/);
      if (m) fields[clean(m[1])] = [clean(m[2])];
      return;
    }
    fields[label] = [];
    anchors.forEach(function (a) {
      var nameEl = a.querySelector('.name');
      var name = clean((nameEl || a).textContent).replace(/\s*\d+(?:[.,]\d+)?[kKmM]?$/, '') || clean(a.textContent);
      fields[label].push(name);
      entries.push({ label: label, name: name, kind: kindOf(a.getAttribute('href'), label) });
    });
  });
  var of = function (kind) { return entries.filter(function (e) { return e.kind === kind; }).map(function (e) { return e.name; }); };

  /* ---------- Название: [Кружок (Автор)] Серия №N ~подзаголовок~ / Перевод [Язык][Команда] ---------- */

  var full = clean(h1.textContent);
  var s = full;
  var circle = '';
  var artist = '';
  var m = s.match(/^\(([^)]*)\)\s*/); // событие, напр. (C102)
  if (m) s = s.slice(m[0].length);
  m = s.match(/^\[([^\]]*)\]\s*/);
  if (m) {
    var inner = m[1].match(/^(.*?)\s*\((.*)\)\s*$/);
    if (inner) { circle = inner[1].trim(); artist = inner[2].trim(); } else artist = m[1].trim();
    s = s.slice(m[0].length);
  }
  var squareTail = [];
  var parodyFromTitle = '';
  while ((m = s.match(/\s*([\[(])([^\[\]()]*)[\])]\s*$/))) {
    if (m[1] === '[') squareTail.unshift(m[2].trim()); else if (!parodyFromTitle) parodyFromTitle = m[2].trim();
    s = s.slice(0, m.index);
  }
  var titleLang = '';
  var translator = '';
  squareTail.forEach(function (t) {
    var low = t.toLowerCase();
    if (LANGS[low]) titleLang = LANGS[low];
    else if (!translator && !/decensor|uncensor|digital|colou?ri[sz]ed|full color|translated|textless/i.test(t)) translator = t;
  });

  var parts = s.split(/\s+\/\s+/);
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
  function sentenceCase(t) {
    var words = t.split(' ');
    var allCaps = words.length > 1 && words.every(function (w) { return !/^[a-zа-яё]/.test(w); });
    if (!/[А-Яа-яЁё]/.test(t) || !allCaps) return t;
    return words.map(function (w, i) { return i === 0 ? w : w.toLowerCase(); }).join(' ');
  }
  var orig = splitNumber(parts[0].trim());
  var tr = parts[1] ? splitNumber(parts[1].trim()) : null;

  /* ---------- Язык, тип, авторы ---------- */

  var language = '';
  of('language').forEach(function (l) { var c = LANGS[l.toLowerCase()]; if (c && !language) language = c; });
  if (!language) language = titleLang || 'ja';
  var category = (of('category')[0] || 'doujinshi').toLowerCase();

  var artists = of('artist');
  if (!artists.length && artist) artists = [artist];
  var groups = of('group');
  if (!circle && groups.length) circle = groups[0];
  var authorNames = artists.concat(circle && artists.indexOf(circle) === -1 ? [circle] : []);
  var isAuthor = function (n) {
    var low = n.toLowerCase();
    return authorNames.concat(groups).some(function (a) { return a.toLowerCase() === low; });
  };

  /* ---------- Теги: все значения блока, кроме языков, категории и авторов ---------- */

  var tags = [];
  var seen = {};
  var addTag = function (raw, group) {
    var en = baseTag(raw);
    if (!en) return;
    var key = group + '|' + en.toLowerCase();
    if (seen[key]) return;
    seen[key] = true;
    tags.push({ name: RU[en.toLowerCase()] || capitalize(en), name_en: capitalize(en), group: group });
  };
  entries.forEach(function (e) {
    if (e.kind === 'tags') addTag(e.name, 'Прочее');
    else if (e.kind === 'search' && !isAuthor(e.name)) addTag(e.name, 'Прочее');
    else if (e.kind === 'character') addTag(e.name, 'Персонажи');
    else if (e.kind === 'parody' && e.name.toLowerCase() !== 'original') addTag(e.name, 'Пародия');
  });
  if (parodyFromTitle && parodyFromTitle.toLowerCase() !== 'original' && !of('parody').length) addTag(parodyFromTitle, 'Пародия');

  /* ---------- Обложка + сканы ---------- */

  var cover = '';
  var coverImg = (root || document).querySelector('.main-cover img, #cover img');
  if (coverImg) cover = coverImg.getAttribute('data-src') || coverImg.getAttribute('src') || '';
  if (!cover) {
    var thumb = document.querySelector('#thumbnail-gallery img, .single-thumb img');
    if (thumb) cover = (thumb.getAttribute('data-src') || thumb.getAttribute('src') || '').replace(/\/(\d+)t\.(\w+)(\?.*)?$/, '/$1.$2');
  }

  var scans = [''];
  var scansGallery = (root || document).querySelectorAll('#thumbnail-gallery img');
  if (!scansGallery && scansGallery.length) {
    scansGallery.forEach(element => {
       var url = (element.getAttribute('data-src') || element.getAttribute('src') || '').replace(/\/(\d+)t\.(\w+)(\?.*)?$/, '/$1.$2');
      
        if (url) scans.push(url);
    });
  }

  /* ---------- Запись для импорта ---------- */

  var seriesName = orig.name || parts[0].trim();
  var number = tr && tr.number !== null ? tr.number : orig.number;
  var title = (language === 'ru' || language === 'uk') && tr && tr.name ? sentenceCase(tr.name) : seriesName;
  var alt = [];
  [seriesName, tr && tr.name ? sentenceCase(tr.name) : ''].forEach(function (a) { if (a && a !== title && alt.indexOf(a) === -1) alt.push(a); });
  var pagesField = Object.keys(fields).filter(function (k) { return /страниц|pages/i.test(k); })[0];
  var timeEl = (root || document).querySelector('time[datetime]');

  return {
    item: {
      title: title,
      alt_titles: alt,
      series: seriesName,
      chapter: { number: number === null ? 1 : number, title: (tr && tr.sub) || orig.sub || '' },
      description: '',
      type: TYPES[category] || 'other',
      status: number !== null ? 'ongoing' : 'completed',
      language: language,
      age_rating: '18+',
      authors: authorNames,
      artists: artists,
      genres: ['Хентай'],
      tags: tags,
      cover_url: cover,
      scans_gallery: scans,
      translator: translator,
      circle: circle,
      pages: pagesField ? Number(fields[pagesField][0]) || null : null,
      uploaded_at: timeEl ? timeEl.getAttribute('datetime') : null,
      source_url: url.replace(/(\/d\/\d+).*$/, '$1'),
      source_title: full,
      source_fields: fields,
    },
  };
}

if (typeof module !== 'undefined') module.exports = { extractGallery: extractGallery };
