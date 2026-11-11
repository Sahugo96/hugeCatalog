'use strict';

/**
 * Импорт произведений из JSON-файла:
 *   npm run import -- works.json [--create-missing] [--skip-covers]
 * Формат описан в src/services/import.js и README.
 */

const fs = require('node:fs');
const { ensureBootstrap } = require('../src/bootstrap');
const { importWorks } = require('../src/services/import');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Использование: npm run import -- works.json [--create-missing] [--skip-covers]');
  process.exit(1);
}

ensureBootstrap();
importWorks(JSON.parse(fs.readFileSync(file, 'utf8')), {
  createMissing: args.includes('--create-missing'),
  skipCovers: args.includes('--skip-covers'),
}).then((report) => {
  const icon = { created: '+', updated: '~', skipped: '=', error: '!' };
  report.forEach((r) => console.log(`${icon[r.status]} ${r.title}${r.slug ? ` (/title/${r.slug})` : ''}${r.messages.length ? ' — ' + r.messages.join('; ') : ''}`));
  const created = report.filter((r) => r.status === 'created').length;
  console.log(`Создано: ${created} из ${report.length}`);
  process.exit(report.some((r) => r.status === 'error') ? 2 : 0);
});
