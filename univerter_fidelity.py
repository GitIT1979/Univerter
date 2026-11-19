#!/usr/bin/env python3
"""
univerter_fidelity.py — DOCX <-> PDF с максимальным сохранением оформления.

  DOCX -> PDF : LibreOffice (headless) — настоящий движок вёрстки: шрифты,
                цвета, таблицы, колонтитулы, размеры, разрывы страниц.
  PDF  -> DOCX: pdf2docx — восстанавливает абзацы, таблицы, картинки, цвета и
                шрифты по координатам из PDF.

Установка:
  1) LibreOffice  (https://www.libreoffice.org) — команда soffice должна быть в PATH
                  (Windows: C:\\Program Files\\LibreOffice\\program\\soffice.exe — путь можно
                  передать через --soffice)
  2) pip install pdf2docx

Примеры:
  python univerter_fidelity.py report.docx              # -> report.pdf рядом
  python univerter_fidelity.py scans_folder/ --out out/ # все .docx/.pdf из папки
  python univerter_fidelity.py a.pdf b.docx --out out/

Важно для точности DOCX -> PDF: на машине должны быть те же шрифты, что в документе
(или метрически совместимые: Carlito = Calibri, Liberation = Arial/Times New Roman).
Скрипт проверяет шрифты и предупреждает о подменах — именно они ломают раскладку.
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

# Метрически совместимые замены: раскладка сохраняется, если установлены они
COMPATIBLE = {
    'calibri': 'Carlito', 'cambria': 'Caladea',
    'arial': 'Liberation Sans', 'times new roman': 'Liberation Serif',
    'courier new': 'Liberation Mono', 'helvetica': 'Liberation Sans',
}


def find_soffice(custom=None):
    if custom:
        return custom
    for name in ('soffice', 'libreoffice'):
        p = shutil.which(name)
        if p:
            return p
    for p in (r'C:\Program Files\LibreOffice\program\soffice.exe',
              r'C:\Program Files (x86)\LibreOffice\program\soffice.exe',
              '/Applications/LibreOffice.app/Contents/MacOS/soffice'):
        if os.path.exists(p):
            return p
    return None


# ---------------------------------------------------------------- шрифты
def docx_fonts(path):
    """Шрифты, реально используемые в DOCX (rFonts в стилях и тексте + шрифты темы)."""
    names, theme_used = set(), False
    try:
        with zipfile.ZipFile(path) as z:
            theme_fonts = set()
            for part in z.namelist():
                if not part.endswith('.xml'):
                    continue
                if part.startswith('word/theme/'):
                    xml = z.read(part).decode('utf-8', 'ignore')
                    for m in re.finditer(r'<a:(?:major|minor)Font>\s*<a:latin typeface="([^"]*)"', xml):
                        theme_fonts.add(m.group(1))
                elif part.startswith('word/') and 'fontTable' not in part:
                    xml = z.read(part).decode('utf-8', 'ignore')
                    for tag in re.findall(r'<w:rFonts\b[^>]*>', xml):
                        names.update(re.findall(r'w:(?:ascii|hAnsi|cs|eastAsia)="([^"]+)"', tag))
                        if re.search(r'w:(?:ascii|hAnsi|cs|eastAsia)Theme=', tag):
                            theme_used = True
            if theme_used:
                names |= theme_fonts
    except Exception as e:
        print(f'   ! не удалось прочитать шрифты: {e}')
    skip = {'symbol', 'wingdings', 'wingdings 2', 'wingdings 3', 'webdings'}
    return {n for n in names if n and n.lower() not in skip and not n.startswith('+')}


def installed_fonts():
    """Возвращает множество установленных семейств шрифтов (нижний регистр) или None, если проверить нельзя."""
    # 1) Linux / macOS: fc-list
    fc = shutil.which('fc-list')
    if fc:
        try:
            out = subprocess.run([fc, ':', 'family'], capture_output=True, text=True, timeout=30).stdout
            fams = set()
            for line in out.splitlines():
                for f in line.split(','):
                    name = f.strip().lower()
                    if name:
                        fams.add(name)
            if fams:
                return fams
        except Exception:
            pass

    # 2) Windows: PowerShell + реестр
    if os.name == 'nt':
        try:
            ps = (
                "Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts' | "
                "Select-Object -ExpandProperty PSObject.Properties | "
                "Where-Object { $_.Name -notmatch '^(PS|Length|Count)' } | "
                "ForEach-Object { $_.Name -replace '\\s*\\(TrueType\\)$','' -replace '\\s*\\(OpenType\\)$','' }"
            )
            out = subprocess.run(
                ['powershell', '-NoProfile', '-NonInteractive', '-Command', ps],
                capture_output=True, text=True, timeout=30, encoding='utf-8', errors='replace'
            )
            fams = set()
            for line in out.stdout.splitlines():
                name = line.strip().lower()
                if name and not name.startswith('ps'):
                    fams.add(name)
            if fams:
                return fams
        except Exception:
            pass

    return None


def check_fonts(path, log=print):
    used = docx_fonts(path)
    have = installed_fonts()
    if have is None:
        if os.name == 'nt':
            log('   (проверка шрифтов пропущена: не удалось получить список через PowerShell)')
        else:
            log('   (проверка шрифтов пропущена: нет fc-list)')
        return
    missing = sorted(f for f in used if f.lower() not in have)
    if not missing:
        log(f'   шрифты: все {len(used)} установлены')
        return
    compat = [f for f in missing if COMPATIBLE.get(f.lower(), '').lower() in have]
    lost = [f for f in missing if f not in compat]
    if compat:
        log('   шрифты: подменяются метрически совместимыми (раскладка сохраняется, глифы чуть другие): '
              + ', '.join(f'{f}→{COMPATIBLE[f.lower()]}' for f in compat))
    if lost:
        log('   ⚠ нет шрифтов, раскладка может измениться:')
        for f in lost:
            sub = COMPATIBLE.get(f.lower())
            log(f'       - {f}' + (f' (установите {sub})' if sub else ' (установите этот шрифт)'))


# ---------------------------------------------------------------- DOCX -> PDF
def docx_to_pdf(src, out_dir, soffice, timeout, log=print, quality='high'):
    """quality: 'high' (без сжатия картинок) или 'fast' (меньший размер, быстрее)."""
    check_fonts(src, log)
    out_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='univerter_lo_') as profile:
        base = [soffice, f'-env:UserInstallation={Path(profile).as_uri()}',
                '--headless', '--norestore']
        if quality == 'fast':
            # Быстрее и меньше: умеренное сжатие картинок
            opts = ('pdf:writer_pdf_Export:{"ReduceImageResolution":{"type":"boolean","value":"true"},'
                    '"MaxImageResolution":{"type":"long","value":"150"},'
                    '"UseLosslessCompression":{"type":"boolean","value":"false"},'
                    '"Quality":{"type":"long","value":"80"},'
                    '"UseTaggedPDF":{"type":"boolean","value":"false"}}')
            log('   режим: fast (сжатие изображений, меньше размер)')
        else:
            opts = ('pdf:writer_pdf_Export:{"ReduceImageResolution":{"type":"boolean","value":"false"},'
                    '"UseLosslessCompression":{"type":"boolean","value":"true"},'
                    '"UseTaggedPDF":{"type":"boolean","value":"true"}}')
        last = None
        for fmt in (opts, 'pdf'):
            cmd = base + ['--convert-to', fmt, '--outdir', str(out_dir), str(src)]
            try:
                last = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
            except subprocess.TimeoutExpired:
                raise RuntimeError(
                    f'LibreOffice не ответил за {timeout} с. '
                    f'Возможные причины: файл слишком большой, LibreOffice завис, '
                    f'не хватает памяти или путь к soffice неверный ({soffice}).'
                )
            result = out_dir / (src.stem + '.pdf')
            if result.exists() and result.stat().st_size > 0:
                return result
        err = (last.stderr or last.stdout or '').strip()[:400] if last else ''
        raise RuntimeError(
            'LibreOffice не создал PDF. '
            + (err if err else 'Пустой вывод.')
            + f' Проверьте, что LibreOffice установлен и доступен по пути: {soffice}. '
            'На Windows можно указать путь явно: --soffice "C:\\Program Files\\LibreOffice\\program\\soffice.exe"'
        )


# ---------------------------------------------------------------- PDF -> DOCX
def pdf_has_text(path):
    """True, если в PDF есть текстовый слой (иначе это скан)."""
    try:
        import fitz  # PyMuPDF ставится вместе с pdf2docx
        with fitz.open(path) as doc:
            sample = min(len(doc), 5)
            chars = sum(len(doc[i].get_text().strip()) for i in range(sample))
            return chars > 30
    except Exception:
        return True  # не смогли проверить — не блокируем


def pdf_to_docx(src, out_dir, log=print, fast=False):
    """fast=True — меньше анализа таблиц и картинок, быстрее на больших PDF."""
    try:
        from pdf2docx import Converter
    except ImportError:
        raise RuntimeError('не установлен pdf2docx: pip install pdf2docx')
    if not pdf_has_text(src):
        log('   ⚠ в PDF нет текстового слоя (скан). pdf2docx вставит страницы как картинки;')
        log('     для редактируемого текста сначала распознайте PDF.')
    out_dir.mkdir(parents=True, exist_ok=True)
    dst = out_dir / (src.stem + '.docx')
    cv = Converter(str(src))
    kwargs = {}
    if fast:
        # Ускорение: отключаем тяжёлый разбор сложных таблиц и уменьшаем разрешение картинок
        kwargs.update({
            'parse_stream_table': False,
            'image_quality': 60,
            'multi_processing': True,
        })
        log('   режим: fast (упрощённый разбор таблиц)')
    try:
        cv.convert(str(dst), start=0, end=None, **kwargs)
    finally:
        cv.close()
    if not dst.exists() or dst.stat().st_size == 0:
        raise RuntimeError('pdf2docx не создал DOCX')
    return dst


# ---------------------------------------------------------------- CLI
def collect(paths):
    files = []
    for p in map(Path, paths):
        if p.is_dir():
            files += sorted(x for x in p.rglob('*') if x.suffix.lower() in ('.docx', '.pdf'))
        elif p.suffix.lower() in ('.docx', '.pdf'):
            files.append(p)
        else:
            print(f'пропуск (не docx/pdf): {p}')
    return files


def main():
    ap = argparse.ArgumentParser(description='DOCX <-> PDF с максимальным сохранением оформления')
    ap.add_argument('inputs', nargs='+', help='файлы или папки (.docx -> .pdf, .pdf -> .docx)')
    ap.add_argument('--out', help='папка результата (по умолчанию — рядом с исходным файлом)')
    ap.add_argument('--soffice', help='путь к soffice, если его нет в PATH')
    ap.add_argument('--timeout', type=int, default=180, help='таймаут LibreOffice на файл, с')
    a = ap.parse_args()

    files = collect(a.inputs)
    if not files:
        sys.exit('Нет файлов .docx/.pdf')
    soffice = None
    if any(f.suffix.lower() == '.docx' for f in files):
        soffice = find_soffice(a.soffice)
        if not soffice:
            sys.exit('LibreOffice не найден. Установите его или укажите путь через --soffice')

    ok = bad = 0
    for f in files:
        out_dir = Path(a.out) if a.out else f.parent
        print(f'→ {f}')
        try:
            if f.suffix.lower() == '.docx':
                res = docx_to_pdf(f, out_dir, soffice, a.timeout)
            else:
                res = pdf_to_docx(f, out_dir)
            print(f'   ✓ {res}')
            ok += 1
        except Exception as e:
            print(f'   ✗ {e}')
            bad += 1
    print(f'\nГотово: {ok}, ошибок: {bad}')
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
