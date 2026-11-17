/* global extractGallery, extractHentai2read, HC_TAGS_RU, chrome */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var LANG_NAMES = { ja: 'японский', en: 'английский', ru: 'русский', zh: 'китайский', ko: 'корейский', uk: 'украинский', es: 'испанский', fr: 'французский', de: 'немецкий', other: 'другой' };
  var current = []; // записи импорта с открытой страницы (у hentai2read — по одной на главу)
  var text = '';

  // Поддерживаемые сайты: проверка адреса страницы и функция разбора.
  var SITES = [
    {
      test: /^https?:\/\/([a-z]+\.)?3hentai\.net\/d\/\d+/,
      hint: '3hentai: страница галереи …/d/123456',
      run: function (tabId) { return chrome.scripting.executeScript({ target: { tabId: tabId }, func: extractGallery }); },
    },
    {
      test: /^https?:\/\/(www\.)?hentai2read\.com\/[^?#]+/,
      hint: 'hentai2read: страница произведения',
      run: function (tabId) {
        return chrome.scripting.executeScript({ target: { tabId: tabId }, func: extractHentai2read, args: [HC_TAGS_RU] });
      },
    },
  ];

  // Одна и та же запись при повторном нажатии заменяется, а не дублируется.
  function keyOf(it) {
    return it.source_url + '|' + (it.format === 'chapters' && it.chapter ? it.chapter.number : '');
  }

  function setStatus(msg, kind) {
    var el = $('status');
    el.textContent = msg;
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  function storage() {
    return new Promise(function (resolve) {
      chrome.storage.local.get({ collect: false, collected: [] }, resolve);
    });
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // Запасной путь для браузеров, где Clipboard API недоступен во всплывающем окне.
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  }

  async function render() {
    var st = await storage();
    $('collect').checked = st.collect;
    $('collect-row').hidden = !st.collect;
    var payload;
    if (st.collect) {
      var keys = current.map(keyOf);
      var list = st.collected.filter(function (x) { return keys.indexOf(keyOf(x)) === -1; }).concat(current);
      await chrome.storage.local.set({ collected: list });
      $('collect-count').textContent = 'В списке: ' + list.length;
      payload = list;
    } else {
      payload = current.length === 1 ? current[0] : current;
    }
    text = JSON.stringify(payload, null, 2);
    $('json').textContent = text;
    $('json').hidden = false;
    $('copy').disabled = false;
    var ok = await copy();
    setStatus(ok ? (st.collect ? 'Список скопирован в буфер обмена' : 'Скопировано в буфер обмена') : 'Не удалось скопировать — нажмите кнопку ниже', ok ? 'ok' : 'err');
  }

  function chapterRow(items) {
    var it = items[0];
    if (it.format === 'single') return ['Формат', 'Сингл (без глав)'];
    var withCh = items.filter(function (x) { return x.chapter; });
    if (!withCh.length) return ['Главы', 'не найдены — импорт создаст произведение без глав'];
    if (withCh.length === 1) return ['Глава', it.chapter.number + (it.chapter.title ? ' — ' + it.chapter.title : '')];
    return ['Главы (' + withCh.length + ')', withCh.map(function (x) { return x.chapter.number; }).join(', ')];
  }

  function showSummary(items) {
    var it = items[0];
    var rows = [
      ['Название', it.title],
      ['Серия', it.series],
      chapterRow(items),
      ['Язык', LANG_NAMES[it.language] || it.language],
      ['Авторы', it.authors.join(', ') || '—'],
      ['Перевод', it.translator || '—'],
      ['Страниц', it.pages || '—'],
      ['Теги (' + it.tags.length + ')', it.tags.map(function (t) { return t.name_en || t.name; }).join(', ') || '—'],
    ];
    // Все поля исходной страницы как есть — чтобы было видно, что ничего не потерялось.
    Object.keys(it.source_fields || {}).forEach(function (k) {
      rows.push(['· ' + k, it.source_fields[k].join(', ')]);
    });
    $('summary').innerHTML = rows.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('');
    $('summary').hidden = false;
    var warns = [];
    if (!it.cover_url) warns.push('Обложка не найдена — загрузите её вручную после импорта.');
    $('warn').textContent = warns.join(' ');
    $('warn').hidden = !warns.length;
  }

  async function run() {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    var tab = tabs[0];
    var site = tab && SITES.filter(function (s) { return s.test.test(tab.url || ''); })[0];
    if (!site) {
      setStatus('Откройте поддерживаемую страницу и нажмите на значок ещё раз: '
        + SITES.map(function (s) { return s.hint; }).join('; ') + '.', 'err');
      return;
    }
    try {
      var res = await site.run(tab.id);
      var out = res && res[0] && res[0].result;
      if (!out || out.error) {
        setStatus(out ? out.error : 'Не удалось прочитать страницу.', 'err');
        return;
      }
      current = out.items || [out.item];
      showSummary(current);
      await render();
    } catch (e) {
      setStatus('Ошибка: ' + e.message, 'err');
    }
  }

  $('copy').addEventListener('click', async function () {
    var ok = await copy();
    setStatus(ok ? 'Скопировано в буфер обмена' : 'Не удалось скопировать', ok ? 'ok' : 'err');
  });
  $('collect').addEventListener('change', async function (e) {
    await chrome.storage.local.set({ collect: e.target.checked });
    if (current.length) render();
  });
  $('clear').addEventListener('click', async function () {
    await chrome.storage.local.set({ collected: [] });
    if (current.length) render();
  });

  run();
})();
