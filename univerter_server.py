#!/usr/bin/env python3
"""
univerter_server.py — локальный движок для Univerter.

Запускается на вашем компьютере и даёт веб-интерфейсу Univerter доступ к
LibreOffice (DOCX -> PDF) и pdf2docx (PDF -> DOCX): максимальное сохранение
шрифтов, цветов, таблиц и расположения. Univerter сам находит сервис и
использует его автоматически; если сервис не запущен — работает браузерный режим.

Запуск (в папке с Univerter.html):
    python univerter_server.py --open

Требуется: LibreOffice и `pip install pdf2docx` (только нужные вам направления).
Безопасность: слушает только 127.0.0.1, принимает запросы только со страниц с
localhost/127.0.0.1 или из локального файла (file://); пути к файлам не принимаются,
каждый запрос обрабатывается во временной папке, которая сразу удаляется.
"""
import argparse
import base64
import importlib.util
import json
import os
import socket
import sys
import tempfile
import threading
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    import univerter_fidelity as fid
except ImportError:
    raise SystemExit('Не найден univerter_fidelity.py — он должен лежать в одной папке с univerter_server.py')

HERE = Path(__file__).resolve().parent
STATIC = {  # отдаём только эти файлы — обход каталогов невозможен
    '/': 'Univerter.html', '/Univerter.html': 'Univerter.html',
    '/Univerter-config.js': 'Univerter-config.js',
    '/Univerter-core.js': 'Univerter-core.js', '/Univerter-convert.js': 'Univerter-convert.js',
}
MIME = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8'}
MAX_BYTES = 300 * 1024 * 1024
LOCK = threading.Lock()          # LibreOffice обрабатывает файлы по одному
CFG = {'soffice': None, 'extra_origins': [], 'timeout': 180}
VERSION = 2
INDRA = {'conv': None, 'state': 'idle', 'error': '', 'lock': threading.Lock()}   # idle → loading → ready | error
OCR_LOCK = threading.Lock()                                                     # распознаём по одной странице


def origin_ok(origin):
    if not origin or origin == 'null':          # file:// и прямые запросы
        return True
    if origin.startswith(('http://127.0.0.1', 'http://localhost')):
        return True
    return origin in CFG['extra_origins']


def capabilities():
    return {
        'ok': True, 'version': VERSION,
        'soffice': bool(CFG['soffice']),                                   # DOCX -> PDF
        'pdf2docx': importlib.util.find_spec('pdf2docx') is not None,      # PDF -> DOCX
        'indra': importlib.util.find_spec('indra_ocr') is not None,        # OCR (Indra)
        'indra_state': INDRA['state'] if importlib.util.find_spec('indra_ocr') is not None else 'missing',
        'indra_error': INDRA['error'],
    }


def convert(to, data, quality='high'):
    """to='pdf' (вход DOCX) или to='docx' (вход PDF). quality='high'|'fast'. Возвращает (bytes, log)."""
    if to == 'pdf':
        if not CFG['soffice']:
            raise RuntimeError(
                'LibreOffice не найден на этой машине. '
                'Установите его с https://www.libreoffice.org или укажите путь: '
                'py univerter_server.py --soffice "C:\\Program Files\\LibreOffice\\program\\soffice.exe"'
            )
        if data[:2] != b'PK':
            raise RuntimeError('Файл не похож на DOCX')
    elif to == 'docx':
        if b'%PDF-' not in data[:1024]:
            raise RuntimeError('Файл не похож на PDF')
    else:
        raise RuntimeError('Неизвестное направление')

    log = []
    with tempfile.TemporaryDirectory(prefix='univerter_srv_') as td:
        td = Path(td)
        src = td / ('input.docx' if to == 'pdf' else 'input.pdf')
        src.write_bytes(data)
        out = td / 'out'
        with LOCK:
            if to == 'pdf':
                res = fid.docx_to_pdf(src, out, CFG['soffice'], CFG['timeout'],
                                      log=log.append, quality=quality)
            else:
                res = fid.pdf_to_docx(src, out, log=log.append, fast=(quality == 'fast'))
        return res.read_bytes(), [l.strip() for l in log if l.strip()]


