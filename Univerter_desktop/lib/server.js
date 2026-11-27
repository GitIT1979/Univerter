// Минимальный статический сервер для Electron.
// Отдаёт файлы из папки src/ (Univerter.html + JS).
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function startServer(root, preferredPort) {
  return new Promise((resolve, reject) => {
    const ROOT = path.resolve(root);
    const server = http.createServer((req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' }); res.end('Method not allowed'); return;
      }
      let urlPath;
      try {
        urlPath = decodeURIComponent(req.url.split('?')[0]);
      } catch (e) {                                  // битый %-код иначе валит главный процесс Electron
        res.writeHead(400); res.end('Bad request'); return;
      }
      if (urlPath === '/') urlPath = '/Univerter.html';
      const filePath = path.resolve(ROOT, '.' + path.posix.normalize(urlPath));
      const rel = path.relative(ROOT, filePath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {   // выход за каталог src/
        res.writeHead(403); res.end('Forbidden'); return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : data);
      });
    });

    function tryListen(port) {
      server.listen(port, '127.0.0.1', () => resolve({ server, port }))
        .on('error', (e) => {
          if (e.code === 'EADDRINUSE' && port < preferredPort + 20) tryListen(port + 1);
          else reject(e);
        });
    }
    tryListen(preferredPort);
  });
}

module.exports = { startServer };
