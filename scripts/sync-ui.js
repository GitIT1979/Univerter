#!/usr/bin/env node
'use strict';
/*
 * Копирует интерфейс из Univerter_HTML/web в Univerter_desktop/src.
 *
 * Две копии нужны, потому что браузерная версия открывается как файл,
 * а Electron раздаёт src/ по HTTP. Правки вносить в web/ и запускать:
 *     node scripts/sync-ui.js
 * Расхождение копий ловит tests/load-app.js.
 */
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', 'Univerter_HTML', 'web');
const SRC = path.join(__dirname, '..', 'Univerter_desktop', 'src');
const FILES = ['Univerter.html', 'Univerter-config.js', 'Univerter-core.js', 'Univerter-convert.js'];

fs.mkdirSync(SRC, { recursive: true });
for (const name of FILES) {
  fs.copyFileSync(path.join(WEB, name), path.join(SRC, name));
}
fs.cpSync(path.join(WEB, 'vendor'), path.join(SRC, 'vendor'), { recursive: true });

console.log(`синхронизировано: ${FILES.join(', ')} + vendor/`);
