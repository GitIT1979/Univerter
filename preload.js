// Преднастройка окна: страница изолирована, ей доступны только сведения о платформе.
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('univerterDesktop', { platform: process.platform, versions: { electron: process.versions.electron, chrome: process.versions.chrome } });
