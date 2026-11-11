/* HugeCatalog — клиентские скрипты (без зависимостей). */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var csrf = ($('meta[name="csrf-token"]') || {}).content || '';
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  var escapeHtml = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  };
  var debounce = function (fn, ms) {
    var t;
    return function () { var a = arguments, self = this; clearTimeout(t); t = setTimeout(function () { fn.apply(self, a); }, ms); };
  };

  /* ---------- Тема ---------- */
  function currentTheme() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t) return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-theme-toggle]')) {
      var next = currentTheme() === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      store.set('theme', next);
    }
    if (e.target.closest('[data-theme-reset]')) {
      document.documentElement.removeAttribute('data-theme');
      store.del('theme');
    }
  });

  /* ---------- Подтверждение возраста (18+) ---------- */
  if (store.get('age-ok') === '1') document.documentElement.classList.add('age-ok');
  var gate = $('[data-age-gate]');
  if (gate && store.get('age-ok') !== '1') {
    gate.hidden = false;
    document.body.style.overflow = 'hidden';
    $('[data-age-confirm]', gate).addEventListener('click', function () {
      store.set('age-ok', '1');
      document.documentElement.classList.add('age-ok');
      gate.hidden = true;
      document.body.style.overflow = '';
    });
  } else if (gate) {
    document.documentElement.classList.add('age-ok');
  }

  /* ---------- Мобильное меню, поиск, выпадашки ---------- */
  document.addEventListener('click', function (e) {
    var navBtn = e.target.closest('[data-toggle="nav"]');
    if (navBtn) {
      var open = document.body.classList.toggle('nav-open');
      navBtn.setAttribute('aria-expanded', open);
      return;
    }
    if (e.target.closest('[data-close-nav]')) document.body.classList.remove('nav-open');
    if (e.target.closest('[data-toggle="search"]')) {
      document.body.classList.toggle('search-open');
      var inp = $('.header-search input');
      if (inp && document.body.classList.contains('search-open')) inp.focus();
      return;
    }

    var dd = e.target.closest('[data-dropdown]');
    $$('.dropdown.open').forEach(function (d) {
      if (!dd || d !== dd.parentElement) { d.classList.remove('open'); $('[data-dropdown]', d).setAttribute('aria-expanded', 'false'); }
    });
    if (dd) {
      var isOpen = dd.parentElement.classList.toggle('open');
      dd.setAttribute('aria-expanded', isOpen);
    }

    if (e.target.closest('.flash-close')) e.target.closest('.flash').remove();
    if (e.target.closest('[data-open-filters]')) document.body.classList.add('filters-open');
    if (e.target.closest('[data-close-filters]')) document.body.classList.remove('filters-open');
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      document.body.classList.remove('nav-open', 'filters-open', 'search-open');
      $$('.dropdown.open').forEach(function (d) { d.classList.remove('open'); });
    }
  });
  setTimeout(function () {
    $$('.flash-success, .flash-info').forEach(function (f) { f.style.transition = 'opacity .4s'; f.style.opacity = '0'; setTimeout(function () { f.remove(); }, 400); });
  }, 6000);

  /* ---------- Подтверждение опасных действий ---------- */
  // Причина «admin» в форме снятия с публикации — полное удаление произведения.
  document.addEventListener('submit', function (e) {
    var f = e.target.closest('[data-delete-command]');
    if (!f) return;
    var reason = f.querySelector('[name="reason"]');
    if (reason && reason.value.trim().toLowerCase() === f.getAttribute('data-delete-command') && !window.confirm(f.getAttribute('data-delete-confirm'))) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);
  document.addEventListener('submit', function (e) {
    var f = e.target.closest('[data-confirm]');
    if (f && !window.confirm(f.getAttribute('data-confirm'))) e.preventDefault();
  });
  $$('[data-autosubmit]').forEach(function (el) {
    el.addEventListener('change', function () { (el.form || document.getElementById(el.getAttribute('form'))).requestSubmit(); });
  });

  /* ---------- Выпадающий список в стиле меню (вместо нативного select) ---------- */
  var CHECK = '<svg class="icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  $$('select[data-fancy]').forEach(function (sel) {
    var wrap = document.createElement('div');
    wrap.className = 'dropdown fancy-select';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'input select fancy-select-btn';
    btn.setAttribute('data-dropdown', '');
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', sel.getAttribute('aria-label') || '');
    var menu = document.createElement('div');
    menu.className = 'dropdown-menu';
    menu.setAttribute('role', 'listbox');
    var render = function () {
      var current = sel.options[sel.selectedIndex];
      btn.textContent = current ? current.textContent : '';
      menu.innerHTML = '';
      Array.prototype.forEach.call(sel.options, function (o) {
        var item = document.createElement('button');
        item.type = 'button';
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', o.selected ? 'true' : 'false');
        item.className = o.selected ? 'selected' : '';
        item.dataset.value = o.value;
        item.innerHTML = '<span>' + escapeHtml(o.textContent) + '</span>' + (o.selected ? CHECK : '');
        menu.appendChild(item);
      });
    };
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(btn);
    wrap.appendChild(menu);
    wrap.appendChild(sel);
    sel.hidden = true;
    render();
    menu.addEventListener('click', function (e) {
      var item = e.target.closest('[data-value]');
      if (!item || item.dataset.value === sel.value) return;
      sel.value = item.dataset.value;
      render();
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    btn.addEventListener('click', function () {
      setTimeout(function () {
        var s = menu.querySelector('.selected') || menu.firstChild;
        if (wrap.classList.contains('open') && s) s.focus();
      });
    });
    menu.addEventListener('keydown', function (e) {
      var items = $$('[role="option"]', menu);
      var i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
      } else if (e.key === 'Escape' || e.key === 'Tab') {
        wrap.classList.toggle('open', false);
        btn.setAttribute('aria-expanded', 'false');
        if (e.key === 'Escape') btn.focus();
      }
    });
  });

  /* ---------- Админка: только жанры и теги без перевода ---------- */
  var onlyMissing = $('[data-only-missing]');
  if (onlyMissing) {
    onlyMissing.addEventListener('change', function () { document.body.classList.toggle('only-missing', onlyMissing.checked); });
  }

  /* ---------- Быстрый поиск в шапке ---------- */
  var qs = $('[data-quick-search]');
  if (qs) {
    var dropdown = qs.parentElement.querySelector('.search-dropdown');
    var active = -1;
    var render = function (items, q) {
      if (!q) { dropdown.hidden = true; return; }
      var html = items.length
        ? items.map(function (it) {
            return '<a class="search-item" href="/title/' + encodeURIComponent(it.slug) + '">' +
              (it.cover ? '<img src="' + escapeHtml(it.cover) + '" alt="">' : '') +
              '<span><strong>' + escapeHtml(it.title) + '</strong><small>' + escapeHtml((typeLabels[it.type] || it.type) + (it.year ? ' · ' + it.year : '')) + '</small></span></a>';
          }).join('')
        : '<div class="search-empty">' + T('Ничего не найдено') + '</div>';
      html += '<a class="search-all" href="/catalog?q=' + encodeURIComponent(q) + '">' + escapeHtml(T('Расширенный поиск по «{q}»', { q: q })) + '</a>';
      dropdown.innerHTML = html;
      dropdown.hidden = false;
      active = -1;
    };
    var typeLabels = { manga: T('Манга'), manhwa: T('Манхва'), manhua: T('Маньхуа'), webtoon: T('Вебтун'), comic: T('Комикс'), oel: T('OEL-манга'), russian: T('Руманга'), doujinshi: T('Додзинси'), other: T('Другое') };
    var search = debounce(function () {
      var q = qs.value.trim();
      if (q.length < 2) { dropdown.hidden = true; return; }
      fetch('/api/search?q=' + encodeURIComponent(q), { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (d) { if (qs.value.trim() === q) render(d.items || [], q); })
        .catch(function () {});
    }, 200);
    qs.addEventListener('input', search);
    qs.addEventListener('focus', function () { if (qs.value.trim().length >= 2) search(); });
    qs.addEventListener('keydown', function (e) {
      var items = $$('.search-item', dropdown);
      if (dropdown.hidden || !items.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items.forEach(function (it, i) { it.classList.toggle('active', i === active); });
      } else if (e.key === 'Enter' && active >= 0) {
        e.preventDefault();
        window.location = items[active].href;
      }
    });
    document.addEventListener('click', function (e) { if (!e.target.closest('.header-search')) dropdown.hidden = true; });
  }

  /* ---------- Лайк / избранное ---------- */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-toggle-action]');
    if (!btn || btn.disabled) return;
    if (document.body.getAttribute('data-auth') !== '1') {
      window.location = '/login';
      return;
    }
    var action = btn.getAttribute('data-toggle-action');
    btn.disabled = true;
    fetch('/api/works/' + btn.getAttribute('data-work') + '/' + action, {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf, Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || T('Ошибка')); return d; }); })
      .then(function (d) {
        $$('[data-toggle-action="' + action + '"][data-work="' + btn.getAttribute('data-work') + '"]').forEach(function (b) {
          b.classList.toggle('is-on', d.active);
          b.setAttribute('aria-pressed', d.active);
          var c = $('[data-count]', b); if (c) c.textContent = d.count;
          var l = $('[data-label]', b); if (l) l.textContent = d.active ? T('В избранном') : T('В избранное');
        });
        if (action === 'like') { var s = $('[data-likes-stat]'); if (s) s.textContent = d.count; }
      })
      .catch(function (err) { alert(err.message); })
      .finally(function () { btn.disabled = false; });
  });

  /* ---------- Трёхпозиционные фильтры каталога ---------- */
  function setTri(tri, state) {
    var key = tri.getAttribute('data-key');
    var input = $('input', tri);
    tri.setAttribute('data-state', state);
    $('.tri-btn', tri).setAttribute('aria-pressed', state ? 'true' : 'false');
    input.name = state === 2 ? key + '_ex' : key;
    input.disabled = state === 0;
  }
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.tri-btn');
    if (!btn) return;
    var tri = btn.parentElement;
    setTri(tri, (Number(tri.getAttribute('data-state')) + 1) % 3);
  });
  // Правый клик — сразу исключить.
  document.addEventListener('contextmenu', function (e) {
    var btn = e.target.closest('.tri-btn');
    if (!btn) return;
    e.preventDefault();
    var tri = btn.parentElement;
    setTri(tri, Number(tri.getAttribute('data-state')) === 2 ? 0 : 2);
  });

  var filtersForm = document.getElementById('filters');
  if (filtersForm) {
    // Чистые URL: не отправляем пустые и значения по умолчанию.
    filtersForm.addEventListener('submit', function () {
      var defaults = { genre_mode: 'all', tag_mode: 'all', sort: 'popular', dir: 'desc' };
      $$('input, select', filtersForm).concat($$('[form="filters"]')).forEach(function (el) {
        if (!el.name) return;
        if (el.value === '' || defaults[el.name] === el.value) el.disabled = true;
      });
      setTimeout(function () { $$('[form="filters"], #filters input, #filters select').forEach(function (el) { if (!el.closest('.tri') || el.closest('.tri').getAttribute('data-state') !== '0') el.disabled = false; }); }, 50);
    });
    var dirBtn = $('[data-toggle-dir]');
    if (dirBtn) {
      dirBtn.addEventListener('click', function () {
        var inp = $('input[name="dir"][form="filters"]');
        inp.value = inp.value === 'desc' ? 'asc' : 'desc';
        filtersForm.requestSubmit();
      });
    }
  }

  /* Поиск внутри длинных списков (жанры, теги) */
  $$('[data-filter-search]').forEach(function (inp) {
    var box = document.getElementById(inp.getAttribute('data-filter-search'));
    inp.addEventListener('input', function () {
      var q = inp.value.trim().toLowerCase();
      $$('.tri, .check-chip', box).forEach(function (el) {
        el.hidden = q && el.textContent.toLowerCase().indexOf(q) === -1;
      });
      $$('details', box).forEach(function (d) { if (q) d.open = true; });
      $$('.tag-block', box).forEach(function (b) { b.hidden = q && !$$('.check-chip:not([hidden])', b).length; });
    });
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') e.preventDefault(); });
  });

  /* Автодополнение автора в фильтрах */
  var authorInput = $('[data-author-search]');
  if (authorInput) {
    var list = authorInput.parentElement.querySelector('.autocomplete-list');
    var authorsBox = document.getElementById('authors-list');
    authorInput.addEventListener('input', debounce(function () {
      var q = authorInput.value.trim();
      if (!q) { list.hidden = true; return; }
      fetch('/api/authors?q=' + encodeURIComponent(q)).then(function (r) { return r.json(); }).then(function (d) {
        list.innerHTML = (d.items || []).map(function (a) {
          return '<button type="button" data-slug="' + escapeHtml(a.slug) + '">' + escapeHtml(a.name) + '</button>';
        }).join('') || '<div class="search-empty">' + T('Не найдено') + '</div>';
        list.hidden = false;
      });
    }, 200));
    authorInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') e.preventDefault(); });
    list.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-slug]');
      if (!b) return;
      var slug = b.getAttribute('data-slug');
      if (!$('.tri input[value="' + CSS.escape(slug) + '"]', authorsBox)) {
        var div = document.createElement('div');
        div.className = 'tri';
        div.setAttribute('data-state', '1');
        div.setAttribute('data-key', 'author');
        div.innerHTML = '<button type="button" class="tri-btn" aria-pressed="true"><span class="tri-box"></span><span class="tri-label">' + escapeHtml(b.textContent) + '</span></button>' +
          '<input type="hidden" name="author" value="' + escapeHtml(slug) + '">';
        authorsBox.appendChild(div);
      }
      authorInput.value = '';
      list.hidden = true;
    });
  }

  /* ---------- Горизонтальные полки ---------- */
  $$('[data-shelf]').forEach(function (shelf) {
    var track = $('.shelf-track', shelf);
    var prev = $('[data-shelf-prev]', shelf);
    var next = $('[data-shelf-next]', shelf);
    var update = function () {
      prev.disabled = track.scrollLeft <= 4;
      next.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 4;
    };
    prev.addEventListener('click', function () { track.scrollBy({ left: -track.clientWidth * 0.85, behavior: 'smooth' }); });
    next.addEventListener('click', function () { track.scrollBy({ left: track.clientWidth * 0.85, behavior: 'smooth' }); });
    track.addEventListener('scroll', debounce(update, 50), { passive: true });
    window.addEventListener('resize', debounce(update, 100));
    update();
  });

  /* ---------- Слайдер на главной ---------- */
  var slider = $('[data-slider]');
  if (slider) {
    var slides = $$('[data-slide]', slider);
    var dots = $$('[data-dot]', slider);
    var idx = 0, timer;
    var show = function (i) {
      idx = (i + slides.length) % slides.length;
      slides.forEach(function (s, j) { s.classList.toggle('active', j === idx); });
      dots.forEach(function (d, j) { d.classList.toggle('active', j === idx); });
    };
    var start = function () { clearInterval(timer); if (slides.length > 1) timer = setInterval(function () { show(idx + 1); }, 7000); };
    dots.forEach(function (d) { d.addEventListener('click', function () { show(Number(d.getAttribute('data-dot'))); start(); }); });
    slider.addEventListener('mouseenter', function () { clearInterval(timer); });
    slider.addEventListener('mouseleave', start);
    start();
  }

  /* ---------- Вкладки ---------- */
  $$('[data-tabs]').forEach(function (tabs) {
    var activate = function (name) {
      $$('[data-tab]', tabs).forEach(function (t) { var on = t.getAttribute('data-tab') === name; t.classList.toggle('active', on); t.setAttribute('aria-selected', on); });
      $$('[data-panel]', tabs).forEach(function (p) { var on = p.getAttribute('data-panel') === name; p.classList.toggle('active', on); p.hidden = !on; });
    };
    $$('[data-tab]', tabs).forEach(function (t) {
      t.addEventListener('click', function () { activate(t.getAttribute('data-tab')); history.replaceState(null, '', '#' + t.getAttribute('data-tab')); });
    });
    if (location.hash === '#similar') activate('similar');
  });
  $$('[data-subtabs]').forEach(function (sub) {
    var root = sub.parentElement;
    $$('[data-subtab]', sub).forEach(function (b) {
      b.addEventListener('click', function () {
        var name = b.getAttribute('data-subtab');
        $$('[data-subtab]', sub).forEach(function (x) { x.classList.toggle('active', x === b); });
        $$('[data-subpanel]', root).forEach(function (p) { p.hidden = p.getAttribute('data-subpanel') !== name; });
      });
    });
  });

  /* ---------- Сворачиваемое описание ---------- */
  $$('[data-collapsible]').forEach(function (box) {
    var text = $('.description-text', box);
    var btn = $('[data-expand]', box);
    if (text.scrollHeight > 170) {
      box.classList.add('collapsed');
      btn.hidden = false;
      btn.addEventListener('click', function () { box.classList.remove('collapsed'); btn.hidden = true; });
    }
  });

  /* ---------- Поиск главы ---------- */
  var chSearch = $('[data-chapter-search]');
  if (chSearch) {
    chSearch.addEventListener('input', function () {
      var q = chSearch.value.trim().toLowerCase();
      $$('[data-chapter-text]').forEach(function (li) {
        var t = li.getAttribute('data-chapter-text');
        li.hidden = q && !(t.split(' ')[0] === q || t.indexOf(q) !== -1);
      });
    });
  }

  /* ---------- Формы студии ---------- */
  $$('input[type="file"][data-image-preview]').forEach(function (inp) {
    inp.addEventListener('change', function () {
      var file = inp.files && inp.files[0];
      if (!file) return;
      var targetId = inp.getAttribute('data-image-preview');
      var img = targetId ? document.getElementById(targetId) : inp.parentElement.querySelector('[data-cover-preview]');
      if (!img) return;
      img.src = URL.createObjectURL(file);
      img.hidden = false;
      var hint = inp.parentElement.querySelector('.cover-drop-hint');
      if (hint) hint.hidden = true;
    });
  });

  $$('[data-checked-count]').forEach(function (label) {
    var box = document.getElementById(label.getAttribute('data-checked-count'));
    var update = function () { var n = $$('input:checked', box).length; label.textContent = n ? T('· выбрано: {n}', { n: n }) : ''; };
    box.addEventListener('change', update);
    update();
  });

  var authorsList = $('#authors-datalist');
  $$('[data-author-input]').forEach(function (inp) {
    inp.addEventListener('input', debounce(function () {
      var last = inp.value.split(',').pop().trim();
      if (!last) return;
      fetch('/api/authors?q=' + encodeURIComponent(last)).then(function (r) { return r.json(); }).then(function (d) {
        var prefix = inp.value.split(',').slice(0, -1).map(function (s) { return s.trim(); }).filter(Boolean).join(', ');
        authorsList.innerHTML = (d.items || []).map(function (a) {
          return '<option value="' + escapeHtml((prefix ? prefix + ', ' : '') + a.name) + '">';
        }).join('');
      });
    }, 200));
  });

  /* Связывание языковых версий в студии */
  var linkSearch = $('[data-link-search]');
  if (linkSearch) {
    var linkForm = linkSearch.closest('form');
    var results = linkForm.querySelector('.link-results');
    linkSearch.addEventListener('input', debounce(function () {
      var q = linkSearch.value.trim();
      if (q.length < 2) { results.hidden = true; return; }
      fetch('/studio/api/works?q=' + encodeURIComponent(q), { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          results.innerHTML = (d.items || []).map(function (w) {
            return '<button type="button" data-id="' + w.id + '" data-title="' + escapeHtml(w.title) + '">' +
              (w.cover ? '<img src="' + escapeHtml(w.cover) + '" alt="">' : '') +
              '<span><strong>' + escapeHtml(w.title) + '</strong><small>' + escapeHtml(w.language_label) + (w.year ? ' · ' + w.year : '') +
              (w.moderation !== 'approved' ? ' · ' + T('на модерации') : '') + '</small></span></button>';
          }).join('') || '<div class="search-empty">' + T('Ничего не найдено') + '</div>';
          results.hidden = false;
        });
    }, 200));
    linkSearch.addEventListener('keydown', function (e) { if (e.key === 'Enter') e.preventDefault(); });
    results.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-id]');
      if (!b) return;
      if (!window.confirm(T('Связать с «{title}» как языковые версии одного произведения?', { title: b.getAttribute('data-title') }))) return;
      linkForm.querySelector('[name="target_id"]').value = b.getAttribute('data-id');
      linkForm.submit();
    });
  }

  var pagesInput = $('[data-pages-input]');
  if (pagesInput) {
    var preview = $('[data-pages-preview]');
    var zone = $('[data-dropzone]');
    var collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
    var renderPages = function () {
      var files = Array.prototype.slice.call(pagesInput.files || []).sort(function (a, b) { return collator.compare(a.name, b.name); });
      preview.innerHTML = '';
      files.forEach(function (f, i) {
        var fig = document.createElement('figure');
        var img = document.createElement('img');
        img.src = URL.createObjectURL(f);
        img.loading = 'lazy';
        var cap = document.createElement('figcaption');
        cap.textContent = (i + 1) + ' · ' + f.name;
        fig.appendChild(img); fig.appendChild(cap);
        preview.appendChild(fig);
      });
    };
    pagesInput.addEventListener('change', renderPages);
    ['dragenter', 'dragover'].forEach(function (ev) { zone.addEventListener(ev, function () { zone.classList.add('drag'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { zone.addEventListener(ev, function () { zone.classList.remove('drag'); }); });

    // Загрузка с индикатором прогресса.
    var form = $('[data-upload-form]');
    form.addEventListener('submit', function (e) {
      if (!window.FormData || !window.XMLHttpRequest) return;
      e.preventDefault();
      var progress = $('[data-upload-progress]');
      var fill = $('.upload-progress-fill', progress);
      var label = $('span', progress);
      var data = new FormData(form);
      if (e.submitter && e.submitter.name) data.append(e.submitter.name, e.submitter.value);
      $$('button[type="submit"]', form).forEach(function (b) { b.disabled = true; });
      progress.hidden = false;
      var xhr = new XMLHttpRequest();
      xhr.open('POST', form.action);
      xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
      xhr.upload.onprogress = function (ev) {
        if (!ev.lengthComputable) return;
        var p = Math.round(ev.loaded / ev.total * 100);
        fill.style.width = p + '%';
        label.textContent = p < 100 ? T('Загрузка…') + ' ' + p + '%' : T('Обработка…');
      };
      xhr.onload = function () {
        var type = xhr.getResponseHeader('Content-Type') || '';
        if (type.indexOf('application/json') !== -1) {
          var d = {};
          try { d = JSON.parse(xhr.responseText); } catch (err) { /* ignore */ }
          if (d.redirect) { window.location = d.redirect; return; }
          label.textContent = d.error || T('Ошибка загрузки');
          fill.style.width = '0';
          $$('button[type="submit"]', form).forEach(function (b) { b.disabled = false; });
          return;
        }
        document.open(); document.write(xhr.responseText); document.close();
      };
      xhr.onerror = function () {
        label.textContent = T('Ошибка сети. Попробуйте ещё раз.');
        $$('button[type="submit"]', form).forEach(function (b) { b.disabled = false; });
      };
      xhr.send(data);
    });
  }
})();
