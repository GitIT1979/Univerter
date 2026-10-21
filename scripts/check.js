// Проверка проекта перед сборкой: есть ли все файлы и корректна ли страница.
const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '..'); let bad = 0;
const must = ['main.js', 'preload.js', 'lib/server.js', 'src/index.html', 'build/icon.png',
  'src/vendor/pdf.min.js', 'src/vendor/pdf.worker.min.js', 'src/vendor/mammoth.browser.min.js', 'src/vendor/turndown.min.js', 'src/vendor/marked.min.js',
  'src/vendor/jszip.min.js', 'src/vendor/jspdf.umd.min.js', 'src/vendor/html2canvas.min.js',
  'src/vendor/tesseract/tesseract.min.js', 'src/vendor/tesseract/worker.min.js', 'src/vendor/tesseract/tesseract-core.wasm.js', 'src/vendor/tesseract/tesseract-core-simd.wasm.js',
  'src/vendor/tessdata/rus.traineddata.gz', 'src/vendor/tessdata/eng.traineddata.gz', 'src/vendor/ort/ort.min.js'];
for (const f of must) { const ok = fs.existsSync(path.join(root, f)); if (!ok) bad++; console.log((ok ? '✓ ' : '✗ ') + f); }
const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
if (/<script src="https:\/\/cdn/.test(html)) { console.log('✗ в index.html остались прямые ссылки на CDN (запустите npm run sync)'); bad++; }
process.exit(bad ? 1 : 0);