# ------------------------------------------------------------------ OCR (Indra)
def load_indra():
    """Загружает модель (при первом запуске Indra скачивает ~76 МБ весов с Hugging Face)."""
    with INDRA['lock']:
        if INDRA['conv'] is not None:
            return INDRA['conv']
        INDRA['state'], INDRA['error'] = 'loading', ''
        try:
            import indra_ocr
            INDRA['conv'] = indra_ocr.load(threads=max(1, min(4, os.cpu_count() or 2)))
            INDRA['state'] = 'ready'
        except Exception as e:                                   # нет пакета, нет сети для весов, нехватка памяти…
            INDRA['state'], INDRA['error'] = 'error', f'{type(e).__name__}: {e}'[:300]
            raise
        return INDRA['conv']


def _to_gray(img):
    import cv2
    return img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)


def _rot_cw(img, deg):
    import cv2
    d = int(round(deg)) % 360
    return {0: img, 90: cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE), 180: cv2.rotate(img, cv2.ROTATE_180),
            270: cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)}[d]


def _rotate_any(img, deg):
    """Поворот на произвольный угол (deg>0 — против часовой) с расширением холста."""
    import cv2
    h, w = img.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2, h / 2), deg, 1.0)
    cos, sin = abs(m[0, 0]), abs(m[0, 1])
    nw, nh = int(h * sin + w * cos), int(h * cos + w * sin)
    m[0, 2] += nw / 2 - w / 2
    m[1, 2] += nh / 2 - h / 2
    return cv2.warpAffine(img, m, (nw, nh), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


def _page_angles(page):
    return float(getattr(page, 'rotation', 0) or 0) % 360, float(getattr(page, 'skew', 0) or 0)


def _aligned(rot, skew, base_skew):
    return min(rot, 360 - rot) < 1 and abs(skew) < max(0.7, abs(base_skew) * 0.4)


def align_and_ocr(conv, img):
    """Распознаёт страницу. Если Indra сообщает поворот/наклон, приводит картинку к прямому виду САМИ
    и распознаёт заново: так рамки строк гарантированно лежат на возвращаемом изображении, и не нужно
    угадывать, в какую сторону и в какой системе координат Indra считает угол. Возвращает
    (page, img, повернуто_по_часовой, наклон_исправлен)."""
    page = conv.ocr(_to_gray(img))
    rot, skew = _page_angles(page)
    if _aligned(rot, skew, 0):
        return page, img, 0, 0.0
    quarter = int(round(rot / 90.0)) * 90 % 360
    rot_options = [0] if quarter == 0 else ([180] if quarter == 180 else [quarter, 360 - quarter])
    skew_options = [0.0] if abs(skew) < 0.7 else [skew, -skew]
    for r in rot_options:
        for s in skew_options:
            cand = _rot_cw(img, r)
            if s:
                cand = _rotate_any(cand, s)
            pg = conv.ocr(_to_gray(cand))
            r2, s2 = _page_angles(pg)
            if _aligned(r2, s2, skew):
                return pg, cand, r, s
    return page, img, 0, 0.0                                       # подтвердить систему координат не удалось


def _xywh(b):
    return [float(v) for v in (b if isinstance(b, (list, tuple)) else getattr(b, '__iter__', lambda: [])())][:4]


def ocr_image_bytes(data):
    import cv2
    import numpy as np
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError('Не удалось прочитать изображение')
    conv = load_indra()
    with OCR_LOCK:
        page, final, rot, skew = align_and_ocr(conv, img)
    lines = []
    for l in (getattr(page, 'lines', None) or []):
        conf = getattr(l, 'conf', None)
        lines.append({'box': _xywh(getattr(l, 'box', [])), 'text': str(getattr(l, 'text', '') or ''),
                      'conf': float(conf) if conf is not None else 1.0})
    if lines and max(x['conf'] for x in lines) <= 1.0:               # уверенность приводим к шкале 0–100
        for x in lines:
            x['conf'] *= 100.0
    blocks = []
    for b in (getattr(page, 'blocks', None) or []):
        get = (lambda k: b.get(k)) if isinstance(b, dict) else (lambda k: getattr(b, k, None))
        blocks.append({'label': str(get('label') or ''), 'bbox': _xywh(get('bbox') or []), 'text': str(get('text') or '')})
    out = {'ok': True, 'engine': 'indra', 'width': int(final.shape[1]), 'height': int(final.shape[0]),
           'rotation': rot, 'deskew': skew, 'aligned': None, 'lines': lines, 'blocks': blocks,
           'text': str(getattr(page, 'text', '') or ''), 'markdown': str(getattr(page, 'markdown', '') or '')}
    if rot or skew:                                                  # клиент покажет/встроит уже выпрямленную картинку
        ok, buf = cv2.imencode('.jpg', final, [cv2.IMWRITE_JPEG_QUALITY, 92])
        if ok:
            out['aligned'] = base64.b64encode(buf.tobytes()).decode('ascii')
    return out


def check_indra():
    """python univerter_server.py --check-indra: ставит модель (при первом запуске) и распознаёт тестовую картинку."""
    if importlib.util.find_spec('indra_ocr') is None:
        print('✗ Пакет indra-ocr не установлен. Выполните: py install_indra.py')
        print('  (на Windows поддержка официально не заявлена авторами Indra — best-effort)')
        return 1
    import cv2
    import numpy as np
    img = np.full((220, 900, 3), 255, np.uint8)
    cv2.putText(img, 'Hello Indra 2024', (30, 140), cv2.FONT_HERSHEY_SIMPLEX, 3.0, (0, 0, 0), 6, cv2.LINE_AA)
    ok, buf = cv2.imencode('.png', img)
    print('Загружаю Indra (при первом запуске скачивается ~76 МБ весов — подождите)…', flush=True)
    try:
        res = ocr_image_bytes(buf.tobytes())
    except Exception as e:
        print(f'✗ Indra не запустилась: {type(e).__name__}: {e}')
        return 1
    text = ' | '.join(l['text'] for l in res['lines'])
    print(f'Распознано: {text!r}')
    if 'hello' in text.lower() or 'indra' in text.lower():
        print('✓ Indra работает.')
        return 0
    print('⚠ Indra запустилась, но тестовый текст не распознан — пришлите этот вывод.')
    return 2


class Handler(BaseHTTPRequestHandler):
    server_version = 'UniverterLocal/1'

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body=b'', ctype='application/json; charset=utf-8', extra=None):
        origin = self.headers.get('Origin')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        if origin and origin_ok(origin):
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Access-Control-Expose-Headers', 'X-Univerter-Warnings')
        self.send_header('Cache-Control', 'no-store')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode('utf-8'))

    def do_OPTIONS(self):
        if not origin_ok(self.headers.get('Origin')):
            return self._json(403, {'error': 'origin not allowed'})
        self._send(204, b'', extra={
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '600',
        })

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == '/health':
            return self._json(200, capabilities())
        name = STATIC.get(path)
        if name:
            f = HERE / name
            if not f.exists():
                return self._json(404, {'error': f'{name} не найден рядом со скриптом'})
            return self._send(200, f.read_bytes(), MIME.get(f.suffix, 'application/octet-stream'))
        self._json(404, {'error': 'not found'})

    def do_POST(self):
        if not origin_ok(self.headers.get('Origin')):
            return self._json(403, {'error': 'origin not allowed'})
        url = urllib.parse.urlparse(self.path)
        if url.path not in ('/convert', '/ocr'):
            return self._json(404, {'error': 'not found'})
        to = urllib.parse.parse_qs(url.query).get('to', [''])[0]
        quality = urllib.parse.parse_qs(url.query).get('quality', ['high'])[0]
        if quality not in ('high', 'fast'):
            quality = 'high'
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BYTES:
            return self._json(413, {'error': f'размер файла должен быть от 1 байта до {MAX_BYTES // 1048576} МБ'})
        data = self.rfile.read(length)
        if url.path == '/ocr':
            if importlib.util.find_spec('indra_ocr') is None:
                return self._json(503, {
                    'error': 'Indra не установлена. Выполните: py install_indra.py',
                    'code': 'indra_missing',
                    'hint': 'После установки перезапустите univerter_server.py. На Windows поддержка best-effort.'
                })
            try:
                return self._json(200, ocr_image_bytes(data))
            except Exception as e:
                err = f'{type(e).__name__}: {e}'
                hint = 'Запустите: py univerter_server.py --check-indra и пришлите полный вывод.'
                if 'onnx' in err.lower() or 'cuda' in err.lower() or 'dll' in err.lower():
                    hint += ' На Windows часто помогает установка Visual C++ Redistributable или использование Linux/macOS.'
                return self._json(500, {
                    'error': err[:400],
                    'code': 'indra_failed',
                    'hint': hint
                })
        try:
            body, log = convert(to, data, quality=quality)
        except Exception as e:
            return self._json(500, {'error': str(e)[:400]})
        warn = urllib.parse.quote(json.dumps(log, ensure_ascii=False))[:6000]
        ctype = 'application/pdf' if to == 'pdf' else \
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        self._send(200, body, ctype, extra={'X-Univerter-Warnings': warn})


