@echo off
setlocal
cd /d "%~dp0"
node smoke.mjs %*
exit /b %errorlevel%
