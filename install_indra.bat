@echo off
cd /d "%~dp0"
echo Installing Indra OCR for Univerter...
where py >nul 2>&1
if %errorlevel%==0 (py -3 install_indra.py) else (python install_indra.py)
echo.
pause
