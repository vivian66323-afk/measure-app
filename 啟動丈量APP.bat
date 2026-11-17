@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 丈量APP 伺服器 - 關閉此視窗即停止

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   找不到 Node.js。
  echo   請先到 https://nodejs.org/ 下載安裝 LTS 版，再重新執行本檔。
  echo.
  pause
  exit /b 1
)

node server.mjs 5173 --open

echo.
echo   伺服器已停止。
pause
