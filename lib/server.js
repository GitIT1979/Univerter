// Локальный HTTP-сервер приложения: отдаёт папку src/ только на 127.0.0.1.
// Страница открывается по http://127.0.0.1:порт/, а не по file://, поэтому воркеры, WebAssembly и fetch работают как в обычном браузере.
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.gz': 'application/octet-stream', '.onnx': 'application/octet-stream', '.map': 'application/json'
};

function assetsScript(srcDir, port) {
  const base = `http://127.0.0.1:${port}/vendor/`;
  const A = {
    tess: {
      worker: base + 'tesseract/worker.min.js',
      core: base + 'tesseract/tesseract-core.wasm.js',
      coreSimd: base + 'tesseract/tesseract-core-simd.wasm.js',
      lang: base + 'tessdata'
    },
    ort: base + 'ort/'
  };
  // модель рукописного текста подключается, только если её скачали командой «npm run vendor:handwriting»
  if (fs.existsSync(path.join(srcDir, 'vendor', 'models', 'vocab.json'))) A.models = base + 'models/';
  return 'window.__ASSETS=' + JSON.stringify(A) + ';';
}

function startServer(srcDir, preferredPort) {
  const root = path.resolve(srcDir);
  let port = 0;
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      let p = decodeURIComponent(url.pathname);
      if (p === '/') p = '/index.html';
      if (p === '/assets.js') {
        res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' });
        return res.end(assetsScript(root, port));
      }
      const file = path.resolve(root, '.' + p);
      if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
      fs.stat(file, (e, st) => {
        if (e || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Content-Length': st.size, 'Cache-Control': 'no-cache'
        });
        fs.createReadStream(file).pipe(res);
      });
    } catch (e) { res.writeHead(400); res.end('Bad request'); }
  });
  return new Promise((resolve, reject) => {
    const listen = (pt, fallback) => {
      server.once('error', err => {
        if (fallback && err.code === 'EADDRINUSE') listen(0, false); else reject(err);
      });
      server.listen(pt, '127.0.0.1', () => { port = server.address().port; resolve({ server, port }); });
    };
    // постоянный порт нужен, чтобы настройки (localStorage) сохранялись между запусками
    listen(preferredPort || 0, !!preferredPort);
  });
}

module.exports = { startServer, assetsScript, MIME };
