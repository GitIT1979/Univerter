@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === Univerter: десктоп-версия ===
echo.
where npm >nul 2>nul || (echo [!] npm не найден. Установите Node.js 20+ с https://nodejs.org и запустите файл снова & pause & exit /b 1)
if exist "node_modules\electron" goto run
echo Первая установка зависимостей — npm install, это может занять пару минут...
call npm install || (echo [!] Не удалось установить зависимости. Проверьте интернет и запустите файл снова & pause & exit /b 1)
echo.
:run
echo Запускаю Univerter...
call npm start || (echo [!] Приложение завершилось с ошибкой. Запустите npm install и попробуйте снова & pause & exit /b 1)
