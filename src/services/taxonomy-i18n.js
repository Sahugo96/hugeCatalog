'use strict';

/**
 * Английские названия жанров и тегов.
 * Источник — колонка name_en (админка); при первом запуске она заполняется из словаря src/i18n/en.js.
 */

const { q } = require('../db');
const i18n = require('../i18n');

/** Заполняет пустые name_en переводами из словаря (только где перевод есть). */
function backfillFromDictionary() {
  for (const table of ['genres', 'tags']) {
    const upd = q(`UPDATE ${table} SET name_en = ? WHERE id = ?`);
    q(`SELECT id, name FROM ${table} WHERE name_en IS NULL`).all().forEach((r) => {
      const en = i18n.dictionaryEN[r.name];
      if (en) upd.run(en, r.id);
    });
  }
}

/** Передаёт переводчику актуальные английские названия из базы. Вызывать после любых изменений жанров/тегов. */
function refresh() {
  const map = new Map();
  for (const table of ['genres', 'tags']) {
    q(`SELECT name, name_en FROM ${table} WHERE name_en IS NOT NULL AND name_en != ''`).all()
      .forEach((r) => map.set(r.name, r.name_en));
  }
  i18n.setOverrides(map);
}

function init() {
  backfillFromDictionary();
  refresh();
}

module.exports = { init, refresh, backfillFromDictionary };
