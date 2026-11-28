@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === Univerter: десктоп-версия ===
echo.
where npm >nul 2>nul || (echo [!] npm не найден. Установите Node.js 20+ с https://nodejs.org и запустите файл снова & pause & exit /b 1)

rem --- Локальный движок (Python): OCR и точный DOCX-PDF.
rem     Если рядом есть Univerter_HTML и движок ещё не работает — запускаем свёрнутым окном.
rem     Остановить движок: закрыть окно «Univerter engine (Python)» на панели задач. ---
set "ENGINE=%~dp0..\Univerter_HTML"
if exist "%ENGINE%\server\univerter_server.py" (
    netstat -ano | findstr /R /C:":8765 .*LISTENING" >nul 2>nul
    if errorlevel 1 (
        where py >nul 2>nul && (
            echo Запускаю локальный движок — при первом запуске он сам поставит pdf2docx и indra-ocr...
            start "Univerter engine (Python)" /D "%ENGINE%" /MIN cmd /c "py server\univerter_server.py"
            ping -n 3 127.0.0.1 >nul
        ) || echo [!] Python не найден — OCR и точный DOCX-PDF будут недоступны. Установите Python 3.10+ с python.org или запустите движок вручную из Univerter_HTML.
    ) else (
        echo Локальный движок уже запущен — использую его.
    )
) else (
    echo [i] Рядом нет папки Univerter_HTML с движком — интерфейс запустится без OCR и точного DOCX-PDF.
)

if exist "node_modules\electron" goto run
echo Первая установка зависимостей — npm install, это может занять пару минут...
call npm install || (echo [!] Не удалось установить зависимости. Проверьте интернет и запустите файл снова & pause & exit /b 1)
echo.
:run
echo Запускаю Univerter...
call npm start || (echo [!] Приложение завершилось с ошибкой. Запустите npm install и попробуйте снова & pause & exit /b 1)
