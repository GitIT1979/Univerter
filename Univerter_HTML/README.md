# Univerter — HTML-версия

Локальный конвертер документов. OCR только через **Indra**.

## Быстрый запуск (Windows)

```powershell
# 1. Установка (один раз)
.\setup.bat

# 2. Проверка Indra
py server\univerter_server.py --check-indra

# 3. Запуск
py server\univerter_server.py --open
```

Без локального движка (только браузер, без OCR):
```powershell
start web\Univerter.html
```

## Запуск (Linux / macOS)

```bash
python3 -m pip install -r requirements.txt
python3 install_indra.py
python3 server/univerter_server.py --check-indra
python3 server/univerter_server.py --open
```

## Структура

```
Univerter_HTML/
├── web/                  # интерфейс (откройте Univerter.html); библиотеки — в web/vendor/
├── server/               # локальный движок (LibreOffice + pdf2docx + Indra)
├── install_indra.py
├── setup.bat
└── requirements.txt
```

Библиотеки интерфейса (pdf.js, JSZip, jsPDF, mammoth, Turndown, SheetJS, FileSaver) лежат
в `web/vendor/` — интернет для работы не нужен, CDN не используется. Список версий и лицензии —
в `web/vendor/LICENSES.md`.

## Требования

- Python 3.10+ (при установке на Windows — галочка «Add python.exe to PATH»)
- LibreOffice (для точного DOCX → PDF)
- Интернет один раз (скачивание весов Indra ~76 МБ)

