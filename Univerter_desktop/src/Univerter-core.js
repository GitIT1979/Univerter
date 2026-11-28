'use strict';
/* ============================================================
   Univerter — core.js
   Входные форматы: pdf, docx, txt, md, markdown, odt,
   xls/xlsx/xlsm/csv/ods, изображения (jpg/jpeg/png/gif/bmp/webp).
   .doc, .rtf, .tiff/.tif — не поддерживаются.

   ВНИМАНИЕ: OCR инициализируется лениво на стороне локального движка.
   stopConversion прерывает HTTP-запросы к движку (AbortController) и отклоняет
   ожидающие промисы, но уже начатую страницу движок доводит сам:
   отменить чужой процесс из браузера нельзя.
   ============================================================ */

/* Константы (CONFIG, формат-правила, расширения) объявлены в Univerter-config.js.
   Он подключается раньше, и оба файла делят одну глобальную область: повторный
   `const` с тем же именем — SyntaxError на весь файл. Не дублировать. */

if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/pdf.worker.min.js`;
}

const $ = (id) => document.getElementById(id);
const fileInput = $('fileInput');
const folderInput = $('folderInput');
const fileList = $('fileList');
const dropZone = $('dropZone');
const modeOptions = document.querySelectorAll('.mode-option');
const currentModeEl = $('currentMode');
const convertBtn = $('convertBtn');
const stopBtn = $('stopBtn');
const overallProgress = $('overallProgress');
const progressBarFill = $('progressBarFill');
const progressPercent = $('progressPercent');
const progressDone = $('progressDone');
const progressTotal = $('progressTotal');
const progressTitle = $('progressTitle');
const progressCurrentFile = $('progressCurrentFile');
const renameFilesCheckbox = $('renameFiles');
const fallbackModeCheckbox = $('fallbackMode');
const templateInput = $('template');

let allFiles = [];
let filesToProcess = [];
let convertedFiles = [];
let isProcessing = false;
let stopRequested = false;
let rebuildSeq = 0;
const stopWaiters = new Set();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function xmlEscape(s) {
  return String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function sanitizeFileName(name) {
  let clean = String(name).replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_').replace(/^\.+|\s+$/g, '').trim();
  clean = clean.replace(/[\s.]+(\.[^.]+)$/, '$1');
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?=\.|$)/i.test(clean)) clean = '_' + clean;
  const full = clean || 'file';
  if (full.length <= 150) return full;
  const ext = (/(\.[A-Za-z0-9]{1,8})$/.exec(full) || ['', ''])[1];   // расширение не режем
  return full.slice(0, 150 - ext.length) + ext;
}
function formatBytes(n) {
  if (!n && n !== 0) return 'неизвестно';
  if (n < 1024) return n + ' Б';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' КБ';
  return (n / 1048576).toFixed(1) + ' МБ';
}
function releaseCanvas(c) { if (c) { c.width = 0; c.height = 0; } }
function requireLib(cond, name) { if (!cond) throw new Error(`Библиотека ${name} не загружена`); }
function throwIfStopped() { if (stopRequested) throw new Error('Остановлено пользователем'); }
/* Промис отклоняется сразу при нажатии «Остановить» (ожидающий запрос
   к движку распознавания не должен висеть до таймаута). */
function rejectOnStop(promise) {
  return new Promise((resolve, reject) => {
    if (stopRequested) return reject(new Error('Остановлено пользователем'));
    const w = () => reject(new Error('Остановлено пользователем'));
    stopWaiters.add(w);
    promise.then(resolve, reject).finally(() => stopWaiters.delete(w));
  });
}
function showNotice(text, kind = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.setAttribute('role', 'status');
  el.textContent = text;
  let box = document.getElementById('toastBox');
  if (!box) { box = document.createElement('div'); box.id = 'toastBox'; document.body.appendChild(box); }
  box.appendChild(el);
  const close = () => el.remove();
  el.addEventListener('click', close);
  setTimeout(close, 9000);
}
function setModeLocked(locked) {
  document.querySelectorAll('input[name="targetFormat"]').forEach(r => { r.disabled = locked; });
  document.querySelectorAll('.mode-option').forEach(o => o.classList.toggle('locked', locked));
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout: ${label}`)), ms); })
  ]);
}

/* Запросы к локальному движку: прерываются по таймауту и по кнопке «Остановить».
   Раньше таймаут только проигрывал гонку, а сам запрос продолжал занимать
   движок (OCR сериализован на сервере), и следующая конвертация стояла в очереди. */
const activeRequests = new Set();
function abortActiveRequests() {
  for (const ctl of activeRequests) { try { ctl.abort(); } catch (e) { /* уже завершён */ } }
  activeRequests.clear();
}
async function fetchAbortable(url, options, ms, label) {
  const ctl = new AbortController();
  activeRequests.add(ctl);
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, Object.assign({}, options, { signal: ctl.signal }));
  } catch (e) {
    if (stopRequested) throw new Error('Остановлено пользователем');
    if (e && e.name === 'AbortError') throw new Error(`timeout: ${label}`);
    throw e;
  } finally {
    clearTimeout(timer);
    activeRequests.delete(ctl);
  }
}

function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b && b.size > 0) ? resolve(b) : reject(new Error('Не удалось получить изображение')), type, quality);
  });
}

/* ============================================================
   Проверка читаемости текста (не считаем пробелы)
   ============================================================ */
function isTextReadable(text) {
  if (!text) return false;
  const visible = text.replace(/\s/g, '');
  if (visible.length < 10) return false;
  const readable = (text.match(/[\p{L}\p{N}]/gu) || []).length;
  const garbage  = (text.match(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g) || []).length;
  return (readable / visible.length > 0.5) && (garbage / text.length < 0.1);
}

function getExtension(filename) {
  const lastDot = String(filename).lastIndexOf('.');
  if (lastDot <= 0) return '';
  const ext = filename.substring(lastDot + 1).toLowerCase();
  return KNOWN_EXTENSIONS.has(ext) ? ext : '';
}
function getBaseName(filename) {
  const ext = getExtension(filename);
  return ext ? filename.substring(0, filename.length - ext.length - 1) : filename;
}

/* MIME → расширение. Записи для doc/rtf/tiff/tif удалены. */
function getExtensionFromMime(mimeType) {
  if (!mimeType) return '';
  const mimeMap = {
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-excel': 'xls',
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
    'image/bmp': 'bmp', 'image/webp': 'webp'
  };
  return mimeMap[mimeType.split(';')[0].trim().toLowerCase()] || '';
}
function detectFileType(file) {
  return getExtension(file.name) || getExtensionFromMime(file.type) || file._sniffedExt || '';
}

/* ============================================================
   Сниффинг по сигнатуре. doc/rtf — удалены.
   OOXML (docx/xlsx) по ZIP-сигнатуре: сначала эвристика по первым
   4 КБ (без JSZip), затем точная проверка через JSZip, если доступен.
   ============================================================ */
async function sniffExtension(file) {
  try {
    const buf = new Uint8Array(await file.slice(0, 32).arrayBuffer());
    const s = String.fromCharCode(...buf);
    if (s.startsWith('%PDF-')) return 'pdf';
    if (buf[0] === 0x89 && s.startsWith('\x89PNG')) return 'png';
    if (buf[0] === 0xFF && buf[1] === 0xD8) return 'jpg';
    if (s.startsWith('GIF8')) return 'gif';
    if (buf[0] === 0x42 && buf[1] === 0x4D && [12, 40, 52, 56, 64, 108, 124].includes(buf[14]) && !buf[15] && !buf[16] && !buf[17]) return 'bmp';
    if (s.startsWith('RIFF') && s.substring(8, 12) === 'WEBP') return 'webp';

    if (buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04) {
      // Эвристика по первым 4 КБ — не требует JSZip
      try {
        const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
        const str = new TextDecoder('latin1').decode(head);
        if (str.includes('[Content_Types].xml')) {
          if (str.includes('word/')) return 'docx';
          if (str.includes('xl/')) return 'xlsx';
        }
      } catch (e) {}
      // Точная проверка через JSZip — если библиотека уже доступна
      if (typeof JSZip !== 'undefined') {
        try {
          const arr = await file.arrayBuffer();
          const z = await JSZip.loadAsync(arr);
          if (z.file('word/document.xml')) return 'docx';
          if (z.file('xl/workbook.xml')) return 'xlsx';
        } catch (e) {}
      }
    }
  } catch (e) {}
  return '';
}

function hasMeaningfulName(filename) {
  const baseName = getBaseName(filename);
  const lower = baseName.toLowerCase().trim();
  if (baseName.length < 3) return false;
  if (/^\d+$/.test(baseName)) return false;
  if (!/\p{L}/u.test(baseName)) return false;
  /* «Автоматические» имена, которые дают камеры, сканеры, мессенджеры и Windows/macOS.
     Слово + только цифры/даты/время/«(1)»/«копия» — автоматическое;
     любое другое слово после него («Скан договора», «Фото с отпуска») делает имя осмысленным. */
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const AUTO_WORDS = [
    // латиница: камеры, сканеры, скриншоты
    'img', 'dsc', 'dscn', 'dscf', 'imag', 'pxl', 'mvimg', 'image', 'photo', 'picture',
    'scan', 'scanned', 'screenshot', 'screen shot', 'document', 'file', 'untitled', 'noname',
    'new document', 'new file',
    // кириллица
    'снимок экрана', 'скриншот', 'скрин', 'скан', 'сканы', 'сканирование', 'изображение',
    'картинка', 'фото', 'фотография', 'документ', 'файл', 'безымянный', 'без названия',
    'без имени', 'новый документ', 'новый текстовый документ', 'новый файл', 'новое изображение'
  ];
  const NEED_NUMBER = ['книга', 'презентация', 'лист', 'копия', 'book', 'presentation', 'sheet', 'copy']; // «Книга1», «Презентация2»
  const TAIL = '(?:[\\s_\\-.:()@\\d]|\\s(?:в|at)\\s|копия|copy)*';
  const autoPatterns = [
    new RegExp('^(?:' + AUTO_WORDS.map(esc).join('|') + ')' + TAIL + '$', 'i'),
    new RegExp('^(?:' + NEED_NUMBER.map(esc).join('|') + ')[\\s_\\-.]*\\d' + TAIL + '$', 'i'),
    /^img[_-]?e\d+$/i,                                   // IMG_E1234 (iPhone, отредактировано)
    /^(?:img|vid|ptt|aud)-\d{8}-wa\d+$/i,                // IMG-20240101-WA0001 (WhatsApp)
    /^p\d{6,}$/i,                                        // P1010001 (камеры)
    /^screenshot[_\s-]?\d[\d_\-\s.:]*(?:_[a-z.]+)?$/i,   // Screenshot_20240101-123456_Chrome
    /^whatsapp[\s_-]*(image|video|audio|document)/i,
    /^telegram[_-]?\d+/i,
    /^(?:новый\s+)?(?:документ|лист|презентация)\s+microsoft\s+(?:word|excel|powerpoint)[\s_\-.:()\d]*$/i,
    /^microsoft\s+(?:word|excel|powerpoint)\s*-\s*(?:document|документ|book|книга|presentation|презентация)\d*$/i,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i,              // UUID
    /^[a-z0-9]{20,}$/i                                    // длинные хеши
  ];
  for (const p of autoPatterns) if (p.test(lower)) return false;
  if (/[^\u0000-\u007F]/.test(baseName) && /\p{L}/u.test(baseName)) return true;
  const words = baseName.split(/[\s_\-.]+/).filter(w => w.length >= 2);
  if (words.length >= 2) return true;
  return /^[a-zA-Z]{4,}$/.test(baseName);
}

/* ============================================================
   Осмысленное имя по содержимому (для автоимён вроде IMG_1234, scan001)
   ============================================================ */
const TITLE_MAX_CHARS = 60;
const DOC_TEXT_MAX = 20000;   // сколько символов текста анализируем

/* Строка из ЗАГЛАВНЫХ → обычный регистр; известные аббревиатуры (ООО, ИНН, АО…) остаются заглавными. */
const CAPS_ABBR = new Set(['ооо', 'зао', 'пао', 'оао', 'ао', 'ип', 'нко', 'инн', 'кпп', 'огрн', 'огрнип', 'бик', 'рф', 'ссср', 'фио',
  'гост', 'снип', 'снилс', 'ндс', 'тз', 'фз', 'сша', 'ес', 'жкх', 'тсж', 'мфц', 'дтп', 'егрн', 'егрюл', 'птс', 'стс', 'ттн', 'упд',
  'llc', 'inc', 'ltd', 'usa', 'uk', 'eu', 'vat', 'pdf', 'ceo', 'gmbh', 'iso']);
function fixCaps(line, capFirst) {
  const lets = line.match(/\p{L}/gu) || [];
  if (!lets.length || lets.filter(ch => /\p{Ll}/u.test(ch)).length / lets.length > 0.15) return line;   // обычный/смешанный регистр — не трогаем
  let capNext = capFirst;
  return line.split(' ').map(tok => {
    const letters = (tok.match(/\p{L}/gu) || []).length;
    if (!letters) return tok;
    const bare = tok.toLowerCase().replace(/[^\p{L}]/gu, '');
    if (CAPS_ABBR.has(bare) || /\d/.test(tok)) return tok;           // известная аббревиатура (ООО, ИНН) или токен с цифрами («45-К»)
    let out = tok.toLowerCase();
    if (capNext) { out = out.replace(/\p{L}/u, ch => ch.toUpperCase()); capNext = false; }
    return out;
  }).join(' ');
}

/* ---------- служебное: границы слов для кириллицы (\b в JS её не понимает) ---------- */
const BL = '(?<![\\p{L}\\d])', BR = '(?![\\p{L}\\d])';
function mkRe(src, flags) {
  const full = src.replace(/\^\^/g, BL).replace(/\$\$/g, BR);
  try { return new RegExp(full, flags); }
  catch (e) { return new RegExp(src.replace(/\^\^|\$\$/g, ''), flags.replace('u', '')); }   // старый браузер без lookbehind
}
const cap1 = s => s.charAt(0).toUpperCase() + s.slice(1);
const GENERIC_TITLE = /^(?:document\s*\d*|документ\s*\d*|microsoft word.*|untitled|без названия|новый документ.*|title|заголовок)$/i;

/* Строка — продолжение заголовка («… СПРАВКА» → «о доходах…»): начинается со строчной буквы или «№» */
const isContinuation = l => !!l && /^(?:\p{Ll}|№)/u.test(l);
const isAllCaps = l => !/\p{Ll}/u.test(l) && (l.match(/\p{L}/gu) || []).length >= 3;

