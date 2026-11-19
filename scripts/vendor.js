// Копирует библиотеки из node_modules в src/vendor/, чтобы приложение работало без интернета.
const fs = require('fs');
const path = require('path');
const NM = path.join(__dirname, '..', 'node_modules');
const OUT = path.join(__dirname, '..', 'src', 'vendor');

// [куда положить, [возможные места в node_modules (берётся первое существующее)]]
const FILES = [
  ['pdf.min.js', ['pdfjs-dist/build/pdf.min.js']],
  ['pdf.worker.min.js', ['pdfjs-dist/build/pdf.worker.min.js']],
  ['mammoth.browser.min.js', ['mammoth/mammoth.browser.min.js']],
  ['turndown.min.js', ['turndown/lib/turndown.browser.umd.js', 'turndown/dist/turndown.js']],
  ['marked.min.js', ['marked/marked.min.js', 'marked/lib/marked.umd.js']],
  ['jszip.min.js', ['jszip/dist/jszip.min.js']],
  ['jspdf.umd.min.js', ['jspdf/dist/jspdf.umd.min.js']],
  ['html2canvas.min.js', ['html2canvas/dist/html2canvas.min.js']],
  ['tesseract/tesseract.min.js', ['tesseract.js/dist/tesseract.min.js']],
  ['tesseract/worker.min.js', ['tesseract.js/dist/worker.min.js']],
  ['tesseract/tesseract-core.wasm.js', ['tesseract.js-core/tesseract-core.wasm.js']],
  ['tesseract/tesseract-core-simd.wasm.js', ['tesseract.js-core/tesseract-core-simd.wasm.js']],
  ['ort/ort.min.js', ['onnxruntime-web/dist/ort.min.js']]
];
// необязательные соседние файлы (wasm-части движков)
const GLOBS = [
  ['tesseract', 'tesseract.js-core', /^tesseract-core.*\.wasm$/],
  ['ort', 'onnxruntime-web/dist', /^ort-wasm.*\.wasm$/]
];
// языковые данные: сначала лучшая «best_int», затем обычная
const LANGS = [['rus', ['4.0.0_best_int', '4.0.0']], ['eng', ['4.0.0_best_int', '4.0.0']]];

let bad = 0;
function copy(from, to) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
const kb = f => (fs.statSync(f).size / 1024).toFixed(0) + ' КБ';

for (const [name, cands] of FILES) {
  const src = cands.map(c => path.join(NM, c)).find(fs.existsSync);
  if (!src) { console.error('✗ НЕТ ФАЙЛА для ' + name + '. Искал: ' + cands.join(', ')); bad++; continue; }
  copy(src, path.join(OUT, name)); console.log('✓ ' + name.padEnd(40) + kb(path.join(OUT, name)));
}
for (const [sub, pkg, re] of GLOBS) {
  const dir = path.join(NM, pkg);
  if (!fs.existsSync(dir)) { console.error('✗ нет папки ' + pkg); bad++; continue; }
  const list = fs.readdirSync(dir).filter(f => re.test(f));
  if (!list.length) console.warn('! в ' + pkg + ' нет файлов ' + re + ' (возможно, wasm встроен в js)');
  for (const f of list) { copy(path.join(dir, f), path.join(OUT, sub, f)); console.log('✓ ' + (sub + '/' + f).padEnd(40) + kb(path.join(OUT, sub, f))); }
}
for (const [lang, vers] of LANGS) {
  let done = false;
  for (const v of vers) {
    const f = path.join(NM, '@tesseract.js-data', lang, v, lang + '.traineddata.gz');
    if (fs.existsSync(f)) { copy(f, path.join(OUT, 'tessdata', lang + '.traineddata.gz')); console.log('✓ ' + ('tessdata/' + lang + '.traineddata.gz').padEnd(40) + kb(f) + '  (' + v + ')'); done = true; break; }
  }
  if (!done) { console.error('✗ нет языковых данных ' + lang); bad++; }
}
if (bad) { console.error('\nНе хватает файлов: ' + bad + '. Выполните «npm install» и повторите.'); process.exit(1); }
console.log('\nВсе библиотеки скопированы в src/vendor');
