@echo off
cd /d "%~dp0"
set PLAYER_PORT=4311
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\Invoke-Project.ps1 web:dev
pause
