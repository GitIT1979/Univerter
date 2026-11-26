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
    const server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/Univerter.html';
      const filePath = path.join(root, urlPath);
      // защита от выхода за пределы root
      if (!filePath.startsWith(path.resolve(root))) {
        res.writeHead(403); res.end('Forbidden'); return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(data);
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
