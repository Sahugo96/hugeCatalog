'use strict';

// Компактные SVG-флаги языков (3:2). Эмодзи-флаги не отображаются в Windows, поэтому рисуем сами.
const FLAGS = {
  ja: '<rect width="30" height="20" fill="#fff"/><circle cx="15" cy="10" r="6" fill="#bc002d"/>',
  ko: '<rect width="30" height="20" fill="#fff"/><path d="M15 4a6 6 0 0 1 0 12a3 3 0 0 1 0-6a3 3 0 0 0 0-6z" fill="#0047a0"/><path d="M15 4a3 3 0 0 0 0 6a3 3 0 0 1 0 6a6 6 0 0 1 0-12z" fill="#cd2e3a"/>'
    + '<g stroke="#000" stroke-width="1.2"><path d="M4 4.5l3-2.5M5 5.7l3-2.5M6 6.9l3-2.5M21 2l3 2.5M22 3.2l3 2.5M21 13.1l3 2.5M22 14.3l3 2.5M6 13.1l-3 2.5M7 14.3l-3 2.5M8 15.5l-3 2.5"/></g>',
  zh: '<rect width="30" height="20" fill="#de2910"/><path d="M5 3l.9 2.8H9l-2.4 1.7.9 2.8L5 8.6 2.6 10.3l.9-2.8L1 5.8h3.1z" fill="#ffde00"/>'
    + '<g fill="#ffde00"><circle cx="10" cy="2.5" r=".8"/><circle cx="12" cy="4.5" r=".8"/><circle cx="12" cy="7.5" r=".8"/><circle cx="10" cy="9.5" r=".8"/></g>',
  en: '<rect width="30" height="20" fill="#012169"/><path d="M0 0l30 20M30 0L0 20" stroke="#fff" stroke-width="4"/><path d="M0 0l30 20M30 0L0 20" stroke="#c8102e" stroke-width="1.6"/>'
    + '<path d="M15 0v20M0 10h30" stroke="#fff" stroke-width="6"/><path d="M15 0v20M0 10h30" stroke="#c8102e" stroke-width="3.4"/>',
  ru: '<rect width="30" height="20" fill="#fff"/><rect y="6.67" width="30" height="6.67" fill="#0039a6"/><rect y="13.33" width="30" height="6.67" fill="#d52b1e"/>',
  uk: '<rect width="30" height="10" fill="#0057b7"/><rect y="10" width="30" height="10" fill="#ffd700"/>',
  fr: '<rect width="10" height="20" fill="#0055a4"/><rect x="10" width="10" height="20" fill="#fff"/><rect x="20" width="10" height="20" fill="#ef4135"/>',
  es: '<rect width="30" height="20" fill="#aa151b"/><rect y="5" width="30" height="10" fill="#f1bf00"/>',
  de: '<rect width="30" height="6.67" fill="#000"/><rect y="6.67" width="30" height="6.67" fill="#dd0000"/><rect y="13.33" width="30" height="6.67" fill="#ffce00"/>',
  other: '<rect width="30" height="20" fill="#5b6478"/><circle cx="15" cy="10" r="6.5" fill="none" stroke="#fff" stroke-width="1.3"/>'
    + '<path d="M8.5 10h13M15 3.5c-3 3.5-3 9.5 0 13M15 3.5c3 3.5 3 9.5 0 13" fill="none" stroke="#fff" stroke-width="1.1"/>',
};

/** <svg> флага языка. title — подпись для всплывающей подсказки и скринридеров. */
function flag(lang, title = '', cls = '') {
  const body = FLAGS[lang] || FLAGS.other;
  const label = String(title).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<svg class="flag ${cls}" viewBox="0 0 30 20" width="21" height="14" role="img" aria-label="${label}"><title>${label}</title>${body}</svg>`;
}

module.exports = { flag, FLAGS };
