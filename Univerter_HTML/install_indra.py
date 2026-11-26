#!/usr/bin/env python3
"""
Установка Indra OCR для Univerter — по инструкции с https://github.com/datalab-to/indra
(официальный способ: `pip install indra-ocr`, нужен Python 3.10+).

Запуск:   py install_indra.py        (Windows)      |      python3 install_indra.py   (macOS/Linux)
Или дважды щёлкните install_indra.bat (Windows).

Что делает: проверяет версию Python → ставит пакет indra-ocr с PyPI → запускает проверку
(при первом запуске Indra скачивает ~76 МБ весов модели с Hugging Face; интернет нужен один раз).

Замечание: авторы Indra указывают проверенные платформы — Linux и macOS (Apple Silicon). Под Windows пакет
ставится из тех же зависимостей (ONNX Runtime, OpenCV, pypdfium2), но на Windows автором явно не заявлен.
Если проверка не пройдёт — скопируйте весь вывод этого окна и пришлите.
Лицензия: код — Apache-2.0; веса модели — по условиям, указанным в разделе License репозитория Indra
(проверьте, подходят ли они для вашего случая).
"""
import subprocess
import sys
from pathlib import Path


def run(cmd):
    print('  $', ' '.join(cmd), flush=True)
    return subprocess.call(cmd)


def main():
    print(f'Python {sys.version.split()[0]}  ({sys.executable})')
    if sys.version_info < (3, 10):
        print('✗ Нужен Python 3.10 или новее. Скачайте с https://www.python.org/downloads/ '
              '(при установке отметьте «Add python.exe to PATH») и запустите снова.')
        return 1

    print('\n[1/3] Обновляю pip…')
    run([sys.executable, '-m', 'pip', 'install', '--upgrade', 'pip'])          # необязательный шаг

    print('\n[2/3] Устанавливаю indra-ocr (PyPI)…')
    if run([sys.executable, '-m', 'pip', 'install', '--upgrade', 'indra-ocr']) != 0:
        print('\n✗ pip не смог установить indra-ocr. Проверьте интернет и версию Python (нужна 3.10+). '
              'Текст ошибки выше — пришлите его, если не получится разобраться.\n'
              '(Linux/macOS с системным Python: сначала создайте окружение — python3 -m venv .venv && source .venv/bin/activate — и запустите установщик из него.)')
        return 1

    print('\n[3/3] Проверка: загрузка модели и распознавание тестовой картинки…')
    code = subprocess.call([sys.executable, str(Path(__file__).resolve().parent / 'server' / 'univerter_server.py'), '--check-indra'])
    if code == 0:
        print('\n✓ Готово. Теперь запускайте:  py server\\univerter_server.py --open')
    return code


if __name__ == '__main__':
    sys.exit(main())
