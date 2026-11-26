#!/usr/bin/env node
'use strict';
/*
 * Проверка загрузки приложения без браузера и без зависимостей.
 *
 * Зачем: `node --check` проверяет файлы по одному и не видит, что два
 * классических скрипта объявляют одно и то же имя в общей глобальной области.
 * Именно так в репозиторий попал SyntaxError, из-за которого приложение
 * не запускалось целиком (Univerter-config.js и Univerter-core.js делили
 * восемь `const`).
 *
 * Здесь все скрипты компилируются в одной области видимости — как в браузере,
 * но без выполнения: DOM не нужен, ловится именно ошибка компиляции.
 *
 * Запуск:  node tests/load-app.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = path.join(__dirname, '..', 'Univerter_HTML', 'web');
// Порядок обязан совпадать с Univerter.html
const ORDER = ['Univerter-config.js', 'Univerter-core.js', 'Univerter-convert.js'];

let failed = false;

function fail(msg) {
  console.error('✗ ' + msg);
  failed = true;
}

// 1. Файлы на месте и HTML подключает их в том же порядке
const html = fs.readFileSync(path.join(WEB, 'Univerter.html'), 'utf8');
let cursor = -1;
for (const name of ORDER) {
  if (!fs.existsSync(path.join(WEB, name))) fail(`нет файла ${name}`);
  const pos = html.indexOf(`src="${name}"`);
  if (pos < 0) fail(`Univerter.html не подключает ${name}`);
  else if (pos < cursor) fail(`Univerter.html подключает ${name} не в том порядке`);
  else cursor = pos;
}

// 2. Совместная компиляция: повторное объявление в общей области — ошибка
const source = ORDER.map(name => fs.readFileSync(path.join(WEB, name), 'utf8')).join('\n;\n');
try {
  new vm.Script('(function () {\n' + source + '\n})', { filename: 'Univerter-*.js' });
} catch (e) {
  fail(`${e.name}: ${e.message}`);
}

// 3. Обе копии интерфейса обязаны совпадать побайтово
const SRC = path.join(__dirname, '..', 'Univerter_desktop', 'src');
for (const name of ORDER.concat('Univerter.html')) {
  const a = path.join(WEB, name);
  const b = path.join(SRC, name);
  if (!fs.existsSync(b)) { fail(`нет копии ${name} в Univerter_desktop/src`); continue; }
  if (!fs.readFileSync(a).equals(fs.readFileSync(b))) fail(`${name} разошёлся между web/ и desktop/src/`);
}

if (failed) process.exit(1);
console.log('✓ Скрипты компилируются вместе, порядок подключения верный, копии синхронны');
