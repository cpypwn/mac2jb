@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22+ from https://nodejs.org/ first.
  pause
  exit /b 1
)
node tools/fs-rpc-browser/install.cjs
pause
