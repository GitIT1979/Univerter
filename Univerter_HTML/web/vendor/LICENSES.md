# Сторонние библиотеки в Univerter_HTML/web/vendor

Все файлы скачаны с официальных площадок и лежат локально: приложение работает без интернета
и не выполняет код с CDN. Версии зафиксированы, менять их нужно вместе с файлами.

| Файл | Пакет | Версия | Лицензия |
|---|---|---|---|
| `pdf.min.js`, `pdf.worker.min.js` | [pdfjs-dist](https://www.npmjs.com/package/pdfjs-dist) | 3.11.174 | Apache-2.0 |
| `jszip.min.js` | [jszip](https://www.npmjs.com/package/jszip) | 3.10.1 | MIT / GPLv3 (двойная) |
| `jspdf.umd.min.js` | [jspdf](https://www.npmjs.com/package/jspdf) | 2.5.2 | MIT |
| `mammoth.browser.min.js` | [mammoth](https://www.npmjs.com/package/mammoth) | 1.8.0 | BSD-2-Clause |
| `turndown.js` | [turndown](https://www.npmjs.com/package/turndown) | 7.2.0 | MIT |
| `turndown-plugin-gfm.js` | [turndown-plugin-gfm](https://www.npmjs.com/package/turndown-plugin-gfm) | 1.0.2 | MIT |
| `xlsx.full.min.js` | [SheetJS CE](https://cdn.sheetjs.com/) | 0.20.3 | Apache-2.0 |
| `FileSaver.min.js` | [file-saver](https://www.npmjs.com/package/file-saver) | 2.0.5 | MIT |

Тексты лицензий — в шапках самих файлов (они не минифицированы в части комментариев) и на страницах пакетов.

Отдельно: OCR-движок `indra-ocr` ставится через pip и **не** входит в этот каталог.
Его код — Apache-2.0, веса модели — модифицированная OpenRAIL-M (см. `install_indra.py` и
[LICENSE модели](https://huggingface.co/datalab-to/indra-ocr/blob/main/LICENSE)).
Встроенный шрифт DejaVu Sans — Bitstream Vera / DejaVu, см. `LICENSE-DejaVu.txt`.
