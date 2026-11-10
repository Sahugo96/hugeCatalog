'use strict';

const { createApp } = require('./src/app');
const { ensureBootstrap } = require('./src/bootstrap');

ensureBootstrap();

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

createApp().listen(PORT, HOST, () => {
  console.log(`HugeCatalog запущен: http://localhost:${PORT}`);
});
