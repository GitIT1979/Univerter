@echo off
chcp 65001 >nul
echo === Univerter: install dependencies ===
echo.

where py >nul 2>&1
if errorlevel 1 (
    echo [!] Python not found. Install Python 3.10+ from https://www.python.org/downloads/
    echo     and check "Add python.exe to PATH".
    pause
    exit /b 1
)

py --version
echo.

echo [1/3] Installing dependencies (pdf2docx)...
py -m pip install --upgrade pip
py -m pip install -r requirements.txt
if errorlevel 1 (
    echo [!] Failed to install pdf2docx
    pause
    exit /b 1
)

echo.
echo [2/3] Installing Indra OCR (optional)...
py install_indra.py
if errorlevel 1 (
    echo [!] Indra failed. On Windows this is best-effort.
    echo     You can continue without OCR - DOCX/PDF will still work.
)

echo.
echo [3/3] Done.
echo Start with:  py server\univerter_server.py --open
echo.
pause
