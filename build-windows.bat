@echo off
chcp 65001 >nul
echo === Univerter: сборка для Windows ===
where node >nul 2>nul || (echo Установите Node.js 20 или новее: https://nodejs.org & pause & exit /b 1)
call npm install || (echo Ошибка установки зависимостей & pause & exit /b 1)
call npm run dist:win || (echo Ошибка сборки & pause & exit /b 1)
echo.
echo Готово. Установщик и портативная версия лежат в папке dist
pause
