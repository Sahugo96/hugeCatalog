'use strict';

/**
 * Массовое сжатие картинок в WebP (как в админке «Изображения»).
 *   npm run images:webp            — сжать все несжатые
 *   npm run images:webp -- --force — пересоздать все (например, после смены качества)
 */

const webp = require('../src/webp');

(async () => {
  if (!webp.available()) {
    console.error('Библиотека sharp не установлена: выполните npm install');
    process.exit(1);
  }
  const before = await webp.stats();
  await webp.startBulk({ force: process.argv.includes('--force') });
  const tick = setInterval(() => {
    const b = webp.bulkState();
    process.stdout.write(`\r${b.done} / ${b.total}`);
    if (!b.running) {
      clearInterval(tick);
      webp.stats().then((after) => {
        const mb = (x) => (x / 1048576).toFixed(1) + ' МБ';
        console.log(`\nСжато: ${b.converted}, ошибок: ${b.errors}${b.lastError ? ' (' + b.lastError + ')' : ''}`);
        console.log(`Оригиналы: ${mb(after.originalBytes)}, отдаётся: ${mb(after.servedBytes)}, экономия: ${mb(after.savedBytes)} (было ${mb(before.savedBytes)})`);
      });
    }
  }, 300);
})();
