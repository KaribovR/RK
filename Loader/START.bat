@echo off
chcp 65001 >nul
cd /d "%~dp0"
set RK_DATA_DIR=F:\Loader\RK_DATA_v3
echo === RK_LOADER: полный цикл ===
node index.js all
echo.
echo === Готово. Окно не закроется само. ===
pause