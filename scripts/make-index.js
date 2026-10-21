// Делает src/index.html из исходного Univerter.html: библиотеки берутся из папки vendor/ (с запасным вариантом из интернета).
// Использование: node scripts/make-index.js Univerter.original.html src/index.html
const fs = require('fs');
const [,, inFile = 'Univerter.original.html', outFile = 'src/index.html'] = process.argv;
let s = fs.readFileSync(inFile, 'utf8');

const LIBS = [
  ['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', 'vendor/pdf.min.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js', 'vendor/mammoth.browser.min.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/turndown/7.1.2/turndown.min.js', 'vendor/turndown.min.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/marked/4.3.0/marked.min.js', 'vendor/marked.min.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', 'vendor/jszip.min.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js', 'vendor/jspdf.umd.min.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js', 'vendor/html2canvas.min.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/4.1.1/tesseract.min.js', 'vendor/tesseract/tesseract.min.js']
];
let n = 0;
for (const [cdn, local] of LIBS) {
  const tag = `<script src="${cdn}"></script>`;
  if (!s.includes(tag)) throw new Error('В исходном файле не найден тег: ' + tag);
  // если локальный файл не загрузился, подгружаем ту же библиотеку из интернета (document.write работает при разборе страницы)
  const fb = `&lt;script src=&quot;${cdn}&quot;&gt;&lt;/script&gt;`;
  s = s.replace(tag, `<script src="${local}" onerror="document.write('${fb}')"></script>`);
  n++;
}
// воркер pdf.js — из локальной копии
const W = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
if (!s.includes(W)) throw new Error('Не найден адрес воркера pdf.js');
s = s.split(W).join('vendor/pdf.worker.min.js');
// пути к OCR-движку и ONNX создаёт сервер (assets.js); он должен загрузиться раньше всех библиотек
const first = s.indexOf('<script src="vendor/pdf.min.js"');
s = s.slice(0, first) + '<script src="assets.js"></script>\n' + s.slice(first);
fs.mkdirSync(require('path').dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, s);
console.log(`Готово: ${outFile} (подключено библиотек: ${n})`);
