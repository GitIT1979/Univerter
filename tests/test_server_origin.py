#!/usr/bin/env python3
"""Проверка правил доступа локального движка Univerter (только stdlib).

Поднимает univerter_server.py на свободном порту и проверяет то, что нельзя
проверить статически:
  * строгую проверку Origin (регрессия: «http://127.0.0.1.evil.com» проходил как локальный);
  * отсечение песочных iframe (Origin: null + Sec-Fetch-Site: cross-site);
  * режим file:// (Origin: null без Sec-Fetch-Site) остаётся рабочим;
  * структурную проверку входного файла (мусор с префиксом PK больше не даёт пустой PDF).

LibreOffice, pdf2docx и Indra не нужны.
Запуск:  python tests/test_server_origin.py
"""
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER_DIR = ROOT / 'Univerter_HTML' / 'server'
SERVER = SERVER_DIR / 'univerter_server.py'

passed = failed = 0


def check(label, ok, detail=''):
    global passed, failed
    if ok:
        passed += 1
        print(f'  ✓ {label}')
    else:
        failed += 1
        print(f'  ✗ {label}' + (f' — {detail}' if detail else ''))


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


def call(port, path, origin=None, fetch_site=None, body=None):
    """Возвращает (код, ACAO, тело)."""
    req = urllib.request.Request(f'http://127.0.0.1:{port}{path}', method='POST' if body is not None else 'GET')
    if origin is not None:
        req.add_header('Origin', origin)
    if fetch_site:
        req.add_header('Sec-Fetch-Site', fetch_site)
    if body is not None:
        req.add_header('Content-Type', 'application/octet-stream')
        req.data = body
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))   # без прокси
    try:
        with opener.open(req, timeout=10) as r:
            return r.status, r.headers.get('Access-Control-Allow-Origin'), r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get('Access-Control-Allow-Origin'), e.read()


def wait_ready(port, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            code, _, body = call(port, '/health')
            if code == 200 and json.loads(body.decode('utf-8')).get('ok'):
                return True
        except Exception:
            pass
        time.sleep(0.25)
    return False


def main():
    port = free_port()
    env = dict(os.environ, PYTHONIOENCODING='utf-8')
    env['PYTHONPATH'] = str(SERVER_DIR) + os.pathsep + env.get('PYTHONPATH', '')
    env['UNIVERTER_NO_AUTOINSTALL'] = '1'          # тесты не должны запускать pip в фоне
    proc = subprocess.Popen(
        [sys.executable, str(SERVER), '--port', str(port)],
        cwd=str(SERVER_DIR), env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    try:
        if not wait_ready(port):
            err = proc.stderr.read().decode('utf-8', 'replace') if proc.stderr else ''
            print('✗ сервис не поднялся\n' + err[:800])
            return 1

        code, _, body = call(port, '/health')
        j = json.loads(body.decode('utf-8'))
        check('health: install-статусы присутствуют',
              isinstance(j.get('install'), dict) and 'pdf2docx' in j['install'] and 'indra_ocr' in j['install'],
              f"install={j.get('install')}")

        print('Origin: разрешённые')
        for origin in (f'http://127.0.0.1:{port}', f'http://localhost:{port}'):
            code, acao, _ = call(port, '/health', origin=origin)
            check(f'{origin} → 200 + ACAO', code == 200 and acao == origin, f'code={code} acao={acao}')

        print('Origin: запрещённые (регрессия префиксной проверки)')
        for origin in ('http://127.0.0.1.evil.com', 'http://localhost.evil.com', 'http://evil.com',
                       'http://127.0.0.1@evil.com', 'ftp://127.0.0.1'):
            code, acao, _ = call(port, '/health', origin=origin)
            check(f'{origin} → без ACAO', acao is None, f'acao={acao}')

        print('Origin: null')
        code, acao, _ = call(port, '/health', origin='null')
        check('file:// (null без Sec-Fetch-Site) → ACAO null', acao == 'null', f'acao={acao}')
        code, acao, _ = call(port, '/health', origin='null', fetch_site='cross-site')
        check('песочный iframe (null + cross-site) → без ACAO', acao is None, f'acao={acao}')

        print('POST')
        junk = b'PK-fake-not-a-docx'
        code, _, _ = call(port, '/convert?to=pdf', origin='http://evil.com', body=junk)
        check('чужой Origin → 403', code == 403, f'code={code}')
        code, _, _ = call(port, '/convert?to=pdf', origin='null', fetch_site='cross-site', body=junk)
        check('null + cross-site → 403', code == 403, f'code={code}')
        code, _, body = call(port, '/convert?to=pdf', origin=f'http://127.0.0.1:{port}', body=junk)
        check('мусор вместо DOCX → 422 bad_input', code == 422 and b'bad_input' in body, f'code={code} body={body[:120]}')
        code, _, _ = call(port, '/convert?to=pdf', origin=f'http://127.0.0.1:{port}', body=b'')
        check('пустое тело → 400', code == 400, f'code={code}')
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()

    print(f'\nИтого: успешно {passed}, провалено {failed}')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
