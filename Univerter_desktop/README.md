# Univerter Desktop (Electron)

Настольная оболочка для Univerter. Интерфейс тот же, что в HTML-версии.  
**OCR выполняется только через Indra** (пакет `indra-ocr`).

---

## Как устроена интеграция с Indra

```
┌─────────────────────┐         ┌──────────────────────────┐
│   Electron          │         │   Python-сервер          │
│   (Univerter_desktop)│         │   (встроен в установщик) │
│                     │         │                          │
│  main.js            │         │  univerter_server.py     │
│    ├─ startEngine…  ├────────►│    ├─ /health            │
│    └─ lib/server.js │  spawn  │    ├─ /ocr  ← Indra      │
│       (порт 47821)  │         │    └─ /convert           │
│  BrowserWindow      │  HTTP   │                          │
│    └─ src/          │◄───────►│  Indra OCR               │
│       Univerter.html│  :8765  │  LibreOffice + pdf2docx  │
└─────────────────────┘         └──────────────────────────┘
```

1. **Electron** запускает свой статический сервер и открывает `Univerter.html` в окне.
2. Приложение проверяет `http://127.0.0.1:8765/health`: движок не отвечает — запускает его сами
   (в упакованном приложении — из `resources\engine`, в репозитории — из `../Univerter_HTML`).
3. Если Python-сервер запущен и Indra установлена, в интерфейсе появляется статус  
   **«OCR (Indra) ✓»**.
4. Распознавание картинок и сканов идёт запросом `POST /ocr` → Indra.  
   DOCX↔PDF идёт запросом `POST /convert`.

Electron и Indra не связаны напрямую. Electron — только оболочка.  
Без запущенного Python-сервера интерфейс работает, но OCR и точное оформление DOCX↔PDF недоступны.

---

## Запуск приложения

Интерфейс и библиотеки лежат в `src/` этого проекта (копия `Univerter_HTML/web`).
Сеть для работы не нужна: pdf.js, JSZip, jsPDF, mammoth, Turndown и SheetJS лежат в `src/vendor/`.

### Установленное приложение — полный режим

Установщик кладёт движок в `resources\engine`. Установленный `Univerter.exe` при старте сам
поднимает движок на `127.0.0.1:8765`, если тот ещё не работает, и завершает его при выходе.

- Нужен установленный Python 3.10+ (`py` или `python` в PATH); недостающие пакеты
  (`pdf2docx`, `indra-ocr`) и веса Indra движок ставит сам при первом запуске — один раз нужен интернет.
- Лог движка: `%APPDATA%\Univerter\engine.log` (консоль движка скрыта намеренно).
- Если движок на 8765 уже запущен (например, вручную из `Univerter_HTML`), приложение
  использует его и при выходе не завершает.
- Если Python не найден — интерфейс работает без OCR и точного DOCX↔PDF.

### Вариант A — только интерфейс (без OCR)

```powershell
cd Univerter_desktop
.\Univerter.bat
```

При первом запуске файл сам выполнит `npm install`. Вручную то же самое —
`npm install`, затем `npm start`.

Откроется окно Univerter. Распознавание текста и точный DOCX↔PDF будут недоступны.

### Вариант B — полный режим (с Indra)

Один файл: `Univerter.bat` запускает интерфейс и сам поднимает движок.

```powershell
cd Univerter_desktop
.\Univerter.bat
```

Если рядом (в `..\Univerter_HTML`) есть движок и он ещё не работает, лаунчер стартует его
свёрнутым окном **«Univerter engine (Python)»** — недостающие пакеты (`pdf2docx`, `indra-ocr`)
движок поставит сам при первом запуске, затем скачает веса. Остановить движок: закрыть это
окно на панели задач. Повторный запуск лаунчера видит уже работающий движок и не дублирует его.
Если Python или `Univerter_HTML` не найдены — интерфейс запустится без OCR, как в варианте A.

Вариант вручную (два окна) — если нужно запустить движок отдельно:

**Окно 1 — Python-сервер с Indra** (папка `Univerter_HTML`):

```powershell
cd Univerter_HTML
py server\univerter_server.py
```

**Окно 2 — Electron**:

```powershell
cd Univerter_desktop
npm start
```

В интерфейсе должна появиться зелёная строка  
**«Локальный движок подключён: … OCR (Indra) ✓»**.

### Проверка Indra

```powershell
cd Univerter_HTML
py server\univerter_server.py --check-indra
```

Ожидаемый результат: `✓ Indra работает.`

### Сборка установщика (Windows)

```powershell
cd Univerter_desktop
npm run dist:win
```

или дважды щёлкните `build-windows.bat`.  
Результат — в папке `dist/`:

- `Univerter-<версия>-win-x64-setup.exe` — установщик (NSIS, выбор папки, ярлыки);
- `Univerter-<версия>-win-x64-portable.exe` — один запускаемый файл без установки;
- `win-unpacked\Univerter.exe` — распакованное приложение.

Сборка не подписана: при первом запуске Windows может показать предупреждение SmartScreen.
Движок кладётся в установку целиком (`extraResources: engine`), копия обязана совпадать с
`Univerter_HTML/server` — это проверяет `tests/load-app.js`.

### Если сборка падает на winCodeSign

```
ERROR: Cannot create symbolic link : ... \winCodeSign\...\darwin\...\libcrypto.dylib
```

Electron-builder распаковывает в кэш архив с символическими ссылками, а Windows создаёт их
только с правами администратора или при включённом режиме разработчика. Варианты:

1. запустить сборку от имени администратора;
2. `npm run dist:win:nosign` — тот же установщик, но без правки ресурсов exe
   (файл сохранит стандартную иконку Electron; иконка окна всё равно берётся из `build/icon.png`).


---

## Иконка

Положите `icon.png` (256×256 или больше) в папку `build/`. Без неё сборка тоже работает.

---

## Если что-то не работает

| Симптом | Что сделать |
|---------|-------------|
| Окно Electron не открывается | `npm install` ещё раз, проверьте Node.js 20+ |
| «Локальный движок не найден» | Запустите Python-сервер из папки `Univerter` |
| «OCR (Indra) ✗» | Перезапустите движок — он сам поставит `indra-ocr`; проверка: `py server\univerter_server.py --check-indra` |
| Indra не загружается | `py server\univerter_server.py --check-indra` и пришлите вывод |
| Порт 8765 занят | Запустите сервер с `--port 8766` и обновите страницу в Electron |
