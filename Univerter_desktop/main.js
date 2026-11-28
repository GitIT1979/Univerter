// Univerter — главный процесс Electron.
const { app, BrowserWindow, Menu, shell, session, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const { startServer } = require('./lib/server');

const PREFERRED_PORT = 47821;
const ENGINE_PORT = 8765;
let win = null, srv = null, origin = '', engineProc = null;

// звуковой сигнал после конвертации должен играть без предварительного клика
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
}

/* ============================================================
   Локальный движок (Python: Indra OCR + точный DOCX ↔ PDF).
   В упакованном приложении движок лежит в resources/engine (extraResources),
   в репозитории — в соседней папке ../Univerter_HTML (режим npm start).
   Приложение само поднимает движок, если на 127.0.0.1:8765 ещё никто не отвечает;
   запущенный нами процесс завершаем при выходе. Чужой (запущенный вручную) — не трогаем.
   Недостающие pip-пакеты движок ставит сам при первом запуске, веса Indra качает тоже сам.
   ============================================================ */
function engineScriptPath() {
  const bundled = path.join(process.resourcesPath || '', 'engine', 'server', 'univerter_server.py');
  if (fs.existsSync(bundled)) return bundled;
  const repo = path.join(__dirname, '..', 'Univerter_HTML', 'server', 'univerter_server.py');
  return fs.existsSync(repo) ? repo : null;
}

function engineAlive() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: ENGINE_PORT, path: '/health', timeout: 1500 }, (res) => {
      res.resume();                                          // тело не читаем — важен только статус
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/* Спрашиваем у py-лаунчера путь к настоящему python.exe. Это важно: py.exe порождает
   python.exe как ребёнка, и kill() по лаунчеру оставляет сервер-сироту на порту 8765. */
function resolvePython() {
  return new Promise((resolve) => {
    let q;
    try { q = spawn('py', ['-c', 'import sys; print(sys.executable)'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch (e) { return resolve(null); }
    let out = '', settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(to); resolve(r); } };
    const to = setTimeout(() => { try { q.kill(); } catch (e) {} done(null); }, 4000);
    q.stdout.on('data', (d) => { out += d; });
    q.once('error', () => done(null));
    q.once('exit', () => {
      const exe = out.trim().split(/\r?\n/).pop() || '';
      done(exe.toLowerCase().endsWith('.exe') ? exe : null);
    });
  });
}

/* outcome: 'running' — за 3 с не умер; 'exited' — интерпретатор есть, но движок завершился;
   'no-such-command' — интерпретатора нет (пробуем следующий). */
function trySpawnEngine(cmd, dir, log) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn(cmd, ['univerter_server.py'], { cwd: dir, stdio: ['ignore', log, log], windowsHide: true }); }
    catch (e) { return resolve({ outcome: 'no-such-command' }); }
    let settled = false;
    const to = setTimeout(() => { if (!settled) { settled = true; resolve({ p, outcome: 'running' }); } }, 3000);
    p.once('error', () => { if (!settled) { settled = true; clearTimeout(to); resolve({ outcome: 'no-such-command' }); } });
    p.once('exit', () => { if (!settled) { settled = true; clearTimeout(to); resolve({ outcome: 'exited' }); } });
  });
}

async function startEngineIfNeeded() {
  if (await engineAlive()) return;
  const script = engineScriptPath();
  if (!script) return;                                       // движка рядом нет — интерфейс работает без OCR
  const dir = path.dirname(script);
  const logPath = path.join(app.getPath('userData'), 'engine.log');
  try { const st = fs.statSync(logPath); if (st.size > 1024 * 1024) fs.writeFileSync(logPath, ''); } catch (e) {}
  try { fs.appendFileSync(logPath, `\n=== ${new Date().toISOString()} движок: ${script} ===\n`); } catch (e) {}
  let log;
  try { log = fs.openSync(logPath, 'a'); } catch (e) { log = 'ignore'; }
  const pyExe = await resolvePython();
  for (const cmd of [pyExe, 'python'].filter(Boolean)) {
    const { p, outcome } = await trySpawnEngine(cmd, dir, log);
    if (outcome === 'running') { engineProc = p; return; }
    if (outcome === 'exited') break;                         // интерпретатор есть, но движок упал — другой не поможет
  }
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const t = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'Файл', submenu: [isMac ? { role: 'close', label: 'Закрыть' } : { role: 'quit', label: 'Выход' }] },
    { label: 'Правка', submenu: [
      { role: 'undo', label: 'Отменить' }, { role: 'redo', label: 'Повторить' }, { type: 'separator' },
      { role: 'cut', label: 'Вырезать' }, { role: 'copy', label: 'Копировать' }, { role: 'paste', label: 'Вставить' }, { role: 'selectAll', label: 'Выделить всё' }] },
    { label: 'Вид', submenu: [
      { role: 'reload', label: 'Перезагрузить' }, { role: 'togglefullscreen', label: 'Во весь экран' }, { type: 'separator' },
      { role: 'zoomIn', label: 'Увеличить' }, { role: 'zoomOut', label: 'Уменьшить' }, { role: 'resetZoom', label: 'Масштаб 100%' }, { type: 'separator' },
      { role: 'toggleDevTools', label: 'Инструменты разработчика' }] },
    { label: 'Справка', submenu: [{
      label: 'О программе', click: () => dialog.showMessageBox(win, {
        type: 'info', title: 'Univerter', message: 'Univerter ' + app.getVersion(),
        detail: 'Универсальный конвертер документов. Работает без интернета: все библиотеки и языковые данные входят в комплект.'
      }) }] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(t));
}

async function createWindow() {
  if (!srv) {                                  // при повторном открытии окна на macOS сервер уже работает
    const started = await startServer(path.join(__dirname, 'src'), PREFERRED_PORT);
    srv = started.server; origin = `http://127.0.0.1:${started.port}`;
  }

  win = new BrowserWindow({
    width: 1280, height: 900, minWidth: 900, minHeight: 640, title: 'Univerter', backgroundColor: '#e8f7d4',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false,
      backgroundThrottling: false // конвертация не должна замедляться, когда окно свёрнуто
    }
  });

  // страница не должна уходить на другие адреса; внешние ссылки открываются в браузере системы
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(origin)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url) && !url.startsWith(origin)) shell.openExternal(url); return { action: 'deny' }; });

  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(['clipboard-read', 'clipboard-sanitized-write', 'fileSystem'].includes(permission));
  });
  // сохранение результата: стандартный диалог «Сохранить как…» показывает сама Электрон

  buildMenu();
  await win.loadURL(origin + '/');
  win.on('closed', () => { win = null; });
}

app.whenReady().then(async () => {
  startEngineIfNeeded().catch(() => {});       // окно открываем сразу; статус движка страница увидит при опросе /health
  await createWindow();
}).catch(err => {
  dialog.showErrorBox('Univerter не запустился', String(err && err.stack || err));
  app.quit();
});
app.on('window-all-closed', () => {
  // на macOS приложение принято оставлять в доке; сервер при этом продолжает работать
  if (process.platform !== 'darwin') { if (srv) srv.close(); app.quit(); }
});
app.on('will-quit', () => {
  if (!engineProc) return;                                   // чужой движок не трогаем — только свой
  try {
    if (process.platform === 'win32')                        // tree-kill: python и его дочерние (soffice и пр.)
      spawn('taskkill', ['/PID', String(engineProc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else engineProc.kill();
  } catch (e) {}
});
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
