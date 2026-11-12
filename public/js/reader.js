/* Читалка: лента или постраничный режим, горячие клавиши, прогресс. */
(function () {
  'use strict';

  var reader = document.querySelector('[data-reader]');
  if (!reader) return;

  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var store = {
    get: function (k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  };

  var pages = $$('.page-frame', reader);
  var total = pages.length;
  var prevUrl = reader.getAttribute('data-prev');
  var nextUrl = reader.getAttribute('data-next');
  var progress = reader.querySelector('[data-progress]');
  var progressLabel = reader.querySelector('[data-progress-label]');
  var pagedUi = reader.querySelector('[data-paged-ui]');
  var current = 0;

  // По умолчанию на телефонах — лента, на десктопе тоже лента (как в большинстве читалок).
  var settings = {
    mode: store.get('reader-mode', 'scroll'),
    width: store.get('reader-width', 'normal'),
    gap: store.get('reader-gap', '0'),
  };

  function applySettings() {
    reader.setAttribute('data-mode', settings.mode);
    reader.setAttribute('data-width', settings.width);
    reader.setAttribute('data-gap', settings.gap);
    $$('[data-setting]').forEach(function (group) {
      var key = group.getAttribute('data-setting');
      $$('button', group).forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-value') === settings[key]); });
    });
    pagedUi.hidden = settings.mode !== 'paged';
    if (settings.mode === 'paged') showPage(current, false);
    else pages.forEach(function (p) { p.classList.remove('current'); });
    updateProgress();
  }

  $$('[data-setting]').forEach(function (group) {
    group.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      var key = group.getAttribute('data-setting');
      settings[key] = b.getAttribute('data-value');
      store.set('reader-' + key, settings[key]);
      if (key === 'mode' && settings.mode === 'scroll' && pages[current]) {
        applySettings();
        pages[current].scrollIntoView();
        return;
      }
      applySettings();
    });
  });

  var settingsPanel = document.querySelector('[data-settings-panel]');
  document.querySelector('[data-reader-settings]').addEventListener('click', function (e) {
    e.stopPropagation();
    settingsPanel.hidden = !settingsPanel.hidden;
  });
  document.addEventListener('click', function (e) {
    if (!settingsPanel.hidden && !e.target.closest('[data-settings-panel]')) settingsPanel.hidden = true;
  });

  var chapterSelect = document.querySelector('[data-chapter-select]'); // у сингла списка глав нет
  if (chapterSelect) {
    chapterSelect.addEventListener('change', function (e) { window.location = e.target.value; });
  }

  // Помечаем загруженные картинки (убираем плейсхолдер).
  $$('img', reader).forEach(function (img) {
    if (img.complete) img.setAttribute('data-loaded', '');
    else img.addEventListener('load', function () { img.setAttribute('data-loaded', ''); });
  });

  /* ----- Постраничный режим ----- */

  function showPage(i, scroll) {
    if (!total) return;
    current = Math.max(0, Math.min(total - 1, i));
    pages.forEach(function (p, j) { p.classList.toggle('current', j === current); });
    // Подгружаем соседние страницы заранее.
    [current + 1, current + 2].forEach(function (j) {
      if (pages[j]) { var img = pages[j].querySelector('img'); img.loading = 'eager'; }
    });
    reader.classList.toggle('at-end', current === total - 1);
    if (scroll !== false) window.scrollTo(0, 0);
    updateProgress();
  }

  function nextPage() {
    if (current < total - 1) showPage(current + 1);
    else if (reader.classList.contains('at-end') && nextUrl) window.location = nextUrl;
  }

  function prevPage() {
    if (current > 0) showPage(current - 1);
    else if (prevUrl) window.location = prevUrl;
  }

  reader.querySelector('[data-paged-next]').addEventListener('click', nextPage);
  reader.querySelector('[data-paged-prev]').addEventListener('click', prevPage);

  /* ----- Прогресс ----- */

  function updateProgress() {
    if (!total) { progressLabel.textContent = '0 / 0'; return; }
    var pct;
    if (settings.mode === 'paged') {
      pct = (current + 1) / total;
    } else {
      // Текущая страница — последняя, верх которой выше середины экрана.
      var mid = window.innerHeight / 2;
      current = 0;
      for (var i = 0; i < total; i++) {
        if (pages[i].getBoundingClientRect().top < mid) current = i; else break;
      }
      var docH = document.documentElement.scrollHeight - window.innerHeight;
      pct = docH > 0 ? Math.min(1, window.scrollY / docH) : 1;
    }
    progress.style.width = (pct * 100).toFixed(1) + '%';
    progressLabel.textContent = (current + 1) + ' / ' + total;
  }

  /* ----- Автоскрытие панелей при прокрутке вниз ----- */

  var lastY = window.scrollY;
  var ticking = false;
  window.addEventListener('scroll', function () {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      var y = window.scrollY;
      if (settings.mode === 'scroll') {
        if (y > lastY + 8 && y > 120) reader.classList.add('bars-hidden');
        else if (y < lastY - 8) reader.classList.remove('bars-hidden');
        updateProgress();
      }
      lastY = y;
      ticking = false;
    });
  }, { passive: true });

  // Тап по странице в режиме ленты показывает/скрывает панели.
  reader.querySelector('[data-pages]').addEventListener('click', function () {
    if (settings.mode === 'scroll') reader.classList.toggle('bars-hidden');
  });

  /* ----- Клавиатура ----- */

  document.addEventListener('keydown', function (e) {
    if (e.target.closest('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    var k = e.key.toLowerCase();
    if (settings.mode === 'paged') {
      if (k === 'arrowright' || k === ' ' || k === 'pagedown') { e.preventDefault(); nextPage(); return; }
      if (k === 'arrowleft' || k === 'pageup') { e.preventDefault(); prevPage(); return; }
    } else {
      if (k === 'arrowright' && pages[current + 1]) { e.preventDefault(); pages[current + 1].scrollIntoView({ behavior: 'smooth' }); return; }
      if (k === 'arrowleft' && pages[current - 1]) { e.preventDefault(); pages[current - 1].scrollIntoView({ behavior: 'smooth' }); return; }
    }
    if ((k === 'd' || k === 'в') && nextUrl) window.location = nextUrl;
    if ((k === 'a' || k === 'ф') && prevUrl) window.location = prevUrl;
    if (k === 'f' || k === 'а') {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(function () {});
      else document.exitFullscreen && document.exitFullscreen();
    }
    if (k === 'escape') settingsPanel.hidden = true;
  });

  // Свайпы в постраничном режиме.
  var touchX = null;
  reader.addEventListener('touchstart', function (e) { touchX = e.touches[0].clientX; }, { passive: true });
  reader.addEventListener('touchend', function (e) {
    if (touchX === null || settings.mode !== 'paged') return;
    var dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 60) (dx < 0 ? nextPage : prevPage)();
    touchX = null;
  }, { passive: true });

  applySettings();
})();