class Server(ThreadingHTTPServer):
    """На Windows SO_REUSEADDR позволяет двум программам занять один порт — тогда запросы
    уходят чужому процессу (в браузере: ERR_EMPTY_RESPONSE). Запрещаем это."""
    allow_reuse_address = (os.name != 'nt')
    daemon_threads = True

    def server_bind(self):
        if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def self_check(port):
    """Python-запрос к самому себе (в обход прокси браузера): отвечает ли именно наш сервис."""
    url = f'http://127.0.0.1:{port}/health'
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(url, timeout=5) as r:
            ok = json.loads(r.read().decode('utf-8')).get('ok') is True
        print('Самопроверка: сервис отвечает ✓' if ok else
              '⚠ Самопроверка: на порту отвечает НЕ Univerter — порт занят другой программой. Запустите с --port 8766',
              flush=True)
    except Exception as e:
        print(f'⚠ Самопроверка не прошла ({e}). Порт, вероятно, занят другой программой или блокируется '
              f'антивирусом. Запустите с --port 8766', flush=True)


def main():
    # Консоль Windows (cp866/cp1251) может не уметь выводить ✓/✗ — не даём сервису упасть из-за этого
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors='replace')
        except Exception:
            pass
    ap = argparse.ArgumentParser(description='Локальный движок Univerter (LibreOffice + pdf2docx)')
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--host', default='127.0.0.1', help='адрес привязки (0.0.0.0 для Docker)')
    ap.add_argument('--soffice', help='путь к soffice, если его нет в PATH')
    ap.add_argument('--timeout', type=int, default=180, help='таймаут LibreOffice на файл, с')
    ap.add_argument('--allow-origin', action='append', default=[],
                    help='дополнительный разрешённый origin (если страница Univerter открыта не локально)')
    ap.add_argument('--open', action='store_true', help='открыть Univerter в браузере')
    ap.add_argument('--check-indra', action='store_true', help='проверить установку Indra (скачает модель при первом запуске) и выйти')
    a = ap.parse_args()

    if a.check_indra:
        raise SystemExit(check_indra())
    CFG['soffice'] = fid.find_soffice(a.soffice)
    CFG['timeout'] = a.timeout
    CFG['extra_origins'] = a.allow_origin
    caps = capabilities()

    try:
        srv = Server((a.host, a.port), Handler)
    except OSError as e:
        raise SystemExit(f'Не удалось занять порт {a.port}: {e}')

    url = f'http://127.0.0.1:{a.port}/' if a.host in ('127.0.0.1', 'localhost') else f'http://{a.host}:{a.port}/'
    print(f'Univerter local engine: {url}', flush=True)
    print(f'  DOCX -> PDF (LibreOffice): {"✓ " + CFG["soffice"] if caps["soffice"] else "✗ LibreOffice не найден"}')
    print(f'  PDF -> DOCX (pdf2docx):    {"✓" if caps["pdf2docx"] else "✗ pip install pdf2docx"}')
    print(f'  OCR (Indra):               {"✓ установлена (модель загружается в фоне)" if caps["indra"] else "✗ py install_indra.py"}', flush=True)
    print('Окно не закрывайте, пока работаете в Univerter. Остановить: Ctrl+C', flush=True)
    if caps['indra']:                                                  # прогрев модели, чтобы первая картинка не ждала
        def _warm():
            try: load_indra()
            except Exception as e: print(f'⚠ Indra не загрузилась: {e}', flush=True)
        threading.Thread(target=_warm, daemon=True).start()
    threading.Timer(0.5, self_check, args=(a.port,)).start()
    if a.open:
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\nОстановлено')


if __name__ == '__main__':
    main()
