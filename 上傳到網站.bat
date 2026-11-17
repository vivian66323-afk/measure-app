@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 上傳丈量APP到網站

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   找不到 Node.js，請先到 https://nodejs.org/ 安裝。
  echo.
  pause
  exit /b 1
)

echo.
echo   [1/3] 檢查程式語法...
call node check.mjs
if errorlevel 1 (
  echo.
  echo   有語法錯誤，已中止上傳。
  pause
  exit /b 1
)

echo.
echo   [2/3] 打包...
call node build.mjs
if errorlevel 1 ( pause & exit /b 1 )

echo.
echo   [3/3] 上傳到 Cloudflare...
echo   第一次執行會開瀏覽器要你登入，登入後回到這個視窗即可。
echo.
call npx wrangler deploy

echo.
echo   完成。手機上請用無痕分頁開一次，避免舊快取。
echo.
pause
