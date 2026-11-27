#!/usr/bin/env python3
"""
Регрессионные тесты Univerter (работают в настоящем браузере, без интернета).

Запуск (из любой папки):
    pip install playwright
    playwright install chromium
    python tests/run_tests.py

Нужны только Python и Playwright. Необязательно: утилиты qpdf и pdftotext (poppler) —
если они есть, дополнительно проверяется текстовый слой PDF; если нет — эти проверки пропускаются.
Библиотеки с CDN (Tesseract, pdf.js, jsPDF …) не нужны: проверяется то, что работает без них.
"""
import base64
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit('Не установлен Playwright: pip install playwright && playwright install chromium')

ROOT = Path(__file__).resolve().parent.parent
URL = (ROOT / 'Univerter_HTML' / 'web' / 'Univerter.html').as_uri()
SERVER_PY = ROOT / 'Univerter_HTML' / 'server' / 'univerter_server.py'
passed = failed = skipped = 0


def make_png(w, h):                                        # белый PNG без внешних библиотек
    import struct, zlib
    raw = b''.join(b'\x00' + b'\xff\xff\xff' * w for _ in range(h))
    def chunk(tag, data): return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


def check(label, ok, detail=''):
    global passed, failed
    if ok:
        passed += 1
        print(f'  ✓ {label}')
    else:
        failed += 1
        print(f'  ✗ {label}  {detail}')


def skip(label, why):
    global skipped
    skipped += 1
    print(f'  – {label}  (пропущено: {why})')


def section(title):
    print(f'\n{title}')


# ----------------------------------------------------------------------------- данные
AUTO = ["IMG_1234.jpg", "scan001.pdf", "Скан 2.pdf", "Снимок экрана 2024-01-01 в 12.00.00.png", "Документ1.docx",
        "photo_2024-01-01_12-00-00.jpg", "Новый документ.docx", "IMG-20240101-WA0001.jpg", "Книга1.xlsx", "123.pdf"]
MEANINGFUL = ["Скан договора аренды.pdf", "Фото с отпуска.jpg", "Договор аренды.docx", "report_final.pdf", "Книга рецептов.pdf",
              "Презентация проекта.pdf", "Копия договора.pdf", "Invoice.pdf"]

