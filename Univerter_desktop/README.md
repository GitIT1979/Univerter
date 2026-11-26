# Univerter Desktop (Electron)

Настольная оболочка для Univerter. Интерфейс тот же, что в HTML-версии.  
**OCR выполняется только через Indra** (пакет `indra-ocr`).

---

## Как устроена интеграция с Indra

```
┌─────────────────────┐         ┌──────────────────────────┐
│   Electron          │         │   Python-сервер          │
│   (Univerter_desktop)│         │   (папка Univerter)      │
│                     │         │                          │
│  main.js            │         │  univerter_server.py     │
│    └─ lib/server.js │         │    ├─ /health            │
│       (порт 47821)  │         │    ├─ /ocr  ← Indra      │
│                     │         │    └─ /convert           │
│  BrowserWindow      │  HTTP   │                          │
│    └─ src/          │◄───────►│  Indra OCR               │
│       Univerter.html│  :8765  │  LibreOffice + pdf2docx  │
└─────────────────────┘         └──────────────────────────┘
```

1. **Electron** запускает свой статический сервер и открывает `Univerter.html` в окне.
2. Страница периодически опрашивает `http://127.0.0.1:8765/health`.
3. Если Python-сервер запущен и Indra установлена, в интерфейсе появляется статус  
   **«OCR (Indra) ✓»**.
4. Распознавание картинок и сканов идёт запросом `POST /ocr` → Indra.  
   DOCX↔PDF идёт запросом `POST /convert`.

Electron и Indra не связаны напрямую. Electron — только оболочка.  
Без запущенного Python-сервера интерфейс работает, но OCR и точное оформление DOCX↔PDF недоступны.

---

## Запуск приложения

### Вариант A — только интерфейс (без OCR)

```powershell
cd Univerter_desktop
npm install
npm start
```

Откроется окно Univerter. Распознавание текста и точный DOCX↔PDF будут недоступны.

### Вариант B — полный режим (с Indra)

Нужны **два окна**.

**Окно 1 — Python-сервер с Indra** (папка `Univerter`):

```powershell
cd Univerter
py setup.bat
py server\univerter_server.py
```

Дождитесь:
```
OCR (Indra): ✓ установлена (модель загружается в фоне)
```

**Окно 2 — Electron**:

```powershell
cd Univerter_desktop
npm install
npm start
```

В интерфейсе должна появиться зелёная строка  
**«Локальный движок подключён: … OCR (Indra) ✓»**.

### Проверка Indra

```powershell
cd Univerter
py server\univerter_server.py --check-indra
```

Ожидаемый результат: `✓ Indra работает.`

### Сборка установщика (Windows)

```powershell
cd Univerter_desktop
npm run dist:win
```

или дважды щёлкните `build-windows.bat`.  
Результат — в папке `dist/`.


---

## Иконка

Положите `icon.png` (256×256 или больше) в папку `build/`. Без неё сборка тоже работает.

---

## Если что-то не работает

| Симптом | Что сделать |
|---------|-------------|
| Окно Electron не открывается | `npm install` ещё раз, проверьте Node.js 20+ |
| «Локальный движок не найден» | Запустите Python-сервер из папки `Univerter` |
| «OCR (Indra) ✗» | В папке `Univerter` выполните `py install_indra.py` и перезапустите сервер |
| Indra не загружается | `py server\univerter_server.py --check-indra` и пришлите вывод |
| Порт 8765 занят | Запустите сервер с `--port 8766` и обновите страницу в Electron |
