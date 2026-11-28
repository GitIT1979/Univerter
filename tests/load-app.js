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

// 4. Библиотеки лежат локально: приложение не должно тянуть код с CDN
const VENDOR = ['pdf.min.js', 'pdf.worker.min.js', 'jszip.min.js', 'jspdf.umd.min.js', 'mammoth.browser.min.js',
                'turndown.js', 'turndown-plugin-gfm.js', 'xlsx.full.min.js', 'FileSaver.min.js'];
for (const name of VENDOR) {
  const a = path.join(WEB, 'vendor', name);
  const b = path.join(SRC, 'vendor', name);
  if (!fs.existsSync(a)) { fail(`нет библиотеки vendor/${name}`); continue; }
  if (!fs.existsSync(b) || !fs.readFileSync(a).equals(fs.readFileSync(b))) fail(`vendor/${name} разошёлся между копиями`);
}
const external = html.match(/<script[^>]+src="https?:\/\/[^"]+"/g);
if (external) fail(`в HTML остались внешние скрипты: ${external.length}`);

// 5. Копия движка для установщика обязана совпадать с Univerter_HTML/server
// (упакованный Univerter.exe стартует движок из resources/engine — см. main.js)
const ENGINE_COPY = path.join(__dirname, '..', 'Univerter_desktop', 'engine', 'server');
for (const name of ['univerter_server.py', 'univerter_fidelity.py']) {
  const a = path.join(__dirname, '..', 'Univerter_HTML', 'server', name);
  const b = path.join(ENGINE_COPY, name);
  if (!fs.existsSync(b)) { fail(`нет копии ${name} в Univerter_desktop/engine/server`); continue; }
  if (!fs.readFileSync(a).equals(fs.readFileSync(b))) fail(`${name} разошёлся между Univerter_HTML/server и desktop/engine/server`);
}

// 5. Батники Windows: CRLF и без BOM — иначе cmd парсит их со сбоями
// (на LF-файле с кириллицей возобновляется посреди строки и исполняет обрывки текста)
function collectBats(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.') || name === 'node_modules' || name.startsWith('dist')) continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) collectBats(p, out);
    else if (name.toLowerCase().endsWith('.bat')) out.push(p);
  }
  return out;
}
for (const p of collectBats(path.join(__dirname, '..'))) {
  const rel = path.relative(path.join(__dirname, '..'), p);
  const buf = fs.readFileSync(p);
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    fail(`${rel}: UTF-8 BOM — первая строка @echo off не сработает`);
    continue;
  }
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0A && (i === 0 || buf[i - 1] !== 0x0D)) {
      fail(`${rel}: LF вместо CRLF — cmd парсит такой батник со сбоями. Пересохраните файл с CRLF`);
      break;
    }
  }
}

if (failed) process.exit(1);
console.log('✓ Скрипты компилируются вместе, порядок подключения верный, копии синхронны, батники в CRLF');
