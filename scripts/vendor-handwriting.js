// Необязательно: скачивает модель распознавания рукописного текста (около 400 МБ) для работы без интернета.
// После этого сервер приложения сам подключит её из src/vendor/models/.
const fs = require('fs');
const path = require('path');
const https = require('https');
const BASE = 'https://huggingface.co/Mievst/trocr-base-handwritten-ru-ONNX/resolve/main/';
const FILES = ['onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_quantized.onnx', 'vocab.json'];
const OUT = path.join(__dirname, '..', 'src', 'vendor', 'models');

function get(url, dest, redirects = 6) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'univerter-vendor' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects) {
        res.resume(); return resolve(get(new URL(res.headers.location, url).href, dest, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' ' + url)); }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const total = +res.headers['content-length'] || 0; let got = 0, last = 0;
      const tmp = dest + '.part', out = fs.createWriteStream(tmp);
      res.on('data', c => { got += c.length; if (total && Date.now() - last > 1500) { last = Date.now(); process.stdout.write(`\r  ${path.basename(dest)}: ${(got / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} МБ   `); } });
      res.pipe(out);
      out.on('finish', () => { out.close(() => { fs.renameSync(tmp, dest); process.stdout.write('\n'); resolve(); }); });
      out.on('error', reject);
    }).on('error', reject);
  });
}
(async () => {
  for (const f of FILES) {
    const dest = path.join(OUT, f);
    if (fs.existsSync(dest)) { console.log('уже есть: ' + f); continue; }
    console.log('скачиваю ' + f); await get(BASE + f, dest);
  }
  console.log('Готово. При следующем запуске приложение будет читать рукопись без интернета.');
})().catch(e => { console.error('Ошибка: ' + e.message); process.exit(1); });
