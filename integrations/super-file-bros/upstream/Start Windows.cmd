@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Super File Bros. needs Node.js.
  echo Install Node.js 22+ from https://nodejs.org/ and reopen this launcher.
  pause
  exit /b 1
)
node start.cjs %*
if errorlevel 1 pause
