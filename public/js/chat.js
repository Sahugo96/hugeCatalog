/* HugeCatalog — чат (общий и личные сообщения) и уведомления в реальном времени. */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var csrf = ($('meta[name="csrf-token"]') || {}).content || '';
  var body = document.body;
  var me = body.getAttribute('data-me-id') ? {
    id: Number(body.getAttribute('data-me-id')),
    name: body.getAttribute('data-me-name'),
    staff: body.getAttribute('data-me-staff') === '1',
  } : null;
  var ss = {
    get: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  };
  var esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  };
  var ICON = {
    back: '<svg class="icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
    send: '<svg class="icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>',
    flag: '<svg class="icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 22V4a1 1 0 0 1 1-1h12l-2 4 2 4H5"/></svg>',
    trash: '<svg class="icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
    ban: '<svg class="icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/></svg>',
  };

  function api(method, url, data) {
    var opts = { method: method, headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' } };
    if (method !== 'GET') {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['X-CSRF-Token'] = csrf;
      opts.body = JSON.stringify(data || {});
    }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || T('Ошибка') + ' ' + r.status);
        return d;
      });
    });
  }

  function fmtTime(isoStr) {
    var d = new Date(isoStr);
    var now = new Date();
    var loc = window.LANG === 'en' ? 'en-GB' : 'ru-RU';
    var hm = d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return hm;
    return d.toLocaleDateString(loc, { day: '2-digit', month: '2-digit' }) + ' ' + hm;
  }

  /* ======================= Счётчики и уведомления ======================= */

  function setBadge(el, n) {
    if (!el) return;
    el.textContent = n > 99 ? '99+' : n;
    el.hidden = !n;
  }

  function applyCounters(c) {
    setBadge($('[data-notif-badge]'), c.notifications);
    setBadge($('[data-chat-badge]'), c.messages);
    setBadge($('[data-dm-badge]'), c.messages);
    var base = document.title.replace(/^\(\d+\+?\) /, '');
    var total = (c.notifications || 0) + (c.messages || 0);
    document.title = total ? '(' + (total > 99 ? '99+' : total) + ') ' + base : base;
  }

  function toast(title, text, link) {
    var stack = $('.flash-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.className = 'flash-stack';
      body.appendChild(stack);
    }
    var el = document.createElement(link ? 'a' : 'div');
    el.className = 'flash flash-info toast';
    if (link) el.href = link;
    el.innerHTML = '<span><strong>' + esc(title) + '</strong>' + (text ? '<br><span class="muted">' + esc(text) + '</span>' : '') + '</span>';
    stack.appendChild(el);
    setTimeout(function () { el.style.transition = 'opacity .4s'; el.style.opacity = '0'; setTimeout(function () { el.remove(); }, 400); }, 6000);
  }

  var notifList = $('[data-notif-list]');
  function loadNotifications() {
    api('GET', '/api/notifications').then(function (d) {
      applyCounters(d.counters);
      notifList.innerHTML = d.items.length ? d.items.map(function (n) {
        return '<a class="notif-item ' + (n.is_read ? '' : 'unread') + '" href="/notifications/' + n.id + '/go">' +
          '<strong>' + esc(n.title) + '</strong>' + (n.body ? '<span class="muted">' + esc(n.body) + '</span>' : '') +
          '<time class="muted">' + fmtTime(n.created_at) + '</time></a>';
      }).join('') : '<div class="search-empty">' + T('Уведомлений нет') + '</div>';
    }).catch(function () { notifList.innerHTML = '<div class="search-empty">' + T('Не удалось загрузить') + '</div>'; });
  }
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-notif-toggle]')) loadNotifications();
    if (e.target.closest('[data-notif-readall]')) {
      e.preventDefault();
      api('POST', '/api/notifications/read').then(function (c) { applyCounters(c); loadNotifications(); });
    }
  });

  /* ======================= Поток событий ======================= */

  var source = null;
  /*
   * Одно соединение на весь браузер. Браузер разрешает не больше 6 одновременных соединений с сайтом
   * (HTTP/1.1), а поток событий держит своё постоянно. Если каждая вкладка откроет поток, на 6-й вкладке
   * сайт «зависнет»: скрипты и переходы ждут в очереди. Поэтому поток открывает только одна «ведущая»
   * вкладка (Web Locks), а события раздаёт остальным через BroadcastChannel. Закрылась ведущая — её место
   * автоматически занимает следующая вкладка.
   */
  var EVENTS = ['counters', 'notification', 'global', 'dm', 'deleted'];
  var channel = null;

  function dispatch(event, data) {
    if (event === 'counters') applyCounters(data);
    else if (event === 'notification') { if (document.visibilityState === 'visible') toast(data.title, data.body, data.link); }
    else if (event === 'global') onGlobal(data);
    else if (event === 'dm') onDirect(data);
    else if (event === 'deleted') onDeleted(data);
  }

  function openSource(onEvent) {
    var es = new EventSource('/api/stream');
    EVENTS.forEach(function (name) {
      es.addEventListener(name, function (e) { onEvent(name, JSON.parse(e.data)); });
    });
    window.addEventListener('pagehide', function () { es.close(); });
    return es;
  }

  function connect() {
    if (source || !window.EventSource) return;
    source = true;
    if (window.BroadcastChannel && navigator.locks && navigator.locks.request) {
      channel = new BroadcastChannel('hc-events');
      channel.onmessage = function (e) { dispatch(e.data.event, e.data.data); };
      navigator.locks.request('hc-event-stream', function () {
        // Блокировка удерживается, пока жива вкладка: промис никогда не завершается.
        return new Promise(function () {
          source = openSource(function (name, data) {
            dispatch(name, data);
            channel.postMessage({ event: name, data: data });
          });
        });
      });
    } else {
      source = openSource(dispatch);
    }
  }
  if (me) connect();

  /* ======================= Виджет чата ======================= */

  var widget = $('[data-chat]');
  if (!widget) return;
  var panel = $('[data-chat-panel]', widget);
  var view = $('[data-chat-body]', widget);
  var fab = $('[data-chat-toggle]', widget);
  var state = { open: false, tab: 'global', conv: null, other: null, blocked: false, oldestId: null, loading: false, globalLoaded: false };

  function openPanel(tab) {
    connect();
    state.open = true;
    panel.hidden = false;
    widget.classList.add('open');
    fab.setAttribute('aria-expanded', 'true');
    ss.set('chat-open', '1');
    if (tab) switchTab(tab);
    else if (!view.children.length) switchTab(ss.get('chat-tab') || 'global');
  }
  function closePanel() {
    state.open = false;
    panel.hidden = true;
    widget.classList.remove('open');
    fab.setAttribute('aria-expanded', 'false');
    ss.set('chat-open', '0');
  }
  fab.addEventListener('click', function () { state.open ? closePanel() : openPanel(); });
  $('[data-chat-close]', widget).addEventListener('click', closePanel);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.open && e.target.closest('[data-chat]')) closePanel(); });

  $$('[data-chat-tab]', widget).forEach(function (b) {
    b.addEventListener('click', function () { switchTab(b.getAttribute('data-chat-tab')); });
  });
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-chat-open]');
    if (b) { e.preventDefault(); openPanel(b.getAttribute('data-chat-open')); }
    var dm = e.target.closest('[data-open-dm]');
    if (dm) { e.preventDefault(); openPanel('dm'); startConversation(dm.getAttribute('data-open-dm')); }
  });

  function switchTab(tab) {
    state.tab = tab;
    ss.set('chat-tab', tab);
    $$('[data-chat-tab]', widget).forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-chat-tab') === tab); });
    $('[data-chat-tab="' + tab + '"]', widget).classList.remove('has-new');
    state.conv = null;
    if (tab === 'global') renderGlobal();
    else if (!me) renderLoginPrompt();
    else {
      var lastConv = Number(ss.get('chat-conv'));
      if (lastConv && view.getAttribute('data-from-restore') !== 'done') { view.setAttribute('data-from-restore', 'done'); openConversation(lastConv); }
      else renderConversationList();
    }
  }

  function renderLoginPrompt() {
    view.innerHTML = '<div class="chat-empty"><p>' + T('Личные сообщения доступны после входа.') + '</p><a class="btn btn-primary btn-sm" href="/login">' + T('Войти') + '</a> <a class="btn btn-ghost btn-sm" href="/register">' + T('Регистрация') + '</a></div>';
  }

  /* ----- Сообщения ----- */

  function messageHtml(m) {
    var mine = me && m.sender.id === me.id;
    var role = m.sender.role === 'admin' ? '<span class="role-tag">' + T('админ') + '</span>' : m.sender.role === 'moderator' ? '<span class="role-tag">' + T('модер') + '</span>' : '';
    var actions = '';
    if (me && !m.deleted) {
      if (mine || (me.staff && !m.conversation_id)) actions += '<button class="msg-act" data-msg-delete="' + m.id + '" title="' + T('Удалить') + '">' + ICON.trash + '</button>';
      if (!mine) actions += '<button class="msg-act" data-msg-report="' + m.id + '" title="' + T('Пожаловаться') + '">' + ICON.flag + '</button>';
    }
    return '<div class="msg ' + (mine ? 'mine' : '') + (m.deleted ? ' deleted' : '') + '" data-msg-id="' + m.id + '">' +
      (state.conv || mine ? '' : '<a class="msg-author" href="/user/' + encodeURIComponent(m.sender.username) + '">' + esc(m.sender.username) + role + '</a>') +
      '<div class="msg-bubble">' + (m.deleted ? '<em>' + T('Сообщение удалено') + '</em>' : esc(m.body)) + '</div>' +
      '<div class="msg-meta"><time>' + fmtTime(m.created_at) + '</time>' + actions + '</div></div>';
  }

  function listEl() { return $('[data-msg-list]', view); }

  function nearBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 80; }

  function appendMessages(list, msgs, scroll) {
    var stick = scroll || nearBottom(list);
    msgs.forEach(function (m) {
      if (list.querySelector('[data-msg-id="' + m.id + '"]')) return;
      list.insertAdjacentHTML('beforeend', messageHtml(m));
    });
    var empty = list.querySelector('.chat-empty');
    if (empty && msgs.length) empty.remove();
    if (stick) list.scrollTop = list.scrollHeight;
  }

  function prependMessages(list, msgs) {
    var h = list.scrollHeight;
    var html = msgs.map(messageHtml).join('');
    var anchor = list.querySelector('.msg');
    if (anchor) anchor.insertAdjacentHTML('beforebegin', html); else list.insertAdjacentHTML('beforeend', html);
    list.scrollTop = list.scrollHeight - h;
  }

  function composerHtml(placeholder, notice) {
    if (!me) return '<div class="chat-login"><a href="/login">' + T('Войдите, чтобы писать в чат') + '</a></div>';
    return (notice ? '<div class="chat-notice">' + notice + '</div>' : '') +
      '<form class="chat-composer" data-composer>' +
      '<textarea rows="1" maxlength="1000" placeholder="' + placeholder + '" aria-label="' + T('Сообщение') + '"></textarea>' +
      '<button class="icon-btn send-btn" type="submit" aria-label="' + T('Отправить') + '">' + ICON.send + '</button></form>';
  }

  function bindComposer(sendFn) {
    var form = $('[data-composer]', view);
    if (!form) return;
    var ta = $('textarea', form);
    var grow = function () { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; };
    ta.addEventListener('input', grow);
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = ta.value.trim();
      if (!text) return;
      var btn = $('button', form);
      btn.disabled = true;
      sendFn(text).then(function (d) {
        ta.value = '';
        grow();
        appendMessages(listEl(), [d.message], true);
      }).catch(function (err) { showError(err.message); })
        .finally(function () { btn.disabled = false; ta.focus(); });
    });
    if (window.matchMedia('(pointer: fine)').matches) ta.focus();
  }

  function showError(text) {
    var bar = $('.chat-error', view);
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'chat-error';
      var form = $('[data-composer]', view);
      if (form) form.parentNode.insertBefore(bar, form); else view.appendChild(bar);
    }
    bar.textContent = text;
    clearTimeout(bar._t);
    bar._t = setTimeout(function () { bar.remove(); }, 5000);
  }

  function bindScrollLoad(loader) {
    var list = listEl();
    list.addEventListener('scroll', function () {
      if (list.scrollTop < 40 && !state.loading && state.oldestId) loader();
    });
  }

  /* ----- Общий чат ----- */

  function renderGlobal() {
    view.innerHTML = '<div class="chat-messages" data-msg-list><div class="chat-empty">' + T('Загрузка…') + '</div></div>' +
      composerHtml(T('Сообщение в общий чат…'), null);
    bindComposer(function (text) { return api('POST', '/api/chat/global', { body: text }); });
    state.loading = true;
    api('GET', '/api/chat/global').then(function (d) {
      var list = listEl();
      list.innerHTML = d.messages.length ? '' : '<div class="chat-empty">' + T('Здесь пока тихо. Напишите первым!') + '</div>';
      appendMessages(list, d.messages, true);
      state.oldestId = d.messages.length >= 50 ? d.messages[0].id : null;
      var online = $('[data-online]', widget);
      online.textContent = '● ' + d.online; online.hidden = !d.online; online.title = T('Сейчас на сайте: {n}', { n: d.online });
      state.globalLoaded = true;
    }).finally(function () { state.loading = false; });
    bindScrollLoad(function () {
      state.loading = true;
      api('GET', '/api/chat/global?before=' + state.oldestId).then(function (d) {
        prependMessages(listEl(), d.messages);
        state.oldestId = d.messages.length >= 50 ? d.messages[0].id : null;
      }).finally(function () { state.loading = false; });
    });
  }

  function onGlobal(m) {
    if (state.open && state.tab === 'global' && listEl()) appendMessages(listEl(), [m], me && m.sender.id === me.id);
    else if (!(me && m.sender.id === me.id)) $('[data-chat-tab="global"]', widget).classList.add('has-new');
  }

  /* ----- Личные сообщения ----- */

  function renderConversationList() {
    ss.set('chat-conv', '');
    view.innerHTML = '<form class="chat-new" data-new-dm><input class="input input-sm" placeholder="' + T('Имя пользователя') + '" aria-label="' + T('Кому написать') + '" autocomplete="off">' +
      '<button class="btn btn-primary btn-sm">' + T('Написать') + '</button></form><div class="conv-list" data-conv-list><div class="chat-empty">' + T('Загрузка…') + '</div></div>';
    $('[data-new-dm]', view).addEventListener('submit', function (e) {
      e.preventDefault();
      var name = $('input', e.target).value.trim();
      if (name) startConversation(name);
    });
    refreshConversationList();
  }

  function refreshConversationList() {
    var box = $('[data-conv-list]', view);
    if (!box) return;
    api('GET', '/api/chat/conversations').then(function (d) {
      box.innerHTML = d.conversations.length ? d.conversations.map(function (c) {
        return '<button class="conv-item' + (c.unread ? ' unread' : '') + '" data-conv="' + c.id + '">' +
          '<span class="avatar">' + esc(c.other.username.slice(0, 1).toUpperCase()) + (c.other.online ? '<i class="online-dot"></i>' : '') + '</span>' +
          '<span class="conv-text"><strong>' + esc(c.other.username) + (c.blocked ? ' <span class="muted">(' + T('заблокирован') + ')</span>' : '') + '</strong>' +
          '<span class="muted">' + (c.last_mine ? T('Вы:') + ' ' : '') + esc(c.last_body || '…') + '</span></span>' +
          '<span class="conv-side"><time class="muted">' + (c.last_message_at ? fmtTime(c.last_message_at) : '') + '</time>' +
          (c.unread ? '<span class="count-badge">' + c.unread + '</span>' : '') + '</span></button>';
      }).join('') : '<div class="chat-empty">' + T('Переписок пока нет. Напишите кому-нибудь — например, автору перевода со страницы его профиля.') + '</div>';
    }).catch(function (err) { box.innerHTML = '<div class="chat-empty">' + esc(err.message) + '</div>'; });
  }

  view.addEventListener('click', function (e) {
    var c = e.target.closest('[data-conv]');
    if (c) openConversation(Number(c.getAttribute('data-conv')));
    if (e.target.closest('[data-conv-back]')) renderConversationList();
    if (e.target.closest('[data-block]')) {
      var blocking = !state.blocked;
      if (!window.confirm(blocking ? T('Заблокировать {name}? Вы перестанете получать от него сообщения.', { name: state.other.username }) : T('Разблокировать {name}?', { name: state.other.username }))) return;
      api('POST', '/api/chat/block', { username: state.other.username }).then(function (d) {
        state.blocked = d.blocked;
        openConversation(state.conv);
      }).catch(function (err) { showError(err.message); });
    }
    var del = e.target.closest('[data-msg-delete]');
    if (del && window.confirm(T('Удалить сообщение?'))) {
      api('POST', '/api/chat/messages/' + del.getAttribute('data-msg-delete') + '/delete').catch(function (err) { showError(err.message); });
    }
    var rep = e.target.closest('[data-msg-report]');
    if (rep) {
      var reason = window.prompt(T('Почему это сообщение нарушает правила? (спам, оскорбления, незаконный контент…)'));
      if (reason === null) return;
      api('POST', '/api/chat/messages/' + rep.getAttribute('data-msg-report') + '/report', { reason: reason })
        .then(function () { showError(T('Жалоба отправлена модераторам. Спасибо!')); })
        .catch(function (err) { showError(err.message); });
    }
  });

  function startConversation(username) {
    if (!me) { renderLoginPrompt(); return; }
    api('POST', '/api/chat/conversations', { username: username })
      .then(function (d) { openConversation(d.id); })
      .catch(function (err) { showError(err.message); });
  }

  function openConversation(id) {
    state.conv = id;
    state.loading = true;
    ss.set('chat-conv', id);
    view.innerHTML = '<div class="chat-messages" data-msg-list><div class="chat-empty">' + T('Загрузка…') + '</div></div>';
    api('GET', '/api/chat/conversations/' + id + '/messages').then(function (d) {
      state.other = d.other;
      state.blocked = d.blocked;
      var head = '<div class="conv-head"><button class="icon-btn small" data-conv-back aria-label="' + T('К списку переписок') + '">' + ICON.back + '</button>' +
        '<a href="/user/' + encodeURIComponent(d.other.username) + '" class="conv-name">' + esc(d.other.username) +
        (d.other.online ? ' <i class="online-dot static" title="' + T('В сети') + '"></i>' : '') + '</a>' +
        '<button class="icon-btn small" data-block title="' + (d.blocked ? T('Разблокировать') : T('Заблокировать')) + '">' + ICON.ban + '</button></div>';
      var notice = T('Личные сообщения видны только вам и собеседнику. Администрация может проверить переписку при жалобе или подозрении на нарушение закона.');
      view.innerHTML = head + '<div class="chat-messages" data-msg-list></div>' +
        (d.blocked ? '<div class="chat-login">' + T('Вы заблокировали этого пользователя.') + ' <button class="link-btn" data-block>' + T('Разблокировать') + '</button></div>'
          : composerHtml(esc(T('Сообщение для {name}…', { name: d.other.username })), esc(notice)));
      var list = listEl();
      if (!d.messages.length) list.innerHTML = '<div class="chat-empty">' + T('Начните переписку — напишите первое сообщение.') + '</div>';
      appendMessages(list, d.messages, true);
      state.oldestId = d.messages.length >= 50 ? d.messages[0].id : null;
      bindComposer(function (text) { return api('POST', '/api/chat/conversations/' + id + '/messages', { body: text }); });
      bindScrollLoad(function () {
        state.loading = true;
        api('GET', '/api/chat/conversations/' + id + '/messages?before=' + state.oldestId).then(function (r) {
          prependMessages(listEl(), r.messages);
          state.oldestId = r.messages.length >= 50 ? r.messages[0].id : null;
        }).finally(function () { state.loading = false; });
      });
      markRead();
    }).catch(function (err) {
      ss.set('chat-conv', '');
      view.innerHTML = '<div class="chat-empty">' + esc(err.message) + '</div>';
    }).finally(function () { state.loading = false; });
  }

  function markRead() {
    var last = $$('.msg', view).pop();
    if (!state.conv || !last) return;
    api('POST', '/api/chat/conversations/' + state.conv + '/read', { last_id: Number(last.getAttribute('data-msg-id')) }).catch(function () {});
  }

  function onDirect(m) {
    var mine = me && m.sender.id === me.id;
    if (state.open && state.tab === 'dm' && state.conv === m.conversation_id && listEl()) {
      appendMessages(listEl(), [m], mine);
      if (!mine && document.visibilityState === 'visible') markRead();
    } else if (state.open && state.tab === 'dm' && !state.conv) {
      refreshConversationList();
    } else if (!mine && document.visibilityState === 'visible') {
      toast(T('Сообщение от {name}', { name: m.sender.username }), m.body.slice(0, 100));
    }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && state.open && state.conv) markRead();
  });

  function onDeleted(d) {
    var el = view.querySelector('[data-msg-id="' + d.id + '"]');
    if (!el) return;
    el.classList.add('deleted');
    $('.msg-bubble', el).innerHTML = '<em>' + T('Сообщение удалено') + '</em>';
    $$('.msg-act', el).forEach(function (b) { b.remove(); });
  }

  // Восстанавливаем открытый чат после перехода на другую страницу.
  if (ss.get('chat-open') === '1' && window.innerWidth > 720) openPanel();
})();
