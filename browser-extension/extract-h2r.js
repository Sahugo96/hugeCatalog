/**
 * Извлечение данных произведения hentai2read для импорта в HugeCatalog.
 *
 * Как и для 3hentai, данные берутся из РОДИТЕЛЬСКОГО блока: от заголовка поднимаемся до контейнера
 * с полями вида «<b>Подпись</b> значения» (Parody, Status, Release Year, Artist, Author, Category,
 * Content, Character, Language, Storyline…). Каждое поле сохраняется в source_fields как есть,
 * поэтому новые или переименованные поля сайта не теряются.
 *
 * Тег/категория «Oneshot» означает сингл: format = 'single', без глав.
 * Иначе каждая глава из списка на странице становится отдельной записью импорта (series + chapter),
 * и импорт соберёт их в одно произведение с главами-каркасами.
 *
 * Сканы (страницы глав) не собираются — только метаданные, обложка и список глав.
 *
 * Функция самодостаточна: её код передаётся в страницу через chrome.scripting.executeScript.
 * dict — словарь подсказок русских названий тегов (HC_TAGS_RU).
 * Возвращает { items: [...] } или { error }.
 */
function extractHentai2read(dict) {
  var RU = dict || {};
  var clean = function (s) { return String(s || '').replace(/\s+/g, ' ').trim(); };
  var capitalize = function (s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; };

  /* ---------- Страница произведения, а не читалка ---------- */

  var segs = location.pathname.split('/').filter(Boolean);
  if (!segs.length) return { error: 'Откройте страницу произведения hentai2read (не главную и не список).' };
  if (/^\d+(?:\.\d+)?$/.test(segs[segs.length - 1])) {
    return { error: 'Это страница чтения главы. Откройте страницу самого произведения (без номера главы в адресе).' };
  }
  var basePath = '/' + segs.join('/') + '/';
  var sourceUrl = location.origin + basePath;

  /* ---------- Поля «подпись → значения» ---------- */

  var ITEM_SEL = 'li, p, div, tr, dt';
  // Подпись — первый элемент <b>/<strong>/<th>/<dt>/<label>, перед которым нет текста.
  function labelOf(el) {
    if (el.tagName === 'DT') return clean(el.textContent).replace(/:$/, '');
    var first = el.firstElementChild;
    if (!first || !/^(B|STRONG|TH|LABEL|SPAN|H4|H5)$/.test(first.tagName)) return '';
    if (first.tagName === 'SPAN' && !/label|title|key|name/i.test(first.className)) return '';
    var before = '';
    for (var n = el.firstChild; n && n !== first; n = n.nextSibling) before += n.textContent;
    if (clean(before)) return '';
    if (first.querySelector('a')) return '';
    var t = clean(first.textContent).replace(/:$/, '');
    return t && t.length <= 30 ? t : '';
  }
  function isField(el) {
    if (!labelOf(el)) return false;
    // Внешние обёртки, внутри которых лежат другие поля, полем не считаются.
    var inner = el.querySelectorAll(ITEM_SEL);
    for (var i = 0; i < inner.length; i++) if (labelOf(inner[i])) return false;
    return true;
  }
  function fieldsIn(node) {
    return Array.prototype.filter.call(node.querySelectorAll(ITEM_SEL), isField);
  }

  // Заголовок произведения: тот из h1/h2/h3/.block-title, чей текст есть в og:title / <title> страницы
  // (блоков с классом .block-title на странице несколько: «Related», «Comments»…).
  var ownText = function (el) {
    var c = el.cloneNode(true);
    Array.prototype.forEach.call(c.querySelectorAll('small, .text-muted'), function (s) { s.remove(); });
    return clean(c.textContent);
  };
  var ogTitle = document.querySelector('meta[property="og:title"]');
  var pageTitle = clean((ogTitle && ogTitle.getAttribute('content')) || document.title).toLowerCase();
  var candidates = Array.prototype.slice.call(document.querySelectorAll('h1, h2, h3, .block-title'));
  var heading = candidates.filter(function (h) {
    var t = ownText(h).toLowerCase();
    return t.length >= 3 && pageTitle.indexOf(t) !== -1;
  }).sort(function (a, b) { return ownText(b).length - ownText(a).length; })[0]
    || candidates.filter(function (h) { return h.querySelector('a[href$="' + basePath + '"]'); })[0]
    || document.querySelector('h1');
  if (!heading) return { error: 'Не найден заголовок произведения на странице.' };

  // Родительский блок: поднимаемся от заголовка, пока в блоке не окажется хотя бы 3 поля.
  var root = heading.parentElement;
  while (root && root !== document.body && fieldsIn(root).length < 3) root = root.parentElement;
  if (!root) root = document.body;
  var fieldEls = fieldsIn(root);
  if (fieldEls.length < 2) return { error: 'Не найден блок с информацией о произведении. Откройте страницу произведения hentai2read.' };

  var fields = {}; // подпись → все значения как есть
  var texts = {}; // подпись → текст без подписи (для описания, года, страниц)
  fieldEls.forEach(function (el) {
    var label = labelOf(el);
    var valueNodes = [];
    if (el.tagName === 'DT') {
      var dd = el.nextElementSibling;
      if (dd && dd.tagName === 'DD') valueNodes = [dd];
    } else {
      for (var n = el.firstElementChild.nextSibling; n; n = n.nextSibling) valueNodes.push(n);
    }
    var anchors = [];
    var text = '';
    valueNodes.forEach(function (n) {
      text += ' ' + (n.textContent || '');
      if (n.nodeType !== 1) return;
      if (n.tagName === 'A') anchors.push(n);
      Array.prototype.forEach.call(n.querySelectorAll('a'), function (a) { anchors.push(a); });
    });
    var values = anchors.map(function (a) {
      var nameEl = a.querySelector('.name');
      // «Big Breasts (123)» / «Big Breasts 1.2k» → «Big Breasts»
      return clean((nameEl || a).textContent).replace(/\s*\(\s*[\d.,]+\s*[kKmM]?\s*\)$/, '').replace(/\s+\d+(?:[.,]\d+)?[kKmM]?$/, '');
    }).filter(Boolean);
    text = clean(text).replace(/^[:\-–]\s*/, '');
    if (!values.length && text) values = [text];
    if (!values.length) return;
    fields[label] = (fields[label] || []).concat(values);
    texts[label] = clean((texts[label] || '') + ' ' + text);
  });

  var find = function (re) { return Object.keys(fields).filter(function (k) { return re.test(k); }); };
  var valuesOf = function (re) {
    var out = [];
    find(re).forEach(function (k) { fields[k].forEach(function (v) { if (out.indexOf(v) === -1) out.push(v); }); });
    return out;
  };
  var textOf = function (re) { var k = find(re)[0]; return k ? texts[k] : ''; };

  /* ---------- Название ---------- */

  var titleNode = heading.cloneNode(true);
  var alt = [];
  Array.prototype.forEach.call(titleNode.querySelectorAll('small, .text-muted, .alt-title'), function (s) {
    clean(s.textContent).split(/\s*[;|]\s*/).forEach(function (a) { if (a) alt.push(a); });
    s.remove();
  });
  var title = clean(titleNode.textContent);
  valuesOf(/^(alternative|alt\.?|other names?|also known|japanese|synonyms?)/i).forEach(function (a) {
    a.split(/\s*[;|]\s*/).forEach(function (x) { if (x && x !== title && alt.indexOf(x) === -1) alt.push(x); });
  });
  alt = alt.filter(function (a) { return a.toLowerCase() !== title.toLowerCase(); });

  /* ---------- Формат: Oneshot = сингл ---------- */

  var ONESHOT = /^one[\s-]?shot$/i;
  var allValues = [];
  Object.keys(fields).forEach(function (k) { allValues = allValues.concat(fields[k]); });
  var single = allValues.some(function (v) { return ONESHOT.test(clean(v)); });

  /* ---------- Язык, тип, статус, год ---------- */

  var LANGS = {
    japanese: 'ja', english: 'en', russian: 'ru', chinese: 'zh', korean: 'ko', spanish: 'es', french: 'fr',
    german: 'de', ukrainian: 'uk',
  };
  var language = '';
  valuesOf(/^languages?$/i).forEach(function (l) { var c = LANGS[l.toLowerCase()]; if (c && !language) language = c; });
  if (!language) language = 'en'; // hentai2read — англоязычный сайт

  var categories = valuesOf(/^(categor|type)/i).map(function (c) { return c.toLowerCase(); });
  var type = 'manga';
  if (categories.indexOf('doujinshi') !== -1) type = 'doujinshi';
  else if (categories.indexOf('manhwa') !== -1) type = 'manhwa';
  else if (categories.indexOf('manhua') !== -1) type = 'manhua';
  else if (categories.indexOf('webtoon') !== -1) type = 'webtoon';
  else if (categories.indexOf('western') !== -1 || categories.indexOf('comic') !== -1) type = 'comic';

  var statusRaw = (valuesOf(/^status$/i)[0] || '').toLowerCase();
  var status = /complet|finish|end/.test(statusRaw) ? 'completed'
    : /hiatus|pause/.test(statusRaw) ? 'hiatus'
    : /cancel|drop/.test(statusRaw) ? 'cancelled'
    : /ongoing|publish|updat/.test(statusRaw) ? 'ongoing'
    : (single ? 'completed' : 'ongoing');

  var yearMatch = textOf(/year|released?/i).match(/\b(19|20)\d{2}\b/);
  var pagesMatch = textOf(/^pages?$/i).match(/\d[\d,]*/);

  var description = textOf(/storyline|synopsis|summary|description|plot/i);
  if (/^(nothing yet|n\/a|none|-|no description)/i.test(description)) description = '';

  /* ---------- Авторы ---------- */

  var artists = valuesOf(/^artists?$/i);
  var writers = valuesOf(/^(authors?|writers?|circles?|groups?)$/i);
  var authors = writers.length ? writers : artists.slice();

  /* ---------- Теги: все значения, кроме служебных полей ---------- */

  var SKIP_FIELD = /^(languages?|status|ranking|rank|views?|pages?|release|year|released|uploaded|uploader|date|artists?|authors?|writers?|circles?|groups?|storyline|synopsis|summary|description|plot|alternative|alt\.?|other names?|also known|japanese|synonyms?|rating|score|favou?rites?|chapters?)/i;
  var TYPE_VALUES = /^(doujinshi|manga|manhwa|manhua|webtoon|western|comic)$/i;
  var tags = [];
  var seen = {};
  function addTag(raw, group) {
    var en = clean(raw).replace(/\s*\((?:female|male|mixed|other)\)\s*$/i, '');
    if (!en || ONESHOT.test(en)) return; // Oneshot — это формат, а не тег
    var key = group + '|' + en.toLowerCase();
    if (seen[key]) return;
    seen[key] = true;
    tags.push({ name: RU[en.toLowerCase()] || capitalize(en), name_en: capitalize(en), group: group });
  }
  Object.keys(fields).forEach(function (label) {
    if (SKIP_FIELD.test(label)) return;
    var l = label.toLowerCase();
    fields[label].forEach(function (v) {
      if (/^parod|^series/.test(l)) { if (v.toLowerCase() !== 'original') addTag(v, 'Пародия'); }
      else if (/^character/.test(l)) addTag(v, 'Персонажи');
      else if (/^(categor|type)/.test(l)) { if (!TYPE_VALUES.test(v)) addTag(v, 'Прочее'); }
      else addTag(v, 'Прочее');
    });
  });

  /* ---------- Обложка ---------- */

  // Обложка часто лежит в соседней колонке — ищем от блока с полями вверх на несколько уровней.
  var cover = '';
  var COVER_SEL = '.img-container img, .cover img, img[src*="cover"], img[data-src*="cover"]';
  var coverImg = null;
  for (var up = root, lvl = 0; up && !coverImg && lvl < 4; up = up.parentElement, lvl++) coverImg = up.querySelector(COVER_SEL);
  if (!coverImg) coverImg = root.querySelector('img');
  if (coverImg) {
    cover = coverImg.getAttribute('data-src') || coverImg.getAttribute('src') || '';
    try { cover = new URL(cover, location.href).href; } catch (e) { /* оставляем как есть */ }
  }
  if (!cover) {
    var og = document.querySelector('meta[property="og:image"]');
    if (og) cover = og.getAttribute('content') || '';
  }

  /* ---------- Главы: ссылки вида <страница произведения>/<номер>/ ---------- */

  var escaped = (location.origin + basePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var chapterRe = new RegExp('^' + escaped + '(\\d+(?:\\.\\d+)?)/?(?:[?#].*)?$');
  var chapters = {};
  Array.prototype.forEach.call(document.querySelectorAll('a[href]'), function (a) {
    var m = a.href.match(chapterRe);
    if (!m) return;
    var number = Number(m[1]);
    var copy = a.cloneNode(true);
    Array.prototype.forEach.call(copy.querySelectorAll('small, time, .text-muted, .badge, i, svg'), function (x) { x.remove(); });
    var name = clean(copy.textContent)
      .replace(/^(?:ch(?:apter)?\.?\s*)?\d+(?:\.\d+)?\s*(?:[-:–.]\s*)?/i, '');
    // Кнопки «Read Online», «First/Last chapter» и т.п. — не названия глав.
    if (/^(read( online| now)?|start reading|read first|read last|first( chapter)?|last( chapter)?|next( chapter)?|prev(ious)?( chapter)?|continue( reading)?|читать)$/i.test(name)
      || name.toLowerCase() === title.toLowerCase()) name = '';
    if (!chapters[number] || (!chapters[number].title && name)) chapters[number] = { number: number, title: name.slice(0, 200) };
  });
  var chapterList = Object.keys(chapters).map(function (k) { return chapters[k]; })
    .sort(function (a, b) { return a.number - b.number; });

  /* ---------- Записи для импорта ---------- */

  var base = {
    title: title,
    alt_titles: alt,
    series: title,
    format: single ? 'single' : 'chapters',
    description: description,
    type: type,
    status: status,
    language: language,
    age_rating: '18+',
    year: yearMatch ? Number(yearMatch[0]) : null,
    authors: authors,
    artists: artists,
    genres: ['Хентай'],
    tags: tags,
    cover_url: cover,
    pages: pagesMatch ? Number(pagesMatch[0].replace(/,/g, '')) || null : null,
    source_url: sourceUrl,
    source_title: title,
    source_fields: fields,
  };
  var copyBase = function (extra) {
    var o = {};
    Object.keys(base).forEach(function (k) { o[k] = base[k]; });
    Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
    return o;
  };

  var items;
  if (single || !chapterList.length) {
    // Для сингла глава — лишь подсказка: если серия на сайте уже ведётся по главам, импорт добавит её главой.
    items = [copyBase(single ? { chapter: { number: 1, title: '' } } : {})];
  } else {
    items = chapterList.map(function (ch) { return copyBase({ chapter: ch }); });
  }
  return { items: items };
}

if (typeof module !== 'undefined') module.exports = { extractHentai2read: extractHentai2read };
