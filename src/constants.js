'use strict';

// Справочники, которые не нужно хранить в БД.

const TYPES = [
  { value: 'manga', label: 'Манга' },
  { value: 'manhwa', label: 'Манхва' },
  { value: 'manhua', label: 'Маньхуа' },
  { value: 'webtoon', label: 'Вебтун' },
  { value: 'comic', label: 'Комикс' },
  { value: 'oel', label: 'OEL-манга' },
  { value: 'russian', label: 'Руманга' },
  { value: 'doujinshi', label: 'Додзинси' },
  { value: 'other', label: 'Другое' },
];

const STATUSES = [
  { value: 'announced', label: 'Анонс' },
  { value: 'ongoing', label: 'Онгоинг' },
  { value: 'completed', label: 'Завершён' },
  { value: 'hiatus', label: 'Заморожен' },
  { value: 'cancelled', label: 'Прекращён' },
];

const LANGUAGES = [
  { value: 'ja', label: 'Японский' },
  { value: 'ko', label: 'Корейский' },
  { value: 'zh', label: 'Китайский' },
  { value: 'en', label: 'Английский' },
  { value: 'ru', label: 'Русский' },
  { value: 'uk', label: 'Украинский' },
  { value: 'fr', label: 'Французский' },
  { value: 'es', label: 'Испанский' },
  { value: 'de', label: 'Немецкий' },
  { value: 'other', label: 'Другой' },
];

const AGE_RATINGS = [
  { value: '0+', label: '0+' },
  { value: '6+', label: '6+' },
  { value: '12+', label: '12+' },
  { value: '16+', label: '16+' },
  { value: '18+', label: '18+' },
];

const SORTS = [
  { value: 'popular', label: 'По популярности' },
  { value: 'updated', label: 'По обновлению' },
  { value: 'new', label: 'По дате добавления' },
  { value: 'likes', label: 'По лайкам' },
  { value: 'year', label: 'По году выпуска' },
  { value: 'title', label: 'По названию' },
  { value: 'chapters', label: 'По количеству глав' },
];

const FORMATS = [
  { value: 'chapters', label: 'По главам' },
  { value: 'single', label: 'Сингл' },
];

const TAG_GROUPS = ['Сюжет', 'Рисовка', 'Персонажи', 'Сеттинг', 'Пародия', 'Прочее'];

const ROLES = [
  { value: 'user', label: 'Пользователь' },
  { value: 'moderator', label: 'Модератор' },
  { value: 'admin', label: 'Администратор' },
];

function labelOf(list, value) {
  const item = list.find((i) => i.value === value);
  return item ? item.label : value;
}

module.exports = {
  FORMATS,
  TYPES,
  STATUSES,
  LANGUAGES,
  AGE_RATINGS,
  SORTS,
  TAG_GROUPS,
  ROLES,
  labelOf,
  values: (list) => list.map((i) => i.value),
};
