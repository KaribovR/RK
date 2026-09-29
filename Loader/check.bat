@echo off
chcp 65001 >nul
cd /d "%~dp0"
set RK_DATA_DIR=F:\Loader\RK_DATA_v3
node index.js check
echo.
pause