CORPUS = [  # (метка, текст, ожидаемое имя)
    ("Договор аренды (стороны прописью)",
     "ДОГОВОР АРЕНДЫ № 15\nнежилого помещения\nг. Москва                                   12 марта 2024 г.\nОбщество с ограниченной ответственностью «Ромашка», именуемое в дальнейшем «Арендодатель», и ООО «Лютик», именуемое в дальнейшем «Арендатор», заключили настоящий договор.\n1. Предмет договора. Срок аренды до 31.12.2025.\nПодписи сторон",
     "2024-03-12 Договор аренды № 15 нежилого помещения — Ромашка, Лютик"),
    ("Счёт на фирменном бланке",
     "ООО «Ромашка»\n125009, г. Москва, ул. Тверская, д. 1\nИНН 7701234567  КПП 770101001  БИК 044525225\nСчёт на оплату № 45 от 12.03.2024\nПоставщик: ООО «Ромашка»\nПокупатель: ИП Иванов Иван\nИтого к оплате: 5 000 руб. Срок оплаты до 20.03.2024.",
     "2024-03-12 Счёт на оплату № 45 — Ромашка, Иванов Иван"),
    ("Акт сверки за квартал",
     "АКТ СВЕРКИ\nвзаиморасчётов за период с 01.01.2024 по 31.03.2024\nмежду ООО «Альфа» и ООО «Бета»\nМы, нижеподписавшиеся, составили настоящий акт.",
     "2024-Q1 Акт сверки взаиморасчётов — Альфа, Бета"),
    ("Кассовый чек (дата с двузначным годом и временем)",
     "ООО \"МАГНИТ\"\nКАССОВЫЙ ЧЕК\nПРИХОД\nИТОГО 1 234,50\nФН 9999078900001234 ФД 12345 ФПД 123456789\n12.03.24 14:35",
     "2024-03-12 Кассовый чек — Магнит"),
    ("Резюме (дата рождения — не дата документа)",
     "Иванов Иван Иванович\nРезюме\nОпыт работы: 2019–2024 ООО «Ромашка», инженер\nОбразование: МГУ\nНавыки: Python, SQL\nДата рождения: 01.01.1990",
     "Резюме — Иванов Иван"),
    ("Заголовок не про тип → имя по содержанию",
     "Спецификация поставки\nКоличество и цены указаны ниже.\n" + "\n".join(f"{i} | Позиция {i} | {i*100}" for i in range(1, 9)) +
     "\nИтого к оплате: 15 000 руб. Назначение платежа: оплата по счёту на оплату № 77 от 02.04.2024. Счёт на оплату выставлен ООО «Альфа».",
     "2024-04-02 Счёт на оплату № 77 — Альфа"),
    ("Только срок — даты нет", "Памятка по оплате\nОплатить необходимо до 31.12.2024. Срок оплаты до 20.03.2025.", "Памятка по оплате"),
    ("ЛОЖНАЯ ДАТА: номер пункта «5.12.10»",
     "ПРОТОКОЛ СОВЕЩАНИЯ\n5.12.10 Порядок расчётов между сторонами.\n5.12.11 Ответственность сторон.\nСлушали: Иванова. Постановили: принять.",
     "Протокол совещания"),
    ("ЛОЖНАЯ ДАТА: версия «2.10.24»",
     "Руководство пользователя\nВерсия 2.10.24 программы Альфа.\nИнструкция по установке и настройке.",
     "Руководство пользователя"),
    ("Контроль: настоящая дата рядом со словом «от»",
     "ПРОТОКОЛ СОВЕЩАНИЯ\nот 05.12.24\nСлушали: Иванова. Постановили: принять.",
     "2024-12-05 Протокол совещания"),
    ("Мусор OCR", "12 34 56 ... --- 7 8 9", None),
]

TXT_CONTRACT = ("ДОГОВОР АРЕНДЫ № 15\nнежилого помещения\nг. Москва 12 марта 2024 г.\n"
                "ООО «Ромашка», именуемое в дальнейшем «Арендодатель», и ООО «Лютик». Предмет договора.")

