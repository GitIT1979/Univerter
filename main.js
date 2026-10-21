// Univerter — главный процесс Electron.
const { app, BrowserWindow, Menu, shell, session, dialog } = require('electron');
const path = require('path');
const { startServer } = require('./lib/server');

const PREFERRED_PORT = 47821;
let win = null, srv = null, origin = '';

// звуковой сигнал после конвертации должен играть без предварительного клика
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
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
  const { server, port } = await startServer(path.join(__dirname, 'src'), PREFERRED_PORT);
  srv = server; origin = `http://127.0.0.1:${port}`;

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

app.whenReady().then(createWindow).catch(err => {
  dialog.showErrorBox('Univerter не запустился', String(err && err.stack || err));
  app.quit();
});
app.on('window-all-closed', () => { if (srv) srv.close(); app.quit(); });
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