function cleanLine(line) {
  return String(line).replace(/^[\s#>*\-–—_•·|]+/, '').replace(/[*_`|]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function isJunkLine(line) {
  if (!line) return true;
  if (/^(?:страница|page|стр\.?)\s*\d+$/i.test(line)) return true;          // наши «## Страница N» и номера страниц
  const letters = (line.match(/\p{L}/gu) || []).length;
  if (letters < 3) return true;                                              // номера, даты, линии
  if (letters / line.length < 0.5) return true;                              // цифровые таблицы, мусор OCR
  if (/^(?:https?:\/\/|www\.)\S+$/i.test(line) || /^\S+@\S+\.\S+$/.test(line)) return true;
  return false;
}

/* Первая «похожая на заголовок» строка текста (запасной вариант и очистка заголовка). */
function titleFromText(text) {
  if (!text) return '';
  const cands = [];
  for (const raw of String(text).replace(/\r/g, '').split('\n')) {
    const line = cleanLine(raw);
    if (isJunkLine(line)) continue;
    cands.push(line);
    if (cands.length >= 3) break;
  }
  if (!cands.length) return '';
  let title = fixCaps(cands[0], true);
  // короткая первая строка («ДОГОВОР») + её продолжение («№ 15 аренды помещения»)
  if (cands[1] && isContinuation(cands[1]) && (cands[0].length <= 14 || isAllCaps(cands[0]))) title += ' ' + fixCaps(cands[1], false);
  title = title.replace(/(\d)\s*\/\s*(\d)/g, '$1-$2').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();   // «7/24» → «7-24»; недопустимые для имени символы убираем
  if (title.length > TITLE_MAX_CHARS) {
    title = title.slice(0, TITLE_MAX_CHARS);
    const sp = title.lastIndexOf(' ');
    if (sp > 20) title = title.slice(0, sp);
  }
  return title.replace(/[\s.,;:–—\-_]+$/, '');
}

function decodeXmlText(s) {
  return s.replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d))
          .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/* DOCX: текст всех абзацев (до maxChars) */
function docxXmlToText(docXml, maxChars) {
  const out = [];
  let len = 0;
  for (const p of docXml.split('</w:p>')) {
    const parts = p.match(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>|<w:tab\/>/g) || [];
    const s = decodeXmlText(parts.map(x => (x === '<w:tab/>' ? ' ' : x.replace(/<[^>]+>/g, ''))).join(''));
    if (!s.trim()) continue;
    out.push(s);
    len += s.length + 1;
    if (len >= maxChars) break;
  }
  return out.join('\n').slice(0, maxChars);
}

/* Таблица: строка-заголовок из одной ячейки → имя листа → первые ячейки шапки */
function titleFromRows(rows, sheetName) {
  const cellsOf = r => (r || []).map(x => String(x == null ? '' : x).trim()).filter(Boolean);
  const first = cellsOf((rows || [])[0]);
  if (first.length === 1 && (first[0].match(/\p{L}/gu) || []).length >= 4) {
    const t = titleFromText(first[0]); if (t) return t;
  }
  if (sheetName && !/^(?:лист|sheet|таблица|table)\s*\d*$/i.test(String(sheetName).trim())) {
    const t = titleFromText(String(sheetName)); if (t) return t;
  }
  return titleFromText(first.filter(s => /\p{L}/u.test(s)).slice(0, 3).join(' '));
}

/* ============================================================
   Даты
   ============================================================ */
const MONTH_RU = { 'янв': 1, 'фев': 2, 'мар': 3, 'апр': 4, 'мая': 5, 'май': 5, 'июн': 6, 'июл': 7, 'авг': 8, 'сен': 9, 'окт': 10, 'ноя': 11, 'дек': 12 };
const MONTH_EN = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function validYMD(y, m, d) {
  const now = new Date().getFullYear();
  if (y < 1990 || y > now + 1 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(y, m, 0).getDate();
}

/* Все даты в тексте: 12.03.2024, 2024-03-12, «12» марта 2024 г., March 12, 2024 (и OCR-опечатки О→0) */
function findDates(text) {
  const out = [];
  const digitBefore = i => i > 0 && /[\d.\/-]/.test(text[i - 1]);
  const fix = s => +String(s).replace(/[OОоo]/g, '0');
  const add = (m, y, mo, d) => { if (validYMD(y, mo, d)) out.push({ y, mo, d, index: m.index, end: m.index + m[0].length, raw: m[0] }); };
  let m, re;

  re = /([0-3OО]?[\dOО])[.\/-]([01OО]?[\dOО])[.\/-](\d{4}|\d{2})(?!\d)/g;
  while ((m = re.exec(text))) {
    if (digitBefore(m.index)) continue;
    let y = fix(m[3]); if (m[3].length === 2) y += 2000;
    const before = out.length;
    add(m, y, fix(m[2]), fix(m[1]));
    if (m[3].length === 2 && out.length > before) out[out.length - 1].twoDigit = true;   // «12.03.24»: легко спутать с номером пункта
  }
  re = /(\d{4})-(\d{2})-(\d{2})(?!\d)/g;
  while ((m = re.exec(text))) { if (!digitBefore(m.index)) add(m, +m[1], +m[2], +m[3]); }

  re = /([0-3]?\d)\s*[»"”]?\s*(янв|фев|мар|апр|ма[йя]|июн|июл|авг|сен|окт|ноя|дек)[а-яё]*\.?\s+(\d{4})/gi;
  while ((m = re.exec(text))) { if (!digitBefore(m.index)) add(m, +m[3], MONTH_RU[m[2].toLowerCase()], +m[1]); }

  re = /(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})/gi;
  while ((m = re.exec(text))) { if (!digitBefore(m.index)) add(m, +m[3], MONTH_EN[m[2].toLowerCase()], +m[1]); }
  re = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/gi;
  while ((m = re.exec(text))) { add(m, +m[3], MONTH_EN[m[1].toLowerCase()], +m[2]); }

  out.sort((a, b) => a.index - b.index);
  return out.filter((d, i) => !i || d.index !== out[i - 1].index);
}

/* Дата документа: «от …», «дата: …», «г. Москва, …» в начале; не срок, не дата рождения; «с … по …» → период */
function pickDocDate(text, typeKey) {
  const dates = findDates(text.slice(0, 6000));
  if (!dates.length) return null;
  const pad = n => String(n).padStart(2, '0');
  const iso = d => `${d.y}-${pad(d.mo)}-${pad(d.d)}`;

  const periodWanted = ['statement', 'report', 'act'].includes(typeKey) || /за\s+период|сверк/i.test(text.slice(0, 1500));
  if (periodWanted) {
    for (let i = 0; i + 1 < dates.length; i++) {
      const a = dates[i], b = dates[i + 1];
      if (a.index > 1500) break;
      const between = text.slice(a.end, b.index);
      const pre = text.slice(Math.max(0, a.index - 8), a.index);
      if (/^\s*(?:по|[-–—]|to)\s*$/i.test(between) && /(?:^|[\s(])(?:с|from)\s*[«"“]?\s*$/i.test(pre)) {
        const last = new Date(a.y, a.mo, 0).getDate();
        if (a.y === b.y && a.mo === b.mo && a.d === 1 && b.d === last) return { iso: `${a.y}-${pad(a.mo)}`, why: 'отчётный месяц' };
        if (a.y === b.y && a.mo === 1 && a.d === 1 && b.mo === 12 && b.d === 31) return { iso: String(a.y), why: 'отчётный год' };
        if (a.y === b.y && a.d === 1 && b.d === new Date(b.y, b.mo, 0).getDate() && b.mo - a.mo === 2 && a.mo % 3 === 1) return { iso: `${a.y}-Q${(a.mo - 1) / 3 + 1}`, why: 'отчётный квартал' };
        return { iso: iso(a) + '_' + iso(b), why: 'период' };
      }
    }
  }

  const KEY = /(?:^|[\s(])(?:от|дата|date|dated|датирован[а-я]*|составлен[а-я]*|на\s+дату|г\.[^\n]{0,25}|№\s*[\p{L}\d\-\/._]+\s+от)\s*[:.,]?\s*[«"“]?\s*$/iu;
  const NEG = /(?:^|[\s(])(?:до|по|не\s+позднее|срок[^\n]{0,20}|действует\s+до|valid\s+until|due(?:\s+date)?|expires?|until|рожд[а-я]*|born|birth[^\n]{0,10}|дата\s+рождения|верси[яи]|version|ver|гост|iso|пункт|раздел|п|стр)\s*[:.,]?\s*[«"“]?\s*$/iu;
  let best = null;
  for (const d of dates) {
    const before = text.slice(Math.max(0, d.index - 45), d.index).toLowerCase();
    let s = 1, why = 'в начале документа';
    s += d.index < 800 ? 4 : d.index < 2000 ? 2 : 0;
    const key = KEY.test(before);
    if (d.twoDigit && !key) {                                         // двузначный год: только рядом с «от/дата» или отдельной строкой («12.03.24 14:35»)
      const rest = text.slice(d.end).split('\n')[0];
      if (!/^\s*(?:г\.?|года)?\s*(?:\d{1,2}:\d{2}.*)?$/i.test(rest)) continue;   // «5.12.10 Порядок расчётов» — это номер пункта
    }
    if (key) { s += 5; why = 'рядом со словом «от» / «дата»'; }
    if (NEG.test(before)) s -= 6;                                   // срок, дата рождения
    if (!best || s > best.s) best = { s, d, why };
  }
  if (!best || best.s < 4) return null;
  return { iso: iso(best.d), why: best.why };
}

/* Убирает из названия даты (они выносятся в начало имени) */
function stripDates(s) {
  const ds = findDates(s);
  for (const d of ds.reverse()) {
    let a = d.index, b = d.end;
    const pre = s.slice(0, a).match(/(?:\s|^)(?:от|на|за|с|по|до|dated?|of)\s*[«"“]?\s*$/i);
    if (pre) a -= pre[0].length;
    const post = s.slice(b).match(/^\s*(?:года|г\.?)(?=\s|$|[,.;])/i);
    if (post) b += post[0].length;
    s = s.slice(0, a) + ' ' + s.slice(b);
  }
  return s.replace(/\s+/g, ' ').replace(/\s+([,.;:])/g, '$1').trim();
}

/* ============================================================
   Типы документов: слова-признаки по ВСЕМУ тексту (в начале — вес выше)
   ============================================================ */
const DOC_TYPES = [];
function defType(key, label, stemSrc, kws, opts) {
  opts = opts || {};
  DOC_TYPES.push({
    key, label,
    stem: mkRe(stemSrc, 'iu'),
    kw: kws.map(([s, w]) => [mkRe(s, 'giu'), w]),
    sub: opts.sub ? mkRe(opts.sub, 'iu') : null,
    numbered: !!opts.numbered, person: !!opts.person, orgs: opts.orgs !== false
  });
}
defType('contract', 'Договор', 'договор|контракт|соглашени',
  [['договор', 3], ['именуем[а-яё]*\\s+(?:в\\s+дальнейшем|далее)', 5], ['предмет\\s+договора', 5], ['подписи\\s+сторон|реквизиты\\s+сторон', 4], ['^^(?:agreement|contract)$$', 2]],
  { numbered: true, sub: 'договор\\s+(?:возмездного\\s+оказания\\s+услуг|оказания\\s+услуг|купли[-\\s]продажи|субаренды|аренды|поставки|подряда|займа|найма|дарения|хранения|перевозки|трудовой)' });
defType('invoice', 'Счёт', 'сч[её]т|invoice',
  [['сч[её]т\\s+на\\s+оплату', 7], ['сч[её]т\\s*(?:№|no\\.?\\s*\\d)', 4], ['назначение\\s+платежа', 2], ['^^invoice$$', 5], ['итого\\s+к\\s+оплате', 3], ['к\\s+оплате', 1]],
  { numbered: true, sub: 'сч[её]т\\s+на\\s+оплату' });
defType('upd', 'Счёт-фактура', 'сч[её]т-фактур|^^упд$$',
  [['сч[её]т-фактура', 8], ['универсальный\\s+передаточный\\s+документ', 8], ['^^упд$$', 5]], { numbered: true });
defType('act', 'Акт', '^^акт$$',
  [['^^акт$$\\s+(?:выполненных|оказанных|сверки|при[её]ма|осмотра|сдачи|списания)', 8], ['^^акт$$\\s*(?:№|no\\.?\\s*\\d)', 5], ['^^акт$$', 2]],
  { numbered: true, sub: '^^акт$$\\s+(?:выполненных\\s+работ|оказанных\\s+услуг|сверки(?:\\s+взаиморасч[её]тов)?|при[её]ма[-\\s]передачи|осмотра|сдачи[-\\s]при[её]мки|списания)' });
defType('waybill', 'Товарная накладная', 'накладн|^^ттн$$|торг-?12',
  [['товарная\\s+накладная|торг-?12', 9], ['транспортная\\s+накладная|^^ттн$$', 8], ['накладная', 3]],
  { numbered: true, sub: 'товарная\\s+накладная|транспортная\\s+накладная' });
defType('receipt', 'Чек', 'чек|квитанци|receipt',
  [['кассовый\\s+чек', 9], ['фискальн|^^ккт$$|^^фн$$|^^фпд$$|^^фд$$', 3], ['квитанци', 6], ['^^чек$$', 3], ['^^receipt$$', 5]],
  { sub: 'кассовый\\s+чек|квитанци[яи](?:\\s+об\\s+оплате)?|^^чек$$' });
defType('payment', 'Платёжное поручение', 'плат[её]жн',
  [['плат[её]жное\\s+поручение', 9], ['плательщик', 2], ['получатель', 1]], { numbered: true });
defType('certificate', 'Справка', 'справк',
  [['справка', 6], ['дана\\s+(?:настоящая|в\\s+том)', 5], ['2-?ндфл', 5], ['выдана', 1]],
  { numbered: true, person: true, sub: 'справка\\s+(?:о|об|с)\\s+[а-яё]{3,}(?:\\s+[а-яё]{4,})?' });
defType('application', 'Заявление', 'заявлени',
  [['заявление', 7], ['прошу\\s+(?:вас\\s+)?(?:принять|предоставить|выдать|считать|разрешить|рассмотреть)', 5]],
  { person: true, orgs: false, sub: 'заявление\\s+(?:о|об|на)\\s+[а-яё]{3,}(?:\\s+[а-яё]{4,})?' });
defType('order', 'Приказ', 'приказ|распоряжен',
  [['приказ', 5], ['приказываю', 6], ['распоряжение', 5]],
  { numbered: true, sub: 'приказ\\s+(?:о|об)\\s+[а-яё]{3,}(?:\\s+[а-яё]{4,})?' });
defType('minutes', 'Протокол', 'протокол',
  [['протокол', 6], ['повестка\\s+дня', 4], ['слушали|постановили|решили', 3]], { numbered: true });
defType('claim', 'Претензия', 'претензи', [['претензи', 7], ['требу(?:ю|ем)', 2]], { numbered: true });
defType('letter', 'Письмо', 'письм|уведомлени',
  [['с\\s+уважением', 3], ['уважаем[а-яё]*', 2], ['^^исх$$\\.?\\s*(?:№|no)', 3], ['уведомля(?:ем|ю)|уведомление', 4], ['письмо', 3]], { numbered: true });
defType('poa', 'Доверенность', 'доверенност', [['доверенность', 8], ['доверяю', 5]], { numbered: true, person: true });
defType('resume', 'Резюме', 'резюме|^^cv$$|resume',
  [['резюме', 8], ['опыт\\s+работы', 4], ['образование', 2], ['(?:ключевые\\s+)?навыки', 2], ['curriculum\\s+vitae|^^resume$$|^^cv$$', 6], ['work\\s+experience|^^skills$$|^^education$$', 2]],
  { person: true, orgs: false });
defType('offer', 'Коммерческое предложение', 'предложени|смет|прайс',
  [['коммерческое\\s+предложение', 8], ['^^смета$$', 6], ['прайс-?лист', 6], ['^^кп$$', 2]],
  { sub: 'коммерческое\\s+предложение|смета(?:\\s+на\\s+[а-яё]{4,}(?:\\s+[а-яё]{4,})?)?|прайс-?лист' });
defType('statement', 'Выписка', 'выписк|statement',
  [['выписка', 7], ['остаток\\s+на\\s+(?:начало|конец)', 3], ['^^statement$$', 3]],
  { sub: 'выписка\\s+(?:из|по)\\s+[а-яё]{3,}(?:\\s+[а-яё]{4,})?' });
defType('instruction', 'Инструкция', 'инструкци|руководств|manual|guide',
  [['инструкци', 6], ['руководство\\s+(?:по|пользователя)', 6], ['^^manual$$|user\\s+guide', 5]], { orgs: false });
defType('regulation', 'Положение', 'положени|регламент|политик|правила|policy',
  [['^^положение$$', 5], ['регламент', 6], ['политика', 5], ['правила', 3], ['^^policy$$', 5]],
  { sub: '(?:положение|регламент|политика|правила)\\s+(?:о|об|по)\\s+[а-яё]{3,}(?:\\s+[а-яё]{4,})?' });
defType('report', 'Отчёт', 'отч[её]т|report|доклад|анализ',
  [['отч[её]т', 5], ['^^report$$', 4], ['^^доклад$$', 4], ['анализ', 2]],
  { sub: 'отч[её]т\\s+(?:о|об|по|за)\\s+[а-яё0-9]{2,}(?:\\s+[а-яё0-9]{3,})?' });
defType('diploma', 'Сертификат', 'сертификат|диплом|свидетельств|удостоверени|certificate',
  [['сертификат', 6], ['диплом', 6], ['свидетельство', 6], ['удостоверение', 6], ['^^certificate$$', 5]],
  { numbered: true, person: true, sub: '(?:сертификат|диплом|свидетельство|удостоверение)(?:\\s+(?:о|об|на)\\s+[а-яё]{3,}(?:\\s+[а-яё]{4,})?)?' });

const ANY_TYPE_STEM = new RegExp(DOC_TYPES.map(t => t.stem.source).join('|'), 'iu');
const STEM_AT_START = new RegExp('^(?:' + DOC_TYPES.map(t => t.stem.source).join('|') + ')', 'iu');

/* Тип документа по совокупности признаков во всём тексте */
function classifyDocument(text) {
  const head = text.slice(0, 500);
  const scored = DOC_TYPES.map(t => {
    let s = 0;
    for (const [re, w] of t.kw) {
      const all = (text.match(re) || []).length;
      const inHead = (head.match(re) || []).length;
      s += Math.min(all, 4) * w + Math.min(inHead, 3) * w * 1.5;
    }
    return { t, score: s };
  }).sort((a, b) => b.score - a.score);
  const best = scored[0], second = scored[1];
  if (!best || best.score < 9) return null;
  const confident = best.score >= 12 && best.score >= second.score * 1.4;
  return { t: best.t, score: best.score, confident };
}

function typeLabel(type, text) {
  if (type.t.sub) {
    const m = type.t.sub.exec(text.slice(0, 3000));
    if (m) return cap1(m[0].toLowerCase().replace(/\s+/g, ' ').trim());
  }
  return type.t.label;
}

/* № документа: ближе к слову-типу, иначе первый в начале */
function extractNumber(text, type) {
  const head = text.slice(0, 1200);
  const re = /(?:№|N[оo°]\.?|No\.?|#)\s*([\p{L}\d][\p{L}\d\-/._]{0,19})/giu;
  let m, first = '';
  while ((m = re.exec(head))) {
    const tok = m[1].replace(/[._\-/]+$/, '');
    if (!/\d/.test(tok)) continue;
    if (findDates(tok).length || /^\d{1,2}[./]\d{1,2}[./]\d{2,4}$/.test(tok)) continue;
    const ctx = head.slice(Math.max(0, m.index - 40), m.index);
    if (type.t.stem.test(ctx)) return tok.replace(/\//g, '-');
    if (!first) first = tok.replace(/\//g, '-');
  }
  return first;
}

/* Стороны: ООО «Ромашка», ИП Иванов, Acme LLC (до двух) */
function extractParties(text) {
  const head = text.slice(0, 3000), names = [], seen = new Set();
  const push = raw => {
    let n = String(raw).replace(/\s+/g, ' ').trim().replace(/[,;.]+$/, '');
    if (n.length < 2 || n.length > 40) return;
    n = fixCaps(n, true);
    const key = n.toLowerCase();
    if (!seen.has(key)) { seen.add(key); names.push(n); }
  };
  let m;
  const q = /(?:ООО|ЗАО|ПАО|ОАО|АО|НКО|МУП|ФГУП|ТСЖ|ИП|Общество\s+с\s+ограниченной\s+ответственностью|(?:Публичное\s+|Закрытое\s+|Открытое\s+)?[Аа]кционерное\s+общество|Индивидуальный\s+предприниматель)\s*[«"“]([^»"”\n]{2,40})[»"”]/g;
  while ((m = q.exec(head))) push(m[1]);
  const ip = /ИП[ \t]+([А-ЯЁ][а-яё]+(?:[ \t]+[А-ЯЁ][а-яё.]+){0,2})/g;     // только в пределах одной строки
  while ((m = ip.exec(head))) push(m[1]);
  const en = /([A-Z][A-Za-z0-9&.-]*(?:[ \t]+[A-Z][A-Za-z0-9&.-]*){0,2})[ \t]+(?:LLC|Ltd\.?|Inc\.?|GmbH|Corp\.?)/g;
  while ((m = en.exec(head))) push(m[1]);
  return names.slice(0, 2);
}

/* ФИО → «Фамилия Имя» */
function extractPerson(text) {
  const head = text.slice(0, 2500);
  const low = s => s.charAt(0) + s.slice(1).toLowerCase();
  // только именительный падеж (отчество оканчивается на -ович/-евна…): «Петрову Петру Петровичу» не берём
  let m = /([А-ЯЁ][а-яё]{2,})[ \t]+([А-ЯЁ][а-яё]{2,})[ \t]+[А-ЯЁ][а-яё]+(?:ович|евич|ьич|овна|евна|ична|инична|оглы|кызы)(?![а-яё])/.exec(head);
  if (m) return `${m[1]} ${m[2]}`;
  m = /([А-ЯЁ]{3,})[ \t]+([А-ЯЁ]{3,})[ \t]+[А-ЯЁ]+(?:ОВИЧ|ЕВИЧ|ЬИЧ|ОВНА|ЕВНА|ИЧНА|ИНИЧНА|ОГЛЫ|КЫЗЫ)(?![А-ЯЁ])/.exec(head);
  if (m) return `${low(m[1])} ${low(m[2])}`;
  return '';
}

/* ============================================================
   Заголовок: оценка строк начала текста (не бланк организации, не адрес, не «Утверждаю»)
   ============================================================ */
const LETTERHEAD = /^(?:ооо|зао|пао|оао|ао|нко|муп|фгуп|тсж|ип)(?=[\s«"“])/i;
const ADDRESS = /(?:^|[\s,(])(?:г\.|ул\.|пр-?т|д\.\s*\d|оф\.|тел\.?|факс|инн|кпп|огрн|р\/с|бик|индекс)(?=[\s:.,]|$)|\+7|@|www\.|(?:^|\s)\d{6}(?=[\s,])/i;
const ADDRESSEE = /^(?:утверждаю|утверждено|согласовано|приложение|генеральному|директору|руководителю|начальнику|кому|исх|вх|копия|в\s+(?:ооо|зао|пао|ао|администрацию|суд|налогов))/i;

/* Скобки и кавычки в названии должны быть парными: «… (ООО «Наш Двор» → «…» */
function balanceTitle(t) {
  for (const [o, cl] of [['(', ')'], ['«', '»'], ['[', ']']]) {
    const no = t.split(o).length - 1, nc = t.split(cl).length - 1;
    if (no > nc) t = t.slice(0, t.lastIndexOf(o));
    else if (nc > no) t = t.slice(t.indexOf(cl) + 1);
  }
  t = t.replace(/\s+г\.\s*[А-ЯЁ][\p{L}-]+$/u, '');                                       // «… № 15 г. Москва» → без места подписания
  return t.replace(/^[\s.,;:–—\-_)»\]]+|[\s.,;:–—\-_(«\[]+$/g, '').trim();
}
/* Похоже ли на название документа (а не на обрывок предложения) */
function isTitleLike(t) {
  const words = t.match(/\p{L}+/gu) || [];
  if (!words.length || words.length > 12 || !words.some(w => w.length >= 4)) return false;
  if (!/^[\p{Lu}\d«"“(№]/u.test(t)) return false;
  return (t.match(/,/g) || []).length <= 2;
}

/* Первое предложение длинной строки («Протокол осмотра помещения № 25. Осмотр проведён…» → «Протокол осмотра помещения № 25») */
function firstSentence(line) {
  const re = /\.\s+(?=[А-ЯЁA-Z])/g;
  let m;
  while ((m = re.exec(line))) {
    const before = line.slice(0, m.index), lastWord = before.split(/\s+/).pop();
    if (((lastWord.match(/\p{L}/gu) || []).length >= 3 || /^\d+$/.test(lastWord)) && before.length >= 8) return before;   // не «г.», «пом.» и т. п.
  }
  return line;
}

function pickHeading(text, meta, type) {
  const sc = scriptStats(text), cyrCtx = sc.cyr >= sc.lat;
  const lines = String(text).replace(/\r/g, '').split('\n').map(cleanLine)
    .map(l => stripDates(l).replace(/\s*(?:за\s+период|период|на\s+дату)\s*$/i, '').replace(/\s+г\.\s*[А-ЯЁ][\p{L}-]+\.?$/u, ''))   // без места подписания («… г. Москва»)
    .filter(l => l && !isJunkLine(l)).slice(0, 25);
  const cands = lines.map((line, i) => ({ line, i }));
  if (meta && meta.title) cands.unshift({ line: cleanLine(meta.title), i: -1, bonus: 3 });
  let best = null;
  for (const c of cands) {
    const line = c.line;
    let s = c.bonus || 0;
    const typeHit = ANY_TYPE_STEM.test(line);
    if (c.i === 0) s += 2; else if (c.i > 0 && c.i < 5) s += 1;
    if (typeHit) { s += 3; if (STEM_AT_START.test(line)) s += 2; }
    if (type && type.t.stem.test(line)) s += 2;
    if (!typeHit) {
      if (LETTERHEAD.test(line)) s -= 5;
      if (ADDRESS.test(line)) s -= 5;
    }
    if (ADDRESSEE.test(line) || /^от\s+[А-ЯЁ][а-яё]+/.test(line)) s -= 4;
    const digits = (line.match(/\d/g) || []).length;
    if (digits / line.length > 0.35) s -= 3;
    if (line.length > 80) s -= 2;
    if (line.length < 5) s -= 2;
    const toks = line.split(/\s+/);
    if (toks.filter(x => cleanOcrToken(x, 100, 0, cyrCtx)).length / toks.length < 0.7) s -= 6;   // много «не слов» — шум распознавания
    if (/^(?:\p{Ll}|[,;:)\]]|\d+\s*[,)])/u.test(line)) s -= 5;                                  // обрывок предложения или номер пункта «9)»
    if (/\.$/.test(line) && line.length > 50) s -= 3;
    const words = (line.match(/\p{L}+/gu) || []).length;
    if (!/\p{Ll}/u.test(line) && words <= 8 && (line.match(/\p{L}/gu) || []).length >= 4) s += 2;   // ЗАГЛАВНЫМИ
    if (!best || s > best.s) best = Object.assign({ s }, c);
  }
  if (!best || best.s < 1) return null;
  let snippet = (best.i >= 0 ? firstSentence(best.line) : best.line).replace(/\s+г\.\s*[А-ЯЁ][\p{L}-]+\.?$/u, '');
  const nx = best.i >= 0 ? lines[best.i + 1] : null;
  if (nx && isContinuation(nx) && (best.line.length <= 14 || isAllCaps(best.line)) && !ADDRESS.test(nx) && !LETTERHEAD.test(nx)) snippet += '\n' + nx;
  const title = balanceTitle(titleFromText(snippet));
  if (!title) return null;
  return { title, score: best.s, consistent: !!(type && type.t.stem.test(title)) };
}

/* ============================================================
   Итог: имя документа в целом
   ============================================================ */
/* ============================================================
   Смысл названия: проверяем, что заголовок осмыслен и относится к документу;
   если нет — анализируем содержание и формируем название сами (тип + главная тема).
   ============================================================ */
const STOP_RU = new Set(('и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между также либо который которая которое которые которых настоящий настоящего настоящему настоящим данный данного данной следующий именуемый именуемое именуемая именуемые стороны сторона стороной сторон является являются должен должны вправе обязан обязуется').split(' '));
const STOP_EN = new Set('the and for are was were with that this from have has had not but you your our their will shall may can into than then them these those which what when where who whom its been being also such any all each other more most some'.split(' '));
const BOILER_HEAD = /^(?:утверждаю|утверждено|согласовано|приложение|страница|стр\.|исх|вх|копия|экз|оригинал|рег\.?|к\s+договору|к\s+приказу|для\s+служебного|секретно)/i;

/* Основы значимых слов (грубое усечение окончаний — для сравнения «заголовок ↔ текст») */
function contentStems(s) {
  const ws = (String(s).toLowerCase().match(/\p{L}{4,}/gu) || []).filter(w => !STOP_RU.has(w) && !STOP_EN.has(w));
  return [...new Set(ws.map(w => w.slice(0, Math.max(4, w.length - 3))))];
}

/* Осмыслен ли заголовок. ok — убедительно (тип документа, разметка, пересечение с текстом) */
function headingSemantics(title, body, type, source) {
  const sc = scriptStats(body), cyrCtx = sc.cyr >= sc.lat;
  const toks = title.split(/\s+/);
  const plausible = toks.filter(t => cleanOcrToken(t, 100, 0, cyrCtx)).length / toks.length;
  if (plausible < 0.8) return { ok: false, valid: false, score: 0, reasons: ['много «не слов»'] };
  const typeHit = !!(type && type.t.stem.test(title));
  if (BOILER_HEAD.test(title) || LETTERHEAD.test(title) || (ADDRESS.test(title) && !typeHit)) return { ok: false, valid: false, score: 0, reasons: ['служебная строка, не заголовок'] };
  if (!isTitleLike(title)) return { ok: false, valid: false, score: 0, reasons: ['не похоже на название'] };
  const reasons = []; let score = 0;
  if (typeHit) { score += 3; reasons.push('соответствует типу документа'); }
  if (source === 'layout') { score += 2; reasons.push('заголовок по разметке страницы'); }
  const cs = contentStems(title);
  const bodyStems = new Set(contentStems(body.split(title).join(' ')));
  const ov = cs.length ? cs.filter(s => bodyStems.has(s)).length / cs.length : 0;
  if (ov >= 0.34) { score += 2; reasons.push('слова заголовка есть в тексте'); } else if (ov > 0) score += 1;
  if (cs.length >= 2) { score += 1; reasons.push('несколько значимых слов'); }
  return { ok: score >= 3, valid: true, score, reasons };
}

/* Главные темы документа: устойчивые сочетания значимых слов (в исходных формах — читаются как фрагмент текста) */
function topicPhrases(text) {
  const clauses = String(text).split(/[\n.,;:!?()«»"—–\[\]]+/);
  const stats = new Map();
  const total = Math.max(1, String(text).length);
  let pos = 0;
  for (const cl of clauses) {
    const at = pos; pos += cl.length + 1;
    const words = cl.split(/\s+/).filter(Boolean).map(w => w.toLowerCase().replace(/^-+|-+$/g, ''));
    const ok = w => /^\p{L}[\p{L}-]{2,}$/u.test(w) && !STOP_RU.has(w) && !STOP_EN.has(w) && w.length >= 3
                    && cleanOcrToken(w, 100, 0, scriptStats(w).cyr > 0);
    for (let i = 0; i < words.length; i++) {
      for (let n = 2; n <= 3 && i + n <= words.length; n++) {
        const g = words.slice(i, i + n);
        if (!g.every(ok) || !g.some(w => w.length >= 5)) break;
        const key = g.map(w => w.slice(0, Math.max(4, w.length - 3))).join(' ');      // «оборудования склада» ≈ «оборудование склада»
        const e = stats.get(key) || { phrase: g.join(' '), n: g.length, freq: 0, first: at / total, longs: g.filter(w => w.length >= 6).length };
        e.freq++; stats.set(key, e);
      }
    }
  }
  return [...stats.values()].map(e => ({ phrase: e.phrase, freq: e.freq, score: e.freq * (1 + 0.25 * e.n) + (e.first < 0.25 ? 0.5 : 0) + e.longs * 0.3 }))
    .filter(x => x.freq >= 2 || x.score >= 2.3).sort((a, b) => b.score - a.score);
}

function analyzeDocument(text, meta) {
  text = String(text || '').slice(0, DOC_TEXT_MAX);
  meta = meta || {};
  if ((text.match(/\p{L}/gu) || []).length < 5 && !meta.title && !(meta.headings && meta.headings.length)) return null;

  text = text.split('\n').map(normalizeSpacing).join('\n');           // «С у м м ы» → «Суммы»
  const type = classifyDocument(text);
  const head = pickHeading(text, meta, type);
  const dateInfo = pickDocDate(text, type && type.t.key);
  const number = type ? extractNumber(text, type) : '';

  // 1. Заголовок: кандидаты из разметки страницы / стилей документа и из строк начала текста; смысл проверяем
  const cands = [];
  for (const h of (meta.headings || [])) {
    const t = balanceTitle(titleFromText(stripDates(cleanLine(h))));
    if (t) cands.push({ title: t, source: 'layout' });
  }
  if (head) cands.push({ title: head.title, source: 'text' });
  let strong = null, medium = null, weak = null;
  for (const cnd of cands) {
    const sem = headingSemantics(cnd.title, text, type, cnd.source);
    const hit = { cnd, sem };
    if (sem.ok && (!strong || sem.score > strong.sem.score)) strong = hit;
    else if (sem.valid && sem.score >= 1 && (!medium || sem.score > medium.sem.score)) medium = hit;
    else if (sem.valid && !weak) weak = hit;
  }

  // 2. Собственный анализ содержания: тип документа и главная тема
  const topics = topicPhrases(text);
  const topic = topics.length ? topics[0] : null;

  let base = '', how = '', topicForType = '';
  if (strong) { base = strong.cnd.title; how = `смысл заголовка проверен: ${strong.sem.reasons.join(', ')}`; }
  else if (type && type.confident) {
    base = typeLabel(type, text);
    if (topic && !base.toLowerCase().includes(topic.phrase.split(' ')[0])) topicForType = topic.phrase;   // добавим, только если нет сторон/ФИО
    how = 'заголовок смыслом не подтверждён — название по анализу содержания';
  }
  else if (medium) { base = medium.cnd.title; how = 'заголовок связан с текстом (подтверждение частичное)'; }
  else if (topic && !type && topic.freq >= 2) { base = cap1(topic.phrase); how = 'тип не определён — название по главной теме текста'; }
  else if (weak) { base = weak.cnd.title; how = 'по заголовку (смысловое подтверждение слабое)'; }
  else return null;

  base = stripDates(base);
  if (!base) return null;
  const wc = s => (s.match(/\p{L}+/gu) || []).length;
  if (number && type && type.t.numbered && !/[№#]|\d/.test(base)) base += ' № ' + number;

  let extra = '';                                    // стороны / ФИО — только к коротким названиям
  if (type && wc(base) <= 4) {
    if (type.t.person) extra = extractPerson(text);
    if (!extra && type.t.orgs) extra = extractParties(text).join(', ');
    if (extra) base += ' — ' + extra;
  }
  if (topicForType && !extra) base += ' — ' + topicForType;          // тема — только когда сторон/ФИО найти не удалось

  let name = (dateInfo ? dateInfo.iso + ' ' : '') + base;
  name = name.replace(/\s+/g, ' ').trim();
  if (name.length > 100) {
    name = name.slice(0, 100);
    const sp = name.lastIndexOf(' ');
    if (sp > 40) name = name.slice(0, sp);
  }
  name = name.replace(/[\s.,;:–—\-_]+$/, '');
  if (!name) return null;

  const why = [type ? `Тип: ${type.t.label}${type.confident ? '' : ' (неуверенно)'}` : 'Тип не определён', how,
               dateInfo ? `дата ${dateInfo.iso} (${dateInfo.why})` : 'дата не найдена'].join(' · ');
  return { name, why, type: type ? type.t.key : null, date: dateInfo ? dateInfo.iso : null, number, heading: head ? head.title : '' };
}

/* ============================================================
   Получение текста файла и переименование результата
   ============================================================ */
async function openPdfQuiet(file) {          // PDF без запроса пароля (если нужен — тихо пропускаем)
  if (typeof pdfjsLib === 'undefined') return null;
  const task = pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false, stopAtErrors: false });
  task.onPassword = () => { try { task.destroy(); } catch (e) {} };
  try { return await task.promise; } catch (e) { return null; }
}

async function ocrTextFromCanvas(canvas, file) {
  if (!ocrEngineReady()) return '';
  const ocr = await ocrCanvas(canvas);
  if (ocr.canvas !== canvas) releaseCanvas(ocr.canvas);
  const nameText = ocr.titleText != null ? ocr.titleText : (ocr.text || '');
  file._docText = nameText;
  file._docHeadings = ocr.headings || [];
  return nameText;
}

/* Текст для анализа: из кэша конвертации или заново (дёшево; OCR — только первая страница скана) */
async function getDocText(file, ext) {
  if (file._docText && file._docText.trim().length >= 15) return { text: file._docText, meta: { headings: file._docHeadings || [] } };

  if (['txt', 'md', 'markdown'].includes(ext)) {
    // Крупный файл читаем не целиком, но с тем же откатом на cp1251 — иначе
    // русский txt в 1251 давал мусор и автоимя по содержимому не определялось.
    const text = file.size <= 2097152
      ? await readTextSmart(file)
      : await readTextSmart(file.slice(0, 262144));
    return { text: text.slice(0, DOC_TEXT_MAX), meta: {} };
  }

  if (ext === 'docx') {
    if (typeof JSZip === 'undefined') return null;
    const zip = await JSZip.loadAsync(file);
    const cf = zip.file('docProps/core.xml'), df = zip.file('word/document.xml');
    const meta = {};
    if (cf) {
      const m = /<dc:title[^>]*>([^<]+)<\/dc:title>/.exec(await cf.async('string'));
      if (m) { const t = titleFromText(decodeXmlText(m[1])); if (t && !GENERIC_TITLE.test(t)) meta.title = t; }
    }
    const dxml = df ? await df.async('string') : '';
    meta.headings = [];                                                   // заголовки по стилям абзацев: Title, Heading N, «Заголовок N»
    for (const p of dxml.split('</w:p>').slice(0, 80)) {
      if (!/<w:pStyle w:val="(?:Title|Heading\d|Заголовок\d?|Subtitle)"/i.test(p)) continue;
      const s = decodeXmlText((p.match(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>/g) || []).map(x => x.replace(/<[^>]+>/g, '')).join('')).trim();
      if (s) meta.headings.push(s);
    }
    return { text: docxXmlToText(dxml, DOC_TEXT_MAX), meta };
  }

  if (SHEET_EXTS.includes(ext)) {
    if (typeof XLSX === 'undefined') return null;
    const wb = ext === 'csv'
      ? XLSX.read(await readTextSmart(file), { type: 'string' })
      : XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const name = wb.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, blankrows: false });
    const text = rows.slice(0, 40).map(r => (r || []).map(x => String(x == null ? '' : x).trim()).filter(Boolean).join(' | ')).filter(Boolean).join('\n');
    const t = titleFromRows(rows, name);
    return { text, meta: t ? { title: t } : {} };
  }

  if (ext === 'pdf') {
    const pdf = await openPdfQuiet(file);
    if (!pdf) return null;
    try {
      let text = '';
      for (let p = 1; p <= Math.min(pdf.numPages, 3) && text.length < DOC_TEXT_MAX; p++) {
        const page = await pdf.getPage(p);
        text += '\n' + await extractPageText(page);
        page.cleanup();
      }
      if (isTextReadable(text) && text.replace(/\s/g, '').length >= 20) return { text: text.slice(0, DOC_TEXT_MAX), meta: {} };   // есть текстовый слой — OCR не нужен
      const canvas = await renderPageAdaptive(pdf, 1, 1800);            // скан: только первая страница
      try { return { text: await ocrTextFromCanvas(canvas, file), meta: { headings: file._docHeadings || [] } }; } finally { releaseCanvas(canvas); }
    } finally { try { pdf.destroy(); } catch (e) {} }
  }

  if (IMAGE_EXTS.includes(ext)) {
    const canvas = await loadImageToCanvas(file);
    try { return { text: await ocrTextFromCanvas(canvas, file), meta: { headings: file._docHeadings || [] } }; } finally { releaseCanvas(canvas); }
  }
  return null;
}

async function deriveName(file, ext) {
  try {
    const src = await getDocText(file, ext);
    return src ? analyzeDocument(src.text, src.meta) : null;
  } catch (e) {
    console.warn('Имя по содержимому не определено:', e && e.message || e);
    return null;
  }
}

/* Переименование результата по содержимому — только для файлов с автоматическим именем,
   получивших имя по шаблону. Если определить имя не удалось — остаётся имя по шаблону. */
async function renameByContent(i, item) {
  try {
    if (!renameFilesCheckbox.checked || item.namingMethod !== 'template') return;
    if (!item.result || !item.result.length || stopRequested) return;
    progressCurrentFile.textContent = `Анализ содержимого: ${item.file.name}`;
    const info = await deriveName(item.file, detectFileType(item.file));
    if (!info || !info.name || stopRequested) return;

    const taken = new Set(filesToProcess.filter((x, k) => k !== i).map(x => getBaseName(x.newName).toLowerCase()));
    const base = sanitizeFileName(info.name);
    let cand = base, n = 2;
    while (taken.has(cand.toLowerCase())) cand = `${base}_${n++}`;

    item.result = item.result.map(r => {
      const ext = getExtension(r.name) || item.targetExt;
      const m = /_стр(\d+)\.[^.]+$/.exec(r.name || '');
      return Object.assign({}, r, { name: `${cand}${m ? '_стр' + m[1] : ''}.${ext}` });
    });
    item.newName = `${cand}.${item.targetExt}`;
    item.namingMethod = 'content';

    const li = fileList.querySelector(`li[data-index="${i}"]`);
    if (li) {
      let el = li.querySelector('.file-new-name');
      if (!el) { el = document.createElement('div'); el.className = 'file-new-name'; li.querySelector('.file-name').after(el); }
      el.textContent = `✨ ${item.newName}`;
      el.classList.add('content');
      el.title = info.why;
    }
  } catch (e) {
    console.warn('renameByContent:', e);
  }
}

function applySmartNaming(file, targetExt, number) {
  const baseName = getBaseName(file.name);
  if (!renameFilesCheckbox.checked) return { name: sanitizeFileName(baseName) + '.' + targetExt, method: 'extension-only' };
  if (hasMeaningfulName(file.name)) return { name: sanitizeFileName(baseName) + '.' + targetExt, method: 'kept' };

  const template = (templateInput.value || '{дата}_{тип}_{номер}').trim();
  const now = new Date();                                           // местная дата (не UTC)
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const newName = template
    .replace(/{дата}/g, dateStr)
    .replace(/{номер}/g, String(number).padStart(3, '0'))
    .replace(/{тип}/g, targetExt.toUpperCase())
    .replace(/{приложение}/g, getBaseName(file.name));
  return { name: sanitizeFileName(newName) + '.' + targetExt, method: 'template' };
}

function uniqueName(name, taken) {
  if (!taken.has(name)) { taken.add(name); return name; }
  const base = getBaseName(name);
  const ext = getExtension(name) || '';
  const tail = ext ? '.' + ext : '';
  let i = 2, candidate;
  do { candidate = `${base}_${i}${tail}`; i++; } while (taken.has(candidate));
  taken.add(candidate);
  return candidate;
}

function getCurrentRules() {
  const checked = document.querySelector('input[name="targetFormat"]:checked');
  const key = checked ? checked.value : 'all-md';
  return formatRules[key] || formatRules['all-md'];
}

async function handleFiles(files, source) {
  if (isProcessing) { alert('Дождитесь окончания обработки'); return; }
  if (convertedFiles.length && !confirm('Добавление файлов сбросит готовые результаты. Продолжить?')) return;
  const seen = new Set();
  allFiles = Array.from(files || []).filter(f => {
    const k = `${f.webkitRelativePath || f.__relPath || ''}|${f.name}|${f.size}|${f.lastModified}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  if (source === 'folder') showFolderPreview(allFiles);   // панель «что внутри выбранной папки»
  await rebuildFileList();
}

async function rebuildFileList() {
  const seq = ++rebuildSeq;
  const rules = getCurrentRules();
  filesToProcess = [];
  convertedFiles = [];
  fileList.innerHTML = '';
  overallProgress.classList.remove('active');
  progressBarFill.style.width = '0%';
  progressPercent.textContent = '0%';
  progressDone.textContent = '0';
  progressTotal.textContent = '0';
  progressTitle.textContent = 'Ожидание...';
  progressCurrentFile.textContent = '';

  const taken = new Set();
  let ignored = 0;

  for (const file of allFiles) {
    let ext = detectFileType(file);
    if (!ext) { ext = await sniffExtension(file); file._sniffedExt = ext; if (seq !== rebuildSeq) return; }

    let action = null;
    if (rules.convert.includes(ext)) action = 'convert';
    else if (rules.copy.includes(ext)) action = 'copy';
    else if (rules.keepAsIs && rules.keepAsIs.includes(ext)) action = 'keep';

    if (!action) {
      addToList(file.name, '', 'ignored', 'Игнорируется', 'ignored', -1);
      ignored++;
      continue;
    }

    const finalExt = action === 'convert' ? rules.targetExt : ext;
    const naming = applySmartNaming(file, finalExt, filesToProcess.length + 1);
    naming.name = uniqueName(naming.name, taken);

    const index = filesToProcess.length;
    filesToProcess.push({
      file, action, targetExt: finalExt,
      newName: naming.name, namingMethod: naming.method,
      result: null, errorDetails: null, originalBlob: null, pdfInfo: null
    });

    let status = action === 'convert' ? `→ ${finalExt.toUpperCase()}`
      : action === 'copy' ? 'Копирование' : `Оставляется как ${ext.toUpperCase()}`;
    if (action === 'convert' && ext === 'pdf' && (finalExt === 'md' || finalExt === 'docx')) {
      status = `→ ${finalExt.toUpperCase()} (текст + OCR)`;
    }
    const cls = action === 'convert' ? 'converted' : action === 'copy' ? 'copied' : 'xls-keep';
    addToList(file.name, naming.name, naming.method, status, cls, index);
  }

  convertBtn.disabled = filesToProcess.length === 0;
  progressTotal.textContent = filesToProcess.length;
  if (allFiles.length) {
    progressTitle.textContent = `К обработке: ${filesToProcess.length}, пропущено: ${ignored}`;
  }
}

function addToList(originalName, newName, namingMethod, status, className, index) {
  const li = document.createElement('li');
  li.className = className;
  li.dataset.index = index;

  let newNameHtml = '';
  if (newName && (newName !== originalName || namingMethod === 'kept')) {
    newNameHtml = `<div class="file-new-name ${namingMethod === 'kept' ? 'kept' : ''}">${escapeHtml(newName)}</div>`;
  }
  const disabled = index < 0 ? 'disabled' : '';

  li.innerHTML = `
    <div class="file-row">
      <div class="file-info">
        <div class="file-name">${escapeHtml(originalName)}</div>
        ${newNameHtml}
        <div class="file-page-progress"></div>
        <div class="file-error-reason" style="display:none;"></div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end;">
        <span class="status-badge">${escapeHtml(status)}</span>
        <button class="download-btn main" data-index="${index}" title="Скачать результат" aria-label="Скачать результат" ${disabled}>💾</button>
        <button class="download-btn retry" data-index="${index}" data-retry="true" title="Повторить" aria-label="Повторить" ${disabled}>🔄</button>
        <button class="download-btn original" data-index="${index}" data-original="true" title="Скачать оригинал" aria-label="Скачать оригинал" ${disabled}>📄</button>
        <button class="download-btn details" data-index="${index}" data-details="true" title="Детали ошибки" aria-label="Детали ошибки" ${disabled}>🔍</button>
      </div>
    </div>
    <div class="file-progress-bar"><div class="file-progress-fill" style="width:0%"></div></div>`;
  fileList.appendChild(li);
  return li;
}

fileList.addEventListener('click', (e) => {
  const btn = e.target.closest('.download-btn');
  if (!btn || btn.disabled) return;
  const index = parseInt(btn.dataset.index, 10);
  if (Number.isNaN(index) || index < 0) return;
  if (btn.dataset.retry === 'true') retrySingleFile(index);
  else if (btn.dataset.original === 'true') downloadSingleFile(index, true);
  else if (btn.dataset.details === 'true') showErrorDetails(index);
  else downloadSingleFile(index, false);
});

/* errorReason — уже готовая HTML-строка; пользовательские данные
   должны быть заэкранированы ДО вызова (escapeHtml). */
function updateFileStatus(index, status, badgeText, errorReason, errorDetails) {
  const li = fileList.querySelector(`li[data-index="${index}"]`);
  if (!li) return;
  li.classList.remove('processing', 'ready', 'error', 'ocr-processing', 'fallback', 'ignored');
  li.classList.add(status);

  const badge = li.querySelector('.status-badge');
  if (badge && badgeText) badge.textContent = badgeText;

  const mainBtn = li.querySelector('.download-btn.main');
  if (mainBtn) mainBtn.classList.toggle('visible', status === 'ready' || status === 'fallback');

  const errorDiv = li.querySelector('.file-error-reason');
  if (errorDiv) {
    if (errorReason) { errorDiv.innerHTML = errorReason; errorDiv.style.display = 'block'; }
    else { errorDiv.innerHTML = ''; errorDiv.style.display = 'none'; }
  }

  const originalBtn = li.querySelector('.download-btn.original');
  const detailsBtn = li.querySelector('.download-btn.details');
  const retryBtn = li.querySelector('.download-btn.retry');
  const showAux = (status === 'error' || status === 'fallback');
  if (originalBtn) originalBtn.style.display = showAux ? 'inline-block' : 'none';
  if (retryBtn) retryBtn.style.display = status === 'error' ? 'inline-block' : 'none';
  if (detailsBtn) {
    if (status === 'error' && errorDetails) {
      detailsBtn.style.display = 'inline-block';
      if (filesToProcess[index]) filesToProcess[index].errorDetails = errorDetails;
    } else detailsBtn.style.display = 'none';
  }
}

/* Очищаем .file-page-progress, когда pageText пуст */
function updateFileProgress(index, percent, pageText) {
  const li = fileList.querySelector(`li[data-index="${index}"]`);
  if (!li) return;
  const bar = li.querySelector('.file-progress-bar');
  const fill = li.querySelector('.file-progress-fill');
  if (bar) bar.classList.add('active');
  if (fill) fill.style.width = clamp(percent, 0, 100).toFixed(1) + '%';

  const pageDiv = li.querySelector('.file-page-progress');
  if (pageDiv) {
    if (pageText) {
      pageDiv.textContent = pageText;
      pageDiv.classList.add('active');
    } else {
      pageDiv.textContent = '';
      pageDiv.classList.remove('active');
    }
  }
}

function setOverallProgress(done, total, title, current) {
  if (title) progressTitle.textContent = title;
  if (current !== undefined) progressCurrentFile.textContent = current;
  progressDone.textContent = done;
  progressTotal.textContent = total;
  const percent = total ? Math.round((done / total) * 100) : 0;
  progressPercent.textContent = percent + '%';
  progressBarFill.style.width = percent + '%';
}

function diagnoseError(error, file, attempts = []) {
  const msg = (error && error.message) || String(error);
  const name = (error && error.name) || '';
  let type = 'unknown', title = '❗ Ошибка', recommendation = 'Попробуйте нажать «🔄» для повтора.';

  if (error && error.ocrUnavailable) {
    type = 'ocr'; title = '🔌 Нет движка распознавания (Indra)';
    recommendation = msg;
  } else if (/password|парол/i.test(msg) || name === 'PasswordException') {
    type = 'encrypted'; title = '🔒 Файл защищён паролем';
    recommendation = 'Снимите защиту в Adobe Acrobat.';
  } else if (/InvalidPDF|не является PDF/i.test(msg)) {
    type = 'corrupted'; title = '💔 Файл повреждён';
    recommendation = 'Пересохраните PDF в Adobe Acrobat.';
  } else if (/memory|RangeError/i.test(msg) || name === 'RangeError') {
    type = 'memory'; title = '💾 Не хватает памяти';
    recommendation = 'Файл слишком большой: разделите его.';
  } else if (/timeout/i.test(msg)) {
    type = 'timeout'; title = '⏱️ Превышено время';
    recommendation = 'Повторите обработку.';
  } else if (/не загружена|CDN|Failed to fetch/i.test(msg)) {
    type = 'network'; title = '🌐 Библиотека не загрузилась';
    recommendation = 'Проверьте интернет и перезагрузите страницу.';
  } else if (/^Не поддерживается:\s*(неизвестный тип|[^\s→]+\s*→\s*\S+)/i.test(msg)) {
    type = 'unsupported'; title = '🚫 Формат не поддерживается';
    recommendation = 'Пересохраните файл в поддерживаемом формате (docx, pdf, txt, md, xls/xlsx, изображение).';
  }

  const item = filesToProcess.find(f => f.file === file);
  return {
    type, title, recommendation, attempts,
    message: msg.substring(0, 300),
    fileSize: file ? file.size : null,
    pages: item?.pdfInfo?.pages,
    hasText: item?.pdfInfo?.hasText,
    hasImages: item?.pdfInfo?.hasImages,
    technicalError: `${name}: ${msg}`
  };
}

function showErrorDetails(index) {
  const item = filesToProcess[index];
  if (!item || !item.errorDetails) { alert('Детали недоступны'); return; }
  const d = item.errorDetails;

  const attemptsText = (d.attempts || [])
    .map((a, i) => `${i + 1}. ${a.method}: ${a.success ? '✓ успех' : '✗ ' + (a.error || 'ошибка')}`)
    .join('\n') || '  (нет данных)';

  const text =
`ДЕТАЛИ ОШИБКИ: ${item.file.name}
═══════════════════════════════════
📋 Тип: ${d.type}
📌 ${d.title}
💬 Сообщение: ${d.message}

🔧 Попытки обработки:
${attemptsText}

📊 Информация о файле:
• Размер: ${formatBytes(d.fileSize)}
• Страниц: ${d.pages ?? 'неизвестно'}
• Есть текст: ${d.hasText === true ? 'да' : d.hasText === false ? 'нет' : 'неизвестно'}
• Есть изображения: ${d.hasImages === true ? 'да' : d.hasImages === false ? 'нет' : 'неизвестно'}

💡 Рекомендация:
${d.recommendation}

🧪 Технически: ${d.technicalError}
═══════════════════════════════════`;

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `<h3 style="margin:0 0 12px">🔍 Детали ошибки</h3><pre></pre>
    <div style="display:flex;justify-content:flex-end;margin-top:14px">
      <button class="btn primary" type="button">Закрыть</button>
    </div>`;
  modal.querySelector('pre').textContent = text;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  modal.querySelector('button').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
}

async function loadImageToCanvas(source) {
  if (source instanceof HTMLCanvasElement) return source;
  let bitmap = null;
  try {
    if (typeof createImageBitmap === 'function' && (source instanceof Blob)) {
      bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' });
    }
  } catch (e) { bitmap = null; }

  if (!bitmap) {
    bitmap = await new Promise((resolve, reject) => {
      const img = new Image();
      const url = (typeof source === 'string') ? source : URL.createObjectURL(source);
      const cleanup = () => { if (url.startsWith('blob:')) URL.revokeObjectURL(url); };
      img.crossOrigin = 'anonymous';
      img.onload = () => { cleanup(); resolve(img); };
      img.onerror = () => { cleanup(); reject(new Error('Не удалось загрузить изображение')); };
      img.src = url;
    });
  }

  const w = bitmap.width || bitmap.naturalWidth;
  const h = bitmap.height || bitmap.naturalHeight;
  if (!w || !h) throw new Error('Изображение имеет нулевой размер');
  // Слишком крупные фото уменьшаем, а не отклоняем
  const k = (w * h > CONFIG.maxCanvasArea) ? Math.sqrt(CONFIG.maxCanvasArea / (w * h)) : 1;
  const cw = Math.max(1, Math.floor(w * k)), ch = Math.max(1, Math.floor(h * k));

  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(bitmap, 0, 0, cw, ch);
  if (bitmap.close) bitmap.close();
  return canvas;
}

/* ============================================================
   Качество распознавания: что считать надёжным текстом, а что — шумом.
   Рукописные вставки, штампы, фото и зернистость дают «мешанину» из случайных символов.
   Indra отдаёт уверенность для каждой строки — используем её вместе с проверкой «похоже ли на слово».
   ============================================================ */
const LAT_LIKE = { a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у', A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У' };
const NOISE_CHARS = /[¢£¥§©®¤¦¬°±µ¶¸¿¡~^|\\{}\[\]<>_`]/;
const RU_VOWELS = /[аеёиоуыэюяАЕЁИОУЫЭЮЯ]/, EN_VOWELS = /[aeiouyAEIOUY]/;
const KEEP_SHORT = new Set(['в', 'с', 'к', 'о', 'у', 'и', 'а', 'я', 'на', 'по', 'от', 'до', 'из', 'за', 'не', 'но', 'ни', 'об', 'во', 'со', 'ко', 'то', 'он', 'же', 'ли', 'бы', 'ст', 'ч', 'п', 'г', 'д', 'ул', 'пр', 'ООО'.toLowerCase()]);
/* Сочетания, невозможные в русских словах: «жы», «чя», «ъ» не перед е/ё/ю/я, «ь» после гласной, 6+ согласных подряд */
const RU_IMPOSSIBLE = /[жшчщ]ы|[чщ][яю]|ъ(?![еёюя])|(?:^|[^а-яё])ъ|[аеёиоуыэюяъь]ь|ъъ|[бвгджзклмнпрстфхцчшщ]{6,}/;
const EDGE_PUNCT = /^[\s.,;:!?()«»"'“”„‘’—–\-/]+|[\s.,;:!?()«»"'“”„‘’—–\-/]+$/g;

function scriptStats(s) {
  let cyr = 0, lat = 0;
  for (const ch of String(s)) { if (/[\u0400-\u04FF]/.test(ch)) cyr++; else if (/[A-Za-z]/.test(ch)) lat++; }
  return { cyr, lat };
}

/* Очищенное слово или '' (слово — шум). conf: 0–100, minConf: порог, cyrContext: текст в основном кириллический */
function cleanOcrToken(text, conf, minConf, cyrContext) {
  let t = String(text == null ? '' : text).trim();
  if (!t || conf < minConf || NOISE_CHARS.test(t)) return '';
  let core = t.replace(EDGE_PUNCT, '');
  const letters = (core.match(/\p{L}/gu) || []).length;
  if (!letters) return /\d/.test(core) ? t : (/^(?:№|—|–|-)$/.test(t) ? t : '');   // цифры оставляем, одинокая пунктуация — шум
  const st = scriptStats(core);
  if (st.cyr && st.lat) {                                    // смесь алфавитов в одном слове
    if (st.cyr < st.lat) return '';
    const fixed = core.replace(/[A-Za-z]/g, c => LAT_LIKE[c] || c);   // «Дoговop» → «Договор»
    if (/[A-Za-z]/.test(fixed)) return '';
    t = t.replace(core, fixed); core = fixed;
  }
  const isCyr = /[\u0400-\u04FF]/.test(core), isLat = /[A-Za-z]/.test(core);
  if (isLat && !isCyr && cyrContext && !(conf >= 85 && letters >= 3)) return '';     // латиница в русском тексте — почти всегда шум
  if (letters <= 2 && !/\d/.test(core) && !KEEP_SHORT.has(core.toLowerCase()) && conf < 85) return '';
  if (letters >= 5 && !(isCyr ? RU_VOWELS : EN_VOWELS).test(core)) return '';        // длинное слово без гласных
  if (/(.)\1{3,}/u.test(core)) return '';                                            // «ааааа», «-----»
  if (isCyr && letters >= 4 && RU_IMPOSSIBLE.test(core.toLowerCase())) return '';    // нарушает правила русской орфографии → ошибка распознавания
  return t;
}

/* ============================================================
   Распознавание текста: Indra (локальный движок univerter_server.py).
   ============================================================ */
function ocrUnavailable(kind, detail) {
  const msg = kind === 'server'
    ? 'Для распознавания нужен локальный движок: запустите «py univerter_server.py --open» (см. README).'
    : kind === 'indra'
      ? 'Indra не установлена: выполните «py install_indra.py», затем перезапустите univerter_server.py.'
      : `Indra недоступна: ${detail || 'неизвестная ошибка'}`;
  const e = new Error(msg);
  e.ocrUnavailable = true;
  return e;
}
function ocrEngineReady() { return typeof helperInfo !== 'undefined' && !!helperInfo && !!helperInfo.indra && helperInfo.indra_state !== 'error'; }

/* Агрессивная склейка слов: части слова соединяются даже если между ними большие пробелы.
   «С у м м ы» → «Суммы», «2 0 2 4» → «2024», а также короткие фрагменты разрядки. */
function normalizeSpacing(text) {
  const src = String(text == null ? '' : text).replace(/\u00A0/g, ' ').replace(/[\t\r\n]+/g, ' ').trim();
  if (!src) return '';

  const isLetter = t => /^\p{L}$/u.test(t);
  const isDigit = t => /^\d$/.test(t);
  const isShort = t => t.length <= 2 && /^[\p{L}\d]+$/u.test(t);

  /* В разрядке «С у м м ы  п р о п и с ь ю» одиночный пробел — внутри слова,
     двойной — между словами. Склейку делаем внутри куска, разрезанного по 2+ пробелам:
     иначе двойные пробелы схлопываются раньше и границы слов теряются. */
  const collapse = (part) => {
    const toks = part.split(' ').filter(Boolean);
    if (toks.length < 2) return toks.join(' ');
    const out = [];
    let i = 0;
    while (i < toks.length) {
      // Склеиваем последовательность одиночных букв или цифр (от 2 штук)
      if (isLetter(toks[i]) || isDigit(toks[i])) {
        const kind = isLetter(toks[i]) ? isLetter : isDigit;
        let j = i;
        while (j < toks.length && kind(toks[j])) j++;
        if (j - i >= 2) {
          out.push(toks.slice(i, j).join(''));
          i = j;
          continue;
        }
      }
      // Склеиваем 3+ коротких фрагмента подряд (разрядка)
      if (isShort(toks[i])) {
        let j = i, shortCount = 0;
        while (j < toks.length && isShort(toks[j])) { shortCount++; j++; }
        if (shortCount >= 3) {
          out.push(toks.slice(i, j).join(''));
          i = j;
          continue;
        }
      }
      out.push(toks[i]);
      i++;
    }
    return out.join(' ');
  };

  return src.split(/ {2,}/).map(collapse).filter(Boolean).join(' ');
}

/* Склеивает фрагменты одной строки по вертикальной координате, даже если между ними большой горизонтальный промежуток */
function mergeDistantLineParts(lines) {
  if (!lines || lines.length < 2) return lines || [];
  const sorted = [...lines].sort((a, b) => {
    if (!a.box || !b.box) return 0;
    const ay = (a.box[1] + a.box[3]) / 2, by = (b.box[1] + b.box[3]) / 2;
    if (Math.abs(ay - by) > 10) return ay - by;
    return a.box[0] - b.box[0];
  });
  const merged = [];
  let cur = null;
  for (const l of sorted) {
    if (!l.box || !l.text) { if (cur) { merged.push(cur); cur = null; } merged.push(l); continue; }
    const cy = (l.box[1] + l.box[3]) / 2;
    const h = Math.max(4, l.box[3] - l.box[1]);
    if (cur && Math.abs(cy - cur._cy) < Math.max(10, h * 0.7)) {
      cur.text = (cur.text + ' ' + l.text).replace(/ +/g, ' ').trim();
      cur.box[0] = Math.min(cur.box[0], l.box[0]);
      cur.box[1] = Math.min(cur.box[1], l.box[1]);
      cur.box[2] = Math.max(cur.box[2], l.box[2]);
      cur.box[3] = Math.max(cur.box[3], l.box[3]);
    } else {
      if (cur) merged.push(cur);
      cur = { ...l, text: String(l.text), box: [...l.box], _cy: cy };
    }
  }
  if (cur) merged.push(cur);
  return merged;
}

function base64ToBlob(b64, type) {
  const bin = atob(b64), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type });
}

/* Рамка строки → [x0, y0, x1, y1] (если пришло [x, y, ширина, высота] — пересчитываем) */
function normalizeBox(b) {
  if (!Array.isArray(b) || b.length < 4 || b.some(v => !Number.isFinite(v))) return null;
  let [x0, y0, x1, y1] = b;
  if (x1 <= x0 || y1 <= y0) { x1 = x0 + Math.abs(b[2]); y1 = y0 + Math.abs(b[3]); }
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
}

async function indraRecognize(canvas) {
  if (typeof helperInfo === 'undefined' || !helperInfo) throw ocrUnavailable('server');
  if (!helperInfo.indra) throw ocrUnavailable('indra');
  if (helperInfo.indra_state === 'error') throw ocrUnavailable('error', helperInfo.indra_error);
  const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
  const res = await rejectOnStop(fetchAbortable(`${helperInfo.url}/ocr`,
    { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob },
    CONFIG.ocrPageTimeout, 'Indra'));
  let j = null;
  try { j = await res.json(); } catch (e) { /* не JSON */ }
  if (!res.ok || !j || !j.ok) {
    if (j && j.code === 'indra_missing') throw ocrUnavailable('indra');
    throw new Error((j && j.error) || `Indra: HTTP ${res.status}`);
  }
  return j;
}

/* Разбор ответа Indra: строки с уверенностью и разметкой → очищенный текст, заголовки, слова для текстового слоя */
function formatIndraResult(res) {
  // Сначала склеиваем фрагменты одной строки, даже если между ними большой промежуток
  // Рамки приводим к [x0, y0, x1, y1] ДО склейки: mergeDistantLineParts считает
  // box[2] правым краем, поэтому для формата [x, y, ширина, высота] рамка ломалась.
  const preNormalized = (res.lines || [])
    .map(l => ({ box: normalizeBox(l.box), conf: l.conf, text: l.text }))
    .filter(l => l.box);
  const rawLines = mergeDistantLineParts(preNormalized);
  const lines = rawLines.map(l => ({ box: l.box, conf: Number(l.conf), text: normalizeSpacing(l.text) }))
    .filter(l => l.text && l.box);
  for (const l of lines) if (!Number.isFinite(l.conf)) l.conf = 100;

  let cyrN = 0, latN = 0;                                             // алфавит документа — по уверенным строкам
  for (const l of lines) if (l.conf >= CONFIG.ocrLineMinConf) { const s = scriptStats(l.text); cyrN += s.cyr; latN += s.lat; }
  const cyrContext = cyrN > 0 && cyrN >= latN;

  const blocks = (res.blocks || []).map(b => ({ label: String(b.label || ''), box: normalizeBox(b.bbox) })).filter(b => b.box);
  const blockOf = l => {
    const cx = (l.box[0] + l.box[2]) / 2, cy = (l.box[1] + l.box[3]) / 2;
    let best = -1;
    blocks.forEach((b, i) => { if (cx >= b.box[0] && cx <= b.box[2] && cy >= b.box[1] && cy <= b.box[3]) best = i; });
    return best;
  };
  const cleanLine = (l, minConf) => {
    const toks = l.text.split(' ');
    const kept = toks.map(t => cleanOcrToken(t, l.conf, minConf, cyrContext)).filter(Boolean);
    const letters = kept.reduce((n, k) => n + (k.match(/\p{L}/gu) || []).length, 0);
    const digits = kept.reduce((n, k) => n + (k.match(/\d/g) || []).length, 0);
    if (!kept.length || letters + digits < 3 || kept.length / toks.length < 0.5) return null;   // строка в основном из шума
    return { text: kept.join(' '), n: kept.length, weight: letters + digits * 0.5 };
  };

  const items = lines.map(l => {
    const bi = blockOf(l);
    return { l, block: bi, label: bi >= 0 ? blocks[bi].label : '', lo: cleanLine(l, CONFIG.ocrLineMinConf), hi: cleanLine(l, CONFIG.ocrTitleMinConf) };
  });

  let goodWords = 0, weight = 0, totalWords = 0, confSum = 0, confN = 0;
  for (const it of items) {
    totalWords += it.l.text.split(' ').length;
    if (it.lo) { goodWords += it.lo.n; weight += it.lo.weight; confSum += it.l.conf; confN++; }
  }
  const quality = { goodWords, totalWords, weight, avgConf: confN ? confSum / confN : 0,
                    useful: goodWords >= CONFIG.ocrUsefulMinWords && weight >= CONFIG.ocrUsefulMinLetters };

  const isHeader = label => /^(?:section-header|title)$/i.test(label);
  const isRunning = label => /^page-(?:header|footer)$/i.test(label);       // колонтитулы и номера страниц — не содержимое
  const assemble = (pick, marks) => {
    const out = []; let lastBlock = null;
    for (const it of items) {
      const t = it[pick] && it[pick].text;
      if (!t || isRunning(it.label)) continue;
      if (lastBlock !== null && it.block !== lastBlock) out.push('');
      lastBlock = it.block;
      out.push(marks && isHeader(it.label) ? '## ' + t : t);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  };

  const headings = [];                                                 // настоящие заголовки по разметке страницы
  let cur = null;
  for (const it of items) {
    if (isHeader(it.label) && it.hi) {
      if (cur && cur.block === it.block) cur.text += ' ' + it.hi.text; else { cur = { block: it.block, text: it.hi.text }; headings.push(cur); }
    }
  }

  const wordLines = [];                                                // слова для невидимого текстового слоя PDF
  for (const it of items) {
    if (!it.lo || isRunning(it.label)) continue;
    const toks = it.l.text.split(' '), [x0, y0, x1, y1] = it.l.box;
    const total = toks.reduce((n, t) => n + t.length + 1, 0) - 1 || 1;
    let off = 0; const row = [];
    for (const t of toks) {
      const a = x0 + (x1 - x0) * off / total, b = x0 + (x1 - x0) * (off + t.length) / total;
      off += t.length + 1;
      const c = cleanOcrToken(t, it.l.conf, CONFIG.ocrLineMinConf, cyrContext);
      if (c) row.push({ text: c, bbox: { x0: a, y0, x1: b, y1 } });
    }
    if (row.length) wordLines.push(row);
  }

  return { text: assemble('lo', true), titleText: assemble('hi', false), headings: headings.map(h => h.text), wordLines, quality };
}

/* Распознавание изображения: отправляем в Indra, получаем очищенный текст, заголовки, рамки; страница выпрямлена сервером */
async function ocrCanvas(sourceCanvas, onProgress) {
  throwIfStopped();
  const report = (p, m) => { if (onProgress) onProgress(p, m); };
  report(15, 'Отправка изображения в Indra...');
  const res = await indraRecognize(sourceCanvas);
  throwIfStopped();
  report(85, 'Анализ результата...');
  let display = sourceCanvas;
  if (res.aligned) display = await loadImageToCanvas(base64ToBlob(res.aligned, 'image/jpeg'));   // выпрямленная картинка: рамки лежат на ней
  try {
    const st = formatIndraResult(res);
    report(100, 'Готово');
    return { text: st.text, confidence: st.quality.avgConf, angle: res.rotation || 0,
             wordLines: st.wordLines, quality: st.quality, titleText: st.titleText, headings: st.headings,
             canvas: display, width: display.width, height: display.height };
  } catch (e) {
    if (display !== sourceCanvas) releaseCanvas(display);
    throw e;
  }
}



async function openPdfSafe(file) {
  requireLib(typeof pdfjsLib !== 'undefined', 'pdf.js');
  file._passwordCancelled = false;
  const buffer = await file.arrayBuffer();
  const head = new Uint8Array(buffer, 0, Math.min(1024, buffer.byteLength));
  let sig = '';
  for (let i = 0; i < head.length; i++) sig += String.fromCharCode(head[i]);
  if (!sig.includes('%PDF-')) throw new Error('InvalidPDF: сигнатура %PDF не найдена');

  const task = pdfjsLib.getDocument({
    data: buffer,
    stopAtErrors: false,
    isEvalSupported: false,
    cMapUrl: `${PDFJS_BASE}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_BASE}/standard_fonts/`,
    maxImageSize: 1024 * 1024 * 64
  });
  task.onPassword = (updatePassword, reason) => {
    const p = prompt(reason === 2 ? 'Неверный пароль:' : 'PDF защищён паролем:');
    if (p === null) {
      file._passwordCancelled = true;
      try { task.destroy(); } catch (e) {}
    } else updatePassword(p);
  };

  const pdf = await task.promise;
  const info = { pdf, pages: pdf.numPages, hasText: false, hasImages: false };
  try {
    const page = await pdf.getPage(1);
    try { info.hasText = (await extractPageText(page)).length > CONFIG.minPageTextChars; } catch (e) {}
    try {
      const ops = await page.getOperatorList();
      const O = pdfjsLib.OPS || {};
      const imageOps = [O.paintImageXObject, O.paintJpegXObject, O.paintInlineImageXObject,
                        O.paintImageXObjectRepeat, O.paintInlineImageXObjectGroup].filter(v => v !== undefined);
      info.hasImages = ops.fnArray.some(fn => imageOps.includes(fn));
    } catch (e) {}
    page.cleanup();
  } catch (e) { console.warn('Не удалось прочитать первую страницу:', e); }
  return info;
}

async function extractPageText(page) {
  const tc = await page.getTextContent();
  let out = '';
  for (const item of tc.items) {
    if (typeof item.str !== 'string') continue;
    out += item.str;
    out += item.hasEOL ? '\n' : ' ';
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

async function renderPageAdaptive(pdf, pageNum, targetMaxSize = CONFIG.renderTargetPx) {
  const page = await pdf.getPage(pageNum);
  try {
    const base = page.getViewport({ scale: 1 });
    const maxSide = Math.max(base.width, base.height) || 1;
    let scale = clamp(targetMaxSize / maxSide, 0.4, 4);
    let viewport = page.getViewport({ scale });

    const limit = Math.min(
      CONFIG.maxCanvasSide / Math.max(viewport.width, viewport.height),
      Math.sqrt(CONFIG.maxCanvasArea / (viewport.width * viewport.height))
    );
    if (limit < 1) { scale *= limit; viewport = page.getViewport({ scale }); }

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    try {
      await page.render({ canvasContext: ctx, viewport, background: '#ffffff' }).promise;
      return canvas;
    } catch (e) {                       // иначе полный бэкенг canvas ждёт GC (до ~50 МБ на страницу)
      releaseCanvas(canvas);
      throw e;
    }
  } finally { page.cleanup(); }
}

async function processPdfPageRobust(pdf, pageNum, index, total) {
  const attempts = [];
  const targets = [CONFIG.renderTargetPx, 1500, 1000];

  for (let k = 0; k < targets.length; k++) {
    throwIfStopped();
    let canvas = null;
    const label = `Рендер ${targets[k]}px + OCR (стр. ${pageNum})`;
    try {
      updateFileProgress(index, ((pageNum - 1) / total) * 100, `Стр. ${pageNum}/${total}: рендер...`);
      canvas = await renderPageAdaptive(pdf, pageNum, targets[k]);
      updateFileProgress(index, ((pageNum - 0.7) / total) * 100, `Стр. ${pageNum}/${total}: OCR...`);
      const ocr = await ocrCanvas(canvas);
      attempts.push({ method: label, success: true, confidence: ocr.confidence });
      if (ocr.canvas !== canvas) releaseCanvas(canvas);
      return { text: ocr.text, canvas: ocr.canvas, wordLines: ocr.wordLines, angle: ocr.angle, quality: ocr.quality, titleText: ocr.titleText, headings: ocr.headings, attempts };
    } catch (err) {
      if (canvas) releaseCanvas(canvas);
      attempts.push({ method: label, success: false, error: err.message });
      console.warn(`Попытка ${k + 1} не удалась для стр. ${pageNum}:`, err);
      if (stopRequested || (err && err.ocrUnavailable)) throw err;     // нет движка распознавания — повторы с другим разрешением бессмысленны
    }
  }

  try {
    throwIfStopped();
    const canvas = await renderPageAdaptive(pdf, pageNum, 2000);
    attempts.push({ method: `Только рендер (стр. ${pageNum})`, success: true });
    return { text: '', canvas, wordLines: [], angle: 0, attempts };
  } catch (err) {
    attempts.push({ method: `Только рендер (стр. ${pageNum})`, success: false, error: err.message });
  }
  return { text: '', canvas: null, wordLines: [], angle: 0, attempts };
}

/* ============================================================
   DOCX (Word OOXML)
   ============================================================ */
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOCX_SECT = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>';

async function createSimpleDocx(text) {
  requireLib(typeof JSZip !== 'undefined', 'JSZip');
  const paragraphs = String(text || '').replace(/\r\n?/g, '\n').split('\n').map(line => {
    if (!line.trim()) return '<w:p/>';
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const content = heading ? heading[2] : line;
    const size = heading ? Math.max(24, 40 - heading[1].length * 4) : 22;
    const bold = heading ? '<w:b/>' : '';
    return `<w:p><w:pPr><w:spacing w:after="80"/></w:pPr><w:r><w:rPr>${bold}<w:sz w:val="${size}"/></w:rPr>` +
           `<w:t xml:space="preserve">${xmlEscape(content)}</w:t></w:r></w:p>`;
  }).join('');

  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}${DOCX_SECT}</w:body></w:document>`;

  // styles.xml не создаём — минимальный документ без стилей.
  // При добавлении /word/styles.xml в архив не забудьте прописать:
  //   <Override PartName="/word/styles.xml"
  //     ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  const ctXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

  const docRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

  const zip = new JSZip();
  zip.file('[Content_Types].xml', ctXml);
  zip.file('_rels/.rels', relsXml);
  zip.folder('word').file('document.xml', docXml);
  zip.folder('word').folder('_rels').file('document.xml.rels', docRelsXml);
  return zip.generateAsync({ type: 'blob', mimeType: DOCX_MIME, compression: 'DEFLATE' });
}

async function createDocxFromImages(images, baseName) {
  requireLib(typeof JSZip !== 'undefined', 'JSZip');
  const zip = new JSZip();
  const media = zip.folder('word').folder('media');
  const files = [];

  for (const img of images) {
    if (!img || !img.blob) continue;
    const name = `image${files.length + 1}.${img.blob.type === 'image/jpeg' ? 'jpeg' : 'png'}`;
    media.file(name, await img.blob.arrayBuffer());
    files.push({ name, width: img.width || 1654, height: img.height || 2339 });
  }
  if (!files.length) throw new Error('Нет изображений для создания DOCX');

  const maxWPt = (11906 - 2268) / 20;
  const maxHPt = (16838 - 2268) / 20;
  let body = '';

  files.forEach((img, i) => {
    const ratio = Math.min(maxWPt / img.width, maxHPt / img.height);
    const cx = Math.max(1, Math.round(img.width * ratio * 12700));
    const cy = Math.max(1, Math.round(img.height * ratio * 12700));
    const id = i + 1;
    const pb = i > 0 ? '<w:pageBreakBefore/>' : '';
    body +=
      `<w:p><w:pPr>${pb}<w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:drawing>` +
      `<wp:inline distT="0" distB="0" distL="0" distR="0">` +
      `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
      `<wp:docPr id="${id}" name="Page ${id}"/>` +
      `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
      `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
      `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:nvPicPr><pic:cNvPr id="${id}" name="${img.name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="rIdImg${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
      `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
      `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  });

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
    `xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
    `<w:body>${body}${DOCX_SECT}</w:body></w:document>`;

  const imgRels = files.map((f, i) =>
    `<Relationship Id="rIdImg${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${f.name}"/>`).join('');

  const wordRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${imgRels}</Relationships>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>`;

  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', rootRels);
  zip.folder('word').file('document.xml', documentXml);
  zip.folder('word').file('styles.xml', stylesXml);
  zip.folder('word').folder('_rels').file('document.xml.rels', wordRels);
  return zip.generateAsync({ type: 'blob', mimeType: DOCX_MIME, compression: 'DEFLATE' });
}

function newJsPdf(opts) {
  requireLib(window.jspdf && window.jspdf.jsPDF, 'jsPDF');
  return new window.jspdf.jsPDF(Object.assign({ unit: 'pt', format: 'a4', compress: true }, opts || {}));
}

/* ============================================================
   Юникод-шрифт для PDF (безопасные чанки)
   ============================================================ */
const FONT_SOURCES = [
  'https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans.ttf',
  'https://cdn.jsdelivr.net/gh/googlefonts/roboto-2@main/src/hinted/Roboto-Regular.ttf',
  'https://cdn.jsdelivr.net/npm/pdfmake@0.2.10/build/fonts/Roboto/Roboto-Regular.ttf'
];
let unicodeFontPromise = null;
const DEFAULT_MEASURE_FAMILY = 'Arial, Helvetica, sans-serif';
let measureFamily = DEFAULT_MEASURE_FAMILY;

function getUnicodeFont() {
  if (unicodeFontPromise) return unicodeFontPromise;
  unicodeFontPromise = (async () => {
    for (const url of FONT_SOURCES) {
      try {
        const res = await withTimeout(fetch(url, { mode: 'cors' }), 8000, 'шрифт');
        if (!res.ok) continue;
        const bytes = new Uint8Array(await withTimeout(res.arrayBuffer(), 15000, 'шрифт'));
        if (bytes.length < 20000) continue;
        let bin = '';
        const CHUNK = 0x2000; // 8192 — безопасно для стека
        for (let i = 0; i < bytes.length; i += CHUNK) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        // Тот же шрифт подключаем к странице, чтобы измерять текст так же, как он будет в PDF
        try {
          const ff = new FontFace('UniverterMeasure', bytes.slice().buffer);
          await ff.load();
          document.fonts.add(ff);
          measureFamily = "'UniverterMeasure', " + DEFAULT_MEASURE_FAMILY;
        } catch (e) { console.warn('Шрифт для измерений не подключён:', e); }
        return { name: 'UniverterUnicode', file: 'univerter-unicode.ttf', base64: btoa(bin) };
      } catch (e) { console.warn('Шрифт не загружен:', url); }
    }
    const emb = getEmbeddedFontBase64();                // CDN недоступен — берём шрифт, встроенный в страницу
    if (emb) {
      try {
        const ff = new FontFace('UniverterMeasure', getEmbeddedFontBytes().slice().buffer);
        await ff.load();
        document.fonts.add(ff);
        measureFamily = "'UniverterMeasure', " + DEFAULT_MEASURE_FAMILY;
      } catch (e) { console.warn('Встроенный шрифт для измерений не подключён:', e); }
      return { name: 'UniverterUnicode', file: 'univerter-unicode.ttf', base64: emb };
    }
    console.warn('Юникод-шрифт недоступен — PDF с кириллицей будет отрисован растром.');
    unicodeFontPromise = null; // повторим попытку при следующем вызове
    return null;
  })();
  return unicodeFontPromise;
}

async function attachUnicodeFont(doc) {
  const font = await getUnicodeFont();
  if (!font) return null;
  try {
    doc.addFileToVFS(font.file, font.base64);
    doc.addFont(font.file, font.name, 'normal');
    doc.setFont(font.name, 'normal');
    return font.name;
  } catch (e) { console.warn('Не удалось подключить шрифт:', e); return null; }
}

/* ============================================================
   PDF со страницей-картинкой и НЕВИДИМЫМ текстовым слоем (поиск, выделение, копирование).
   Свой минимальный писатель: не зависит от jsPDF и от сети — шрифт (урезанный DejaVu Sans:
   латиница + кириллица) встроен в Univerter.html.
   ============================================================ */
/* PDF-WRITER:BEGIN */
function parseTtf(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numTables = dv.getUint16(4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    tables[String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3])] = { offset: dv.getUint32(o + 8), length: dv.getUint32(o + 12) };
  }
  const need = t => { if (!tables[t]) throw new Error('В шрифте нет таблицы ' + t); return tables[t]; };
  const head = need('head'), hhea = need('hhea'), maxp = need('maxp'), hmtx = need('hmtx'), cmap = need('cmap');
  const unitsPerEm = dv.getUint16(head.offset + 18);
  const bbox = [dv.getInt16(head.offset + 36), dv.getInt16(head.offset + 38), dv.getInt16(head.offset + 40), dv.getInt16(head.offset + 42)];
  const ascent = dv.getInt16(hhea.offset + 4), descent = dv.getInt16(hhea.offset + 6);
  const numHM = dv.getUint16(hhea.offset + 34);
  const numGlyphs = dv.getUint16(maxp.offset + 4);
  const advance = gid => dv.getUint16(hmtx.offset + Math.min(gid, numHM - 1) * 4);

  let sub = null;                                  // cmap формата 4 (BMP)
  const nSub = dv.getUint16(cmap.offset + 2);
  for (let i = 0; i < nSub; i++) {
    const rec = cmap.offset + 4 + i * 8;
    const plat = dv.getUint16(rec), enc = dv.getUint16(rec + 2), off = cmap.offset + dv.getUint32(rec + 4);
    if (dv.getUint16(off) === 4 && ((plat === 3 && enc === 1) || plat === 0)) { sub = off; break; }
  }
  if (sub === null) throw new Error('В шрифте нет cmap формата 4');
  const segX2 = dv.getUint16(sub + 6), segCount = segX2 / 2;
  const endO = sub + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, rangeO = deltaO + segX2;
  const map = new Map();
  for (let s = 0; s < segCount; s++) {
    const end = dv.getUint16(endO + s * 2), start = dv.getUint16(startO + s * 2);
    const delta = dv.getInt16(deltaO + s * 2), ro = dv.getUint16(rangeO + s * 2);
    for (let c = start; c <= end && c !== 0xFFFF; c++) {
      let gid;
      if (ro === 0) gid = (c + delta) & 0xFFFF;
      else { const g = dv.getUint16(rangeO + s * 2 + ro + (c - start) * 2); gid = g === 0 ? 0 : (g + delta) & 0xFFFF; }
      if (gid) map.set(c, gid);
    }
  }
  return { unitsPerEm, ascent, descent, bbox, numGlyphs, advance, gidOf: cp => map.get(cp) || 0 };
}

async function deflateBytes(u8) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const cs = new CompressionStream('deflate');
    const w = cs.writable.getWriter();
    w.write(u8); w.close();
    return new Uint8Array(await new Response(cs.readable).arrayBuffer());
  } catch (e) { return null; }
}

/* o: { jpeg:Uint8Array, imgW, imgH, pageW, pageH, box:{x,y,w,h} (pt, от верхнего левого угла),
        scale (pt на пиксель), lines:[{ y0, y1, words:[{ text, x0, x1 }] }] (px), fontBytes:Uint8Array }
   → { bytes:Uint8Array, layerWords, layerChars } */
async function buildSearchablePdf(o) {
  const enc = new TextEncoder();
  const num = v => String(+Number(v).toFixed(2));
  const hex4 = n => n.toString(16).padStart(4, '0');

  // ---- текстовый слой: каждое слово — отдельный невидимый фрагмент в своей позиции ----
  const font = o.fontBytes ? parseTtf(o.fontBytes) : null;
  const used = new Map();                               // gid -> unicode
  const ops = [];
  let layerWords = 0, layerChars = 0;
  if (font) {
    for (const ln of o.lines || []) {
      const hPt = (ln.y1 - ln.y0) * o.scale;
      if (hPt < 1) continue;
      const size = Math.max(1, Math.min(hPt * 0.9, 120));
      const baseline = o.pageH - (o.box.y + (ln.y1 - (ln.y1 - ln.y0) * 0.18) * o.scale);
      ln.words.forEach((wd, wi) => {
        const gids = []; let units = 0;
        for (const ch of String(wd.text).normalize('NFC')) {
          const cp = ch.codePointAt(0);
          if (cp > 0xFFFF) continue;
          const gid = font.gidOf(cp);
          if (!gid) continue;                           // символа нет в шрифте — пропускаем
          gids.push(gid); units += font.advance(gid);
          if (!used.has(gid)) used.set(gid, cp);
        }
        const targetPt = (wd.x1 - wd.x0) * o.scale;
        if (!gids.length || units <= 0 || targetPt < 0.5) return;
        const natural = units / font.unitsPerEm * size;
        const tz = Math.max(10, Math.min(targetPt / natural * 100, 800));   // растягиваем слово по его рамке
        if (wi < ln.words.length - 1) {                 // явный пробел после слова: фразы ищутся и копируются целиком
          const sp = font.gidOf(32);
          if (sp) { gids.push(sp); if (!used.has(sp)) used.set(sp, 32); }
        }
        const x = o.box.x + wd.x0 * o.scale;
        ops.push(`BT /F1 ${num(size)} Tf ${num(tz)} Tz 3 Tr 1 0 0 1 ${num(x)} ${num(baseline)} Tm <${gids.map(hex4).join('')}> Tj ET`);
        layerWords++; layerChars += gids.length;
      });
    }
  }
  const hasText = layerWords > 0;

  // ---- объекты ----
  const N = { catalog: 1, pages: 2, page: 3, img: 4, content: 5, type0: 6, cid: 7, desc: 8, tou: 9, ff: 10 };
  const total = hasText ? 10 : 5;
  const content = enc.encode(`q ${num(o.box.w)} 0 0 ${num(o.box.h)} ${num(o.box.x)} ${num(o.pageH - o.box.y - o.box.h)} cm /Im0 Do Q\n` + ops.join('\n') + '\n');

  const chunks = [], offsets = [];
  let pos = 0;
  const push = u8 => { chunks.push(u8); pos += u8.length; };
  const text = s => push(enc.encode(s));
  const obj = (n, dict) => { offsets[n] = pos; text(`${n} 0 obj\n${dict}\nendobj\n`); };
  const streamObj = (n, dict, data) => {
    offsets[n] = pos;
    text(`${n} 0 obj\n<< ${dict} /Length ${data.length} >>\nstream\n`);
    push(data); text('\nendstream\nendobj\n');
  };

  push(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34, 0x0A, 0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));   // %PDF-1.4 + бинарный маркер
  obj(N.catalog, `<< /Type /Catalog /Pages ${N.pages} 0 R >>`);
  obj(N.pages, `<< /Type /Pages /Kids [${N.page} 0 R] /Count 1 >>`);
  obj(N.page, `<< /Type /Page /Parent ${N.pages} 0 R /MediaBox [0 0 ${num(o.pageW)} ${num(o.pageH)}] /Resources << /XObject << /Im0 ${N.img} 0 R >>${hasText ? ` /Font << /F1 ${N.type0} 0 R >>` : ''} >> /Contents ${N.content} 0 R >>`);
  streamObj(N.img, `/Type /XObject /Subtype /Image /Width ${o.imgW} /Height ${o.imgH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, o.jpeg);
  streamObj(N.content, '', content);

  if (hasText) {
    const entries = [...used.entries()].sort((a, b) => a[0] - b[0]);
    const k = 1000 / font.unitsPerEm;
    const bb = font.bbox.map(v => Math.round(v * k));
    obj(N.type0, `<< /Type /Font /Subtype /Type0 /BaseFont /UniverterSans /Encoding /Identity-H /DescendantFonts [${N.cid} 0 R] /ToUnicode ${N.tou} 0 R >>`);
    obj(N.cid, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /UniverterSans /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${N.desc} 0 R /CIDToGIDMap /Identity /DW 600 /W [${entries.map(([g]) => `${g} [${Math.round(font.advance(g) * k)}]`).join(' ')}] >>`);
    obj(N.desc, `<< /Type /FontDescriptor /FontName /UniverterSans /Flags 4 /FontBBox [${bb.join(' ')}] /ItalicAngle 0 /Ascent ${Math.round(font.ascent * k)} /Descent ${Math.round(font.descent * k)} /CapHeight ${Math.round(font.ascent * k * 0.75)} /StemV 80 /FontFile2 ${N.ff} 0 R >>`);

    let cm = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n';
    for (let i = 0; i < entries.length; i += 100) {
      const part = entries.slice(i, i + 100);
      cm += `${part.length} beginbfchar\n${part.map(([g, u]) => `<${hex4(g)}> <${hex4(u)}>`).join('\n')}\nendbfchar\n`;
    }
    cm += 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n';
    streamObj(N.tou, '', enc.encode(cm));

    const packed = await deflateBytes(o.fontBytes);
    if (packed && packed.length < o.fontBytes.length) streamObj(N.ff, `/Length1 ${o.fontBytes.length} /Filter /FlateDecode`, packed);
    else streamObj(N.ff, `/Length1 ${o.fontBytes.length}`, o.fontBytes);
  }

  const xrefPos = pos;
  let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= total; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  text(xref + `trailer\n<< /Size ${total + 1} /Root ${N.catalog} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);

  const out = new Uint8Array(pos);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return { bytes: out, layerWords, layerChars };
}
/* PDF-WRITER:END */

/* ---- встроенный шрифт (Univerter.html, <script id="univerterFont">) ---- */
let embeddedFontBytes = null;
function getEmbeddedFontBase64() {
  const el = document.getElementById('univerterFont');
  return el ? (el.textContent || '').replace(/\s+/g, '') : '';
}
function getEmbeddedFontBytes() {
  if (embeddedFontBytes) return embeddedFontBytes;
  const b64 = getEmbeddedFontBase64();
  if (!b64) return null;
  const bin = atob(b64), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return (embeddedFontBytes = out);
}
async function getFontBytesForPdf() {
  const emb = getEmbeddedFontBytes();
  if (emb) return emb;
  const f = await getUnicodeFont();                          // запасной путь: шрифт с CDN
  if (f && f.base64) { const bin = atob(f.base64), out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  return null;
}

async function createSearchablePdf(canvas, ocrResult, baseName) {
  const w = canvas.width, h = canvas.height;
  if (!w || !h) throw new Error('Пустое изображение для PDF');
  const jpegBlob = await canvasToBlob(canvas, 'image/jpeg', CONFIG.jpegQuality);
  const jpeg = new Uint8Array(await jpegBlob.arrayBuffer());

  const landscape = w > h;
  const pageW = landscape ? 841.89 : 595.28, pageH = landscape ? 595.28 : 841.89;
  const margin = 34;                                          // ≈ 12 мм
  const scale = Math.min((pageW - margin * 2) / w, (pageH - margin * 2) / h);
  const box = { w: w * scale, h: h * scale };
  box.x = (pageW - box.w) / 2; box.y = (pageH - box.h) / 2;

  const lines = [];
  for (const line of (ocrResult && ocrResult.wordLines) || []) {
    const words = (Array.isArray(line) ? line : [line]).filter(x => x && x.bbox && x.text && String(x.text).trim());
    if (!words.length) continue;
    words.sort((a, b) => a.bbox.x0 - b.bbox.x0);
    lines.push({
      y0: Math.min(...words.map(x => x.bbox.y0)), y1: Math.max(...words.map(x => x.bbox.y1)),
      words: words.map(x => ({ text: String(x.text).trim(), x0: x.bbox.x0, x1: x.bbox.x1 }))
    });
  }
  const fontBytes = lines.length ? await getFontBytesForPdf() : null;
  if (lines.length && !fontBytes) throw new Error('Нет шрифта для текстового слоя');

  const res = await buildSearchablePdf({ jpeg, imgW: w, imgH: h, pageW, pageH, box, scale, lines, fontBytes });
  return { name: baseName + '.pdf', blob: new Blob([res.bytes], { type: 'application/pdf' }), textLayerLines: res.layerWords, textLayerChars: res.layerChars };
}

/* Проверка: действительно ли в готовом PDF есть извлекаемый текст (через pdf.js, если загружен) */
async function pdfTextChars(blob) {
  try {
    const pdf = await openPdfQuiet(new File([blob], 'check.pdf'));
    if (!pdf) return -1;
    try {
      const page = await pdf.getPage(1);
      const t = await extractPageText(page);
      page.cleanup();
      return t.replace(/\s/g, '').length;
    } finally { try { pdf.destroy(); } catch (e) {} }
  } catch (e) { return -1; }
}

async function createPdfWithTextLayer(source, ocrResult, baseName) {
  const canvas = (ocrResult && ocrResult.canvas) ? ocrResult.canvas : await loadImageToCanvas(source);
  const hasWords = !!(ocrResult && ocrResult.wordLines && ocrResult.wordLines.length);
  let firstError = '';
  try {
    const res = await createSearchablePdf(canvas, ocrResult, baseName);
    if (!hasWords || res.textLayerLines > 0) {
      const chars = res.textLayerLines > 0 ? await pdfTextChars(res.blob) : -1;      // -1: проверить нечем / не нужно
      if (chars !== 0) return res;
      firstError = 'текст в готовом PDF не извлекается';
      console.warn('Текстовый слой не извлекается — пробую запасной способ (jsPDF)');
    }
  } catch (e) {
    firstError = (e && e.message) || String(e);
    console.warn('Свой PDF-писатель не сработал, запасной способ (jsPDF):', firstError);
  }
  try {
    return await createPdfWithTextLayerJsPdf(source, ocrResult, baseName);
  } catch (e2) {
    throw new Error(`Не удалось создать PDF с текстовым слоем (${firstError || 'нет данных'}; запасной способ: ${(e2 && e2.message) || e2})`);
  }
}

/* Запасной способ (jsPDF): используется, только если свой писатель не сработал */
async function createPdfWithTextLayerJsPdf(source, ocrResult, baseName) {
  const canvas = (ocrResult && ocrResult.canvas) ? ocrResult.canvas : await loadImageToCanvas(source);
  const w = canvas.width, h = canvas.height;
  if (!w || !h) throw new Error('Пустое изображение для PDF');

  const landscape = w > h;
  const doc = newJsPdf({ orientation: landscape ? 'landscape' : 'portrait' });
  const pw = doc.internal.pageSize.getWidth();
  const ph = doc.internal.pageSize.getHeight();
  const margin = 12;
  const scale = Math.min((pw - margin * 2) / w, (ph - margin * 2) / h);
  const dw = w * scale, dh = h * scale;
  const ox = (pw - dw) / 2, oy = (ph - dh) / 2;

  doc.addImage(canvas.toDataURL('image/jpeg', CONFIG.jpegQuality), 'JPEG', ox, oy, dw, dh, undefined, 'FAST');

  const lines = (ocrResult && ocrResult.wordLines) || [];
  let added = 0;
  if (lines.length) {
    const fontName = await attachUnicodeFont(doc);
    for (const line of lines) {
      const words = (Array.isArray(line) ? line : [line]).filter(x => x && x.bbox && x.text);
      if (!words.length) continue;
      const text = words.map(x => x.text).join(' ').trim();
      if (!text) continue;
      if (!fontName && /[^\x20-\x7E]/.test(text)) continue;

      const x0 = Math.min(...words.map(x => x.bbox.x0));
      const x1 = Math.max(...words.map(x => x.bbox.x1));
      const y0 = Math.min(...words.map(x => x.bbox.y0));
      const y1 = Math.max(...words.map(x => x.bbox.y1));
      const fontSize = clamp((y1 - y0) * scale * 0.95, 1, 96);
      if (fontSize <= 1) continue;

      doc.setFontSize(fontSize);
      const options = { renderingMode: 'invisible', baseline: 'alphabetic' };
      try {
        const measured = doc.getTextWidth(text);
        const target = (x1 - x0) * scale;
        if (measured > 0 && text.length > 1)
          options.charSpace = clamp((target - measured) / (text.length - 1), -2, 2);
        doc.text(text, ox + x0 * scale, oy + y1 * scale, options);
        added++;
      } catch (e) {}
    }
  }
  return { name: baseName + '.pdf', blob: doc.output('blob'), textLayerLines: added };
}

/* ============================================================
   Рендер текста/таблиц в PDF
   ============================================================ */
function measureText(text, size, bold) {
  const c = measureText._c || (measureText._c = document.createElement('canvas'));
  const ctx = c.getContext('2d');
  // с кастомным шрифтом жирный рисуется имитацией (двойной проход), ширина почти не меняется
  const useBold = bold && measureFamily === DEFAULT_MEASURE_FAMILY;
  ctx.font = `${useBold ? 'bold ' : ''}${size}px ${measureFamily}`;
  return ctx.measureText(String(text)).width;
}

function wrapText(text, size, maxWidth, bold) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (measureText(test, size, bold) <= maxWidth) { line = test; continue; }
    if (line) { lines.push(line); line = ''; }
    if (measureText(word, size, bold) <= maxWidth) { line = word; continue; }
    // Слово шире строки: режем бинарным поиском по длине префикса. Посимвольное
    // накопление давало O(n²) вызовов measureText и вешало вкладку на длинных
    // токенах без пробелов (base64, URL).
    let rest = word;
    while (rest) {
      if (measureText(rest, size, bold) <= maxWidth) { line = rest; break; }
      let lo = 1, hi = rest.length;                    // наибольший влезающий префикс
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (measureText(rest.slice(0, mid), size, bold) <= maxWidth) lo = mid; else hi = mid - 1;
      }
      const take = Math.max(1, lo);
      lines.push(rest.slice(0, take));
      rest = rest.slice(take);
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function layoutTextPages(text, { landscape = false, fontSize = 11, margin = 40, title = '' } = {}) {
  const pw = landscape ? 841.89 : 595.28;
  const ph = landscape ? 595.28 : 841.89;
  const maxW = pw - margin * 2;
  const lineH = fontSize * 1.35;
  const pages = [];
  let ops = [], y = margin + fontSize;

  const pushPage = () => { pages.push(ops); ops = []; y = margin + fontSize; };
  const addLine = (str, size, bold) => {
    if (y > ph - margin) pushPage();
    ops.push({ type: 'text', text: str, x: margin, y, size, bold });
    y += size * 1.35;
  };

  if (title) { addLine(title, fontSize + 4, true); y += 6; }
  for (const paragraph of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (!paragraph.trim()) { y += lineH * 0.6; continue; }
    for (const l of wrapText(paragraph, fontSize, maxW, false)) addLine(l, fontSize, false);
  }
  if (ops.length || !pages.length) pages.push(ops);
  return pages;
}

/* Шапка таблицы повторяется на новых страницах */
function layoutTablePages(sheets, { landscape = true, margin = 28, fontSize = 8 } = {}) {
  const pw = landscape ? 841.89 : 595.28;
  const ph = landscape ? 595.28 : 841.89;
  const maxW = pw - margin * 2;
  const pad = 3, lineH = fontSize * 1.25;
  const pages = [];

  for (const sheet of sheets) {
    const rows = sheet.rows || [];
    const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);

    let ops = [], y = margin;
    let headerOps = [], headerHeight = 0;

    const pushPage = (withHeader) => {
      pages.push(ops);
      ops = [];
      y = margin;
      if (withHeader && headerOps.length) {
        for (const op of headerOps) ops.push({ ...op });
        y = margin + headerHeight;
      }
    };

    ops.push({ type: 'text', text: sheet.name, x: margin, y: y + 13, size: 13, bold: true });
    y += 22;
    if (!cols) { pushPage(false); continue; }

    // Ширины — по выборке строк: на таблице в десятки тысяч строк полный проход
    // (rows × cols вызовов measureText) подвешивал вкладку на минуты.
    const SAMPLE_LIMIT = 400;
    const step = Math.max(1, Math.ceil(rows.length / SAMPLE_LIMIT));
    const sampleRows = rows.length > SAMPLE_LIMIT ? rows.filter((_, i) => i === 0 || i % step === 0) : rows;
    const widths = [];
    for (let c = 0; c < cols; c++) {
      let w = 30;
      for (const row of sampleRows)
        w = Math.max(w, Math.min(measureText(String(row[c] ?? ''), fontSize, false) + pad * 2, 260));
      widths.push(w);
    }
    const totalW = widths.reduce((a, b) => a + b, 0);
    const k = totalW > maxW ? maxW / totalW : 1;
    let colW = widths.map(w => Math.max(24, w * k));
    const sumColW = colW.reduce((a, b) => a + b, 0);
    if (sumColW > maxW) colW = colW.map(w => w * (maxW / sumColW));   // пол 24 pt не должен выносить таблицу за поля

    if (rows.length) {
      const cellLines = [];
      let rowH = lineH + pad * 2;
      for (let c = 0; c < cols; c++) {
        const lines = wrapText(String(rows[0][c] ?? ''), fontSize, colW[c] - pad * 2, true);
        cellLines.push(lines);
        rowH = Math.max(rowH, lines.length * lineH + pad * 2);
      }
      let hx = margin, hy = margin;
      for (let c = 0; c < cols; c++) {
        headerOps.push({ type: 'rect', x: hx, y: hy, w: colW[c], h: rowH });
        cellLines[c].forEach((ln, i) => {
          headerOps.push({ type: 'text', text: ln, x: hx + pad, y: hy + pad + fontSize + i * lineH,
                           size: fontSize, bold: true });
        });
        hx += colW[c];
      }
      headerHeight = rowH;
    }

    for (let r = 0; r < rows.length; r++) {
      const cellLines = [];
      let rowH = lineH + pad * 2;
      for (let c = 0; c < cols; c++) {
        const lines = wrapText(String(rows[r][c] ?? ''), fontSize, colW[c] - pad * 2, r === 0);
        cellLines.push(lines);
        rowH = Math.max(rowH, lines.length * lineH + pad * 2);
      }
      if (y + rowH > ph - margin) {
        pushPage(r > 0);
      }
      let x = margin;
      for (let c = 0; c < cols; c++) {
        ops.push({ type: 'rect', x, y, w: colW[c], h: rowH });
        cellLines[c].forEach((ln, i) => {
          ops.push({ type: 'text', text: ln, x: x + pad, y: y + pad + fontSize + i * lineH,
                     size: fontSize, bold: r === 0 });
        });
        x += colW[c];
      }
      y += rowH;
    }
    pushPage(false);
  }
  return pages.length ? pages : [[]];
}

async function createPdfFromOps(pages, { landscape = false } = {}) {
  const doc = newJsPdf({ orientation: landscape ? 'landscape' : 'portrait' });
  const fontName = await attachUnicodeFont(doc);
  const pw = doc.internal.pageSize.getWidth();
  const ph = doc.internal.pageSize.getHeight();
  const list = pages.length ? pages : [[]];

  if (fontName) {
    list.forEach((ops, i) => {
      if (i) doc.addPage();
      for (const op of ops) {
        if (op.type === 'text') {
          doc.setFontSize(op.size); doc.text(op.text, op.x, op.y);
          if (op.bold) doc.text(op.text, op.x + 0.35, op.y); // имитация жирного
        }
        else if (op.type === 'rect') { doc.setDrawColor(170); doc.rect(op.x, op.y, op.w, op.h); }
      }
    });
  } else {
    const s = 2;
    list.forEach((ops, i) => {
      if (i) doc.addPage();
      const c = document.createElement('canvas');
      c.width = Math.round(pw * s); c.height = Math.round(ph * s);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.scale(s, s);
      ctx.strokeStyle = '#aaaaaa'; ctx.fillStyle = '#000000'; ctx.textBaseline = 'alphabetic';
      for (const op of ops) {
        if (op.type === 'text') { ctx.font = `${op.bold ? 'bold ' : ''}${op.size}px Arial, sans-serif`; ctx.fillText(op.text, op.x, op.y); }
        else if (op.type === 'rect') ctx.strokeRect(op.x, op.y, op.w, op.h);
      }
      doc.addImage(c.toDataURL('image/jpeg', 0.9), 'JPEG', 0, 0, pw, ph, undefined, 'FAST');
      releaseCanvas(c);
    });
  }
  return doc.output('blob');
}

/* ============================================================
   Превью содержимого выбранной папки (#folderPreview).
   Панель опциональна: без элемента в HTML всё работает как раньше.
   ============================================================ */
const FP_ROW_LIMIT = 200;                     // длинные списки не заваливаем: хвост — строкой «…и ещё N»

function folderPreviewPaths(f) {
  const rel = f.webkitRelativePath || f.__relPath || '';
  const i = rel.lastIndexOf('/');
  return { rel, dir: i >= 0 ? rel.slice(0, i) : '', root: rel.split('/')[0] || '' };
}

function hideFolderPreview() {
  const el = document.getElementById('folderPreview');
  if (el) { el.hidden = true; el.textContent = ''; }
}

function showFolderPreview(files) {
  const el = document.getElementById('folderPreview');
  if (!el) return;
  const items = (files || []).map(f => ({ f, ...folderPreviewPaths(f) })).filter(it => it.rel);
  if (!items.length) { hideFolderPreview(); return; }

  // Сводка по правилам текущего режима — только по расширению, без «сниффинга» содержимого:
  // точный вердикт по каждому файлу всё равно показывает очередь ниже.
  const rules = getCurrentRules();
  const buckets = { convert: 0, copy: 0, keep: 0, ignored: 0, unknown: 0 };
  let totalSize = 0;
  for (const it of items) {
    totalSize += it.f.size || 0;
    const ext = detectFileType(it.f);
    if (!ext) buckets.unknown++;
    else if (rules.convert.includes(ext)) buckets.convert++;
    else if (rules.copy.includes(ext)) buckets.copy++;
    else if (rules.keepAsIs && rules.keepAsIs.includes(ext)) buckets.keep++;
    else buckets.ignored++;
  }

  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.dir)) groups.set(it.dir, []);
    groups.get(it.dir).push(it);
  }

  el.textContent = '';                          // только DOM-API: имена файлов — недоверенные данные
  const roots = [...new Set(items.map(it => it.root))];
  const h = document.createElement('h4');
  h.textContent = (roots.length === 1 ? `Содержимое папки «${roots[0]}»` : `Содержимое папок (${roots.length})`) +
    ` — файлов: ${items.length}, ${formatBytes(totalSize)}`;
  el.appendChild(h);

  const summary = [`в конвертацию: ${buckets.convert}`, `копирование: ${buckets.copy}`];
  if (buckets.keep) summary.push(`без изменений: ${buckets.keep}`);
  if (buckets.ignored) summary.push(`не подходит: ${buckets.ignored}`);
  if (buckets.unknown) summary.push(`расширение проверится по содержимому: ${buckets.unknown}`);
  const s = document.createElement('div');
  s.className = 'fp-summary';
  s.textContent = summary.join(' · ');
  el.appendChild(s);

  let shown = 0, extra = 0;
  for (const dir of [...groups.keys()].sort()) {
    const g = document.createElement('div');
    const gt = document.createElement('div');
    gt.className = 'fp-group-title';
    gt.textContent = dir || 'в корне папки';
    g.appendChild(gt);
    for (const it of groups.get(dir)) {
      if (shown >= FP_ROW_LIMIT) { extra++; continue; }
      const row = document.createElement('div');
      row.className = 'fp-file';
      const name = document.createElement('span');
      name.textContent = it.rel;
      const size = document.createElement('span');
      size.className = 'fp-size';
      size.textContent = formatBytes(it.f.size || 0);
      row.append(name, size);
      g.appendChild(row);
      shown++;
    }
    el.appendChild(g);
  }
  if (extra) {
    const more = document.createElement('div');
    more.className = 'fp-more';
    more.textContent = `… и ещё ${extra} — полный список в очереди ниже`;
    el.appendChild(more);
  }
  el.hidden = false;
}

/* ============================================================
   Чтение папок / URL
   ============================================================ */
function readEntry(entry, files) {
  return new Promise((resolve) => {
    if (!entry) return resolve();
    if (entry.isFile) {
      entry.file(f => {
        // Брошенные мышью файлы теряют webkitRelativePath — сохраняем путь из entry.fullPath
        const p = (entry.fullPath || '').replace(/^\//, '');
        if (p.includes('/')) f.__relPath = p;
        files.push(f); resolve();
      }, err => { console.warn('Не удалось прочитать файл', entry.fullPath, err); resolve(); });
      return;
    }
    if (!entry.isDirectory) return resolve();
    const reader = entry.createReader();
    const collected = [];
    const readBatch = () => {
      reader.readEntries(async (batch) => {
        if (!batch.length) {
          for (const child of collected) await readEntry(child, files);
          return resolve();
        }
        collected.push(...batch);
        readBatch();
      }, err => { console.warn('Ошибка чтения папки', entry.fullPath, err); resolve(); });
    };
    readBatch();
  });
}

async function promptUrl() {
  const url = prompt('URL файла (сервер должен разрешать CORS):');
  if (!url) return;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const cd = res.headers.get('content-disposition') || '';
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
    let name = m ? decodeURIComponent(m[1]) : '';
    if (!name) {
      try { name = decodeURIComponent(new URL(url, location.href).pathname.split('/').pop() || ''); } catch (e) { name = ''; }
    }
    if (!name) name = 'download';
    if (!getExtension(name)) {
      const ext = getExtensionFromMime(res.headers.get('content-type') || blob.type);
      if (ext) name += '.' + ext;
    }
    const file = new File([blob], sanitizeFileName(name), { type: blob.type });
    await handleFiles(allFiles.concat([file]));
  } catch (err) {
    alert('Не удалось загрузить файл: ' + err.message + '\nВозможно, сервер запрещает CORS.');
  }
}

function clearAll() {
  if (isProcessing) { alert('Сначала остановите обработку'); return; }
  for (const item of filesToProcess) {
    try { item.pdfInfo?.pdf?.destroy(); } catch (e) {}
    item.pdfInfo = null; item.result = null; item.originalBlob = null;
  }
  allFiles = []; filesToProcess = []; convertedFiles = [];
  fileList.innerHTML = '';
  hideFolderPreview();
  fileInput.value = ''; folderInput.value = '';
  overallProgress.classList.remove('active');
  progressBarFill.style.width = '0%';
  convertBtn.disabled = true;
}

/* ============================================================
   Инициализация UI
   ============================================================ */
function selectMode(radio) {
  modeOptions.forEach(o => o.classList.toggle('active', o.querySelector('input').checked));
  const label = (formatRules[radio.value] && formatRules[radio.value].label) || radio.value;
  currentModeEl.innerHTML = `Выбран режим: <strong>${escapeHtml(label)}</strong>`;
  currentModeEl.classList.remove('flash'); void currentModeEl.offsetWidth; currentModeEl.classList.add('flash'); // мгновенная подсветка смены
  if (allFiles.length) rebuildFileList();
}

/* change — для клавиатуры; click — для мыши */
let prevModeRadio = document.querySelector('input[name="targetFormat"]:checked');
document.querySelectorAll('input[name="targetFormat"]').forEach(radio => {
  radio.addEventListener('change', () => {
    if (isProcessing) { if (prevModeRadio) prevModeRadio.checked = true; return; }
    if (convertedFiles.length && !confirm('Смена режима сбросит готовые результаты. Продолжить?')) {
      if (prevModeRadio) prevModeRadio.checked = true;
      return;
    }
    prevModeRadio = radio;
    selectMode(radio);
  });
});

/* Имена пересчитываются сразу при смене галочки «Умное переименование» или шаблона */
function refreshNames() {
  if (!allFiles.length || isProcessing) return true;
  if (convertedFiles.length && !confirm('Изменение имён сбросит готовые результаты. Продолжить?')) return false;
  rebuildFileList();
  return true;
}
renameFilesCheckbox.addEventListener('change', () => {
  if (!refreshNames()) renameFilesCheckbox.checked = !renameFilesCheckbox.checked;
});
templateInput.addEventListener('change', () => { refreshNames(); });

$('pickFileBtn').addEventListener('click', () => fileInput.click());
$('pickFolderBtn').addEventListener('click', () => folderInput.click());
$('urlBtn').addEventListener('click', promptUrl);
$('clearBtn').addEventListener('click', clearAll);
$('zipBtn').addEventListener('click', () => downloadZip());
$('separateBtn').addEventListener('click', () => downloadAllSeparate());
$('saveBtn').addEventListener('click', () => saveAll());
convertBtn.addEventListener('click', () => startConversion());
stopBtn.addEventListener('click', () => stopConversion());

/* Файловые input'ы добавляют, а не заменяют список */
fileInput.addEventListener('change', async (e) => {
  const list = Array.from(e.target.files || []);
  e.target.value = '';
  if (!list.length) return;
  await handleFiles(allFiles.concat(list));
});
folderInput.addEventListener('change', async (e) => {
  const list = Array.from(e.target.files || []);
  e.target.value = '';
  if (!list.length) return;
  await handleFiles(allFiles.concat(list), 'folder');
});

dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (isProcessing) { alert('Идёт обработка'); return; }
  const files = [];
  const items = e.dataTransfer.items;
  let folderDrop = false;
  if (items && items.length && items[0].webkitGetAsEntry) {
    const entries = [];
    for (const item of items) { const entry = item.webkitGetAsEntry(); if (entry) entries.push(entry); }
    folderDrop = entries.some(en => en.isDirectory);
    for (const entry of entries) await readEntry(entry, files);
  } else {
    for (const f of e.dataTransfer.files) files.push(f);
  }
  if (files.length) {
    await handleFiles(allFiles.concat(files), folderDrop ? 'folder' : undefined);
  } else if (items && items.length) {
    alert('Не удалось прочитать перетащенные файлы.\n' +
          'В Firefox папки не поддерживаются — используйте кнопку «Добавить папку».');
  }
});

window.addEventListener('beforeunload', (e) => {
  if (isProcessing) { e.preventDefault(); e.returnValue = ''; }
});

/* ============================================================
   Индикатор загрузки CDN-библиотек.
   Безопасно работает, если #libStatus в HTML отсутствует.
   ============================================================ */
(function watchLibs() {
  const el = document.getElementById('libStatus');
  if (!el) return;

  const required = {
    pdfjsLib: 'pdf.js',
    JSZip: 'JSZip',
    jspdf: 'jsPDF',
    mammoth: 'mammoth',
    TurndownService: 'Turndown',
    XLSX: 'SheetJS'
  };
  const started = Date.now();

  function tick() {
    const missing = Object.keys(required).filter(k => !window[k]);
    if (!missing.length) {
      el.style.color = 'var(--ok)';
      el.textContent = '✓ Все библиотеки загружены';
      return;
    }
    el.style.color = 'var(--warn)';
    el.textContent =
      `⏳ Загрузка библиотек (${missing.length}): ` +
      missing.map(k => required[k]).join(', ');
    if (Date.now() - started > 60000) {
      el.style.color = 'var(--err)';
      el.textContent = '❌ Часть библиотек не загрузилась. Проверьте интернет / VPN / блокировщик и перезагрузите страницу.';
      return;
    }
    setTimeout(tick, 300);
  }
  tick();
})();