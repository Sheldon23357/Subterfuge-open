@echo off
setlocal
cd /d "%~dp0"
node offline-mock.mjs %*
exit /b %errorlevel%
