'use strict';
/* ============================================================
   Univerter-config.js
   Константы и правила форматов.
   Загружается до Univerter-core.js (script defer).
   ============================================================ */

const PDFJS_VERSION = '3.11.174';
const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}`;

const CONFIG = {
  renderTargetPx: 3000,
  maxCanvasSide: 8192,
  maxCanvasArea: 16777216,
  minPageTextChars: 40,
  ocrInitTimeout: 240000,
  ocrPageTimeout: 180000,
  orientationDetect: true,
  orientationProbeSide: 1100,
  orientationProbeTimeout: 60000,
  orientationOkConfidence: 60,
  orientationMargin: 15,
  jpegQuality: 0.92,
  ocrLineMinConf: 45,        // строки с меньшей уверенностью Indra считаются шумом (шкала 0–100)
  ocrTitleMinConf: 65,       // для имени файла берём только уверенно распознанный текст
  ocrUsefulMinWords: 4,      // меньше надёжных слов — на картинке нет полезной информации
  ocrUsefulMinLetters: 20
};

const KNOWN_EXTENSIONS = new Set([
  'pdf', 'docx', 'txt', 'md', 'markdown', 'odt',
  'xls', 'xlsx', 'xlsm', 'csv', 'ods',
  'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico', 'heic', 'heif',
  'zip', 'rar', '7z', 'tar', 'gz', 'html', 'htm', 'xml', 'json'
]);

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'];
// TIFF/TIF не декодируются браузером — исключены из IMAGE_EXTS.
// В KNOWN_EXTENSIONS их тоже нет — файлы попадут в «Игнорируется»,
// а не в ошибку «Не удалось загрузить изображение».
const SHEET_EXTS = ['xls', 'xlsx', 'xlsm', 'csv', 'ods'];
const DOC_EXTS = ['docx'];

const formatRules = {
  'all-md':     { label: 'Все в MD',          convert: ['pdf', ...DOC_EXTS, 'txt', ...SHEET_EXTS, ...IMAGE_EXTS], copy: ['md', 'markdown'], keepAsIs: [], targetExt: 'md' },
  'all-pdf':    { label: 'Все в PDF',         convert: [...DOC_EXTS, 'txt', 'md', 'markdown', ...IMAGE_EXTS, ...SHEET_EXTS], copy: ['pdf'], keepAsIs: [], targetExt: 'pdf' },
  'all-docx':   { label: 'Все в DOCX',        convert: ['pdf', 'md', 'markdown', 'txt', ...IMAGE_EXTS], copy: DOC_EXTS, keepAsIs: SHEET_EXTS, targetExt: 'docx' },
  'pdf-md':     { label: 'PDF → MD',          convert: ['pdf'], copy: [], keepAsIs: [], targetExt: 'md' },
  'pdf-docx':   { label: 'PDF → DOCX',        convert: ['pdf'], copy: [], keepAsIs: [], targetExt: 'docx' },
  'pdf-image':  { label: 'PDF → Картинка',    convert: ['pdf'], copy: [], keepAsIs: [], targetExt: 'png' },
  'xls-pdf':    { label: 'XLS → PDF',         convert: SHEET_EXTS, copy: [], keepAsIs: [], targetExt: 'pdf' },
  'image-pdf':  { label: 'Картинка → PDF',    convert: IMAGE_EXTS, copy: [], keepAsIs: [], targetExt: 'pdf' },
  'docx-md':    { label: 'DOCX → MD',         convert: DOC_EXTS, copy: [], keepAsIs: [], targetExt: 'md' },
  'txt-md':     { label: 'TXT → MD',          convert: ['txt'], copy: [], keepAsIs: [], targetExt: 'md' },
  'image-md':   { label: 'Картинка → MD',     convert: IMAGE_EXTS, copy: [], keepAsIs: [], targetExt: 'md' },
  'image-docx': { label: 'Картинка → DOCX',   convert: IMAGE_EXTS, copy: [], keepAsIs: [], targetExt: 'docx' }
};

// Делаем доступными глобально (скрипты без type=module)
Object.assign(window, {
  PDFJS_VERSION, PDFJS_BASE, CONFIG,
  KNOWN_EXTENSIONS, IMAGE_EXTS, SHEET_EXTS, DOC_EXTS, formatRules
});
