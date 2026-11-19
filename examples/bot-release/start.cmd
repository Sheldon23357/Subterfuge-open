@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.13 or newer is required. Install it and reopen this window.
  pause
  exit /b 1
)
node launch.mjs %*
set "bot_exit=%errorlevel%"
if not "%bot_exit%"=="0" (
  echo.
  echo Bot startup failed with exit code %bot_exit%. See the error above.
  pause
)
exit /b %bot_exit%
