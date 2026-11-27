# Univerter

Универсальный конвертер документов, который работает на вашем компьютере.
Две сборки из одного интерфейса:

| Папка | Что это | Запуск |
|---|---|---|
| `Univerter_HTML/` | браузерная версия + локальный Python-движок | `cd Univerter_HTML` → `.\setup.bat` → `py server\univerter_server.py --open` |
| `Univerter_desktop/` | Electron-оболочка (Windows/macOS/Linux) | `cd Univerter_desktop` → `npm install` → `npm start` |

Интерфейс один и тот же: `Univerter_HTML/web/` — источник, `Univerter_desktop/src/` — его копия.
После правки в `web/` выполните `node scripts/sync-ui.js`.

## Что умеет

- **MD**: PDF, DOCX, TXT, таблицы, картинки → Markdown (OCR для сканов и изображений).
- **PDF**: DOCX и таблицы через LibreOffice (точное оформление), TXT/картинки — своим писателем.
- **DOCX**: PDF через pdf2docx, текст и картинки — без внешних сервисов.
- Распознавание — локально через [Indra OCR](https://github.com/datalab-to/indra) (ставится отдельно, ~76 МБ весов).
- Интернет не нужен: библиотеки интерфейса лежат в `web/vendor/` (см. `vendor/LICENSES.md`).

## Требования

- Python 3.10+ (для движка), Node.js 20+ (только для Electron-сборки).
- LibreOffice — для DOCX → PDF с точной вёрсткой.
- Опционально: `pdf2docx` — для PDF → DOCX, `indra-ocr` — для OCR.

## Проверки

```bash
node tests/load-app.js            # скрипты компилируются вместе, копии интерфейса синхронны, vendor на месте
python tests/test_server_origin.py # правила доступа локального движка и валидация входных файлов
python tests/run_tests.py          # регрессия интерфейса в настоящем браузере (нужен playwright)
node scripts/sync-ui.js            # синхронизировать web/ → desktop/src/
```

CI (GitHub Actions) прогоняет первые две проверки на каждый push и pull request.

## Структура

```
Univerter_HTML/
├── web/            # интерфейс: Univerter.html + config/core/convert + vendor/
├── server/         # univerter_server.py (HTTP), univerter_fidelity.py (LibreOffice, pdf2docx)
└── install_indra.py, setup.bat, requirements.txt
Univerter_desktop/
├── main.js, preload.js, lib/server.js   # Electron-оболочка и статический сервер
├── src/                                 # копия web/ (интерфейс + vendor)
└── package.json
scripts/sync-ui.js  # web/ → desktop/src/
tests/              # load-app.js, test_server_origin.py, run_tests.py (Playwright)
```

## Лицензии

Код проекта — как указано владельцем репозитория. Сторонние библиотеки интерфейса — в
`Univerter_HTML/web/vendor/LICENSES.md`; шрифт DejaVu — `LICENSE-DejaVu.txt`; веса Indra OCR —
по условиям правообладателя (модифицированная OpenRAIL-M), подробности в `install_indra.py`.
