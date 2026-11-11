'use strict';

/**
 * Языковые версии одного произведения.
 * Версии объединяются общим works.group_id. У одной группы — не больше одной версии на язык.
 */

const { q, transaction } = require('../db');
const C = require('../constants');

function groupOf(workId) {
  const row = q('SELECT id, group_id, language, title FROM works WHERE id = ?').get(workId);
  if (!row) return null;
  const members = row.group_id
    ? q('SELECT id, language, title FROM works WHERE group_id = ?').all(row.group_id)
    : [{ id: row.id, language: row.language, title: row.title }];
  return { work: row, groupId: row.group_id, members };
}

/**
 * Все версии произведения (включая его само), отсортированные по порядку языков в справочнике.
 * onlyApproved — для читателей скрываем версии, не прошедшие модерацию (кроме текущей).
 */
function getVersions(workId, { onlyApproved = true } = {}) {
  const row = q('SELECT group_id FROM works WHERE id = ?').get(workId);
  if (!row || !row.group_id) return [];
  const order = C.values(C.LANGUAGES);
  return q(`SELECT id, slug, title, language, moderation,
      (SELECT COUNT(*) FROM chapters c WHERE c.work_id = works.id) AS chapters_count
    FROM works WHERE group_id = ?`).all(row.group_id)
    .filter((v) => !onlyApproved || v.moderation === 'approved' || v.id === workId)
    .sort((a, b) => order.indexOf(a.language) - order.indexOf(b.language));
}

/** Связывает два произведения как языковые версии. Бросает ошибку с понятным текстом. */
function linkWorks(aId, bId) {
  if (aId === bId) throw userError('Нельзя связать произведение с самим собой.');
  return transaction(() => {
    const a = groupOf(aId);
    const b = groupOf(bId);
    if (!a || !b) throw userError('Произведение не найдено.');
    if (a.groupId && a.groupId === b.groupId) throw userError('Эти версии уже связаны.');
    const langsA = new Map(a.members.map((m) => [m.language, m]));
    for (const m of b.members) {
      if (langsA.has(m.language)) {
        throw userError(`Версия на языке «${C.labelOf(C.LANGUAGES, m.language)}» уже есть: «${langsA.get(m.language).title}». Сначала отвяжите её.`);
      }
    }
    const target = a.groupId || b.groupId || Math.min(aId, bId);
    const ids = [...a.members, ...b.members].map((m) => m.id);
    const upd = q('UPDATE works SET group_id = ? WHERE id = ?');
    ids.forEach((id) => upd.run(target, id));
    return target;
  });
}

/** Отвязывает версию от группы. Если в группе остаётся одна версия, группа распускается. */
function unlinkWork(workId) {
  return transaction(() => {
    const row = q('SELECT group_id FROM works WHERE id = ?').get(workId);
    if (!row || !row.group_id) return;
    q('UPDATE works SET group_id = NULL WHERE id = ?').run(workId);
    cleanupGroup(row.group_id);
  });
}

function cleanupGroup(groupId) {
  if (!groupId) return;
  const left = q('SELECT COUNT(*) AS n FROM works WHERE group_id = ?').get(groupId).n;
  if (left < 2) q('UPDATE works SET group_id = NULL WHERE group_id = ?').run(groupId);
}

/** id всех версий произведения (включая его само) — для исключения из «похожих». */
function sameGroupIds(workId) {
  const row = q('SELECT group_id FROM works WHERE id = ?').get(workId);
  if (!row || !row.group_id) return new Set([workId]);
  return new Set(q('SELECT id FROM works WHERE group_id = ?').all(row.group_id).map((r) => r.id));
}

function userError(message) {
  const err = new Error(message);
  err.status = 400;
  err.expose = true;
  return err;
}

module.exports = { getVersions, linkWorks, unlinkWork, cleanupGroup, sameGroupIds };