with tempfile.TemporaryDirectory() as tmp, sync_playwright() as pw:
    tmp = Path(tmp)
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={'width': 1600, 'height': 1000})
    page_errors = []
    page.on('pageerror', lambda e: page_errors.append(str(e)[:140]))
    page.on('dialog', lambda d: (page_errors.append('DIALOG: ' + d.message[:80]), d.dismiss()))
    page.goto(URL, wait_until='load')
    page.wait_for_timeout(800)

    # ------------------------------------------------------------------ 1
    section('1. Страница')
    check('галочка «Умное переименование» включена по умолчанию', page.is_checked('#renameFiles'))
    check('встроенный шрифт на месте', page.evaluate("(getEmbeddedFontBytes() || []).length") > 20000)
    ids = page.evaluate("[...document.querySelectorAll('[id]')].map(e => e.id)")
    check('нет повторяющихся id', len(ids) == len(set(ids)))
    page.click('.mode-option:has(.mode-title:text-is("PDF → DOCX"))')
    check('клик по режиму сразу меняет «Выбран режим»', 'PDF → DOCX' in page.inner_text('#currentMode'))
    check('колонки режимов выровнены по верху и низу', page.evaluate(
        "()=>{const L=[...document.querySelectorAll('.modes.stack .mode-option')].map(e=>e.getBoundingClientRect()),"
        "G=[...document.querySelectorAll('.modes.grid9 .mode-option')].map(e=>e.getBoundingClientRect());"
        "return Math.abs(L[0].top-G[0].top)<1&&Math.abs(L[2].bottom-G[8].bottom)<1}"))

    # ------------------------------------------------------------------ 2
    section('2. Правила автоимён (что переименовывать, а что оставлять)')
    res = page.evaluate("n => n.map(x => [x, hasMeaningfulName(x)])", AUTO + MEANINGFUL)
    bad = [n for n, g in res if (n in AUTO and g) or (n in MEANINGFUL and not g)]
    check(f'{len(res)} имён классифицированы верно', not bad, str(bad))

    # ------------------------------------------------------------------ 3
    section('3. Имя по содержимому (тип, дата, номер, стороны)')
    for label, text, exp in CORPUS:
        r = page.evaluate("t => analyzeDocument(t, {})", text)
        got = r['name'] if r else None
        check(label, got == exp, f'получено {got!r}, ожидалось {exp!r}')

    # ------------------------------------------------------------------ 4
    section('4. Имена файлов (Windows)')
    cases = {'CON.md': '_CON.md', 'nul': '_nul', 'Com1.txt': '_Com1.txt', 'имя .md': 'имя.md', 'a..md': 'a.md',
             'Договор: «тест» / проверка?.md': 'Договор_ «тест» _ проверка_.md', 'Controller.md': 'Controller.md'}
    for src, exp in cases.items():
        got = page.evaluate("s => sanitizeFileName(s)", src)
        check(f'{src!r} → {exp!r}', got == exp, f'получено {got!r}')
    today = page.evaluate("(()=>{const d=new Date();return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`})()")
    page.click('.mode-option:has(.mode-title:text-is("Все в MD"))')
    page.set_input_files('#fileInput', [{'name': 'IMG_1.txt', 'mimeType': 'text/plain', 'buffer': b'12 34 56'}])
    page.wait_for_timeout(700)
    shown = page.evaluate("document.querySelector('#fileList .file-new-name').textContent")
    check('{дата} в шаблоне — местная дата', today in shown, f'{shown!r} / {today}')

    # ------------------------------------------------------------------ 5
    section('5. Fallback возвращает массив страниц (PDF → Картинка)')
    r = page.evaluate("""async () => {
        filesToProcess.length = 0; fileList.innerHTML = '';
        const item = { file: new File([new Uint8Array([1])], 'a.pdf'), action: 'convert', targetExt: 'png', newName: 'a.png', namingMethod: 'kept', result: null };
        filesToProcess.push(item);
        const li = document.createElement('li'); li.dataset.index = 0; li.innerHTML = '<div class="file-name">a</div><div class="file-new-name">x</div>'; fileList.appendChild(li);
        window.createFallbackResult = async () => [{ name: 'a_стр1.png', blob: new Blob(['1']), fallbackReason: 'p1' }, { name: 'a_стр2.png', blob: new Blob(['2']), fallbackReason: 'p2' }];
        const out = await applyFallbackOrError(0, item, { title: 't', message: 'm', attempts: [], type: 'unknown' });
        window.createFallbackResult = async () => ({ name: 'x.md' });      // без blob — должно быть ошибкой
        const bad = await applyFallbackOrError(0, { ...item, result: null }, { title: 't', message: 'm', attempts: [], type: 'unknown' });
        return { out, names: (item.result || []).map(x => x.name), bad };
    }""")
    check('массив страниц принят как успех', r['out'] == 'fallback' and r['names'] == ['a_стр1.png', 'a_стр2.png'], str(r))
    check('результат без blob по-прежнему считается ошибкой', r['bad'] == 'error')

    # ------------------------------------------------------------------ 6
    section('6. Сквозной прогон: реальные TXT → MD с переименованием по содержимому')
    page.reload(wait_until='load'); page.wait_for_timeout(700)
    files = [("scan001.txt", TXT_CONTRACT.encode('utf-8')),
             ("IMG_5.txt", "Счёт на оплату № 45 от 12.03.2024\nПоставщик: ООО «Альфа»\nИтого к оплате: 5000 руб.".encode('utf-8')),
             ("Договор аренды.txt", TXT_CONTRACT.encode('utf-8')),
             ("scan002.txt", TXT_CONTRACT.encode('cp1251')),
             ("IMG_6.txt", b"12 34 56\n---")]
    page.set_input_files('#fileInput', [{'name': n, 'mimeType': 'text/plain', 'buffer': d} for n, d in files])
    page.wait_for_timeout(900)
    page.click('#convertBtn')
    page.wait_for_function("document.getElementById('stopBtn').disabled && !document.getElementById('convertBtn').disabled", timeout=20000)
    names = page.evaluate("convertedFiles.map(f => f.name)")
    check('файл с автоименем получил имя по договору', '2024-03-12 Договор аренды № 15 нежилого помещения — Ромашка, Лютик.md' in names, str(names))
    check('счёт: дата и номер в имени', '2024-03-12 Счёт на оплату № 45 — Альфа.md' in names)
    check('Windows-1251 прочитан верно (совпадение → _2)', '2024-03-12 Договор аренды № 15 нежилого помещения — Ромашка, Лютик_2.md' in names)
    check('осмысленное имя не тронуто', 'Договор аренды.md' in names)
    check('нет текста → остаётся имя по шаблону', any(n.endswith('_MD_005.md') or '_MD_' in n for n in names))

    # ------------------------------------------------------------------ 7
    section('7. Безопасность: враждебное имя и содержимое не превращаются в HTML')
    page.reload(wait_until='load'); page.wait_for_timeout(600)
    page.set_input_files('#fileInput', [{'name': '"><img src=x onerror=alert(1)><b>x</b>.txt', 'mimeType': 'text/plain',
                                          'buffer': 'ДОГОВОР № 5\nПредмет договора. именуемое в дальнейшем "<script>alert(2)</script>"'.encode()}])
    page.wait_for_timeout(800); page.click('#convertBtn'); page.wait_for_timeout(2500)
    injected = page.evaluate("document.querySelectorAll('#fileList img, #fileList script, #fileList b').length")
    check('в списке нет внедрённых элементов, диалоги не открывались', injected == 0 and not [e for e in page_errors if e.startswith('DIALOG')])

    # ------------------------------------------------------------------ 8
    section('8. PDF из картинки: невидимый текстовый слой')
    JS = """async ({W, H, rows}) => {
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, W, H); x.fillStyle = '#000'; x.font = '34px sans-serif';
        const wordLines = [];
        rows.forEach((txt, r) => { const y = 70 + r * 80; let px = 60; const line = [];
            for (const w of txt.split(' ')) { const wd = x.measureText(w).width; x.fillText(w, px, y);
                line.push({ text: w, bbox: { x0: px, y0: y - 30, x1: px + wd, y1: y + 10 } }); px += wd + x.measureText(' ').width; }
            wordLines.push(line); });
        const res = await createPdfWithTextLayer(null, { canvas: c, wordLines, text: rows.join('\\n') }, 't');
        const buf = new Uint8Array(await res.blob.arrayBuffer()); let bin = '';
        for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
        return { b64: btoa(bin), words: res.textLayerLines };
    }"""
    rows = ["СЧЁТ НА ОПЛАТУ № 45 от 12.03.2024", "Поставщик: ООО «Ромашка»", "Invoice total 5000 EUR", "Україна: Їжак, Єнот, Ґанок"]
    out = page.evaluate(JS, {'W': 900, 'H': 600, 'rows': rows})
    pdf = tmp / 'layer.pdf'
    pdf.write_bytes(base64.b64decode(out['b64']))
    check('слой построен без jsPDF и без сети', out['words'] == sum(len(r.split(' ')) for r in rows), f"слов: {out['words']}")
    if shutil.which('qpdf'):
        r = subprocess.run(['qpdf', '--check', str(pdf)], capture_output=True, text=True)
        check('qpdf: PDF структурно корректен', 'No syntax or stream encoding errors' in (r.stdout + r.stderr))
    else:
        skip('qpdf --check', 'qpdf не установлен')
    if shutil.which('pdftotext'):
        txt = subprocess.run(['pdftotext', '-layout', str(pdf), '-'], capture_output=True, text=True).stdout
        check('pdftotext извлекает весь текст (рус., англ., укр.)', ' '.join(txt.split()) == ' '.join(' '.join(rows).split()), repr(' '.join(txt.split())))
    else:
        skip('pdftotext', 'poppler не установлен')

    # ------------------------------------------------------------------ 9
    section('9. Сторож загрузки: страница без своих скриптов сообщает причину')
    check('при нормальном запуске предупреждение скрыто и страница помечена как готовая',
          page.evaluate("document.getElementById('loadBanner').hidden && window.__univerterReady === true"))
    lonely = tmp / 'lonely'; lonely.mkdir()
    shutil.copy(ROOT / 'Univerter_HTML' / 'web' / 'Univerter.html', lonely / 'Univerter.html')   # .js-файлов рядом нет (как при открытии из ZIP)
    p2 = browser.new_page(); p2.goto((lonely / 'Univerter.html').as_uri(), wait_until='load'); p2.wait_for_timeout(1200)
    shown = p2.evaluate("(() => { const b = document.getElementById('loadBanner'); return { visible: !b.hidden, text: b.innerText }; })()")
    check('без .js-файлов видна красная плашка с именами файлов и советом', shown['visible'] and 'Univerter-core.js' in shown['text'] and 'Univerter-convert.js' in shown['text'] and 'ZIP' in shown['text'], shown['text'][:80])
    p2.close()

    # ------------------------------------------------------------------ 10
    section('10. Пробелы между буквами и осмысленность текста')
    spacing = {'С у м м ы  п р о п и с ь ю  з а  к а ж д ы й  д е н ь': 'Суммы прописью за каждый день',
               'Д О Г О В О Р': 'ДОГОВОР', '2 0 2 4': '2024', 'в т.ч. 5 шт': 'в т.ч. 5 шт', 'обычный   текст  с  пробелами': 'обычный текст с пробелами'}
    for src, exp in spacing.items():
        got = page.evaluate("s => normalizeSpacing(s)", src)
        check(f'{src!r} → {exp!r}', got == exp, f'получено {got!r}')

    LINE = lambda box, text, conf: {'box': box, 'text': text, 'conf': conf}
    RES = {'lines': [LINE([40, 30, 700, 70], 'ПРОТОКОЛ ОСМОТРА МЕСТА ПРОИСШЕСТВИЯ', 96), LINE([40, 90, 700, 120], 'Фиксация обстановки при входе в пом. № 25 (ООО «Наш Двор»)', 93),
                     LINE([40, 130, 700, 160], 'С у м м ы  п р о п и с ь ю', 88), LINE([40, 300, 300, 330], '¢d pre LC gasp?', 31),
                     LINE([40, 340, 700, 370], 'i (подпись понятого) Kel Fotecns 5 с easy Epa cer died adr pel ne CLR rel? LAC id REA £ REN LE pe', 33),
                     LINE([40, 380, 300, 410], '7 М rgoxnmy АД. 9-9, 9)', 29), LINE([40, 420, 300, 450], 'Ea бан,', 40), LINE([40, 560, 200, 580], 'стр. 3', 90)],
           'blocks': [{'label': 'Section-Header', 'bbox': [40, 30, 700, 70]}, {'label': 'Text', 'bbox': [40, 90, 700, 160]}, {'label': 'Page-Footer', 'bbox': [40, 555, 200, 585]}]}
    f = page.evaluate("r => formatIndraResult(r)", RES)
    NOISE = ['¢', 'gasp', 'rgoxnmy', 'Fotecns', 'Epa', 'стр. 3', 'REA', '£']
    check('мусор и колонтитул «стр. 3» убраны из текста', not [n for n in NOISE if n in f['text']], f['text'][:80])
    check('заголовок по разметке страницы найден и отмечен «##»', f['headings'] == ['ПРОТОКОЛ ОСМОТРА МЕСТА ПРОИСШЕСТВИЯ'] and f['text'].startswith('## ПРОТОКОЛ'))
    check('разряженный текст склеен по словам', 'Суммы прописью' in f['text'])
    check('картинка с полезным текстом признана полезной', f['quality']['useful'])
    junk = page.evaluate("r => formatIndraResult(r)", {'lines': RES['lines'][3:7], 'blocks': []})
    check('картинка из одного мусора: «полезной информации нет»', not junk['quality']['useful'] and junk['text'] == '')

    section('11. Смысл названия: проверка заголовка и собственный анализ')
    SEM = [
        ("служебные строки до заголовка на двух строках",
         "Рег. № 45/2024\nУтверждаю\nПРОТОКОЛ\nосмотра места происшествия\nг. Москва 21.01.2026\nСледователь Петров П.П. в присутствии понятых произвёл осмотр помещения № 25 ООО «Наш Двор». Изъяты предметы.", {},
         "2026-01-21 Протокол осмотра места происшествия № 45-2024 — Наш Двор"),
        ("заголовок — обрывок фразы, имя по содержанию (счёт)",
         "обнаруженный на втором этаже здания\nСчёт на оплату № 91 от 03.04.2025\nПоставщик ООО «Альфа». Итого к оплате 12 000 руб. Назначение платежа: оплата по счёту.", {},
         "2025-04-03 Счёт на оплату № 91 — Альфа"),
        ("заголовок «Благодарность» не про документ — это договор",
         "Благодарность\nДОГОВОР ПОДРЯДА № 3 от 02.02.2025\nПодрядчик ООО «Строй» обязуется выполнить ремонт. Предмет договора. Подписи сторон.", {},
         "2025-02-02 Договор подряда № 3 — Строй"),
        ("нет типа и заголовка — главная тема текста (падежи не мешают)",
         "Склад оборудования находится на втором этаже. Оборудование склада проверено комиссией. Проверка оборудования склада показала замечания. Замечания по оборудованию склада устранены.", {},
         "Оборудование склада"),
        ("заголовок из разметки страницы (Indra)",
         "Согласие на обработку персональных данных\nЯ, Иванов Иван Иванович, даю согласие на обработку персональных данных.", {'headings': ['СОГЛАСИЕ НА ОБРАБОТКУ ПЕРСОНАЛЬНЫХ ДАННЫХ']},
         "Согласие на обработку персональных данных"),
        ("мусорная первая строка, заголовок — первое предложение абзаца",
         "¢d pre LC gasp?\nПротокол осмотра помещения № 25. Осмотр проведён в присутствии понятых. Протокол составлен 21.01.2026.", {},
         "2026-01-21 Протокол осмотра помещения № 25"),
        ("только обрывки фраз — осмысленного имени нет",
         "2, обнаруженный на 2-м этаже\nкоторый указал на дверь\n9) как следует из показаний", {}, None),
    ]
    for label, text, meta, exp in SEM:
        r = page.evaluate("([t, m]) => analyzeDocument(t, m)", [text, meta])
        got = r['name'] if r else None
        check(label, got == exp, f'получено {got!r}, ожидалось {exp!r}')

    section('12. Распознавание через Indra: сервер + страница (подставная Indra, настоящий API)')
    try:
        import numpy as np, cv2, socket, time, urllib.request
        have_cv = True
    except ImportError:
        have_cv = False
    if not have_cv:
        skip('сквозной прогон с сервером', 'нужны numpy и opencv-python (они ставятся вместе с Indra)')
    else:
        FAKE = ROOT / 'tests' / 'fake_indra'
        D = lambda lines, blocks: {'lines': [[l['box'], l['text'], l['conf']] for l in lines], 'blocks': blocks}
        GOODL = [LINE([40, 30, 700, 70], 'ПРОТОКОЛ ОСМОТРА МЕСТА ПРОИСШЕСТВИЯ', 96), LINE([40, 90, 700, 120], 'Фиксация обстановки при входе в пом. № 25 (ООО «Наш Двор»)', 93),
                 LINE([40, 130, 700, 160], 'С у м м ы  п р о п и с ь ю  з а  к а ж д ы й  д е н ь', 88), LINE([40, 560, 200, 580], 'стр. 3', 90)]
        JUNKL = RES['lines'][3:7]
        BLK = [{'label': 'Section-Header', 'bbox': [40, 30, 700, 70], 'text': ''}, {'label': 'Text', 'bbox': [40, 90, 700, 160], 'text': ''}, {'label': 'Page-Footer', 'bbox': [40, 555, 200, 585], 'text': ''}]
        data = {'301': D(JUNKL, []), '302': D(GOODL, BLK), '303': D(GOODL[:3] + JUNKL + GOODL[3:], BLK), '800': D(GOODL[:2], BLK)}
        dpath = tmp / 'fake.json'; dpath.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
        s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
        # Подставную Indra подкладываем через sys.path в launcher'е: PYTHONPATH игнорируют
        # некоторые сборки Python (в т.ч. встроенные), и тогда тест молча работал бы с настоящей моделью.
        launcher = tmp / 'fake_server.py'
        launcher.write_text(
            'import sys, runpy\n'
            f'sys.path.insert(0, r"{FAKE}")\n'
            'sys.argv = ["univerter_server.py", "--port", sys.argv[1]]\n'
            f'runpy.run_path(r"{SERVER_PY}", run_name="__main__")\n',
            encoding='utf-8')
        env = dict(**__import__('os').environ, UNIVERTER_FAKE_INDRA_DATA=str(dpath))
        srv = subprocess.Popen([sys.executable, str(launcher), str(port)], env=env, cwd=str(tmp),
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            base = f'http://127.0.0.1:{port}'
            for _ in range(40):
                try: urllib.request.urlopen(base + '/health', timeout=1); break
                except Exception: time.sleep(0.25)
            health = json.loads(urllib.request.urlopen(base + '/health').read())
            check('сервер видит Indra и модель загружена', health.get('indra') and health.get('indra_state') in ('ready', 'loading', 'idle'), str(health))

            def post_ocr(img):
                req = urllib.request.Request(base + '/ocr', data=cv2.imencode('.png', img)[1].tobytes(), method='POST')
                return json.loads(urllib.request.urlopen(req, timeout=20).read())
            up = np.full((600, 800, 3), 255, np.uint8); up[:12, :12] = 0
            r0 = post_ocr(up)
            check('прямая страница: поворот не нужен, строки и блоки получены', r0['rotation'] == 0 and r0['aligned'] is None and len(r0['lines']) == 2 and len(r0['blocks']) == 3)
            for name, rot, exp in [('повёрнута на 90°', cv2.ROTATE_90_CLOCKWISE, {90, 270}), ('вверх ногами', cv2.ROTATE_180, {180})]:
                rr = post_ocr(cv2.rotate(up, rot))
                al = cv2.imdecode(np.frombuffer(base64.b64decode(rr['aligned'] or ''), np.uint8), cv2.IMREAD_GRAYSCALE) if rr['aligned'] else None
                check(f'страница {name}: сервер сам нашёл верное направление и вернул выпрямленное изображение',
                      rr['rotation'] in exp and al is not None and al[:12, :12].mean() < 80, f"rotation={rr['rotation']}")
            try:
                urllib.request.urlopen(urllib.request.Request(base + '/ocr', data=b'not an image', method='POST'), timeout=10)
                check('не-картинка даёт ошибку, а не пустой результат', False)
            except urllib.error.HTTPError as e:
                check('не-картинка даёт понятную ошибку (HTTP 500)', e.code == 500)

            p4 = browser.new_page(viewport={'width': 1600, 'height': 1000}); p4_errors = []
            p4.on('pageerror', lambda e: p4_errors.append(str(e)[:120]))
            p4.goto(base + '/', wait_until='load'); p4.wait_for_timeout(1500)
            check('страница показывает «OCR (Indra) ✓»', 'OCR (Indra)' in p4.inner_text('#helperStatus') and '✓' in p4.inner_text('#helperStatus'), p4.inner_text('#helperStatus'))
            check('галочка «Пропускать изображения без полезной информации» включена', p4.is_checked('#skipUseless'))
            p4.click('.mode-option:has(.mode-title:text-is("Картинка → MD"))')
            p4.set_input_files('#fileInput', [{'name': f'IMG_000{i}.png', 'mimeType': 'image/png', 'buffer': make_png(w, 200)} for i, w in enumerate([301, 302, 303], 1)])
            p4.wait_for_timeout(1200); p4.click('#convertBtn')
            p4.wait_for_function("document.getElementById('stopBtn').disabled && !document.getElementById('convertBtn').disabled", timeout=30000); p4.wait_for_timeout(700)
            rows = p4.evaluate("[...document.querySelectorAll('#fileList li')].map(li => li.querySelector('.status-badge').textContent)")
            done = p4.evaluate("Promise.all(convertedFiles.map(async f => [f.name, await f.blob.text()]))")
            check('картинка из одного мусора: «Пропущен»', rows[0].startswith('⏭'), str(rows))
            check('пропущенный файл НЕ попал в список готовых (готово 2 из 3)', len(done) == 2, str([n for n, _ in done]))
            check('имена по содержимому осмысленные', all(n.startswith('Протокол осмотра места происшествия № 25') for n, _ in done), str([n for n, _ in done]))
            alltext = ' '.join(t for _, t in done)
            check('в готовых файлах нет мусора и колонтитула', not [n for n in NOISE if n in alltext])
            check('слова не разорваны пробелами: «Суммы прописью за каждый день»', 'Суммы прописью за каждый день' in alltext)
            # В выводе сначала идёт «# <имя файла>», поэтому заголовок страницы — не первая строка;
            # проверяем, что он всё равно оформлен как заголовок второго уровня.
            check('заголовок страницы оформлен как заголовок («## …»)', all('## ПРОТОКОЛ' in t for _, t in done))
            p4.uncheck('#skipUseless'); p4.click('#convertBtn')
            p4.wait_for_function("document.getElementById('stopBtn').disabled && !document.getElementById('convertBtn').disabled", timeout=30000); p4.wait_for_timeout(600)
            check('при выключенной галочке конвертируются все 3 файла', p4.evaluate("convertedFiles.length") == 3)

            # Картинка → PDF: слой строится из строк Indra, фразы ищутся целиком
            p4.reload(wait_until='load'); p4.wait_for_timeout(1200)
            p4.click('.mode-option:has(.mode-title:text-is("Картинка → PDF"))')
            p4.set_input_files('#fileInput', [{'name': 'IMG_0100.png', 'mimeType': 'image/png', 'buffer': make_png(800, 600)}])
            p4.wait_for_timeout(1000); p4.click('#convertBtn')
            p4.wait_for_function("document.getElementById('stopBtn').disabled && !document.getElementById('convertBtn').disabled", timeout=30000); p4.wait_for_timeout(700)
            pdfb64 = p4.evaluate("Promise.all(convertedFiles.map(async f => { const b = new Uint8Array(await f.blob.arrayBuffer()); let s=''; for (let i=0;i<b.length;i+=8192) s+=String.fromCharCode.apply(null,b.subarray(i,i+8192)); return btoa(s); }))")
            check('Картинка → PDF: получен один файл', len(pdfb64) == 1)
            if pdfb64 and shutil.which('pdftotext'):
                pp = tmp / 'indra_layer.pdf'; pp.write_bytes(base64.b64decode(pdfb64[0]))
                txt = ' '.join(subprocess.run(['pdftotext', '-layout', str(pp), '-'], capture_output=True, text=True).stdout.split())
                check('в текстовом слое PDF есть текст Indra (поиск по фразе)', 'Фиксация обстановки при входе' in txt, txt[:100])
            else:
                skip('проверка текстового слоя PDF', 'pdftotext не установлен')
            check('ошибок JavaScript в этих прогонах не было', not p4_errors, str(p4_errors))
            p4.close()
        finally:
            srv.terminate()

    check('ошибок JavaScript на странице не было', not [e for e in page_errors if not e.startswith('DIALOG')], str(page_errors))
    browser.close()

print(f'\nИтого: пройдено {passed}, не пройдено {failed}, пропущено {skipped}')
sys.exit(1 if failed else 0)
