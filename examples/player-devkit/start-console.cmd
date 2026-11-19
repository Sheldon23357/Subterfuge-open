@echo off
setlocal
cd /d "%~dp0"
node launch-console.mjs %*
exit /b %errorlevel%
