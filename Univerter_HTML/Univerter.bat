@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === Univerter: локальная версия — движок + браузер ===
echo.
where py >nul 2>nul || (echo [!] Python не найден. Установите Python 3.10+ с https://www.python.org/downloads/ — галочка "Add python.exe to PATH", затем один раз запустите setup.bat & pause & exit /b 1)
if not exist "server\univerter_server.py" (
    echo [!] Не найдена папка server — запускайте Univerter.bat из папки Univerter_HTML
    pause
    exit /b 1
)
echo Запускаю движок и открываю браузер. Это окно можно закрыть, чтобы остановить сервер.
echo.
py server\univerter_server.py --open || (echo [!] Движок завершился с ошибкой. Если зависимости не установлены, один раз запустите setup.bat & pause & exit /b 1)
